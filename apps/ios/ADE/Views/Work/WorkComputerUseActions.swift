import SwiftUI

// Computer-use action rows in the chat thread (desktop
// `ChatComputerUseActions.tsx`) and the shell-tool reading behind them
// (desktop `chatComputerUseRows.ts`). The actions come from
// `WorkComputerUseSummary.swift`, the Swift port of the desktop parser; the
// words from `WorkComputerUsePresentation.swift`.

// MARK: - Reading tool-group members

/// Computer-use actions among a tool cluster's members, in order.
func workComputerUseActions(from members: [WorkToolGroupMember]) -> [WorkComputerUseAction] {
  members.compactMap { member -> WorkComputerUseAction? in
    var summary: WorkComputerUseAction?
    switch member {
    case .command(let card):
      summary = workComputerUseSummary(command: card.command, output: card.output, status: card.status.rawValue, exitCode: card.exitCode)
    case .tool(let card):
      guard let input = workComputerUseToolInput(
        toolName: card.toolName, argsText: card.argsText, resultText: card.resultText, status: card.status.rawValue
      ) else { return nil }
      summary = workComputerUseSummary(command: input.command, output: input.output, status: input.status, exitCode: input.exitCode)
    case .fileChange:
      return nil
    }
    guard var action = summary else { return nil }
    action.id = member.id
    return action
  }
}

// MARK: - Reading a shell tool call (desktop `chatComputerUseRows.ts`)

/// Desktop `isShellToolName`: Claude `Bash`, Codex `exec_command`, OpenCode
/// `shell`, ADE `bash`, also under a namespace (`functions.exec_command`).
private let workShellToolNames: Set<String> = ["Bash", "bash", "shell", "exec_command"]

func workIsShellToolName(_ name: String) -> Bool {
  if workShellToolNames.contains(name) { return true }
  let afterDot = name.components(separatedBy: ".").last ?? ""
  let afterNamespace = name.components(separatedBy: "__").last ?? ""
  return workShellToolNames.contains(afterDot) || workShellToolNames.contains(afterNamespace)
}

/// Desktop `computerUseCommandText`: an argv array as one line of shell, its spaced parts quoted.
func workComputerUseCommandText(_ parts: [String]) -> String {
  parts.map { part in
    part.rangeOfCharacter(from: .whitespacesAndNewlines) != nil
      ? "'\(part.replacingOccurrences(of: "'", with: "'\\''"))'"
      : part
  }.joined(separator: " ")
}

private let workTextOfContentKeys = ["stdout", "stderr", "output", "text", "content", "aggregated_output", "formatted_output"]
private let workExitCodeKeys = ["exitCode", "exit_code", "returncode"]

/// Desktop `textOfContent`: a tool result as the text a terminal would have shown.
func workComputerUseTextOfContent(_ value: Any?, depth: Int = 0) -> String {
  guard depth <= 3, let value, !(value is NSNull) else { return "" }
  if let text = value as? String { return text }
  if let array = value as? [Any] {
    return array.map { workComputerUseTextOfContent($0, depth: depth + 1) }.filter { !$0.isEmpty }.joined(separator: "\n")
  }
  guard let record = value as? [String: Any] else { return "" }
  var parts: [String] = []
  for key in workTextOfContentKeys {
    let text = workComputerUseTextOfContent(record[key], depth: depth + 1)
    if !text.isEmpty { parts.append(text) }
  }
  if parts.isEmpty {
    let error = (record["error"] as? String) ?? ((record["error"] as? [String: Any])?["message"] as? String)
    if let error { parts.append("ade: \(error)") }
  }
  return parts.joined(separator: "\n")
}

/// The phone gets a tool result as text: a string result as itself, a
/// structured one as JSON. Read the JSON back only when it has the shape of a
/// structured result (output keys, an exit code, or a bare error), so a CLI's
/// own JSON printed to stdout stays the output it was.
private func workToolResultValue(_ resultText: String) -> Any {
  guard let data = resultText.data(using: .utf8),
        let object = try? JSONSerialization.jsonObject(with: data) else { return resultText }
  if let record = object as? [String: Any] {
    let structured = workTextOfContentKeys.contains { record[$0] != nil }
      || workExitCodeKeys.contains { record[$0] != nil }
      || (record["error"] != nil && record["ok"] == nil)
    return structured ? record : resultText
  }
  if let array = object as? [Any],
     array.contains(where: { $0 is String || (($0 as? [String: Any]).map { item in workTextOfContentKeys.contains { item[$0] != nil } } ?? false) }) {
    return array
  }
  return resultText
}

/// Desktop `computerUseInputForEntry` for a shell tool call: the command it
/// ran, its output, its status, and its exit code. Nil for any other tool.
func workComputerUseToolInput(toolName: String, argsText: String?, resultText: String?, status: String)
  -> WorkComputerUseToolInput? {
  guard workIsShellToolName(toolName) else { return nil }
  // Keyed by the raw texts, so a cache hit skips both JSON parses. A running
  // call's result still grows; read it fresh.
  guard status != "running" else {
    return workReadComputerUseToolInput(argsText: argsText, resultText: resultText, status: status)
  }
  let key = "\(toolName)\u{0}\(status)\u{0}\(argsText.map(cuCacheTextKey) ?? "-")\u{0}\(resultText.map(cuCacheTextKey) ?? "-")"
  if let cached = workCUToolInputCache.value(key) { return cached.input }
  let input = workReadComputerUseToolInput(argsText: argsText, resultText: resultText, status: status)
  workCUToolInputCache.store(key, WorkCUToolInputBox(input: input))
  return input
}

typealias WorkComputerUseToolInput = (command: String, output: String?, status: String, exitCode: Int?)

private struct WorkCUToolInputBox { let input: WorkComputerUseToolInput? }
private let workCUToolInputCache = WorkCUCache<WorkCUToolInputBox>()

private func workReadComputerUseToolInput(argsText: String?, resultText: String?, status: String) -> WorkComputerUseToolInput? {
  var args: [String: Any] = [:]
  if let data = argsText?.data(using: .utf8), let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
    args = object
  }
  let raw: Any? = (args["command"] is String || args["command"] is [Any]) ? args["command"] : args["cmd"]
  let command: String
  if let text = raw as? String {
    command = text
  } else if let parts = raw as? [String] {
    command = workComputerUseCommandText(parts)
  } else {
    return nil
  }
  guard !command.isEmpty else { return nil }
  guard let resultText else { return (command, nil, status, nil) }
  let result = workToolResultValue(resultText)
  var exitCode: Int?
  if let record = result as? [String: Any] {
    for key in workExitCodeKeys {
      if let number = record[key] as? NSNumber, CFGetTypeID(number as CFTypeRef) != CFBooleanGetTypeID() {
        exitCode = number.intValue
        break
      }
    }
  }
  return (command, workComputerUseTextOfContent(result), status == "running" ? "completed" : status, exitCode)
}

// MARK: - View

/// One run of computer-use actions in the thread (desktop
/// `ChatComputerUseActionRun`). Expansion ids live in the session's central
/// set so an opened row survives cell recycling.
struct WorkComputerUseRunView: View {
  let groupId: String
  let actions: [WorkComputerUseAction]
  /// Not the turn's newest run: its newest action draws compact too.
  var compactAll = false
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
        if compactAll {
          compactRow(latest, expandable: true)
        } else {
          WorkComputerUseFullRow(action: latest)
        }
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
        .accessibilityLabel(workComputerUseText(action))
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
  let parts = workComputerUseParts(action)
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
    case "press", "key": return "keyboard"
    case "scroll", "swipe": return "arrow.up.and.down"
    case "drag": return "hand.draw"
    case "observe", "snapshot": return "eye"
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
    .accessibilityLabel(workComputerUseText(action))
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
