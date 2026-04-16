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
  let onOpenSettings: (() -> Void)?

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
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 12) {
        WorkProviderLogo(
          provider: chatSummary?.provider,
          fallbackSymbol: providerIcon(chatSummary?.provider ?? ""),
          tint: providerTint(chatSummary?.provider),
          size: 36
        )

        VStack(alignment: .leading, spacing: 4) {
          Text(chatSummary?.title ?? session.title)
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(2)
          Text(metaLine)
            .font(.caption.monospacedDigit())
            .foregroundStyle(ADEColor.textMuted)
        }

        Spacer(minLength: 8)

        HStack(spacing: 8) {
          if let onOpenLane {
            Button(action: onOpenLane) {
              Image(systemName: "arrow.triangle.branch")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(ADEColor.accent)
                .frame(width: 34, height: 34)
                .background(ADEColor.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Open lane")
          }

          if let onOpenSettings {
            Button(action: onOpenSettings) {
              Image(systemName: "slider.horizontal.3")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(ADEColor.textPrimary)
                .frame(width: 34, height: 34)
                .background(ADEColor.surfaceBackground.opacity(0.6), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Open chat settings")
          }
        }
      }

      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 6) {
          WorkTag(
            text: sessionStatusLabel(session, summary: chatSummary),
            icon: workChatStatusIcon(status),
            tint: workChatStatusTint(status)
          )
          if let chatSummary {
            WorkTag(
              text: providerLabel(chatSummary.provider),
              icon: providerIcon(chatSummary.provider),
              tint: providerTint(chatSummary.provider)
            )
          }
          WorkTag(text: session.laneName, icon: "arrow.triangle.branch", tint: ADEColor.textSecondary)
        }
      }

      if let summaryLine {
        Text(summaryLine)
          .font(.subheadline)
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(3)
      }
    }
    .adeListCard()
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(chatSummary?.title ?? session.title), \(sessionStatusLabel(session, summary: chatSummary)), lane \(session.laneName)")
  }
}

struct WorkChatMessageBubble: View {
  let message: WorkChatMessage

  /// When true, this bubble is the active assistant message in a streaming
  /// turn. Drives the streaming shimmer + accent glow treatment. Defaults to
  /// `false` so existing call sites keep working; the session view sets it
  /// to `true` for the latest assistant message while `sessionStatus == "active"`.
  var isLive: Bool = false

  /// Provider string for the current chat session (e.g. "claude", "codex", "cursor").
  /// Injected via `.environment(\.workChatProvider, ...)` by the session view.
  /// When present and the message is from the assistant, a compact provider chip
  /// renders next to the role label so users know which model wrote the turn.
  @Environment(\.workChatProvider) private var sessionProvider

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    HStack {
      if message.role == "assistant" {
        bubbleContent
        Spacer(minLength: 32)
      } else {
        Spacer(minLength: 32)
        bubbleContent
      }
    }
  }

  var bubbleContent: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        Image(systemName: message.role == "assistant" ? "sparkles" : "person.fill")
          .font(.caption.weight(.semibold))
          .foregroundStyle(message.role == "assistant" ? ADEColor.accent : ADEColor.warning)
        Text(message.role == "assistant" ? "Assistant" : "You")
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textSecondary)
        providerChip
        if let deliveryBadge {
          WorkDeliveryBadge(state: deliveryBadge)
        }
        Spacer(minLength: 8)
        Text(relativeTimestamp(message.timestamp))
          .font(.caption2)
          .foregroundStyle(ADEColor.textMuted)
      }

      WorkMarkdownRenderer(markdown: message.markdown)
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      RoundedRectangle(cornerRadius: 18, style: .continuous)
        .fill(message.role == "assistant" ? ADEColor.accent.opacity(0.08) : ADEColor.surfaceBackground.opacity(0.7))
    )
    .adeStreamingShimmer(isActive: isLive && message.role == "assistant", cornerRadius: 18)
    .contextMenu {
      Button {
        UIPasteboard.general.string = message.markdown
      } label: {
        Label("Copy message", systemImage: "doc.on.doc")
      }
    }
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
      let tint = providerTint(provider)
      HStack(spacing: 4) {
        Image(systemName: providerIcon(provider))
          .font(.system(size: 8, weight: .bold))
        Text(providerLabel(provider))
          .font(.caption2.weight(.semibold))
          .tracking(0.3)
      }
      .foregroundStyle(tint)
      .padding(.horizontal, 6)
      .padding(.vertical, 2)
      .background(tint.opacity(0.12), in: Capsule())
      .overlay(
        Capsule().stroke(tint.opacity(0.22), lineWidth: 0.5)
      )
      .accessibilityLabel("Written by \(providerLabel(provider))")
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
