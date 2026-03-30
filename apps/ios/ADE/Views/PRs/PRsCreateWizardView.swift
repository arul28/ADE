import SwiftUI
private enum PrCreationMode: String, CaseIterable, Identifiable {
  case single
  case queue
  case integration
  var id: String { rawValue }
  var title: String {
    switch self {
    case .single: return "Single PR"
    case .queue: return "Queue"
    case .integration: return "Integration"
    }
  }
}
struct CreatePrWizardView: View {
  @EnvironmentObject private var syncService: SyncService
  @Environment(\.dismiss) private var dismiss
  let lanes: [LaneSummary]
  let onCreateSingle: (String, String, String, Bool, String, [String], [String]) -> Void
  let onCreateQueue: ([String], String, String, Bool, Bool, Bool) -> Void
  let onCreateIntegration: ([String], String, String, String, String, Bool) -> Void
  let onSimulateIntegration: ([String], String) async throws -> IntegrationProposal
  @State private var mode: PrCreationMode = .single
  @State private var step = 1
  @State private var selectedLaneId = ""
  @State private var baseBranch = "main"
  @State private var title = ""
  @State private var bodyText = ""
  @State private var draft = false
  @State private var reviewers = ""
  @State private var labels = ""
  @State private var queueStep = 1
  @State private var queueLaneIds: [String] = []
  @State private var queueTargetBranch = ""
  @State private var queueName = ""
  @State private var queueDraft = false
  @State private var queueAutoRebase = true
  @State private var queueCIGating = true
  @State private var integrationStep = 1
  @State private var integrationLaneIds: [String] = []
  @State private var integrationBaseBranch = ""
  @State private var integrationLaneName = ""
  @State private var integrationTitle = ""
  @State private var integrationBody = ""
  @State private var integrationDraft = true
  @State private var integrationProposal: IntegrationProposal?
  @State private var integrationSimulating = false
  @State private var isGenerating = false
  @State private var errorMessage: String?
  private var laneLookup: [String: LaneSummary] {
    Dictionary(uniqueKeysWithValues: lanes.map { ($0.id, $0) })
  }
  private var selectedLane: LaneSummary? {
    laneLookup[selectedLaneId] ?? lanes.first
  }
  private var selectedQueueLanes: [LaneSummary] {
    queueLaneIds.compactMap { laneLookup[$0] }
  }
  private var selectedIntegrationLanes: [LaneSummary] {
    integrationLaneIds.compactMap { laneLookup[$0] }
  }
  private var stepLabels: [String] {
    switch mode {
    case .single: return ["Lane", "Details", "Review"]
    case .queue: return ["Lanes", "Options", "Review"]
    case .integration: return ["Sources", "Simulation", "Review"]
    }
  }
  private var primaryActionTitle: String {
    switch mode {
    case .single:
      return step < 3 ? "Next" : "Create PR"
    case .queue:
      return queueStep < 3 ? "Next" : "Create queue"
    case .integration:
      switch integrationStep {
      case 1:
        return "Next"
      case 2:
        return "Simulate"
      default:
        return "Create integration"
      }
    }
  }
  private var canAdvance: Bool {
    switch mode {
    case .single:
      switch step {
      case 1:
        return selectedLane != nil && !baseBranch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      case 2:
        return !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      default:
        return true
      }
    case .queue:
      switch queueStep {
      case 1:
        return !selectedQueueLanes.isEmpty
      case 2:
        return !queueTargetBranch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      default:
        return true
      }
    case .integration:
      switch integrationStep {
      case 1:
        return selectedIntegrationLanes.count >= 2
      case 2:
        return !integrationBaseBranch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
          && !integrationLaneName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      default:
        return integrationProposal != nil
      }
    }
  }
  private var integrationCanSimulate: Bool { selectedIntegrationLanes.count >= 2 && !integrationBaseBranch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !integrationLaneName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !integrationSimulating }
  var body: some View {
    NavigationStack {
      List {
        PrDetailSectionCard("Mode") {
          Picker("Mode", selection: $mode) {
            ForEach(PrCreationMode.allCases) { mode in
              Text(mode.title).tag(mode)
            }
          }
          .pickerStyle(.segmented)
        }
        .prListRow()
        if let errorMessage {
          ADENoticeCard(
            title: "Create PR draft failed",
            message: errorMessage,
            icon: "exclamationmark.triangle.fill",
            tint: ADEColor.danger,
            actionTitle: nil,
            action: nil
          )
          .prListRow()
        }
        switch mode {
        case .single:
          singleModeSections
        case .queue:
          queueModeSections
        case .integration:
          integrationModeSections
        }
      }
      .listStyle(.plain)
      .scrollContentBackground(.hidden)
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("Create PR")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") {
            dismiss()
          }
        }
        ToolbarItem(placement: .topBarLeading) {
          if mode == .single, step > 1 {
            Button("Back") {
              withAnimation(.smooth) { step -= 1 }
            }
          } else if mode == .queue, queueStep > 1 {
            Button("Back") {
              withAnimation(.smooth) { queueStep -= 1 }
            }
          } else if mode == .integration, integrationStep > 1 {
            Button("Back") {
              withAnimation(.smooth) {
                integrationStep -= 1
              }
            }
          }
        }
        ToolbarItem(placement: .topBarTrailing) {
          if mode != .single {
            EditButton()
          }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button(primaryActionTitle) {
            Task { await performPrimaryAction() }
          }
          .disabled(!canAdvance || isGenerating || integrationSimulating)
        }
      }
      .onAppear {
        seedDefaultSelections()
      }
      .onChange(of: lanes) { _, _ in
        seedDefaultSelections()
      }
      .onChange(of: mode) { _, newValue in
        errorMessage = nil
        step = 1
        queueStep = 1
        integrationStep = 1
        integrationProposal = nil
        seedDefaultSelections()
        if newValue == .single, let selectedLane, baseBranch == "main" {
          baseBranch = selectedLane.baseRef
        }
      }
    }
  }
  @ViewBuilder
  private var singleModeSections: some View {
    PrStepIndicator(title: "Single PR", step: step, labels: stepLabels)
      .prListRow()
    switch step {
    case 1:
      createStepOne
        .prListRow()
    case 2:
      createStepTwo
        .prListRow()
    default:
      createStepThree
        .prListRow()
    }
  }
  @ViewBuilder
  private var queueModeSections: some View {
    PrStepIndicator(title: "Queue", step: queueStep, labels: stepLabels)
      .prListRow()
    switch queueStep {
    case 1:
      laneSelectionCard(
        title: "Step 1 · lanes",
        selection: $queueLaneIds,
        helperText: "Tap Edit to reorder selected lanes. Use the menu to add more."
      )
      .prListRow()
    case 2:
      queueOptionsCard
        .prListRow()
    default:
      queueReviewCard
        .prListRow()
    }
  }
  @ViewBuilder
  private var integrationModeSections: some View {
    PrStepIndicator(title: "Integration", step: integrationStep, labels: stepLabels)
      .prListRow()
    switch integrationStep {
    case 1:
      laneSelectionCard(
        title: "Step 1 · source lanes",
        selection: $integrationLaneIds,
        helperText: "Select at least two source lanes, then reorder them to match the integration plan."
      )
      .prListRow()
    case 2:
      integrationDetailsCard
        .prListRow()
    default:
      integrationReviewCard
        .prListRow()
    }
  }
  private var createStepOne: some View {
    PrDetailSectionCard("Step 1 · lane and branch") {
      VStack(alignment: .leading, spacing: 12) {
        Picker("Lane", selection: $selectedLaneId) {
          ForEach(lanes) { lane in
            Text("\(lane.name) · \(lane.branchRef)").tag(lane.id)
          }
        }
        .pickerStyle(.menu)
        .adeInsetField()
        if let selectedLane {
          Text("Source branch: \(selectedLane.branchRef)")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }
        TextField("Target branch", text: $baseBranch)
          .adeInsetField()
        Toggle("Create as draft", isOn: $draft)
          .adeInsetField()
      }
    }
  }
  private var createStepTwo: some View {
    PrDetailSectionCard("Step 2 · title and body") {
      VStack(alignment: .leading, spacing: 12) {
        TextField("Title", text: $title)
          .adeInsetField()
        TextEditor(text: $bodyText)
          .frame(minHeight: 180)
          .adeInsetField(cornerRadius: 14, padding: 10)
        Button(isGenerating ? "Generating…" : "Generate with AI") {
          Task { await generateDraft() }
        }
        .buttonStyle(.glass)
        .disabled(isGenerating || selectedLane == nil)
      }
    }
  }
  private var createStepThree: some View {
    PrDetailSectionCard("Step 3 · reviewers and labels") {
      VStack(alignment: .leading, spacing: 12) {
        TextField("Reviewers (comma-separated)", text: $reviewers)
          .adeInsetField()
        TextField("Labels (comma-separated)", text: $labels)
          .adeInsetField()
        VStack(alignment: .leading, spacing: 6) {
          Text("Summary")
            .font(.caption.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text(title.isEmpty ? "Add a title before creating the PR." : title)
            .font(.subheadline)
            .foregroundStyle(ADEColor.textSecondary)
          Text("Targeting \(baseBranch)")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }
        Button("Create PR") {
          guard let selectedLane else { return }
          onCreateSingle(
            selectedLane.id,
            title.trimmingCharacters(in: .whitespacesAndNewlines),
            bodyText,
            draft,
            baseBranch.trimmingCharacters(in: .whitespacesAndNewlines),
            labels.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty },
            reviewers.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
          )
        }
        .buttonStyle(.glassProminent)
        .tint(ADEColor.accent)
        .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || baseBranch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
    }
  }
  private var queueOptionsCard: some View {
    PrDetailSectionCard("Step 2 · queue options") {
      VStack(alignment: .leading, spacing: 12) {
        TextField("Target branch", text: $queueTargetBranch)
          .adeInsetField()
        TextField("Queue name", text: $queueName)
          .adeInsetField()
        Toggle("Create as draft", isOn: $queueDraft)
          .adeInsetField()
        Toggle("Auto-rebase", isOn: $queueAutoRebase)
          .adeInsetField()
        Toggle("CI gating", isOn: $queueCIGating)
          .adeInsetField()
        Label("Queue lanes will land in the order shown in step 1.", systemImage: "arrow.up.arrow.down")
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
      }
    }
  }
  private var queueReviewCard: some View {
    PrDetailSectionCard("Step 3 · review and create") {
      VStack(alignment: .leading, spacing: 12) {
        summaryLine("Selected lanes", value: "\(selectedQueueLanes.count)")
        summaryLine("Target branch", value: queueTargetBranch)
        summaryLine("Queue name", value: queueName.isEmpty ? "Unnamed queue" : queueName)
        summaryLine("Draft", value: queueDraft ? "Yes" : "No")
        summaryLine("Auto-rebase", value: queueAutoRebase ? "On" : "Off")
        summaryLine("CI gating", value: queueCIGating ? "On" : "Off")
        if !selectedQueueLanes.isEmpty {
          VStack(alignment: .leading, spacing: 8) {
            Text("Lane order")
              .font(.caption.weight(.semibold))
              .foregroundStyle(ADEColor.textPrimary)
            ForEach(Array(selectedQueueLanes.enumerated()), id: \.element.id) { item in
              HStack(alignment: .top, spacing: 10) {
                ADEStatusPill(text: "#\(item.offset + 1)", tint: ADEColor.textSecondary)
                VStack(alignment: .leading, spacing: 3) {
                  Text(item.element.name)
                    .foregroundStyle(ADEColor.textPrimary)
                  Text(item.element.branchRef)
                    .font(.caption2)
                    .foregroundStyle(ADEColor.textSecondary)
                }
              }
              .padding(.vertical, 4)
            }
          }
        }
        Button("Create queue") {
          Task { await submitQueue() }
        }
        .buttonStyle(.glassProminent)
        .tint(ADEColor.accent)
        .disabled(selectedQueueLanes.isEmpty || queueTargetBranch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
    }
  }
  private var integrationDetailsCard: some View {
    PrDetailSectionCard("Step 2 · integration details") {
      VStack(alignment: .leading, spacing: 12) {
        TextField("Base branch", text: $integrationBaseBranch)
          .adeInsetField()
        TextField("Integration lane name", text: $integrationLaneName)
          .adeInsetField()
        TextField("Title", text: $integrationTitle)
          .adeInsetField()
        TextEditor(text: $integrationBody)
          .frame(minHeight: 180)
          .adeInsetField(cornerRadius: 14, padding: 10)
        Toggle("Create as draft", isOn: $integrationDraft)
          .adeInsetField()
        Button(integrationSimulating ? "Simulating…" : "Simulate integration") {
          Task { await simulateIntegration() }
        }
        .buttonStyle(.glassProminent)
        .tint(ADEColor.accent)
        .disabled(!integrationCanSimulate)
        if integrationProposal == nil {
          Label("Run simulation to review outcomes before creating the integration PR.", systemImage: "sparkles")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }
      }
    }
  }
  private var integrationReviewCard: some View {
    PrDetailSectionCard("Step 3 · simulation summary and create") {
      VStack(alignment: .leading, spacing: 12) {
        summaryLine("Source lanes", value: "\(selectedIntegrationLanes.count)")
        summaryLine("Base branch", value: integrationBaseBranch)
        summaryLine("Lane name", value: integrationLaneName)
        summaryLine("Draft", value: integrationDraft ? "Yes" : "No")
        if let proposal = integrationProposal {
          HStack(spacing: 8) {
            ADEStatusPill(
              text: proposal.overallOutcome.uppercased(),
              tint: proposal.overallOutcome == "clean" ? ADEColor.success : ADEColor.warning
            )
            ADEStatusPill(text: "\(proposal.steps.count) steps", tint: ADEColor.textSecondary)
            ADEStatusPill(text: "\(proposal.pairwiseResults.count) pairings", tint: ADEColor.textSecondary)
          }
          if let cleanupState = proposal.cleanupState {
            summaryLine("Cleanup", value: cleanupState)
          }
          if !proposal.pairwiseResults.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
              Text("Pairwise results")
                .font(.caption.weight(.semibold))
                .foregroundStyle(ADEColor.textPrimary)
              ForEach(proposal.pairwiseResults.prefix(4)) { result in
                Text("\(result.laneAName) ↔ \(result.laneBName) · \(result.outcome)")
                  .font(.caption)
                  .foregroundStyle(ADEColor.textSecondary)
              }
            }
          }
        } else {
          Label("Run simulation before creating the integration PR.", systemImage: "sparkles")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }
        HStack(spacing: 10) {
          Button("Create integration PR") {
            Task { await submitIntegration() }
          }
          .buttonStyle(.glassProminent)
          .tint(ADEColor.accent)
          .disabled(integrationProposal == nil || integrationTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || integrationBody.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          Button("Create lane from simulation") {
            Task { await createIntegrationLaneFromSimulation() }
          }
          .buttonStyle(.glass)
          .disabled(integrationProposal == nil || integrationSimulating)
        }
      }
    }
  }
  @ViewBuilder
  private func laneSelectionCard(
    title: String,
    selection: Binding<[String]>,
    helperText: String
  ) -> some View {
    let selected = selection.wrappedValue.compactMap { laneLookup[$0] }
    let available = lanes.filter { !selection.wrappedValue.contains($0.id) }
    PrDetailSectionCard(title) {
      VStack(alignment: .leading, spacing: 12) {
        if selected.isEmpty {
          ADEEmptyStateView(
            symbol: "square.stack.3d.up",
            title: "No lanes selected",
            message: "Add one or more lanes to continue."
          )
        } else {
          VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(selected.enumerated()), id: \.element.id) { item in
              HStack(alignment: .top, spacing: 10) {
                Image(systemName: "line.3.horizontal")
                  .foregroundStyle(ADEColor.textSecondary)
                  .padding(.top, 2)
                VStack(alignment: .leading, spacing: 3) {
                  Text(item.element.name)
                    .foregroundStyle(ADEColor.textPrimary)
                  Text("\(item.element.branchRef) · \(item.element.baseRef)")
                    .font(.caption2)
                    .foregroundStyle(ADEColor.textSecondary)
                }
                Spacer(minLength: 0)
                ADEStatusPill(text: item.element.laneType.uppercased(), tint: item.element.laneType == "primary" ? ADEColor.accent : ADEColor.textSecondary)
              }
              .padding(.vertical, 6)
              .padding(.horizontal, 10)
              .background(ADEColor.surfaceBackground.opacity(0.45), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
              .swipeActions {
                Button("Remove", role: .destructive) {
                  removeLane(item.element.id, from: selection)
                }
              }
            }
            .onMove { source, destination in
              moveLanes(in: selection, from: source, to: destination)
            }
          }
        }
        HStack(spacing: 10) {
          Menu {
            ForEach(available) { lane in
              Button {
                addLane(lane.id, to: selection)
              } label: {
                Text("\(lane.name) · \(lane.branchRef)")
              }
            }
          } label: {
            Label("Add lane", systemImage: "plus")
          }
          .buttonStyle(.glass)
          .disabled(available.isEmpty)
          if !selection.wrappedValue.isEmpty {
            Button("Clear selection", role: .destructive) {
              selection.wrappedValue.removeAll()
              updateDefaultsAfterSelectionChange()
            }
            .buttonStyle(.glass)
          }
        }
        Text(helperText)
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
      }
    }
  }
  private func summaryLine(_ label: String, value: String) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      Text(label)
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
      Spacer(minLength: 8)
      Text(value.isEmpty ? "Unspecified" : value)
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)
    }
  }
  @MainActor
  private func performPrimaryAction() async {
    switch mode {
    case .single:
      if step < 3 {
        withAnimation(.smooth) { step += 1 }
      } else if let selectedLane {
        onCreateSingle(
          selectedLane.id,
          title.trimmingCharacters(in: .whitespacesAndNewlines),
          bodyText,
          draft,
          baseBranch.trimmingCharacters(in: .whitespacesAndNewlines),
          labels.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty },
          reviewers.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        )
      }
    case .queue:
      if queueStep < 3 {
        withAnimation(.smooth) { queueStep += 1 }
      } else {
        await submitQueue()
      }
    case .integration:
      if integrationStep == 1 {
        withAnimation(.smooth) { integrationStep = 2 }
      } else if integrationStep == 2 {
        await simulateIntegration()
      } else {
        await submitIntegration()
      }
    }
  }
  @MainActor
  private func submitQueue() async {
    let branch = queueTargetBranch.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !selectedQueueLanes.isEmpty, !branch.isEmpty else { return }
    onCreateQueue(
      queueLaneIds,
      branch,
      queueName.trimmingCharacters(in: .whitespacesAndNewlines),
      queueDraft,
      queueAutoRebase,
      queueCIGating
    )
    errorMessage = nil
  }
  @MainActor
  private func simulateIntegration() async {
    guard !integrationSimulating else { return }
    let branch = integrationBaseBranch.trimmingCharacters(in: .whitespacesAndNewlines)
    let laneName = integrationLaneName.trimmingCharacters(in: .whitespacesAndNewlines)
    guard selectedIntegrationLanes.count >= 2, !branch.isEmpty, !laneName.isEmpty else { return }
    integrationSimulating = true
    defer { integrationSimulating = false }
    do {
      let proposal = try await onSimulateIntegration(integrationLaneIds, branch)
      integrationProposal = proposal
      if integrationTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        integrationTitle = proposal.title?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
          ? proposal.title!
          : suggestedIntegrationTitle()
      }
      if integrationBody.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        integrationBody = proposal.body?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
          ? proposal.body!
          : integrationSummaryBody(for: proposal)
      }
      integrationStep = 3
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }
  @MainActor
  private func submitIntegration() async {
    let branch = integrationBaseBranch.trimmingCharacters(in: .whitespacesAndNewlines)
    let laneName = integrationLaneName.trimmingCharacters(in: .whitespacesAndNewlines)
    let title = integrationTitle.trimmingCharacters(in: .whitespacesAndNewlines)
    let body = integrationBody.trimmingCharacters(in: .whitespacesAndNewlines)
    guard integrationProposal != nil, selectedIntegrationLanes.count >= 2, !branch.isEmpty, !laneName.isEmpty, !title.isEmpty, !body.isEmpty else {
      return
    }
    onCreateIntegration(
      integrationLaneIds,
      laneName,
      branch,
      title,
      body,
      integrationDraft
    )
    errorMessage = nil
  }
  @MainActor
  private func createIntegrationLaneFromSimulation() async {
    guard let proposal = integrationProposal else { return }
    do {
      _ = try await syncService.createIntegrationLaneForProposal(proposalId: proposal.proposalId)
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }
  @MainActor
  private func generateDraft() async {
    guard let selectedLane else { return }
    isGenerating = true
    defer { isGenerating = false }
    do {
      let suggestion: PullRequestDraftSuggestion
      if syncService.supportsRemoteAction("prs.draftDescription") {
        suggestion = try await syncService.draftPullRequestDescription(laneId: selectedLane.id)
      } else {
        let detail = try? await syncService.refreshLaneDetail(laneId: selectedLane.id)
        suggestion = prHeuristicDraft(lane: selectedLane, detail: detail)
      }
      title = suggestion.title
      bodyText = suggestion.body
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }
  private func seedDefaultSelections() {
    if selectedLaneId.isEmpty || laneLookup[selectedLaneId] == nil {
      selectedLaneId = lanes.first?.id ?? ""
    }

    if queueLaneIds.isEmpty {
      let preferred = lanes.filter { $0.laneType != "primary" }.prefix(3).map(\.id)
      queueLaneIds = preferred.isEmpty ? Array(lanes.prefix(2).map(\.id)) : Array(preferred)
    }

    if integrationLaneIds.isEmpty {
      let preferred = lanes.filter { $0.laneType != "primary" }.prefix(2).map(\.id)
      integrationLaneIds = preferred.isEmpty ? Array(lanes.prefix(2).map(\.id)) : Array(preferred)
    }

    if let selectedLane, (baseBranch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || baseBranch == "main") {
      baseBranch = selectedLane.baseRef
    }

    updateDefaultsAfterSelectionChange()
  }
  private func updateDefaultsAfterSelectionChange() {
    if queueTargetBranch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || queueTargetBranch == "main" {
      queueTargetBranch = selectedQueueLanes.first?.baseRef ?? queueTargetBranch
    }
    if queueName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !selectedQueueLanes.isEmpty {
      queueName = suggestedWorkflowName(prefix: "queue", lanes: selectedQueueLanes)
    }
    if integrationBaseBranch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || integrationBaseBranch == "main" {
      integrationBaseBranch = selectedIntegrationLanes.first?.baseRef ?? integrationBaseBranch
    }
    if integrationLaneName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !selectedIntegrationLanes.isEmpty {
      integrationLaneName = suggestedWorkflowName(prefix: "integration", lanes: selectedIntegrationLanes)
    }
  }
  private func addLane(_ laneId: String, to selection: Binding<[String]>) {
    guard !selection.wrappedValue.contains(laneId) else { return }
    selection.wrappedValue.append(laneId)
    updateDefaultsAfterSelectionChange()
  }
  private func removeLane(_ laneId: String, from selection: Binding<[String]>) {
    selection.wrappedValue.removeAll { $0 == laneId }
    updateDefaultsAfterSelectionChange()
  }
  private func moveLanes(in selection: Binding<[String]>, from source: IndexSet, to destination: Int) {
    selection.wrappedValue.move(fromOffsets: source, toOffset: destination)
    updateDefaultsAfterSelectionChange()
  }
  private func suggestedWorkflowName(prefix: String, lanes: [LaneSummary]) -> String {
    let slug = lanes.map(\.name)
      .joined(separator: "-")
      .lowercased()
      .replacingOccurrences(of: " ", with: "-")
      .replacingOccurrences(of: "_", with: "-")
      .replacingOccurrences(of: "--", with: "-")
      .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    return "\(prefix)/\(slug.isEmpty ? "bundle" : slug)"
  }
  private func suggestedIntegrationTitle() -> String {
    let names = selectedIntegrationLanes.map(\.name)
    return names.isEmpty ? "Integration workflow" : "Integration: \(names.joined(separator: ", "))"
  }
  private func integrationSummaryBody(for proposal: IntegrationProposal) -> String {
    var lines = [
      "Integration simulation for \(selectedIntegrationLanes.map(\.name).joined(separator: ", "))",
      "",
      "Outcome: \(proposal.overallOutcome)",
    ]
    if !proposal.pairwiseResults.isEmpty {
      lines += ["", "Pairwise results:"] + proposal.pairwiseResults.map {
        "- \($0.laneAName) ↔ \($0.laneBName): \($0.outcome)"
      }
    }
    return lines.joined(separator: "\n")
  }
}

private struct PrStepIndicator: View {
  let title: String
  let step: Int
  let labels: [String]
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        Text(title)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Spacer(minLength: 8)
        Text("Step \(step) of \(labels.count)")
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textSecondary)
      }
      HStack(spacing: 8) {
        ForEach(0..<labels.count, id: \.self) { index in
          RoundedRectangle(cornerRadius: 8, style: .continuous)
            .fill(index < step ? ADEColor.accent : ADEColor.border.opacity(0.35))
            .frame(height: 8)
        }
      }
      HStack(spacing: 8) {
        ForEach(Array(labels.enumerated()), id: \.offset) { item in
          Text(item.element)
            .frame(maxWidth: .infinity)
        }
      }
      .font(.caption)
      .foregroundStyle(ADEColor.textSecondary)
    }
    .adeGlassCard(cornerRadius: 18)
  }
}
