import SwiftUI
import UIKit
import AVKit

struct WorkSessionHeader: View {
  let session: TerminalSessionSummary
  let chatSummary: AgentChatSessionSummary?
  // transitionNamespace is retained on the init for caller compatibility but
  // intentionally unused in body: navigationTransition(.zoom(sourceID:)) on
  // the container already interpolates child layouts during the push, so
  // this destination must NOT emit per-element matchedGeometryEffect for
  // work-icon/title/status — the list row is the sole isSource=true view
  // in each matched-geometry group.
  let transitionNamespace: Namespace.ID?
  let onOpenLane: (() -> Void)?

  private var status: String {
    normalizedWorkChatSessionStatus(session: session, summary: chatSummary)
  }

  private var statusTint: Color {
    workChatStatusTint(status)
  }

  private var relativeStartLabel: String {
    relativeTimestamp(session.startedAt)
  }

  var body: some View {
    // Compact toolbar matching the desktop ChatGitToolbar shape: a left-side
    // chip cluster (status dot + lane chip + relative time) and a trailing
    // overflow menu so future Run / Stage & Commit / Push / PR / Terminal /
    // Handoff entry points have a stable home. The standalone "ENDED · …"
    // status row that used to live below the title is gone — composer
    // feedback already conveys the disabled state.
    HStack(spacing: 8) {
      laneChip
      Text(relativeStartLabel)
        .font(.caption.monospacedDigit())
        .foregroundStyle(ADEColor.textMuted)
        .lineLimit(1)
      Spacer(minLength: 0)
      overflowMenu
    }
    .padding(.vertical, 4)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("\(chatSummary?.title ?? session.title), \(sessionStatusLabel(session, summary: chatSummary)), lane \(session.laneName)")
  }

  @ViewBuilder
  private var laneChip: some View {
    Button {
      onOpenLane?()
    } label: {
      HStack(spacing: 6) {
        Circle()
          .fill(statusTint)
          .frame(width: 6, height: 6)
        Image(systemName: "arrow.triangle.branch")
          .font(.caption2.weight(.semibold))
          .foregroundStyle(ADEColor.accent)
        Text(session.laneName)
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
      }
      .padding(.horizontal, 9)
      .padding(.vertical, 5)
      .background(ADEColor.surfaceBackground.opacity(0.55), in: Capsule(style: .continuous))
      .overlay(
        Capsule(style: .continuous)
          .stroke(ADEColor.border.opacity(0.22), lineWidth: 0.6)
      )
    }
    .buttonStyle(.plain)
    .disabled(onOpenLane == nil)
    .accessibilityLabel("Lane \(session.laneName). Tap to open.")
  }

  @ViewBuilder
  private var overflowMenu: some View {
    // Single-entry menu today — the lane action set (Run / Stage & Commit /
    // Push / PR / Terminal / Handoff) needs callbacks the iOS chat view
    // doesn't yet thread through. Slot for them here when they land so the
    // header layout stays stable.
    Menu {
      if let onOpenLane {
        Button {
          onOpenLane()
        } label: {
          Label("Open lane", systemImage: "arrow.triangle.branch")
        }
      }
    } label: {
      Image(systemName: "ellipsis")
        .font(.system(size: 14, weight: .semibold))
        .foregroundStyle(ADEColor.textSecondary)
        .frame(width: 28, height: 28)
        .background(ADEColor.surfaceBackground.opacity(0.55), in: Circle())
        .overlay(
          Circle()
            .stroke(ADEColor.border.opacity(0.22), lineWidth: 0.6)
        )
    }
    .menuStyle(.borderlessButton)
    .accessibilityLabel("More lane actions")
    .disabled(onOpenLane == nil)
  }
}

/// Desktop-shaped message row.
///
/// Assistant messages live inside a dark rounded card with only a small
/// model-badge chip above (no name, no per-message timestamp — that goes into
/// the centered turn separator). User messages stay right-aligned but size to
/// their content so short replies don't look like banner ads, and they drop
/// the per-message timestamp for the same reason.
struct WorkChatMessageBubble: View {
  let message: WorkChatMessage

  /// When true, this row is the active assistant message in a streaming turn.
  /// Drives the subtle streaming shimmer treatment. Defaults to `false` so
  /// existing call sites keep working; the session view sets it to `true`
  /// for the latest assistant message while `sessionStatus == "active"`.
  var isLive: Bool = false

  /// Provider string for the current chat session (e.g. "claude", "codex", "cursor").
  /// Injected via `.environment(\.workChatProvider, ...)` by the session view.
  @Environment(\.workChatProvider) private var sessionProvider
  /// Active session model id, used to resolve the per-model accent for the
  /// model badge chip and card border tint.
  @Environment(\.workChatModelId) private var sessionModelId
  /// Pretty model label ("Claude Sonnet 4.6"), injected by the session view
  /// so each bubble doesn't have to recompute the same string.
  @Environment(\.workChatModelLabel) private var sessionModelLabel

  var body: some View {
    if message.role == "assistant" {
      assistantRow
    } else {
      userRow
    }
  }

  private var accent: Color {
    ADEColor.chatSurfaceAccent(modelId: sessionModelId, provider: sessionProvider)
  }

  private var assistantRow: some View {
    // Model name intentionally absent here. The turn separator above each user
    // message already labels the active model; repeating it over every
    // assistant response clutters the transcript.
    WorkMarkdownRenderer(markdown: message.markdown)
      .padding(.horizontal, 14)
      .padding(.vertical, 12)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(ADEColor.cardBackground.opacity(0.55), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 14, style: .continuous)
          .stroke(accent.opacity(0.16), lineWidth: 0.6)
      )
      .frame(maxWidth: .infinity, alignment: .leading)
      .adeStreamingShimmer(isActive: isLive, cornerRadius: 14)
    .contextMenu {
      Button {
        UIPasteboard.general.string = message.markdown
      } label: {
        Label("Copy message", systemImage: "doc.on.doc")
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Assistant message. \(message.markdown)")
  }

  private var userRow: some View {
    HStack(alignment: .top, spacing: 8) {
      Spacer(minLength: 32)
      VStack(alignment: .trailing, spacing: 4) {
        if let deliveryBadge {
          // Delivery badges only render when a non-default state applies
          // (queued/sending/failed). Successful deliveries stay silent.
          WorkDeliveryBadge(state: deliveryBadge)
        }
        WorkMarkdownRenderer(markdown: message.markdown)
          .padding(.horizontal, 12)
          .padding(.vertical, 8)
          .background(ADEColor.accentDeep.opacity(0.22), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
          .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
              .stroke(ADEColor.accent.opacity(0.30), lineWidth: 0.5)
          )
          // Cap the bubble at ~78% of available width so short messages stay
          // compact but long ones still wrap rather than clipping.
          .frame(maxWidth: 320, alignment: .trailing)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .contextMenu {
      Button {
        UIPasteboard.general.string = message.markdown
      } label: {
        Label("Copy message", systemImage: "doc.on.doc")
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Your message. \(message.markdown)")
  }

  var deliveryBadge: WorkDeliveryBadge.State? {
    guard message.role == "user" else { return nil }
    if let state = message.deliveryState {
      switch state {
      case "queued": return .queued
      case "delivered":
        return message.processed == true ? nil : .delivered
      case "failed": return .failed
      case "sending": return .sending
      default: return nil
      }
    }
    return nil
  }

  @ViewBuilder
  private var modelBadge: some View {
    let provider = sessionProvider?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let label = (sessionModelLabel?.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap { $0.isEmpty ? nil : $0 }
      ?? (provider.isEmpty ? nil : providerLabel(provider))
    if let label, !label.isEmpty {
      HStack(spacing: 5) {
        Circle()
          .fill(accent)
          .frame(width: 6, height: 6)
        Text(label)
          .font(.caption2.weight(.semibold))
          .foregroundStyle(accent)
          .lineLimit(1)
      }
      .padding(.horizontal, 7)
      .padding(.vertical, 2)
      .background(accent.opacity(0.10), in: Capsule(style: .continuous))
      .overlay(
        Capsule(style: .continuous)
          .stroke(accent.opacity(0.22), lineWidth: 0.5)
      )
      .accessibilityLabel("Written by \(label)")
    }
  }
}

/// Centered "11:34 AM · Claude Sonnet 4.6" pill that introduces each turn,
/// matching desktop's transcript separator. Pulled into a dedicated view so
/// timeline rendering can switch on `WorkTimelinePayload.turnSeparator` and
/// drop in a single component.
struct WorkTurnSeparatorView: View {
  let separator: WorkTurnSeparator

  var body: some View {
    let accent = ADEColor.chatSurfaceAccent(modelId: separator.modelId, provider: separator.provider)
    HStack(spacing: 8) {
      Spacer(minLength: 0)
      Text(workTurnSeparatorTimeLabel(separator.time))
        .font(.caption2.monospacedDigit())
        .foregroundStyle(ADEColor.textMuted)
      if !separator.modelLabel.isEmpty {
        HStack(spacing: 5) {
          Circle()
            .fill(accent)
            .frame(width: 6, height: 6)
          Text(separator.modelLabel)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(accent)
            .lineLimit(1)
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 2)
        .background(accent.opacity(0.10), in: Capsule(style: .continuous))
        .overlay(
          Capsule(style: .continuous)
            .stroke(accent.opacity(0.22), lineWidth: 0.5)
        )
      }
      Spacer(minLength: 0)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 4)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("New turn at \(workTurnSeparatorTimeLabel(separator.time))" + (separator.modelLabel.isEmpty ? "" : ", model \(separator.modelLabel)"))
  }
}

private func workTurnSeparatorTimeLabel(_ iso: String) -> String {
  // Matches desktop's "01:34 AM" turn separator format. Falls back to the raw
  // string when the input isn't an ISO date so we never crash on host quirks.
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  if let date = formatter.date(from: iso) {
    return shortClockFormatter.string(from: date)
  }
  formatter.formatOptions = [.withInternetDateTime]
  if let date = formatter.date(from: iso) {
    return shortClockFormatter.string(from: date)
  }
  return iso
}

private let shortClockFormatter: DateFormatter = {
  let f = DateFormatter()
  f.dateFormat = "hh:mm a"
  f.amSymbol = "AM"
  f.pmSymbol = "PM"
  return f
}()

/// Environment injection for the active chat session's provider/model context.
/// The session view wraps the transcript in `.environment(\.workChatProvider, …)`,
/// `.workChatModelId`, and `.workChatModelLabel` so message bubbles can render
/// the model badge tinted to the chat's accent without threading the values
/// through each call site.
private struct WorkChatProviderEnvironmentKey: EnvironmentKey {
  static let defaultValue: String? = nil
}

private struct WorkChatModelIdEnvironmentKey: EnvironmentKey {
  static let defaultValue: String? = nil
}

private struct WorkChatModelLabelEnvironmentKey: EnvironmentKey {
  static let defaultValue: String? = nil
}

extension EnvironmentValues {
  var workChatProvider: String? {
    get { self[WorkChatProviderEnvironmentKey.self] }
    set { self[WorkChatProviderEnvironmentKey.self] = newValue }
  }

  var workChatModelId: String? {
    get { self[WorkChatModelIdEnvironmentKey.self] }
    set { self[WorkChatModelIdEnvironmentKey.self] = newValue }
  }

  var workChatModelLabel: String? {
    get { self[WorkChatModelLabelEnvironmentKey.self] }
    set { self[WorkChatModelLabelEnvironmentKey.self] = newValue }
  }
}

struct WorkDeliveryBadge: View {
  enum State {
    case queued, sending, delivered, failed

    var label: String {
      switch self {
      case .queued: return "Queued"
      case .sending: return "Sending"
      case .delivered: return "Delivered"
      case .failed: return "Failed"
      }
    }

    var icon: String {
      switch self {
      case .queued: return "clock"
      case .sending: return "arrow.up.circle"
      case .delivered: return "checkmark.circle"
      case .failed: return "exclamationmark.triangle"
      }
    }

    var tint: Color {
      switch self {
      case .queued: return ADEColor.accent
      case .sending: return ADEColor.accent
      case .delivered: return ADEColor.success
      case .failed: return ADEColor.danger
      }
    }
  }

  let state: State

  var body: some View {
    HStack(spacing: 4) {
      Image(systemName: state.icon)
      Text(state.label)
    }
    .font(.caption2.weight(.semibold))
    .foregroundStyle(state.tint)
    .padding(.horizontal, 6)
    .padding(.vertical, 2)
    .background(state.tint.opacity(0.12), in: Capsule(style: .continuous))
    .accessibilityLabel("Delivery state: \(state.label)")
  }
}
