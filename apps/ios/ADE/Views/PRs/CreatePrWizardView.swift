import AVKit
import SwiftUI

// MARK: - Public view

struct CreatePrWizardView: View {
  @EnvironmentObject private var syncService: SyncService
  @Environment(\.dismiss) private var dismiss

  let lanes: [LaneSummary]
  /// Host-provided create eligibility. When present, drives the lane picker
  /// (filtered to canCreate=true entries), default base branch, and per-lane
  /// blocked-reason subtitles. When nil, the view falls back to the raw
  /// `lanes` list so cached/offline flows still work.
  let createCapabilities: PrCreateCapabilities?
  /// Single-PR submit: (laneId, title, body, draft, baseBranch, labels, reviewers, strategy).
  let onCreateSingle: (String, String, String, Bool, String, [String], [String], String?) async -> Bool
  let initialLaneId: String?
  /// Shown in a pane beside a chat (the Duo, an iPad), where desktop opens
  /// it: no navigation stack of its own (it would take over the chat's
  /// toolbar); its title and Create go to the pane's header, and Close is the
  /// pane's.
  var embedded = false

  init(
    lanes: [LaneSummary],
    createCapabilities: PrCreateCapabilities? = nil,
    initialLaneId: String? = nil,
    onCreateSingle: @escaping (String, String, String, Bool, String, [String], [String], String?) async -> Bool
  ) {
    self.lanes = lanes
    self.createCapabilities = createCapabilities
    self.initialLaneId = initialLaneId
    self.onCreateSingle = onCreateSingle
  }

  @State private var selectedLaneId = ""
  @State private var baseBranch = ""
  @State private var title = ""
  @State private var bodyText = ""
  @State private var draft = false
  @State private var strategy: PrStrategyChoice = .prTarget
  @State private var labelsInput = ""
  @State private var reviewersInput = ""
  @State private var isSubmitting = false
  @State private var errorMessage: String?
  @State private var editPresented = false
  @State private var lastAutoTitle = ""
  // Cached eligible lane options — recomputed only when the source-of-truth
  // (capabilities / lanes) shifts, not on every keystroke.
  @State private var cachedLaneOptions: [CreatePrLaneOption] = []
  @State private var didCacheLaneOptions = false

  private var fallbackCreateLanes: [LaneSummary] {
    lanes.filter { $0.archivedAt == nil && $0.laneType != "primary" }
  }

  private var eligibleLaneOptions: [CreatePrLaneOption] {
    didCacheLaneOptions ? cachedLaneOptions : sourceEligibleLaneOptions
  }

  private var sourceEligibleLaneOptions: [CreatePrLaneOption] {
    if let capabilities = createCapabilities {
      return capabilities.lanes
        .filter { Self.canOpenPr(from: $0) }
        .map { eligibility in
          CreatePrLaneOption(
            id: eligibility.laneId,
            title: eligibility.laneName,
            branchRef: lanes.first(where: { $0.id == eligibility.laneId })?.branchRef ?? eligibility.laneName,
            defaultBaseBranch: eligibility.defaultBaseBranch,
            subtitle: Self.laneProgressSubtitle(for: eligibility)
          )
        }
    }
    return fallbackCreateLanes.map { lane in
      CreatePrLaneOption(
        id: lane.id,
        title: lane.name,
        branchRef: lane.branchRef,
        defaultBaseBranch: lane.baseRef,
        subtitle: nil
      )
    }
  }

  private var selectedOption: CreatePrLaneOption? {
    guard !selectedLaneId.isEmpty else { return nil }
    if let match = eligibleLaneOptions.first(where: { $0.id == selectedLaneId }) {
      return match
    }
    guard let lane = selectedLane else { return nil }
    let eligibility = eligibility(for: lane.id)
    return CreatePrLaneOption(
      id: lane.id,
      title: lane.name,
      branchRef: lane.branchRef,
      defaultBaseBranch: eligibility?.defaultBaseBranch ?? lane.baseRef,
      subtitle: eligibility.map { Self.laneProgressSubtitle(for: $0) } ?? nil
    )
  }

  private var selectedLane: LaneSummary? {
    guard !selectedLaneId.isEmpty else { return nil }
    return lanes.first(where: { $0.id == selectedLaneId })
  }

  private var defaultTargetBranch: String {
    selectedOption?.defaultBaseBranch
      ?? createCapabilities?.defaultBaseBranch
      ?? "main"
  }

  private func displayNameForTargetBranch(_ branch: String) -> String {
    let normalizedTarget = normalizedPrBranchName(branch)
    guard !normalizedTarget.isEmpty else { return "target" }
    return lanes.first { lane in
      normalizedPrBranchName(lane.branchRef) == normalizedTarget
    }?.name ?? normalizedTarget
  }

  private var branchTargetOptions: [PrBranchTargetOption] {
    let targets = [
      PrBranchTargetOption(
        id: defaultTargetBranch,
        label: defaultTargetBranch,
        subtitle: "origin · default branch"
      )
    ]
    return targets
  }

  private func eligibility(for laneId: String) -> PrCreateLaneEligibility? {
    createCapabilities?.lanes.first(where: { $0.laneId == laneId })
  }

  private func laneEligibilitySubtitle(for lane: LaneSummary) -> String? {
    guard let eligibility = eligibility(for: lane.id) else { return nil }
    return Self.laneProgressSubtitle(for: eligibility)
  }

  private func isSourceLaneDisabled(_ lane: LaneSummary) -> Bool {
    guard let eligibility = eligibility(for: lane.id) else { return false }
    return !Self.canOpenPr(from: eligibility)
  }

  private var selectedLaneBlockedReason: String? {
    guard let lane = selectedLane, let eligibility = eligibility(for: lane.id) else { return nil }
    guard !Self.canOpenPr(from: eligibility) else { return nil }
    return Self.blockedCreateReason(for: eligibility)
  }

  private var selectedLaneCanCreate: Bool {
    guard let lane = selectedLane else { return false }
    guard let eligibility = eligibility(for: lane.id) else { return true }
    return Self.canOpenPr(from: eligibility)
  }

  private static func laneProgressSubtitle(for eligibility: PrCreateLaneEligibility) -> String? {
    guard let ahead = eligibility.commitsAheadOfBase else {
      return eligibility.dirty ? "Uncommitted edits present" : nil
    }
    let base = eligibility.defaultBaseBranch
    let commitLabel = ahead == 1 ? "1 commit" : "\(ahead) commits"
    if ahead > 0 {
      return eligibility.dirty
        ? "\(commitLabel) ahead of \(base) · uncommitted edits"
        : "Ready to open: \(commitLabel) ahead of \(base)"
    }
    return eligibility.dirty
      ? "No commits ahead of \(base) · uncommitted edits"
      : "No commits ahead of \(base)"
  }

  private static func canOpenPr(from eligibility: PrCreateLaneEligibility) -> Bool {
    guard eligibility.canCreate else { return false }
    guard let ahead = eligibility.commitsAheadOfBase else { return true }
    return ahead > 0
  }

  private static func blockedCreateReason(for eligibility: PrCreateLaneEligibility) -> String? {
    if let reason = eligibility.blockedReason, !reason.isEmpty {
      return reason
    }
    if let ahead = eligibility.commitsAheadOfBase, ahead <= 0 {
      return "No commits ahead of \(eligibility.defaultBaseBranch)."
    }
    return nil
  }

  private static func defaultPrTitle(source: String, target: String) -> String {
    let sourceName = source.trimmingCharacters(in: .whitespacesAndNewlines)
    let targetName = target.trimmingCharacters(in: .whitespacesAndNewlines)
    return "\(sourceName.isEmpty ? "Source lane" : sourceName) -> \(targetName.isEmpty ? "target" : targetName)"
  }

  private var currentDefaultTitle: String {
    let target = baseBranch.trimmingCharacters(in: .whitespacesAndNewlines)
    let resolvedTarget = target.isEmpty ? defaultTargetBranch : target
    let targetDisplayName = displayNameForTargetBranch(resolvedTarget)
    guard let option = selectedOption else { return "" }
    return Self.defaultPrTitle(source: option.title, target: targetDisplayName)
  }

  private func applyDefaultTitleIfUntouched() {
    let next = currentDefaultTitle
    guard !next.isEmpty else { return }
    let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty || title == lastAutoTitle {
      title = next
    }
    lastAutoTitle = next
  }

  private func clearLaneScopedDetailsIfChangingSource(from oldLaneId: String, to newLaneId: String) {
    guard !oldLaneId.isEmpty, !newLaneId.isEmpty, oldLaneId != newLaneId else { return }
    bodyText = ""
    labelsInput = ""
    reviewersInput = ""
  }

  private var canSubmit: Bool {
    if isSubmitting { return false }
    guard selectedLane != nil, selectedLaneCanCreate else { return false }
    let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
    let effectiveTitle = trimmedTitle.isEmpty ? currentDefaultTitle : trimmedTitle
    return !effectiveTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && !baseBranch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  var body: some View {
    if embedded {
      formScroll
        .duoPaneHeader(status: nil) {
          DuoPaneRowOnly { submitButton }
        }
        .onAppear(perform: seedSelection)
    } else {
      NavigationStack {
        formScroll
          .navigationTitle("Open pull request")
          .adeAnalyticsScreen(.pullRequestCreate)
          .navigationBarTitleDisplayMode(.inline)
          .toolbar {
            ToolbarItem(placement: .cancellationAction) {
              Button("Cancel") { dismiss() }
                .foregroundStyle(ADEColor.textSecondary)
            }
            ToolbarItem(placement: .confirmationAction) {
              submitButton
            }
            .sharedBackgroundVisibility(.hidden)
          }
          .onAppear(perform: seedSelection)
      }
    }
  }

  private var formScroll: some View {
      ScrollView {
        VStack(spacing: 0) {
          if let errorMessage, !syncService.connectionState.isHostUnreachable {
            ADENoticeCard(
              title: "Create PR failed",
              message: errorMessage,
              icon: "exclamationmark.triangle.fill",
              tint: ADEColor.danger,
              actionTitle: nil,
              action: nil
            )
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 12)
          }
          branchesSection
          detailsSection
          strategySection
          stanceSection
          reviewersSection
          labelsSection
          finalReviewSection
          Color.clear.frame(height: 72)
        }
      }
      .scrollIndicators(.hidden)
      .adeScreenBackground()
      .adeNavigationGlass()
      .onChange(of: selectedLaneId) { oldLaneId, newLaneId in
        // Reset base-branch default when lane changes so the target picker
        // tracks the new lane's recommended base instead of a stale one.
        clearLaneScopedDetailsIfChangingSource(from: oldLaneId, to: newLaneId)
        baseBranch = defaultTargetBranch
        applyDefaultTitleIfUntouched()
        errorMessage = nil
      }
      .onChange(of: baseBranch) { _, _ in
        applyDefaultTitleIfUntouched()
      }
      .sheet(isPresented: $editPresented) {
        editorSheet
      }
  }

  private func seedSelection() {
        refreshCachedLaneOptions()
        if selectedLaneId.isEmpty {
          if let initialLaneId,
             fallbackCreateLanes.contains(where: { $0.id == initialLaneId }) {
            selectedLaneId = initialLaneId
          } else if let firstEligible = eligibleLaneOptions.first {
            selectedLaneId = firstEligible.id
          } else if let firstSource = fallbackCreateLanes.first {
            selectedLaneId = firstSource.id
          }
        }
        if baseBranch.isEmpty {
          baseBranch = defaultTargetBranch
        }
        applyDefaultTitleIfUntouched()
      }

  // MARK: - Branches (source + target)

  private var branchesSection: some View {
    VStack(spacing: 0) {
      PrSectionHdr(title: "Branches")
      VStack(alignment: .leading, spacing: 14) {
        branchPickerField(label: "Source branch") {
          if fallbackCreateLanes.isEmpty {
            Text("No lanes are available to open a PR.")
              .font(.subheadline)
              .foregroundStyle(ADEColor.textSecondary)
          } else {
            WorkLanePickerDropdown(
              lanes: fallbackCreateLanes,
              selectedLaneId: $selectedLaneId,
              showsAutoCreateOption: false,
              laneSubtitle: laneEligibilitySubtitle(for:),
              isLaneDisabled: isSourceLaneDisabled(_:)
            )
          }
        }

        branchPickerField(label: "Target branch") {
          PrTargetBranchPickerDropdown(
            targets: branchTargetOptions,
            selectedBranch: $baseBranch
          )
        }

        if let lane = selectedLane {
          comparisonStats(for: lane)
        }

        if let blockedReason = selectedLaneBlockedReason {
          PrWarnBanner(text: blockedReason, tint: ADEColor.warning)
        }
      }
      .padding(14)
      .wizardCard()
      .padding(.horizontal, 16)
      .padding(.bottom, 8)
    }
  }

  private func branchPickerField<Content: View>(label: String, @ViewBuilder content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      ADEEyebrow(label)
      content()
    }
  }

  private func comparisonStats(for lane: LaneSummary) -> some View {
    let eligibility = eligibility(for: lane.id)
    let ahead = eligibility?.commitsAheadOfBase ?? lane.status.ahead
    let behind = lane.status.behind
    let dirty = eligibility?.dirty ?? lane.status.dirty

    return VStack(alignment: .leading, spacing: 8) {
      ADEEyebrow("Comparison")
      HStack(spacing: 8) {
        comparisonStat(label: "Ahead", value: "\(ahead)", tint: ADEColor.textPrimary)
        comparisonStat(label: "Behind", value: "\(behind)", tint: ADEColor.textSecondary)
        comparisonStat(
          label: "Status",
          value: dirty ? "Dirty" : "Clean",
          tint: dirty ? ADEColor.warning : ADEColor.success
        )
      }
    }
  }

  private func comparisonStat(label: String, value: String, tint: Color) -> some View {
    VStack(spacing: 4) {
      Text(value)
        .font(.adeMono(17, weight: .medium))
        .foregroundStyle(tint)
        .lineLimit(1)
        .minimumScaleFactor(0.75)
      Text(label)
        .font(.system(size: 11))
        .foregroundStyle(ADEColor.textMuted)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 9)
    .background(ADEKit.track, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
  }

  // MARK: - Details

  private var detailsSection: some View {
    VStack(spacing: 0) {
      PrSectionHdr(title: "Details")

      VStack(alignment: .leading, spacing: 10) {
        Text(title.isEmpty ? currentDefaultTitle : title)
          .font(.system(size: 15, weight: .bold))
          .tracking(-0.15)
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(3)
          .multilineTextAlignment(.leading)
          .frame(maxWidth: .infinity, alignment: .leading)

        bodyPreviewCard

        HStack(spacing: 6) {
          Button {
            editPresented = true
          } label: {
            Label("Edit", systemImage: "pencil")
          }
          .buttonStyle(ADEKitButtonStyle())

          Spacer(minLength: 0)
        }
      }
      .padding(12)
      .wizardCard()
      .padding(.horizontal, 16)
      .padding(.bottom, 8)
    }
  }

  private var bodyPreviewCard: some View {
    let previewText = bodyText.isEmpty
      ? "Edit the description to summarize the change."
      : bodyText
    return Text(previewText)
      .font(.system(size: 11.5))
      .foregroundStyle(bodyText.isEmpty ? ADEColor.textMuted : ADEColor.textSecondary)
      .lineSpacing(2)
      .multilineTextAlignment(.leading)
      .frame(maxWidth: .infinity, alignment: .leading)
      .lineLimit(6)
      .padding(.horizontal, 10)
      .padding(.vertical, 8)
      .background(ADEKit.track, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
  }

  // MARK: - Strategy

  private var strategySection: some View {
    VStack(spacing: 0) {
      PrSectionHdr(title: "Strategy")
      VStack(spacing: 0) {
        StrategyRow(
          choice: .prTarget,
          selected: strategy == .prTarget,
          onTap: { strategy = .prTarget }
        )
        PrRowSeparator()
        StrategyRow(
          choice: .laneBase,
          selected: strategy == .laneBase,
          onTap: { strategy = .laneBase }
        )
      }
      .wizardCard()
      .padding(.horizontal, 16)
      .padding(.bottom, 8)
    }
  }

  // MARK: - Stance

  private var stanceSection: some View {
    VStack(spacing: 0) {
      PrSectionHdr(title: "Stance")
      ADEKitSegmented(selection: $draft, options: [(value: true, title: "Draft"), (value: false, title: "Ready for review")])
      .padding(.horizontal, 16)
      .padding(.bottom, 10)
    }
  }

  // MARK: - Reviewers

  private var reviewersSection: some View {
    VStack(spacing: 0) {
      PrSectionHdr(title: "Reviewers") {
        PrMonoText(text: "optional", color: ADEColor.textMuted, size: 10)
      }
      VStack(alignment: .leading, spacing: 6) {
        TextField("@alice, @bob", text: $reviewersInput)
          .font(.system(size: 13, design: .monospaced))
          .foregroundStyle(ADEColor.textPrimary)
          .autocorrectionDisabled()
          .textInputAutocapitalization(.never)
          .padding(.horizontal, 14)
          .padding(.vertical, 12)
          .contentShape(Rectangle())
        Text("Comma-separated GitHub usernames (without @)")
          .font(.system(size: 10, design: .monospaced))
          .foregroundStyle(ADEColor.textMuted)
          .padding(.horizontal, 14)
          .padding(.bottom, 10)
      }
      .wizardCard()
      .padding(.horizontal, 16)
      .padding(.bottom, 8)
    }
  }

  // MARK: - Labels

  private var labelsSection: some View {
    VStack(spacing: 0) {
      PrSectionHdr(title: "Labels") {
        PrMonoText(text: "optional", color: ADEColor.textMuted, size: 10)
      }
      VStack(alignment: .leading, spacing: 6) {
        TextField("bug, enhancement, …", text: $labelsInput)
          .font(.system(size: 13, design: .monospaced))
          .foregroundStyle(ADEColor.textPrimary)
          .autocorrectionDisabled()
          .textInputAutocapitalization(.never)
          .padding(.horizontal, 14)
          .padding(.vertical, 12)
          .contentShape(Rectangle())
        Text("Comma-separated label names")
          .font(.system(size: 10, design: .monospaced))
          .foregroundStyle(ADEColor.textMuted)
          .padding(.horizontal, 14)
          .padding(.bottom, 10)
      }
      .wizardCard()
      .padding(.horizontal, 16)
      .padding(.bottom, 8)
    }
  }

  // MARK: - Final review

  private var finalReviewSection: some View {
    VStack(spacing: 0) {
      PrSectionHdr(title: "Final review") {
        PrMonoText(text: "machine action", color: ADEColor.textMuted, size: 10)
      }
      VStack(spacing: 0) {
        let steps = buildNextSteps()
        ForEach(Array(steps.enumerated()), id: \.element.id) { index, step in
          if index > 0 { PrRowSeparator() }
          NextStepRow(step: step)
        }
      }
      .wizardCard()
      .padding(.horizontal, 16)
      .padding(.bottom, 8)
    }
  }

  private func buildNextSteps() -> [NextStepItem] {
    var steps: [NextStepItem] = []
    let branch = selectedOption?.branchRef ?? selectedLane?.branchRef ?? "lane"
    steps.append(
      NextStepItem(
        id: "push",
        label: "Push \(branch) to origin",
        note: "Runs before GitHub opens the PR."
      )
    )

    let stanceLabel = draft ? "draft" : "ready"
    steps.append(
      NextStepItem(
        id: "open",
        label: "Open PR against \(baseBranch)",
        note: "Stance: \(stanceLabel)."
      )
    )

    // CODEOWNERS / required checks / Linear data isn't wired through the
    // mobile snapshot yet. Surface rows only when capabilities grow to
    // include these signals; today we hide gracefully so the checklist
    // stays honest.

    return steps
  }

  // MARK: - Submit button

  private var submitButton: some View {
    Button {
      Task { await submit() }
    } label: {
      HStack(spacing: 6) {
        if isSubmitting {
          ProgressView()
            .controlSize(.small)
            .tint(.white)
        }
        Text(submitLabel)
          .fixedSize(horizontal: true, vertical: false)
      }
    }
    .buttonStyle(ADEKitButtonStyle(prominent: true))
    .disabled(!canSubmit)
  }

  private var submitLabel: String { isSubmitting ? "Opening…" : "Open" }

  @MainActor
  private func submit() async {
    guard canSubmit else { return }
    isSubmitting = true
    errorMessage = nil
    let parsedLabels = labelsInput
      .split(separator: ",")
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }
    let parsedReviewers = reviewersInput
      .split(separator: ",")
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "@")) }
      .filter { !$0.isEmpty }

    guard let option = selectedOption, selectedLaneCanCreate else {
        isSubmitting = false
        return
      }
      let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
      let completed = await onCreateSingle(
        option.id,
        trimmedTitle.isEmpty ? currentDefaultTitle : trimmedTitle,
        bodyText,
        draft,
        baseBranch.trimmingCharacters(in: .whitespacesAndNewlines),
        parsedLabels,
        parsedReviewers,
        /* strategy */ strategy.rawValue
      )
      isSubmitting = false
      if !completed {
        errorMessage = "The pull request was not created."
      }
  }

  private func refreshCachedLaneOptions() {
    cachedLaneOptions = sourceEligibleLaneOptions
    didCacheLaneOptions = true
  }

  // MARK: - Edit sheet

  private var editorSheet: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          ADEEyebrow("Title")
          TextField("Title", text: $title, axis: .vertical)
            .font(.system(size: 14, weight: .semibold))
            .lineLimit(1...3)
            .textInputAutocapitalization(.sentences)
            .foregroundStyle(ADEColor.textPrimary)
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .adeKitCard(padding: nil)

          ADEEyebrow("Body")
          TextEditor(text: $bodyText)
            .font(.system(size: 12, design: .monospaced))
            .foregroundStyle(ADEColor.textPrimary)
            .frame(minHeight: 220)
            .scrollContentBackground(.hidden)
            .padding(10)
            .adeKitCard(padding: nil)
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 24)
      }
      .scrollContentBackground(.hidden)
      .adeScreenBackground()
      .navigationTitle("Edit draft")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { editPresented = false }
        }
      }
    }
    .presentationDetents([.large])
  }
}

// MARK: - Local helpers

fileprivate struct PrRowSeparator: View {
  var body: some View {
    Rectangle()
      .fill(ADEKit.rule)
      .frame(height: 0.75)
      .padding(.leading, 14)
  }
}

fileprivate extension View {
  func wizardCard() -> some View {
    adeKitCard(padding: nil)
  }
}

// MARK: - Row views

fileprivate enum PrStrategyChoice: String {
  case prTarget = "pr_target"
  case laneBase = "lane_base"

  var title: String {
    switch self {
    case .prTarget: return "PR target"
    case .laneBase: return "Lane base"
    }
  }

  var subtitle: String {
    switch self {
    case .prTarget:
      return "Target changes on main rebase into this PR"
    case .laneBase:
      return "PR carries an immutable base; target drift surfaces as rebase attention"
    }
  }

  var helper: String {
    switch self {
    case .prTarget: return "Recommended"
    case .laneBase: return "Best for long-lived branches"
    }
  }
}

fileprivate struct StrategyRow: View {
  let choice: PrStrategyChoice
  let selected: Bool
  let onTap: () -> Void

  var body: some View {
    Button(action: onTap) {
      HStack(alignment: .top, spacing: 10) {
        radio
        VStack(alignment: .leading, spacing: 2) {
          Text(choice.title)
            .font(.system(size: 12, weight: .bold))
            .foregroundStyle(ADEColor.textPrimary)
          Text(choice.subtitle)
            .font(.system(size: 11.5))
            .foregroundStyle(ADEColor.textSecondary)
            .lineSpacing(2)
          Text(choice.helper)
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(ADEColor.textMuted)
            .padding(.top, 2)
        }
        Spacer(minLength: 0)
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 12)
      .contentShape(Rectangle())
    }
    .buttonStyle(ADEKitRowButtonStyle())
    .accessibilityAddTraits(selected ? [.isSelected] : [])
  }

  private var radio: some View {
    ZStack {
      Circle()
        .stroke(selected ? ADEColor.accent : ADEColor.border, lineWidth: 1.5)
        .frame(width: 18, height: 18)
      if selected {
        Circle()
          .fill(ADEColor.accent)
          .frame(width: 9, height: 9)
      }
    }
    .padding(.top, 1)
  }
}

fileprivate struct NextStepItem: Identifiable, Equatable {
  let id: String
  let label: String
  let note: String?
}

fileprivate struct NextStepRow: View {
  let step: NextStepItem

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: "checkmark")
        .font(.system(size: 10, weight: .bold))
        .foregroundStyle(ADEColor.textMuted)
        .frame(width: 18, height: 18)

      VStack(alignment: .leading, spacing: 2) {
        Text(step.label)
          .font(.system(size: 12.5))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(2)

        if let note = step.note {
          Text(note)
            .font(.system(size: 10.5))
            .foregroundStyle(ADEColor.textMuted)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 10)
  }
}

// MARK: - Mode + multi-lane row views

struct CreatePrLaneOption: Identifiable, Equatable {
  let id: String
  let title: String
  let branchRef: String
  let defaultBaseBranch: String
  let subtitle: String?
}

struct PrMarkdownRenderer: View {
  /// Split once when the row is made, not on every draw: a PR thread holds
  /// one of these for each comment, and they redraw while the list scrolls.
  private let pieces: [PrDescriptionPiece]

  init(markdown: String) {
    pieces = prDescriptionPieces(normalizePrMarkdownText(markdown))
  }

  var body: some View {
    // Text with no media is one renderer, exactly as before.
    if pieces.count == 1, case .markdown(let text) = pieces[0] {
      markdownText(text)
    } else {
      VStack(alignment: .leading, spacing: 10) {
        ForEach(Array(pieces.enumerated()), id: \.offset) { _, piece in
          switch piece {
          case .markdown(let text):
            markdownText(text)
          case .media(let media):
            PrDescriptionMediaView(media: media)
          case .compare(let sides):
            PrDescriptionCompareView(sides: sides)
          }
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private func markdownText(_ text: String) -> some View {
    WorkMarkdownRenderer(markdown: text)
      .font(.system(.footnote))
      .foregroundStyle(ADEColor.textPrimary)
      .tint(ADEColor.accent)
      .frame(maxWidth: .infinity, alignment: .leading)
      // In a List row the proposed height is tight; without this, list items
      // truncate to one line instead of wrapping.
      .fixedSize(horizontal: false, vertical: true)
      .textSelection(.enabled)
  }
}

/// A picture or a video from a PR text. A picture loads when it scrolls into
/// view. A video loads nothing until the reader taps it: a PR can hold several,
/// and none may start to download on a phone before it is asked for.
struct PrDescriptionMediaView: View {
  let media: PrDescriptionMedia
  @Environment(\.openURL) private var openURL
  @State private var player: AVPlayer?
  @State private var videoFailed = false

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      switch media.kind {
      case .image:
        AsyncImage(url: media.url) { phase in
          switch phase {
          case .success(let image):
            image
              .resizable()
              .scaledToFit()
              .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
              // No tap action: a tap happens by accident during a scroll, and
              // it would leave the app. The menu is a deliberate long press.
              .contextMenu {
                Button {
                  openURL(media.url)
                } label: {
                  Label("Open on GitHub", systemImage: "arrow.up.right.square")
                }
              }
              .accessibilityLabel(media.label.isEmpty ? "Picture" : media.label)
              .accessibilityAction(named: "Open on GitHub") { openURL(media.url) }
          case .failure:
            fallbackLink
          default:
            RoundedRectangle(cornerRadius: 8, style: .continuous)
              .fill(ADEColor.textMuted.opacity(0.12))
              .frame(height: 120)
              .overlay(ProgressView())
          }
        }
      case .video:
        if videoFailed {
          // A private repository or a lost connection: the file did not load.
          fallbackLink
        } else if let player {
          VideoPlayer(player: player)
            .aspectRatio(16.0 / 9.0, contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .onReceive(player.publisher(for: \.currentItem?.status).receive(on: DispatchQueue.main)) { status in
              if status == .failed { videoFailed = true }
            }
            // A file can load and then fail part way, with no change of status.
            .onReceive(NotificationCenter.default.publisher(
              for: .AVPlayerItemFailedToPlayToEndTime,
              object: player.currentItem
            ).receive(on: DispatchQueue.main)) { _ in
              videoFailed = true
            }
        } else {
          Button {
            let next = AVPlayer(url: media.url)
            player = next
            next.play()
          } label: {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
              .fill(Color.black.opacity(0.85))
              .aspectRatio(16.0 / 9.0, contentMode: .fit)
              .overlay(
                Image(systemName: "play.circle.fill")
                  .font(.system(size: 44))
                  .foregroundStyle(.white.opacity(0.9))
              )
          }
          .buttonStyle(.plain)
          .accessibilityLabel(media.label.isEmpty ? "Play video" : "Play video: \(media.label)")
        }
      }
      if !media.label.isEmpty {
        Text(media.label)
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .onDisappear {
      player?.pause()
    }
  }

  /// Media that did not load (a private repository, no connection).
  private var fallbackLink: some View {
    Button {
      openURL(media.url)
    } label: {
      Label(
        media.label.isEmpty ? (media.kind == .video ? "Open video on GitHub" : "Open picture on GitHub") : media.label,
        systemImage: "arrow.up.right.square"
      )
        .font(.footnote)
        .frame(minHeight: 44, alignment: .leading)
    }
    .tint(ADEColor.accent)
  }
}

/// Before and after: side by side when there is room, one under the other on
/// a phone held upright.
struct PrDescriptionCompareView: View {
  let sides: [PrDescriptionCompareSide]
  @Environment(\.horizontalSizeClass) private var horizontalSizeClass

  var body: some View {
    let layout = horizontalSizeClass == .regular
      ? AnyLayout(HStackLayout(alignment: .top, spacing: 12))
      : AnyLayout(VStackLayout(alignment: .leading, spacing: 12))
    layout {
      ForEach(Array(sides.enumerated()), id: \.offset) { _, side in
        VStack(alignment: .leading, spacing: 4) {
          Text(side.title)
            .font(.caption.weight(.semibold))
            .foregroundStyle(ADEColor.textSecondary)
          PrDescriptionMediaView(media: side.media)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
  }
}
