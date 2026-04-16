import SwiftUI
import UIKit
import AVKit

struct WorkNewChatSheet: View {
  @Environment(\.dismiss) var dismiss
  @EnvironmentObject var syncService: SyncService

  let lanes: [LaneSummary]
  let initialLaneId: String?
  let onRefreshLanes: @MainActor () async -> Void
  let onCreated: @MainActor (WorkDraftChatSession) async -> Void

  @State var provider = "claude"
  @State var models: [AgentChatModelInfo] = []
  @State var selectedModelId = ""
  @State var selectedReasoningEffort = ""
  @State var selectedLaneId = ""
  @State var initialMessage = ""
  @State var busy = false
  @State var errorMessage: String?

  let providerColumns = [
    GridItem(.flexible(), spacing: 12),
    GridItem(.flexible(), spacing: 12),
  ]

  var selectedModel: AgentChatModelInfo? {
    models.first(where: { $0.id == selectedModelId })
  }

  var trimmedInitialMessage: String {
    initialMessage.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  var canStartChat: Bool {
    !busy && !selectedLaneId.isEmpty && !selectedModelId.isEmpty && !trimmedInitialMessage.isEmpty
  }

  var startDisabledReason: String? {
    if busy { return nil }
    if selectedLaneId.isEmpty { return "Choose a lane." }
    if selectedModelId.isEmpty { return "Choose a model." }
    if trimmedInitialMessage.isEmpty { return "Enter an opening prompt." }
    return nil
  }

  var providerOptions: [WorkProviderOption] {
    [
      WorkProviderOption(
        id: "claude",
        title: "Claude",
        subtitle: "Long-form reasoning and review",
        icon: providerIcon("claude"),
        tint: providerTint("claude")
      ),
      WorkProviderOption(
        id: "codex",
        title: "Codex",
        subtitle: "Fast code execution and edits",
        icon: providerIcon("codex"),
        tint: providerTint("codex")
      ),
      WorkProviderOption(
        id: "opencode",
        title: "OpenCode",
        subtitle: "Open runtime workflows and tools",
        icon: providerIcon("opencode"),
        tint: providerTint("opencode")
      ),
      WorkProviderOption(
        id: "cursor",
        title: "Cursor",
        subtitle: "Cursor-native chat sessions",
        icon: providerIcon("cursor"),
        tint: providerTint("cursor")
      ),
    ]
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: 14) {
          GlassSection(title: "Provider") {
            LazyVGrid(columns: providerColumns, spacing: 12) {
              ForEach(providerOptions) { option in
                Button {
                  provider = option.id
                } label: {
                  VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 10) {
                      Image(systemName: option.icon)
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(option.tint)
                        .frame(width: 34, height: 34)
                        .background(option.tint.opacity(0.14), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                      Spacer(minLength: 0)
                      if provider == option.id {
                        Image(systemName: "checkmark.circle.fill")
                          .foregroundStyle(ADEColor.accent)
                      }
                    }
                    Text(option.title)
                      .font(.subheadline.weight(.semibold))
                      .foregroundStyle(ADEColor.textPrimary)
                    Text(option.subtitle)
                      .font(.caption)
                      .foregroundStyle(ADEColor.textSecondary)
                      .lineLimit(2)
                  }
                  .frame(maxWidth: .infinity, minHeight: 118, alignment: .leading)
                  .padding(12)
                  .background(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                      .fill(provider == option.id ? option.tint.opacity(0.14) : ADEColor.surfaceBackground.opacity(0.55))
                  )
                  .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                      .stroke(provider == option.id ? option.tint.opacity(0.45) : ADEColor.border.opacity(0.18), lineWidth: provider == option.id ? 1.3 : 0.8)
                  )
                  .glassEffect(in: .rect(cornerRadius: 16))
                }
                .buttonStyle(.plain)
              }
            }
          }

          GlassSection(title: "Model") {
            VStack(alignment: .leading, spacing: 12) {
              if models.isEmpty && errorMessage == nil {
                HStack(spacing: 10) {
                  ProgressView()
                    .tint(ADEColor.accent)
                  Text("Loading \(providerLabel(provider)) models…")
                    .font(.subheadline)
                    .foregroundStyle(ADEColor.textSecondary)
                }
              } else if models.isEmpty {
                Text(errorMessage ?? "No models are currently available for \(providerLabel(provider)).")
                  .font(.caption)
                  .foregroundStyle(errorMessage == nil ? ADEColor.textSecondary : ADEColor.danger)
              } else {
                ForEach(models) { model in
                  Button {
                    selectedModelId = model.id
                  } label: {
                    VStack(alignment: .leading, spacing: 8) {
                      HStack(spacing: 10) {
                        VStack(alignment: .leading, spacing: 4) {
                          Text(model.displayName)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(ADEColor.textPrimary)
                          if let description = model.description, !description.isEmpty {
                            Text(description)
                              .font(.caption)
                              .foregroundStyle(ADEColor.textSecondary)
                              .lineLimit(2)
                          }
                        }
                        Spacer(minLength: 8)
                        if selectedModelId == model.id {
                          Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(ADEColor.accent)
                        }
                      }

                      HStack(spacing: 6) {
                        if let family = model.family, !family.isEmpty {
                          LaneMicroChip(icon: "circle.grid.2x2.fill", text: family, tint: ADEColor.textSecondary)
                        }
                        if model.supportsReasoning == true {
                          LaneMicroChip(icon: "brain", text: "Reasoning", tint: ADEColor.accent)
                        }
                        if model.supportsTools == true {
                          LaneMicroChip(icon: "hammer.fill", text: "Tools", tint: ADEColor.success)
                        }
                        if model.isDefault {
                          LaneMicroChip(icon: "star.fill", text: "Default", tint: ADEColor.warning)
                        }
                        Spacer(minLength: 0)
                      }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .background(
                      RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .fill(selectedModelId == model.id ? providerTint(provider).opacity(0.14) : ADEColor.surfaceBackground.opacity(0.55))
                    )
                    .overlay(
                      RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .stroke(selectedModelId == model.id ? providerTint(provider).opacity(0.42) : ADEColor.border.opacity(0.18), lineWidth: selectedModelId == model.id ? 1.3 : 0.8)
                    )
                    .glassEffect(in: .rect(cornerRadius: 16))
                  }
                  .buttonStyle(.plain)
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

          GlassSection(title: "Lane") {
            if lanes.isEmpty {
              VStack(spacing: 14) {
                ADEEmptyStateView(
                  symbol: "arrow.triangle.branch",
                  title: "No lanes on this phone yet",
                  message: "Lanes are created on the ADE host. After the host syncs lane metadata, pull to refresh on Work or tap below."
                )
                Button {
                  Task { await onRefreshLanes() }
                } label: {
                  Label("Refresh lanes from host", systemImage: "arrow.trianglehead.2.clockwise.rotate.90")
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                }
                .buttonStyle(.glassProminent)
                .tint(ADEColor.accent)
              }
            } else {
              VStack(spacing: 12) {
                ForEach(lanes) { lane in
                  Button {
                    selectedLaneId = lane.id
                  } label: {
                    VStack(alignment: .leading, spacing: 8) {
                      HStack(spacing: 12) {
                        Circle()
                          .fill(lane.status.dirty ? ADEColor.warning : ADEColor.success)
                          .frame(width: 10, height: 10)
                        VStack(alignment: .leading, spacing: 4) {
                          Text(lane.name)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(ADEColor.textPrimary)
                          Text(lane.branchRef)
                            .font(.caption.monospaced())
                            .foregroundStyle(ADEColor.textSecondary)
                            .lineLimit(1)
                        }
                        Spacer(minLength: 0)
                        if let devices = lane.devicesOpen, !devices.isEmpty {
                          Image(systemName: devicePresenceSymbol(for: devices))
                            .foregroundStyle(ADEColor.accent)
                        }
                        if selectedLaneId == lane.id {
                          Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(ADEColor.accent)
                        }
                      }

                      HStack(spacing: 6) {
                        if lane.status.dirty {
                          LaneMicroChip(icon: "circle.fill", text: "dirty", tint: ADEColor.warning)
                        }
                        if lane.status.ahead > 0 {
                          LaneMicroChip(icon: "arrow.up", text: "\(lane.status.ahead)", tint: ADEColor.success)
                        }
                        if lane.status.behind > 0 {
                          LaneMicroChip(icon: "arrow.down", text: "\(lane.status.behind)", tint: ADEColor.warning)
                        }
                        if let devices = lane.devicesOpen, !devices.isEmpty {
                          LaneMicroChip(icon: devicePresenceSymbol(for: devices), text: "\(devices.count)", tint: ADEColor.accent)
                        }
                        Spacer(minLength: 0)
                      }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .background(
                      RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .fill(selectedLaneId == lane.id ? ADEColor.accent.opacity(0.12) : ADEColor.surfaceBackground.opacity(0.55))
                    )
                    .overlay(
                      RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .stroke(selectedLaneId == lane.id ? ADEColor.accent.opacity(0.4) : ADEColor.border.opacity(0.18), lineWidth: selectedLaneId == lane.id ? 1.3 : 0.8)
                    )
                    .glassEffect(in: .rect(cornerRadius: 16))
                  }
                  .buttonStyle(.plain)
                }
              }
            }
          }

          GlassSection(title: "Opening prompt") {
            VStack(alignment: .leading, spacing: 8) {
              TextField("Tell the agent what to do", text: $initialMessage, axis: .vertical)
                .textInputAutocapitalization(.sentences)
                .autocorrectionDisabled()
                .adeInsetField(cornerRadius: 14, padding: 12)
                .disabled(busy)

              if let startDisabledReason {
                Label(startDisabledReason, systemImage: "info.circle")
                  .font(.caption2)
                  .foregroundStyle(ADEColor.textMuted)
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
              Text("Creating \(providerLabel(provider)) chat…")
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
      .navigationTitle("New chat")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
            .disabled(busy)
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Start") {
            Task { await submit() }
          }
          .disabled(!canStartChat)
        }
      }
      .onChange(of: selectedModelId) { _, _ in
        if let reasoningEfforts = selectedModel?.reasoningEfforts, !reasoningEfforts.isEmpty {
          if !reasoningEfforts.contains(where: { $0.effort == selectedReasoningEffort }) {
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
      .onAppear {
        if selectedLaneId.isEmpty {
          if let initialLaneId,
             lanes.contains(where: { $0.id == initialLaneId }) {
            selectedLaneId = initialLaneId
          } else {
            selectedLaneId = lanes.first?.id ?? ""
          }
        }
      }
    }
  }

  @MainActor
  func loadModels(resetSelection: Bool) async {
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
      models = []
      selectedModelId = ""
    }
  }

  @MainActor
  func submit() async {
    let openingMessage = trimmedInitialMessage
    guard !openingMessage.isEmpty else {
      errorMessage = "Enter an opening message before starting a chat."
      return
    }
    do {
      busy = true
      let summary = try await syncService.createChatSession(
        laneId: selectedLaneId,
        provider: provider,
        model: selectedModelId,
        reasoningEffort: {
          guard !selectedReasoningEffort.isEmpty else { return nil }
          guard selectedModel?.reasoningEfforts?.contains(where: { $0.effort == selectedReasoningEffort }) == true else { return nil }
          return selectedReasoningEffort
        }()
      )
      await onCreated(WorkDraftChatSession(summary: summary, initialMessage: openingMessage))
      dismiss()
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
    busy = false
  }
}

struct WorkProviderOption: Identifiable {
  let id: String
  let title: String
  let subtitle: String
  let icon: String
  let tint: Color
}

struct WorkRuntimeOption: Identifiable {
  let id: String
  let title: String
  let subtitle: String
}
