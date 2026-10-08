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
/// `ChatComputerUseActionRun`). No row opens: the line is all there is to say.
struct WorkComputerUseRunView: View {
  let actions: [WorkComputerUseAction]
  /// Not the turn's newest run: its newest action draws compact too.
  var compactAll = false

  var body: some View {
    let layout = workComputerUseRunLayout(actions)
    VStack(alignment: .leading, spacing: 0) {
      ForEach(layout.earlier) { line in compactRow(line) }
      if let latest = layout.latest {
        if compactAll {
          compactRow(latest)
        } else {
          WorkComputerUseFullRow(action: latest.action, count: latest.count)
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .contain)
  }

  private func compactRow(_ line: WorkComputerUseRunLine) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      compactLine(line)
      WorkComputerUseProofThumbnails(action: line.action)
    }
  }

  private func compactLine(_ line: WorkComputerUseRunLine) -> some View {
    HStack(alignment: .center, spacing: 10) {
      WorkComputerUseActionGlyph(action: line.action, emphasize: false)
      HStack(spacing: 4) {
        workComputerUseLineText(line.action, emphasize: false)
          .font(.caption)
          .lineLimit(1)
          .truncationMode(.tail)
          .workComputerUseShimmer(line.action.outcome == .running)
        WorkComputerUseRepeatCount(count: line.count)
        ADEKitDot(tone: dotTone(line.action))
          .padding(.leading, 4)
      }
      Spacer(minLength: 0)
    }
    .padding(.vertical, 3)
    .frame(minHeight: 22)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(workComputerUseAccessibilityText(line.action, count: line.count))
  }

  private func dotTone(_ action: WorkComputerUseAction) -> ADEKitTone {
    switch action.outcome {
    case .failed: return .crit
    case .unconfirmed: return .warn
    default: return .neutral
    }
  }
}

/// "×3": how many identical actions one line stands for.
struct WorkComputerUseRepeatCount: View {
  let count: Int

  var body: some View {
    if count > 1 {
      Text("×\(count)")
        .font(.caption.monospacedDigit())
        .foregroundStyle(ADEColor.textMuted)
    }
  }
}

func workComputerUseAccessibilityText(_ action: WorkComputerUseAction, count: Int) -> String {
  let text = workComputerUseText(action)
  return count > 1 ? "\(text), \(count) times" : text
}

/// The action as one line: "Clicked “Save” in [icon] TextEdit", "Pressed “Escape” on [icon] Mac Desktop".
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
    line = Text("\(line)\(Text(" \(using.preposition) ").foregroundColor(quiet))")
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
  var count = 1

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      line
      WorkComputerUseProofThumbnails(action: action)
    }
  }

  private var line: some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      WorkComputerUseActionGlyph(action: action, emphasize: true)
      VStack(alignment: .leading, spacing: 3) {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          workComputerUseLineText(action, emphasize: true)
            .font(.subheadline)
            .lineLimit(2)
            .workComputerUseShimmer(action.outcome == .running)
          WorkComputerUseRepeatCount(count: count)
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
    .padding(.vertical, 5)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(workComputerUseAccessibilityText(action, count: count))
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

/// The pictures a filed-proof line filed, small, under the line and flush with
/// the thread's left edge (desktop `ProofThumbnails`). Nothing for any other action.
struct WorkComputerUseProofThumbnails: View {
  let action: WorkComputerUseAction

  var body: some View {
    let ids = workComputerUseShownProofIds(action)
    if !ids.isEmpty {
      HStack(spacing: 6) {
        ForEach(ids, id: \.self) { id in WorkProofActionThumbnail(artifactId: id) }
      }
      .padding(.bottom, 4)
    }
  }
}

/// One filed proof's picture, 64pt tall (desktop `ProofActionThumbnail`). It
/// loads when it scrolls in; a tap opens it full screen, as an answer's
/// citation does, without the drawer. A record the chat cannot find, or one
/// that is not a picture or a video, draws nothing: the line already says
/// what was filed.
struct WorkProofActionThumbnail: View {
  let artifactId: String

  static let height: CGFloat = 64

  @Environment(\.workProofCitations) private var citations
  @State private var viewerOpen = false

  var body: some View {
    if let citations,
       let artifact = citations.artifactsById[artifactId] ?? citations.lookup?(artifactId),
       workArtifactIsImage(artifact) || workArtifactIsVideo(artifact) {
      media(artifact, content: citations.content[artifactId])
        .task(id: artifactId) {
          if citations.content[artifactId] == nil { await citations.load(artifact, .preview) }
        }
        .fullScreenCover(isPresented: $viewerOpen) {
          WorkProofViewer(
            artifacts: [artifact],
            artifactContent: citations.content,
            initialArtifactId: artifact.id,
            onLoadArtifact: citations.load
          )
        }
    }
  }

  @ViewBuilder
  private func media(_ artifact: ComputerUseArtifactSummary, content: WorkLoadedArtifactContent?) -> some View {
    let shape = RoundedRectangle(cornerRadius: 7, style: .continuous)
    switch content {
    case .image(let image):
      Button {
        viewerOpen = true
      } label: {
        Image(uiImage: image)
          .resizable()
          .scaledToFit()
          .frame(height: Self.height)
          .clipShape(shape)
          .overlay(shape.strokeBorder(ADEColor.border.opacity(0.3)))
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Enlarge \(text(artifact))")
    case .remoteURL(let url) where workArtifactIsImage(artifact):
      Button {
        viewerOpen = true
      } label: {
        AsyncImage(url: url) { image in
          image.resizable().scaledToFit()
        } placeholder: {
          Color.clear.frame(width: Self.height)
        }
        .frame(height: Self.height)
        .clipShape(shape)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Enlarge \(text(artifact))")
    case .video, .videoOnDemand, .remoteURL:
      // The phone has no poster for a recording; a quiet play tile stands in.
      Button {
        viewerOpen = true
      } label: {
        Image(systemName: "play.fill")
          .font(.system(size: 16, weight: .semibold))
          .foregroundStyle(.white.opacity(0.85))
          .frame(width: Self.height * 16 / 10, height: Self.height)
          .background(Color.black.opacity(0.85), in: shape)
          .overlay(shape.strokeBorder(ADEColor.border.opacity(0.3)))
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Play \(text(artifact))")
    case .none:
      // Room held while it loads, so the row does not jump when it lands.
      Color.clear.frame(width: 1, height: Self.height)
    case .text, .error:
      EmptyView()
    }
  }

  private func text(_ artifact: ComputerUseArtifactSummary) -> String {
    let description = artifact.description?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return description.isEmpty ? artifact.title : description
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
