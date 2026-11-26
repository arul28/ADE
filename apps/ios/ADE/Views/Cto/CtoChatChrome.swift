import SwiftUI

// The CTO thread's calm rendering on iOS: quiet chips for its state changes,
// one working line during a live turn, a "Fresh context" hairline, and the
// floating header pill. Ports desktop `components/chat/cto/` (ctoToolWords,
// CtoToolChips, CtoWorkingLine) and `components/cto/CtoHeaderPill`.

// MARK: - Live state

/// What the CTO is doing, shared by the header pill, the profile sheet and the
/// working line. The thread (`WorkChatSessionView`) writes the turn facts; the
/// CTO tab writes the look, name and machine facts.
@MainActor
final class CtoLiveModel: ObservableObject {
  @Published var look: CtoAvatarLook? = nil
  @Published var name: String = "CTO"
  @Published var turnActive = false
  @Published var streamingText = false
  @Published var awaitingInput = false
  @Published var liveStep: String? = nil
  @Published var runningChildren = 0
  @Published var offline = false
  @Published var noModel = false
  @Published var lastTurnFailed = false
  /// The CTO chat, once the tab has it.
  @Published var sessionId: String? = nil
  /// When the live turn began; nil between turns.
  var turnStartedAt: Date? = nil

  /// Opens the profile sheet (the pill's tap).
  var onOpenProfile: (() -> Void)? = nil
  /// Opens settings (the rail's gear on a phone).
  var onOpenSettings: (() -> Void)? = nil

  init() {}

  var asleep: Bool { offline || noModel }

  /// "Idle", "Working…", "Writing…", "Waiting on you", "Asleep" (desktop `ctoStatusPhrase`).
  var statusPhrase: String { ctoStatusPhrase(asleep: asleep, awaitingInput: awaitingInput, turnActive: turnActive, streamingText: streamingText, runningChildren: runningChildren) }

  var avatarState: CtoAvatarState {
    if asleep { return .asleep }
    if awaitingInput { return .waiting }
    if turnActive { return streamingText ? .thinking : .working }
    if lastTurnFailed { return .error }
    return .idle
  }

  func applyTurn(active: Bool, streaming: Bool, awaiting: Bool, step: String?, failed: Bool) {
    if turnActive != active { turnActive = active }
    if streamingText != streaming { streamingText = streaming }
    if awaitingInput != awaiting { awaitingInput = awaiting }
    if liveStep != step { liveStep = step }
    if lastTurnFailed != failed { lastTurnFailed = failed }
  }
}

/// The CTO thread's turn facts, as the chat view derives them.
struct WorkCtoLiveFacts: Equatable {
  var active: Bool
  var streaming: Bool
  var awaiting: Bool
  var step: String?
}

func ctoStatusPhrase(asleep: Bool, awaitingInput: Bool, turnActive: Bool, streamingText: Bool, runningChildren: Int) -> String {
  if asleep { return "Asleep" }
  if awaitingInput { return "Waiting on you" }
  if turnActive { return streamingText ? "Writing…" : "Working…" }
  if runningChildren > 0 { return "Working on \(runningChildren) \(runningChildren == 1 ? "thing" : "things")" }
  return "Idle"
}

private struct CtoLiveModelKey: EnvironmentKey {
  static let defaultValue: CtoLiveModel? = nil
}

extension EnvironmentValues {
  /// Set on the CTO thread only: the rail draws the CTO pill from it.
  var ctoLiveModel: CtoLiveModel? {
    get { self[CtoLiveModelKey.self] }
    set { self[CtoLiveModelKey.self] = newValue }
  }
}

// MARK: - Header pill

/// The thread's header: the CTO's live avatar, its name and one status
/// phrase, in the floating capsule. Tapping it opens the profile.
struct CtoHeaderPillLabel: View {
  @ObservedObject var model: CtoLiveModel

  var body: some View {
    Button {
      ADEHaptics.light()
      model.onOpenProfile?()
    } label: {
      HStack(spacing: 8) {
        CtoAvatarView(look: model.look, state: model.avatarState, size: 26, motion: .lazy)
        Text(model.name)
          .font(.system(.subheadline, design: .rounded).weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
          .layoutPriority(1)
        Text(model.statusPhrase)
          .font(.system(.footnote, design: .rounded).weight(.medium))
          .foregroundStyle(model.avatarState == .waiting ? model.look.ctoAccent : ADEColor.textSecondary)
          .lineLimit(1)
          .truncationMode(.tail)
          .contentTransition(.opacity)
      }
      .padding(.leading, 6)
      .padding(.trailing, 14)
      .frame(height: DuoChatHeaderCapsules.height)
      .contentShape(Capsule())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(model.name), \(model.statusPhrase.lowercased())")
    .accessibilityHint("Opens \(model.name)'s profile")
    .accessibilityIdentifier("Cto.HeaderPill")
  }
}

// MARK: - Tool words

/// The bare tool name, whatever namespace the provider wrapped it in:
/// `mcp__ade__scheduleWork`, `ade.scheduleWork`, `ade/scheduleWork`, `scheduleWork`.
func ctoToolBaseName(_ toolName: String) -> String {
  let raw = toolName.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !raw.isEmpty else { return "" }
  let parts = raw.replacingOccurrences(of: "__", with: "/")
    .split(whereSeparator: { $0 == "." || $0 == "/" || $0 == ":" })
    .map(String.init)
    .filter { !$0.isEmpty }
  return parts.last ?? raw
}

private func ctoJSONObject(_ text: String?) -> [String: Any]? {
  guard let text = text?.trimmingCharacters(in: .whitespacesAndNewlines), text.hasPrefix("{"),
        let data = text.data(using: .utf8),
        let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
  else { return nil }
  // MCP wraps a JSON result in `{ content: [{ type: "text", text }] }`.
  if let content = object["content"] as? [[String: Any]],
     let first = content.first(where: { ($0["type"] as? String) == "text" }),
     let inner = first["text"] as? String,
     let unwrapped = ctoJSONObject(inner) {
    return unwrapped
  }
  return object
}

private func ctoStr(_ value: Any?) -> String? {
  guard let text = value as? String else { return nil }
  let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
  return trimmed.isEmpty ? nil : trimmed
}

/// The first line, clipped at a word to about `max` characters.
func ctoClipWords(_ text: String, max: Int = 48) -> String {
  var line = text.split(whereSeparator: \.isNewline).first.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? ""
  if line.hasPrefix("- ") || line.hasPrefix("* ") { line = String(line.dropFirst(2)) }
  guard line.count > max else { return line }
  let cut = String(line.prefix(max - 1))
  if let space = cut.lastIndex(of: " "), cut.distance(from: cut.startIndex, to: space) > Int(Double(max) * 0.6) {
    return String(cut[..<space]).trimmingCharacters(in: .whitespaces) + "…"
  }
  return cut.trimmingCharacters(in: .whitespaces) + "…"
}

enum CtoChipKind: String {
  case scheduled, cancelled, paused, resumed, remembered, forgot, tracking, done

  var verb: String {
    switch self {
    case .scheduled: return "Scheduled"
    case .cancelled: return "Cancelled"
    case .paused: return "Paused"
    case .resumed: return "Resumed"
    case .remembered: return "Saved note"
    case .forgot: return "Dropped note"
    case .tracking: return "Tracking"
    case .done: return "Done"
    }
  }

  var failedVerb: String {
    switch self {
    case .scheduled: return "Couldn't schedule"
    case .cancelled: return "Couldn't cancel"
    case .paused: return "Couldn't pause"
    case .resumed: return "Couldn't resume"
    case .remembered: return "Couldn't save note"
    case .forgot: return "Couldn't drop note"
    case .tracking: return "Couldn't track"
    case .done: return "Couldn't finish"
    }
  }

  var symbol: String {
    switch self {
    case .scheduled: return "alarm"
    case .cancelled: return "calendar.badge.minus"
    case .paused: return "pause.circle"
    case .resumed: return "play.circle"
    case .remembered: return "bookmark"
    case .forgot: return "eraser"
    case .tracking: return "circle"
    case .done: return "checkmark.circle.fill"
    }
  }
}

struct CtoToolChip: Identifiable, Hashable {
  let id: String
  let kind: CtoChipKind
  let verb: String
  let text: String?
  let failed: Bool
}

/// State-changing CTO tools that draw a chip instead of hiding in the tools list.
private let ctoChipToolNames: Set<String> = [
  "scheduleWork", "cancelScheduledWork", "setScheduledWorkPaused", "remember", "forget", "trackWork", "finishWork",
]

/// The chip for one finished state-changing CTO call, or nil while it runs
/// (the working line names it then) and for every other tool.
func ctoChip(for card: WorkToolCardModel) -> CtoToolChip? {
  let name = ctoToolBaseName(card.toolName)
  guard ctoChipToolNames.contains(name), card.status != .running else { return nil }
  let args = ctoJSONObject(card.argsText) ?? [:]
  let result = ctoJSONObject(card.resultText)
  let payload = (result?["result"] as? [String: Any]) ?? (result?["item"] as? [String: Any]) ?? result
  if result?["declined"] as? Bool == true || result?["cancelled"] as? Bool == true { return nil }
  let failed = card.status == .failed
    || result?["success"] as? Bool == false
    || ctoStr(result?["error"]) != nil

  let kind: CtoChipKind
  let text: String?
  switch name {
  case "scheduleWork":
    kind = .scheduled
    text = ctoStr(payload?["title"]) ?? ctoStr(args["reason"]) ?? ctoStr(args["prompt"])
  case "cancelScheduledWork":
    kind = .cancelled
    text = ctoStr(payload?["title"]) ?? ctoStr(payload?["reason"]) ?? ctoStr(payload?["prompt"])
  case "setScheduledWorkPaused":
    kind = (args["paused"] as? Bool) == false ? .resumed : .paused
    text = ctoStr(payload?["title"]) ?? (args["scheduleId"] == nil ? "every routine on that chat" : nil)
  case "remember":
    kind = .remembered
    text = ctoStr(args["note"])
  case "forget":
    kind = .forgot
    text = ctoStr(args["note"])
  case "trackWork":
    kind = .tracking
    text = ctoStr(args["text"]) ?? ctoStr(payload?["text"])
  case "finishWork":
    kind = .done
    text = ctoStr(payload?["text"]) ?? ctoStr(args["outcome"])
  default:
    return nil
  }
  return CtoToolChip(id: card.id, kind: kind, verb: failed ? kind.failedVerb : kind.verb, text: text.map { ctoClipWords($0) }, failed: failed)
}

func ctoChips(for members: [WorkToolGroupMember]) -> [CtoToolChip] {
  members.compactMap { member in
    if case .tool(let card) = member { return ctoChip(for: card) }
    return nil
  }
}

/// One running step in plain words: "Checking PR #12", "Reading a chat".
func ctoStepWords(toolName: String, argsText: String?) -> String? {
  let name = ctoToolBaseName(toolName)
  let args = ctoJSONObject(argsText) ?? [:]
  let prNumber = (args["prNumber"] as? Int) ?? (args["number"] as? Int)
  let pr = prNumber.map { "PR #\($0)" } ?? "a PR"
  switch name {
  case "spawnChat":
    if let modelId = ctoStr(args["modelId"]), let slash = modelId.firstIndex(of: "/") {
      let prefix = String(modelId[..<slash])
      let provider = ["anthropic": "Claude", "openai": "Codex"][prefix] ?? prefix.capitalized
      return "Starting a chat on \(provider)"
    }
    return "Starting a chat"
  case "listChats": return "Looking over the chats"
  case "getChatStatus", "getSessionLifecycle": return "Checking on a chat"
  case "getChatTranscript": return "Reading a chat"
  case "waitForChats":
    let count = (args["sessionIds"] as? [Any])?.count ?? 0
    return count > 1 ? "Waiting on \(count) chats" : "Waiting on a chat"
  case "sendChatMessage", "steerChat": return "Messaging a chat"
  case "interruptChat": return "Stopping a chat"
  case "handoffChatToModel": return "Handing off a chat"
  case "listLanes", "inspectLane": return "Looking at the lanes"
  case "createLane": return "Making a lane"
  case "listPullRequests": return "Checking the PRs"
  case "getPullRequestStatus", "getPullRequestDiff", "watchPullRequest": return "Checking \(pr)"
  case "commentOnPullRequest": return "Commenting on \(pr)"
  case "createPrFromLane": return "Opening a PR"
  case "landPullRequest": return "Landing \(pr)"
  case "approvePullRequest": return "Approving \(pr)"
  case "readWorkspaceFile", "Read": return "Reading a file"
  case "searchWorkspaceText", "searchCodebase", "searchProject", "Grep", "Glob": return "Searching the project"
  case "readHistory": return "Reading our history"
  case "replyNow": return "Replying"
  case "noReply": return "Wrapping up"
  case "react": return "Reacting"
  case "remember": return "Saving a note"
  case "forget": return "Dropping a note"
  case "trackWork": return "Noting open work"
  case "finishWork": return "Closing out open work"
  case "scheduleWork": return "Scheduling a check-in"
  case "listScheduledWork", "getScheduledWorkState": return "Checking the schedule"
  case "cancelScheduledWork": return "Cancelling a routine"
  case "setScheduledWorkPaused": return (args["paused"] as? Bool) == false ? "Resuming a routine" : "Pausing a routine"
  case "runTests": return "Running tests"
  case "listLinearIssues", "getLinearIssue": return "Reading Linear"
  case "getUsageSnapshot", "getUsageStats", "getBudgetStatus": return "Checking usage"
  case "listMachines": return "Looking at your machines"
  case "runMachineAction": return "Acting on a machine"
  case "listComputerUseArtifacts", "getArtifactPreview", "reviewArtifact": return "Looking at proof"
  case "captureProof": return "Filing proof"
  case "gitStatus", "gitListRecentCommits", "gitListBranches": return "Checking git"
  case "getRecentEvents", "getProjectHealthSummary": return "Catching up on the project"
  case "listSubagents": return "Checking helpers"
  case "Bash", "PowerShell": return "Running a command"
  case "ToolSearch", "loadCtoTools": return "Finding the right tool"
  case "WebSearch", "WebFetch": return "Searching the web"
  case "Task", "Agent": return "Starting a helper"
  case "TodoWrite": return "Planning"
  default: return ctoHumanizedToolName(name)
  }
}

private let ctoToolVerbWords: [String: String] = [
  "list": "Looking at", "get": "Checking", "read": "Reading", "search": "Searching", "find": "Finding",
  "inspect": "Looking at", "create": "Making", "update": "Updating", "set": "Setting", "run": "Running",
  "start": "Starting", "send": "Sending", "open": "Opening", "check": "Checking", "review": "Reviewing",
  "fetch": "Fetching",
]

/// `listAutomationRules` → "Looking at automation rules"; nil without a known verb.
private func ctoHumanizedToolName(_ name: String) -> String? {
  var spaced = ""
  var previous: Character? = nil
  for character in name {
    if character.isUppercase, let previous, previous.isLowercase || previous.isNumber { spaced.append(" ") }
    spaced.append(character == "_" || character == "-" ? " " : character)
    previous = character
  }
  let words = spaced.lowercased().split(separator: " ").map(String.init)
  guard words.count >= 2, let verb = ctoToolVerbWords[words[0]] else { return nil }
  return "\(verb) \(words.dropFirst().joined(separator: " "))"
}

/// The newest running step of a live turn, in plain words.
func ctoLatestStepWords(_ members: [WorkToolGroupMember]) -> String? {
  for member in members.reversed() {
    switch member {
    case .tool(let card):
      guard card.status == .running else { continue }
      if let words = ctoStepWords(toolName: card.toolName, argsText: card.argsText) { return words }
    case .command(let card):
      if card.status == .running { return "Running a command" }
    case .fileChange(let card):
      if card.status == .running { return "Editing a file" }
    }
  }
  return nil
}

// MARK: - Chips

/// The CTO's state changes as quiet chips: "Scheduled · Daily check-in",
/// "Saved note · Deploys go through staging first". One line each.
struct CtoToolChipsRow: View {
  let chips: [CtoToolChip]
  let accent: Color

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      ForEach(chips) { chip in
        CtoToolChipView(chip: chip, accent: accent)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.vertical, 2)
  }
}

struct CtoToolChipView: View {
  let chip: CtoToolChip
  let accent: Color

  private var tint: Color { chip.failed ? ADEColor.warning : accent }

  var body: some View {
    HStack(spacing: 6) {
      Image(systemName: chip.failed ? "exclamationmark.triangle" : chip.kind.symbol)
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(tint)
      Text(chip.verb)
        .font(.footnote.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary.opacity(0.82))
        .fixedSize()
      if let text = chip.text {
        Text(text)
          .font(.footnote)
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
          .truncationMode(.tail)
      }
    }
    .padding(.horizontal, 10)
    .frame(minHeight: 28)
    .background(tint.opacity(0.11), in: Capsule())
    .overlay(Capsule().strokeBorder(tint.opacity(0.18), lineWidth: 0.5))
    .accessibilityElement(children: .combine)
    .accessibilityLabel(chip.text.map { "\(chip.verb): \($0)" } ?? chip.verb)
  }
}

// MARK: - Greeting

/// What the CTO's empty thread shows: it says hi and offers a start. A
/// starter fills the composer; the person finishes it. Same words as the
/// desktop greeting (`CtoGreeting.tsx`).
struct CtoGreetingView: View {
  @ObservedObject var live: CtoLiveModel
  /// Fills the composer. Nil when this chat can't take a message here.
  var onPick: ((String) -> Void)?

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var shown = false

  private struct Starter: Hashable {
    let label: String
    let prefill: String
  }

  private static let starters: [Starter] = [
    Starter(label: "What's going on?", prefill: "What's going on in this project right now?"),
    Starter(label: "Every morning…", prefill: "Every weekday at 9am, "),
    Starter(label: "Remember that…", prefill: "Remember that "),
    Starter(label: "Get a chat on it", prefill: "Start a chat to "),
  ]

  var body: some View {
    let accent = live.look.ctoAccent
    VStack(spacing: 0) {
      ZStack {
        CtoAvatarHalo(color: accent, diameter: 220)
        CtoAvatarView(look: live.look, state: .idle, size: 96, motion: .live, label: "\(live.name), idle", blips: false)
      }
      .frame(height: 150)
      Text("Hey, I'm \(live.name)")
        .font(.system(.title3, design: .rounded).weight(.bold))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)
      Text("Ask me anything, or give me something to do on a schedule.")
        .font(.subheadline)
        .foregroundStyle(ADEColor.textSecondary)
        .multilineTextAlignment(.center)
        .padding(.top, 4)
        .padding(.horizontal, 32)
      if let onPick {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)], spacing: 8) {
          ForEach(Self.starters, id: \.label) { starter in
            Button {
              ADEHaptics.light()
              onPick(starter.prefill)
            } label: {
              Text(starter.label)
                .font(.footnote.weight(.medium))
                .foregroundStyle(ADEColor.textPrimary.opacity(0.85))
                .lineLimit(1)
                .frame(maxWidth: .infinity, minHeight: 40)
                .background(accent.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(accent.opacity(0.2), lineWidth: 0.5))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Starts your message with this")
          }
        }
        .padding(.top, 20)
        .padding(.horizontal, 24)
      }
    }
    .frame(maxWidth: .infinity)
    .padding(.top, 36)
    .padding(.bottom, 12)
    .opacity(shown ? 1 : 0)
    .offset(y: shown ? 0 : 10)
    .onAppear {
      if reduceMotion {
        shown = true
      } else {
        withAnimation(.spring(response: 0.45, dampingFraction: 0.82)) { shown = true }
      }
    }
    .accessibilityIdentifier("Cto.Greeting")
  }
}

// MARK: - Fresh context

/// ADE gave the CTO a fresh provider thread: a hairline, not a card.
struct CtoFreshContextDivider: View {
  var body: some View {
    HStack(spacing: 10) {
      Rectangle().fill(ADEFlat.hairline).frame(height: 0.5)
      Text("Fresh context")
        .font(.caption.weight(.medium))
        .foregroundStyle(ADEColor.textMuted)
        .lineLimit(1)
        .fixedSize()
      Rectangle().fill(ADEFlat.hairline).frame(height: 0.5)
    }
    .padding(.vertical, 10)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Fresh context")
  }
}

// MARK: - Working line

/// The live turn: the CTO at work on a soft glow, big enough to move, the
/// step it is on in plain words, and how long the turn has run. Tap for the
/// steps.
struct CtoWorkingLine: View {
  let look: CtoAvatarLook?
  let members: [WorkToolGroupMember]
  let streamingText: Bool
  let startedAt: Date?
  var onOpenSteps: (() -> Void)? = nil

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private var running: Bool { members.contains { $0.status == .running } }
  private var doneCount: Int { members.filter { $0.status != .running }.count }

  private var step: String {
    if let words = ctoLatestStepWords(members) { return words }
    if streamingText { return "Writing" }
    return running ? "Working" : "Thinking"
  }

  var body: some View {
    let accent = look.ctoAccent
    let row = HStack(spacing: 12) {
      ZStack {
        Circle()
          .fill(RadialGradient(colors: [accent.opacity(0.34), accent.opacity(0)], center: .center, startRadius: 0, endRadius: 30))
          .frame(width: 60, height: 60)
          // A phase animator, not a one-shot state: the row remounts inside a
          // Button once the first step lands, and the glow must keep breathing.
          .phaseAnimator(reduceMotion ? [false] : [false, true]) { glow, up in
            glow
              .scaleEffect(up ? 1.06 : 0.92)
              .opacity(up ? 0.85 : 0.45)
          } animation: { _ in
            .easeInOut(duration: streamingText ? 0.8 : 1.2)
          }
        CtoAvatarView(
          look: look,
          state: streamingText && !running ? .thinking : .working,
          size: 44,
          motion: .live,
          blips: false
        )
      }
      .frame(width: 48, height: 48)
      VStack(alignment: .leading, spacing: 2) {
        Text(step)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary.opacity(0.9))
          .lineLimit(1)
          .truncationMode(.tail)
        HStack(spacing: 6) {
          // Only the time ticks; the avatar is not redrawn every second.
          TimelineView(.periodic(from: .now, by: 1)) { context in
            Text(WorkActivityIndicator.formatElapsedSeconds(Int(context.date.timeIntervalSince(startedAt ?? context.date))))
              .monospacedDigit()
          }
          if doneCount > 0 {
            Text("·").foregroundStyle(ADEColor.textMuted.opacity(0.6))
            Text(doneCount == 1 ? "1 step" : "\(doneCount) steps")
          }
          if onOpenSteps != nil, !members.isEmpty {
            Image(systemName: "chevron.right")
              .font(.system(size: 9, weight: .bold))
              .foregroundStyle(ADEColor.textMuted.opacity(0.7))
          }
        }
        .font(.caption)
        .foregroundStyle(ADEColor.textMuted)
        .lineLimit(1)
      }
    }
    .padding(.vertical, 6)
    .padding(.leading, 6)
    .padding(.trailing, 16)
    .background(accent.opacity(0.07), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(accent.opacity(0.16), lineWidth: 0.5))
    .contentShape(Rectangle())
    Group {
      if let onOpenSteps, !members.isEmpty {
        Button(action: onOpenSteps) { row }
          .buttonStyle(.plain)
          .accessibilityHint("Shows the steps so far")
      } else {
        row
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(step)
    .accessibilityValue(doneCount == 0 ? "" : (doneCount == 1 ? "1 step done" : "\(doneCount) steps done"))
    .accessibilityIdentifier("Cto.WorkingLine")
  }
}

/// CTO-thread cards that are plumbing, not news: its quiet context refreshes
/// and the "approaching plan limit" warning (the composer's usage ring says
/// the same). Desktop hides the same two.
func ctoThreadHidesCard(_ card: WorkEventCardModel) -> Bool {
  if card.kind == "ctoFresh" { return true }
  return card.noticeKind == "rate_limit" && (card.body ?? "").hasPrefix("Approaching")
}

// MARK: - Waiting on you

private struct CtoStoreKey: EnvironmentKey {
  static let defaultValue: CtoStore? = nil
}

extension EnvironmentValues {
  /// Set on the CTO thread only: the "Waiting on you" card reads its needs.
  var ctoStore: CtoStore? {
    get { self[CtoStoreKey.self] }
    set { self[CtoStoreKey.self] = newValue }
  }
}

extension View {
  /// Keeps the CTO store's needs fresh while the CTO thread is on screen, and
  /// reports whether the "Waiting on you" card shows. A no-op off the CTO
  /// thread (no `ctoStore` in the environment).
  ///
  /// Reads on appear and on app foreground, when a CTO turn ends, shortly
  /// after chat events settle, and every 60 s while on screen with the app
  /// active (children move without CTO events). Nothing runs while hidden.
  func ctoNeedsFeed(sessionId: String, turnActive: Bool, eventToken: Int, shown: Binding<Bool>) -> some View {
    modifier(CtoNeedsFeed(sessionId: sessionId, turnActive: turnActive, eventToken: eventToken, shown: shown))
  }
}

private struct CtoNeedsFeed: ViewModifier {
  let sessionId: String
  let turnActive: Bool
  let eventToken: Int
  @Binding var shown: Bool

  @Environment(\.ctoStore) private var store
  @Environment(\.ctoLiveModel) private var live

  func body(content: Content) -> some View {
    if let store, let live {
      content.modifier(CtoNeedsFeedAwake(live: live, store: store, sessionId: sessionId, turnActive: turnActive, eventToken: eventToken, shown: $shown))
    } else if let store {
      content.modifier(CtoNeedsFeedActive(store: store, asleep: false, sessionId: sessionId, turnActive: turnActive, eventToken: eventToken, shown: $shown))
    } else {
      content
    }
  }
}

/// Watches the CTO's sleep: the card hides while it sleeps, so the composer keeps no room for it.
private struct CtoNeedsFeedAwake: ViewModifier {
  @ObservedObject var live: CtoLiveModel
  let store: CtoStore
  let sessionId: String
  let turnActive: Bool
  let eventToken: Int
  @Binding var shown: Bool

  func body(content: Content) -> some View {
    content.modifier(CtoNeedsFeedActive(store: store, asleep: live.asleep, sessionId: sessionId, turnActive: turnActive, eventToken: eventToken, shown: $shown))
  }
}

private struct CtoNeedsFeedActive: ViewModifier {
  @ObservedObject var store: CtoStore
  let asleep: Bool
  let sessionId: String
  let turnActive: Bool
  let eventToken: Int
  @Binding var shown: Bool

  @Environment(\.scenePhase) private var scenePhase
  @State private var visible = false

  private var active: Bool { visible && scenePhase == .active }

  func body(content: Content) -> some View {
    content
      .onAppear { visible = true }
      .onDisappear { visible = false }
      // The card's own condition (`CtoWaitingOnYouSlot`).
      .onChange(of: !asleep && (!store.needs.isEmpty || store.needsFailed), initial: true) { _, show in
        if shown != show { shown = show }
      }
      // Appear, foreground, then every 60 s while on screen and active.
      .task(id: "\(sessionId)|\(active)") {
        guard active else { return }
        await store.loadNeeds(force: true)
        while !Task.isCancelled {
          try? await Task.sleep(nanoseconds: 60_000_000_000)
          guard !Task.isCancelled else { return }
          await store.loadNeeds(force: true)
        }
      }
      // Chat events for the CTO: one read once they settle (throttled).
      .task(id: eventToken) {
        try? await Task.sleep(nanoseconds: 2_000_000_000)
        guard !Task.isCancelled, active else { return }
        await store.loadNeeds()
      }
      .onChange(of: turnActive) { wasActive, isActive in
        guard wasActive, !isActive, active else { return }
        Task { await store.loadNeeds(force: true) }
      }
  }
}

/// The foot of the CTO thread, above the composer: one row per chat the CTO
/// started that needs the person, with the CTO's line saying what to do. A
/// row opens that chat. Draws nothing off the CTO thread or with nothing
/// waiting; `ctoNeedsFeed` keeps it fresh.
struct CtoWaitingOnYouSlot: View {
  @Environment(\.ctoStore) private var store
  @Environment(\.ctoLiveModel) private var live

  var body: some View {
    if let store, let live {
      CtoWaitingOnYouAwake(live: live, store: store)
    } else if let store {
      CtoWaitingOnYouCard(store: store)
    }
  }
}

/// The card hides while the CTO sleeps; its lines come back when it wakes.
private struct CtoWaitingOnYouAwake: View {
  @ObservedObject var live: CtoLiveModel
  let store: CtoStore

  var body: some View {
    if !live.asleep {
      CtoWaitingOnYouCard(store: store)
    }
  }
}

private struct CtoWaitingOnYouCard: View {
  @ObservedObject var store: CtoStore

  @Environment(\.ctoLiveModel) private var live
  /// "+N more" opens the rest in place, as on desktop.
  @State private var expanded = false

  private static let maxRows = 3

  private var accent: Color { live?.look.ctoAccent ?? ADEColor.ctoAccent }

  var body: some View {
    if !store.needs.isEmpty {
      card
    } else if store.needsFailed {
      failedCard
    }
  }

  private var header: some View {
    HStack(spacing: 6) {
      Circle()
        .fill(accent)
        .frame(width: 6, height: 6)
      Text("Waiting on you")
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEColor.textSecondary)
      Spacer(minLength: 0)
    }
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(.isHeader)
  }

  /// The lines could not be read and none are known: say so, with a retry.
  private var failedCard: some View {
    VStack(alignment: .leading, spacing: 4) {
      header
      HStack(spacing: 10) {
        Text("Couldn't load what's waiting on you.")
          .font(.subheadline)
          .foregroundStyle(ADEColor.textSecondary)
        Spacer(minLength: 0)
        Button("Retry") {
          ADEHaptics.light()
          Task { await store.loadNeeds(force: true) }
        }
        .font(.caption.weight(.semibold))
        .buttonStyle(.plain)
        .foregroundStyle(accent)
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .workChatGlass(in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("Cto.WaitingOnYou")
  }

  private var card: some View {
    let rows = expanded ? store.needs : Array(store.needs.prefix(Self.maxRows))
    let more = store.needs.count - rows.count
    return VStack(alignment: .leading, spacing: 0) {
      header
        .padding(.horizontal, 14)
        .padding(.top, 10)
        .padding(.bottom, 2)

      if expanded {
        // Every line: it scrolls past a few rows, so the composer stays on screen.
        ScrollView {
          rowList(rows)
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(maxHeight: 220)
      } else {
        rowList(rows)
      }

      if more > 0 {
        Button {
          ADEHaptics.light()
          withAnimation(.snappy(duration: 0.2)) { expanded = true }
        } label: {
          Text("+\(more) more")
            .font(.caption.weight(.medium))
            .foregroundStyle(ADEColor.textMuted)
            .frame(maxWidth: .infinity, minHeight: 28, alignment: .leading)
            .padding(.horizontal, 14)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("Shows the rest of the chats waiting on you")
      }
    }
    .padding(.bottom, 4)
    .frame(maxWidth: .infinity, alignment: .leading)
    .workChatGlass(in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("Cto.WaitingOnYou")
  }

  private func rowList(_ rows: [CtoNeed]) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      ForEach(Array(rows.enumerated()), id: \.element.id) { index, need in
        if index > 0 {
          Rectangle().fill(ADEColor.glassBorder).frame(height: 0.5).padding(.horizontal, 14)
        }
        row(need)
      }
    }
  }

  private func row(_ need: CtoNeed) -> some View {
    Button {
      ADEHaptics.light()
      store.openNeed(need)
    } label: {
      HStack(spacing: 8) {
        VStack(alignment: .leading, spacing: 1) {
          Text(need.childTitle.isEmpty ? "Untitled chat" : need.childTitle)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(1)
          Text(need.line)
            .font(.subheadline.weight(.medium))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(2)
            .multilineTextAlignment(.leading)
        }
        Spacer(minLength: 0)
        Image(systemName: "chevron.right")
          .font(.system(size: 10, weight: .bold))
          .foregroundStyle(ADEColor.textMuted.opacity(0.7))
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 7)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(need.childTitle.isEmpty ? "Untitled chat" : need.childTitle): \(need.line)")
    .accessibilityHint("Opens that chat")
  }
}
