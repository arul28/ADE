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
      switch status {
      case "active":
        // Running turn — primary action is stopping it. End chat is a
        // secondary escape hatch.
        Button {
          Task { await onInterrupt() }
        } label: {
          Label("Interrupt", systemImage: "stop.fill")
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.glassProminent)
        .tint(ADEColor.warning)
        .disabled(actionInFlight)

        Button("End") {
          Task { await onDispose() }
        }
        .buttonStyle(.glass)
        .tint(ADEColor.textSecondary)
        .disabled(actionInFlight)

      case "idle", "awaiting-input":
        Button {
          Task { await onResume() }
        } label: {
          Label("Resume", systemImage: "play.fill")
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.glassProminent)
        .tint(ADEColor.accent)
        .disabled(actionInFlight)

        Button("End") {
          Task { await onDispose() }
        }
        .buttonStyle(.glass)
        .tint(ADEColor.textSecondary)
        .disabled(actionInFlight)

      default:
        // Ended — only a single primary CTA matters. "Close session" on an
        // already-closed session was nonsense.
        Button {
          Task { await onResume() }
        } label: {
          Label("Resume chat", systemImage: "play.fill")
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.glassProminent)
        .tint(ADEColor.accent)
        .disabled(actionInFlight)
      }
    }
    .controlSize(.large)
    .padding(12)
    .background(ADEColor.surfaceBackground.opacity(0.55), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
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

/// Compact horizontal strip matching the desktop composer toolbar: small
/// single-line pills for access / model / reasoning, queued/pending status
/// chips, and nothing else. The access pill is a SwiftUI `Menu` so runtime
/// modes flip inline — no extra "session settings" sheet to wade through.
struct WorkComposerChipStrip: View {
  let chatSummary: AgentChatSessionSummary?
  let queuedSteerCount: Int
  let pendingInputCount: Int
  let onOpenModelPicker: (() -> Void)?
  let onSelectRuntimeMode: ((String) -> Void)?

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 6) {
        if let chatSummary {
          accessPill(summary: chatSummary)
          modelPill(summary: chatSummary)
        }

        if queuedSteerCount > 0 {
          statusChip(icon: "paperplane.circle.fill", label: "\(queuedSteerCount) queued", tint: ADEColor.accent)
        }
        if pendingInputCount > 0 {
          statusChip(icon: "hand.raised.circle.fill", label: "\(pendingInputCount) waiting", tint: ADEColor.warning)
        }
      }
      .padding(.horizontal, 2)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  @ViewBuilder
  private func modelPill(summary: AgentChatSessionSummary) -> some View {
    Button {
      onOpenModelPicker?()
    } label: {
      HStack(spacing: 6) {
        WorkProviderLogo(
          provider: summary.provider,
          fallbackSymbol: providerIcon(summary.provider),
          tint: providerTint(summary.provider),
          size: 16
        )
        Text(prettyModelName(summary.model))
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
        Image(systemName: "chevron.down")
          .font(.system(size: 9, weight: .bold))
          .foregroundStyle(ADEColor.textMuted)
      }
      .padding(.horizontal, 9)
      .padding(.vertical, 6)
      .background(ADEColor.surfaceBackground.opacity(0.7), in: Capsule(style: .continuous))
      .overlay(
        Capsule(style: .continuous)
          .stroke(ADEColor.border.opacity(0.28), lineWidth: 0.6)
      )
    }
    .buttonStyle(.plain)
    .disabled(onOpenModelPicker == nil)
    .accessibilityLabel("Model: \(summary.model). Tap to switch.")
  }

  @ViewBuilder
  private func accessPill(summary: AgentChatSessionSummary) -> some View {
    let options = runtimeMenuOptions(for: summary)
    let currentMode = workInitialRuntimeMode(summary)
    let label = runtimeDisplayLabel(summary: summary, currentMode: currentMode)
    let tint = runtimeTint(currentMode)

    if options.isEmpty || onSelectRuntimeMode == nil {
      pillContent(dotColor: tint, label: label, showChevron: false)
    } else {
      Menu {
        ForEach(options, id: \.id) { option in
          Button {
            onSelectRuntimeMode?(option.id)
          } label: {
            if option.id == currentMode {
              Label(option.title, systemImage: "checkmark")
            } else {
              Text(option.title)
            }
          }
        }
      } label: {
        pillContent(dotColor: tint, label: label, showChevron: true)
      }
      .menuStyle(.borderlessButton)
      .buttonStyle(.plain)
      .accessibilityLabel("Access mode: \(label). Tap to change.")
    }
  }

  @ViewBuilder
  private func pillContent(dotColor: Color, label: String, showChevron: Bool) -> some View {
    HStack(spacing: 6) {
      Circle()
        .fill(dotColor)
        .frame(width: 6, height: 6)
      Text(label)
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)
      if showChevron {
        Image(systemName: "chevron.down")
          .font(.system(size: 9, weight: .bold))
          .foregroundStyle(ADEColor.textMuted)
      }
    }
    .padding(.horizontal, 9)
    .padding(.vertical, 6)
    .background(dotColor.opacity(0.12), in: Capsule(style: .continuous))
    .overlay(
      Capsule(style: .continuous)
        .stroke(dotColor.opacity(0.35), lineWidth: 0.6)
    )
  }

  @ViewBuilder
  private func statusChip(icon: String, label: String, tint: Color) -> some View {
    HStack(spacing: 5) {
      Image(systemName: icon)
        .font(.caption2.weight(.semibold))
      Text(label)
        .font(.caption.weight(.semibold))
        .lineLimit(1)
    }
    .foregroundStyle(tint)
    .padding(.horizontal, 9)
    .padding(.vertical, 6)
    .background(tint.opacity(0.1), in: Capsule(style: .continuous))
    .overlay(
      Capsule(style: .continuous)
        .stroke(tint.opacity(0.22), lineWidth: 0.5)
    )
  }

  private func prettyModelName(_ model: String) -> String {
    // Strip marketing prefixes so the pill stays on one compact line —
    // "claude-opus-4-6" → "Opus 4.6", "gpt-5-codex" → "GPT-5 Codex".
    let trimmed = model.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return "Model" }
    if trimmed.lowercased().hasPrefix("claude-") {
      let tail = trimmed.dropFirst("claude-".count)
      return beautifyModelSegment(String(tail))
    }
    return beautifyModelSegment(trimmed)
  }

  private func beautifyModelSegment(_ raw: String) -> String {
    raw
      .split(separator: "-")
      .map { part -> String in
        let s = String(part)
        if s.range(of: #"^\d+$"#, options: .regularExpression) != nil {
          return s
        }
        if s.lowercased() == "gpt" { return "GPT" }
        return s.prefix(1).uppercased() + s.dropFirst()
      }
      .joined(separator: " ")
      .replacingOccurrences(of: #"(\d+) (\d+)"#, with: "$1.$2", options: .regularExpression)
  }

  private struct RuntimeMenuOption {
    let id: String
    let title: String
  }

  private func runtimeMenuOptions(for summary: AgentChatSessionSummary) -> [RuntimeMenuOption] {
    switch summary.provider.lowercased() {
    case "claude":
      return [
        RuntimeMenuOption(id: "default", title: "Default"),
        RuntimeMenuOption(id: "plan", title: "Plan"),
        RuntimeMenuOption(id: "edit", title: "Accept edits"),
        RuntimeMenuOption(id: "full-auto", title: "Bypass permissions"),
      ]
    case "codex":
      return [
        RuntimeMenuOption(id: "default", title: "Default"),
        RuntimeMenuOption(id: "plan", title: "Plan"),
        RuntimeMenuOption(id: "edit", title: "On-failure approvals"),
        RuntimeMenuOption(id: "full-auto", title: "Full auto"),
      ]
    case "opencode":
      return [
        RuntimeMenuOption(id: "plan", title: "Plan"),
        RuntimeMenuOption(id: "edit", title: "Edit"),
        RuntimeMenuOption(id: "full-auto", title: "Full auto"),
      ]
    default:
      return []
    }
  }

  private func runtimeDisplayLabel(summary: AgentChatSessionSummary, currentMode: String) -> String {
    switch summary.provider.lowercased() {
    case "claude":
      switch currentMode {
      case "plan": return "Plan"
      case "edit": return "Accept edits"
      case "full-auto": return "Bypass permissions"
      default: return "Default"
      }
    case "codex":
      switch currentMode {
      case "plan": return "Plan"
      case "edit": return "On-failure"
      case "full-auto": return "Full auto"
      default: return "Default"
      }
    case "opencode":
      return currentMode.isEmpty ? "Edit" : currentMode.capitalized
    default:
      return summary.permissionMode?.capitalized ?? summary.executionMode?.capitalized ?? "Access"
    }
  }

  private func runtimeTint(_ mode: String) -> Color {
    switch mode {
    case "full-auto": return ADEColor.danger
    case "edit": return ADEColor.warning
    case "plan": return ADEColor.accent
    default: return ADEColor.textSecondary
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

  // Collapsed by default: with long turns users can have 3-5 queued items
  // and the composer area is the most vertical-space-constrained region
  // on iPhone. Users open the strip only when they need to edit/cancel.
  @State private var isExpanded: Bool = false
  // Cancel haptic token: bumped each time a row's cancel lands so the
  // whole strip can drive a single sensoryFeedback modifier.
  @State private var cancelHapticToken: Int = 0
  // Always expand while any row is actively being edited so edits aren't
  // hidden behind a collapse tap.
  private var anyEditing: Bool {
    steers.contains(where: { drafts[$0.id] != nil })
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      header

      if isExpanded || anyEditing {
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
              onCancel: {
                cancelHapticToken &+= 1
                await onCancel(steer.id)
              },
              onSave: { text in await onSaveEdit(steer.id, text) }
            )
          }
        }
        .transition(.opacity.combined(with: .move(edge: .top)))
      }
    }
    .padding(10)
    .background(ADEColor.accent.opacity(0.06), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .stroke(ADEColor.accent.opacity(0.18), lineWidth: 0.8)
    )
    .sensoryFeedback(.impact(weight: .light), trigger: cancelHapticToken)
    .animation(.smooth(duration: 0.22), value: isExpanded)
    .animation(.smooth(duration: 0.22), value: anyEditing)
  }

  private var header: some View {
    Button {
      withAnimation(.smooth(duration: 0.22)) {
        isExpanded.toggle()
      }
    } label: {
      HStack(spacing: 6) {
        Image(systemName: "paperplane.circle")
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.accent)
        Text(steers.count == 1 ? "1 queued" : "\(steers.count) queued")
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textSecondary)
        if !isExpanded && !anyEditing, let preview = steers.first?.text {
          Text("·")
            .font(.caption2)
            .foregroundStyle(ADEColor.textMuted)
          Text(preview)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(1)
            .truncationMode(.tail)
        }
        Spacer(minLength: 4)
        Image(systemName: isExpanded || anyEditing ? "chevron.up" : "chevron.down")
          .font(.caption2.weight(.semibold))
          .foregroundStyle(ADEColor.textMuted)
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(steers.count == 1 ? "1 queued message" : "\(steers.count) queued messages")
    .accessibilityHint(isExpanded || anyEditing ? "Collapse queued messages" : "Expand to edit or cancel queued messages")
    .disabled(anyEditing)
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
        // "Queued" ribbon mirrors the desktop PendingSteerItem treatment so
        // users see at a glance that this item hasn't been sent yet.
        HStack(spacing: 6) {
          Text("Queued")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(ADEColor.accent)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(ADEColor.accent.opacity(0.12), in: Capsule())
          Text(relativeTimestamp(steer.timestamp))
            .font(.caption2)
            .foregroundStyle(ADEColor.textMuted)
          Spacer(minLength: 0)
        }

        // Clip the preview at two lines so long queued messages don't blow
        // out the composer. Full text is still reachable via Edit.
        Text(steer.text)
          .font(.caption)
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(2)
          .truncationMode(.tail)
          .frame(maxWidth: .infinity, alignment: .leading)

        HStack(spacing: 8) {
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
