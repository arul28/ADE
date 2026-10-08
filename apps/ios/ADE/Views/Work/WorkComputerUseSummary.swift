import Foundation

// What a computer-use shell command did, in words a reader can follow.
//
// A faithful port of the desktop parser,
// `apps/desktop/src/shared/computerUseActionSummary.ts` and
// `computerUseActionOutput.ts`: an agent's `ade screen click …` / `ade browser
// fill …` / `"$ADE_CLI_PATH" apple tap …` shell call becomes "Clicked
// “Checkout” on localhost:5173".
// Keep them in step — the same command and output must read the same on the
// phone and on the desktop. Anything this cannot describe with confidence
// returns nil and keeps its plain tool row. The words are in
// `WorkComputerUsePresentation.swift` (desktop
// `computerUseActionPresentation.ts`); reading a shell tool call (desktop
// `chatComputerUseRows.ts`) and the rows themselves are in
// `WorkComputerUseActions.swift`.

enum WorkComputerUseSurface: String, Hashable {
  case laneScreen, appControl, adeBrowser, userBrowser, appleDevice, proof
}

enum WorkComputerUseOutcome: String, Hashable {
  case running, observed, unconfirmed, notChecked, failed
}

/// Where the action happened, when that is not already the surface: an app
/// ("in TextEdit") or a site ("on localhost:5173").
struct WorkComputerUsePlace: Hashable {
  enum Kind: Hashable { case app, site, other }
  let preposition: String
  let label: String
  let kind: Kind
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
  var target: String?
  var targetQuoted: Bool
  var place: WorkComputerUsePlace?
  var appName: String?
  let browserName: String?
  let hostLabel: String?
  var deviceName: String?
  var deviceOS: String?
  /// Which lane screen the command named: "mac" (`ade mac-desktop`), "windows", or nil for `ade screen`.
  var screenProduct: String? = nil
  let outcome: WorkComputerUseOutcome
  let reason: String?
  let prNumber: Int?
  /// Proof ids the output named: the record a capture or attach filed, or the
  /// records a publish posted.
  var proofIds: [String] = []
  /// Set by the run layout: a later `proof publish` posted this record to that PR.
  var postedToPr: Int? = nil
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

/// `text.split(regex)` as JavaScript does it.
private func cuSplit(_ pattern: String, _ text: String) -> [String] {
  guard let regex = WorkCURegexCache.shared.regex(pattern, []) else { return [text] }
  var parts: [String] = []
  var start = text.startIndex
  for match in regex.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
    guard let range = Range(match.range, in: text) else { continue }
    parts.append(String(text[start..<range.lowerBound]))
    start = range.upperBound
  }
  parts.append(String(text[start...]))
  return parts
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
  /// Whether it surely ran: `.or` beside a `||` (it may have been skipped, or
  /// the exit code is another command's), `.and` after a `&&` (skipped when
  /// the command before it failed), nil otherwise.
  var conditional: CUShellConditional? = nil
  /// What reached the transcript of its output: `.none` as printed, `.cite`
  /// when only its `cite:` lines were kept (`| grep cite:`), `.other` when a
  /// pipe or redirect cut or hid it.
  var outputFilter: CUOutputFilter = .none

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

private enum CUShellConditional { case or, and }

private enum CUOutputFilter { case none, cite, other }

/// One simple command, whether a `||` or `&&` makes it conditional, and the
/// command its output is piped into.
private struct CUShellCommand {
  let tokens: [String]
  let conditional: CUShellConditional?
  var pipedInto: [String]? = nil
}

private enum CUParseResult {
  case none
  case control
  case invocation(CUInvocation)
}

/// Quote-aware split into simple commands on `&&`, `||`, `;`, `|`, `&`,
/// newlines; each notes whether a `||` or `&&` makes it conditional.
private func cuSplitShellCommands(_ source: String) -> [CUShellCommand] {
  var commands: [CUShellCommand] = []
  var tokens: [String] = []
  var current = ""
  var hasToken = false
  var quote: Character? = nil
  // The operator before the command being read; a newline after `||` / `&&`
  // continues it.
  var before: String? = nil
  let chars = Array(source)
  func pushToken() {
    if hasToken { tokens.append(current) }
    current = ""
    hasToken = false
  }
  func pushCommand(_ after: String?) {
    pushToken()
    if !tokens.isEmpty {
      let conditional: CUShellConditional? = before == "||" || after == "||"
        ? .or
        : before == "&&" ? .and : nil
      if before == "|", !commands.isEmpty { commands[commands.count - 1].pipedInto = tokens }
      commands.append(CUShellCommand(tokens: tokens, conditional: conditional))
      tokens = []
      before = after
    } else if after != "\n" || before == nil {
      before = after
    }
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
    } else if char == "&", current.hasSuffix(">") || current.hasSuffix("<")
                || (index + 1 < chars.count && chars[index + 1] == ">") {
      // `2>&1` and `&>file` are redirections, not the background operator: a
      // split there would cut `ade … 2>&1 || true` off from its `||`.
      current.append(char)
      hasToken = true
    } else if char == "\n" || char == ";" || char == "|" || char == "&" {
      let doubled = (char == "|" || char == "&") && index + 1 < chars.count && chars[index + 1] == char
      if doubled { index += 1 }
      pushCommand(doubled ? "\(char)\(char)" : String(char))
    } else if char == " " || char == "\t" || char == "\r" {
      pushToken()
    } else {
      current.append(char)
      hasToken = true
    }
    index += 1
  }
  pushCommand(nil)
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
  /// `attached: …` (or the JSON attach result); "" when only the flag was seen.
  var attachedLine: String?
  /// `target: …` (or JSON `userBrowserTarget`): "your Google Chrome on studio-mac".
  var userBrowserTarget: String?
  var prNumber: Int?
  /// Proof ids the output named: `cite: ![…](ade-proof://<id>)`, or the JSON record.
  var proofIds: [String] = []
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
  for rawLine in output.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n") {
    let line = rawLine.replacingOccurrences(of: #"\s+$"#, with: "", options: .regularExpression)
    let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { continue }
    let lower = trimmed.lowercased()
    if lower.hasPrefix("hit:"), parsed.hitName == nil, !parsed.hitNone {
      let rest = String(trimmed.dropFirst(4)).trimmingCharacters(in: .whitespaces)
      if rest.lowercased().hasPrefix("no element") { parsed.hitNone = true } else { parsed.hitName = cuQuotedName(rest) }
      continue
    }
    if lower.hasPrefix("effect:"), parsed.effect == nil {
      let rest = String(trimmed.dropFirst(7)).trimmingCharacters(in: .whitespaces)
      let parts = cuSplit(#"\s+—\s+|\s+-\s+"#, rest)
      let status = (parts.first ?? "").lowercased()
      if status.hasPrefix("observed") { parsed.effect = "observed" }
      else if status.hasPrefix("unconfirmed") { parsed.effect = "unconfirmed" }
      else if status.hasPrefix("waiting") { parsed.effect = "waiting" }
      else if status.hasPrefix("not checked") || status.hasPrefix("not_checked") { parsed.effect = "not_checked" }
      let reason = parts.dropFirst().joined(separator: " — ").trimmingCharacters(in: .whitespaces)
      parsed.effectReason = reason.isEmpty ? nil : reason
      continue
    }
    if parsed.errorMessage == nil, cuTests(#"^ade:\s"#, trimmed) {
      let message = String(trimmed.dropFirst(4)).trimmingCharacters(in: .whitespacesAndNewlines)
        .replacingOccurrences(of: #"^[A-Z][A-Z0-9_]{3,}:\s*"#, with: "", options: .regularExpression)
      parsed.errorMessage = message.isEmpty ? nil : message
      continue
    }
    if lower.hasPrefix(workUserBrowserAttachedPrefix), parsed.attachedLine == nil {
      parsed.attachedLine = String(trimmed.dropFirst(workUserBrowserAttachedPrefix.count)).trimmingCharacters(in: .whitespacesAndNewlines)
      continue
    }
    if lower.hasPrefix(workUserBrowserTargetPrefix), parsed.userBrowserTarget == nil {
      parsed.userBrowserTarget = String(trimmed.dropFirst(workUserBrowserTargetPrefix.count)).trimmingCharacters(in: .whitespacesAndNewlines)
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
      parsed.values[key] = value.trimmingCharacters(in: .whitespacesAndNewlines)
    }
  }
  if parsed.values["ok"] == "false" { parsed.okFalse = true }
  if let regex = WorkCURegexCache.shared.regex(#"ade-proof:/{0,2}([\w-]+)"#, [.caseInsensitive]) {
    for match in regex.matches(in: output, range: NSRange(output.startIndex..., in: output)) {
      if let range = Range(match.range(at: 1), in: output), !parsed.proofIds.contains(String(output[range])) {
        parsed.proofIds.append(String(output[range]))
      }
    }
  }
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
    if parsed.userBrowserTarget == nil { parsed.userBrowserTarget = cuReadString(json["userBrowserTarget"]) }
    let nested = [json["artifact"] as? [String: Any]] + ((json["artifacts"] as? [Any]) ?? []).map { $0 as? [String: Any] }
    for (index, record) in ([json as [String: Any]?] + nested).enumerated() {
      let id = cuReadString(record?["proofArtifactId"]) ?? cuReadString(record?["artifactId"])
        ?? (index == 0 ? nil : cuReadString(record?["id"]))
      if let id, !parsed.proofIds.contains(id) { parsed.proofIds.append(id) }
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
  guard let components = URLComponents(string: withScheme), let host = components.host?.lowercased(), !host.isEmpty else { return nil }
  let scheme = components.scheme?.lowercased()
  if scheme == "about" || scheme == "data" { return nil }
  // Like a WHATWG URL's `host`: the default port is not part of it.
  if let port = components.port, !((scheme == "http" && port == 80) || (scheme == "https" && port == 443)) { return "\(host):\(port)" }
  return host
}

// These mirror `apps/desktop/src/shared/userBrowserLabels.ts`: the browsers
// `ade browser attach` can reach, their short names, and the line prefixes.
private let workUserBrowserIds = ["chrome", "edge", "brave", "arc", "helium", "chromium"]
private let workUserBrowserShortNames: [String: String] = [
  "chrome": "Chrome", "edge": "Edge", "brave": "Brave", "arc": "Arc", "helium": "Helium", "chromium": "Chromium",
]
private let workUserBrowserAttachedPrefix = "attached:"
private let workUserBrowserTargetPrefix = "target:"

/// "Google Chrome" → "Chrome": the short name of the first browser the text names.
private func cuUserBrowserShortName(_ text: String?) -> String? {
  guard let text, !text.isEmpty else { return nil }
  for id in workUserBrowserIds where cuTests("\\b\(id)\\b", text, [.caseInsensitive]) {
    return workUserBrowserShortNames[id]
  }
  return nil
}

/// The user's own browser, when the output says the command reached it (desktop `readUserBrowser`).
private func cuReadUserBrowser(_ parsed: CUOutput) -> (browser: String?, host: String?)? {
  let target = parsed.userBrowserTarget.flatMap { cuMatch(#"^your\s+(.+?)\s+on\s+(.+?)$"#, $0, [.caseInsensitive]) }
  guard parsed.attachedLine != nil || target != nil else { return nil }
  let attached = parsed.attachedLine.flatMap { $0.isEmpty ? nil : cuMatch(#"^(.+?)\s+on\s+(.+?)(?:,\s*tab\b.*)?$"#, $0, [.caseInsensitive]) }
  let source = (target?[1] ?? nil) ?? (attached?[1] ?? nil) ?? (parsed.attachedLine?.isEmpty == false ? parsed.attachedLine : nil)
  let browser = cuUserBrowserShortName(source)
    ?? cuUserBrowserShortName(parsed.values["browser"])
    ?? cuUserBrowserShortName(cuReadString(parsed.json?["browserLabel"]))
    ?? cuUserBrowserShortName(cuReadString(parsed.json?["browser"]))
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
  for command in cuSplitShellCommands(source) {
    let tokens = command.tokens
    let head = cuBasename(tokens.first ?? "")
    if cuShells.contains(head), depth < 2,
       let flagIndex = tokens.indices.first(where: { $0 > 0 && cuTests(#"^-[a-z]*c$"#, tokens[$0], [.caseInsensitive]) }),
       flagIndex + 1 < tokens.count {
      guard let inner = cuFindInvocations(tokens[flagIndex + 1], depth: depth + 1) else { return nil }
      // A script behind `||` or `&&` is as conditional as its own commands.
      found.append(contentsOf: inner.map { entry in
        var entry = entry
        entry.conditional = cuStrongerConditional(entry.conditional, command.conditional)
        return entry
      })
      continue
    }
    switch cuParseInvocation(tokens, aliasVars: aliasVars) {
    case .control: return nil
    case .invocation(var invocation):
      invocation.conditional = command.conditional
      invocation.outputFilter = cuOutputFilter(command)
      found.append(invocation)
    case .none: break
    }
  }
  return found
}

/// Desktop `outputFilterOf`: stdout sent to a file (`>out`, `&>/dev/null`, not
/// `2>&1`), or piped into a filter.
private func cuOutputFilter(_ command: CUShellCommand) -> CUOutputFilter {
  if command.tokens.contains(where: { cuTests(#"^(?:1|&)?>>?(?!&)"#, $0) }) { return .other }
  guard let pipe = command.pipedInto else { return .none }
  let head = cuBasename(pipe.first ?? "")
  let keepsCites = ["grep", "egrep", "rg"].contains(head)
    && pipe.dropFirst().contains(where: { !$0.hasPrefix("-") && cuTests("cite|ade-proof", $0, [.caseInsensitive]) })
  return keepsCites ? .cite : .other
}

/// The less certain of two: `.or` over `.and` over unconditional.
private func cuStrongerConditional(_ left: CUShellConditional?, _ right: CUShellConditional?) -> CUShellConditional? {
  if left == .or || right == .or { return .or }
  return left ?? right
}

// MARK: - Summary

/// A small bounded cache, cleared whole at 300 entries (desktop `summaryCache`).
final class WorkCUCache<Value>: @unchecked Sendable {
  private var cache: [String: Value] = [:]
  private let lock = NSLock()
  func value(_ key: String) -> Value? {
    lock.lock(); defer { lock.unlock() }
    return cache[key]
  }
  func store(_ key: String, _ value: Value) {
    lock.lock(); defer { lock.unlock() }
    if cache.count >= 300 { cache.removeAll() }
    cache[key] = value
  }
}

private let workCUSummaryCache = WorkCUCache<WorkComputerUseAction?>()

private let cuCacheOutputEdge = 2048

/// The text's length plus its head and tail, not the whole text (desktop
/// `summaryCacheKey`): two runs can share a long observation and differ only
/// in a later `effect:` or error line, which lands in the tail.
func cuCacheTextKey(_ text: String) -> String {
  let length = text.utf8.count
  guard length > cuCacheOutputEdge * 2 else { return "\(length)\u{0}\(text)" }
  return "\(length)\u{0}\(text.prefix(cuCacheOutputEdge))\u{0}\(text.suffix(cuCacheOutputEdge))"
}

/// A cheap first look: the command names an `ade` executable or the ADE CLI
/// path variable (desktop `ADE_COMMAND_HINT`).
private let cuAdeCommandHint = #"(?:^|[\s"'`/\\;&|(=])ade(?:\.(?:exe|cmd|ps1))?(?=$|[\s"'`;&|)])|ADE_CLI_PATH"#

/// Summarize one shell command (desktop `summarizeComputerUseCommand`).
/// `status` is `running`, `completed`, `failed` or `interrupted`.
func workComputerUseSummary(command: String, output: String?, status: String, exitCode: Int? = nil) -> WorkComputerUseAction? {
  guard !command.isEmpty, cuTests(cuAdeCommandHint, command, [.caseInsensitive]) else { return nil }
  let output = output ?? ""
  // A running command's output still grows; summarize it fresh every time.
  let cacheable = status != "running"
  let key = cacheable
    ? "\(status)\u{0}\(exitCode.map(String.init) ?? "")\u{0}\(command)\u{0}\(cuCacheTextKey(output))"
    : ""
  if cacheable, let cached = workCUSummaryCache.value(key) { return cached }
  // No ADE invocation at all: not worth a cache slot.
  guard let invocations = cuFindInvocations(command), !invocations.isEmpty else { return nil }
  let summary = cuBuildSummary(invocations: invocations, output: output, status: status, exitCode: exitCode)
  if cacheable { workCUSummaryCache.store(key, summary) }
  return summary
}

/// The object of the sentence, and how the verb reads around it (desktop `TargetShape`).
private struct CUTargetShape {
  var target: String?
  var quoted = true
  var direction: String?
  var point = false
}

private let cuNumberPattern = #"^-?\d+(\.\d+)?$"#

/// JavaScript `Math.round` as text: halves round up, toward +∞. A value too large
/// for `Int` prints as a Double, like JavaScript does, instead of trapping.
private func cuJSRound(_ value: Double) -> String {
  let rounded = (value + 0.5).rounded(.down)
  guard rounded.isFinite, abs(rounded) < 1e15 else { return "\(rounded)" }
  return String(Int(rounded))
}

private func cuDescribeTarget(spec: CUVerbSpec, verbKey: String, invocation: CUInvocation, parsed: CUOutput, appName: String?) -> CUTargetShape {
  var shape = CUTargetShape()
  let elementFlag = invocation.flag("--label", "--text-match", "--text", "--name", "--title", "--test-id", "--element", "--placeholder", "--role-name")
  switch spec.target {
  case .element:
    shape.target = parsed.hitName ?? elementFlag
      ?? ((verbKey == "wait" || verbKey == "wait-for-element") ? invocation.flag("--selector", "--window-title") : nil)
      ?? invocation.flag("--selector")
    if shape.target == nil, ["fill", "select", "select-option"].contains(verbKey) {
      shape.target = invocation.flag("--value", "--option") ?? invocation.positionals.last
    }
    if shape.target == nil, let x = invocation.flag("--x"), let y = invocation.flag("--y"),
       cuTests(cuNumberPattern, x), cuTests(cuNumberPattern, y), let xv = Double(x), let yv = Double(y) {
      return CUTargetShape(target: "\(cuJSRound(xv)), \(cuJSRound(yv))", quoted: false, direction: nil, point: true)
    }
  case .typed:
    let joined = invocation.positionals.joined(separator: " ")
    shape.target = joined.isEmpty ? invocation.flag("--value", "--string") : joined
  case .key:
    shape.target = invocation.positionals.first ?? invocation.flag("--key", "--button")
  case .direction:
    let raw = (invocation.positionals.first ?? invocation.flag("--direction") ?? "").lowercased()
    shape.direction = ["up", "down", "left", "right"].contains(raw) ? raw : nil
    shape.target = parsed.hitName ?? elementFlag
  case .app:
    var target: String?
    // `app-control launch` takes a shell command (`npm run dev`), which is no
    // name for the app: it reads as its label or window title, or none.
    if verbKey == "launch", invocation.domain == "app-control" {
      return CUTargetShape(target: invocation.flag("--label", "--name") ?? appName, quoted: false, direction: nil, point: false)
    } else {
      target = invocation.positionals.first ?? invocation.flag("--app", "--bundle-id") ?? appName
    }
    if invocation.domain == "apple", let value = target, !value.isEmpty, cuTests(#"^[\w-]+(\.[\w-]+){2,}$"#, value) {
      target = cuAppName(fromBundleId: value)
    }
    shape.target = target
  case .url:
    let url = invocation.positionals.first ?? invocation.flag("--url") ?? parsed.openedUrl
    return CUTargetShape(target: cuUrlHost(url) ?? url.flatMap { $0.isEmpty ? nil : cuClip($0, 48) }, quoted: false, direction: nil, point: false)
  case .caption:
    shape.target = invocation.flag("--caption", "--title", "--description")
  case .file:
    let file = invocation.flag("--file") ?? invocation.positionals.first
    shape.target = file.map { String($0.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last ?? Substring($0)) }
  case .page:
    shape.target = invocation.domain == "browser"
      ? (parsed.values["title"] ?? cuReadString((parsed.json?["observation"] as? [String: Any])?["title"]))
      : nil
  case .none:
    break
  }
  return shape
}

private func cuBuildSummary(invocations: [CUInvocation], output: String, status: String, exitCode: Int?) -> WorkComputerUseAction? {
  let described = invocations.compactMap { invocation -> (CUInvocation, String, CUVerbSpec)? in
    guard let verb = cuResolveVerb(invocation) else { return nil }
    return (invocation, verb.key, verb.spec)
  }
  // Two acting commands in one call: whose output is whose is a guess.
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
  let commandFailed = status == "failed" || status == "interrupted" || exitFailed || outputFailed
  // Beside a `||` it may never have run, and the exit code may be the other
  // command's. After a `&&` it ran only if the command before it succeeded,
  // which a failed call cannot tell apart from the action failing. Either way
  // the row would state something the call does not show: keep the shell row.
  if invocation.conditional == .or || (invocation.conditional == .and && commandFailed) { return nil }
  var outcome: WorkComputerUseOutcome
  if commandFailed { outcome = .failed }
  else if status == "running", parsed.effect == nil { outcome = .running }
  else if parsed.effect == "observed" { outcome = .observed }
  else if parsed.effect == "unconfirmed" || parsed.effect == "waiting" { outcome = .unconfirmed }
  else { outcome = .notChecked }
  // A filed proof prints its id. A call that exits 0 without one did not file
  // it: the exit code can be a later command's in the same call. No output at
  // all says nothing either way (the transcript may not have carried it).
  let filesProof = cuFilesProof.contains(verbKey)
  var missingProof: String?
  let sawOutput = !output.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || invocation.outputFilter == .cite
  if filesProof, sawOutput, outcome != .failed, outcome != .running, parsed.proofIds.isEmpty {
    if invocation.outputFilter == .other {
      outcome = .unconfirmed
      missingProof = "Its output was cut off, so ADE could not see the proof filed."
    } else {
      outcome = .failed
      missingProof = "No proof was filed."
    }
  }
  var reason: String?
  if outcome == .failed {
    reason = parsed.errorMessage
      ?? (parsed.okFalse ? (parsed.values["message"] ?? cuReadString(json?["message"])) : nil)
      ?? (status == "interrupted" ? "Stopped before it finished." : nil)
      ?? missingProof
  } else if outcome == .unconfirmed {
    reason = missingProof ?? parsed.effectReason
  }

  // Surface and browser.
  var surface = cuSurface(domain)
  var browserName: String?
  var hostLabel: String?
  if domain == "browser" {
    let user = cuReadUserBrowser(parsed)
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
  if let name = appName, !name.isEmpty { appName = cuClip(name, 48) } else { appName = nil }

  // Target and the words around it.
  let device = domain == "apple" ? cuReadAppleDevice(invocation, output: output) : (name: nil, os: nil)
  // `apple start` names the device it booted.
  let shape = verbKey == "start" && domain == "apple"
    ? CUTargetShape(target: device.name, quoted: false, direction: nil, point: false)
    : cuDescribeTarget(spec: spec, verbKey: verbKey, invocation: invocation, parsed: parsed, appName: appName)
  var target = shape.target.flatMap { raw -> String? in
    let clipped = cuClip(raw)
    return clipped.isEmpty ? nil : clipped
  }
  var targetQuoted = shape.quoted
  let at = shape.point ? " at" : ""
  // "Scrolled down in “Notes list”", or plain "Scrolled down".
  let toward = shape.direction.map { target != nil ? " \($0) in" : " \($0)" } ?? ""

  // Where, when the surface does not already say it.
  var place: WorkComputerUsePlace?
  if surface == .userBrowser {
    place = nil
  } else if domain == "browser" {
    let host = cuUrlHost(parsed.values["url"] ?? cuReadString(observation?["url"]) ?? cuReadString(json?["url"]) ?? parsed.openedUrl)
    if let host, host != target { place = WorkComputerUsePlace(preposition: "on", label: host, kind: .site) }
  } else if domain == "screen" || domain == "app-control" || domain == "apple" {
    // `screen open` happens on the lane screen, which "using …" names.
    let opensApp = domain == "screen" && verbKey == "open"
    if !opensApp, let appName, appName != target { place = WorkComputerUsePlace(preposition: "in", label: appName, kind: .app) }
  }
  // "Scrolled down in “Notes list”" already says where.
  if shape.direction != nil, target != nil { place = nil }
  // Connected to your browser: the browser is the object.
  if verbKey == "attach" {
    target = "your \(browserName ?? "browser")"
    targetQuoted = false
  }
  // A look at the whole screen names the app, not a page: "Looked at TextEdit".
  if verbKey == "observe" || verbKey == "snapshot", target == nil, let appName, domain != "browser" {
    target = appName
    targetQuoted = false
    place = nil
  }

  var prNumber: Int?
  var proofIds: [String] = []
  if verbKey.hasPrefix("proof") {
    prNumber = parsed.prNumber ?? invocation.flag("--pr").flatMap { value in
      (cuMatch(#"(\d+)\s*$"#, value)?[1] ?? nil).flatMap { Int($0) }
    }
    // A publish names the records it posts; anything else, the one it filed.
    if verbKey == "proof publish" {
      for id in invocation.positionals.filter({ cuTests(cuProofIdPattern, $0) }) + parsed.proofIds where !proofIds.contains(id) {
        proofIds.append(id)
      }
    } else if filesProof {
      proofIds = parsed.proofIds
    }
  }
  return WorkComputerUseAction(
    id: "",
    surface: surface,
    domain: domain,
    verb: verbKey,
    past: spec.past + at + toward,
    progressive: spec.progressive + at + toward,
    infinitive: spec.infinitive + at + toward,
    target: target,
    targetQuoted: targetQuoted,
    place: place,
    appName: appName,
    browserName: browserName,
    hostLabel: hostLabel,
    deviceName: device.name,
    deviceOS: device.os,
    screenProduct: invocation.alias.hasPrefix("windows") ? "windows"
      : (invocation.alias.hasPrefix("mac") || invocation.alias.hasPrefix("desk")) ? "mac" : nil,
    outcome: outcome,
    reason: reason.flatMap { $0.isEmpty ? nil : cuClip($0, 240) },
    prNumber: prNumber,
    proofIds: proofIds
  )
}

/// Verbs that file one proof record and print its id.
private let cuFilesProof: Set<String> = ["proof", "proof capture", "proof attach"]

/// A proof record id as `proof publish` takes it.
private let cuProofIdPattern = #"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"#
