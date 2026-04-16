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

  private var metaLine: String {
    var parts: [String] = [relativeTimestamp(session.startedAt)]
    let status = status
    if status == "active" || status == "idle" || status == "awaiting-input" {
      let duration = formattedSessionDuration(startedAt: session.startedAt, endedAt: session.endedAt)
      if duration != "—" { parts.append(duration) }
    }
    if let chatSummary, !chatSummary.model.isEmpty {
      parts.append(chatSummary.model)
    }
    return parts.joined(separator: " · ")
  }

  private var summaryLine: String? {
    let raw = chatSummary?.summary ?? session.summary ?? ""
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }

  var body: some View {
    // Document-style intro — no card chrome, just a small meta line with
    // lane, status, and model. The navigation title already shows the chat
    // name so we drop the duplicate headline/title block here too.
    HStack(spacing: 6) {
      Circle()
        .fill(workChatStatusTint(status))
        .frame(width: 6, height: 6)
      Text(sessionStatusLabel(session, summary: chatSummary))
        .font(.caption2.weight(.bold))
        .tracking(0.4)
        .foregroundStyle(workChatStatusTint(status))
      Text("·")
        .font(.caption2)
        .foregroundStyle(ADEColor.textMuted)
      Button {
        onOpenLane?()
      } label: {
        HStack(spacing: 3) {
          Image(systemName: "arrow.triangle.branch")
            .font(.caption2.weight(.semibold))
          Text(session.laneName)
            .font(.caption.weight(.semibold))
            .lineLimit(1)
        }
        .foregroundStyle(ADEColor.accent)
      }
      .buttonStyle(.plain)
      .disabled(onOpenLane == nil)
      .accessibilityLabel("Lane \(session.laneName). Tap to open.")
      Text("·")
        .font(.caption2)
        .foregroundStyle(ADEColor.textMuted)
      Text(metaLine)
        .font(.caption.monospacedDigit())
        .foregroundStyle(ADEColor.textMuted)
        .lineLimit(1)
      Spacer(minLength: 0)
    }
    .padding(.vertical, 4)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(chatSummary?.title ?? session.title), \(sessionStatusLabel(session, summary: chatSummary)), lane \(session.laneName)")
  }
}

/// Document-style message row. Desktop renders the transcript like a doc —
/// no card chrome on the assistant side, just a provider chip + prose — so
/// mobile follows suit. User messages stay right-aligned with a very
/// subtle tinted bubble to preserve sender asymmetry, but shed the heavy
/// box the old implementation used.
struct WorkChatMessageBubble: View {
  let message: WorkChatMessage

  /// When true, this row is the active assistant message in a streaming turn.
  /// Drives the subtle streaming shimmer treatment. Defaults to `false` so
  /// existing call sites keep working; the session view sets it to `true`
  /// for the latest assistant message while `sessionStatus == "active"`.
  var isLive: Bool = false

  /// Provider string for the current chat session (e.g. "claude", "codex", "cursor").
  /// Injected via `.environment(\.workChatProvider, ...)` by the session view.
  /// When present and the message is from the assistant, a compact provider chip
  /// renders next to the role label so users know which model wrote the turn.
  @Environment(\.workChatProvider) private var sessionProvider

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    if message.role == "assistant" {
      assistantRow
    } else {
      userRow
    }
  }

  private var assistantRow: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 6) {
        providerChip
        Text(relativeTimestamp(message.timestamp))
          .font(.caption2)
          .foregroundStyle(ADEColor.textMuted)
        Spacer(minLength: 0)
      }
      WorkMarkdownRenderer(markdown: message.markdown)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .adeStreamingShimmer(isActive: isLive, cornerRadius: 10)
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
        HStack(spacing: 6) {
          if let deliveryBadge {
            WorkDeliveryBadge(state: deliveryBadge)
          }
          Text(relativeTimestamp(message.timestamp))
            .font(.caption2)
            .foregroundStyle(ADEColor.textMuted)
        }
        WorkMarkdownRenderer(markdown: message.markdown)
          .padding(.horizontal, 12)
          .padding(.vertical, 8)
          .background(ADEColor.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
          .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
              .stroke(ADEColor.accent.opacity(0.22), lineWidth: 0.5)
          )
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
  private var providerChip: some View {
    if message.role == "assistant",
       let provider = sessionProvider?.trimmingCharacters(in: .whitespacesAndNewlines),
       !provider.isEmpty {
      HStack(spacing: 5) {
        WorkProviderLogo(
          provider: provider,
          fallbackSymbol: providerIcon(provider),
          tint: providerTint(provider),
          size: 14
        )
        Text(providerLabel(provider))
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textSecondary)
      }
      .accessibilityLabel("Written by \(providerLabel(provider))")
    } else if message.role == "user" {
      EmptyView()
    }
  }
}

/// Environment injection for the active chat session's provider string.
/// The session view wraps the transcript in `.environment(\.workChatProvider, provider)`
/// so every message bubble can render a provider chip without threading the
/// value through each call site.
private struct WorkChatProviderEnvironmentKey: EnvironmentKey {
  static let defaultValue: String? = nil
}

extension EnvironmentValues {
  var workChatProvider: String? {
    get { self[WorkChatProviderEnvironmentKey.self] }
    set { self[WorkChatProviderEnvironmentKey.self] = newValue }
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
