import SwiftUI
import UIKit
import AVKit

struct WorkSessionUsageSummaryCard: View {
  let summary: WorkUsageSummary

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        Text("Session usage")
          .font(.headline)
          .foregroundStyle(ADEColor.textPrimary)
        Spacer()
        Text(summary.turnCount == 1 ? "1 completed turn" : "\(summary.turnCount) completed turns")
          .font(.caption)
          .foregroundStyle(ADEColor.textMuted)
      }

      HStack(spacing: 12) {
        usageMetric(title: "Input", value: formattedTokenCount(summary.inputTokens))
        usageMetric(title: "Output", value: formattedTokenCount(summary.outputTokens))
        usageMetric(title: "Cache read", value: formattedTokenCount(summary.cacheReadTokens))
        usageMetric(title: "Cache write", value: formattedTokenCount(summary.cacheCreationTokens))
      }

      HStack {
        Text("Estimated cost")
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textSecondary)
        Spacer()
        Text(summary.costUsd > 0 ? String(format: "$%.4f", summary.costUsd) : "$0.0000")
          .font(.caption.monospacedDigit())
          .foregroundStyle(ADEColor.textPrimary)
      }
    }
    .adeGlassCard(cornerRadius: 18, padding: 14)
  }

  func usageMetric(title: String, value: String) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(title)
        .font(.caption2.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
      Text(value)
        .font(.caption.monospacedDigit())
        .foregroundStyle(ADEColor.textPrimary)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

struct WorkSessionControlBar: View {
  let status: String
  let actionInFlight: Bool
  let onInterrupt: @MainActor () async -> Void
  let onResume: @MainActor () async -> Void
  let onDispose: @MainActor () async -> Void

  var body: some View {
    HStack(spacing: 10) {
      if status == "active" {
        Button("Interrupt") {
          Task { await onInterrupt() }
        }
        .buttonStyle(.glass)
        .tint(ADEColor.warning)
        .disabled(actionInFlight)
      } else if status == "idle" || status == "ended" {
        Button(status == "ended" ? "Resume chat" : "Resume") {
          Task { await onResume() }
        }
        .buttonStyle(.glass)
        .tint(ADEColor.accent)
        .disabled(actionInFlight)
      }

      Spacer(minLength: 0)

      Button(status == "ended" ? "Close session" : "End chat") {
        Task { await onDispose() }
      }
      .buttonStyle(.glassProminent)
      .tint(status == "ended" ? ADEColor.textSecondary : ADEColor.danger)
      .disabled(actionInFlight)
    }
    .padding(14)
    .background(ADEColor.surfaceBackground.opacity(0.6), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
  }
}

struct WorkComposerInputBanner: View {
  let title: String
  let message: String
  let icon: String
  let tint: Color

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: icon)
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(tint)
        .frame(width: 24, height: 24)
        .background(tint.opacity(0.12), in: Circle())

      VStack(alignment: .leading, spacing: 3) {
        Text(title)
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Text(message)
          .font(.caption2)
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(2)
      }

      Spacer(minLength: 0)
    }
    .padding(10)
    .background(tint.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .stroke(tint.opacity(0.18), lineWidth: 0.8)
    )
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(title). \(message)")
  }
}

struct WorkComposerChipStrip: View {
  let chatSummary: AgentChatSessionSummary?
  let queuedSteerCount: Int
  let pendingInputCount: Int
  let onOpenSettings: (() -> Void)?

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        if let chatSummary {
          chip(
            icon: providerIcon(chatSummary.provider),
            label: chatSummary.model,
            tint: providerTint(chatSummary.provider)
          )
          if let runtime = runtimeLabel(for: chatSummary) {
            chip(icon: "shield.lefthalf.filled", label: runtime, tint: ADEColor.accent)
          }
          if let profile = chatSummary.sessionProfile, !profile.isEmpty {
            chip(icon: "slider.horizontal.3", label: profile, tint: ADEColor.textSecondary)
          }
        }

        if queuedSteerCount > 0 {
          chip(icon: "paperplane.circle", label: "\(queuedSteerCount) queued", tint: ADEColor.accent)
        }
        if pendingInputCount > 0 {
          chip(icon: "hand.raised.circle", label: "\(pendingInputCount) waiting", tint: ADEColor.warning)
        }
      }
      .padding(.horizontal, 2)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  func chip(icon: String, label: String, tint: Color) -> some View {
    Button {
      onOpenSettings?()
    } label: {
      HStack(spacing: 6) {
        Image(systemName: icon)
          .font(.caption2.weight(.semibold))
        Text(label)
          .font(.caption2.weight(.semibold))
          .lineLimit(1)
      }
      .foregroundStyle(tint)
      .padding(.horizontal, 10)
      .padding(.vertical, 5)
      .background(tint.opacity(0.1), in: Capsule(style: .continuous))
      .overlay(
        Capsule(style: .continuous)
          .stroke(tint.opacity(0.18), lineWidth: 0.6)
      )
    }
    .buttonStyle(.plain)
    .disabled(onOpenSettings == nil)
    .accessibilityLabel("\(label). Open chat settings")
  }

  func runtimeLabel(for summary: AgentChatSessionSummary) -> String? {
    let normalizedProvider = summary.provider.lowercased()
    switch normalizedProvider {
    case "claude":
      return summary.claudePermissionMode ?? summary.permissionMode
    case "codex":
      if let policy = summary.codexApprovalPolicy, let sandbox = summary.codexSandbox {
        return "\(policy) · \(sandbox)"
      }
      return summary.codexApprovalPolicy ?? summary.codexSandbox
    case "opencode":
      return summary.opencodePermissionMode ?? summary.permissionMode
    default:
      return summary.permissionMode ?? summary.executionMode
    }
  }
}

struct WorkQueuedSteerStrip: View {
  let steers: [WorkPendingSteerModel]
  @Binding var drafts: [String: String]
  let busy: Bool
  let isLive: Bool
  let onCancel: @MainActor (String) async -> Void
  let onSaveEdit: @MainActor (String, String) async -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 6) {
        Image(systemName: "paperplane.circle")
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.accent)
        Text(steers.count == 1 ? "1 queued message" : "\(steers.count) queued messages")
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textSecondary)
        Spacer(minLength: 0)
      }

      VStack(spacing: 6) {
        ForEach(steers) { steer in
          WorkQueuedSteerRow(
            steer: steer,
            draft: Binding(
              get: { drafts[steer.id] ?? steer.text },
              set: { drafts[steer.id] = $0 }
            ),
            isEditing: drafts[steer.id] != nil,
            busy: busy,
            isLive: isLive,
            onBeginEdit: { drafts[steer.id] = steer.text },
            onCancelEdit: { drafts.removeValue(forKey: steer.id) },
            onCancel: { await onCancel(steer.id) },
            onSave: { text in await onSaveEdit(steer.id, text) }
          )
        }
      }
    }
    .padding(10)
    .background(ADEColor.accent.opacity(0.06), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .stroke(ADEColor.accent.opacity(0.18), lineWidth: 0.8)
    )
  }
}

struct WorkQueuedSteerRow: View {
  let steer: WorkPendingSteerModel
  @Binding var draft: String
  let isEditing: Bool
  let busy: Bool
  let isLive: Bool
  let onBeginEdit: () -> Void
  let onCancelEdit: () -> Void
  let onCancel: @MainActor () async -> Void
  let onSave: @MainActor (String) async -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if isEditing {
        TextField("Queued message", text: $draft, axis: .vertical)
          .lineLimit(1...5)
          .adeInsetField(cornerRadius: 12, padding: 10)
          .disabled(busy || !isLive)

        HStack(spacing: 8) {
          Spacer(minLength: 0)
          Button("Cancel edit", action: onCancelEdit)
            .buttonStyle(.glass)
            .tint(ADEColor.textSecondary)
            .controlSize(.small)
            .disabled(busy)

          Button("Save") {
            let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return }
            Task { await onSave(trimmed) }
          }
          .buttonStyle(.glassProminent)
          .tint(ADEColor.accent)
          .controlSize(.small)
          .disabled(busy || !isLive || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
      } else {
        Text(steer.text)
          .font(.caption)
          .foregroundStyle(ADEColor.textPrimary)
          .frame(maxWidth: .infinity, alignment: .leading)

        HStack(spacing: 8) {
          Text(relativeTimestamp(steer.timestamp))
            .font(.caption2)
            .foregroundStyle(ADEColor.textMuted)
          Spacer(minLength: 0)
          Button {
            onBeginEdit()
          } label: {
            Label("Edit", systemImage: "pencil")
              .labelStyle(.titleAndIcon)
              .font(.caption2.weight(.semibold))
          }
          .buttonStyle(.glass)
          .tint(ADEColor.accent)
          .controlSize(.mini)
          .disabled(busy || !isLive)

          Button(role: .destructive) {
            Task { await onCancel() }
          } label: {
            Label("Cancel", systemImage: "xmark")
              .labelStyle(.titleAndIcon)
              .font(.caption2.weight(.semibold))
          }
          .buttonStyle(.glass)
          .tint(ADEColor.danger)
          .controlSize(.mini)
          .disabled(busy || !isLive)
        }
      }
    }
    .padding(10)
    .background(ADEColor.surfaceBackground.opacity(0.55), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Queued message: \(steer.text)")
  }
}

struct WorkApprovalRequestCard: View {
  let approval: WorkPendingApprovalModel
  let busy: Bool
  let onDecision: @MainActor (AgentChatApprovalDecision) async -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Approval needed")
        .font(.headline)
        .foregroundStyle(ADEColor.textPrimary)

      Text(approval.description)
        .font(.subheadline)
        .foregroundStyle(ADEColor.textSecondary)

      if let detail = approval.detail, !detail.isEmpty {
        WorkStructuredOutputBlock(title: "Details", text: detail)
      }

      HStack(spacing: 10) {
        Button("Approve") {
          Task { await onDecision(.accept) }
        }
        .buttonStyle(.glassProminent)
        .tint(ADEColor.success)
        .disabled(busy)

        Button("Approve for session") {
          Task { await onDecision(.acceptForSession) }
        }
        .buttonStyle(.glass)
        .tint(ADEColor.accent)
        .disabled(busy)

        Button("Deny") {
          Task { await onDecision(.decline) }
        }
        .buttonStyle(.glass)
        .tint(ADEColor.danger)
        .disabled(busy)
      }
    }
    .adeGlassCard(cornerRadius: 18, padding: 14)
  }
}

struct WorkStructuredQuestionCard: View {
  let question: WorkPendingQuestionModel
  @Binding var responseText: String
  let busy: Bool
  let onSelectOption: @MainActor (String) async -> Void
  let onSubmitFreeform: @MainActor () async -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Question")
        .font(.headline)
        .foregroundStyle(ADEColor.textPrimary)

      Text(question.question)
        .font(.subheadline)
        .foregroundStyle(ADEColor.textSecondary)

      if !question.options.isEmpty {
        VStack(alignment: .leading, spacing: 8) {
          ForEach(question.options, id: \.self) { option in
            Button(option) {
              Task { await onSelectOption(option) }
            }
            .buttonStyle(.glass)
            .tint(ADEColor.accent)
            .disabled(busy)
          }
        }
      }

      HStack(alignment: .bottom, spacing: 10) {
        TextField("Optional response", text: $responseText, axis: .vertical)
          .lineLimit(1...4)
          .adeInsetField(cornerRadius: 14, padding: 12)
          .disabled(busy)

        Button("Send") {
          Task { await onSubmitFreeform() }
        }
        .buttonStyle(.glassProminent)
        .tint(ADEColor.accent)
        .disabled(busy || responseText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
    }
    .adeGlassCard(cornerRadius: 18, padding: 14)
  }
}
