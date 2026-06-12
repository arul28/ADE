import SwiftUI

// MARK: - Create PR mode (single / queue / integration)

enum CreatePrMode: String, CaseIterable, Identifiable {
  case single, queue, integration
  var id: String { rawValue }
  var title: String {
    switch self {
    case .single: return "Single"
    case .queue: return "Queue"
    case .integration: return "Integration"
    }
  }
  var symbol: String {
    switch self {
    case .single: return "doc.badge.plus"
    case .queue: return "rectangle.stack.badge.plus"
    case .integration: return "arrow.triangle.merge"
    }
  }
  var description: String {
    switch self {
    case .single: return "One branch, one PR"
    case .queue: return "Land multiple PRs in order, auto-rebasing"
    case .integration: return "Merge several lanes into one integration PR"
    }
  }
}

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
  /// Queue PR batch submit.
  let onCreateQueue: (CreateQueuePrsRequest) async -> Bool
  /// Integration PR submit (caller runs simulateIntegration → commitIntegration).
  let onCreateIntegration: (CreateIntegrationRequest) async -> Bool
  let initialLaneId: String?
  let singleModeOnly: Bool

  init(
    lanes: [LaneSummary],
    createCapabilities: PrCreateCapabilities? = nil,
    initialLaneId: String? = nil,
    singleModeOnly: Bool = false,
    onCreateSingle: @escaping (String, String, String, Bool, String, [String], [String], String?) async -> Bool,
    onCreateQueue: @escaping (CreateQueuePrsRequest) async -> Bool,
    onCreateIntegration: @escaping (CreateIntegrationRequest) async -> Bool
  ) {
    self.lanes = lanes
    self.createCapabilities = createCapabilities
    self.initialLaneId = initialLaneId
    self.singleModeOnly = singleModeOnly
    self.onCreateSingle = onCreateSingle
    self.onCreateQueue = onCreateQueue
    self.onCreateIntegration = onCreateIntegration
  }

  @State private var createMode: CreatePrMode = .single
  @State private var selectedLaneId = ""
  @State private var selectedLaneIds: Set<String> = []
  @State private var baseBranch = ""
  @State private var title = ""
  @State private var bodyText = ""
  @State private var draft = true
  @State private var strategy: PrStrategyChoice = .prTarget
  @State private var labelsInput = ""
  @State private var reviewersInput = ""
  @State private var isGenerating = false
  @State private var isSubmitting = false
  @State private var errorMessage: String?
  @State private var editPresented = false
  @State private var draftLoadedOnce = false
  // Queue / integration-only state.
  @State private var queueName = ""
  @State private var autoRebase = true
  @State private var ciGating = true
  @State private var integrationLaneName = ""
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
            defaultTitle: eligibility.defaultTitle,
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
        defaultTitle: lane.name,
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
      defaultTitle: eligibility?.defaultTitle ?? lane.name,
      subtitle: eligibility.map { Self.laneProgressSubtitle(for: $0) } ?? nil
    )
  }

  private var selectedLane: LaneSummary? {
    guard !selectedLaneId.isEmpty else { return nil }
    return lanes.first(where: { $0.id == selectedLaneId })
  }

  /// Integration branches derived from other lanes of type "integration".
  /// These are surfaced alongside the repo default as legal PR targets.
  private var integrationTargets: [IntegrationTargetOption] {
    lanes
      .filter { $0.archivedAt == nil && $0.laneType == "integration" && $0.id != selectedOption?.id }
      .map { lane in
        let childNote: String = {
          switch lane.childCount {
          case 0: return "integration"
          case 1: return "stacked · 1 child"
          default: return "stacked · \(lane.childCount) children"
          }
        }()
        return IntegrationTargetOption(
          id: lane.branchRef,
          branchRef: lane.branchRef,
          subtitle: childNote
        )
      }
  }

  private var defaultTargetBranch: String {
    selectedOption?.defaultBaseBranch
      ?? createCapabilities?.defaultBaseBranch
      ?? "main"
  }

  private var branchTargetOptions: [PrBranchTargetOption] {
    var targets = [
      PrBranchTargetOption(
        id: defaultTargetBranch,
        label: defaultTargetBranch,
        subtitle: "origin · default branch"
      )
    ]
    for integration in integrationTargets {
      targets.append(
        PrBranchTargetOption(
          id: integration.id,
          label: integration.branchRef,
          subtitle: integration.subtitle
        )
      )
    }
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

  private var canSubmit: Bool {
    if isSubmitting { return false }
    switch createMode {
    case .single:
      guard selectedLane != nil, selectedLaneCanCreate else { return false }
      let hasTitle = !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      let hasBase = !baseBranch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      return hasTitle && hasBase
    case .queue:
      return selectedLaneIds.count >= 1
    case .integration:
      let hasName = !integrationLaneName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      let hasTitle = !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      return selectedLaneIds.count >= 2 && hasName && hasTitle
    }
  }

  private var backdrop: some View {
    prLiquidGlassBackdrop()
      .ignoresSafeArea()
  }

  var body: some View {
    NavigationStack {
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
          if !singleModeOnly {
            modeSelectorSection
          }
          switch createMode {
          case .single:
            branchesSection
            aiTitleSection
            strategySection
            stanceSection
            reviewersSection
            labelsSection
            finalReviewSection
          case .queue:
            multiLaneSection(mode: .queue)
            targetBranchSection(title: "Target branch")
            queueSettingsSection
            stanceSection
            reviewersSection
            labelsSection
            queueReviewSection
          case .integration:
            multiLaneSection(mode: .integration)
            targetBranchSection(title: "Target branch")
            integrationSettingsSection
            aiTitleSection
            stanceSection
            reviewersSection
            labelsSection
            integrationReviewSection
          }
          Color.clear.frame(height: 72)
        }
      }
      .scrollIndicators(.hidden)
      .background(backdrop)
      .adeNavigationGlass()
      .navigationTitle("Open pull request")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
            .foregroundStyle(ADEColor.textSecondary)
        }
        ToolbarItem(placement: .confirmationAction) {
          submitButton
        }
      }
      .onAppear {
        if singleModeOnly {
          createMode = .single
        }
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
        if !draftLoadedOnce, selectedLane != nil, selectedLaneCanCreate {
          draftLoadedOnce = true
          Task { await generateDraft(initial: true) }
        }
      }
      .onChange(of: selectedLaneId) { _, _ in
        // Reset base-branch default when lane changes so the target picker
        // tracks the new lane's recommended base instead of a stale one.
        baseBranch = defaultTargetBranch
        title = selectedOption?.defaultTitle ?? ""
        bodyText = ""
        labelsInput = ""
        reviewersInput = ""
        errorMessage = nil
        if selectedLaneCanCreate {
          Task { await generateDraft(initial: false) }
        }
      }
      .onChange(of: createMode) { _, newValue in
        // Reset shared fields when flipping modes so stale values from the
        // previous mode's submit don't leak over.
        errorMessage = nil
        if newValue == .single {
          // Restore single-mode defaults using the currently selected lane.
          title = selectedOption?.defaultTitle ?? ""
          if selectedOption != nil {
            Task { await generateDraft(initial: false) }
          }
        } else {
          // Queue + integration share the multi-select; reset the title input
          // so it doesn't carry over the single-lane suggestion.
          title = ""
          bodyText = ""
          // Seed integration name so the form feels started.
          if newValue == .integration && integrationLaneName.isEmpty {
            integrationLaneName = "integration/\(Int(Date().timeIntervalSince1970))"
          }
        }
      }
      .sheet(isPresented: $editPresented) {
        editorSheet
      }
    }
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
      Text(label.uppercased())
        .font(.system(size: 10, weight: .bold))
        .tracking(1.0)
        .foregroundStyle(ADEColor.textSecondary)
      content()
    }
  }

  private func comparisonStats(for lane: LaneSummary) -> some View {
    let eligibility = eligibility(for: lane.id)
    let ahead = eligibility?.commitsAheadOfBase ?? lane.status.ahead
    let behind = lane.status.behind
    let dirty = eligibility?.dirty ?? lane.status.dirty

    return VStack(alignment: .leading, spacing: 8) {
      Text("COMPARISON")
        .font(.system(size: 10, weight: .bold))
        .tracking(1.0)
        .foregroundStyle(ADEColor.textSecondary)
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
        .font(.system(size: 18, weight: .bold, design: .rounded))
        .foregroundStyle(tint)
        .lineLimit(1)
        .minimumScaleFactor(0.75)
      Text(label.uppercased())
        .font(.system(size: 9, weight: .bold))
        .tracking(0.8)
        .foregroundStyle(ADEColor.textMuted)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 10)
    .background(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .fill(PrGlassPalette.ink.opacity(0.45))
    )
    .overlay(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .strokeBorder(Color.white.opacity(0.08), lineWidth: 0.5)
    )
  }

  private func targetBranchSection(title: String) -> some View {
    VStack(spacing: 0) {
      PrSectionHdr(title: title)
      VStack(alignment: .leading, spacing: 6) {
        PrTargetBranchPickerDropdown(
          targets: branchTargetOptions,
          selectedBranch: $baseBranch
        )
      }
      .padding(14)
      .wizardCard()
      .padding(.horizontal, 16)
      .padding(.bottom, 8)
    }
  }

  // MARK: - AI-drafted title card

  private var aiTitleSection: some View {
    VStack(spacing: 0) {
      PrSectionHdr(title: "Title") {
        HStack(spacing: 4) {
          Image(systemName: "sparkles")
            .font(.system(size: 9, weight: .semibold))
          PrMonoText(text: "sonnet-4.6", color: ADEColor.purpleAccent, size: 10)
        }
        .foregroundStyle(ADEColor.purpleAccent)
      }

      VStack(alignment: .leading, spacing: 10) {
        if isGenerating && title.isEmpty {
          HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text("Drafting title and body…")
              .font(.footnote)
              .foregroundStyle(ADEColor.textSecondary)
          }
        } else {
          Text(title.isEmpty ? "Untitled change" : title)
            .font(.system(size: 15, weight: .bold))
            .tracking(-0.15)
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(3)
            .multilineTextAlignment(.leading)
            .frame(maxWidth: .infinity, alignment: .leading)
        }

        bodyPreviewCard

        HStack(spacing: 6) {
          Button {
            Task { await generateDraft(initial: false) }
          } label: {
            HStack(spacing: 4) {
              Image(systemName: "sparkles")
                .font(.system(size: 10, weight: .semibold))
              Text("Regenerate")
                .font(.system(size: 11, weight: .semibold))
            }
            .foregroundStyle(ADEColor.textSecondary)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(
              RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(ADEColor.textPrimary.opacity(0.04))
            )
            .overlay(
              RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(ADEColor.border.opacity(0.5), lineWidth: 0.5)
            )
          }
          .buttonStyle(.plain)
          .disabled(isGenerating || selectedLane == nil || !selectedLaneCanCreate)

          Button {
            editPresented = true
          } label: {
            Text("Edit")
              .font(.system(size: 11, weight: .semibold))
              .foregroundStyle(ADEColor.textSecondary)
              .padding(.horizontal, 10)
              .padding(.vertical, 5)
              .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                  .fill(ADEColor.textPrimary.opacity(0.04))
              )
              .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                  .stroke(ADEColor.border.opacity(0.5), lineWidth: 0.5)
              )
          }
          .buttonStyle(.plain)

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
      ? "Generate or edit a description to summarize the change."
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
      .background(
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .fill(ADEColor.purpleAccent.opacity(0.08))
      )
      .overlay(
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .stroke(ADEColor.purpleAccent.opacity(0.2), lineWidth: 0.5)
      )
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

  // MARK: - Strategy

  private var stanceSection: some View {
    VStack(spacing: 0) {
      PrSectionHdr(title: "Stance")
      HStack(spacing: 2) {
        StanceSegment(
          label: "Draft",
          active: draft,
          action: { draft = true }
        )
        StanceSegment(
          label: "Ready for review",
          active: !draft,
          action: { draft = false }
        )
      }
      .padding(3)
      .background(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .fill(PrGlassPalette.ink.opacity(0.45))
      )
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .strokeBorder(Color.white.opacity(0.08), lineWidth: 0.5)
      )
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
        PrMonoText(text: "machine action", color: ADEColor.warning, size: 10)
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

  // MARK: - Mode selector

  private var modeSelectorSection: some View {
    VStack(spacing: 0) {
      PrSectionHdr(title: "Mode")
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 8) {
          ForEach(CreatePrMode.allCases) { mode in
            ModeCard(
              mode: mode,
              selected: mode == createMode,
              action: { createMode = mode }
            )
            .frame(width: 148)
          }
        }
        .padding(.horizontal, 16)
      }
      .padding(.bottom, 12)
    }
  }

  // MARK: - Multi-lane select (queue + integration)

  @ViewBuilder
  private func multiLaneSection(mode: CreatePrMode) -> some View {
    let options = cachedLaneOptions.isEmpty ? eligibleLaneOptions : cachedLaneOptions
    VStack(spacing: 0) {
      PrSectionHdr(title: "Lanes") {
        let minCount = mode == .integration ? 2 : 1
        let label = selectedLaneIds.count >= minCount
          ? "\(selectedLaneIds.count) selected"
          : "select \(minCount)+"
        PrMonoText(text: label, color: ADEColor.textMuted, size: 10)
      }
      if options.isEmpty {
        Text("No lanes are eligible to open a PR right now.")
          .font(.subheadline)
          .foregroundStyle(ADEColor.textSecondary)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(14)
          .wizardCard()
          .padding(.horizontal, 16)
          .padding(.bottom, 8)
      } else {
        LazyVStack(spacing: 0) {
          ForEach(Array(options.enumerated()), id: \.element.id) { index, option in
            if index > 0 { PrRowSeparator() }
            Button {
              toggleLaneSelection(option.id)
            } label: {
              MultiLaneRow(option: option, selected: selectedLaneIds.contains(option.id))
            }
            .buttonStyle(.plain)
          }
        }
        .wizardCard()
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
      }
    }
  }

  private func toggleLaneSelection(_ id: String) {
    if selectedLaneIds.contains(id) {
      selectedLaneIds.remove(id)
    } else {
      selectedLaneIds.insert(id)
    }
    errorMessage = nil
  }

  // MARK: - Queue settings

  private var queueSettingsSection: some View {
    VStack(spacing: 0) {
      PrSectionHdr(title: "Queue")
      VStack(alignment: .leading, spacing: 10) {
        TextField("queue name (optional)", text: $queueName)
          .font(.system(size: 13, design: .monospaced))
          .foregroundStyle(ADEColor.textPrimary)
          .autocorrectionDisabled()
          .textInputAutocapitalization(.never)
          .padding(.horizontal, 14)
          .padding(.vertical, 12)
          .prGlassCard(cornerRadius: 14)

        Toggle(isOn: $autoRebase) {
          VStack(alignment: .leading, spacing: 2) {
            Text("Auto-rebase")
              .font(.system(size: 13, weight: .semibold))
              .foregroundStyle(ADEColor.textPrimary)
            Text("Rebase each PR on the one ahead of it as the queue lands.")
              .font(.system(size: 11))
              .foregroundStyle(ADEColor.textMuted)
          }
        }
        .tint(PrGlassPalette.purpleBright)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .prGlassCard(cornerRadius: 14)

        Toggle(isOn: $ciGating) {
          VStack(alignment: .leading, spacing: 2) {
            Text("CI gating")
              .font(.system(size: 13, weight: .semibold))
              .foregroundStyle(ADEColor.textPrimary)
            Text("Wait for green checks before advancing to the next PR.")
              .font(.system(size: 11))
              .foregroundStyle(ADEColor.textMuted)
          }
        }
        .tint(PrGlassPalette.purpleBright)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .prGlassCard(cornerRadius: 14)
      }
      .padding(.horizontal, 16)
      .padding(.bottom, 10)
    }
  }

  // MARK: - Integration settings

  private var integrationSettingsSection: some View {
    VStack(spacing: 0) {
      PrSectionHdr(title: "Integration branch")
      VStack(alignment: .leading, spacing: 6) {
        TextField("integration/my-batch", text: $integrationLaneName)
          .font(.system(size: 13, design: .monospaced))
          .foregroundStyle(ADEColor.textPrimary)
          .autocorrectionDisabled()
          .textInputAutocapitalization(.never)
          .padding(.horizontal, 14)
          .padding(.vertical, 12)
          .prGlassCard(cornerRadius: 14)
        Text("Name the integration lane that will carry the merged work.")
          .font(.system(size: 10, design: .monospaced))
          .foregroundStyle(ADEColor.textMuted)
          .padding(.horizontal, 14)
      }
      .padding(.horizontal, 16)
      .padding(.bottom, 10)
    }
  }

  // MARK: - Review (queue + integration)

  private var queueReviewSection: some View {
    VStack(spacing: 0) {
      PrSectionHdr(title: "Review") {
        PrMonoText(text: "queue", color: ADEColor.purpleAccent, size: 10)
      }
      let count = selectedLaneIds.count
      let base = baseBranch.isEmpty ? defaultTargetBranch : baseBranch
      VStack(alignment: .leading, spacing: 6) {
        ReviewLine(label: "PRs to open", value: "\(count)")
        ReviewLine(label: "Target", value: base)
        ReviewLine(label: "Auto-rebase", value: autoRebase ? "on" : "off")
        ReviewLine(label: "CI gating", value: ciGating ? "on" : "off")
        if !queueName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
          ReviewLine(label: "Queue", value: queueName)
        }
      }
      .padding(14)
      .wizardCard()
      .padding(.horizontal, 16)
      .padding(.bottom, 8)
    }
  }

  private var integrationReviewSection: some View {
    VStack(spacing: 0) {
      PrSectionHdr(title: "Review") {
        PrMonoText(text: "integration", color: ADEColor.purpleAccent, size: 10)
      }
      let count = selectedLaneIds.count
      let base = baseBranch.isEmpty ? defaultTargetBranch : baseBranch
      VStack(alignment: .leading, spacing: 6) {
        ReviewLine(label: "Source lanes", value: "\(count)")
        ReviewLine(label: "Integration lane", value: integrationLaneName.isEmpty ? "—" : integrationLaneName)
        ReviewLine(label: "Target", value: base)
        ReviewLine(label: "Stance", value: draft ? "draft" : "ready")
      }
      .padding(14)
      .wizardCard()
      .padding(.horizontal, 16)
      .padding(.bottom, 8)
    }
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
          .font(.system(size: 12, weight: .bold))
          .foregroundStyle(.white)
          .lineLimit(1)
          .fixedSize(horizontal: true, vertical: false)
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 7)
      .background(
        PrGlassPalette.accentGradient,
        in: RoundedRectangle(cornerRadius: 12, style: .continuous)
      )
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .strokeBorder(Color.white.opacity(0.24), lineWidth: 0.5)
      )
      .overlay(
        RoundedRectangle(cornerRadius: 11, style: .continuous)
          .inset(by: 1)
          .stroke(Color.white.opacity(0.18), lineWidth: 0.5)
          .blendMode(.plusLighter)
      )
      .shadow(color: PrGlassPalette.purpleDeep.opacity(canSubmit ? 0.55 : 0), radius: 12, y: 4)
      .opacity(canSubmit ? 1.0 : 0.45)
    }
    .buttonStyle(.plain)
    .disabled(!canSubmit)
  }

  private var submitLabel: String {
    if isSubmitting {
      switch createMode {
      case .single: return "Opening…"
      case .queue: return "Queueing…"
      case .integration: return "Merging…"
      }
    }
    switch createMode {
    case .single: return "Open"
    case .queue: return "Queue"
    case .integration: return "Integrate"
    }
  }

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

    switch createMode {
    case .single:
      guard let option = selectedOption, selectedLaneCanCreate else {
        isSubmitting = false
        return
      }
      let completed = await onCreateSingle(
        option.id,
        title.trimmingCharacters(in: .whitespacesAndNewlines),
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
    case .queue:
      let laneIds = orderedSelectedLaneIds
      let trimmedName = queueName.trimmingCharacters(in: .whitespacesAndNewlines)
      let baseTrim = baseBranch.trimmingCharacters(in: .whitespacesAndNewlines)
      let targetBranch = baseTrim.isEmpty ? defaultTargetBranch : baseTrim
      let completed = await onCreateQueue(
        CreateQueuePrsRequest(
          laneIds: laneIds,
          queueName: trimmedName.isEmpty ? nil : trimmedName,
          draft: draft,
          autoRebase: autoRebase,
          ciGating: ciGating,
          // v2 TODO: per-lane title overrides.
          titles: nil,
          baseBranch: targetBranch
        )
      )
      isSubmitting = false
      if !completed {
        errorMessage = "The queue PRs were not created."
      }
    case .integration:
      let laneIds = orderedSelectedLaneIds
      let trimmedName = integrationLaneName.trimmingCharacters(in: .whitespacesAndNewlines)
      let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
      let baseTrim = baseBranch.trimmingCharacters(in: .whitespacesAndNewlines)
      let targetBranch = baseTrim.isEmpty ? defaultTargetBranch : baseTrim
      let completed = await onCreateIntegration(
        CreateIntegrationRequest(
          sourceLaneIds: laneIds,
          integrationLaneName: trimmedName,
          title: trimmedTitle,
          body: bodyText,
          draft: draft,
          baseBranch: targetBranch
        )
      )
      isSubmitting = false
      if !completed {
        errorMessage = "The integration PR was not created."
      }
    }
  }

  private var orderedSelectedLaneIds: [String] {
    // Preserve eligibleLaneOptions order so multi-lane submits are deterministic.
    eligibleLaneOptions.map(\.id).filter { selectedLaneIds.contains($0) }
  }

  private func refreshCachedLaneOptions() {
    cachedLaneOptions = sourceEligibleLaneOptions
    didCacheLaneOptions = true
  }

  // MARK: - Draft generation

  @MainActor
  private func generateDraft(initial: Bool) async {
    guard selectedLaneCanCreate, let option = selectedOption else { return }
    isGenerating = true
    defer { isGenerating = false }

    do {
      let suggestion: PullRequestDraftSuggestion
      if syncService.supportsRemoteAction("prs.draftDescription") {
        suggestion = try await syncService.draftPullRequestDescription(laneId: option.id)
      } else if let lane = lanes.first(where: { $0.id == option.id }) {
        let detail = try? await syncService.refreshLaneDetail(laneId: option.id)
        suggestion = prHeuristicDraft(lane: lane, detail: detail)
      } else {
        suggestion = PullRequestDraftSuggestion(title: option.defaultTitle, body: "")
      }

      // On the initial auto-fetch, don't stomp user edits if they appeared
      // between the onAppear trigger and the await resolving.
      if initial && (!title.isEmpty || !bodyText.isEmpty) {
        return
      }
      title = suggestion.title
      bodyText = suggestion.body
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  // MARK: - Edit sheet

  private var editorSheet: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          // 4x5 grab handle
          Capsule()
            .fill(Color.white.opacity(0.25))
            .frame(width: 40, height: 5)
            .frame(maxWidth: .infinity)
            .padding(.top, 4)
            .padding(.bottom, 6)

          PrEyebrow(text: "Title")
          TextField("Title", text: $title, axis: .vertical)
            .font(.system(size: 14, weight: .semibold))
            .lineLimit(1...3)
            .textInputAutocapitalization(.sentences)
            .foregroundStyle(ADEColor.textPrimary)
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .prGlassCard(cornerRadius: 14)

          PrEyebrow(text: "Body")
          TextEditor(text: $bodyText)
            .font(.system(size: 12, design: .monospaced))
            .foregroundStyle(ADEColor.textPrimary)
            .frame(minHeight: 220)
            .scrollContentBackground(.hidden)
            .padding(10)
            .prGlassCard(cornerRadius: 14)
        }
        .padding(.horizontal, 18)
        .padding(.bottom, 24)
      }
      .scrollContentBackground(.hidden)
      .background(prLiquidGlassBackdrop().ignoresSafeArea())
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
      .fill(ADEColor.border.opacity(0.4))
      .frame(height: 0.5)
      .padding(.leading, 14)
  }
}

fileprivate extension View {
  func wizardCard() -> some View {
    prGlassCard(cornerRadius: 18)
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
    case .prTarget: return "Recommended · auto-rebase on"
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
        RoundedRectangle(cornerRadius: 2, style: .continuous)
          .fill(
            LinearGradient(
              colors: [PrGlassPalette.purpleBright, PrGlassPalette.purpleDeep],
              startPoint: .top, endPoint: .bottom
            )
          )
          .frame(width: 3)
          .opacity(selected ? 1.0 : 0.0)
          .shadow(color: PrGlassPalette.purple.opacity(selected ? 0.5 : 0), radius: 6)

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
            .foregroundStyle(selected ? PrGlassPalette.purple : ADEColor.textMuted)
            .padding(.top, 2)
        }
        Spacer(minLength: 0)
      }
      .padding(.leading, 10)
      .padding(.trailing, 14)
      .padding(.vertical, 12)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }

  private var radio: some View {
    ZStack {
      Circle()
        .stroke(selected ? PrGlassPalette.purple : ADEColor.border, lineWidth: 1.5)
        .frame(width: 20, height: 20)
      if selected {
        Circle()
          .fill(PrGlassPalette.purple)
          .frame(width: 20, height: 20)
        Circle()
          .fill(PrGlassPalette.ink)
          .frame(width: 7, height: 7)
      }
    }
    .padding(.top, 1)
  }
}

fileprivate struct IntegrationTargetOption: Identifiable, Equatable {
  let id: String
  let branchRef: String
  let subtitle: String
}

fileprivate struct StanceSegment: View {
  let label: String
  let active: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Text(label)
        .font(.system(size: 12.5, weight: .semibold))
        .foregroundStyle(active ? Color.white : ADEColor.textSecondary)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 9)
        .background(
          ZStack {
            if active {
              RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(PrGlassPalette.accentGradient)
            }
          }
        )
        .overlay(
          RoundedRectangle(cornerRadius: 10, style: .continuous)
            .strokeBorder(active ? Color.white.opacity(0.24) : Color.clear, lineWidth: 0.5)
        )
        .overlay(
          RoundedRectangle(cornerRadius: 9, style: .continuous)
            .inset(by: 1)
            .stroke(active ? Color.white.opacity(0.18) : Color.clear, lineWidth: 0.5)
            .blendMode(.plusLighter)
        )
        .shadow(color: active ? PrGlassPalette.purpleDeep.opacity(0.5) : .clear, radius: 10, y: 3)
    }
    .buttonStyle(.plain)
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
      ZStack {
        Circle()
          .fill(ADEColor.success.opacity(0.16))
        Circle()
          .stroke(ADEColor.success.opacity(0.3), lineWidth: 0.5)
        Image(systemName: "checkmark")
          .font(.system(size: 9, weight: .heavy))
          .foregroundStyle(ADEColor.success)
      }
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

fileprivate struct ModeCard: View {
  let mode: CreatePrMode
  let selected: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      VStack(alignment: .leading, spacing: 8) {
        HStack(spacing: 6) {
          Image(systemName: mode.symbol)
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(selected ? Color.white : ADEColor.textSecondary)
          Text(mode.title)
            .font(.system(size: 12, weight: .bold))
            .foregroundStyle(selected ? Color.white : PrGlassPalette.textPrimary)
            .lineLimit(1)
            .minimumScaleFactor(0.75)
          Spacer(minLength: 0)
          if selected {
            Circle()
              .fill(PrGlassPalette.accentGradient)
              .frame(width: 6, height: 6)
          }
        }
        Text(mode.description)
          .font(.system(size: 10.5))
          .foregroundStyle(selected ? Color.white.opacity(0.82) : ADEColor.textMuted)
          .lineLimit(2)
          .multilineTextAlignment(.leading)
          .fixedSize(horizontal: false, vertical: true)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, 10)
      .padding(.vertical, 10)
      .frame(minHeight: 72, alignment: .topLeading)
      .background(
        RoundedRectangle(cornerRadius: 14, style: .continuous)
          .fill(selected ? PrGlassPalette.purpleDeep.opacity(0.42) : PrGlassPalette.ink.opacity(0.45))
      )
      .overlay(
        RoundedRectangle(cornerRadius: 14, style: .continuous)
          .strokeBorder(
            selected ? Color.white.opacity(0.28) : Color.white.opacity(0.08),
            lineWidth: 0.5
          )
      )
      .overlay(
        RoundedRectangle(cornerRadius: 14, style: .continuous)
          .inset(by: 1)
          .stroke(Color.white.opacity(selected ? 0.22 : 0), lineWidth: 0.5)
          .blendMode(.plusLighter)
      )
      .shadow(color: selected ? PrGlassPalette.purpleDeep.opacity(0.55) : .clear, radius: 12, y: 3)
      .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
    .buttonStyle(.plain)
  }
}

fileprivate struct MultiLaneRow: View {
  let option: CreatePrLaneOption
  let selected: Bool

  var body: some View {
    HStack(spacing: 10) {
      ZStack {
        if selected {
          Circle()
            .fill(PrGlassPalette.accentGradient)
            .frame(width: 22, height: 22)
          Image(systemName: "checkmark")
            .font(.system(size: 11, weight: .bold))
            .foregroundStyle(.white)
        } else {
          Circle()
            .strokeBorder(ADEColor.border.opacity(0.6), lineWidth: 1)
            .frame(width: 22, height: 22)
        }
      }

      VStack(alignment: .leading, spacing: 1) {
        Text(option.title)
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
        Text(option.branchRef)
          .font(.system(size: 10.5, design: .monospaced))
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(1)
        if let subtitle = option.subtitle, !subtitle.isEmpty {
          Text(subtitle)
            .font(.system(size: 10))
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(1)
        }
      }
      Spacer(minLength: 0)
    }
    .padding(.leading, 12)
    .padding(.trailing, 14)
    .padding(.vertical, 11)
    .contentShape(Rectangle())
  }
}

fileprivate struct ReviewLine: View {
  let label: String
  let value: String

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Text(label)
        .font(.system(size: 11, design: .monospaced))
        .foregroundStyle(ADEColor.textMuted)
        .frame(width: 120, alignment: .leading)
      Text(value)
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(2)
        .multilineTextAlignment(.leading)
      Spacer(minLength: 0)
    }
  }
}

// MARK: - Shared types

/// Unified lane option for the wizard picker — abstracts both the legacy
/// LaneSummary list and the host-provided PrCreateLaneEligibility entries.
struct CreatePrLaneOption: Identifiable, Equatable {
  let id: String
  let title: String
  let branchRef: String
  let defaultBaseBranch: String
  let defaultTitle: String
  let subtitle: String?
}

/// Queue-PR batch submit payload passed from the wizard to the host.
struct CreateQueuePrsRequest: Equatable {
  let laneIds: [String]
  let queueName: String?
  let draft: Bool
  let autoRebase: Bool
  let ciGating: Bool
  /// Per-lane title overrides, keyed by laneId. v1 leaves this nil and lets
  /// the host derive defaults; v2 will expose a disclosure for editing.
  let titles: [String: String]?
  let baseBranch: String?
}

/// Integration-PR submit payload. Caller runs simulateIntegration →
/// commitIntegration in sequence.
struct CreateIntegrationRequest: Equatable {
  let sourceLaneIds: [String]
  let integrationLaneName: String
  let title: String
  let body: String
  let draft: Bool
  let baseBranch: String?
}

struct PrMarkdownRenderer: View {
  let markdown: String

  private var attributed: AttributedString? {
    if let cached = PrMarkdownRenderingCache.shared.attributedString(for: markdown) {
      return cached
    }

    guard let parsed = try? AttributedString(
      markdown: markdown,
      options: AttributedString.MarkdownParsingOptions(
        interpretedSyntax: .full,
        failurePolicy: .returnPartiallyParsedIfPossible
      )
    ) else {
      return nil
    }

    PrMarkdownRenderingCache.shared.store(parsed, for: markdown)
    return parsed
  }

  var body: some View {
    Group {
      if let attributed {
        Text(attributed)
          .foregroundStyle(ADEColor.textPrimary)
          .frame(maxWidth: .infinity, alignment: .leading)
          .textSelection(.enabled)
      } else {
        Text(markdown)
          .foregroundStyle(ADEColor.textPrimary)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
  }
}
