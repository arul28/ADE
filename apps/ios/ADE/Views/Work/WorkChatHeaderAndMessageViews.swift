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

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 12) {
        Image(systemName: providerIcon(chatSummary?.provider ?? ""))
          .font(.system(size: 20, weight: .semibold))
          .foregroundStyle(providerTint(chatSummary?.provider))
          .frame(width: 34, height: 34)
          .background(providerTint(chatSummary?.provider).opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        VStack(alignment: .leading, spacing: 6) {
          Text(chatSummary?.title ?? session.title)
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
          HStack(spacing: 8) {
            WorkTag(
              text: sessionStatusLabel(session, summary: chatSummary),
              icon: workChatStatusIcon(normalizedWorkChatSessionStatus(session: session, summary: chatSummary)),
              tint: workChatStatusTint(normalizedWorkChatSessionStatus(session: session, summary: chatSummary))
            )
            if let chatSummary {
              WorkTag(text: providerLabel(chatSummary.provider), icon: providerIcon(chatSummary.provider), tint: providerTint(chatSummary.provider))
              WorkTag(text: chatSummary.model, icon: "cpu", tint: ADEColor.textSecondary)
            }
            WorkTag(text: session.laneName, icon: "arrow.triangle.branch", tint: ADEColor.textSecondary)
          }
        }
        Spacer(minLength: 8)
        HStack(spacing: 8) {
          if let onOpenLane {
            Button(action: onOpenLane) {
              Image(systemName: "arrow.triangle.branch")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(ADEColor.accent)
                .frame(width: 36, height: 36)
                .background(ADEColor.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Open lane")
          }

          if let onOpenSettings {
            Button(action: onOpenSettings) {
              Image(systemName: "slider.horizontal.3")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(ADEColor.textPrimary)
                .frame(width: 36, height: 36)
                .background(ADEColor.surfaceBackground.opacity(0.6), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Open chat settings")
          }
        }
      }

      HStack(spacing: 12) {
        metric(title: "Started", value: relativeTimestamp(session.startedAt))
        metric(title: "Duration", value: formattedSessionDuration(startedAt: session.startedAt, endedAt: session.endedAt))
        if let preview = chatSummary?.summary ?? session.summary, !preview.isEmpty {
          metric(title: "Summary", value: preview)
        }
      }
    }
    .adeListCard()
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(chatSummary?.title ?? session.title), \(sessionStatusLabel(session, summary: chatSummary)), lane \(session.laneName)")
  }

  func metric(title: String, value: String) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(title)
        .font(.caption2.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
      Text(value)
        .font(.caption)
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(2)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

struct WorkChatMessageBubble: View {
  let message: WorkChatMessage

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
