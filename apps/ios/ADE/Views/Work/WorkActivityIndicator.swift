import SwiftUI

/// A live one-line pill that surfaces what the agent is doing right now
/// ("Running bash: ls -la", "Editing src/foo.ts", "Thinking…") by scanning
/// the tail of the transcript for the most recent actionable event.
///
/// Ports desktop `deriveLatestActivity` behaviour (see
/// apps/desktop/src/renderer/components/chat/AgentChatMessageList.tsx:2500)
/// against the existing `WorkChatEvent` shapes. Does not add new envelope
/// payloads. Respects Reduce Motion by falling back to a static dot.
struct WorkActivityIndicator: View {
  let transcript: [WorkChatEnvelope]
  let isStreaming: Bool

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  /// Anchors the elapsed label to when the streaming turn began. Held in
  /// `@State` so it survives transcript re-renders; only re-derived when the
  /// transcript actually changes (via `onAppear` / `onChange`), never per-frame.
  ///
  /// The seconds counter itself is computed from a `TimelineView(.periodic)`
  /// clock rather than a stored `Timer.publish().autoconnect()`. The latter is
  /// recreated on every struct re-init (which, while streaming, can happen
  /// faster than once a second), and `.onReceive` re-subscribes to the fresh
  /// publisher each time — resetting its interval so the tick may never fire.
  /// `TimelineView` is immune to that, auto-pauses off-screen, and writes no
  /// per-tick `@State` so it can't trigger a transcript re-render storm.
  @State private var turnStart: Date?

  @ViewBuilder
  var body: some View {
    if isStreaming, let presentation = Self.derivePresentation(from: transcript) {

      // Re-rendering only this leaf view once a second; the elapsed value is a
      // pure function of `context.date`, so no @State is mutated on tick.
      TimelineView(.periodic(from: .now, by: 1)) { context in
        let elapsed = elapsedSeconds(at: context.date)

        HStack(spacing: 10) {
          // The lone streaming animation in the transcript: three staggered
          // violet dots (static under Reduce Motion).
          WorkThinkingDots()
            .frame(height: 6)

          Text(tailLabel(for: presentation, elapsed: elapsed))
            .font(.caption.weight(.semibold))
            .foregroundStyle(presentation.tint)
            .tracking(0.3)
            .lineLimit(1)
            .truncationMode(.tail)

          if let detail = presentation.detail {
            Text(detail)
              .font(.caption2.monospaced())
              .foregroundStyle(ADEColor.textMuted)
              .lineLimit(1)
              .truncationMode(.middle)
          }

          Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(presentation.accessibilityLabel)
      }
      .onAppear { syncTurnStart() }
      .onChange(of: transcript.count) { _, _ in syncTurnStart() }
    }
  }

  /// Whole seconds elapsed since the anchored turn start. Clamped at 0 so a
  /// future-dated anchor (host clock skew) can't render a negative counter.
  private func elapsedSeconds(at now: Date) -> Int {
    guard let turnStart else { return 0 }
    return max(0, Int(now.timeIntervalSince(turnStart)))
  }

  /// "Thinking · 4s" / "Working · 1m 02s · taking longer than usual".
  private func tailLabel(for presentation: Presentation, elapsed: Int) -> String {
    var label = presentation.label
    if elapsed > 0 {
      label += " · \(Self.formatElapsedSeconds(elapsed))"
    }
    if elapsed >= 30 {
      label += " · taking longer than usual"
    }
    return label
  }

  static func formatElapsedSeconds(_ totalSeconds: Int) -> String {
    let safe = max(0, totalSeconds)
    if safe < 60 { return "\(safe)s" }
    return String(format: "%dm %02ds", safe / 60, safe % 60)
  }

  /// Anchor the elapsed clock to the most recent active-turn start. Falls back
  /// to the latest envelope timestamp so the counter still advances even when a
  /// discrete `status: started` boundary wasn't emitted.
  private func syncTurnStart() {
    let anchor = Self.activeTurnStartTimestamp(from: transcript)
    guard let anchor, let date = workActivityTimestamp(anchor) else {
      if turnStart == nil {
        turnStart = Date()
      }
      return
    }
    if turnStart == nil || abs(date.timeIntervalSince(turnStart ?? date)) > 1.5 {
      turnStart = date
    }
  }

  /// Timestamp of the last user message / turn-start boundary, i.e. when the
  /// currently-streaming turn began.
  static func activeTurnStartTimestamp(from transcript: [WorkChatEnvelope]) -> String? {
    var latestActiveStatus: String?
    for envelope in transcript.reversed() {
      switch envelope.event {
      case .userMessage:
        return envelope.timestamp
      case .status(let turnStatus, _, _):
        if latestActiveStatus == nil,
           ["started", "active", "running"].contains(turnStatus.lowercased()) {
          latestActiveStatus = envelope.timestamp
        }
      default:
        continue
      }
    }
    return latestActiveStatus ?? transcript.last?.timestamp
  }

  struct Presentation: Equatable {
    let label: String
    let detail: String?
    let tint: Color

    var accessibilityLabel: String {
      detail.map { "\(label): \($0)" } ?? label
    }
  }

  /// Walks the transcript tail looking for the most recent running/active
  /// event. Command > running tool call > file change > named activity >
  /// subagent progress > fall back to "Working".
  static func derivePresentation(from transcript: [WorkChatEnvelope]) -> Presentation? {
    let workingFallback = Presentation(label: "Working", detail: nil, tint: ADEColor.accent)
    let endedTurnIds = Set(transcript.compactMap(Self.endedTurnId(from:)))

    for envelope in sortedWorkChatEnvelopes(transcript).reversed() {
      switch envelope.event {
      case .done:
        return nil

      case .userMessage:
        return workingFallback

      case .assistantText(_, let turnId, _):
        if let turnId, endedTurnIds.contains(turnId) { continue }
        return workingFallback

      case .command(let command, _, _, let status, _, _, _, let turnId):
        if let turnId, endedTurnIds.contains(turnId) { continue }
        if status == .running {
          return Presentation(
            label: "Running command",
            detail: summarizeCommand(command),
            tint: ADEColor.accent
          )
        }

      case .toolCall(let tool, let argsText, _, _, let turnId):
        if let turnId, endedTurnIds.contains(turnId) { continue }
        let activity = workToolActivityPresentation(tool: tool, argsText: argsText)
        return Presentation(
          label: activity.label,
          detail: activity.detail,
          tint: ADEColor.accent
        )

      case .toolResult(let tool, _, _, _, let turnId, let status):
        if let turnId, endedTurnIds.contains(turnId) { continue }
        if status == .running {
          let activity = workToolActivityPresentation(tool: tool, argsText: nil)
          return Presentation(
            label: activity.label,
            detail: activity.detail,
            tint: ADEColor.accent
          )
        }

      case .fileChange(let path, _, let kind, let status, _, let turnId):
        if let turnId, endedTurnIds.contains(turnId) { continue }
        if status == .running {
          return Presentation(
            label: fileChangeLabel(kind: kind),
            detail: truncatedPath(path),
            tint: ADEColor.accent
          )
        }

      case .activity(let kind, let detail, let turnId):
        if let turnId, endedTurnIds.contains(turnId) { continue }
        let label = humanizeActivityKind(kind)
        return Presentation(
          label: label.isEmpty ? "Working" : label,
          detail: detail?.isEmpty == false ? detail : nil,
          tint: ADEColor.accent
        )

      case .webSearch(let query, _, let status, _, let turnId):
        if let turnId, endedTurnIds.contains(turnId) { continue }
        if status == .running {
          return Presentation(
            label: "Searching",
            detail: query,
            tint: ADEColor.accent
          )
        }

      case .subagentStarted(_, _, _, _, let description, _, let turnId):
        if let turnId, endedTurnIds.contains(turnId) { continue }
        return Presentation(
          label: "Agent",
          detail: description,
          tint: ADEColor.accent
        )

      case .subagentProgress(_, _, _, _, _, let summary, let toolName, let turnId):
        if let turnId, endedTurnIds.contains(turnId) { continue }
        return Presentation(
          label: toolName.map { "Agent · \($0)" } ?? "Agent",
          detail: summary.isEmpty ? nil : summary,
          tint: ADEColor.accent
        )

      case .status(let turnStatus, let message, _):
        if Self.isTerminalStatus(turnStatus) {
          return nil
        }
        if Self.isActiveStatus(turnStatus) {
          return workingFallback
        }
        if let message, !message.isEmpty {
          return Presentation(
            label: humanizeActivityKind(turnStatus),
            detail: message,
            tint: ADEColor.accent
          )
        }

      case .reasoning:
        return Presentation(label: "Thinking", detail: nil, tint: ADEColor.accent)

      case .plan, .planText,
           .todoUpdate, .approvalRequest, .structuredQuestion, .toolUseSummary,
           .systemNotice, .error, .promptSuggestion, .contextCompact,
           .autoApprovalReview, .pendingInputResolved, .subagentResult,
           .completionReport, .tokens, .unknown:
        continue
      }
    }

    return workingFallback
  }

  private static func endedTurnId(from envelope: WorkChatEnvelope) -> String? {
    switch envelope.event {
    case .done(_, _, _, let turnId, _, _):
      return normalizedActivityTurnId(turnId)
    case .status(let turnStatus, _, let turnId) where isTerminalStatus(turnStatus):
      return normalizedActivityTurnId(turnId)
    default:
      return nil
    }
  }

  private static func normalizedActivityTurnId(_ turnId: String?) -> String? {
    let key = turnId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return key.isEmpty ? nil : key
  }

  private static func isActiveStatus(_ status: String) -> Bool {
    switch status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
    case "started", "active", "running", "inprogress", "in_progress", "in-progress":
      return true
    default:
      return false
    }
  }

  private static func isTerminalStatus(_ status: String) -> Bool {
    switch status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
    case "completed", "failed", "interrupted", "cancelled", "canceled", "ended":
      return true
    default:
      return false
    }
  }

  private static func fileChangeLabel(kind: String) -> String {
    switch kind.lowercased() {
    case "create", "add": return "Creating"
    case "delete", "remove": return "Deleting"
    case "rename": return "Renaming"
    case "update", "modify", "edit": return "Editing"
    default: return "Editing"
    }
  }

  private static func humanizeActivityKind(_ kind: String) -> String {
    let cleaned = kind.replacingOccurrences(of: "_", with: " ")
    return cleaned.prefix(1).uppercased() + cleaned.dropFirst()
  }

  private static func truncatedPath(_ path: String) -> String {
    let parts = path.split(separator: "/")
    guard parts.count > 2 else { return path }
    return ".../" + parts.suffix(2).joined(separator: "/")
  }

  private static func summarizeCommand(_ command: String) -> String {
    let trimmed = command.trimmingCharacters(in: .whitespacesAndNewlines)
    let firstLine = trimmed.split(separator: "\n").first.map(String.init) ?? trimmed
    if firstLine.count <= 72 { return firstLine }
    return String(firstLine.prefix(69)) + "…"
  }
}

func workChatShouldShowInterruptControl(isStreamingTurn: Bool, transcript: [WorkChatEnvelope]) -> Bool {
  guard isStreamingTurn else { return false }
  return WorkActivityIndicator.derivePresentation(from: transcript) != nil
}

/// Parse an ISO-8601 timestamp (with or without fractional seconds) into a
/// `Date` for elapsed-time math. Returns nil on host quirks so callers can fall
/// back gracefully.
private func workActivityTimestamp(_ iso: String) -> Date? {
  if let date = workActivityIsoFormatter.date(from: iso) { return date }
  return workActivityIsoFallbackFormatter.date(from: iso)
}

private let workActivityIsoFormatter: ISO8601DateFormatter = {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return formatter
}()

private let workActivityIsoFallbackFormatter: ISO8601DateFormatter = {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime]
  return formatter
}()
