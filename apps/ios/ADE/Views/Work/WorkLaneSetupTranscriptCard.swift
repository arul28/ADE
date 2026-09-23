import SwiftUI

// MARK: - Transcript card

/// The `lane_setup` `ade_card` at the top of a launched chat. Prefers the live
/// snapshot this device holds; falls back to the card's own rows (reload,
/// another device's launch that has expired). One fixed-height line per stage
/// so the transcript's measured row height stays valid as stages tick.
///
/// Messages typed during setup whose delivery failed stay on the launch after
/// the agent starts (the host keeps retrying); they show under the card as
/// "Couldn't send — retrying" until the host delivers them.
struct WorkLaneSetupTranscriptCard: View {
  let card: WorkAdeCardModel
  @ObservedObject var store: ChatLaunchStore

  var body: some View {
    let snapshot = chatLaunchIdFromLaneSetupCardId(card.id).flatMap { store.snapshot(launchId: $0) }
    let undelivered = snapshot?.queuedMessages.filter(\.deliveryFailed) ?? []
    VStack(alignment: .leading, spacing: 10) {
      if let snapshot, workLaneSetupCardMatchesSnapshot(card, snapshot) {
        liveCard(snapshot)
      } else {
        payloadCard
      }
      ForEach(undelivered) { message in
        WorkChatLaunchQueuedMessageView(message: message)
      }
    }
  }

  private func liveCard(_ snapshot: ChatLaunchSnapshot) -> some View {
    WorkLaneSetupCompactCard(
      title: chatLaunchCardTitle(snapshot),
      laneName: snapshot.laneName,
      phaseStatus: WorkChatLaunchTone.phaseStatus(snapshot),
      rows: snapshot.stages.map { stage in
        WorkLaneSetupCompactRow(
          symbol: chatLaunchStageSymbol(stage.id, kind: snapshot.kind, templateName: snapshot.templateName),
          status: stage.status,
          label: chatLaunchStageLabel(stage.id, kind: snapshot.kind, templateName: snapshot.templateName),
          detail: stage.detail?.trimmingCharacters(in: .whitespacesAndNewlines),
          percent: stage.id == .checkout && stage.status == .running ? stage.percent : nil,
          startedAt: stage.startedAt,
          endedAt: stage.endedAt
        )
      },
      rail: chatLaunchRailSegments(snapshot.stages)
    )
  }

  @ViewBuilder
  private var payloadCard: some View {
    let rows = workLaneSetupPayloadRows(card)
    let failed = card.rows.contains { $0.icon == .fail }
    let running = rows.contains { $0.status == .running }
    WorkLaneSetupCompactCard(
      title: chatLaunchCardPayloadTitle(title: workLaneSetupHostTitle(card), failed: failed, durationMs: card.durationMs),
      laneName: card.subtitle ?? "",
      phaseStatus: failed ? .failed : running ? .running : .done,
      rows: rows,
      rail: rows.enumerated().map { index, row in
        ChatLaunchRailSegment(
          id: "\(index)",
          status: row.status,
          fill: chatLaunchRailFill(status: row.status, percent: nil)
        )
      }
    )
  }
}

/// Whether the live snapshot describes the same stages as the card, matched
/// by each row's `key` (its stage id).
func workLaneSetupCardMatchesSnapshot(_ card: WorkAdeCardModel, _ snapshot: ChatLaunchSnapshot) -> Bool {
  guard !snapshot.stages.isEmpty else { return false }
  if card.rows.isEmpty { return true }
  // Every lane_setup row carries its stage id as `key`.
  return card.rows.map(\.key) == snapshot.stages.map { Optional($0.id.rawValue) }
}

/// The host's card title, or "" when it sent none (the card model substitutes
/// the variant name for a blank title).
func workLaneSetupHostTitle(_ card: WorkAdeCardModel) -> String {
  card.title == card.variant ? "" : card.title
}

/// The template a `lane_setup` card was built with, from its `Template` metric.
func workLaneSetupTemplateName(_ card: WorkAdeCardModel) -> String? {
  let value = card.metrics
    .first { $0.label == chatLaunchCardTemplateMetric }?
    .value
    .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  return value.isEmpty ? nil : value
}

/// A `lane_setup` card's rows as stage lines, read from the payload alone.
/// Stage identity comes from the row `key` alone. A transcript card belongs to
/// a chat launch, so its agent row is the chat's agent, never a CLI session.
func workLaneSetupPayloadRows(_ card: WorkAdeCardModel) -> [WorkLaneSetupCompactRow] {
  let templateName = workLaneSetupTemplateName(card)
  return card.rows.map { row in
    let label = row.text
    let symbol = chatLaunchStageIdForCardRow(key: row.key).map {
      chatLaunchStageSymbol($0, kind: .chat, templateName: templateName)
    } ?? "wrench.and.screwdriver"
    return WorkLaneSetupCompactRow(
      symbol: symbol,
      status: workLaneSetupStatus(for: row),
      label: label,
      detail: row.detail,
      percent: nil,
      startedAt: nil,
      endedAt: nil
    )
  }
}

/// Card row → stage status (desktop `stageStatusFromCardRow`). The host writes
/// a warning stage as `pass` in the warning tone; hosts before that wrote it as
/// `info` in the warning tone, which older transcripts still carry.
func workLaneSetupStatus(for row: WorkAdeCardRow) -> ChatLaunchStageStatus {
  switch row.icon {
  case .pass: return row.tone == .warning ? .warning : .done
  case .fail: return .failed
  case .running: return .running
  case .skipped: return .skipped
  case .info: return row.tone == .warning ? .warning : .pending
  case .queued, .file, .none: return .pending
  }
}

struct WorkLaneSetupCompactRow: Equatable {
  let symbol: String
  let status: ChatLaunchStageStatus
  let label: String
  let detail: String?
  let percent: Double?
  let startedAt: String?
  let endedAt: String?
}

private struct WorkLaneSetupCompactCard: View {
  let title: String
  let laneName: String
  let phaseStatus: ChatLaunchStageStatus
  let rows: [WorkLaneSetupCompactRow]
  let rail: [ChatLaunchRailSegment]

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 8) {
        WorkChatLaunchStageTile(
          symbol: phaseStatus == .failed ? "exclamationmark.triangle.fill" : phaseStatus == .done ? "checkmark" : "arrow.branch",
          status: phaseStatus,
          size: 20
        )
        Text(title)
          .font(.footnote.weight(.semibold))
          .foregroundStyle(phaseStatus == .failed ? ADEColor.warning : ADEColor.textPrimary)
          .lineLimit(1)
        Spacer(minLength: 6)
        let name = laneName.trimmingCharacters(in: .whitespacesAndNewlines)
        if !name.isEmpty {
          HStack(spacing: 3) {
            WorkLaneLogoMark(color: WorkChatLaunchTone.running, size: 8)
            Text(name)
              .lineLimit(1)
              .truncationMode(.middle)
          }
          .font(.caption2.weight(.medium))
          .foregroundStyle(ADEColor.textSecondary)
          .padding(.horizontal, 6)
          .padding(.vertical, 2)
          .background(ADEColor.recessedBackground.opacity(0.5), in: Capsule(style: .continuous))
          .overlay(Capsule(style: .continuous).strokeBorder(ADEColor.glassBorder, lineWidth: 1))
        }
      }
      WorkChatLaunchProgressRail(segments: rail, height: 2.5)
        .padding(.top, 9)
        .padding(.bottom, 3)
      ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
        if index > 0 { WorkChatLaunchHairline() }
        WorkChatLaunchStageLine(
          symbol: row.symbol,
          status: row.status,
          label: row.label,
          detail: row.detail,
          percent: row.percent,
          startedAt: row.startedAt,
          endedAt: row.endedAt,
          compact: true
        )
      }
    }
    .padding(.horizontal, 12)
    .padding(.top, 10)
    .padding(.bottom, 4)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(ADEColor.cardBackground.opacity(0.45), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .strokeBorder(phaseStatus == .failed ? ADEColor.warning.opacity(0.3) : ADEColor.glassBorder, lineWidth: 1)
    )
    .animation(ADEMotion.quick(reduceMotion: reduceMotion), value: rows)
    .accessibilityElement(children: .combine)
  }
}
