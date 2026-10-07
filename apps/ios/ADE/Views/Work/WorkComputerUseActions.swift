import SwiftUI

// Computer-use action rows in the chat thread.
//
// A faithful port of `apps/desktop/src/shared/computerUseActionSummary.ts`:
// an agent's `ade screen click …` / `ade browser fill …` / `"$ADE_CLI_PATH"
// apple tap …` shell call becomes "Clicked “Checkout” on localhost:5173".
// Keep the two in step — the same command and output must read the same on
// the phone and on the desktop. Anything this cannot describe with
// confidence returns nil and keeps its plain tool row.

enum WorkComputerUseSurface: String, Hashable {
  case laneScreen, appControl, adeBrowser, userBrowser, appleDevice, proof
}

enum WorkComputerUseOutcome: String, Hashable {
  case running, observed, unconfirmed, notChecked, failed
}

struct WorkComputerUseAction: Identifiable, Hashable {
  /// The tool-group member id the action came from.
  var id: String
  let surface: WorkComputerUseSurface
  let domain: String
  let verb: String
  let past: String
  let progressive: String
  let infinitive: String
  let target: String?
  let targetQuoted: Bool
  let whereText: String?
  let appName: String?
  let browserName: String?
  let hostLabel: String?
  var deviceName: String?
  var deviceOS: String?
  /// Which lane screen the command named: "mac" (`ade mac-desktop`), "windows", or nil for `ade screen`.
  var screenProduct: String? = nil
  let outcome: WorkComputerUseOutcome
  let reason: String?
  let prNumber: Int?
}

// MARK: - Regex helper

private final class WorkCURegexCache: @unchecked Sendable {
  static let shared = WorkCURegexCache()
  private var cache: [String: NSRegularExpression] = [:]
  private let lock = NSLock()
  func regex(_ pattern: String, _ options: NSRegularExpression.Options = []) -> NSRegularExpression? {
    lock.lock(); defer { lock.unlock() }
    let key = "\(options.rawValue)|\(pattern)"
    if let cached = cache[key] { return cached }
    let compiled = try? NSRegularExpression(pattern: pattern, options: options)
    if let compiled { cache[key] = compiled }
    return compiled
  }
}

/// Capture groups of the first match (index 0 is the whole match), nil groups as nil.
private func cuMatch(_ pattern: String, _ text: String, _ options: NSRegularExpression.Options = []) -> [String?]? {
  guard let regex = WorkCURegexCache.shared.regex(pattern, options) else { return nil }
  let range = NSRange(text.startIndex..., in: text)
  guard let match = regex.firstMatch(in: text, range: range) else { return nil }
  return (0..<match.numberOfRanges).map { index in
    let r = match.range(at: index)
    guard r.location != NSNotFound, let swiftRange = Range(r, in: text) else { return nil }
    return String(text[swiftRange])
  }
}

private func cuReplacing(_ pattern: String, in text: String, _ transform: (String) -> String) -> String {
  guard let regex = WorkCURegexCache.shared.regex(pattern, []) else { return text }
  var result = text
  for match in regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).reversed() {
    guard let range = Range(match.range, in: result) else { continue }
    result.replaceSubrange(range, with: transform(String(result[range])))
  }
  return result
}

private func cuTests(_ pattern: String, _ text: String, _ options: NSRegularExpression.Options = []) -> Bool {
  cuMatch(pattern, text, options) != nil
}

// MARK: - Command parsing

private let cuDomainAliases: [String: String] = [
  "screen": "screen", "mac-desktop": "screen", "mac-desk": "screen", "desk": "screen",
  "windows-desktop": "screen", "windows-desk": "screen",
  "app-control": "app-control", "app": "app-control", "apps": "app-control", "electron": "app-control",
  "browser": "browser", "ade-browser": "browser", "built-in-browser": "browser", "builtin-browser": "browser",
  "apple": "apple", "ios-sim": "apple", "ios": "apple", "simulator": "apple",
  "proof": "proof", "computer": "proof", "computer-use": "proof", "artifact": "proof", "artifacts": "proof",
]

private let cuBooleanFlags: Set<String> = [
  "--text", "--json", "--pretty", "--compact", "--map", "--fast", "--real", "--submit",
  "--follow", "--open-drawer", "--no-build", "--panel", "--no-panel", "--new-tab",
  "--active-tab", "--floating", "--keep", "--plain", "--isolated", "--no-dom",
  "--network-idle", "--double", "--right", "--force", "--no-wait", "--wait",
  "--shared", "--all", "--no-verify", "--har", "--clear", "--help", "-h", "--quiet",
  "--verbose", "--background", "--no-observe", "--observe", "--socket",
]
private let cuGlobalValueFlags: Set<String> = ["--project", "--project-root", "--machine", "--runtime", "--role", "--home"]
private let cuShells: Set<String> = ["bash", "sh", "zsh", "dash", "fish", "pwsh", "powershell", "cmd"]
private let cuWrappers: Set<String> = ["env", "time", "command", "exec", "nohup", "sudo", "caffeinate"]
private let cuControlWords: Set<String> = ["for", "while", "until", "if", "then", "else", "elif", "do", "done", "fi", "case", "esac", "function"]

private struct CUInvocation {
  let domain: String
  /// The domain word as typed: `mac-desktop`, `windows-desktop`, `screen`, …
  var alias: String = ""
  var words: [String]
  var positionals: [String]
  var flags: [String: String?]

  func flag(_ names: String...) -> String? {
    for name in names {
      if let value = flags[name] ?? nil {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { return trimmed }
      }
    }
    return nil
  }

  func has(_ name: String) -> Bool { flags.keys.contains(name) }
}

private enum CUParseResult {
  case none
  case control
  case invocation(CUInvocation)
}

/// Quote-aware split into simple commands on `&&`, `||`, `;`, `|`, `&`, newlines.
private func cuSplitShellCommands(_ source: String) -> [[String]] {
  var commands: [[String]] = []
  var tokens: [String] = []
  var current = ""
  var hasToken = false
  var quote: Character? = nil
  let chars = Array(source)
  func pushToken() {
    if hasToken { tokens.append(current) }
    current = ""
    hasToken = false
  }
  func pushCommand() {
    pushToken()
    if !tokens.isEmpty { commands.append(tokens) }
    tokens = []
  }
  var index = 0
  while index < chars.count {
    let char = chars[index]
    if let q = quote {
      if char == q {
        quote = nil
      } else if char == "\\", q == "\"", index + 1 < chars.count {
        let next = chars[index + 1]
        if next == "\"" || next == "\\" || next == "$" || next == "`" {
          current.append(next)
          index += 1
        } else {
          current.append(char)
        }
      } else {
        current.append(char)
      }
      index += 1
      continue
    }
    if char == "'" || char == "\"" {
      quote = char
      hasToken = true
    } else if char == "\\", index + 1 < chars.count {
      let next = chars[index + 1]
      if next != "\n" {
        current.append(next)
        hasToken = true
      }
      index += 1
    } else if char == "\n" || char == ";" || char == "|" || char == "&" {
      pushCommand()
    } else if char == " " || char == "\t" || char == "\r" {
      pushToken()
    } else {
      current.append(char)
      hasToken = true
    }
    index += 1
  }
  pushCommand()
  return commands
}

private func cuBasename(_ token: String) -> String {
  let parts = token.split(whereSeparator: { $0 == "/" || $0 == "\\" })
  return (parts.last.map(String.init) ?? token).lowercased()
}

private func cuIsAdeExecutable(_ token: String, aliasVars: Set<String>) -> Bool {
  if cuTests(#"^(?:\$\{?(?:env:)?ADE_CLI_PATH\}?|%ADE_CLI_PATH%)$"#, token, [.caseInsensitive]) { return true }
  let name = cuBasename(token)
  if ["ade", "ade.exe", "ade.cmd", "ade.ps1"].contains(name) { return true }
  if let variable = cuMatch(#"^\$\{?(\w+)\}?$"#, token)?[1] ?? nil { return aliasVars.contains(variable) }
  return false
}

private func cuIsSubcommandWord(domain: String, words: [String], token: String) -> Bool {
  guard let first = words.first else { return true }
  if first == "record" { return ["start", "stop", "status"].contains(token) }
  if domain == "proof" { return first == "proof" && ["capture", "attach", "record", "publish", "step", "list", "status", "rm"].contains(token) }
  if first == "session" || first == "terminal" { return true }
  return false
}

private func cuParseInvocation(_ tokens: [String], aliasVars: Set<String>) -> CUParseResult {
  var index = 0
  while index < tokens.count {
    let token = tokens[index]
    if cuTests(#"^\w+="#, token) { index += 1; continue }
    let name = cuBasename(token)
    if cuControlWords.contains(name) { return .control }
    if cuWrappers.contains(name) { index += 1; continue }
    if name == "timeout" || name == "gtimeout" { index += 2; continue }
    break
  }
  guard index < tokens.count, cuIsAdeExecutable(tokens[index], aliasVars: aliasVars) else { return .none }
  index += 1
  while index < tokens.count, tokens[index].hasPrefix("-") {
    let flag = tokens[index]
    index += 1
    if !flag.contains("="), index < tokens.count, !tokens[index].hasPrefix("-") {
      let next = tokens[index]
      let takesValue = cuGlobalValueFlags.contains(flag)
        || (flag == "--socket" && cuDomainAliases[next.lowercased()] == nil)
      if takesValue { index += 1 }
    }
  }
  guard index < tokens.count, let domain = cuDomainAliases[tokens[index].lowercased()] else { return .none }
  index += 1
  var invocation = CUInvocation(domain: domain, words: [], positionals: [], flags: [:])
  invocation.alias = tokens[index - 1].lowercased()
  while index < tokens.count {
    let token = tokens[index]
    index += 1
    if token.hasPrefix("-"), token.count > 1, !cuTests(#"^-\d"#, token) {
      if let eq = token.firstIndex(of: "="), eq != token.startIndex {
        invocation.flags[String(token[..<eq])] = String(token[token.index(after: eq)...])
        continue
      }
      // `--text` is the output switch, except in `click --text "Deploy"`, where
      // it names the element: a plain word after it is its value.
      let takesValue = !cuBooleanFlags.contains(token)
        || (token == "--text" && index < tokens.count && !tokens[index].hasPrefix("-"))
      if takesValue, index < tokens.count,
         !tokens[index].hasPrefix("-") || cuTests(#"^-\d"#, tokens[index]) {
        invocation.flags[token] = tokens[index]
        index += 1
      } else if invocation.flags[token] == nil {
        // A bare repeat (`--text "Deploy" --text`) keeps the value it already has.
        invocation.flags[token] = .some(nil)
      }
      continue
    }
    if invocation.positionals.isEmpty, invocation.words.count < 2, cuTests(#"^[a-z][a-z-]*$"#, token),
       cuIsSubcommandWord(domain: domain, words: invocation.words, token: token) {
      invocation.words.append(token)
      continue
    }
    invocation.positionals.append(token)
  }
  return .invocation(invocation)
}

// MARK: - Verbs

private enum CUTargetKind { case element, typed, key, app, url, caption, direction, file, page, none }

private struct CUVerbSpec {
  let past: String
  let progressive: String
  let infinitive: String
  let target: CUTargetKind
  var passive = false
}

private let cuVerbs: [String: CUVerbSpec] = [
  "click": .init(past: "Clicked", progressive: "Clicking", infinitive: "click", target: .element),
  "double-click": .init(past: "Double-clicked", progressive: "Double-clicking", infinitive: "double-click", target: .element),
  "dblclick": .init(past: "Double-clicked", progressive: "Double-clicking", infinitive: "double-click", target: .element),
  "right-click": .init(past: "Right-clicked", progressive: "Right-clicking", infinitive: "right-click", target: .element),
  "tap": .init(past: "Tapped", progressive: "Tapping", infinitive: "tap", target: .element),
  "tap-element": .init(past: "Tapped", progressive: "Tapping", infinitive: "tap", target: .element),
  "hover": .init(past: "Hovered over", progressive: "Hovering over", infinitive: "hover over", target: .element),
  "drag": .init(past: "Dragged", progressive: "Dragging", infinitive: "drag", target: .element),
  "swipe": .init(past: "Swiped", progressive: "Swiping", infinitive: "swipe", target: .direction),
  "scroll": .init(past: "Scrolled", progressive: "Scrolling", infinitive: "scroll", target: .direction),
  "type": .init(past: "Typed", progressive: "Typing", infinitive: "type", target: .typed),
  "fill": .init(past: "Filled", progressive: "Filling", infinitive: "fill", target: .element),
  "clear": .init(past: "Cleared", progressive: "Clearing", infinitive: "clear", target: .element),
  "select": .init(past: "Selected", progressive: "Selecting", infinitive: "select", target: .element),
  "select-option": .init(past: "Selected", progressive: "Selecting", infinitive: "select", target: .element),
  "press": .init(past: "Pressed", progressive: "Pressing", infinitive: "press", target: .key),
  "key": .init(past: "Pressed", progressive: "Pressing", infinitive: "press", target: .key),
  "button": .init(past: "Pressed", progressive: "Pressing", infinitive: "press", target: .key),
  "upload": .init(past: "Uploaded", progressive: "Uploading", infinitive: "upload", target: .file),
  "open": .init(past: "Opened", progressive: "Opening", infinitive: "open", target: .app),
  "open-url": .init(past: "Opened", progressive: "Opening", infinitive: "open", target: .url),
  "navigate": .init(past: "Opened", progressive: "Opening", infinitive: "open", target: .url),
  "new-tab": .init(past: "Opened", progressive: "Opening", infinitive: "open", target: .url),
  "back": .init(past: "Went back", progressive: "Going back", infinitive: "go back", target: .none),
  "forward": .init(past: "Went forward", progressive: "Going forward", infinitive: "go forward", target: .none),
  "reload": .init(past: "Reloaded", progressive: "Reloading", infinitive: "reload", target: .none),
  "launch": .init(past: "Launched", progressive: "Launching", infinitive: "launch", target: .app),
  "relaunch": .init(past: "Opened", progressive: "Opening", infinitive: "open", target: .app),
  "terminate": .init(past: "Closed", progressive: "Closing", infinitive: "close", target: .app),
  "focus": .init(past: "Focused", progressive: "Focusing", infinitive: "focus", target: .app),
  "close": .init(past: "Closed", progressive: "Closing", infinitive: "close", target: .app),
  "wait": .init(past: "Waited for", progressive: "Waiting for", infinitive: "find", target: .element, passive: true),
  "wait-for-element": .init(past: "Waited for", progressive: "Waiting for", infinitive: "find", target: .element, passive: true),
  "assert-visible": .init(past: "Saw", progressive: "Checking for", infinitive: "see", target: .element, passive: true),
  "observe": .init(past: "Looked at", progressive: "Looking at", infinitive: "look at", target: .page, passive: true),
  "snapshot": .init(past: "Looked at", progressive: "Looking at", infinitive: "look at", target: .page, passive: true),
  "screenshot": .init(past: "Took a screenshot of", progressive: "Taking a screenshot of", infinitive: "take a screenshot of", target: .page, passive: true),
  "record start": .init(past: "Started recording", progressive: "Starting a recording", infinitive: "start recording", target: .caption),
  "record-start": .init(past: "Started recording", progressive: "Starting a recording", infinitive: "start recording", target: .caption),
  "record stop": .init(past: "Stopped recording", progressive: "Stopping the recording", infinitive: "stop recording", target: .caption),
  "record-stop": .init(past: "Stopped recording", progressive: "Stopping the recording", infinitive: "stop recording", target: .caption),
  "proof": .init(past: "Filed proof", progressive: "Filing proof", infinitive: "file proof", target: .caption),
  "proof capture": .init(past: "Filed proof", progressive: "Filing proof", infinitive: "file proof", target: .caption),
  "proof attach": .init(past: "Filed proof", progressive: "Filing proof", infinitive: "file proof", target: .caption),
  "proof record": .init(past: "Filed proof", progressive: "Recording proof", infinitive: "record proof", target: .caption),
  "proof publish": .init(past: "Posted proof", progressive: "Posting proof", infinitive: "post proof", target: .caption),
  "attach": .init(past: "Connected to", progressive: "Connecting to", infinitive: "connect to", target: .none),
]

private func cuResolveVerb(_ invocation: CUInvocation) -> (key: String, spec: CUVerbSpec)? {
  guard let first = invocation.words.first else { return nil }
  let second = invocation.words.count > 1 ? invocation.words[1] : ""
  if invocation.has("--help") || invocation.has("-h") || first == "help" { return nil }
  if invocation.domain == "proof" {
    guard ["proof", "capture", "attach", "record", "publish"].contains(first) else { return nil }
    let key = first == "proof" ? "proof \(second)".trimmingCharacters(in: .whitespaces) : "proof \(first)"
    return cuVerbs[key].map { (key, $0) }
  }
  if first == "record" {
    let key = "record \(second)".trimmingCharacters(in: .whitespaces)
    return cuVerbs[key].map { (key, $0) }
  }
  if first == "attach", invocation.domain != "browser" { return nil }
  if first == "open", invocation.domain == "browser" { return ("open", cuVerbs["navigate"]!) }
  if first == "open", invocation.domain == "apple" { return ("open", cuVerbs["open-url"]!) }
  if (first == "observe" || first == "snapshot"), invocation.domain == "browser" {
    return (first, .init(past: "Read", progressive: "Reading", infinitive: "read", target: .page, passive: true))
  }
  if first == "start", invocation.domain == "apple" {
    return ("start", .init(past: "Started", progressive: "Starting", infinitive: "start", target: .none, passive: true))
  }
  return cuVerbs[first].map { (first, $0) }
}

// MARK: - Output parsing

private struct CUOutput {
  var hitName: String?
  var hitNone = false
  var effect: String?
  var effectReason: String?
  var values: [String: String] = [:]
  var windows: [(id: String, app: String)] = []
  var errorMessage: String?
  var okFalse = false
  var openedUrl: String?
  var json: [String: Any]?
  var attachedLine: String?
  var prNumber: Int?
}

private func cuReadString(_ value: Any?) -> String? {
  guard let text = value as? String else { return nil }
  let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
  return trimmed.isEmpty ? nil : trimmed
}

private func cuQuotedName(_ text: String) -> String? {
  guard let start = text.firstIndex(of: "\"") else { return nil }
  var index = text.index(after: start)
  while index < text.endIndex {
    let char = text[index]
    if char == "\\" {
      index = text.index(index, offsetBy: 2, limitedBy: text.endIndex) ?? text.endIndex
      continue
    }
    if char == "\"" { break }
    index = text.index(after: index)
  }
  let literal = String(text[start..<(index < text.endIndex ? text.index(after: index) : text.endIndex)])
  if let data = "[\(literal)]".data(using: .utf8),
     let array = try? JSONSerialization.jsonObject(with: data) as? [String],
     let first = array.first?.trimmingCharacters(in: .whitespacesAndNewlines), !first.isEmpty {
    return first
  }
  let raw = String(text[text.index(after: start)..<index]).trimmingCharacters(in: .whitespaces)
  return raw.isEmpty ? nil : raw
}

private func cuElementName(_ element: [String: Any]?) -> String? {
  guard let element else { return nil }
  for key in ["title", "label", "text", "name", "value", "placeholder", "identifier", "ariaLabel"] {
    if let value = cuReadString(element[key]) { return value }
  }
  return nil
}

private func cuParseJSON(_ output: String) -> [String: Any]? {
  let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
  guard let start = trimmed.firstIndex(of: "{"),
        trimmed.distance(from: trimmed.startIndex, to: start) <= 200,
        let end = trimmed.lastIndex(of: "}"), end > start,
        let data = String(trimmed[start...end]).data(using: .utf8),
        let parsed = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
  if parsed["domain"] is String, let inner = parsed["result"] as? [String: Any] { return inner }
  return parsed
}

private func cuParseOutput(_ output: String) -> CUOutput {
  var parsed = CUOutput()
  guard !output.isEmpty else { return parsed }
  for rawLine in output.components(separatedBy: .newlines) {
    let line = rawLine.replacingOccurrences(of: #"\s+$"#, with: "", options: .regularExpression)
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    if trimmed.isEmpty { continue }
    let lower = trimmed.lowercased()
    if lower.hasPrefix("hit:"), parsed.hitName == nil, !parsed.hitNone {
      let rest = String(trimmed.dropFirst(4)).trimmingCharacters(in: .whitespaces)
      if rest.lowercased().hasPrefix("no element") { parsed.hitNone = true } else { parsed.hitName = cuQuotedName(rest) }
      continue
    }
    if lower.hasPrefix("effect:"), parsed.effect == nil {
      let rest = String(trimmed.dropFirst(7)).trimmingCharacters(in: .whitespaces)
      let parts = rest.components(separatedBy: " — ")
      let status = (parts.first ?? "").lowercased()
      if status.hasPrefix("observed") { parsed.effect = "observed" }
      else if status.hasPrefix("unconfirmed") { parsed.effect = "unconfirmed" }
      else if status.hasPrefix("waiting") { parsed.effect = "waiting" }
      else if status.hasPrefix("not checked") || status.hasPrefix("not_checked") { parsed.effect = "not_checked" }
      let reason = parts.dropFirst().joined(separator: " — ").trimmingCharacters(in: .whitespaces)
      parsed.effectReason = reason.isEmpty ? nil : reason
      continue
    }
    if trimmed.hasPrefix("ade: ") || trimmed.hasPrefix("ade:\t"), parsed.errorMessage == nil {
      let message = String(trimmed.dropFirst(4)).trimmingCharacters(in: .whitespaces)
        .replacingOccurrences(of: #"^[A-Z][A-Z0-9_]{3,}:\s*"#, with: "", options: .regularExpression)
      parsed.errorMessage = message.isEmpty ? nil : message
      continue
    }
    if lower.hasPrefix("attached:"), parsed.attachedLine == nil {
      parsed.attachedLine = String(trimmed.dropFirst(9)).trimmingCharacters(in: .whitespaces)
      continue
    }
    if parsed.openedUrl == nil, let opened = cuMatch(#"^(?:opened|navigated):\s+\S+\s+(\S+)"#, trimmed, [.caseInsensitive]), let url = opened[1] {
      parsed.openedUrl = url
      continue
    }
    if parsed.prNumber == nil, lower.hasPrefix("posted"), let pr = cuMatch(#"/pull/(\d+)\b"#, trimmed)?[1] ?? nil {
      parsed.prNumber = Int(pr)
    }
    if let window = cuMatch(#"^\s+#(\d+)\s+(.+?)(?:\s+—\s+(.*))?$"#, line), let id = window[1], let app = window[2] {
      parsed.windows.append((id: id, app: app.trimmingCharacters(in: .whitespaces)))
      continue
    }
    if let kv = cuMatch(#"^([a-z][a-z0-9 ]{0,30}?)\s{2,}(\S.*)$"#, trimmed), let key = kv[1], let value = kv[2], parsed.values[key] == nil {
      parsed.values[key] = value.trimmingCharacters(in: .whitespaces)
    }
  }
  if parsed.values["ok"] == "false" { parsed.okFalse = true }
  if let json = cuParseJSON(output) {
    parsed.json = json
    let match = json["match"] as? [String: Any]
    let resolved = (json["resolved"] as? [String: Any]) ?? (json["matched"] as? [String: Any]) ?? (match?["element"] as? [String: Any])
    if parsed.hitName == nil { parsed.hitName = cuElementName(resolved) }
    if parsed.effect == nil, let effect = json["effect"] as? [String: Any], let status = cuReadString(effect["status"]) {
      parsed.effect = ["observed", "unconfirmed", "not_checked"].contains(status) ? status : (status == "waiting_for_approval" ? "waiting" : nil)
      parsed.effectReason = cuReadString(effect["reason"])
    }
    if (json["ok"] as? Bool) == false { parsed.okFalse = true }
    if parsed.errorMessage == nil {
      parsed.errorMessage = cuReadString(json["error"]) ?? cuReadString((json["error"] as? [String: Any])?["message"])
    }
    if (json["attached"] as? Bool) == true || cuReadString(json["browserKind"]) == "user" || json["attached"] is [String: Any] {
      parsed.attachedLine = parsed.attachedLine ?? cuReadString((json["attached"] as? [String: Any])?["label"]) ?? ""
    }
  }
  return parsed
}

// MARK: - Field readers

private func cuClip(_ value: String, _ max: Int = 60) -> String {
  let oneLine = value.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
  return oneLine.count > max ? "\(oneLine.prefix(max - 1))…" : oneLine
}

private func cuUrlHost(_ value: String?) -> String? {
  guard let raw = value?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return nil }
  let withScheme = cuTests(#"^[a-z][a-z0-9+.-]*://"#, raw, [.caseInsensitive]) ? raw : "http://\(raw)"
  guard let components = URLComponents(string: withScheme), let host = components.host, !host.isEmpty else { return nil }
  if let port = components.port { return "\(host):\(port)" }
  return host
}

private let cuUserBrowserNames: [(String, String)] = [
  (#"\bchrome\b"#, "Chrome"), (#"\bedge\b"#, "Edge"), (#"\bbrave\b"#, "Brave"), (#"\barc\b"#, "Arc"),
  (#"\bhelium\b"#, "Helium"), (#"\bsafari\b"#, "Safari"), (#"\bfirefox\b"#, "Firefox"),
  (#"\bvivaldi\b"#, "Vivaldi"), (#"\bopera\b"#, "Opera"), (#"\bchromium\b"#, "Chromium"), (#"\bzen\b"#, "Zen"),
]

private func cuReadUserBrowser(_ parsed: CUOutput, output: String) -> (browser: String?, host: String?)? {
  // `ade browser attach` prints `attached: Google Chrome on Arul's Mac Studio, tab "…" (…)`;
  // every command made while attached leads with `target: your Google Chrome on Arul's Mac Studio`.
  let target = cuMatch(#"^\s*target:\s*your\s+(.+?)\s+on\s+(.+?)\s*$"#, output, [.caseInsensitive, .anchorsMatchLines])
  let attached = parsed.attachedLine.flatMap { cuMatch(#"^(.+?)\s+on\s+(.+?)(?:,\s*tab\b.*)?$"#, $0, [.caseInsensitive]) }
  let your = cuMatch(#"\byour (chrome|edge|brave|arc|helium|safari|firefox|vivaldi|opera|chromium|zen|browser)\b"#, output, [.caseInsensitive])?[0] ?? nil
  guard parsed.attachedLine != nil || target != nil || your != nil else { return nil }
  let source = (target?[1] ?? nil) ?? (attached?[1] ?? nil)
    ?? (parsed.attachedLine?.isEmpty == false ? parsed.attachedLine : nil) ?? your ?? ""
  let browser = cuUserBrowserNames.first(where: { cuTests($0.0, source, [.caseInsensitive]) })?.1
    ?? cuUserBrowserNames.first(where: { cuTests($0.0, parsed.values["browser"] ?? "", [.caseInsensitive]) })?.1
  let host = (target?[2] ?? nil) ?? (attached?[2] ?? nil)
    ?? parsed.values["machine"] ?? parsed.values["host"] ?? cuReadString(parsed.json?["machine"])
  return (browser, host.map { cuClip($0, 40) })
}

private let cuAppleDevicePattern = #"\b(iPhone|iPad|Apple Watch|Apple TV|Apple Vision Pro)\b((?:[ ](?!(?:iOS|iPadOS|watchOS|tvOS|visionOS|xrOS)\b)[A-Za-z0-9-]+){0,4})"#
private let cuAppleOSPattern = #"\b(iOS|iPadOS|watchOS|tvOS|visionOS|xrOS)[ -](\d+(?:[.-]\d+)?)"#

private func cuReadAppleDevice(_ invocation: CUInvocation, output: String) -> (name: String?, os: String?) {
  // Simulator type ids spell the name with hyphens: `SimDeviceType.iPhone-16-Pro`.
  let sources = [invocation.flag("--device-type", "--device-name", "--simulator"), output].compactMap { $0 }.map { source in
    cuReplacing(#"\b(iPhone|iPad)((?:-[A-Za-z0-9]+)+)"#, in: source) { $0.replacingOccurrences(of: "-", with: " ") }
  }
  var name: String?
  var os: String?
  for source in sources {
    if name == nil, let match = cuMatch(cuAppleDevicePattern, source), let head = match[1] {
      name = "\(head)\(match[2] ?? "")".trimmingCharacters(in: .whitespaces)
    }
    if os == nil, let match = cuMatch(cuAppleOSPattern, source), let family = match[1], let version = match[2] {
      os = "\(family) \(version.replacingOccurrences(of: "-", with: "."))"
    }
  }
  if os == nil, let runtime = invocation.flag("--runtime"), let match = cuMatch(cuAppleOSPattern, runtime), let family = match[1], let version = match[2] {
    os = "\(family) \(version.replacingOccurrences(of: "-", with: "."))"
  }
  return (name, os)
}

private func cuAppName(fromBundleId bundleId: String?) -> String? {
  guard let bundleId, let last = bundleId.split(separator: ".").last.map(String.init), !last.isEmpty else { return nil }
  let known = ["mobilesafari": "Safari", "preferences": "Settings", "mobileslideshow": "Photos", "mobilenotes": "Notes",
               "mobilemail": "Mail", "mobilecal": "Calendar", "mobiletimer": "Clock", "maps": "Maps"]
  return known[last.lowercased()] ?? (last.prefix(1).uppercased() + last.dropFirst())
}

private func cuSurface(_ domain: String) -> WorkComputerUseSurface {
  switch domain {
  case "screen": return .laneScreen
  case "app-control": return .appControl
  case "browser": return .adeBrowser
  case "apple": return .appleDevice
  default: return .proof
  }
}

private func cuFindInvocations(_ source: String, depth: Int = 0) -> [CUInvocation]? {
  var aliasVars = Set<String>()
  if let regex = WorkCURegexCache.shared.regex(#"\b(\w+)=["']?\$\{?ADE_CLI_PATH\}?["']?"#) {
    for match in regex.matches(in: source, range: NSRange(source.startIndex..., in: source)) {
      if let range = Range(match.range(at: 1), in: source) { aliasVars.insert(String(source[range])) }
    }
  }
  var found: [CUInvocation] = []
  for tokens in cuSplitShellCommands(source) {
    let head = cuBasename(tokens.first ?? "")
    if cuShells.contains(head), depth < 2,
       let flagIndex = tokens.indices.first(where: { $0 > 0 && cuTests(#"^-[a-z]*c$"#, tokens[$0], [.caseInsensitive]) }),
       flagIndex + 1 < tokens.count {
      guard let inner = cuFindInvocations(tokens[flagIndex + 1], depth: depth + 1) else { return nil }
      found.append(contentsOf: inner)
      continue
    }
    switch cuParseInvocation(tokens, aliasVars: aliasVars) {
    case .control: return nil
    case .invocation(let invocation): found.append(invocation)
    case .none: break
    }
  }
  return found
}

// MARK: - Summary

private final class WorkCUSummaryCache: @unchecked Sendable {
  static let shared = WorkCUSummaryCache()
  private var cache: [String: WorkComputerUseAction?] = [:]
  private let lock = NSLock()
  func value(_ key: String) -> WorkComputerUseAction?? {
    lock.lock(); defer { lock.unlock() }
    return cache[key]
  }
  func store(_ key: String, _ value: WorkComputerUseAction?) {
    lock.lock(); defer { lock.unlock() }
    if cache.count > 2000 { cache.removeAll() }
    cache[key] = .some(value)
  }
}

/// Summarize one shell command (desktop `summarizeComputerUseCommand`).
/// `status` is `running`, `completed`, `failed` or `interrupted`.
func workComputerUseSummary(command: String, output: String?, status: String, exitCode: Int? = nil) -> WorkComputerUseAction? {
  guard command.range(of: "ade", options: .caseInsensitive) != nil else { return nil }
  let output = output ?? ""
  let key = "\(status)|\(exitCode.map(String.init) ?? "")|\(command)|\(output.count)|\(output.prefix(2048))"
  if let cached = WorkCUSummaryCache.shared.value(key) { return cached }
  let summary = cuBuildSummary(source: command, output: output, status: status, exitCode: exitCode)
  WorkCUSummaryCache.shared.store(key, summary)
  return summary
}

private func cuBuildSummary(source: String, output: String, status: String, exitCode: Int?) -> WorkComputerUseAction? {
  guard let invocations = cuFindInvocations(source), !invocations.isEmpty else { return nil }
  let described = invocations.compactMap { invocation -> (CUInvocation, String, CUVerbSpec)? in
    guard let verb = cuResolveVerb(invocation) else { return nil }
    return (invocation, verb.key, verb.spec)
  }
  let acting = described.filter { !$0.2.passive }
  guard acting.count <= 1, !described.isEmpty else { return nil }
  guard let chosen = acting.first ?? (described.count == 1 ? described[0] : nil) else { return nil }
  let (invocation, verbKey, spec) = chosen
  let parsed = cuParseOutput(output)
  let json = parsed.json
  let domain = invocation.domain
  let observation = json?["observation"] as? [String: Any]

  // Outcome.
  let exitFailed = exitCode.map { $0 != 0 } ?? false
  let outputFailed = parsed.okFalse || (parsed.errorMessage != nil && parsed.hitName == nil && parsed.effect == nil)
  let outcome: WorkComputerUseOutcome
  if status == "failed" || status == "interrupted" || exitFailed || outputFailed { outcome = .failed }
  else if status == "running", parsed.effect == nil { outcome = .running }
  else if parsed.effect == "observed" { outcome = .observed }
  else if parsed.effect == "unconfirmed" || parsed.effect == "waiting" { outcome = .unconfirmed }
  else { outcome = .notChecked }
  var reason: String?
  if outcome == .failed {
    reason = parsed.errorMessage
      ?? (parsed.okFalse ? (parsed.values["message"] ?? cuReadString(json?["message"])) : nil)
      ?? (status == "interrupted" ? "Stopped before it finished." : nil)
  } else if outcome == .unconfirmed {
    reason = parsed.effectReason
  }

  // Surface and browser.
  var surface = cuSurface(domain)
  var browserName: String?
  var hostLabel: String?
  if domain == "browser" {
    let user = cuReadUserBrowser(parsed, output: output)
    if user != nil || verbKey == "attach" {
      surface = .userBrowser
      browserName = user?.browser
      hostLabel = user?.host
    }
  }

  // App name.
  var appName: String?
  switch domain {
  case "screen":
    let windowId = invocation.flag("--window", "--window-id")
    let fromWindow = windowId.flatMap { id in parsed.windows.first(where: { $0.id == id })?.app }
    var distinct: [String] = []
    for window in parsed.windows where !distinct.contains(window.app) { distinct.append(window.app) }
    appName = invocation.flag("--app") ?? fromWindow ?? parsed.values["app"]
      ?? (verbKey == "open" ? invocation.positionals.first : nil)
      ?? (distinct.count == 1 ? distinct[0] : nil)
      ?? cuReadString(json?["appName"])
  case "app-control":
    appName = parsed.values["title"] ?? cuReadString(observation?["title"]) ?? cuReadString(json?["title"])
  case "apple":
    appName = parsed.values["app name"] ?? cuReadString(json?["appName"])
      ?? cuAppName(fromBundleId: invocation.flag("--bundle-id", "--bundle") ?? parsed.values["active app"])
  default:
    if surface == .userBrowser { appName = browserName }
  }
  appName = appName.map { cuClip($0, 48) }

  // Target.
  var target: String?
  var targetQuoted = true
  var direction: String?
  var point: String?
  let elementFlag = invocation.flag("--label", "--text-match", "--text", "--name", "--title", "--test-id", "--element", "--placeholder", "--role-name")
  switch spec.target {
  case .element:
    target = parsed.hitName ?? elementFlag
      ?? ((verbKey == "wait" || verbKey == "wait-for-element") ? invocation.flag("--selector", "--window-title") : nil)
      ?? invocation.flag("--selector")
    if target == nil, ["fill", "select", "select-option"].contains(verbKey) {
      target = invocation.flag("--value", "--option") ?? invocation.positionals.last
    }
    if target == nil, let x = invocation.flag("--x"), let y = invocation.flag("--y"), let xv = Double(x), let yv = Double(y) {
      point = "\(Int(xv.rounded())), \(Int(yv.rounded()))"
    }
  case .typed:
    let joined = invocation.positionals.joined(separator: " ")
    target = joined.isEmpty ? invocation.flag("--value", "--string") : joined
  case .key:
    target = invocation.positionals.first ?? invocation.flag("--key", "--button")
  case .direction:
    let raw = (invocation.positionals.first ?? invocation.flag("--direction") ?? "").lowercased()
    direction = ["up", "down", "left", "right"].contains(raw) ? raw : nil
    target = parsed.hitName ?? elementFlag
  case .app:
    if verbKey == "launch", domain == "app-control" {
      target = invocation.flag("--command", "--app") ?? invocation.positionals.joined(separator: " ")
    } else {
      target = invocation.positionals.first ?? invocation.flag("--app", "--bundle-id") ?? appName
    }
    if domain == "apple", let value = target, cuTests(#"^[\w-]+(\.[\w-]+){2,}$"#, value) { target = cuAppName(fromBundleId: value) }
  case .url:
    let url = invocation.positionals.first ?? invocation.flag("--url") ?? parsed.openedUrl
    target = cuUrlHost(url) ?? url.map { cuClip($0, 48) }
    targetQuoted = false
  case .caption:
    target = invocation.flag("--caption", "--title", "--description")
  case .file:
    let file = invocation.flag("--file") ?? invocation.positionals.first
    target = file.map { String($0.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last ?? Substring($0)) }
  case .page:
    target = domain == "browser" ? (parsed.values["title"] ?? cuReadString(observation?["title"])) : nil
  case .none:
    target = nil
  }
  if target?.isEmpty == true { target = nil }

  var past = spec.past
  var progressive = spec.progressive
  var infinitive = spec.infinitive
  if let point {
    target = point
    targetQuoted = false
    past += " at"; progressive += " at"; infinitive += " at"
  }
  let device = domain == "apple" ? cuReadAppleDevice(invocation, output: output) : (name: nil, os: nil)
  if verbKey == "start", domain == "apple" {
    target = device.name
    targetQuoted = false
  }
  var cleanTarget = target.map { cuClip($0) }
  if let direction {
    let suffix = cleanTarget != nil ? " \(direction) in" : " \(direction)"
    past += suffix; progressive += suffix; infinitive += suffix
  }

  // Where.
  var whereText: String?
  if surface == .userBrowser {
    whereText = verbKey == "attach" ? nil : "in your \(browserName ?? "browser")"
  } else if domain == "browser" {
    let host = cuUrlHost(parsed.values["url"] ?? cuReadString(observation?["url"]) ?? cuReadString(json?["url"]) ?? parsed.openedUrl)
    if let host, host != cleanTarget { whereText = "on \(host)" }
  } else if domain == "screen" {
    if verbKey == "open" { whereText = "on the lane screen" }
    else if let appName, appName != cleanTarget { whereText = "in \(appName)" }
  } else if domain == "app-control" || domain == "apple", let appName, appName != cleanTarget {
    whereText = "in \(appName)"
  }
  if direction != nil, cleanTarget != nil { whereText = nil }
  if verbKey == "attach" {
    cleanTarget = "your \(browserName ?? "browser")"
    targetQuoted = false
  }
  // A look at the whole screen names the app, not a page: "Looked at TextEdit".
  if verbKey == "observe" || verbKey == "snapshot", cleanTarget == nil, let appName, domain != "browser" {
    cleanTarget = appName
    targetQuoted = false
    whereText = nil
  }

  let isProof = verbKey.hasPrefix("proof")
  var prNumber: Int?
  if isProof {
    prNumber = parsed.prNumber ?? invocation.flag("--pr").flatMap { value in
      (cuMatch(#"(\d+)\s*$"#, value)?[1] ?? nil).flatMap { Int($0) }
    }
  }
  return WorkComputerUseAction(
    id: "",
    surface: surface,
    domain: domain,
    verb: verbKey,
    past: past,
    progressive: progressive,
    infinitive: infinitive,
    target: cleanTarget,
    targetQuoted: targetQuoted,
    whereText: whereText,
    appName: appName,
    browserName: browserName,
    hostLabel: hostLabel,
    deviceName: device.name,
    deviceOS: device.os,
    screenProduct: invocation.alias.hasPrefix("windows") ? "windows"
      : (invocation.alias.hasPrefix("mac") || invocation.alias.hasPrefix("desk")) ? "mac" : nil,
    outcome: outcome,
    reason: reason.map { cuClip($0, 240) },
    prNumber: prNumber
  )
}

// MARK: - Presentation (desktop `computerUseActionSentence` and friends)

struct WorkComputerUseSentence: Equatable {
  let lead: String
  let target: String?
  let targetQuoted: Bool
  let trailing: String?
}

func workComputerUseSentence(_ action: WorkComputerUseAction, compact: Bool) -> WorkComputerUseSentence {
  let lead: String
  switch action.outcome {
  case .running: lead = action.progressive
  case .failed: lead = "Couldn't \(action.infinitive)"
  default: lead = action.past
  }
  var tails: [String] = []
  if let whereText = action.whereText { tails.append(whereText) }
  var trailing: String? = tails.isEmpty ? nil : tails.joined(separator: " ")
  if let pr = action.prNumber {
    trailing = [trailing, "· on PR #\(pr)"].compactMap { $0 }.joined(separator: " ")
  }
  return WorkComputerUseSentence(lead: lead, target: action.target, targetQuoted: action.targetQuoted, trailing: trailing)
}

func workComputerUseText(_ action: WorkComputerUseAction, compact: Bool) -> String {
  let parts = workComputerUseParts(action, compact: compact)
  let target = parts.target.map { parts.targetQuoted ? "“\($0)”" : $0 }
  let place = parts.place.map { "\($0.preposition) \($0.label)" }
  let using = parts.using.map { "using \($0.label)" }
  let text = [parts.lead, target, place, using, parts.suffix].compactMap { $0 }.joined(separator: " ")
  return action.outcome == .running ? "\(text)…" : text
}

/// Where the action happened: an app ("in TextEdit") or a site ("on localhost:5173").
struct WorkComputerUsePlace: Equatable {
  enum Kind: Equatable { case app, site, other }
  let preposition: String
  let label: String
  let kind: Kind
}

/// One action as one line: "Clicked “Save” in TextEdit using Mac Desktop".
struct WorkComputerUseParts: Equatable {
  let lead: String
  let target: String?
  let targetQuoted: Bool
  let place: WorkComputerUsePlace?
  let using: (label: String, symbol: String, warning: Bool)?
  let suffix: String?

  static func == (lhs: WorkComputerUseParts, rhs: WorkComputerUseParts) -> Bool {
    lhs.lead == rhs.lead && lhs.target == rhs.target && lhs.targetQuoted == rhs.targetQuoted
      && lhs.place == rhs.place && lhs.using?.label == rhs.using?.label && lhs.suffix == rhs.suffix
  }
}

func workComputerUseParts(_ action: WorkComputerUseAction, compact: Bool) -> WorkComputerUseParts {
  let sentence = workComputerUseSentence(action, compact: compact)
  // "Connected to your Chrome on studio-mac": the browser is already the object.
  if action.verb == "attach" {
    return WorkComputerUseParts(
      lead: sentence.lead, target: sentence.target, targetQuoted: sentence.targetQuoted,
      place: action.hostLabel.map { WorkComputerUsePlace(preposition: "on", label: $0, kind: .other) },
      using: nil, suffix: nil
    )
  }
  var place: WorkComputerUsePlace?
  let whereText = action.whereText?.trimmingCharacters(in: .whitespaces) ?? ""
  // "on the lane screen" and "in your Chrome" say what the "using" part says.
  if action.surface != .userBrowser, whereText != "on the lane screen",
     let match = cuMatch(#"^(in|on)\s+(.+)$"#, whereText), let preposition = match[1], let label = match[2] {
    let kind: WorkComputerUsePlace.Kind = label == action.appName ? .app : preposition == "on" ? .site : .other
    place = WorkComputerUsePlace(preposition: preposition, label: label, kind: kind)
  }
  return WorkComputerUseParts(
    lead: sentence.lead, target: sentence.target, targetQuoted: sentence.targetQuoted,
    place: place, using: workComputerUseSurfaceLabel(action),
    suffix: action.prNumber.map { "· on PR #\($0)" }
  )
}

func workComputerUseSurfaceLabel(_ action: WorkComputerUseAction) -> (label: String, symbol: String, warning: Bool) {
  switch action.surface {
  case .laneScreen:
    let label = action.screenProduct == "windows" ? "Windows Desktop"
      : action.screenProduct == "mac" ? "Mac Desktop" : "the lane screen"
    return (label, "display", false)
  case .appControl: return ("App Control", "macwindow", false)
  case .adeBrowser: return ("ADE browser", "globe", false)
  case .userBrowser:
    let browser = "your \(action.browserName ?? "browser")"
    return (action.hostLabel.map { "\(browser) on \($0)" } ?? browser, "person", true)
  case .appleDevice:
    return (action.deviceName ?? "the simulator", "iphone", false)
  case .proof: return ("ADE proof", "checkmark.seal", false)
  }
}

func workComputerUseNote(_ action: WorkComputerUseAction) -> (text: String, danger: Bool)? {
  switch action.outcome {
  case .failed: return action.reason.map { ($0, true) }
  case .unconfirmed: return ("Sent, but no change seen yet", false)
  default: return nil
  }
}

enum WorkComputerUseRunItem: Identifiable, Hashable {
  case action(WorkComputerUseAction)
  case appFold(appName: String, actions: [WorkComputerUseAction])

  var id: String {
    switch self {
    case .action(let action): return action.id
    case .appFold(_, let actions): return "fold:\(actions.first?.id ?? "")"
    }
  }
}

/// Desktop `layoutComputerUseRun`: earlier actions compact (consecutive
/// confirmed actions in one app folded), the latest one in full.
func workComputerUseRunLayout(_ actions: [WorkComputerUseAction]) -> (earlier: [WorkComputerUseRunItem], latest: WorkComputerUseAction?) {
  guard !actions.isEmpty else { return ([], nil) }
  var lastDevice: (String?, String?)? = nil
  let withDevices = actions.map { action -> WorkComputerUseAction in
    guard action.surface == .appleDevice else { return action }
    if action.deviceName != nil {
      lastDevice = (action.deviceName, action.deviceOS)
      return action
    }
    guard let device = lastDevice else { return action }
    var copy = action
    copy.deviceName = device.0
    copy.deviceOS = action.deviceOS ?? device.1
    return copy
  }
  let compact = Array(withDevices.dropLast())
  func foldable(_ action: WorkComputerUseAction) -> Bool {
    action.appName != nil && action.outcome != .failed && action.outcome != .unconfirmed
  }
  var earlier: [WorkComputerUseRunItem] = []
  var index = 0
  while index < compact.count {
    let first = compact[index]
    guard foldable(first), let key = first.appName?.lowercased() else {
      earlier.append(.action(first))
      index += 1
      continue
    }
    var end = index + 1
    while end < compact.count, foldable(compact[end]), compact[end].appName?.lowercased() == key { end += 1 }
    if end - index >= 2 {
      earlier.append(.appFold(appName: first.appName ?? "", actions: Array(compact[index..<end])))
    } else {
      earlier.append(.action(first))
    }
    index = end
  }
  return (earlier, withDevices.last)
}

// MARK: - Reading tool-group members

private let workShellToolNames: Set<String> = ["bash", "shell", "exec_command", "functions.exec_command", "local_shell"]

private func workShellOutputText(_ resultText: String?) -> String? {
  guard let resultText else { return nil }
  guard let object = workJSONObject(from: resultText) else { return resultText }
  var parts: [String] = []
  for key in ["stdout", "stderr", "output", "text", "content", "aggregated_output", "formatted_output"] {
    if let text = object[key] as? String, !text.isEmpty { parts.append(text) }
  }
  return parts.isEmpty ? resultText : parts.joined(separator: "\n")
}

/// Computer-use actions among a tool cluster's members, in order.
func workComputerUseActions(from members: [WorkToolGroupMember]) -> [WorkComputerUseAction] {
  members.compactMap { member -> WorkComputerUseAction? in
    var summary: WorkComputerUseAction?
    switch member {
    case .command(let card):
      summary = workComputerUseSummary(command: card.command, output: card.output, status: card.status.rawValue, exitCode: card.exitCode)
    case .tool(let card):
      let name = card.toolName.lowercased()
      guard workShellToolNames.contains(name) || name.hasSuffix(".exec_command") else { return nil }
      let args = workJSONObject(from: card.argsText)
      let command: String?
      if let text = args?["command"] as? String ?? args?["cmd"] as? String {
        command = text
      } else if let parts = args?["command"] as? [String] ?? args?["cmd"] as? [String] {
        command = parts.joined(separator: " ")
      } else {
        command = nil
      }
      guard let command else { return nil }
      let status = card.status == .running && card.resultText != nil ? "completed" : card.status.rawValue
      summary = workComputerUseSummary(command: command, output: workShellOutputText(card.resultText), status: status)
    case .fileChange:
      return nil
    }
    guard var action = summary else { return nil }
    action.id = member.id
    return action
  }
}

// MARK: - View

/// One run of computer-use actions in the thread (desktop
/// `ChatComputerUseActionRun`). Expansion ids live in the session's central
/// set so an opened row survives cell recycling.
struct WorkComputerUseRunView: View {
  let groupId: String
  let actions: [WorkComputerUseAction]
  var expandedIds: Set<String> = []
  var onToggle: (String) -> Void = { _ in }

  static func expansionId(groupId: String, itemId: String) -> String { "\(groupId)::cu::\(itemId)" }

  var body: some View {
    let layout = workComputerUseRunLayout(actions)
    VStack(alignment: .leading, spacing: 0) {
      ForEach(layout.earlier) { item in
        switch item {
        case .action(let action):
          compactRow(action, expandable: true)
        case .appFold(let appName, let members):
          foldRow(appName: appName, members: members, id: item.id)
        }
      }
      if let latest = layout.latest {
        WorkComputerUseFullRow(action: latest)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .contain)
  }

  @ViewBuilder
  private func compactRow(_ action: WorkComputerUseAction, expandable: Bool) -> some View {
    let expansion = Self.expansionId(groupId: groupId, itemId: action.id)
    let open = expandable && expandedIds.contains(expansion)
    let line = HStack(alignment: .center, spacing: 10) {
      WorkComputerUseActionGlyph(action: action, emphasize: false)
      HStack(spacing: 4) {
        workComputerUseLineText(action, emphasize: false)
          .font(.caption)
          .lineLimit(1)
          .truncationMode(.tail)
          .workComputerUseShimmer(action.outcome == .running)
        if expandable {
          Image(systemName: "chevron.right")
            .font(.system(size: 8, weight: .semibold))
            .foregroundStyle(ADEColor.textMuted)
            .rotationEffect(.degrees(open ? 90 : 0))
        }
        ADEKitDot(tone: dotTone(action))
          .padding(.leading, 4)
      }
      Spacer(minLength: 0)
    }
    .padding(.vertical, 3)
    .frame(minHeight: expandable ? 30 : 22)
    .contentShape(Rectangle())
    if expandable {
      Button { onToggle(expansion) } label: { line }
        .buttonStyle(.plain)
        .accessibilityLabel(workComputerUseText(action, compact: true))
        .accessibilityHint(open ? "Hides details" : "Shows details")
      if open {
        WorkComputerUseFullRow(action: action, nested: true)
          .padding(.leading, 12)
          .overlay(alignment: .leading) { Rectangle().fill(ADEColor.border).frame(width: 1) }
          .padding(.leading, 28)
          .padding(.bottom, 4)
      }
    } else {
      line
    }
  }

  @ViewBuilder
  private func foldRow(appName: String, members: [WorkComputerUseAction], id: String) -> some View {
    let expansion = Self.expansionId(groupId: groupId, itemId: id)
    let open = expandedIds.contains(expansion)
    let using = workComputerUseSurfaceLabel(members[0])
    Button { onToggle(expansion) } label: {
      HStack(alignment: .center, spacing: 10) {
        WorkComputerUseIcon(action: members[0], size: 14)
        HStack(spacing: 4) {
          Text("\(members.count) actions in \(appName) \(Text("using").foregroundColor(ADEColor.textMuted.opacity(0.8))) \(Text(Image(systemName: using.symbol)).foregroundColor(using.warning ? ADEColor.warning : ADEColor.textMuted)) \(Text(using.label).foregroundColor(using.warning ? ADEColor.warning : ADEColor.textMuted))")
            .font(.caption)
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
          Image(systemName: "chevron.right")
            .font(.system(size: 8, weight: .semibold))
            .foregroundStyle(ADEColor.textMuted)
            .rotationEffect(.degrees(open ? 90 : 0))
          ADEKitDot(tone: .neutral)
            .padding(.leading, 4)
        }
        Spacer(minLength: 0)
      }
      .padding(.vertical, 3)
      .frame(minHeight: 30)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(members.count) actions in \(appName) using \(using.label)")
    if open {
      VStack(alignment: .leading, spacing: 0) {
        ForEach(members) { member in compactRow(member, expandable: false) }
      }
      .padding(.leading, 12)
      .overlay(alignment: .leading) { Rectangle().fill(ADEColor.border).frame(width: 1) }
      .padding(.leading, 28)
      .padding(.bottom, 4)
    }
  }

  private func dotTone(_ action: WorkComputerUseAction) -> ADEKitTone {
    switch action.outcome {
    case .failed: return .crit
    case .unconfirmed: return .warn
    default: return .neutral
    }
  }
}

/// The action as one line: "Clicked “Save” in [icon] TextEdit using [icon] Mac Desktop".
func workComputerUseLineText(_ action: WorkComputerUseAction, emphasize: Bool) -> Text {
  let parts = workComputerUseParts(action, compact: !emphasize)
  let failed = action.outcome == .failed
  let base = emphasize ? (failed ? ADEColor.danger : ADEColor.textPrimary) : ADEColor.textMuted
  let quiet = ADEColor.textMuted
  var line = Text(parts.lead).foregroundColor(base)
  if let target = parts.target {
    let targetText = Text(parts.targetQuoted ? " “\(target)”" : " \(target)").foregroundColor(base)
    line = Text("\(line)\(emphasize ? targetText.fontWeight(.medium) : targetText)")
  }
  if let place = parts.place {
    line = Text("\(line)\(Text(" \(place.preposition) ").foregroundColor(quiet))")
    switch place.kind {
    case .app: line = Text("\(line)\(Text(Image(systemName: "macwindow")).foregroundColor(quiet)) ")
    case .site: line = Text("\(line)\(Text(Image(systemName: "globe")).foregroundColor(quiet)) ")
    case .other: break
    }
    line = Text("\(line)\(Text(place.label).foregroundColor(emphasize ? ADEColor.textPrimary : quiet))")
  }
  if let using = parts.using {
    let tone = using.warning ? ADEColor.warning : quiet
    line = Text("\(line)\(Text(" using ").foregroundColor(quiet))")
    if action.surface == .appleDevice {
      line = Text("\(line)\(Text(Image(systemName: "apple.logo")).foregroundColor(tone))")
    }
    line = Text("\(line)\(Text(Image(systemName: using.symbol)).foregroundColor(tone)) \(Text(using.label).foregroundColor(tone))")
  }
  if let suffix = parts.suffix {
    line = Text("\(line)\(Text(" \(suffix)").foregroundColor(quiet))")
  }
  if action.outcome == .running {
    line = Text("\(line)\(Text("…").foregroundColor(base))")
  }
  return line
}

/// The icon for what the action did: a click, typing, a look, a proof.
struct WorkComputerUseActionGlyph: View {
  let action: WorkComputerUseAction
  let emphasize: Bool

  var body: some View {
    Image(systemName: symbol)
      .font(.system(size: emphasize ? 14 : 12, weight: .regular))
      .foregroundStyle(emphasize ? ADEColor.textPrimary.opacity(0.75) : ADEColor.textMuted)
      .frame(width: 18)
      .accessibilityHidden(true)
  }

  private var symbol: String {
    if action.prNumber != nil || action.verb.hasPrefix("proof") { return "checkmark.seal" }
    switch action.verb {
    case "click", "double-click", "right-click", "hover": return "cursorarrow.click"
    case "tap": return "hand.tap"
    case "type", "fill", "clear": return "textformat"
    case "press", "key", "hotkey": return "keyboard"
    case "scroll", "swipe": return "arrow.up.and.down"
    case "drag": return "hand.draw"
    case "observe", "snapshot", "read": return "eye"
    case "screenshot": return "camera"
    case "attach": return "powerplug"
    case "wait", "wait-for-element": return "hourglass"
    case "open", "launch", "relaunch": return "macwindow"
    case "open-url", "navigate", "new-tab", "back", "forward", "reload": return "globe"
    default: return "cursorarrow.click"
    }
  }
}

/// A light sweep over a running action's line, like the desktop's thinking shimmer.
private struct WorkComputerUseShimmer: ViewModifier {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let active: Bool
  @State private var phase: CGFloat = -1

  func body(content: Content) -> some View {
    if active && !reduceMotion {
      content
        .opacity(0.7)
        .overlay {
          GeometryReader { proxy in
            LinearGradient(colors: [.clear, Color.primary.opacity(0.9), .clear], startPoint: .leading, endPoint: .trailing)
              .frame(width: proxy.size.width * 0.35)
              .offset(x: proxy.size.width * phase)
          }
          .mask(content)
          .allowsHitTesting(false)
        }
        .onAppear {
          phase = -0.4
          withAnimation(.linear(duration: 1.6).repeatForever(autoreverses: false)) { phase = 1.1 }
        }
    } else {
      content
    }
  }
}

extension View {
  func workComputerUseShimmer(_ active: Bool) -> some View {
    modifier(WorkComputerUseShimmer(active: active))
  }
}

/// The newest action: the full line, its status, and what went wrong.
struct WorkComputerUseFullRow: View {
  let action: WorkComputerUseAction
  var nested = false

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      WorkComputerUseActionGlyph(action: action, emphasize: true)
      VStack(alignment: .leading, spacing: 3) {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          workComputerUseLineText(action, emphasize: true)
            .font(.subheadline)
            .lineLimit(2)
            .workComputerUseShimmer(action.outcome == .running)
          statusGlyph
        }
        if let note = workComputerUseNote(action) {
          Text(note.text)
            .font(.caption)
            .foregroundStyle(note.danger ? ADEColor.danger : ADEColor.warning)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      Spacer(minLength: 0)
    }
    .padding(.vertical, nested ? 2 : 5)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(workComputerUseText(action, compact: false))
  }

  @ViewBuilder
  private var statusGlyph: some View {
    switch action.outcome {
    case .running:
      EmptyView()
    case .failed:
      Image(systemName: "xmark.circle").font(.system(size: 13)).foregroundStyle(ADEColor.danger)
    case .unconfirmed:
      Image(systemName: "exclamationmark.triangle").font(.system(size: 12)).foregroundStyle(ADEColor.warning)
    default:
      Image(systemName: "checkmark.circle").font(.system(size: 13)).foregroundStyle(ADEColor.success)
    }
  }
}

/// SF Symbol stand-in for the app icon: the phone cannot read the Mac's app
/// icons, so each surface gets its own neutral glyph.
struct WorkComputerUseIcon: View {
  let action: WorkComputerUseAction
  let size: CGFloat

  var body: some View {
    Image(systemName: symbol)
      .font(.system(size: size * 0.78, weight: .regular))
      .foregroundStyle(ADEColor.textMuted)
      .frame(width: 18, height: size)
      .accessibilityHidden(true)
  }

  private var symbol: String {
    switch action.surface {
    case .laneScreen, .appControl: return "macwindow"
    case .adeBrowser, .userBrowser: return "globe"
    case .appleDevice: return "iphone"
    case .proof: return "checkmark.seal"
    }
  }
}
