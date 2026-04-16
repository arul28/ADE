import SwiftUI

struct CreatePrWizardView: View {
  @EnvironmentObject private var syncService: SyncService
  @Environment(\.dismiss) private var dismiss

  let lanes: [LaneSummary]
  /// Host-provided create eligibility. When present, drives the lane picker
  /// (filtered to canCreate=true entries), default base branch, and per-lane
  /// blocked-reason subtitles. When nil, the view falls back to the raw
  /// `lanes` list so cached/offline flows still work.
  let createCapabilities: PrCreateCapabilities?
  let onCreate: (String, String, String, Bool, String, [String], [String]) -> Void

  init(
    lanes: [LaneSummary],
    createCapabilities: PrCreateCapabilities? = nil,
    onCreate: @escaping (String, String, String, Bool, String, [String], [String]) -> Void
  ) {
    self.lanes = lanes
    self.createCapabilities = createCapabilities
    self.onCreate = onCreate
  }

  @State private var step = 1
  @State private var selectedLaneId = ""
  @State private var baseBranch = ""
  @State private var title = ""
  @State private var bodyText = ""
  @State private var draft = false
  @State private var reviewers = ""
  @State private var labels = ""
  @State private var isGenerating = false
  @State private var errorMessage: String?

  // Eligible lanes for the picker. When createCapabilities is present, only
  // entries with canCreate=true are selectable — blocked lanes are hidden
  // from the picker and surfaced separately below so users still see why.
  private var eligibleLaneOptions: [CreatePrLaneOption] {
    if let capabilities = createCapabilities {
      return capabilities.lanes
        .filter { $0.canCreate }
        .map { eligibility in
          CreatePrLaneOption(
            id: eligibility.laneId,
            title: eligibility.laneName,
            branchRef: lanes.first(where: { $0.id == eligibility.laneId })?.branchRef ?? eligibility.laneName,
            defaultBaseBranch: eligibility.defaultBaseBranch,
            defaultTitle: eligibility.defaultTitle,
            subtitle: eligibility.blockedReason
          )
        }
    }
    return lanes.map { lane in
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
    return capabilities.lanes.filter { !$0.canCreate }
  }

  private var selectedOption: CreatePrLaneOption? {
    eligibleLaneOptions.first(where: { $0.id == selectedLaneId }) ?? eligibleLaneOptions.first
  }

  private var selectedLane: LaneSummary? {
    guard let id = selectedOption?.id else { return nil }
    return lanes.first(where: { $0.id == id })
  }

  private var canAdvance: Bool {
    switch step {
    case 1:
      return selectedOption != nil && !baseBranch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    case 2:
      return !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    default:
      return true
    }
  }

  var body: some View {
    NavigationStack {
      List {
        PrStepIndicator(step: step)
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

        Group {
          switch step {
          case 1:
            createStepOne
          case 2:
            createStepTwo
          default:
            createStepThree
          }
        }
        .prListRow()
      }
      .listStyle(.plain)
      .scrollContentBackground(.hidden)
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("Create PR")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") {
            dismiss()
          }
        }

        ToolbarItem(placement: .topBarLeading) {
          if step > 1 {
            Button("Back") {
              withAnimation(.smooth) { step -= 1 }
            }
          }
        }

        ToolbarItem(placement: .confirmationAction) {
          if step < 3 {
            Button("Next") {
              withAnimation(.smooth) { step += 1 }
            }
            .disabled(!canAdvance)
          } else {
            Button("Create") {
              guard let selectedOption else { return }
              onCreate(
                selectedOption.id,
                title.trimmingCharacters(in: .whitespacesAndNewlines),
                bodyText,
                draft,
                baseBranch.trimmingCharacters(in: .whitespacesAndNewlines),
                labels.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty },
                reviewers.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
              )
            }
            .disabled(!canAdvance)
          }
        }
      }
      .onAppear {
        if selectedLaneId.isEmpty {
          selectedLaneId = selectedOption?.id ?? ""
        }
        if baseBranch.isEmpty {
          // Host-provided default wins; else the selected lane's base; else
          // fall back to "main" so the field is never empty at step 1.
          baseBranch = createCapabilities?.defaultBaseBranch
            ?? selectedOption?.defaultBaseBranch
            ?? "main"
        }
      }
    }
  }

  private var createStepOne: some View {
    VStack(alignment: .leading, spacing: 12) {
      PrDetailSectionCard("Step 1 · lane and branch") {
        VStack(alignment: .leading, spacing: 12) {
          if eligibleLaneOptions.isEmpty {
            Text("No lanes are eligible to open a PR right now.")
              .font(.subheadline)
              .foregroundStyle(ADEColor.textSecondary)
          } else {
            Picker("Lane", selection: $selectedLaneId) {
              ForEach(eligibleLaneOptions) { option in
                Text("\(option.title) · \(option.branchRef)").tag(option.id)
              }
            }
            .pickerStyle(.menu)
            .adeInsetField()

            if let selectedOption {
              Text("Source branch: \(selectedOption.branchRef)")
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
            }
          }

          TextField("Target branch", text: $baseBranch)
            .adeInsetField()

          Toggle("Create as draft", isOn: $draft)
            .adeInsetField()

          if !blockedLaneOptions.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
              Text("Not eligible")
                .font(.caption.weight(.semibold))
                .foregroundStyle(ADEColor.textPrimary)
              ForEach(blockedLaneOptions) { entry in
                VStack(alignment: .leading, spacing: 2) {
                  Text(entry.laneName)
                    .font(.caption)
                    .foregroundStyle(ADEColor.textPrimary)
                  if let reason = entry.blockedReason, !reason.isEmpty {
                    Text(reason)
                      .font(.caption2)
                      .foregroundStyle(ADEColor.textSecondary)
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  private var createStepTwo: some View {
    VStack(alignment: .leading, spacing: 12) {
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
          .disabled(isGenerating || selectedOption == nil)
        }
      }
    }
  }

  private var createStepThree: some View {
    VStack(alignment: .leading, spacing: 12) {
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
        }
      }
    }
  }

  @MainActor
  private func generateDraft() async {
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

      title = suggestion.title
      bodyText = suggestion.body
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }
}

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

struct PrStepIndicator: View {
  let step: Int

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("Step \(step) of 3")
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEColor.textSecondary)

      HStack(spacing: 8) {
        ForEach(1...3, id: \.self) { index in
          RoundedRectangle(cornerRadius: 8, style: .continuous)
            .fill(index <= step ? ADEColor.accent : ADEColor.border.opacity(0.35))
            .frame(height: 8)
        }
      }

      HStack(spacing: 8) {
        Text("Branch")
        Text("Details")
        Text("Review")
      }
      .font(.caption)
      .foregroundStyle(ADEColor.textSecondary)
    }
    .adeGlassCard(cornerRadius: 18)
  }
}

struct PrMarkdownRenderer: View {
  let markdown: String

  private var attributed: AttributedString? {
    try? AttributedString(
      markdown: markdown,
      options: AttributedString.MarkdownParsingOptions(
        interpretedSyntax: .full,
        failurePolicy: .returnPartiallyParsedIfPossible
      )
    )
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
