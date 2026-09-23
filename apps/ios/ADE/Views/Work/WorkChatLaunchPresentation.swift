import Foundation

// Hand mirror of `apps/desktop/src/shared/chatLaunch.ts` — the pure
// presentation helpers every desktop surface uses for a chat launch (thread
// card, sidebar row, launches slide-out). Keep the wording identical: the same
// launch reads the same on every device. Covered by `ChatLaunchTests`, which
// copies the TypeScript cases. Pure model helpers the services also use
// (merge, pending/terminal predicates, stage order, card-id parsing) live in
// `Models/ChatLaunchModels.swift`.

func chatLaunchStageLabel(
  _ id: ChatLaunchStageId,
  kind: ChatLaunchKind,
  templateName: String?
) -> String {
  switch id {
  case .fetch:
    return "Fetch base branch"
  case .checkout:
    return "Check out files"
  case .environment:
    return chatLaunchHasTemplate(templateName) ? "Apply lane template" : "Set up environment"
  case .agent:
    return kind == .cli ? "Start CLI session" : "Start agent"
  default:
    return chatLaunchUnknownStageLabel(id)
  }
}

/// Present-tense label for the stage currently running ("Checking out files").
func chatLaunchStageActiveLabel(
  _ id: ChatLaunchStageId,
  kind: ChatLaunchKind,
  templateName: String?
) -> String {
  switch id {
  case .fetch:
    return "Fetching base branch"
  case .checkout:
    return "Checking out files"
  case .environment:
    return chatLaunchHasTemplate(templateName) ? "Applying lane template" : "Setting up environment"
  case .agent:
    return kind == .cli ? "Starting CLI session" : "Starting agent"
  default:
    return chatLaunchUnknownStageLabel(id)
  }
}

/// JS truthiness: `context.templateName ? … : …` treats "" as absent.
private func chatLaunchHasTemplate(_ templateName: String?) -> Bool {
  guard let templateName else { return false }
  return !templateName.isEmpty
}

/// A stage a newer host invented: show its id, humanized, rather than nothing.
private func chatLaunchUnknownStageLabel(_ id: ChatLaunchStageId) -> String {
  let words = id.rawValue
    .replacingOccurrences(of: "_", with: " ")
    .replacingOccurrences(of: "-", with: " ")
    .trimmingCharacters(in: .whitespacesAndNewlines)
  guard let first = words.first else { return "Setup" }
  return first.uppercased() + words.dropFirst()
}

func chatLaunchActiveStage(_ stages: [ChatLaunchStage]) -> ChatLaunchStage? {
  stages.first { $0.status == .running }
    ?? stages.first { $0.status == .failed }
    ?? stages.first { $0.status == .pending }
}

/// The launch in one short line, for the Work row and the Hub row:
/// "Checking out files · 62%", "Applying lane template · Install dependencies",
/// "Check out files failed", "Agent started".
func chatLaunchStatusLine(_ launch: ChatLaunchSnapshot) -> String {
  let kind = launch.kind
  let templateName = launch.templateName
  if launch.phase == .cancelled { return "Cancelled" }
  if launch.phase == .failed {
    let failed = launch.stages.first { $0.status == .failed }
    let label = failed.map { chatLaunchStageLabel($0.id, kind: kind, templateName: templateName) } ?? "Setup"
    return "\(label) failed"
  }
  if launch.phase == .completed {
    return kind == .cli ? "CLI session started" : "Agent started"
  }
  guard let active = chatLaunchActiveStage(launch.stages) else { return "Setting up lane" }
  let label = chatLaunchStageActiveLabel(active.id, kind: kind, templateName: templateName)
  if active.id == .checkout, let percent = active.percent {
    return "\(label) · \(chatLaunchFormatNumber(percent))%"
  }
  if active.id == .environment,
     let step = active.steps?.first(where: { $0.status == "running" }) {
    return "\(label) · \(step.label)"
  }
  return label
}

func chatLaunchStageDurationMs(
  startedAt: String?,
  endedAt: String?,
  nowMs: Double = Date().timeIntervalSince1970 * 1000
) -> Double? {
  guard let startedAt, let start = chatLaunchParseTimestampMs(startedAt) else { return nil }
  let end: Double
  if let endedAt, !endedAt.isEmpty {
    guard let parsed = chatLaunchParseTimestampMs(endedAt) else { return nil }
    end = parsed
  } else {
    end = nowMs
  }
  return max(0, end - start)
}

func chatLaunchStageDurationMs(
  _ stage: ChatLaunchStage,
  nowMs: Double = Date().timeIntervalSince1970 * 1000
) -> Double? {
  chatLaunchStageDurationMs(startedAt: stage.startedAt, endedAt: stage.endedAt, nowMs: nowMs)
}

func formatChatLaunchDuration(_ ms: Double?) -> String {
  guard let ms else { return "" }
  if ms < 1000 { return "\(Int(chatLaunchJSRound(ms)))ms" }
  let seconds = ms / 1000
  if seconds < 60 {
    return seconds < 10
      ? "\(String(format: "%.1f", seconds))s"
      : "\(Int(chatLaunchJSRound(seconds)))s"
  }
  let minutes = Int((seconds / 60).rounded(.down))
  let rest = Int(chatLaunchJSRound(seconds.truncatingRemainder(dividingBy: 60)))
  return "\(minutes)m \(rest)s"
}

/// `Math.round`: halves round toward +∞.
private func chatLaunchJSRound(_ value: Double) -> Double {
  (value + 0.5).rounded(.down)
}

/// JS number → string for the values a launch carries (62 → "62", 62.5 → "62.5").
func chatLaunchFormatNumber(_ value: Double) -> String {
  if value.isFinite, value == value.rounded(), abs(value) < 1e15 {
    return String(Int(value))
  }
  return String(value)
}

private let chatLaunchFractionalTimestampParser: ISO8601DateFormatter = {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return formatter
}()

private let chatLaunchPlainTimestampParser: ISO8601DateFormatter = {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime]
  return formatter
}()

func chatLaunchParseTimestampMs(_ value: String) -> Double? {
  let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmed.isEmpty else { return nil }
  let date = chatLaunchFractionalTimestampParser.date(from: trimmed)
    ?? chatLaunchPlainTimestampParser.date(from: trimmed)
  return date.map { $0.timeIntervalSince1970 * 1000 }
}

// MARK: - iOS-only presentation

/// Header line of the setup card: desktop `laneSetupTitle`, word for word
/// ("Setting up lane…", "Lane setup failed", "Lane set up in 4.2s",
/// "Starting CLI session…"), so the same launch reads the same everywhere.
func chatLaunchCardTitle(
  _ launch: ChatLaunchSnapshot,
  nowMs: Double = Date().timeIntervalSince1970 * 1000
) -> String {
  switch launch.phase {
  case .failed: return "Lane setup failed"
  case .cancelled: return "Lane setup cancelled"
  case .completed:
    let duration = formatChatLaunchDuration(
      chatLaunchStageDurationMs(startedAt: launch.startedAt, endedAt: launch.endedAt, nowMs: nowMs)
    )
    return duration.isEmpty ? "Lane set up" : "Lane set up in \(duration)"
  case .awaitingClient:
    return "Starting CLI session…"
  case .running:
    return "Setting up lane…"
  }
}

/// Title of a `lane_setup` card read from its payload alone: the host's title,
/// else the desktop fallback from the card's own duration.
func chatLaunchCardPayloadTitle(title: String, failed: Bool, durationMs: Int?) -> String {
  let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
  if !trimmed.isEmpty { return trimmed }
  if failed { return "Lane setup failed" }
  let duration = formatChatLaunchDuration(durationMs.map(Double.init))
  return duration.isEmpty ? "Lane set up" : "Lane set up in \(duration)"
}

/// Every stage but the agent has finished and the lane exists (or the agent is up).
func chatLaunchLaneIsReady(_ launch: ChatLaunchSnapshot) -> Bool {
  switch launch.phase {
  case .completed: return true
  case .failed, .cancelled: return false
  case .running, .awaitingClient:
    if launch.agentStarted { return true }
    let finished = launch.stages.allSatisfy {
      $0.id == .agent || $0.status == .done || $0.status == .skipped || $0.status == .warning
    }
    return finished && launch.laneCreated
  }
}

/// The base branch chip: the base the lane was cut from, else its own branch.
func chatLaunchBaseLabel(_ launch: ChatLaunchSnapshot) -> String? {
  let base = launch.baseRef?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  if !base.isEmpty { return base }
  var branch = launch.branchRef?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  if branch.hasPrefix("refs/heads/") { branch.removeFirst("refs/heads/".count) }
  return branch.isEmpty ? nil : branch
}

/// A live duration at the ≤1 Hz tick the phone renders it with: whole seconds
/// under a minute (a 1 Hz "2.0s → 3.0s" would read as broken precision), the
/// desktop format beyond that.
func formatChatLaunchLiveDuration(_ ms: Double?) -> String {
  guard let ms else { return "" }
  if ms < 60_000 { return "\(Int((ms / 1000).rounded(.down)))s" }
  return formatChatLaunchDuration(ms)
}

// MARK: - Progress rail

/// One segment of the segmented launch progress rail (desktop
/// `LaunchProgressRail`). Carries only what the rail draws, so list rows can
/// hold it in their render signature without the full stage payload.
struct ChatLaunchRailSegment: Codable, Hashable {
  let id: String
  let status: ChatLaunchStageStatus
  /// 0…1 — the fill's horizontal scale from the leading edge.
  let fill: Double
}

/// Mirror of desktop `fillScale`: finished stages are full, the running
/// checkout fills to its real percent (at least a sliver), everything else is empty.
func chatLaunchRailFill(status: ChatLaunchStageStatus, percent: Double?) -> Double {
  switch status {
  case .done, .warning, .failed, .skipped:
    return 1
  case .running:
    guard let percent, percent.isFinite else { return 0 }
    return max(0.04, min(1, percent / 100))
  case .pending:
    return 0
  }
}

func chatLaunchRailSegments(_ stages: [ChatLaunchStage]) -> [ChatLaunchRailSegment] {
  stages.map { stage in
    ChatLaunchRailSegment(
      id: stage.id.rawValue,
      status: stage.status,
      fill: chatLaunchRailFill(status: stage.status, percent: stage.id == .checkout ? stage.percent : nil)
    )
  }
}

// MARK: - Stage symbols

/// SF Symbol per stage (desktop `launchStageIcon`, Phosphor → SF Symbols).
func chatLaunchStageSymbol(_ id: ChatLaunchStageId, kind: ChatLaunchKind, templateName: String?) -> String {
  switch id {
  case .fetch: return "icloud.and.arrow.down"
  case .checkout: return "doc.on.doc"
  case .environment: return chatLaunchHasTemplate(templateName) ? "square.stack.3d.up" : "wrench.and.screwdriver"
  case .agent: return kind == .cli ? "terminal" : "sparkles"
  default: return "circle.dashed"
  }
}

/// SF Symbol per lane-environment step kind (desktop `ENV_STEP_ICON`).
func chatLaunchEnvStepSymbol(_ kind: String) -> String {
  switch kind {
  case "env-files": return "key"
  case "docker": return "shippingbox"
  case "dependencies": return "cube.box"
  case "mount-points": return "externaldrive"
  case "copy-paths": return "doc.on.doc"
  case "setup-script": return "scroll"
  default: return "wrench.and.screwdriver"
  }
}

/// The `lane_setup` card metric that carries the template name
/// (desktop `LANE_SETUP_CARD_TEMPLATE_METRIC`).
let chatLaunchCardTemplateMetric = "Template"

/// Stage id for a transcript-card row (desktop `stageIdForCardRow`): the row's
/// `key` when it names a known stage. Rows are matched by key only — the label
/// is display copy, and `lane_setup` cards have always carried keys.
func chatLaunchStageIdForCardRow(key: String?) -> ChatLaunchStageId? {
  let trimmedKey = key?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  guard !trimmedKey.isEmpty else { return nil }
  let id = ChatLaunchStageId(rawValue: trimmedKey)
  return chatLaunchStageOrder.contains(id) ? id : nil
}

/// Trailing detail for a stage row: the host's detail, plus the checkout
/// percentage while files are still landing.
func chatLaunchStageTrailingDetail(_ stage: ChatLaunchStage) -> String? {
  let detail = stage.detail?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  if stage.id == .checkout, stage.status == .running, let percent = stage.percent {
    let percentText = "\(chatLaunchFormatNumber(percent))%"
    return detail.isEmpty ? percentText : "\(detail) · \(percentText)"
  }
  return detail.isEmpty ? nil : detail
}

/// Label for a queued message the host failed to deliver and is retrying.
let chatLaunchDeliveryFailureTitle = "Couldn't send — retrying"

/// "Start anyway" only makes sense once the lane exists and the thing that
/// failed was the environment (template, env files, setup script…).
func chatLaunchCanStartAnyway(_ launch: ChatLaunchSnapshot) -> Bool {
  guard launch.phase == .failed, launch.laneCreated, !launch.agentStarted else { return false }
  return launch.stages.first { $0.status == .failed }?.id == .environment
}

/// "Start now": skip the rest of the template while the environment runs.
func chatLaunchCanStartNow(_ launch: ChatLaunchSnapshot) -> Bool {
  guard launch.phase == .running, launch.laneCreated, !launch.agentStarted else { return false }
  return launch.stages.contains { $0.id == .environment && $0.status == .running }
}
