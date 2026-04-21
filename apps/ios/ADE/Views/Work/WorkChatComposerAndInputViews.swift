import SwiftUI
import UIKit
import AVKit

struct WorkTurnUsageSummaryBanner: View {
  let summary: WorkUsageSummary
  /// Retained for call-site compatibility; the inline model chip was removed
  /// so model labels only appear in the turn separator and composer pickers.
  /// Kept as optional params in case future rows need provider context.
  var provider: String? = nil
  var modelLabel: String? = nil

  var body: some View {
    HStack(spacing: 8) {
      Text("USAGE")
        .font(.caption2.weight(.bold))
        .tracking(0.6)
        .foregroundStyle(ADEColor.textMuted)

      Spacer(minLength: 4)

      usagePill("In", workAbbreviateCount(summary.inputTokens))
      usagePill("Out", workAbbreviateCount(summary.outputTokens))

      if summary.cacheReadTokens > 0 {
        usagePill("Cache", workAbbreviateCount(summary.cacheReadTokens))
      }
      if summary.cacheCreationTokens > 0 {
        usagePill("New cache", workAbbreviateCount(summary.cacheCreationTokens))
      }

      if summary.costUsd > 0 {
        Text(formatUsageCost(summary.costUsd))
          .font(.caption2.monospacedDigit())
          .foregroundStyle(ADEColor.textSecondary)
      }
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 7)
    .background(ADEColor.surfaceBackground.opacity(0.55), in: Capsule(style: .continuous))
    .overlay(
      Capsule(style: .continuous)
        .stroke(ADEColor.border.opacity(0.28), lineWidth: 0.6)
    )
  }

  private func usagePill(_ label: String, _ value: String) -> some View {
    Text("\(label) \(value)")
      .font(.caption2.monospacedDigit())
      .foregroundStyle(ADEColor.textMuted)
      .lineLimit(1)
  }

  private func formatUsageCost(_ cost: Double) -> String {
    // Mirror desktop: two decimals when above one cent so "$0.06" reads
    // cleanly; fall back to four decimals for sub-cent costs.
    if cost >= 0.01 { return String(format: "$%.2f", cost) }
    return String(format: "$%.4f", cost)
  }
}

/// Abbreviate a token count the way the desktop usage row does: 1100 -> "1.1k",
/// 19,246 -> "19.2k", 1_500_000 -> "1.5M". Counts under 1k stay literal.
func workAbbreviateCount(_ count: Int) -> String {
  let n = Double(count)
  if count < 1_000 { return String(count) }
  if count < 1_000_000 {
    return formatWorkAbbreviation(n / 1_000, suffix: "k")
  }
  if count < 1_000_000_000 {
    return formatWorkAbbreviation(n / 1_000_000, suffix: "M")
  }
  return formatWorkAbbreviation(n / 1_000_000_000, suffix: "B")
}

private func formatWorkAbbreviation(_ value: Double, suffix: String) -> String {
  // Drop trailing ".0" so "1.0k" reads as "1k" while keeping "1.1k", "19.2k".
  let rounded = (value * 10).rounded() / 10
  if rounded.truncatingRemainder(dividingBy: 1) == 0 {
    return "\(Int(rounded))\(suffix)"
  }
  return String(format: "%.1f%@", rounded, suffix)
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
  let onSelectEffort: ((String) -> Void)?

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 6) {
        if let chatSummary {
          accessPill(summary: chatSummary)
          modelPill(summary: chatSummary)
          effortPill(summary: chatSummary)
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

  /// Reasoning-effort chip tuned to the active model. Each model advertises
  /// its own tier set in `ADEColor.reasoningTiers` (mirror of the desktop
  /// registry) — Opus has low/medium/high/max, Sonnet has low/medium/high,
  /// Haiku has no tiers at all, GPT-5.x Codex has low/medium/high/xhigh, etc.
  /// The pill hides entirely when the current model doesn't support tiers so
  /// we never offer a setting the host will reject.
  @ViewBuilder
  private func effortPill(summary: AgentChatSessionSummary) -> some View {
    if let onSelectEffort,
       let tiers = ADEColor.reasoningTiers(for: summary.modelId ?? summary.model),
       !tiers.isEmpty {
      let current = (summary.reasoningEffort ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      // Include the current stored value even if it isn't in the model's
      // advertised set — protects against registry drift so users never get
      // stuck with an un-selectable tier.
      let menuTiers: [String] = {
        if !current.isEmpty && !tiers.contains(where: { $0.lowercased() == current.lowercased() }) {
          return tiers + [current]
        }
        return tiers
      }()
      let label = current.isEmpty ? "Effort" : current.capitalized
      Menu {
        ForEach(menuTiers, id: \.self) { option in
          Button {
            onSelectEffort(option)
          } label: {
            if option.lowercased() == current.lowercased() {
              Label(option.capitalized, systemImage: "checkmark")
            } else {
              Text(option.capitalized)
            }
          }
        }
      } label: {
        HStack(spacing: 6) {
          Image(systemName: "gauge.with.dots.needle.50percent")
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(ADEColor.textMuted)
          Text(label)
            .font(.caption.weight(.semibold))
            .foregroundStyle(current.isEmpty ? ADEColor.textSecondary : ADEColor.textPrimary)
            .lineLimit(1)
          Image(systemName: "chevron.down")
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(ADEColor.textMuted)
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 6)
        .background(ADEColor.raisedBackground.opacity(0.78), in: Capsule(style: .continuous))
        .overlay(
          Capsule(style: .continuous)
            .stroke(ADEColor.glassBorder, lineWidth: 0.6)
        )
      }
      .menuStyle(.borderlessButton)
      .accessibilityLabel(
        current.isEmpty
          ? "Reasoning effort. Tap to choose a tier."
          : "Reasoning effort: \(current.capitalized). Tap to change."
      )
    }
  }

  @ViewBuilder
  private func modelPill(summary: AgentChatSessionSummary) -> some View {
    let reasoning = (summary.reasoningEffort ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
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
        if !reasoning.isEmpty {
          Text("·")
            .font(.caption2)
            .foregroundStyle(ADEColor.textMuted.opacity(0.5))
          Text(reasoning.capitalized)
            .font(.system(size: 10, weight: .medium))
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
        }
        Image(systemName: "chevron.down")
          .font(.system(size: 9, weight: .bold))
          .foregroundStyle(ADEColor.textMuted)
      }
      .padding(.horizontal, 9)
      .padding(.vertical, 6)
      .background(ADEColor.raisedBackground.opacity(0.78), in: Capsule(style: .continuous))
      .overlay(
        Capsule(style: .continuous)
          .stroke(ADEColor.glassBorder, lineWidth: 0.6)
      )
    }
    .buttonStyle(.plain)
    .disabled(onOpenModelPicker == nil)
    .accessibilityLabel("Model: \(summary.model)\(reasoning.isEmpty ? "" : ", reasoning \(reasoning)"). Tap to switch.")
  }

  @ViewBuilder
  private func accessPill(summary: AgentChatSessionSummary) -> some View {
    let options = workRuntimeModeOptions(provider: summary.provider)
    let currentMode = workInitialRuntimeMode(summary)
    let label = workRuntimeModeLabel(provider: summary.provider, mode: currentMode)
    let tint = workRuntimeModeTint(currentMode)

    if options.isEmpty || onSelectRuntimeMode == nil {
      pillContent(dotColor: tint, label: label, showChevron: false)
    } else {
      Menu {
        ForEach(options) { option in
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
    // Match the desktop composer's model label: "Claude Sonnet 4.6" /
    // "GPT-5.4-Codex" instead of a bare short id. Host-reported
    // `chatSummary.model` is usually just "sonnet" / "opus" / "haiku" for
    // Claude and the full long form for Codex, so we special-case the
    // Claude short ids and otherwise beautify the raw string.
    let trimmed = model.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return "Model" }
    let lower = trimmed.lowercased()

    switch lower {
    case "opus": return "Claude Opus 4.7"
    case "opus[1m]", "opus-1m": return "Claude Opus 4.7 1M"
    case "sonnet": return "Claude Sonnet 4.6"
    case "haiku": return "Claude Haiku 4.5"
    default: break
    }
    if lower.hasPrefix("claude-") {
      let tail = trimmed.dropFirst("claude-".count)
      return "Claude " + beautifyModelSegment(String(tail))
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
  /// Tap-to-submit is only used for single-question single-select with options
  /// (the card invokes this directly from `optionRow`). Multi-question cards
  /// never call this — taps only update local state and submit via Send.
  let onSelectOption: @MainActor (WorkPendingQuestionOption) async -> Void
  /// Aggregate submit: one map from questionId -> answer value, plus the
  /// shared freeform response (single-question only). The session action
  /// forwards this as one `chat.respondToInput` call.
  let onSubmitAll: @MainActor ([String: AgentChatInputAnswerValue], String?) async -> Void
  let onDecline: @MainActor () async -> Void

  @State private var currentPage: Int = 0
  @State private var selections: [String: Set<String>] = [:]
  @State private var freeformByQuestion: [String: String] = [:]
  @State private var expandedPreviews: Set<String> = []

  private var isPaged: Bool { question.questions.count > 1 }
  private var activeQuestion: WorkPendingQuestion {
    guard !question.questions.isEmpty else { return question.primary }
    let index = min(max(currentPage, 0), question.questions.count - 1)
    return question.questions[index]
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      headerRow

      if isPaged {
        TabView(selection: $currentPage) {
          ForEach(Array(question.questions.enumerated()), id: \.offset) { index, q in
            questionPage(q)
              .tag(index)
              .padding(.bottom, 24)
          }
        }
        .tabViewStyle(.page(indexDisplayMode: .always))
        .indexViewStyle(.page(backgroundDisplayMode: .always))
        .frame(minHeight: 280)
      } else {
        questionPage(activeQuestion)
      }

      if !isPaged, activeQuestion.allowsFreeform {
        freeformRow(for: activeQuestion)
      }

      footerRow
    }
    .adeGlassCard(cornerRadius: 18, padding: 14)
  }

  @ViewBuilder
  private var headerRow: some View {
    VStack(alignment: .leading, spacing: 6) {
      if isPaged {
        Text("Question \(currentPage + 1) of \(question.questions.count)")
          .font(.caption.weight(.bold))
          .tracking(0.6)
          .foregroundStyle(ADEColor.textMuted)
      } else if let title = question.title, !title.isEmpty {
        Text(title)
          .font(.headline)
          .foregroundStyle(ADEColor.textPrimary)
      }
      if !isPaged, let body = question.body, !body.isEmpty,
         normalizedText(body) != normalizedText(activeQuestion.question) {
        Text(body)
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      if let header = activeQuestion.header, !header.isEmpty {
        Text(header.uppercased())
          .font(.caption2.weight(.bold))
          .tracking(0.6)
          .foregroundStyle(ADEColor.textMuted)
      }
      Text(activeQuestion.question)
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private func normalizedText(_ value: String) -> String {
    value
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .lowercased()
  }

  @ViewBuilder
  private func questionPage(_ q: WorkPendingQuestion) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      if let impact = q.impact, !impact.isEmpty {
        WorkStructuredQuestionMetaRow(
          icon: "exclamationmark.triangle",
          label: "Impact",
          value: impact,
          tint: ADEColor.warning
        )
      }

      if let assumption = q.defaultAssumption, !assumption.isEmpty {
        WorkStructuredQuestionMetaRow(
          icon: "wand.and.stars",
          label: "Default",
          value: assumption,
          tint: ADEColor.accent
        )
      }

      if !q.options.isEmpty {
        VStack(alignment: .leading, spacing: 8) {
          ForEach(Array(q.options.enumerated()), id: \.offset) { _, option in
            optionRow(for: option, in: q)
          }
        }
      }

      if isPaged, q.allowsFreeform {
        freeformRow(for: q)
      }
    }
  }

  @ViewBuilder
  private func freeformRow(for q: WorkPendingQuestion) -> some View {
    let binding = freeformBinding(for: q)
    if q.isSecret {
      SecureField(q.options.isEmpty ? "Response" : "Optional response", text: binding)
        .adeInsetField(cornerRadius: 14, padding: 12)
        .disabled(busy)
    } else {
      TextField(q.options.isEmpty ? "Response" : "Optional response", text: binding, axis: .vertical)
        .lineLimit(1...4)
        .adeInsetField(cornerRadius: 14, padding: 12)
        .disabled(busy)
    }
  }

  @ViewBuilder
  private var footerRow: some View {
    HStack(spacing: 10) {
      Button(submitLabel) {
        Task { await submitAll() }
      }
      .buttonStyle(.glassProminent)
      .tint(ADEColor.accent)
      .disabled(busy || !canSubmit)

      Spacer(minLength: 0)

      Button("Decline") {
        Task { await onDecline() }
      }
      .buttonStyle(.glass)
      .tint(ADEColor.danger)
      .disabled(busy)
    }
  }

  private var submitLabel: String {
    if isPaged { return "Send answers" }
    if activeQuestion.options.isEmpty { return "Send answer" }
    return "Send"
  }

  private var canSubmit: Bool {
    // Multi-question card: require at least one answer (selection OR freeform)
    // per question that has options. Questions that are freeform-only need
    // non-empty text before Send unlocks.
    for q in question.questions {
      let selected = selections[q.questionId] ?? []
      let freeform = (freeformByQuestion[q.questionId] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      if q.options.isEmpty {
        if freeform.isEmpty { return false }
      } else if q.multiSelect {
        if selected.isEmpty && (!q.allowsFreeform || freeform.isEmpty) { return false }
      } else {
        if selected.isEmpty && (!q.allowsFreeform || freeform.isEmpty) { return false }
      }
    }
    if !isPaged {
      // Single-question card: also allow the shared responseText binding.
      let shared = responseText.trimmingCharacters(in: .whitespacesAndNewlines)
      if activeQuestion.options.isEmpty {
        let freeform = (freeformByQuestion[activeQuestion.questionId] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return !freeform.isEmpty || !shared.isEmpty
      }
    }
    return true
  }

  @MainActor
  private func submitAll() async {
    var answers: [String: AgentChatInputAnswerValue] = [:]
    for q in question.questions {
      let selected = selections[q.questionId] ?? []
      let ordered = q.options.map(\.value).filter { selected.contains($0) }
      if !ordered.isEmpty {
        if q.multiSelect {
          answers[q.questionId] = .strings(ordered)
        } else if let first = ordered.first {
          answers[q.questionId] = .string(first)
        }
        continue
      }
      let freeform = (freeformByQuestion[q.questionId] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      if !freeform.isEmpty {
        answers[q.questionId] = .string(freeform)
      }
    }
    let sharedFreeform: String? = {
      if isPaged { return nil }
      let shared = responseText.trimmingCharacters(in: .whitespacesAndNewlines)
      return shared.isEmpty ? nil : shared
    }()
    await onSubmitAll(answers, sharedFreeform)
  }

  private func freeformBinding(for q: WorkPendingQuestion) -> Binding<String> {
    if !isPaged {
      // Single-question cards keep the legacy shared binding so composer
      // callers can drive the text externally if needed.
      return $responseText
    }
    return Binding(
      get: { freeformByQuestion[q.questionId] ?? "" },
      set: { freeformByQuestion[q.questionId] = $0 }
    )
  }

  @ViewBuilder
  private func optionRow(for option: WorkPendingQuestionOption, in q: WorkPendingQuestion) -> some View {
    let selectedSet = selections[q.questionId] ?? []
    let selected = selectedSet.contains(option.value)
    let expanded = expandedPreviews.contains(previewKey(for: q, option: option))
    let showsCheckbox = q.multiSelect
    VStack(alignment: .leading, spacing: 6) {
      HStack(alignment: .top, spacing: 10) {
        Button {
          tapOption(option, in: q)
        } label: {
          VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
              if showsCheckbox {
                Image(systemName: selected ? "checkmark.square.fill" : "square")
                  .foregroundStyle(selected ? ADEColor.warning : ADEColor.textSecondary)
              } else if selected {
                Image(systemName: "largecircle.fill.circle")
                  .foregroundStyle(ADEColor.warning)
              }
              Text(option.label)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(ADEColor.textPrimary)
              if option.recommended {
                Text("★ Recommended")
                  .font(.caption2.weight(.bold))
                  .foregroundStyle(ADEColor.success)
                  .padding(.horizontal, 6)
                  .padding(.vertical, 2)
                  .background(ADEColor.success.opacity(0.14), in: Capsule())
              }
              Spacer(minLength: 0)
            }
            if let description = option.description, !description.isEmpty {
              Text(description)
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(10)
          .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
              .fill(selected ? ADEColor.warning.opacity(0.18) : ADEColor.surfaceBackground.opacity(0.6))
          )
          .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
              .stroke(selected ? ADEColor.warning.opacity(0.6) : ADEColor.border.opacity(0.25), lineWidth: 0.8)
          )
        }
        .buttonStyle(.plain)
        .disabled(busy)

        if let preview = option.preview, !preview.isEmpty {
          Button {
            let key = previewKey(for: q, option: option)
            if expandedPreviews.contains(key) {
              expandedPreviews.remove(key)
            } else {
              expandedPreviews.insert(key)
            }
          } label: {
            Image(systemName: expanded ? "chevron.up" : "chevron.down")
              .font(.caption.weight(.semibold))
              .foregroundStyle(ADEColor.textSecondary)
              .padding(8)
              .background(ADEColor.surfaceBackground.opacity(0.5), in: Circle())
          }
          .buttonStyle(.plain)
          .accessibilityLabel(expanded ? "Hide preview" : "Show preview")
          .disabled(busy)
        }
      }

      if expanded, let preview = option.preview, !preview.isEmpty {
        previewPanel(text: preview, format: option.previewFormat)
      }
    }
  }

  @ViewBuilder
  private func previewPanel(text: String, format: String?) -> some View {
    Group {
      if (format?.lowercased() ?? "markdown") == "markdown" {
        WorkMarkdownRenderer(markdown: text)
      } else {
        Text(text)
          .font(.caption)
          .foregroundStyle(ADEColor.textPrimary)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .padding(10)
    .background(ADEColor.surfaceBackground.opacity(0.4), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
  }

  private func previewKey(for q: WorkPendingQuestion, option: WorkPendingQuestionOption) -> String {
    "\(q.questionId)::\(option.value)"
  }

  private func tapOption(_ option: WorkPendingQuestionOption, in q: WorkPendingQuestion) {
    // Tap-to-submit is intentional ONLY for single-question, single-select
    // cards with concrete options. Multi-question cards collect selections
    // and require an explicit Send so users can answer every page first.
    let singleQuestionSingleSelect = !isPaged && !q.multiSelect && !q.options.isEmpty
    var current = selections[q.questionId] ?? []
    if q.multiSelect {
      if current.contains(option.value) {
        current.remove(option.value)
      } else {
        current.insert(option.value)
      }
      selections[q.questionId] = current
    } else {
      selections[q.questionId] = [option.value]
    }
    if singleQuestionSingleSelect {
      Task { await onSelectOption(option) }
    }
  }
}

private struct WorkStructuredQuestionMetaRow: View {
  let icon: String
  let label: String
  let value: String
  let tint: Color

  var body: some View {
    HStack(alignment: .top, spacing: 8) {
      Image(systemName: icon)
        .font(.caption2.weight(.semibold))
        .foregroundStyle(tint)
        .frame(width: 18, height: 18)
      VStack(alignment: .leading, spacing: 2) {
        Text(label.uppercased())
          .font(.caption2.weight(.bold))
          .tracking(0.6)
          .foregroundStyle(ADEColor.textMuted)
        Text(value)
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
      }
      Spacer(minLength: 0)
    }
  }
}

struct WorkPermissionCard: View {
  let permission: WorkPendingPermissionModel
  let busy: Bool
  let onDecision: @MainActor (AgentChatApprovalDecision) async -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 8) {
        Image(systemName: "lock.shield")
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(ADEColor.warning)
        Text("Permission requested")
          .font(.headline)
          .foregroundStyle(ADEColor.textPrimary)
      }

      Text(permission.description)
        .font(.subheadline)
        .foregroundStyle(ADEColor.textSecondary)
        .frame(maxWidth: .infinity, alignment: .leading)

      if !permission.tool.isEmpty && permission.tool != "tool" {
        HStack(spacing: 6) {
          Text("Tool")
            .font(.caption2.weight(.bold))
            .tracking(0.6)
            .foregroundStyle(ADEColor.textMuted)
          Text(permission.tool)
            .font(.caption.monospaced())
            .foregroundStyle(ADEColor.textPrimary)
        }
      }

      if let detail = permission.detail, !detail.isEmpty {
        WorkStructuredOutputBlock(title: "Details", text: detail)
      }

      HStack(spacing: 10) {
        Button("Allow") {
          Task { await onDecision(.accept) }
        }
        .buttonStyle(.glassProminent)
        .tint(ADEColor.success)
        .disabled(busy)

        Button("Allow for session") {
          Task { await onDecision(.acceptForSession) }
        }
        .buttonStyle(.glass)
        .tint(ADEColor.accent)
        .disabled(busy)

        Button("Decline") {
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
