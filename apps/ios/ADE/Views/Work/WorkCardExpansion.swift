import SwiftUI

// MARK: - Central expansion state

/// Expansion state for every collapsible card in the Work transcript, held once
/// at the session level instead of per-row.
///
/// Two reasons it does not live in the rows:
///
/// 1. A row's `@State` dies whenever the `LazyVStack` recycles it, so a card the
///    reader opened silently snapped shut the moment it scrolled off screen.
/// 2. Turn end has to collapse the whole turn at once, which no row can do to
///    itself.
///
/// The two sets are overrides on top of a per-card default. `defaultsOpen` is
/// what the card would show on its own — today's behavior while its turn is
/// live — and the reader's tap records only the *disagreement* with it, which
/// is what makes "collapse this while it is still running" survive the next
/// streaming delta.
struct WorkCardExpansionState: Equatable {
  /// Cards the reader opened by hand.
  private(set) var expandedIds: Set<String> = []
  /// Cards the reader shut by hand while their turn was still live.
  private(set) var collapsedIds: Set<String> = []

  init(expandedIds: Set<String> = [], collapsedIds: Set<String> = []) {
    self.expandedIds = expandedIds
    self.collapsedIds = collapsedIds
  }

  func isExpanded(id: String, defaultsOpen: Bool) -> Bool {
    if expandedIds.contains(id) { return true }
    if collapsedIds.contains(id) { return false }
    return defaultsOpen
  }

  mutating func toggle(id: String, defaultsOpen: Bool) {
    set(id: id, expanded: !isExpanded(id: id, defaultsOpen: defaultsOpen), defaultsOpen: defaultsOpen)
  }

  mutating func set(id: String, expanded: Bool, defaultsOpen: Bool) {
    if expanded == defaultsOpen {
      // Back in agreement with the card's own default: drop the override rather
      // than carry a redundant entry that the turn-end sweep has to clear.
      expandedIds.remove(id)
      collapsedIds.remove(id)
    } else if expanded {
      collapsedIds.remove(id)
      expandedIds.insert(id)
    } else {
      expandedIds.remove(id)
      collapsedIds.insert(id)
    }
  }

  /// A turn ending collapses everything it produced, and drops the overrides
  /// that were only meaningful while it was live. Reopening a chat lands here
  /// too, because nothing is streaming: history renders collapsed.
  mutating func clearForTurnEnd() {
    guard !expandedIds.isEmpty || !collapsedIds.isEmpty else { return }
    expandedIds.removeAll()
    collapsedIds.removeAll()
  }

  var isEmpty: Bool { expandedIds.isEmpty && collapsedIds.isEmpty }
}

/// Order-independent fingerprint of the expansion state. `WorkChatSessionView`
/// carries it as a plain `Int` so SwiftUI's view-identity compare actually sees
/// an expand/collapse — a `@Binding` alone compares equal no matter what.
func workCardExpansionRenderSignature(_ state: WorkCardExpansionState) -> Int {
  var hasher = Hasher()
  hasher.combine(state.expandedIds.count)
  hasher.combine(state.collapsedIds.count)
  for id in state.expandedIds.sorted() {
    hasher.combine(id)
  }
  hasher.combine(0)
  for id in state.collapsedIds.sorted() {
    hasher.combine(id)
  }
  return hasher.finalize()
}

// MARK: - Collapsed summaries

/// One right-aligned count chip on a collapsed card row.
struct WorkCollapsedStatusChip: Identifiable, Equatable {
  let id: String
  /// Compact glyph form, e.g. `18✓`.
  let label: String
  let tone: WorkAdeCardTone
  /// Spoken form, e.g. "18 passed".
  let accessibilityText: String
}

/// Pass/fail counts for a collapsed `ade_card`. A zero count draws no chip —
/// "18✓" alone says a clean run better than "18✓ 0✕" does.
func workAdeCardCollapsedChips(_ card: WorkAdeCardModel) -> [WorkCollapsedStatusChip] {
  guard let progress = card.progress else { return [] }
  var chips: [WorkCollapsedStatusChip] = []
  if progress.passed > 0 {
    chips.append(
      WorkCollapsedStatusChip(
        id: "passed",
        label: "\(progress.passed)✓",
        tone: .success,
        accessibilityText: "\(progress.passed) passed"
      )
    )
  }
  if progress.failed > 0 {
    chips.append(
      WorkCollapsedStatusChip(
        id: "failed",
        label: "\(progress.failed)✕",
        // Amber, not red: `adeCard.ts`'s tone policy has no red path, and the
        // expanded card right below this row uses the same tint.
        tone: .warning,
        accessibilityText: "\(progress.failed) failed"
      )
    )
  }
  return chips
}

/// `Title · first subtitle segment` — for a `pr_ci` card that reads
/// "CI passing · PR #490". The subtitle's later segments (run name, failure
/// reason) belong to the expanded card, not to a one-line row.
func workAdeCardCollapsedSummary(_ card: WorkAdeCardModel) -> String {
  var parts: [String] = []
  let title = card.title.trimmingCharacters(in: .whitespacesAndNewlines)
  // A titleless payload gets the raw variant slug as its title (see
  // `makeWorkAdeCardModel`). That slug is wire vocabulary — `pr_ci`, not "CI" —
  // so drop it and let the fallback prose speak, which is exactly what the
  // expanded card renders for the same payload.
  if !title.isEmpty, title != card.variant.trimmingCharacters(in: .whitespacesAndNewlines) {
    parts.append(title)
  }
  if let subtitle = card.subtitle?.trimmingCharacters(in: .whitespacesAndNewlines),
     !subtitle.isEmpty,
     let lead = subtitle.components(separatedBy: " · ").first?
      .trimmingCharacters(in: .whitespacesAndNewlines),
     !lead.isEmpty {
    parts.append(lead)
  }
  if parts.isEmpty {
    return card.fallbackText
  }
  return parts.joined(separator: " · ")
}

/// Leading glyph for a collapsed `ade_card`. Variant-shaped and status-neutral —
/// the pass/fail reading belongs to the chips on the right, not to the icon.
func workAdeCardCollapsedGlyph(_ card: WorkAdeCardModel) -> String {
  switch card.variant.trimmingCharacters(in: .whitespacesAndNewlines) {
  case "pr_ci": return "checklist"
  case "pr_review": return "text.bubble"
  case "pr_merged", "pr_merge_ready": return "arrow.triangle.merge"
  case "pr_conflict": return "exclamationmark.triangle"
  case "proof_artifact": return "cube.transparent"
  case "claude_session_quota": return "gauge.with.dots.needle.33percent"
  default: return "square.stack"
  }
}

func workAdeCardCollapsedAccessibilityLabel(_ card: WorkAdeCardModel) -> String {
  var parts = [workAdeCardCollapsedSummary(card)]
  parts.append(contentsOf: workAdeCardCollapsedChips(card).map(\.accessibilityText))
  parts.append("collapsed")
  return parts.joined(separator: ", ")
}

/// `Plan · <first pending step, or the plan's own summary>`.
func workPlanCardCollapsedSummary(_ card: WorkEventCardModel) -> String {
  let steps = card.planSteps
  let detail = workPlanCardCollapsedDetail(card)
  guard let detail else {
    return steps.isEmpty ? "Plan" : "Plan · \(steps.count) step\(steps.count == 1 ? "" : "s")"
  }
  return "Plan · \(detail)"
}

private func workPlanCardCollapsedDetail(_ card: WorkEventCardModel) -> String? {
  let title = card.title.trimmingCharacters(in: .whitespacesAndNewlines)
  if !title.isEmpty, title.caseInsensitiveCompare("Plan") != .orderedSame {
    return workSummarizeInlineText(title, maxChars: 64)
  }
  let steps = card.planSteps
  // The step the reader would act on next, falling back to the first one when
  // the plan has not started (or has finished).
  let active = steps.first { !workPlanStepIsCompleted($0.status) } ?? steps.first
  if let text = active?.text.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
    return workSummarizeInlineText(text, maxChars: 64)
  }
  if let body = card.body?.trimmingCharacters(in: .whitespacesAndNewlines), !body.isEmpty {
    return workSummarizeInlineText(body, maxChars: 64)
  }
  return nil
}

/// Same mapping `WorkProposedPlanCard` normalizes with, so the collapsed row's
/// `4/7` can never disagree with the expanded checklist's.
func workPlanStepIsCompleted(_ status: String) -> Bool {
  switch status.lowercased().replacingOccurrences(of: "_", with: "-") {
  case "completed", "done", "complete", "success": return true
  default: return false
  }
}

func workPlanCardCompletedStepCount(_ card: WorkEventCardModel) -> Int {
  card.planSteps.filter { workPlanStepIsCompleted($0.status) }.count
}

/// `4/7`, or nil for a plan that has no steps yet.
func workPlanCardCollapsedProgressLabel(_ card: WorkEventCardModel) -> String? {
  let steps = card.planSteps
  guard !steps.isEmpty else { return nil }
  return "\(workPlanCardCompletedStepCount(card))/\(steps.count)"
}

func workPlanCardCollapsedAccessibilityLabel(_ card: WorkEventCardModel) -> String {
  var parts = [workPlanCardCollapsedSummary(card)]
  if workPlanCardCollapsedProgressLabel(card) != nil {
    parts.append("\(workPlanCardCompletedStepCount(card)) of \(card.planSteps.count) steps done")
  }
  parts.append("collapsed")
  return parts.joined(separator: ", ")
}

// MARK: - Shared collapsed row

/// The one-line form every auto-collapsed card takes: glyph, summary, count
/// chips, chevron — one 44pt row, tapped to expand in place.
struct WorkCollapsedCardRow: View {
  let systemImage: String
  let glyphTint: Color
  let summary: String
  var chips: [WorkCollapsedStatusChip] = []
  let accessibilityText: String
  let onToggle: () -> Void

  var body: some View {
    Button(action: onToggle) {
      HStack(spacing: 8) {
        Image(systemName: systemImage)
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(glyphTint)
          .frame(width: 16)

        Text(summary)
          .font(.footnote.weight(.medium))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
          .truncationMode(.tail)

        Spacer(minLength: 6)

        ForEach(chips) { chip in
          Text(chip.label)
            .font(.caption.weight(.semibold).monospacedDigit())
            .foregroundStyle(workAdeCardToneColor(chip.tone))
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(
              workAdeCardToneColor(chip.tone).opacity(0.12),
              in: Capsule(style: .continuous)
            )
        }

        Image(systemName: "chevron.right")
          .font(.system(size: 10, weight: .semibold))
          .foregroundStyle(ADEColor.textMuted)
      }
      .padding(.horizontal, 12)
      .frame(minHeight: 44)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(accessibilityText)
    .accessibilityHint("Double tap to expand.")
  }
}

/// Long-press peek: the full card, rendered as a non-interactive context-menu
/// preview so the reader can check a collapsed row without expanding it and
/// pushing the transcript around.
extension View {
  @ViewBuilder
  func workCollapsedCardPeek<Preview: View>(
    enabled: Bool = true,
    onExpand: @escaping () -> Void,
    @ViewBuilder preview: @escaping () -> Preview
  ) -> some View {
    if enabled {
      contextMenu {
        Button {
          onExpand()
        } label: {
          Label("Expand", systemImage: "chevron.down")
        }
      } preview: {
        ScrollView {
          preview()
            .allowsHitTesting(false)
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(width: 340)
        .background(ADEColor.pageBackground)
      }
    } else {
      self
    }
  }
}
