import SwiftUI

// MARK: - Chat launch sheet

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
              Picker("Provider", selection: $provider) {
                Text("Codex").tag("codex")
                Text("Claude").tag("claude")
              }
              .pickerStyle(.segmented)

              Text("Session stays lane-scoped.")
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
            }
          }

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
                Picker("Model", selection: $selectedModelId) {
                  ForEach(models) { model in
                    Text(model.displayName).tag(model.id)
                  }
                }
                .pickerStyle(.menu)

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
                Picker("Reasoning", selection: $selectedReasoningEffort) {
                  Text("Default").tag("")
                  ForEach(reasoningEfforts) { effort in
                    Text(effort.effort.capitalized).tag(effort.effort)
                  }
                }
                .pickerStyle(.segmented)

                if let effort = reasoningEfforts.first(where: { $0.effort == selectedReasoningEffort }) {
                  Text(effort.description)
                    .font(.caption)
                    .foregroundStyle(ADEColor.textSecondary)
                }
              }
            }
          }

          if let errorMessage {
            HStack(spacing: 10) {
              Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(ADEColor.danger)
              Text(errorMessage)
                .font(.caption)
                .foregroundStyle(ADEColor.danger)
              Spacer()
            }
            .padding(12)
            .background(ADEColor.danger.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
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
          .disabled(busy || (models.isEmpty == false && selectedModelId.isEmpty))
        }
      }
      .task(id: provider) {
        await loadModels(resetSelection: true)
      }
    }
  }

  @MainActor
  private func loadModels(resetSelection: Bool) async {
    do {
      let loadedModels = try await syncService.listChatModels(provider: provider)
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
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  private func submit() async {
    do {
      busy = true
      let session = try await syncService.createChatSession(
        laneId: laneId,
        provider: provider,
        model: selectedModelId,
        reasoningEffort: selectedReasoningEffort.isEmpty ? nil : selectedReasoningEffort
      )
      await onComplete(session)
      dismiss()
    } catch {
      errorMessage = error.localizedDescription
    }
    busy = false
  }
}
