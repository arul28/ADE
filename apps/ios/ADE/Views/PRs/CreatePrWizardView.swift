import SwiftUI

struct CreatePrWizardView: View {
  @EnvironmentObject private var syncService: SyncService
  @Environment(\.dismiss) private var dismiss

  let lanes: [LaneSummary]
  let onCreate: (String, String, String, Bool, String, [String], [String]) -> Void

  @State private var step = 1
  @State private var selectedLaneId = ""
  @State private var baseBranch = "main"
  @State private var title = ""
  @State private var bodyText = ""
  @State private var draft = false
  @State private var reviewers = ""
  @State private var labels = ""
  @State private var isGenerating = false
  @State private var errorMessage: String?

  private var selectedLane: LaneSummary? {
    lanes.first(where: { $0.id == selectedLaneId }) ?? lanes.first
  }

  private var canAdvance: Bool {
    switch step {
    case 1:
      return selectedLane != nil && !baseBranch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
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
              guard let selectedLane else { return }
              onCreate(
                selectedLane.id,
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
        selectedLaneId = selectedLaneId.isEmpty ? (lanes.first?.id ?? "") : selectedLaneId
        if let selectedLane, baseBranch == "main" {
          baseBranch = selectedLane.baseRef
        }
      }
    }
  }

  private var createStepOne: some View {
    VStack(alignment: .leading, spacing: 12) {
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
          .disabled(isGenerating || selectedLane == nil)
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
      if bodyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        bodyText = suggestion.body
      } else {
        bodyText = suggestion.body
      }
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }
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
