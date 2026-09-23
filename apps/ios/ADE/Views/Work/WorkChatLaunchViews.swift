import SwiftUI

// The shared building blocks of a chat launch's (an instant new-lane chat's)
// iOS surfaces, in the same visual language as the desktop `LaneSetupCard` /
// `LaunchProgressRail`: the status palette, stage glyphs and tiles, the
// segmented progress rail, live durations, and the stage row. The surfaces
// built from them live beside this file:
//
// - `WorkChatLaunchSetupCard.swift` — the live setup card (header, rail, one
//   row per stage with the environment's steps nested, details, actions).
// - `WorkChatLaunchPendingScreen.swift` — the chat before its agent starts,
//   and the gate that hands the route over to the ordinary chat.
// - `WorkLaneSetupTranscriptCard.swift` — the `lane_setup` `ade_card` the host
//   leaves at the top of the thread.
// - `WorkChatLaunchListProjection.swift` — the Work/Hub row projection (no views).
//
// Colour carries status everywhere: running is ADE purple, done is success
// green, warning and failure are amber (`ADEColor.warning`) — never red.
//
// Render cost: time passing re-renders only the duration texts (a `TimelineView`
// at 1 Hz, and only while something runs). The rail's fill animates by scale
// and the running segment's sheen by offset — transform animations SwiftUI
// interpolates without re-running any body — and Reduce Motion stops the sheen.
//
// Wording comes from `WorkChatLaunchPresentation.swift`, the hand mirror of
// `apps/desktop/src/shared/chatLaunch.ts`.

// MARK: - Palette

/// Status → colour, one place. Running uses the fixed ADE purple rather than
/// `ADEColor.accent`, which is green in light mode and would read as "done".
enum WorkChatLaunchTone {
  static let running = ADEColor.purpleAccent

  static func tint(_ status: ChatLaunchStageStatus) -> Color {
    switch status {
    case .running: return running
    case .done: return ADEColor.success
    case .warning, .failed: return ADEColor.warning
    case .skipped, .pending: return ADEColor.textMuted
    }
  }

  static func tileFill(_ status: ChatLaunchStageStatus) -> Color {
    switch status {
    case .running: return running.opacity(0.14)
    case .done: return ADEColor.success.opacity(0.10)
    case .warning: return ADEColor.warning.opacity(0.10)
    case .failed: return ADEColor.warning.opacity(0.13)
    case .skipped, .pending: return ADEColor.textMuted.opacity(0.06)
    }
  }

  static func tileStroke(_ status: ChatLaunchStageStatus) -> Color {
    switch status {
    case .running: return running.opacity(0.30)
    case .done: return ADEColor.success.opacity(0.20)
    case .warning: return ADEColor.warning.opacity(0.24)
    case .failed: return ADEColor.warning.opacity(0.32)
    case .skipped, .pending: return ADEColor.glassBorder
    }
  }

  static func tileIcon(_ status: ChatLaunchStageStatus) -> Color {
    switch status {
    case .skipped, .pending: return ADEColor.textMuted.opacity(0.7)
    default: return tint(status)
    }
  }

  static func railTrack(_ status: ChatLaunchStageStatus) -> Color {
    switch status {
    case .running: return running.opacity(0.18)
    case .done: return ADEColor.success.opacity(0.22)
    case .warning, .failed: return ADEColor.warning.opacity(0.22)
    case .skipped, .pending: return ADEColor.textMuted.opacity(0.14)
    }
  }

  static func railFill(_ status: ChatLaunchStageStatus) -> Color {
    switch status {
    case .running: return running.opacity(0.85)
    case .done: return ADEColor.success.opacity(0.75)
    case .warning: return ADEColor.warning.opacity(0.72)
    case .failed: return ADEColor.warning.opacity(0.85)
    case .skipped: return ADEColor.textMuted.opacity(0.28)
    case .pending: return .clear
    }
  }

  /// A launch phase as a stage status, for the header tile.
  static func phaseStatus(_ launch: ChatLaunchSnapshot) -> ChatLaunchStageStatus {
    switch launch.phase {
    case .failed: return .failed
    case .cancelled: return .skipped
    case .completed: return chatLaunchCompletedWithWarnings(launch) ? .warning : .done
    case .running, .awaitingClient: return chatLaunchLaneIsReady(launch) ? .done : .running
    }
  }

  /// Header glyph for a phase status: warning and failure share the amber
  /// triangle, done a check, anything still moving the lane mark.
  static func phaseSymbol(_ status: ChatLaunchStageStatus) -> String {
    switch status {
    case .failed, .warning: return "exclamationmark.triangle.fill"
    case .done: return "checkmark"
    default: return "arrow.branch"
    }
  }
}

// MARK: - Glyphs

/// One stage's status mark. Pending is a hollow ring, running a small spinner,
/// done a check, warning an amber triangle, failed an amber cross (ADE chat has
/// no red path), skipped a minus.
struct WorkChatLaunchStageGlyph: View {
  let status: ChatLaunchStageStatus
  var size: CGFloat = 12

  var body: some View {
    ZStack {
      switch status {
      case .running:
        ProgressView()
          .controlSize(.mini)
          .tint(WorkChatLaunchTone.running)
          .scaleEffect(size < 11 ? 0.75 : 0.9)
          .transition(.opacity)
      case .pending:
        Circle()
          .strokeBorder(ADEColor.textMuted.opacity(0.45), lineWidth: 1.1)
          .frame(width: size - 2, height: size - 2)
          .transition(.opacity)
      default:
        Image(systemName: symbol)
          .font(.system(size: size - 1, weight: .bold))
          .foregroundStyle(WorkChatLaunchTone.tint(status).opacity(status == .skipped ? 0.6 : 0.9))
          .transition(.scale(scale: 0.6).combined(with: .opacity))
      }
    }
    .frame(width: size + 4, height: size + 4)
    .accessibilityHidden(true)
  }

  private var symbol: String {
    switch status {
    case .done: return "checkmark"
    case .warning: return "exclamationmark.triangle.fill"
    case .failed: return "xmark"
    case .skipped: return "minus"
    case .pending, .running: return "circle"
    }
  }
}

/// The rounded icon tile at the head of a stage row (and the card header).
struct WorkChatLaunchStageTile: View {
  let symbol: String
  let status: ChatLaunchStageStatus
  var size: CGFloat = 22

  var body: some View {
    Image(systemName: symbol)
      .font(.system(size: size * 0.5, weight: status == .running ? .semibold : .regular))
      .foregroundStyle(WorkChatLaunchTone.tileIcon(status))
      .frame(width: size, height: size)
      .background(
        WorkChatLaunchTone.tileFill(status),
        in: RoundedRectangle(cornerRadius: size * 0.3, style: .continuous)
      )
      .overlay(
        RoundedRectangle(cornerRadius: size * 0.3, style: .continuous)
          .strokeBorder(WorkChatLaunchTone.tileStroke(status), lineWidth: 1)
      )
      .accessibilityHidden(true)
  }
}

/// The lane-environment step glyph (`LaneEnvInitStep.status` is a plain string).
func workChatLaunchEnvStepStatus(_ raw: String) -> ChatLaunchStageStatus {
  switch raw.lowercased() {
  case "completed", "done": return .done
  case "running": return .running
  case "failed": return .failed
  case "skipped": return .skipped
  case "warning": return .warning
  default: return .pending
  }
}

/// A hairline in the card's border colour.
struct WorkChatLaunchHairline: View {
  @Environment(\.displayScale) private var displayScale

  var body: some View {
    Rectangle()
      .fill(ADEColor.glassBorder)
      .frame(height: 1 / max(displayScale, 1))
      .accessibilityHidden(true)
  }
}

// MARK: - Progress rail

/// The segmented launch progress rail: one segment per stage. A segment's fill
/// is a full-width capsule scaled from the leading edge (checkout's real
/// percent, else empty or full), and the running segment carries a sheen that
/// slides across by offset. Both are transform animations; no per-frame state.
struct WorkChatLaunchProgressRail: View, Equatable {
  let segments: [ChatLaunchRailSegment]
  var height: CGFloat = 3

  var body: some View {
    HStack(spacing: 3) {
      ForEach(segments, id: \.id) { segment in
        WorkChatLaunchRailSegmentView(segment: segment, height: height)
      }
    }
    .frame(height: height)
    .accessibilityHidden(true)
  }
}

private struct WorkChatLaunchRailSegmentView: View {
  let segment: ChatLaunchRailSegment
  let height: CGFloat

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    Capsule(style: .continuous)
      .fill(WorkChatLaunchTone.railTrack(segment.status))
      .overlay {
        Capsule(style: .continuous)
          .fill(WorkChatLaunchTone.railFill(segment.status))
          .scaleEffect(x: max(segment.fill, 0.001), y: 1, anchor: .leading)
          .opacity(segment.fill > 0 ? 1 : 0)
      }
      .overlay {
        if segment.status == .running && !reduceMotion {
          WorkChatLaunchRailSheen()
            .transition(.opacity)
        }
      }
      .clipShape(Capsule(style: .continuous))
      .frame(maxWidth: .infinity)
      .frame(height: height)
      .animation(reduceMotion ? nil : .easeOut(duration: 0.3), value: segment)
  }
}

/// A soft highlight that slides across the running segment, forever. The only
/// state is one Bool flipped on appear; the repeat is an offset animation.
private struct WorkChatLaunchRailSheen: View {
  @State private var sweeping = false

  var body: some View {
    GeometryReader { proxy in
      let width = max(proxy.size.width * 0.45, 14)
      LinearGradient(
        colors: [.white.opacity(0), .white.opacity(0.5), .white.opacity(0)],
        startPoint: .leading,
        endPoint: .trailing
      )
      .frame(width: width)
      .offset(x: sweeping ? proxy.size.width : -width)
      .animation(.linear(duration: 1.5).repeatForever(autoreverses: false), value: sweeping)
    }
    .allowsHitTesting(false)
    .onAppear { sweeping = true }
  }
}

// MARK: - Durations

/// A stage's (or the launch's) elapsed time. Ticks at 1 Hz only while live, in
/// whole seconds; a finished span renders its fixed duration with no timeline.
struct WorkChatLaunchDurationText: View {
  let startedAt: String?
  let endedAt: String?
  let isLive: Bool
  var color: Color = ADEColor.textMuted

  var body: some View {
    if isLive {
      TimelineView(.periodic(from: .now, by: 1)) { context in
        label(formatChatLaunchLiveDuration(durationMs(nowMs: context.date.timeIntervalSince1970 * 1000)))
      }
    } else {
      label(formatChatLaunchDuration(durationMs(nowMs: Date().timeIntervalSince1970 * 1000)))
    }
  }

  private func durationMs(nowMs: Double) -> Double? {
    chatLaunchStageDurationMs(startedAt: startedAt, endedAt: endedAt, nowMs: nowMs)
  }

  @ViewBuilder
  private func label(_ text: String) -> some View {
    if !text.isEmpty {
      Text(text)
        .font(.caption2.monospacedDigit())
        .foregroundStyle(color)
        .lineLimit(1)
        .fixedSize()
        .contentTransition(.numericText())
    }
  }
}

// MARK: - Stage row

/// One stage line: `[tile] label  detail  62% …… 1.2s [status]`. Shared by the
/// live card and the transcript card's payload fallback.
struct WorkChatLaunchStageLine: View {
  let symbol: String
  let status: ChatLaunchStageStatus
  let label: String
  var detail: String? = nil
  var percent: Double? = nil
  var startedAt: String? = nil
  var endedAt: String? = nil
  var compact = false
  var isExpandable = false
  var isExpanded = false

  var body: some View {
    HStack(spacing: compact ? 8 : 10) {
      WorkChatLaunchStageTile(symbol: symbol, status: status, size: compact ? 18 : 22)
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Text(label)
          .font(compact ? .caption : .footnote)
          .fontWeight(status == .running ? .medium : .regular)
          .foregroundStyle(labelColor)
          .lineLimit(1)
          .layoutPriority(1)
        if let detail, !detail.isEmpty {
          Text(detail)
            .font(.caption2)
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
            .truncationMode(.middle)
        }
        if let percent {
          Text("\(chatLaunchFormatNumber(percent))%")
            .font(.caption2.monospacedDigit().weight(.medium))
            .foregroundStyle(WorkChatLaunchTone.running)
            .contentTransition(.numericText())
            .fixedSize()
        }
        if isExpandable {
          Image(systemName: "chevron.right")
            .font(.system(size: 8, weight: .bold))
            .foregroundStyle(ADEColor.textMuted)
            .rotationEffect(.degrees(isExpanded ? 90 : 0))
        }
      }
      Spacer(minLength: 6)
      WorkChatLaunchDurationText(startedAt: startedAt, endedAt: endedAt, isLive: status == .running)
      WorkChatLaunchStageGlyph(status: status, size: compact ? 11 : 12)
    }
    .frame(minHeight: compact ? 28 : 34)
    .contentShape(Rectangle())
  }

  private var labelColor: Color {
    switch status {
    case .running: return ADEColor.textPrimary
    case .done: return ADEColor.textSecondary
    case .warning, .failed: return ADEColor.textPrimary
    case .pending, .skipped: return ADEColor.textMuted
    }
  }
}

struct WorkChatLaunchStageRow: View {
  let stage: ChatLaunchStage
  let kind: ChatLaunchKind
  let templateName: String?
  var compact = false
  var isExpandable = false
  var isExpanded = false
  var onToggle: () -> Void = {}

  var body: some View {
    WorkChatLaunchStageLine(
      symbol: chatLaunchStageSymbol(stage.id, kind: kind, templateName: templateName),
      status: stage.status,
      label: chatLaunchStageLabel(stage.id, kind: kind, templateName: templateName),
      detail: stage.detail?.trimmingCharacters(in: .whitespacesAndNewlines),
      percent: stage.id == .checkout && stage.status == .running ? stage.percent : nil,
      startedAt: stage.startedAt,
      endedAt: stage.endedAt,
      compact: compact,
      isExpandable: isExpandable,
      isExpanded: isExpanded
    )
    .onTapGesture {
      if isExpandable { onToggle() }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(accessibilityText)
    .accessibilityAddTraits(isExpandable ? .isButton : [])
  }

  private var accessibilityText: String {
    var parts = [chatLaunchStageLabel(stage.id, kind: kind, templateName: templateName)]
    switch stage.status {
    case .pending: parts.append("waiting")
    case .running: parts.append("in progress")
    case .done: parts.append("done")
    case .skipped: parts.append("skipped")
    case .warning: parts.append("finished with a warning")
    case .failed: parts.append("failed")
    }
    if let detail = chatLaunchStageTrailingDetail(stage) { parts.append(detail) }
    return parts.joined(separator: ", ")
  }
}

/// The environment's own steps, indented under the environment row on a
/// hairline guide that drops from the stage tile's centre.
struct WorkChatLaunchEnvironmentSteps: View {
  let steps: [LaneEnvInitStep]
  var compact = false

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      ForEach(Array(steps.enumerated()), id: \.offset) { _, step in
        stepRow(step)
      }
    }
    .padding(.leading, compact ? 16 : 18)
    .overlay(alignment: .leading) {
      Rectangle()
        .fill(ADEColor.glassBorder)
        .frame(width: 1)
    }
    .padding(.leading, compact ? 8.5 : 10.5)
    .padding(.bottom, 6)
  }

  private func stepRow(_ step: LaneEnvInitStep) -> some View {
    let status = workChatLaunchEnvStepStatus(step.status)
    let error = step.error?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return HStack(spacing: 8) {
      Image(systemName: chatLaunchEnvStepSymbol(step.kind))
        .font(.system(size: 10, weight: status == .running ? .semibold : .regular))
        .foregroundStyle(WorkChatLaunchTone.tileIcon(status).opacity(status == .done ? 0.8 : 1))
        .frame(width: 14)
      Text(step.label)
        .font(.caption)
        .foregroundStyle(stepLabelColor(status))
        .lineLimit(1)
        .layoutPriority(1)
      Spacer(minLength: 6)
      if status == .failed || status == .warning, !error.isEmpty {
        Text(error)
          .font(.caption2)
          .foregroundStyle(ADEColor.warning.opacity(0.9))
          .lineLimit(1)
          .truncationMode(.tail)
      } else if let durationMs = step.durationMs {
        Text(formatChatLaunchDuration(Double(durationMs)))
          .font(.caption2.monospacedDigit())
          .foregroundStyle(ADEColor.textMuted)
          .fixedSize()
      }
      WorkChatLaunchStageGlyph(status: status, size: 9)
    }
    .frame(minHeight: 22)
    .accessibilityElement(children: .combine)
  }

  private func stepLabelColor(_ status: ChatLaunchStageStatus) -> Color {
    switch status {
    case .running: return ADEColor.textPrimary
    case .pending, .skipped: return ADEColor.textMuted
    default: return ADEColor.textSecondary
    }
  }
}

// MARK: - Pending row rail

/// The rail under a Work or Hub row whose chat is still being launched, with
/// the stage count for VoiceOver (the rail itself is decorative).
struct WorkChatLaunchRowRail: View, Equatable {
  let segments: [ChatLaunchRailSegment]

  var body: some View {
    WorkChatLaunchProgressRail(segments: segments, height: 2.5)
      .padding(.top, 2)
      .accessibilityElement()
      .accessibilityLabel(accessibilityText)
  }

  private var accessibilityText: String {
    let finished = segments.filter { $0.status == .done || $0.status == .skipped || $0.status == .warning }.count
    return "Lane setup, \(finished) of \(segments.count) steps done"
  }
}

// MARK: - Queued message

/// A message typed while the lane was being set up, as the user's (queued)
/// bubble. When the host's delivery failed it adds "Couldn't send — retrying"
/// and the error under the bubble, in amber: the host keeps retrying, so this
/// is a wait, not a dead end. Used by the pending screen and, after the agent
/// started, under the transcript's setup card.
struct WorkChatLaunchQueuedMessageView: View {
  let message: ChatLaunchQueuedMessage
  var maxBubbleWidth: CGFloat = 320

  var body: some View {
    VStack(alignment: .trailing, spacing: 4) {
      WorkChatMessageBubble(
        message: WorkChatMessage(
          id: "launch-queued-\(message.id)",
          role: "user",
          markdown: message.bubbleText,
          timestamp: message.createdAt,
          turnId: nil,
          itemId: nil,
          deliveryState: "queued",
          attachments: message.attachments
        ),
        maxUserBubbleWidth: maxBubbleWidth,
        onOpenFullOutput: {}
      )
      if let error = message.deliveryError {
        WorkChatLaunchDeliveryFailureNote(error: error)
      }
    }
    .frame(maxWidth: .infinity, alignment: .trailing)
  }
}

/// "Couldn't send — retrying" plus the host's delivery error.
struct WorkChatLaunchDeliveryFailureNote: View {
  let error: String

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 5) {
      Image(systemName: "arrow.clockwise")
        .font(.system(size: 9, weight: .bold))
      VStack(alignment: .leading, spacing: 1) {
        Text(chatLaunchDeliveryFailureTitle)
          .font(.caption2.weight(.semibold))
        Text(error)
          .font(.caption2)
          .foregroundStyle(ADEColor.warning.opacity(0.85))
          .lineLimit(3)
          .fixedSize(horizontal: false, vertical: true)
          .textSelection(.enabled)
      }
    }
    .foregroundStyle(ADEColor.warning)
    .padding(.horizontal, 4)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(chatLaunchDeliveryFailureTitle). \(error)")
  }
}
