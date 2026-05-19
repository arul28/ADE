import SwiftUI

struct LaneChatLaunchSheet: View {
  @Environment(\.dismiss) private var dismiss
  @EnvironmentObject private var syncService: SyncService

  let laneId: String
  let onComplete: @MainActor (AgentChatSessionSummary) async -> Void

  @State private var provider: String
  @State private var models: [AgentChatModelInfo] = []
  @State private var selectedModelId = ""
  @State private var selectedReasoningEffort = ""
  @State private var busy = false
  @State private var errorMessage: String?

  init(
    laneId: String,
    provider: String,
    onComplete: @escaping @MainActor (AgentChatSessionSummary) async -> Void
  ) {
    self.laneId = laneId
    self.onComplete = onComplete
    _provider = State(initialValue: provider)
  }

  private var selectedModel: AgentChatModelInfo? {
    models.first(where: { $0.id == selectedModelId })
  }

  private var providerTitle: String {
    provider == "claude" ? "Claude" : "Codex"
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: 14) {
          GlassSection(title: "Provider") {
            VStack(alignment: .leading, spacing: 12) {
              HStack(spacing: 8) {
                LaneOptionButton(
                  title: "Codex",
                  subtitle: "OpenAI CLI runtime",
                  systemImage: "sparkle",
                  isSelected: provider == "codex"
                ) {
                  provider = "codex"
                }
                LaneOptionButton(
                  title: "Claude",
                  subtitle: "Claude Code runtime",
                  systemImage: "brain.head.profile",
                  isSelected: provider == "claude"
                ) {
                  provider = "claude"
                }
              }

              Text("Session stays lane-scoped.")
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
            }
          }
          .adeBorderBeam(
            cornerRadius: 16,
            duration: 18,
            strength: 0.5,
            lineWidth: 1.25,
            variant: .provider(provider),
            active: true
          )

          GlassSection(title: providerTitle) {
            HStack(alignment: .center, spacing: 12) {
              Image(systemName: provider == "claude" ? "brain.head.profile" : "sparkle")
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(ADEColor.accent)
              VStack(alignment: .leading, spacing: 3) {
                Text(selectedModel?.displayName ?? "Choose a model")
                  .font(.subheadline.weight(.semibold))
                  .foregroundStyle(ADEColor.textPrimary)
                Text("Session stays lane-scoped.")
                  .font(.caption)
                  .foregroundStyle(ADEColor.textSecondary)
              }
              Spacer()
            }
          }

          if !models.isEmpty {
            GlassSection(title: "Model") {
              VStack(alignment: .leading, spacing: 12) {
                if models.count > 5 {
                  ScrollView {
                    modelOptionStack
                  }
                  .frame(maxHeight: 340)
                  .scrollBounceBehavior(.basedOnSize)
                } else {
                  modelOptionStack
                }

                if let selectedModel {
                  VStack(alignment: .leading, spacing: 8) {
                    if let description = selectedModel.description, !description.isEmpty {
                      Text(description)
                        .font(.caption)
                        .foregroundStyle(ADEColor.textSecondary)
                    }
                    HStack(spacing: 6) {
                      if let family = selectedModel.family, !family.isEmpty {
                        LaneMicroChip(icon: "circle.grid.2x2.fill", text: family, tint: ADEColor.textSecondary)
                      }
                      if selectedModel.supportsReasoning == true {
                        LaneMicroChip(icon: "brain", text: "Reasoning", tint: ADEColor.accent)
                      }
                      if selectedModel.supportsTools == true {
                        LaneMicroChip(icon: "hammer.fill", text: "Tools", tint: ADEColor.success)
                      }
                    }
                  }
                }
              }
            }
          }

          if let reasoningEfforts = selectedModel?.reasoningEfforts, !reasoningEfforts.isEmpty {
            GlassSection(title: "Reasoning") {
              VStack(alignment: .leading, spacing: 12) {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 120), spacing: 8)], alignment: .leading, spacing: 8) {
                  LaneOptionButton(
                    title: "Default",
                    subtitle: "Runtime default",
                    systemImage: "circle.dashed",
                    isSelected: selectedReasoningEffort.isEmpty
                  ) {
                    selectedReasoningEffort = ""
                  }
                  ForEach(reasoningEfforts) { effort in
                    LaneOptionButton(
                      title: effort.effort.capitalized,
                      subtitle: effort.description,
                      systemImage: "brain",
                      isSelected: selectedReasoningEffort == effort.effort
                    ) {
                      selectedReasoningEffort = effort.effort
                    }
                  }
                }

                if let effort = reasoningEfforts.first(where: { $0.effort == selectedReasoningEffort }) {
                  Text(effort.description)
                    .font(.caption)
                    .foregroundStyle(ADEColor.textSecondary)
                }
              }
            }
          }

          if let errorMessage {
            HStack(alignment: .top, spacing: 10) {
              Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(ADEColor.danger)
              Text(errorMessage)
                .font(.caption)
                .foregroundStyle(ADEColor.danger)
                .fixedSize(horizontal: false, vertical: true)
              Spacer(minLength: 0)
            }
            .adeGlassCard(cornerRadius: 12, padding: 12)
          }

          if busy {
            HStack(spacing: 10) {
              ProgressView()
                .tint(ADEColor.accent)
              Text("Creating \(providerTitle) chat...")
                .font(.subheadline)
                .foregroundStyle(ADEColor.textSecondary)
              Spacer()
            }
            .adeGlassCard(cornerRadius: 12, padding: 12)
          }
        }
        .padding(16)
      }
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("New \(providerTitle) chat")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
            .disabled(busy)
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Launch") {
            Task { await submit() }
          }
          .disabled(busy || selectedModelId.isEmpty)
        }
      }
      .onChange(of: selectedModelId) { _, _ in
        if let efforts = selectedModel?.reasoningEfforts, !efforts.isEmpty {
          if !efforts.contains(where: { $0.effort == selectedReasoningEffort }) {
            selectedReasoningEffort = ""
          }
        } else {
          selectedReasoningEffort = ""
        }
      }
      .task(id: provider) {
        models = []
        selectedModelId = ""
        selectedReasoningEffort = ""
        await loadModels(resetSelection: true)
      }
    }
  }

  private var modelOptionStack: some View {
    LazyVStack(spacing: 8) {
      ForEach(models) { model in
        LaneOptionButton(
          title: model.displayName,
          subtitle: model.description,
          systemImage: model.supportsReasoning == true ? "brain" : "circle.grid.2x2.fill",
          isSelected: selectedModelId == model.id
        ) {
          selectedModelId = model.id
        }
      }
    }
  }

  @MainActor
  private func loadModels(resetSelection: Bool) async {
    let requestedProvider = provider
    do {
      let loadedModels = try await syncService.listChatModels(provider: requestedProvider)
      guard provider == requestedProvider else { return }
      models = loadedModels
      if resetSelection || loadedModels.contains(where: { $0.id == selectedModelId }) == false {
        if let preferred = loadedModels.first(where: \.isDefault) ?? loadedModels.first {
          selectedModelId = preferred.id
          selectedReasoningEffort = ""
        } else {
          selectedModelId = ""
          selectedReasoningEffort = ""
        }
      }
      errorMessage = nil
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  private func submit() async {
    guard !selectedModelId.isEmpty, models.contains(where: { $0.id == selectedModelId }) else {
      errorMessage = "Please select a valid model."
      return
    }
    do {
      busy = true
      let session = try await syncService.createChatSession(
        laneId: laneId,
        provider: provider,
        model: selectedModelId,
        reasoningEffort: {
          guard !selectedReasoningEffort.isEmpty else { return nil }
          guard selectedModel?.reasoningEfforts?.contains(where: { $0.effort == selectedReasoningEffort }) == true else { return nil }
          return selectedReasoningEffort
        }()
      )
      await onComplete(session)
      dismiss()
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
    busy = false
  }
}
