import SwiftUI

/// Detail for one staged message.
///
/// The strip row is icon-only, so a long message is truncated to a line and the
/// four actions are unlabelled glyphs. Tapping the row opens this sheet: the
/// whole message, when it was staged, what happens to it next, and every
/// delivery option the provider has — including the ones it does not support,
/// shown disabled with the reason rather than quietly dropped.
struct WorkQueuedSteerDetailSheet: View {
  let steer: WorkPendingSteerModel
  let capability: WorkActiveSendCapability
  /// True while the turn this message is waiting behind is running.
  let turnActive: Bool
  /// False when the host is unreachable — every action is a host round trip.
  let isLive: Bool
  let busy: Bool
  let onDispatchInline: (@MainActor () async -> Void)?
  let onDispatchInterrupt: (@MainActor () async -> Void)?
  let onBeginEdit: () -> Void
  let onCancel: @MainActor () async -> Void

  @Environment(\.dismiss) private var dismiss
  @State private var actionInFlight = false

  private var controlsEnabled: Bool { isLive && !busy && !actionInFlight }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        header
        messageBody
        if let attachments = steer.attachments, !attachments.isEmpty {
          attachmentChips(attachments)
        }
        VStack(spacing: 8) {
          sendNowRow
          interruptRow
          editRow
          cancelRow
        }
        if !isLive {
          Text("Reconnect to this chat to change a staged message.")
            .font(.caption)
            .foregroundStyle(ADEColor.textMuted)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      .padding(.horizontal, 20)
      .padding(.top, 22)
      .padding(.bottom, 24)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .background(ADEColor.surfaceBackground)
    .presentationDetents([.medium, .large])
    .presentationDragIndicator(.visible)
    .accessibilityIdentifier("Work.Chat.StagedStrip.DetailSheet")
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(stateTitle)
        .font(.headline)
        .foregroundStyle(ADEColor.textPrimary)
      Text(stateDetail)
        .font(.subheadline)
        .foregroundStyle(ADEColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  /// Selectable so a long prompt can be copied back out, and scrollable through
  /// the sheet's own ScrollView rather than a nested clipped box.
  private var messageBody: some View {
    Text(steer.text)
      .font(.system(size: 15))
      .foregroundStyle(ADEColor.textPrimary)
      .textSelection(.enabled)
      .fixedSize(horizontal: false, vertical: true)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(12)
      .background(ADEColor.raisedBackground, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .stroke(ADEColor.glassBorder, lineWidth: 0.5)
      )
      .accessibilityIdentifier("Work.Chat.StagedStrip.DetailSheet.Message")
  }

  private func attachmentChips(_ attachments: [AgentChatFileRef]) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      ForEach(Array(attachments.enumerated()), id: \.offset) { _, ref in
        HStack(spacing: 6) {
          Image(systemName: workChatAttachmentIsImage(ref) ? "photo" : "doc")
            .font(.caption)
            .foregroundStyle(ADEColor.textMuted)
          Text(workChatAttachmentDisplayName(ref))
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(1)
            .truncationMode(.middle)
        }
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(workChatAttachmentAccessibilityLabel(attachments))
  }

  private var stateTitle: String {
    turnActive ? "Queued" : "Waiting to send"
  }

  /// Names the provider and says what actually happens next. A Claude steer is
  /// picked up at the next tool step, not parked until the turn ends, and the
  /// strip's one-line disposition had no room to say so.
  private var stateDetail: String {
    let staged = "Staged \(relativeTimestamp(steer.timestamp))."
    guard turnActive else {
      return "\(staged) It sends as soon as \(capability.agentLabel) is ready."
    }
    if capability.modes.contains(.inline) {
      return "\(staged) \(capability.agentLabel) picks it up after the current tool step."
    }
    return "\(staged) \(capability.agentLabel) can't take a message mid-turn, so it sends when this turn ends."
  }

  private var sendNowRow: some View {
    optionRow(
      systemImage: "arrow.turn.down.right",
      tint: ADEColor.accent,
      title: "Send now",
      description: "Send it now, ahead of the current step.",
      unavailableReason: sendNowUnavailableReason,
      identifier: "Work.Chat.StagedStrip.DetailSheet.SendNow"
    ) {
      await onDispatchInline?()
    }
  }

  private var sendNowUnavailableReason: String? {
    if !capability.modes.contains(.inline) {
      return "\(capability.agentLabel) can't take a message mid-turn."
    }
    if onDispatchInline == nil { return "Not available on this session." }
    if !turnActive { return "No turn is running." }
    return nil
  }

  private var interruptRow: some View {
    optionRow(
      systemImage: "bolt.fill",
      tint: ADEColor.warning,
      title: capability.interruptContinues ? "Interrupt & continue" : "Interrupt & send",
      description: capability.interruptContinues
        ? "Stop the current \(capability.agentLabel) turn and continue with this message."
        : "Stop \(capability.agentLabel) now and redirect it to this message.",
      unavailableReason: interruptUnavailableReason,
      identifier: "Work.Chat.StagedStrip.DetailSheet.Interrupt"
    ) {
      await onDispatchInterrupt?()
    }
  }

  private var interruptUnavailableReason: String? {
    if !capability.modes.contains(.interrupt) {
      return "\(capability.agentLabel) can't be interrupted with a message."
    }
    if onDispatchInterrupt == nil { return "Not available on this session." }
    if !turnActive { return "No turn is running." }
    return nil
  }

  private var editRow: some View {
    optionRow(
      systemImage: "pencil",
      tint: ADEColor.textSecondary,
      title: "Edit",
      description: "Change the text before it sends.",
      unavailableReason: nil,
      identifier: "Work.Chat.StagedStrip.DetailSheet.Edit"
    ) {
      onBeginEdit()
    }
  }

  private var cancelRow: some View {
    optionRow(
      systemImage: "xmark",
      tint: ADEColor.danger,
      title: "Cancel",
      description: "Remove it from the queue. The turn keeps running.",
      unavailableReason: nil,
      identifier: "Work.Chat.StagedStrip.DetailSheet.Cancel"
    ) {
      await onCancel()
    }
  }

  /// Full-width row: title, one line of description, and — when the provider
  /// cannot do it — the reason in place of that line, disabled rather than
  /// hidden so the option set reads the same on every provider.
  @ViewBuilder
  private func optionRow(
    systemImage: String,
    tint: Color,
    title: String,
    description: String,
    unavailableReason: String?,
    identifier: String,
    action: @escaping @MainActor () async -> Void
  ) -> some View {
    let disabled = unavailableReason != nil || !controlsEnabled
    Button {
      Task {
        actionInFlight = true
        await action()
        actionInFlight = false
        dismiss()
      }
    } label: {
      HStack(alignment: .top, spacing: 10) {
        Image(systemName: systemImage)
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(tint)
          .frame(width: 20, height: 20)
        VStack(alignment: .leading, spacing: 2) {
          Text(title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text(unavailableReason ?? description)
            .font(.caption)
            .foregroundStyle(ADEColor.textMuted)
            .fixedSize(horizontal: false, vertical: true)
        }
        Spacer(minLength: 0)
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 10)
      .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
      .background(ADEColor.raisedBackground, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .stroke(ADEColor.glassBorder, lineWidth: 0.5)
      )
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(disabled)
    .opacity(disabled ? 0.5 : 1)
    .accessibilityIdentifier(identifier)
    .accessibilityHint(unavailableReason ?? description)
  }
}
