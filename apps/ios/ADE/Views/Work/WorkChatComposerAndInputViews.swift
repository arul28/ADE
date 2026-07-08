import SwiftUI
import UIKit
import AVKit

struct WorkTurnUsageSummaryBanner: View {
  let summary: WorkUsageSummary
  /// Retained for call-site compatibility. Model is shown in usage and composer, not the turn line.
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

func workReasoningChipLabel(_ effort: String?) -> String? {
  guard let effort else { return nil }
  let lower = effort.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  guard !lower.isEmpty else { return nil }
  switch lower {
  case "minimal": return "MIN"
  case "low": return "LOW"
  case "medium": return "MED"
  case "high": return "HI"
  case "xhigh", "extra-high", "extra_high", "extra high": return "XH"
  case "max": return "MAX"
  case "ultracode": return "ULTRA"
  default: return String(lower.prefix(3)).uppercased()
  }
}

func workChatComposerSupportsFastMode(_ summary: AgentChatSessionSummary) -> Bool {
  workComposerFastModeSupported(
    modelId: summary.modelId ?? summary.model,
    provider: summary.provider,
    effectiveFastMode: summary.effectiveFastMode,
    fallbackRefs: [summary.modelId, summary.model]
  )
}

/// Whether a model (by raw id + provider family) can use the "fast" service
/// tier. Shared by the in-session and new-chat composers so both surfaces show
/// the fast-mode lightning toggle for the same models.
func workComposerSupportsFastMode(modelId: String, provider: String) -> Bool {
  workComposerFastModeSupported(
    modelId: modelId,
    provider: provider,
    effectiveFastMode: false,
    fallbackRefs: [modelId]
  )
}

private func workComposerFastModeSupported(
  modelId: String,
  provider: String,
  effectiveFastMode: Bool,
  fallbackRefs: [String?]
) -> Bool {
  if effectiveFastMode { return true }
  return WorkComposerFastModeCapabilityCache.shared.supportsFastMode(
    modelId: modelId,
    provider: provider,
    fallbackRefs: fallbackRefs
  )
}

private final class WorkComposerFastModeCapabilityCache {
  static let shared = WorkComposerFastModeCapabilityCache()

  private let lock = NSLock()
  private var cachedValues: [String: Bool] = [:]

  func supportsFastMode(modelId: String, provider: String, fallbackRefs: [String?]) -> Bool {
    let trimmedModelId = modelId.trimmingCharacters(in: .whitespacesAndNewlines)
    let refsKey = fallbackRefs
      .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
      .filter { !$0.isEmpty }
      .joined(separator: ",")
    let key = "\(providerFamilyKey(provider))|\(trimmedModelId.lowercased())|\(refsKey)"

    lock.lock()
    if let cached = cachedValues[key] {
      lock.unlock()
      return cached
    }
    lock.unlock()

    let supported = workComposerModelOption(modelId: trimmedModelId, provider: provider)?
      .supportsServiceTier("fast") == true
      || workModelRefsLookFastCapable(fallbackRefs)

    lock.lock()
    cachedValues[key] = supported
    lock.unlock()
    return supported
  }
}

/// Resolve the catalog `WorkModelOption` for a raw model id, preferring the
/// model's own provider-family group before falling back to a global search.
func workComposerModelOption(modelId: String, provider: String) -> WorkModelOption? {
  let currentModelId = modelId.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !currentModelId.isEmpty else { return nil }
  let family = providerFamilyKey(provider)
  let groups = workModelCatalogGroups(currentModelId: currentModelId, currentProvider: provider)
  let familyGroups = groups.filter { $0.key == family }
  let searchGroups = familyGroups.isEmpty ? groups : familyGroups

  for group in searchGroups {
    for provider in group.providers {
      if let match = provider.models.first(where: { workModelIdsEquivalent($0.id, currentModelId) }) {
        return match
      }
    }
  }
  return nil
}

/// Hardcoded fallback for hosts that don't advertise service tiers yet: a small
/// allow-list of fast-capable model refs plus any "-fast" suffixed id.
private func workModelRefsLookFastCapable(_ rawRefs: [String?]) -> Bool {
  let refs = rawRefs
    .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
    .filter { !$0.isEmpty }
  let fastRefs: Set<String> = [
    "gpt-5.5", "gpt-5.5-codex", "openai/gpt-5.5", "openai/gpt-5.5-codex",
    "gpt-5.4", "gpt-5.4-codex", "openai/gpt-5.4", "openai/gpt-5.4-codex",
    "opencode/openai/gpt-5.4",
    "fable", "claude-fable-5", "anthropic/claude-fable-5", "opencode/anthropic/claude-fable-5",
    "opus", "claude-opus-4-8", "anthropic/claude-opus-4-8", "opencode/anthropic/claude-opus-4-8",
    "opus-4-7", "claude-opus-4-7", "anthropic/claude-opus-4-7", "opencode/anthropic/claude-opus-4-7",
    "opencode/anthropic/opus",
    "opus-1m", "opus[1m]", "claude-opus-4-7-1m", "anthropic/claude-opus-4-7-1m",
    "opus-4.8", "opus-4-8", "claude-opus-4-8", "anthropic/claude-opus-4-8",
    "opencode/anthropic/claude-opus-4-8",
  ]
  return refs.contains { fastRefs.contains($0) || $0.hasSuffix("-fast") }
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

/// Width below which the access/permission control collapses from the full
/// segmented chip row to a single dot-only Menu button — mirroring the desktop
/// composer's container query, tuned down for the phone. Shared so the
/// in-session and new-chat composers collapse at the same point.
let workComposerControlsCollapseThreshold: CGFloat = 360

/// The composer's access/model/fast-mode controls, shared verbatim by the
/// in-session composer (`WorkComposerChipStrip`) and the new-chat composer
/// (`WorkNewChatComposerBar`) so the two surfaces stay visually and
/// behaviorally identical: a permission/access control (single tone-dot Menu
/// when space is tight, segmented chips when wide), a model pill, and a
/// fast-mode lightning toggle. The caller owns width measurement and passes
/// `isCollapsed` so the GeometryReader can sit on the scroll viewport.
struct WorkComposerControlsRow: View {
  let provider: String
  let modelDisplayName: String
  let reasoningEffort: String
  let currentMode: String
  let modeOptions: [WorkRuntimeModeOption]
  let modeLabel: String
  let isCollapsed: Bool
  let fastModeSupported: Bool
  let fastModeEnabled: Bool
  let settingsMutationInFlight: Bool
  let onOpenModelPicker: (() -> Void)?
  let onSelectMode: ((String) -> Void)?
  let onToggleFastMode: ((Bool) -> Void)?

  var body: some View {
    HStack(spacing: 8) {
      accessControl
      modelPill
      fastModeToggle
    }
  }

  /// Access/permission control: full segmented chips above the threshold, a
  /// single tone-dot Menu button below it (label + caret hidden, color encodes
  /// the safety tier via `workRuntimeModeTint`).
  @ViewBuilder
  private var accessControl: some View {
    if isCollapsed {
      collapsedAccessControl
    } else {
      accessPill
    }
  }

  @ViewBuilder
  private var collapsedAccessControl: some View {
    let tint = workRuntimeModeTint(currentMode)

    if modeOptions.isEmpty || onSelectMode == nil {
      collapsedDotButton(tint: tint, glyph: nil)
        .accessibilityLabel("Access mode: \(modeLabel)")
    } else {
      Menu {
        Picker("Access mode", selection: Binding(
          get: { currentMode },
          set: { onSelectMode?($0) }
        )) {
          ForEach(modeOptions) { option in
            Text(option.title).tag(option.id)
          }
        }
      } label: {
        collapsedDotButton(tint: tint, glyph: nil)
      }
      .accessibilityLabel("Access mode: \(modeLabel). Tap to change.")
    }
  }

  /// Compact ~1.5rem square showing just the tone dot (and an optional short
  /// glyph), mirroring the desktop collapsed permission control.
  private func collapsedDotButton(tint: Color, glyph: String?) -> some View {
    ZStack {
      if let glyph {
        Text(glyph)
          .font(.system(size: 10, weight: .bold))
          .foregroundStyle(tint)
      } else {
        Circle()
          .fill(tint)
          .frame(width: 8, height: 8)
      }
    }
    .frame(width: 28, height: 28)
    .background(ADEColor.surfaceBackground.opacity(0.38), in: Capsule(style: .continuous))
    .overlay(
      Capsule(style: .continuous)
        .stroke(ADEColor.border.opacity(0.24), lineWidth: 0.5)
    )
    .contentShape(Rectangle())
  }

  @ViewBuilder
  private var accessPill: some View {
    if modeOptions.isEmpty || onSelectMode == nil {
      pillContent(dotColor: workRuntimeModeTint(currentMode), label: modeLabel, showChevron: false)
    } else {
      HStack(spacing: 6) {
        ForEach(modeOptions) { option in
          composerOptionChip(
            title: option.title,
            tint: workRuntimeModeTint(option.id),
            isSelected: option.id == currentMode,
            accessibilityPrefix: "Access mode"
          ) {
            onSelectMode?(option.id)
          }
        }
      }
    }
  }

  private func composerOptionChip(
    title: String,
    tint: Color,
    isSelected: Bool,
    accessibilityPrefix: String,
    action: @escaping () -> Void
  ) -> some View {
    Button(action: action) {
      HStack(spacing: 6) {
        Circle()
          .fill(tint)
          .frame(width: 6, height: 6)
        Text(title)
          .font(.caption.weight(.semibold))
          .foregroundStyle(isSelected ? ADEColor.textPrimary : ADEColor.textSecondary)
          .lineLimit(1)
        if isSelected {
          Image(systemName: "checkmark")
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(tint)
        }
      }
      .padding(.horizontal, 8)
      .padding(.vertical, 5)
      .background(
        ADEColor.surfaceBackground.opacity(isSelected ? 0.56 : 0.28),
        in: Capsule(style: .continuous)
      )
      .overlay(
        Capsule(style: .continuous)
          .stroke(isSelected ? tint.opacity(0.4) : ADEColor.border.opacity(0.22), lineWidth: 0.5)
      )
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(accessibilityPrefix): \(title)")
    .accessibilityValue(isSelected ? "Selected" : "")
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
    .padding(.horizontal, 8)
    .padding(.vertical, 5)
    .background(ADEColor.surfaceBackground.opacity(0.38), in: Capsule(style: .continuous))
    .overlay(
      Capsule(style: .continuous)
        .stroke(ADEColor.border.opacity(0.24), lineWidth: 0.5)
    )
  }

  @ViewBuilder
  private var modelPill: some View {
    let reasoning = reasoningEffort.trimmingCharacters(in: .whitespacesAndNewlines)
    let reasoningLabel = workReasoningChipLabel(reasoning)
    Button {
      onOpenModelPicker?()
    } label: {
      HStack(spacing: 6) {
        WorkProviderLogo(
          provider: provider,
          fallbackSymbol: providerIcon(provider),
          tint: providerTint(provider),
          size: 16
        )
        Text(modelDisplayName)
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
        if let reasoningLabel {
          Text("·")
            .font(.caption2)
            .foregroundStyle(ADEColor.textMuted.opacity(0.5))
          Text(reasoningLabel)
            .font(.system(size: 10, weight: .medium))
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
        }
        Image(systemName: "chevron.down")
          .font(.system(size: 9, weight: .bold))
          .foregroundStyle(ADEColor.textMuted)
      }
      .padding(.horizontal, 8)
      .padding(.vertical, 5)
      .background(Color.clear, in: Capsule(style: .continuous))
      .overlay(
        Capsule(style: .continuous)
          .stroke(ADEColor.border.opacity(0.22), lineWidth: 0.5)
      )
    }
    .buttonStyle(.plain)
    .disabled(onOpenModelPicker == nil)
    .accessibilityLabel("Model: \(modelDisplayName)\(reasoning.isEmpty ? "" : ", reasoning \(reasoning)"). Tap to switch.")
  }

  @ViewBuilder
  private var fastModeToggle: some View {
    if fastModeSupported {
      Button {
        onToggleFastMode?(!fastModeEnabled)
      } label: {
        Image(systemName: "bolt.fill")
          .font(.system(size: 11, weight: .bold))
          .foregroundStyle(fastModeEnabled ? ADEColor.warning : ADEColor.textMuted)
          .frame(width: 28, height: 28)
          .background(
            Capsule(style: .continuous)
              .fill(ADEColor.surfaceBackground.opacity(fastModeEnabled ? 0.56 : 0.34))
          )
          .overlay(
            Capsule(style: .continuous)
              .stroke(fastModeEnabled ? ADEColor.warning.opacity(0.38) : ADEColor.border.opacity(0.22), lineWidth: 0.5)
          )
      }
      .buttonStyle(.plain)
      .disabled(onToggleFastMode == nil || settingsMutationInFlight)
      .contentShape(Rectangle())
      .accessibilityLabel("Fast mode \(fastModeEnabled ? "on" : "off"). Tap to turn \(fastModeEnabled ? "off" : "on").")
      .accessibilityValue(settingsMutationInFlight ? "\(fastModeEnabled ? "On" : "Off"), saving" : (fastModeEnabled ? "On" : "Off"))
      .accessibilityIdentifier("Work.Chat.Composer.FastModeToggle")
    }
  }
}

/// Compact horizontal strip matching the desktop composer toolbar: small
/// single-line pills for access, model, fast mode, pending status chips,
/// and nothing else. Reasoning is summarized in the model chip and changed
/// through the full model picker.
struct WorkComposerChipStrip: View {
  let chatSummary: WorkChatSummaryRenderContext
  let settingsMutationInFlight: Bool
  let codexFastModeOverride: Bool?
  let onOpenModelPicker: (() -> Void)?
  let onSelectRuntimeMode: ((String) -> Void)?
  let onToggleCodexFastMode: ((Bool) -> Void)?

  /// Width below which the access control collapses from the full segmented
  /// chip row to a single dot-only Menu button — mirroring the desktop
  /// composer's ≤560px container query (tuned down for the phone, where the full
  /// strip still wants to leave room for the model pill + Send button).
  private let collapseThreshold: CGFloat = workComposerControlsCollapseThreshold

  /// Live measurement of the strip's available width, fed by a background
  /// GeometryReader so the collapse decision tracks rotation / split-view.
  @State private var availableWidth: CGFloat = 0

  private var isCollapsed: Bool {
    availableWidth > 0 && availableWidth <= collapseThreshold
  }

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        if chatSummary.isAvailable {
          let currentMode = chatSummary.runtimeMode
          WorkComposerControlsRow(
            provider: chatSummary.provider,
            modelDisplayName: chatSummary.modelLabel,
            reasoningEffort: chatSummary.reasoningEffort,
            currentMode: currentMode,
            modeOptions: workRuntimeModeOptions(provider: chatSummary.provider),
            modeLabel: workRuntimeModeLabel(provider: chatSummary.provider, mode: currentMode),
            isCollapsed: isCollapsed,
            fastModeSupported: chatSummary.fastModeSupported,
            fastModeEnabled: codexFastModeOverride ?? chatSummary.effectiveFastMode,
            settingsMutationInFlight: settingsMutationInFlight,
            onOpenModelPicker: onOpenModelPicker,
            onSelectMode: onSelectRuntimeMode,
            onToggleFastMode: onToggleCodexFastMode
          )
        }
      }
      .padding(.horizontal, 2)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .disabled(settingsMutationInFlight)
    .opacity(settingsMutationInFlight ? 0.72 : 1)
    .background(
      GeometryReader { proxy in
        Color.clear
          .onAppear { availableWidth = proxy.size.width }
          .onChange(of: proxy.size.width) { _, newValue in
            availableWidth = newValue
          }
      }
    )
  }

  private func prettyModelName(_ model: String) -> String {
    // Match the desktop composer's model label: "Claude Sonnet 5" /
    // "GPT-5.4" instead of a bare short id. Host-reported
    // `chatSummary.model` is usually just "sonnet" / "opus" / "haiku" for
    // Claude and the full long form for Codex, so we special-case the
    // Claude short ids and otherwise beautify the raw string.
    let trimmed = model.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return "Model" }
    if let known = workKnownModelDisplayName(trimmed) {
      return known
    }
    let lower = trimmed.lowercased()
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
  let onDispatchInline: (@MainActor (String) async -> Void)?
  let onDispatchInterrupt: (@MainActor (String) async -> Void)?

  // Expanded by default so Send now / Interrupt / Edit / Cancel have the same
  // immediate affordance as desktop and the TUI after a steer is staged.
  @State private var isExpanded: Bool = true
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
              onSave: { text in await onSaveEdit(steer.id, text) },
              onDispatchInline: onDispatchInline.map { dispatch in
                { await dispatch(steer.id) }
              },
              onDispatchInterrupt: onDispatchInterrupt.map { dispatch in
                { await dispatch(steer.id) }
              }
            )
          }
        }
        .transition(.opacity.combined(with: .move(edge: .top)))
      }
    }
    .padding(10)
    .background(ADEColor.accent.opacity(0.08), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .stroke(ADEColor.accent.opacity(0.22), lineWidth: 0.8)
    )
    .sensoryFeedback(.impact(weight: .light), trigger: cancelHapticToken)
    .animation(.smooth(duration: 0.22), value: isExpanded)
    .animation(.smooth(duration: 0.22), value: anyEditing)
    .accessibilityElement(children: .contain)
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
        Text(steers.count == 1 ? "1 staged" : "\(steers.count) staged")
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
    .accessibilityLabel(steers.count == 1 ? "1 staged message" : "\(steers.count) staged messages")
    .accessibilityHint(isExpanded || anyEditing ? "Collapse staged messages" : "Expand to send now, interrupt, edit, or cancel staged messages")
    .accessibilityIdentifier("Work.Chat.StagedStrip.Header")
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
  let onDispatchInline: (@MainActor () async -> Void)?
  let onDispatchInterrupt: (@MainActor () async -> Void)?

  @StateObject private var dictationCoordinator = DictationInsertionCoordinator()
  @State private var isDictating = false
  private var dictationTargetId: String {
    "work-steer:\(steer.id)"
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if isEditing {
        TextField("Queued message", text: $draft, axis: .vertical)
          .lineLimit(1...5)
          .adePromptInputTraits()
          .adeInsetField(cornerRadius: 12, padding: 10)
          .disabled(busy || !isLive)

        HStack(spacing: 8) {
          if !isDictating {
            DictationRawUndoChip(coordinator: dictationCoordinator, draft: $draft)
          }

          DictationMicButton(
            draft: $draft,
            coordinator: dictationCoordinator,
            targetId: dictationTargetId,
            onRecordingChange: { isDictating = $0 }
          )
          .frame(maxWidth: isDictating ? .infinity : nil)

          if !isDictating {
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
        }
      } else {
        // Disposition ribbon mirrors the desktop staging-card treatment so
        // users see at a glance what will happen with this message and that
        // it hasn't been sent yet.
        HStack(spacing: 6) {
          Text("Sends after turn")
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
          if let onDispatchInline {
            Button {
              Task { await onDispatchInline() }
            } label: {
              Label("Send now", systemImage: "arrow.turn.down.right")
                .labelStyle(.titleAndIcon)
                .font(.caption2.weight(.semibold))
            }
            .buttonStyle(.glass)
            .tint(ADEColor.accent)
            .controlSize(.mini)
            .disabled(busy || !isLive)
            .accessibilityHint("Fold this message into the active turn")
            .accessibilityIdentifier("Work.Chat.StagedStrip.SendNow")
          }

          if let onDispatchInterrupt {
            Button {
              Task { await onDispatchInterrupt() }
            } label: {
              Label("Interrupt", systemImage: "bolt.fill")
                .labelStyle(.titleAndIcon)
                .font(.caption2.weight(.semibold))
            }
            .buttonStyle(.glass)
            .tint(ADEColor.warning)
            .controlSize(.mini)
            .disabled(busy || !isLive)
            .accessibilityHint("Stop the current turn and run this instead")
            .accessibilityIdentifier("Work.Chat.StagedStrip.Interrupt")
          }

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
          .accessibilityIdentifier("Work.Chat.StagedStrip.Edit")

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
          .accessibilityIdentifier("Work.Chat.StagedStrip.Cancel")
        }
      }
    }
    .padding(10)
    .background(ADEColor.surfaceBackground.opacity(0.86), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .stroke(ADEColor.glassBorder, lineWidth: 0.5)
    )
    .accessibilityElement(children: .contain)
  }
}

/// Whether an option preview should render as a fixed-column monospace block
/// rather than markdown. True when the text contains ASCII box-drawing or
/// wireframe glyphs (│┌┐└┘├┤┼─ ╭╮╰╯ ●○◉◯ ▢▣ etc.) or repeated indentation
/// whose alignment matters.
/// Mirrors the desktop redesign's wireframe detection on the question card.
func workPreviewIsWireframe(_ text: String) -> Bool {
  let wireframeScalars: Set<Character> = [
    "│", "┌", "┐", "└", "┘", "├", "┤", "┼", "─",
    "╭", "╮", "╰", "╯", "║", "═", "╔", "╗", "╚", "╝", "╠", "╣", "╬",
    "▌", "▐", "█", "▓", "▒", "░", "▢", "▣", "□", "■",
  ]
  if text.contains(where: { wireframeScalars.contains($0) }) {
    return true
  }
  let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
  guard lines.count >= 2 else { return false }
  let alignedColumnLines = lines.filter { line in
    line.range(of: #"\S\s{3,}\S"#, options: .regularExpression) != nil
  }
  return alignedColumnLines.count >= 2
}

struct WorkStructuredQuestionCard: View {
  let question: WorkPendingQuestionModel
  let busy: Bool
  /// Tap-to-submit is only used for single-question single-select with options
  /// (the card invokes this directly from `optionRow`). Multi-question cards
  /// never call this — taps only update local state and submit via Send.
  let onSelectOption: @MainActor (WorkPendingQuestionOption, String?) async -> Void
  /// Aggregate submit: one map from questionId -> answer value, plus the
  /// shared freeform response (single-question only). The session action
  /// forwards this as one `chat.respondToInput` call.
  let onSubmitAll: @MainActor ([String: AgentChatInputAnswerValue], String?) async -> Void
  let onDecline: @MainActor () async -> Void
  var onFreeformFocusChange: ((Bool) -> Void)? = nil
  /// Provider to fall back on when the parsed question carries no `source`
  /// (legacy `structured_question` envelopes). Usually the session provider.
  var fallbackProvider: String? = nil

  /// Resolved asking provider: the parsed question source, else the session
  /// fallback. Drives the header verb, logo, and per-provider accent.
  private var resolvedProvider: String? {
    if let source = question.source?.trimmingCharacters(in: .whitespacesAndNewlines), !source.isEmpty {
      return source
    }
    return fallbackProvider
  }

  private var providerAccent: Color { ADEColor.providerChatAccent(for: resolvedProvider) }

  @State private var currentPage: Int = 0
  @State private var singleQuestionFreeformText: String = ""
  @State private var selections: [String: Set<String>] = [:]
  @State private var freeformByQuestion: [String: String] = [:]
  @State private var expandedPreviews: Set<String> = []
  @FocusState private var freeformFocused: Bool

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
              .padding(.bottom, 4)
          }
        }
        .tabViewStyle(.page(indexDisplayMode: .never))
        .frame(minHeight: 240)
      } else {
        questionPage(activeQuestion)
      }

      if !isPaged, activeQuestion.allowsFreeform {
        freeformRow(for: activeQuestion)
      }

      footerRow
    }
    .adeGlassCard(cornerRadius: 18, padding: 14)
    .overlay(
      RoundedRectangle(cornerRadius: 18, style: .continuous)
        .stroke(providerAccent.opacity(0.30), lineWidth: 1)
    )
    .onChange(of: freeformFocused) { _, focused in
      onFreeformFocusChange?(focused)
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("\(workChatSurfaceProviderName(resolvedProvider)) asks. \(activeQuestion.question)")
  }

  @ViewBuilder
  private var headerRow: some View {
    VStack(alignment: .leading, spacing: 8) {
      // Provider-identified header: logo + "{Provider} asks" verb. Replaces the
      // old clock-icon "Input needed · Claude" treatment from the desktop redesign.
      HStack(spacing: 8) {
        WorkProviderBareLogo(
          provider: resolvedProvider,
          fallbackSymbol: providerIcon(resolvedProvider ?? ""),
          tint: providerAccent,
          size: 18
        )
        Text(question.providerHeaderVerb(fallbackProvider: fallbackProvider))
          .font(.caption.weight(.semibold))
          .foregroundStyle(providerAccent)
        Spacer(minLength: 0)
        if isPaged {
          Text("\(currentPage + 1) of \(question.questions.count)")
            .font(.caption2.weight(.bold).monospacedDigit())
            .foregroundStyle(ADEColor.textMuted)
        }
      }
      .accessibilityHidden(true)

      // Optional kicker: the question's short `header` shown above the prompt.
      if let header = activeQuestion.header, !header.isEmpty {
        Text(header.uppercased())
          .font(.caption2.weight(.bold))
          .tracking(0.6)
          .foregroundStyle(ADEColor.textMuted)
      }

      // The question text, rendered once. The old top-level title that simply
      // echoed the question is gone; only a request-level description that
      // differs from the question text is shown (below).
      Text(activeQuestion.question)
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
        .frame(maxWidth: .infinity, alignment: .leading)

      if !isPaged, let body = question.body, !body.isEmpty,
         normalizedText(body) != normalizedText(activeQuestion.question),
         normalizedText(body) != normalizedText(question.title ?? "") {
        Text(body)
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
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
        .focused($freeformFocused)
        .adeInsetField(cornerRadius: 14, padding: 12)
        .disabled(busy)
    } else {
      TextField(q.options.isEmpty ? "Response" : "Optional response", text: binding, axis: .vertical)
        .focused($freeformFocused)
        .lineLimit(1...4)
        .adePromptInputTraits()
        .adeInsetField(cornerRadius: 14, padding: 12)
        .disabled(busy)
    }
  }

  @ViewBuilder
  private var footerRow: some View {
    HStack(spacing: 10) {
      Button("Decline") {
        Task { await declineQuestion() }
      }
      .buttonStyle(.glass)
      .tint(ADEColor.danger)
      .disabled(busy)

      Spacer(minLength: 8)

      if isPaged {
        pageIndicator
        Spacer(minLength: 8)
      }

      Button(submitLabel) {
        Task { await submitAll() }
      }
      .buttonStyle(.glassProminent)
      .tint(providerAccent)
      .disabled(busy || !canSubmit)
    }
  }

  @ViewBuilder
  private var pageIndicator: some View {
    HStack(spacing: 6) {
      ForEach(0..<question.questions.count, id: \.self) { index in
        Button {
          withAnimation(.easeInOut(duration: 0.18)) { currentPage = index }
        } label: {
          Circle()
            .fill(index == currentPage ? ADEColor.accent : ADEColor.textMuted.opacity(0.35))
            .frame(width: index == currentPage ? 7 : 6, height: index == currentPage ? 7 : 6)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Question \(index + 1) of \(question.questions.count)")
      }
    }
    .padding(.horizontal, 4)
  }

  private var submitLabel: String {
    if isPaged { return "Send answers" }
    if activeQuestion.options.isEmpty { return "Send answer" }
    return "Send"
  }

  private var canSubmit: Bool {
    if !isPaged {
      let selected = selections[activeQuestion.questionId] ?? []
      let freeform = singleQuestionFreeformText.trimmingCharacters(in: .whitespacesAndNewlines)
      if activeQuestion.options.isEmpty {
        return !freeform.isEmpty
      }
      return !selected.isEmpty || (activeQuestion.allowsFreeform && !freeform.isEmpty)
    }

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
      let shared = singleQuestionFreeformText.trimmingCharacters(in: .whitespacesAndNewlines)
      return shared.isEmpty ? nil : shared
    }()
    await onSubmitAll(answers, sharedFreeform)
    clearQuestionDrafts()
  }

  @MainActor
  private func declineQuestion() async {
    await onDecline()
    clearQuestionDrafts()
  }

  @MainActor
  private func clearQuestionDrafts() {
    if !singleQuestionFreeformText.isEmpty {
      singleQuestionFreeformText = ""
    }
    if !selections.isEmpty {
      selections.removeAll()
    }
    if !freeformByQuestion.isEmpty {
      freeformByQuestion.removeAll()
    }
    if !expandedPreviews.isEmpty {
      expandedPreviews.removeAll()
    }
    if currentPage != 0 {
      currentPage = 0
    }
  }

  private func freeformBinding(for q: WorkPendingQuestion) -> Binding<String> {
    if !isPaged {
      return $singleQuestionFreeformText
    }
    return Binding(
      get: { freeformByQuestion[q.questionId] ?? "" },
      set: { newValue in
        guard freeformByQuestion[q.questionId] != newValue else { return }
        freeformByQuestion[q.questionId] = newValue
      }
    )
  }

  @ViewBuilder
  private func optionRow(for option: WorkPendingQuestionOption, in q: WorkPendingQuestion) -> some View {
    let selectedSet = selections[q.questionId] ?? []
    let selected = selectedSet.contains(option.value)
    let expanded = expandedPreviews.contains(previewKey(for: q, option: option))
    let showsCheckbox = q.multiSelect
    let accent = providerAccent
    VStack(alignment: .leading, spacing: 6) {
      HStack(alignment: .top, spacing: 10) {
        Button {
          tapOption(option, in: q)
        } label: {
          VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
              if showsCheckbox {
                Image(systemName: selected ? "checkmark.square.fill" : "square")
                  .foregroundStyle(selected ? accent : ADEColor.textSecondary)
              } else if selected {
                Image(systemName: "largecircle.fill.circle")
                  .foregroundStyle(accent)
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
              .fill(selected ? accent.opacity(0.18) : ADEColor.surfaceBackground.opacity(0.6))
          )
          .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
              .stroke(selected ? accent.opacity(0.6) : ADEColor.border.opacity(0.25), lineWidth: 0.8)
          )
        }
        .buttonStyle(.plain)
        .disabled(busy)
        // Expose options as radio buttons (single-select) or checkboxes
        // (multi-select) so VoiceOver announces selection state like a form.
        // The Button already carries `.isButton`; add `.isSelected` so the
        // current choice is read as selected, and describe the control kind.
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityValue(showsCheckbox
          ? "Checkbox, \(selected ? "checked" : "unchecked")"
          : (selected ? "Selected" : "Not selected"))
        .accessibilityLabel(option.recommended ? "\(option.label), recommended" : option.label)

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
    let isMarkdownFormat = (format?.lowercased() ?? "markdown") == "markdown"
    Group {
      // Wireframes (ASCII box-drawing / bullet glyphs) must keep their column
      // alignment, so they render in a true monospace block with whitespace and
      // newlines preserved and horizontal scrolling allowed — collapsing them
      // through the markdown renderer destroyed the alignment. Plain markdown
      // previews without box-drawing chars still go through the markdown path.
      if workPreviewIsWireframe(text) || !isMarkdownFormat {
        // Horizontal ScrollView + intrinsic-width monospace Text: columns stay
        // aligned and wide wireframes scroll sideways instead of wrapping.
        ScrollView(.horizontal, showsIndicators: false) {
          Text(text)
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(ADEColor.textPrimary)
            .fixedSize(horizontal: true, vertical: true)
            .textSelection(.enabled)
            .multilineTextAlignment(.leading)
        }
      } else {
        WorkMarkdownRenderer(markdown: text)
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
      let freeform = singleQuestionFreeformText.trimmingCharacters(in: .whitespacesAndNewlines)
      Task { @MainActor in
        await onSelectOption(option, freeform.isEmpty ? nil : freeform)
        clearQuestionDrafts()
      }
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

struct WorkModelSelectionPendingCard: View {
  @EnvironmentObject private var syncService: SyncService

  let request: WorkPendingModelSelectionModel
  let busy: Bool
  let onConfirm: @MainActor (String) async -> Void
  let onCancel: @MainActor () async -> Void

  @State private var selectedModelId: String
  @State private var selectedProvider: String
  @State private var selectedReasoningEffort: String
  @State private var selectedCodexFastMode: Bool
  @State private var selectedModel: WorkModelOption?
  @State private var pickerPresented = false

  init(
    request: WorkPendingModelSelectionModel,
    busy: Bool,
    onConfirm: @escaping @MainActor (String) async -> Void,
    onCancel: @escaping @MainActor () async -> Void
  ) {
    self.request = request
    self.busy = busy
    self.onConfirm = onConfirm
    self.onCancel = onCancel
    _selectedModelId = State(initialValue: "")
    _selectedProvider = State(initialValue: "claude")
    _selectedReasoningEffort = State(initialValue: "")
    _selectedCodexFastMode = State(initialValue: false)
    _selectedModel = State(initialValue: nil)
  }

  private var requestResetKey: String {
    [
      request.id,
      request.role,
      request.tag,
      request.workDescription ?? "",
      request.filesHint.joined(separator: "\u{1F}"),
      request.dependsOn.joined(separator: "\u{1F}"),
      request.availableModelIds?.joined(separator: "\u{1F}") ?? ""
    ].joined(separator: "\u{1E}")
  }

  private func resetSelectionState() {
    selectedModelId = ""
    selectedProvider = "claude"
    selectedReasoningEffort = ""
    selectedCodexFastMode = false
    selectedModel = nil
    pickerPresented = false
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      header
      selectedModelSummary
      if shouldShowFastModeToggle {
        fastModeToggle
      }
      footer
    }
    .adeGlassCard(cornerRadius: 18, padding: 14)
    .sheet(isPresented: $pickerPresented) {
      WorkModelPickerSheet(
        currentModelId: selectedModelId,
        currentProvider: selectedProvider,
        currentReasoningEffort: selectedReasoningEffort,
        availableModelIds: request.availableModelIds,
        isBusy: busy,
        onSelect: { option, pickedReasoning, provider in
          selectedModel = option
          selectedModelId = option.id
          selectedProvider = provider
          selectedReasoningEffort = pickedReasoning ?? ""
          if !option.supportsCodexFastMode {
            selectedCodexFastMode = false
          }
          pickerPresented = false
        }
      )
      .environmentObject(syncService)
    }
    .onChange(of: requestResetKey) { _, _ in
      resetSelectionState()
    }
  }

  @ViewBuilder
  private var header: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 8) {
        Image(systemName: "cpu")
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(ADEColor.accent)
        Text(request.title)
          .font(.headline)
          .foregroundStyle(ADEColor.textPrimary)
      }
      if let workDescription = request.workDescription, !workDescription.isEmpty {
        Text(workDescription)
          .font(.subheadline)
          .foregroundStyle(ADEColor.textSecondary)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      briefingList(label: "Files it touches", values: request.filesHint)
      briefingList(label: "Runs after", values: request.dependsOn)
    }
  }

  @ViewBuilder
  private func briefingList(label: String, values: [String]) -> some View {
    if !values.isEmpty {
      VStack(alignment: .leading, spacing: 3) {
        Text(label.uppercased())
          .font(.caption2.weight(.bold))
          .foregroundStyle(ADEColor.textMuted)
        ForEach(Array(values.prefix(4).enumerated()), id: \.offset) { _, value in
          Text(value)
            .font(.caption.monospaced())
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(1)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        if values.count > 4 {
          Text("+\(values.count - 4) more")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(ADEColor.textMuted)
        }
      }
      .padding(.top, 2)
    }
  }

  @ViewBuilder
  private var selectedModelSummary: some View {
    HStack(alignment: .center, spacing: 10) {
      WorkProviderLogo(provider: selectedProvider, size: 30)
      VStack(alignment: .leading, spacing: 4) {
        Text(selectedModelDisplayName)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(selectedModelId.isEmpty ? ADEColor.textMuted : ADEColor.textPrimary)
          .lineLimit(1)
        HStack(spacing: 6) {
          Text(selectedProvider.isEmpty ? "provider" : selectedProvider)
          if !selectedModelId.isEmpty {
            Text("·")
            Text(selectedModelId)
          }
          if !selectedReasoningEffort.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            Text("·")
            Text(selectedReasoningEffort.capitalized)
          }
        }
        .font(.caption.monospaced())
        .foregroundStyle(ADEColor.textSecondary)
        .lineLimit(1)
      }
      Spacer(minLength: 8)
      Button {
        pickerPresented = true
      } label: {
        Image(systemName: selectedModelId.isEmpty ? "plus.circle" : "arrow.triangle.2.circlepath")
          .font(.subheadline.weight(.semibold))
      }
      .buttonStyle(.glass)
      .tint(ADEColor.accent)
      .disabled(busy)
      .accessibilityLabel(selectedModelId.isEmpty ? "Choose model" : "Change model")
    }
    .padding(12)
    .background(ADEColor.surfaceBackground.opacity(0.55), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .stroke(ADEColor.glassBorder, lineWidth: 0.5)
    )
  }

  @ViewBuilder
  private var fastModeToggle: some View {
    Toggle(isOn: $selectedCodexFastMode) {
      VStack(alignment: .leading, spacing: 2) {
        Text("Fast mode")
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Text("Use the fast service tier for this worker.")
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
      }
    }
    .tint(ADEColor.accent)
    .disabled(busy)
  }

  @ViewBuilder
  private var footer: some View {
    HStack(spacing: 10) {
      Button("Cancel") {
        Task { await onCancel() }
      }
      .buttonStyle(.glass)
      .tint(ADEColor.danger)
      .disabled(busy)

      Spacer(minLength: 8)

      Button(selectedModelId.isEmpty ? "Choose model" : "Confirm") {
        if selectedModelId.isEmpty {
          pickerPresented = true
        } else {
          Task { await confirmSelection() }
        }
      }
      .buttonStyle(.glassProminent)
      .tint(ADEColor.accent)
      .disabled(busy)
    }
  }

  private var selectedModelDisplayName: String {
    if let selectedModel {
      return selectedModel.displayName
    }
    if let known = workKnownModelDisplayName(selectedModelId) {
      return known
    }
    return selectedModelId.isEmpty ? "No model selected" : selectedModelId
  }

  private var shouldShowFastModeToggle: Bool {
    selectedCodexFastMode || selectedModel?.supportsCodexFastMode == true
  }

  @MainActor
  private func confirmSelection() async {
    let trimmedModelId = selectedModelId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedModelId.isEmpty else {
      pickerPresented = true
      return
    }
    let trimmedProvider = selectedProvider.trimmingCharacters(in: .whitespacesAndNewlines)
    let trimmedEffort = selectedReasoningEffort.trimmingCharacters(in: .whitespacesAndNewlines)
    let answer = WorkModelSelectionChoice(
      provider: trimmedProvider.isEmpty ? "claude" : trimmedProvider,
      modelId: trimmedModelId,
      reasoningEffort: trimmedEffort.isEmpty ? nil : trimmedEffort,
      fastMode: selectedCodexFastMode ? true : nil
    )
    guard let json = workModelSelectionJSONString(answer) else { return }
    await onConfirm(json)
  }

  private func workModelSelectionJSONString(_ answer: WorkModelSelectionChoice) -> String? {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    guard let data = try? encoder.encode(answer) else { return nil }
    return String(data: data, encoding: .utf8)
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
