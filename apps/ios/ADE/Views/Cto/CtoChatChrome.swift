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
  /// Fixture only: answers a "Learned" card's Undo without a host. Nil sends
  /// `cto.undoLearned` to the CTO's home machine.
  var fixtureUndoLearned: ((_ learnId: String, _ changeId: String) async -> CtoUndoLearnedResult)? = nil

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
  guard let text = text?.trimmingCharacters(in: .whitespacesAndNewlines), text.hasPrefix("{") || text.hasPrefix("["),
        let data = text.data(using: .utf8),
        let parsed = try? JSONSerialization.jsonObject(with: data)
  else { return nil }
  // MCP content blocks, bare (`[{ type: "text", text }]`) or wrapped in
  // `{ content: [...] }`: the JSON result is the first text block.
  func textBlockObject(_ blocks: [[String: Any]]) -> [String: Any]? {
    guard let first = blocks.first(where: { ($0["type"] as? String) == "text" }),
          let inner = first["text"] as? String
    else { return nil }
    return ctoJSONObject(inner)
  }
  if let blocks = parsed as? [[String: Any]] { return textBlockObject(blocks) }
  guard let object = parsed as? [String: Any] else { return nil }
  if let content = object["content"] as? [[String: Any]], let unwrapped = textBlockObject(content) {
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
  case scheduled, cancelled, paused, resumed, tracking, done
  /// A chat `spawnChat` started on another machine or ADE Cloud: no subagent
  /// card lands here for it, so the call draws the row itself.
  case started

  var verb: String {
    switch self {
    case .scheduled: return "Scheduled"
    case .cancelled: return "Cancelled"
    case .paused: return "Paused"
    case .resumed: return "Resumed"
    case .tracking: return "Tracking"
    case .done: return "Done"
    case .started: return "Started a new task"
    }
  }

  var failedVerb: String {
    switch self {
    case .scheduled: return "Couldn't schedule"
    case .cancelled: return "Couldn't cancel"
    case .paused: return "Couldn't pause"
    case .resumed: return "Couldn't resume"
    case .tracking: return "Couldn't track"
    case .done: return "Couldn't finish"
    case .started: return "Couldn't start"
    }
  }

  var symbol: String {
    switch self {
    case .scheduled: return "alarm"
    case .cancelled: return "calendar.badge.minus"
    case .paused: return "pause.circle"
    case .resumed: return "play.circle"
    case .tracking: return "circle"
    case .done: return "checkmark.circle.fill"
    case .started: return "play.circle"
    }
  }
}

struct CtoToolChip: Identifiable, Hashable {
  let id: String
  let kind: CtoChipKind
  let verb: String
  let text: String?
  let failed: Bool
  /// `started` on another machine or ADE Cloud only: where the chat runs, so
  /// its row can open it there. Nil for every other chip.
  var remote: CtoRemoteSpawn? = nil
}

/// A chat `spawnChat` started on another machine or ADE Cloud, read off the
/// call's result. Desktop `CtoToolChip.remote`.
struct CtoRemoteSpawn: Hashable {
  let machineName: String
  let sessionId: String?
  /// The lane id on that machine (not namespaced).
  let laneId: String?
  let provider: String?
}

/// State-changing CTO tools that draw a chip instead of hiding in the tools
/// list. Notes, rules and skills draw none: the turn's "Learned" card lists
/// each of those changes with its Undo (desktop `CHIP_TOOL_NAMES`).
private let ctoChipToolNames: Set<String> = [
  "scheduleWork", "cancelScheduledWork", "setScheduledWorkPaused", "trackWork", "finishWork",
]

/// The chip for one finished state-changing CTO call, or nil while it runs
/// (the working line names it then) and for every other tool.
func ctoChip(for card: WorkToolCardModel) -> CtoToolChip? {
  let name = ctoToolBaseName(card.toolName)
  if name == "spawnChat" {
    if let spawn = ctoRemoteSpawn(card) {
      return CtoToolChip(id: card.id, kind: .started, verb: CtoChipKind.started.verb, text: spawn.title.map { ctoClipWords($0) }, failed: false, remote: spawn.remote)
    }
    // A local spawn that started draws its row from its subagent card. One
    // that failed, on any machine, says so in the thread.
    guard card.status != .running, ctoToolCardFailed(card) else { return nil }
    let title = ctoSpawnTitle(args: ctoJSONObject(card.argsText) ?? [:], result: ctoJSONObject(card.resultText))
    return CtoToolChip(id: card.id, kind: .started, verb: CtoChipKind.started.failedVerb, text: title.map { ctoClipWords($0) }, failed: true)
  }
  guard ctoChipToolNames.contains(name), card.status != .running else { return nil }
  let args = ctoJSONObject(card.argsText) ?? [:]
  let result = ctoJSONObject(card.resultText)
  let payload = (result?["result"] as? [String: Any]) ?? (result?["item"] as? [String: Any]) ?? result
  if result?["declined"] as? Bool == true || result?["cancelled"] as? Bool == true { return nil }
  let failed = ctoToolCardFailed(card)

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

/// A finished call that did not do what it was asked: it failed, or its result
/// says `success: false` or carries an error.
private func ctoToolCardFailed(_ card: WorkToolCardModel) -> Bool {
  if card.status == .failed { return true }
  let result = ctoJSONObject(card.resultText)
  return result?["success"] as? Bool == false || ctoStr(result?["error"]) != nil
}

/// A successful `spawnChat` that ran on another machine or ADE Cloud, read off
/// its result; nil for a local spawn (its subagent card draws the row), a
/// failure, or anything else. Desktop `ctoRemoteSpawnForEntry`.
func ctoRemoteSpawn(_ card: WorkToolCardModel) -> (title: String?, remote: CtoRemoteSpawn)? {
  guard ctoToolBaseName(card.toolName) == "spawnChat", card.status == .completed,
        let result = ctoJSONObject(card.resultText), result["success"] as? Bool != false
  else { return nil }
  let cloud = result["adeCloud"] as? Bool == true
  // Every ADE Cloud lane has its own computer, but the person sees one machine: ADE Cloud.
  guard let machineName = cloud ? "ADE Cloud" : ctoStr(result["machineName"]) else { return nil }
  let args = ctoJSONObject(card.argsText) ?? [:]
  // An ADE Cloud launch result names no provider; the model the CTO asked for does.
  let provider = ctoStr(result["provider"]) ?? ctoProviderId(modelId: result["modelId"]) ?? ctoProviderId(modelId: args["modelId"])
  return (
    ctoSpawnTitle(args: args, result: result),
    CtoRemoteSpawn(machineName: machineName, sessionId: ctoStr(result["sessionId"]), laneId: ctoStr(result["laneId"]), provider: provider)
  )
}

private func ctoSpawnTitle(args: [String: Any], result: [String: Any]?) -> String? {
  ctoStr(result?["requestedTitle"]) ?? ctoStr(args["title"]) ?? ctoStr(result?["laneName"]) ?? ctoStr(args["initialPrompt"])
}

/// The provider id a model id runs on (`anthropic/…` is `claude`), or nil.
private func ctoProviderId(modelId: Any?) -> String? {
  guard let id = ctoStr(modelId), let slash = id.firstIndex(of: "/"), slash != id.startIndex else { return nil }
  let prefix = String(id[..<slash])
  return ["anthropic": "claude", "openai": "codex"][prefix] ?? prefix
}

/// The providers' own subagent tools (Claude `Agent`/`Task`, Codex
/// `spawn_agent`, OpenCode and Cursor `task`, Cursor `subagent`). Never an MCP
/// call: an MCP server's own `task` tool is not a spawn.
private let ctoNativeSpawnToolNames: Set<String> = ["Agent", "Task", "task", "subagent", "spawn_agent"]

/// Spawn calls a spawn row already stands for, so they leave the CTO turn's
/// tool list: a local `spawnChat` that started a chat, or a native subagent
/// tool. A remote spawn draws its own row and a failed one stays. Desktop
/// `isCtoSpawnToolEntry`.
func ctoIsSpawnToolMember(_ member: WorkToolGroupMember) -> Bool {
  guard case .tool(let card) = member, card.status == .completed else { return false }
  let name = ctoToolBaseName(card.toolName)
  if name == "spawnChat" {
    guard ctoRemoteSpawn(card) == nil, let result = ctoJSONObject(card.resultText) else { return false }
    return result["success"] as? Bool != false && ctoStr(result["sessionId"]) != nil
  }
  let raw = card.toolName.trimmingCharacters(in: .whitespacesAndNewlines)
  return !raw.hasPrefix("mcp__") && !raw.hasPrefix("mcp.") && ctoNativeSpawnToolNames.contains(name)
}

/// The CTO fold row counts the tools its list shows, spawn calls left out.
func ctoFoldModel(_ model: WorkTurnFoldModel, activity: WorkToolGroupModel?) -> WorkTurnFoldModel {
  guard let activity else { return model }
  let dropped = activity.count - (ctoTurnActivity(activity)?.count ?? 0)
  guard dropped > 0 else { return model }
  var next = model
  next.toolCount = max(0, model.toolCount - dropped)
  return next
}

/// The CTO turn's tool list without the spawn calls its rows stand for.
func ctoTurnActivity(_ group: WorkToolGroupModel?) -> WorkToolGroupModel? {
  guard let group else { return nil }
  let members = group.members.filter { !ctoIsSpawnToolMember($0) }
  if members.count == group.members.count { return group }
  guard !members.isEmpty else { return nil }
  return WorkToolGroupModel(id: group.id, members: members, turnId: group.turnId)
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
  case "addRule": return "Saving a rule"
  case "removeRule": return "Dropping a rule"
  case "saveSkill": return "Saving a skill"
  case "readSkill": return "Reading a skill"
  case "deleteSkill": return "Deleting a skill"
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
  case "showMedia": return "Adding a picture"
  case "getChatProof": return "Getting a chat's proof"
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
/// "Tracking · Ship the release notes". One line each.
struct CtoToolChipsRow: View {
  let chips: [CtoToolChip]
  let accent: Color
  /// Opens a chat the CTO started on another machine (`WorkSessionDestinationView.openRemoteSpawnedChat`).
  var onOpenRemote: (@MainActor (CtoRemoteSpawn) -> Void)? = nil

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      ForEach(chips) { chip in
        if let remote = chip.remote {
          CtoRemoteTaskRow(chip: chip, remote: remote, onOpen: onOpenRemote)
        } else {
          CtoToolChipView(chip: chip, accent: accent)
        }
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

// MARK: - Learned

/// What one CTO turn changed in its rules, skills and notes, with an Undo per
/// change (desktop `CtoLearnedRow`). Undo goes to the CTO's home machine; the
/// host sends the row again with the change marked undone, so the card keeps
/// no undone state of its own beyond the call in flight.
struct CtoLearnedCard: View {
  let model: WorkCtoLearnedModel
  let accent: Color
  var live: CtoLiveModel? = nil

  @State private var pending: String? = nil
  @State private var note: String? = nil

  private var canUndo: Bool {
    live?.fixtureUndoLearned != nil || SyncService.shared?.ctoHomeSupportsAction("cto.undoLearned") == true
  }

  var body: some View {
    let canUndo = canUndo
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 6) {
        Image(systemName: "lightbulb")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(accent)
        Text("Learned")
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textSecondary)
      }
      .accessibilityElement(children: .combine)
      .accessibilityAddTraits(.isHeader)
      VStack(alignment: .leading, spacing: 4) {
        ForEach(model.changes) { change in
          row(change, canUndo: canUndo)
        }
      }
      if let note {
        Text(note)
          .font(.caption)
          .foregroundStyle(ADEColor.textMuted)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityAddTraits(.updatesFrequently)
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(accent.opacity(0.05), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(ADEColor.glassBorder, lineWidth: 0.5))
    .accessibilityIdentifier("Cto.Learned")
  }

  private func opWord(_ op: CtoLearnedOp) -> String? {
    switch op {
    case .added: return nil
    case .changed: return "Sharpened"
    case .removed: return "Removed"
    }
  }

  private func line(_ change: CtoLearnedChange) -> Text {
    let main = Text(change.text)
      .foregroundStyle(ADEColor.textPrimary.opacity(0.85))
      .strikethrough(change.op == .removed, color: ADEColor.textMuted)
    let lead = opWord(change.op).map { Text("\($0) · ").foregroundStyle(ADEColor.textMuted) } ?? Text("")
    let tail = change.detail.map { Text(" · \($0)").foregroundStyle(ADEColor.textMuted) } ?? Text("")
    return Text("\(lead)\(main)\(tail)")
  }

  private func row(_ change: CtoLearnedChange, canUndo: Bool) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      Text(change.area.label)
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEColor.textSecondary)
        .frame(width: 64, alignment: .leading)
      line(change)
        .font(.footnote)
        .frame(maxWidth: .infinity, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .opacity(change.undone ? 0.5 : 1)
      if change.undone {
        Text("Undone")
          .font(.caption)
          .foregroundStyle(ADEColor.textMuted)
      } else if canUndo {
        Button {
          Task { await undo(change) }
        } label: {
          Text(pending == change.id ? "Undoing…" : "Undo")
            .font(.caption.weight(.medium))
            .foregroundStyle(ADEColor.textSecondary)
            .padding(.horizontal, 9)
            .frame(minHeight: 24)
            .overlay(Capsule().strokeBorder(ADEColor.glassBorder, lineWidth: 0.75))
            .contentShape(Capsule())
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.vertical, -10)
        .disabled(pending != nil)
        .accessibilityLabel("Undo: \(change.text)")
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityHint(change.previous.map { "Was: \($0)" } ?? "")
  }

  private func undo(_ change: CtoLearnedChange) async {
    pending = change.id
    note = nil
    defer { pending = nil }
    do {
      let result: CtoUndoLearnedResult
      if let fixture = live?.fixtureUndoLearned {
        result = await fixture(model.learnId, change.id)
      } else if let sync = SyncService.shared {
        result = try await sync.undoCtoLearned(learnId: model.learnId, changeId: change.id)
      } else {
        note = "Couldn't undo that."
        return
      }
      if !result.undone || result.note != nil {
        note = result.note ?? "Couldn't undo that."
      } else {
        ADEHaptics.light()
      }
    } catch {
      note = ctoShortError(error, fallback: "Couldn't undo that.")
      ADEHaptics.error()
    }
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

// MARK: - Spawn rows

/// A child chat the CTO started for real work. A read-only helper chat, a
/// provider's native subagent or a workflow agent is a background task.
/// Same rule as desktop (`isCtoStartedTask` in `ctoSpawnRules.ts`).
func ctoIsStartedTask(_ snapshot: WorkSubagentSnapshot) -> Bool {
  workChatInfoChildSessionId(snapshot) != nil && !snapshot.readOnly
}

/// The task row's verb. A child whose first start is in an older page came
/// from a later turn's result or restart, so the row says what that turn did,
/// not "Started a new task" a second time. iOS turns the child's "finished
/// its turn" notice into this result, so the row is that turn's only trace;
/// desktop draws the notice line and drops the row (`ctoTranscriptRows`).
func ctoTaskVerb(_ snapshot: WorkSubagentSnapshot) -> String {
  guard snapshot.startNotLoaded else { return "Started a new task" }
  switch snapshot.status {
  case .running: return "Working on"
  case .succeeded: return "Finished"
  case .failed: return "Failed"
  case .stopped: return "Stopped"
  }
}

/// The CTO thread's spawn rows, in place of subagent cards: one quiet
/// "Started a new task" row per child chat, and one "N background tasks" row
/// for its helpers, which opens to list them. Same as desktop `CtoSpawnRows`.
struct CtoSpawnRowsView: View {
  let rows: [WorkSubagentTimelineRow]
  /// The CTO's own provider: a native helper runs on it.
  let sessionProvider: String?
  /// Opens a child chat on its machine (`handleSubagentSelection`).
  var onOpen: (@MainActor (WorkSubagentSnapshot) async -> Void)? = nil
  /// Stops a running native helper by its provider task; nil when the chat cannot.
  var onStop: (@MainActor (WorkSubagentSnapshot) async -> Void)? = nil
  /// Opens Chat Info on a native helper's detail, its result.
  var onOpenDetail: (@MainActor (WorkSubagentSnapshot) async -> Void)? = nil
  /// A child chat's current title, when a list knows it (desktop reads the machine's chats).
  var childTitle: (@MainActor (String) -> String?)? = nil

  @State private var helpersOpen = false

  private var tasks: [WorkSubagentTimelineRow] { rows.filter { ctoIsStartedTask($0.snapshot) } }

  private func taskTitle(_ snapshot: WorkSubagentSnapshot) -> String {
    workChatInfoChildSessionId(snapshot).flatMap { childTitle?($0) } ?? workSubagentMeaningfulName(snapshot)
  }
  private var helpers: [WorkSubagentTimelineRow] { rows.filter { !ctoIsStartedTask($0.snapshot) } }

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      ForEach(tasks, id: \.id) { row in
        Button {
          Task { await onOpen?(row.snapshot) }
        } label: {
          HStack(spacing: 7) {
            Text(ctoTaskVerb(row.snapshot))
              .foregroundStyle(ADEColor.textSecondary)
              .fixedSize()
            CtoSpawnAvatar(provider: row.snapshot.provider)
            Text(taskTitle(row.snapshot))
              .fontWeight(.medium)
              .foregroundStyle(ADEColor.textPrimary.opacity(0.86))
              .lineLimit(1)
              .truncationMode(.tail)
            Image(systemName: "chevron.right")
              .font(.system(size: 9, weight: .semibold))
              .foregroundStyle(ADEColor.textSecondary.opacity(0.7))
          }
          .font(.footnote)
          .frame(minHeight: 30)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(ctoTaskVerb(row.snapshot)): \(taskTitle(row.snapshot))")
        .accessibilityHint("Opens the chat")
        .accessibilityIdentifier("Cto.StartedTask")
      }
      if !helpers.isEmpty {
        helpersRow
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  /// The collapsed row: running wins, then failed, then stopped, then done.
  private var helpersSummary: (noun: String, summary: String, icon: String, tint: Color) {
    let noun = helpers.count == 1 ? "1 background task" : "\(helpers.count) background tasks"
    func count(_ status: WorkSubagentSnapshot.Status) -> Int { helpers.filter { $0.snapshot.status == status }.count }
    if count(.running) > 0 { return (noun, "\(count(.running)) running", "circle.dotted", ADEColor.accent) }
    if count(.failed) > 0 { return (noun, "\(count(.failed)) failed", "exclamationmark.circle", ADEColor.warning) }
    if count(.stopped) > 0 { return (noun, "\(count(.stopped)) stopped", "stop.circle", ADEColor.textSecondary) }
    return (noun, "done", "checkmark.circle", ADEColor.success)
  }

  private var helpersRow: some View {
    let facts = helpersSummary
    return VStack(alignment: .leading, spacing: 2) {
      Button {
        withAnimation(.snappy(duration: 0.2)) { helpersOpen.toggle() }
      } label: {
        HStack(spacing: 7) {
          Image(systemName: facts.icon)
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(facts.tint)
          Text(facts.noun)
            .fontWeight(.medium)
            .foregroundStyle(ADEColor.textPrimary.opacity(0.86))
          Text("· \(facts.summary)")
            .foregroundStyle(ADEColor.textSecondary)
          Image(systemName: helpersOpen ? "chevron.down" : "chevron.right")
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(ADEColor.textSecondary.opacity(0.7))
        }
        .font(.footnote)
        .frame(minHeight: 30)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("\(facts.noun), \(facts.summary)")
      .accessibilityValue(helpersOpen ? "Open" : "Closed")
      .accessibilityIdentifier("Cto.BackgroundTasks")
      if helpersOpen {
        VStack(alignment: .leading, spacing: 0) {
          ForEach(helpers, id: \.id) { row in
            CtoHelperLine(snapshot: row.snapshot, sessionProvider: sessionProvider, onOpen: onOpen, onOpenDetail: onOpenDetail, onStop: onStop)
          }
        }
        .padding(.leading, 10)
        .overlay(alignment: .leading) {
          Rectangle().fill(ADEColor.textPrimary.opacity(0.09)).frame(width: 1)
        }
        .padding(.leading, 6)
      }
    }
  }
}

/// One helper in the opened background-tasks row. A helper chat opens; a
/// native subagent has no chat of its own, so it opens its detail in Chat Info.
private struct CtoHelperLine: View {
  let snapshot: WorkSubagentSnapshot
  let sessionProvider: String?
  var onOpen: (@MainActor (WorkSubagentSnapshot) async -> Void)?
  var onOpenDetail: (@MainActor (WorkSubagentSnapshot) async -> Void)?
  var onStop: (@MainActor (WorkSubagentSnapshot) async -> Void)?

  private var isChat: Bool { workChatInfoChildSessionId(snapshot) != nil }

  private var statusWord: String {
    switch snapshot.status {
    case .running: return "running"
    case .succeeded: return "done"
    case .failed: return "failed"
    case .stopped: return "stopped"
    }
  }

  private var name: String { workSubagentMeaningfulName(snapshot) }

  private var line: some View {
    HStack(spacing: 7) {
      CtoSpawnAvatar(provider: snapshot.provider ?? (isChat ? nil : sessionProvider), size: 16)
      Text(name)
        .foregroundStyle(ADEColor.textPrimary.opacity(0.78))
        .lineLimit(1)
        .truncationMode(.tail)
      Text(statusWord)
        .foregroundStyle(snapshot.status == .failed ? ADEColor.warning : ADEColor.textSecondary)
        .fixedSize()
    }
    .font(.caption)
    .frame(minHeight: 28)
  }

  var body: some View {
    HStack(spacing: 2) {
      if isChat {
        Button { Task { await onOpen?(snapshot) } } label: { line.contentShape(Rectangle()) }
          .buttonStyle(.plain)
          .accessibilityLabel("\(name), \(statusWord)")
          .accessibilityHint("Opens the chat")
      } else if let onOpenDetail {
        Button { Task { await onOpenDetail(snapshot) } } label: { line.contentShape(Rectangle()) }
          .buttonStyle(.plain)
          .accessibilityLabel("\(name), \(statusWord)")
          .accessibilityHint("Shows its result")
      } else {
        line
          .accessibilityElement(children: .combine)
      }
      // The same rule as the subagent card's Stop: a native helper's provider task, while it runs.
      if let onStop, workSubagentCanStopTask(snapshot) {
        Button { Task { await onStop(snapshot) } } label: {
          Image(systemName: "stop.fill")
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(ADEColor.warning)
            .frame(width: 28, height: 28)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(workSubagentStopLabel(snapshot))
      }
    }
  }
}

/// A chat started on another machine, drawn like a local spawn's row. A tap
/// opens it on that machine, through the Work list that knows its chats.
private struct CtoRemoteTaskRow: View {
  let chip: CtoToolChip
  let remote: CtoRemoteSpawn
  var onOpen: (@MainActor (CtoRemoteSpawn) -> Void)?

  private var canOpen: Bool { onOpen != nil && remote.sessionId != nil }

  private var line: some View {
    HStack(spacing: 7) {
      Text("Started a new task")
        .foregroundStyle(ADEColor.textSecondary)
        .fixedSize()
      CtoSpawnAvatar(provider: remote.provider)
      Text(chip.text ?? "a chat")
        .fontWeight(.medium)
        .foregroundStyle(ADEColor.textPrimary.opacity(0.86))
        .lineLimit(1)
        .truncationMode(.tail)
      Text("on \(remote.machineName)")
        .foregroundStyle(ADEColor.textSecondary)
        .lineLimit(1)
      if canOpen {
        Image(systemName: "chevron.right")
          .font(.system(size: 9, weight: .semibold))
          .foregroundStyle(ADEColor.textSecondary.opacity(0.7))
      }
    }
    .font(.footnote)
    .frame(minHeight: 30)
    .contentShape(Rectangle())
  }

  var body: some View {
    if canOpen, let onOpen {
      Button { onOpen(remote) } label: { line }
        .buttonStyle(.plain)
        .accessibilityLabel("Started a new task: \(chip.text ?? "a chat") on \(remote.machineName)")
        .accessibilityHint("Opens the chat")
        .accessibilityIdentifier("Cto.StartedTask")
    } else {
      line
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("Cto.StartedTask")
    }
  }
}

private struct CtoSpawnAvatar: View {
  let provider: String?
  var size: CGFloat = 18

  var body: some View {
    WorkProviderBareLogo(provider: provider, fallbackSymbol: "sparkle", tint: ADEColor.textSecondary, size: size - 6)
      .frame(width: size, height: size)
      .background(ADEColor.textPrimary.opacity(0.08), in: Circle())
      .overlay(Circle().strokeBorder(ADEColor.textPrimary.opacity(0.1), lineWidth: 0.5))
  }
}
