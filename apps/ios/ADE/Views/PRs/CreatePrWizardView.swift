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
  /// Parameters: laneId, title, body, draft, baseBranch, labels, reviewers, strategy ("pr_target" | "lane_base").
  let onCreate: (String, String, String, Bool, String, [String], [String], String?) -> Void

  init(
    lanes: [LaneSummary],
    createCapabilities: PrCreateCapabilities? = nil,
    onCreate: @escaping (String, String, String, Bool, String, [String], [String], String?) -> Void
  ) {
    self.lanes = lanes
    self.createCapabilities = createCapabilities
    self.onCreate = onCreate
  }

  @State private var selectedLaneId = ""
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

  private var fallbackCreateLanes: [LaneSummary] {
    lanes.filter { $0.archivedAt == nil && $0.laneType != "primary" }
  }

  private var eligibleLaneOptions: [CreatePrLaneOption] {
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

  private var blockedLaneOptions: [PrCreateLaneEligibility] {
    guard let capabilities = createCapabilities else { return [] }
    return capabilities.lanes.filter { !Self.canOpenPr(from: $0) }
  }

  private var selectedOption: CreatePrLaneOption? {
    eligibleLaneOptions.first(where: { $0.id == selectedLaneId }) ?? eligibleLaneOptions.first
  }

  private var selectedLane: LaneSummary? {
    guard let id = selectedOption?.id else { return nil }
    return lanes.first(where: { $0.id == id })
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

  private var availableTargets: [TargetOption] {
    var targets: [TargetOption] = []
    targets.append(
      TargetOption(
        id: defaultTargetBranch,
        icon: "∙",
        label: defaultTargetBranch,
        subtitle: "origin · default branch"
      )
    )
    for integration in integrationTargets {
      targets.append(
        TargetOption(
          id: integration.id,
          icon: "↯",
          label: integration.branchRef,
          subtitle: integration.subtitle
        )
      )
    }
    return targets
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
    guard selectedOption != nil else { return false }
    let hasTitle = !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    let hasBase = !baseBranch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    return hasTitle && hasBase && !isSubmitting
  }

  private var branchRefForHeader: String {
    (selectedOption?.branchRef ?? selectedLane?.branchRef ?? "lane").uppercased()
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: 0) {
          dragHandle
          heroHeader
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
            .padding(.bottom, 12)
          }
          laneSection
          aiTitleSection
          strategySection
          targetSection
          stanceSection
          reviewersSection
          labelsSection
          whatHappensNextSection
          Color.clear.frame(height: 40)
        }
      }
      .scrollIndicators(.hidden)
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("")
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
        if selectedLaneId.isEmpty {
          selectedLaneId = selectedOption?.id ?? ""
        }
        if baseBranch.isEmpty {
          baseBranch = defaultTargetBranch
        }
        if !draftLoadedOnce, selectedOption != nil {
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
        if selectedOption != nil {
          Task { await generateDraft(initial: false) }
        }
      }
      .sheet(isPresented: $editPresented) {
        editorSheet
      }
    }
  }

  // MARK: - Hero chrome

  private var dragHandle: some View {
    HStack {
      Spacer()
      RoundedRectangle(cornerRadius: 2, style: .continuous)
        .fill(ADEColor.textSecondary.opacity(0.28))
        .frame(width: 36, height: 4)
      Spacer()
    }
    .padding(.top, 8)
    .padding(.bottom, 4)
  }

  private var heroHeader: some View {
    VStack(alignment: .leading, spacing: 6) {
      PrEyebrow(text: "NEW PR · \(branchRefForHeader)")
      Text("Open pull request")
        .font(.system(size: 28, weight: .heavy, design: .default))
        .tracking(-0.7)
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(2)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.horizontal, 22)
    .padding(.top, 4)
    .padding(.bottom, 14)
  }

  // MARK: - Lane picker (only shown when multiple lanes are eligible)

  @ViewBuilder
  private var laneSection: some View {
    if eligibleLaneOptions.count > 1 {
      PrSectionHdr(title: "Lane")
      VStack(spacing: 0) {
        ForEach(Array(eligibleLaneOptions.enumerated()), id: \.element.id) { index, option in
          if index > 0 { PrRowSeparator() }
          Button {
            selectedLaneId = option.id
          } label: {
            LaneRow(option: option, selected: option.id == selectedOption?.id)
          }
          .buttonStyle(.plain)
        }
      }
      .wizardCard()
      .padding(.horizontal, 16)
      .padding(.bottom, 8)

      if !blockedLaneOptions.isEmpty {
        blockedLanesNotice
      }
    } else if eligibleLaneOptions.isEmpty {
      PrSectionHdr(title: "Lane")
      Text("No lanes are eligible to open a PR right now.")
        .font(.subheadline)
        .foregroundStyle(ADEColor.textSecondary)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .wizardCard()
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
    }
  }

  private var blockedLanesNotice: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 6) {
        Image(systemName: "lock.fill")
          .font(.caption2.weight(.semibold))
          .foregroundStyle(ADEColor.warning)
        Text("Not eligible (\(blockedLaneOptions.count))")
          .font(.caption2.weight(.semibold))
          .foregroundStyle(ADEColor.textSecondary)
      }
      ForEach(blockedLaneOptions) { entry in
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Text(entry.laneName)
            .font(.caption.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          if let reason = Self.blockedCreateReason(for: entry), !reason.isEmpty {
            Text(reason)
              .font(.caption2)
              .foregroundStyle(ADEColor.textMuted)
              .lineLimit(2)
          }
          Spacer(minLength: 0)
        }
      }
    }
    .padding(.horizontal, 22)
    .padding(.bottom, 12)
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
          .disabled(isGenerating || selectedOption == nil)

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

  // MARK: - Target

  private var targetSection: some View {
    VStack(spacing: 0) {
      PrSectionHdr(title: "Target")
      VStack(spacing: 0) {
        ForEach(Array(availableTargets.enumerated()), id: \.element.id) { index, target in
          if index > 0 { PrRowSeparator() }
          Button {
            baseBranch = target.id
          } label: {
            TargetRowView(target: target, selected: target.id == baseBranch)
          }
          .buttonStyle(.plain)
        }
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
        RoundedRectangle(cornerRadius: 11, style: .continuous)
          .fill(ADEColor.recessedBackground.opacity(0.7))
      )
      .overlay(
        RoundedRectangle(cornerRadius: 11, style: .continuous)
          .stroke(ADEColor.border.opacity(0.4), lineWidth: 0.5)
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

  // MARK: - What happens next

  private var whatHappensNextSection: some View {
    VStack(spacing: 0) {
      PrSectionHdr(title: "What happens next") {
        PrMonoText(text: "automated", color: ADEColor.textMuted, size: 10)
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
    steps.append(NextStepItem(id: "push", label: "Push \(branch) to origin", note: nil))

    let stanceLabel = draft ? "draft" : "ready"
    steps.append(
      NextStepItem(
        id: "open",
        label: "Open PR against \(baseBranch) · \(stanceLabel)",
        note: nil
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
      submit()
    } label: {
      HStack(spacing: 6) {
        if isSubmitting {
          ProgressView()
            .controlSize(.small)
            .tint(Color(.sRGB, red: 0.05, green: 0.04, blue: 0.07, opacity: 1.0))
        }
        Text(isSubmitting ? "Opening…" : "Open")
          .font(.system(size: 12, weight: .bold))
          .foregroundStyle(Color(.sRGB, red: 0.05, green: 0.04, blue: 0.07, opacity: 1.0))
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 6)
      .background(
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .fill(ADEColor.purpleAccent)
      )
      .opacity(canSubmit ? 1.0 : 0.45)
    }
    .buttonStyle(.plain)
    .disabled(!canSubmit)
  }

  private func submit() {
    guard let option = selectedOption, canSubmit else { return }
    isSubmitting = true
    let parsedLabels = labelsInput
      .split(separator: ",")
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }
    let parsedReviewers = reviewersInput
      .split(separator: ",")
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "@")) }
      .filter { !$0.isEmpty }
    onCreate(
      option.id,
      title.trimmingCharacters(in: .whitespacesAndNewlines),
      bodyText,
      draft,
      baseBranch.trimmingCharacters(in: .whitespacesAndNewlines),
      parsedLabels,
      parsedReviewers,
      /* strategy */ strategy.rawValue
    )
    // Re-enable the button after a short delay so the spinner clears if the
    // host keeps the sheet open (e.g. on an error toast). The parent sheet
    // controller is responsible for dismissing on success.
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
      isSubmitting = false
    }
  }

  // MARK: - Draft generation

  @MainActor
  private func generateDraft(initial: Bool) async {
    guard let option = selectedOption else { return }
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
        VStack(alignment: .leading, spacing: 18) {
          Text("Title")
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
          TextField("Title", text: $title, axis: .vertical)
            .lineLimit(1...3)
            .textInputAutocapitalization(.sentences)
            .adeInsetField()

          Text("Body")
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
          TextEditor(text: $bodyText)
            .frame(minHeight: 220)
            .scrollContentBackground(.hidden)
            .padding(12)
            .background(ADEColor.recessedBackground.opacity(0.5), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(
              RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(ADEColor.border.opacity(0.35), lineWidth: 0.5)
            )
        }
        .padding(18)
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
      .fill(ADEColor.border.opacity(0.4))
      .frame(height: 0.5)
      .padding(.leading, 14)
  }
}

fileprivate extension View {
  func wizardCard() -> some View {
    background(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .fill(ADEColor.cardBackground)
    )
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .stroke(ADEColor.border.opacity(0.5), lineWidth: 0.5)
    )
  }
}

// MARK: - Row views

fileprivate enum PrStrategyChoice: String {
  case prTarget = "pr_target"
  case laneBase = "lane_base"

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
        radio
        VStack(alignment: .leading, spacing: 2) {
          Text(choice.rawValue)
            .font(.system(size: 12, weight: .bold, design: .monospaced))
            .foregroundStyle(ADEColor.textPrimary)
          Text(choice.subtitle)
            .font(.system(size: 11.5))
            .foregroundStyle(ADEColor.textSecondary)
            .lineSpacing(2)
          Text(choice.helper)
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(selected ? ADEColor.purpleAccent : ADEColor.textMuted)
            .padding(.top, 2)
        }
        Spacer(minLength: 0)
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 12)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }

  private var radio: some View {
    ZStack {
      Circle()
        .stroke(selected ? ADEColor.purpleAccent : ADEColor.border, lineWidth: 1.5)
        .frame(width: 20, height: 20)
      if selected {
        Circle()
          .fill(ADEColor.purpleAccent)
          .frame(width: 20, height: 20)
        Circle()
          .fill(Color(.sRGB, red: 0.05, green: 0.04, blue: 0.07, opacity: 1.0))
          .frame(width: 7, height: 7)
      }
    }
    .padding(.top, 1)
  }
}

fileprivate struct TargetOption: Identifiable, Equatable {
  let id: String
  let icon: String
  let label: String
  let subtitle: String
}

fileprivate struct IntegrationTargetOption: Identifiable, Equatable {
  let id: String
  let branchRef: String
  let subtitle: String
}

fileprivate struct TargetRowView: View {
  let target: TargetOption
  let selected: Bool

  var body: some View {
    HStack(spacing: 10) {
      ZStack {
        RoundedRectangle(cornerRadius: 7, style: .continuous)
          .fill(selected ? ADEColor.purpleAccent.opacity(0.18) : ADEColor.recessedBackground.opacity(0.6))
        RoundedRectangle(cornerRadius: 7, style: .continuous)
          .stroke(selected ? ADEColor.purpleAccent.opacity(0.35) : ADEColor.border.opacity(0.4), lineWidth: 0.5)
        Text(target.icon)
          .font(.system(size: 14, weight: .bold, design: .monospaced))
          .foregroundStyle(selected ? ADEColor.purpleAccent : ADEColor.textSecondary)
      }
      .frame(width: 26, height: 26)

      VStack(alignment: .leading, spacing: 1) {
        Text(target.label)
          .font(.system(size: 12, weight: .semibold, design: .monospaced))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
        Text(target.subtitle)
          .font(.system(size: 10, design: .monospaced))
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(1)
      }
      Spacer(minLength: 0)
      if selected {
        Image(systemName: "checkmark")
          .font(.system(size: 12, weight: .bold))
          .foregroundStyle(ADEColor.purpleAccent)
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 11)
    .contentShape(Rectangle())
  }
}

fileprivate struct StanceSegment: View {
  let label: String
  let active: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Text(label)
        .font(.system(size: 12.5, weight: .semibold))
        .foregroundStyle(active ? ADEColor.textPrimary : ADEColor.textSecondary)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
        .background(
          RoundedRectangle(cornerRadius: 9, style: .continuous)
            .fill(active ? ADEColor.cardBackground : Color.clear)
        )
        .overlay(
          RoundedRectangle(cornerRadius: 9, style: .continuous)
            .stroke(active ? ADEColor.purpleAccent.opacity(0.25) : Color.clear, lineWidth: 0.5)
        )
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

      Text(step.label)
        .font(.system(size: 12.5))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(2)

      Spacer(minLength: 0)

      if let note = step.note {
        Text(note)
          .font(.system(size: 9.5, design: .monospaced))
          .foregroundStyle(ADEColor.textMuted)
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 10)
  }
}

fileprivate struct LaneRow: View {
  let option: CreatePrLaneOption
  let selected: Bool

  var body: some View {
    HStack(spacing: 10) {
      ZStack {
        RoundedRectangle(cornerRadius: 7, style: .continuous)
          .fill(selected ? ADEColor.purpleAccent.opacity(0.18) : ADEColor.recessedBackground.opacity(0.6))
        RoundedRectangle(cornerRadius: 7, style: .continuous)
          .stroke(selected ? ADEColor.purpleAccent.opacity(0.35) : ADEColor.border.opacity(0.4), lineWidth: 0.5)
        Image(systemName: "arrow.triangle.branch")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(selected ? ADEColor.purpleAccent : ADEColor.textSecondary)
      }
      .frame(width: 26, height: 26)

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
      if selected {
        Image(systemName: "checkmark")
          .font(.system(size: 12, weight: .bold))
          .foregroundStyle(ADEColor.purpleAccent)
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 11)
    .contentShape(Rectangle())
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
