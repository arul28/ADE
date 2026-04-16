import SwiftUI
import UIKit
import AVKit

struct WorkSessionSettingsSheet: View {
  @Environment(\.dismiss) var dismiss
  @EnvironmentObject var syncService: SyncService

  let sessionId: String
  let laneName: String
  let summary: AgentChatSessionSummary
  let onSaved: @MainActor () async -> Void

  @State var titleText: String
  @State var models: [AgentChatModelInfo] = []
  @State var selectedModelId: String
  @State var selectedReasoningEffort: String
  @State var selectedRuntimeMode: String
  @State var selectedCursorModeId: String
  @State var busy = false
  @State var errorMessage: String?

  init(
    sessionId: String,
    laneName: String,
    summary: AgentChatSessionSummary,
    onSaved: @escaping @MainActor () async -> Void
  ) {
    self.sessionId = sessionId
    self.laneName = laneName
    self.summary = summary
    self.onSaved = onSaved
    _titleText = State(initialValue: summary.title ?? defaultWorkChatTitle(provider: summary.provider))
    _selectedModelId = State(initialValue: summary.modelId ?? summary.model)
    _selectedReasoningEffort = State(initialValue: summary.reasoningEffort ?? "")
    _selectedRuntimeMode = State(initialValue: workInitialRuntimeMode(summary))
    _selectedCursorModeId = State(initialValue: workInitialCursorModeId(summary))
  }

  var selectedModel: AgentChatModelInfo? {
    models.first(where: { $0.id == selectedModelId })
  }

  var resolvedInitialModelId: String {
    summary.modelId ?? summary.model
  }

  var resolvedInitialTitle: String {
    (summary.title ?? defaultWorkChatTitle(provider: summary.provider))
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }

  var resolvedInitialReasoningEffort: String {
    summary.reasoningEffort ?? ""
  }

  var runtimeOptions: [WorkRuntimeOption] {
    switch summary.provider {
    case "claude":
      return [
        WorkRuntimeOption(id: "default", title: "Default", subtitle: "Standard approval flow."),
        WorkRuntimeOption(id: "plan", title: "Plan", subtitle: "Analysis and planning turns."),
        WorkRuntimeOption(id: "edit", title: "Edit", subtitle: "Auto-approve file edits."),
        WorkRuntimeOption(id: "full-auto", title: "Full auto", subtitle: "Skip permission prompts."),
      ]
    case "codex":
      return [
        WorkRuntimeOption(id: "default", title: "Default", subtitle: "Ask on request with workspace write."),
        WorkRuntimeOption(id: "plan", title: "Plan", subtitle: "Untrusted approvals with read-only sandbox."),
        WorkRuntimeOption(id: "edit", title: "Edit", subtitle: "Approve on failure with workspace write."),
        WorkRuntimeOption(id: "full-auto", title: "Full auto", subtitle: "Never ask, full sandbox access."),
      ]
    case "opencode":
      return [
        WorkRuntimeOption(id: "plan", title: "Plan", subtitle: "Read-first runtime mode."),
        WorkRuntimeOption(id: "edit", title: "Edit", subtitle: "Normal edit loop."),
        WorkRuntimeOption(id: "full-auto", title: "Full auto", subtitle: "Let the runtime operate freely."),
      ]
    default:
      return []
    }
  }

  var cursorModeOptions: [WorkRuntimeOption] {
    workCursorModeIds(summary.cursorModeSnapshot, fallback: workInitialCursorModeId(summary)).map { modeId in
      WorkRuntimeOption(
        id: modeId,
        title: workCursorModeLabel(modeId),
        subtitle: modeId == (summary.cursorModeId ?? workInitialCursorModeId(summary))
          ? "Current cursor mode."
          : "Switch this session to \(workCursorModeLabel(modeId))."
      )
    }
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: 14) {
          GlassSection(title: "Session") {
            VStack(alignment: .leading, spacing: 12) {
              HStack(spacing: 12) {
                Image(systemName: providerIcon(summary.provider))
                  .font(.system(size: 18, weight: .semibold))
                  .foregroundStyle(providerTint(summary.provider))
                  .frame(width: 34, height: 34)
                  .background(providerTint(summary.provider).opacity(0.14), in: RoundedRectangle(cornerRadius: 12, style: .continuous))

                VStack(alignment: .leading, spacing: 4) {
                  Text(providerLabel(summary.provider))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(ADEColor.textPrimary)
                  Text("Update the live chat without leaving mobile.")
                    .font(.caption)
                    .foregroundStyle(ADEColor.textSecondary)
                }

                Spacer(minLength: 0)
              }

              HStack(spacing: 8) {
                WorkTag(text: laneName, icon: "arrow.triangle.branch", tint: ADEColor.textSecondary)
                WorkTag(
                  text: sessionStatusLabel(for: normalizedWorkChatSessionStatus(session: nil, summary: summary)),
                  icon: workChatStatusIcon(normalizedWorkChatSessionStatus(session: nil, summary: summary)),
                  tint: workChatStatusTint(normalizedWorkChatSessionStatus(session: nil, summary: summary))
                )
              }
            }
          }

          GlassSection(title: "Title") {
            TextField("Name this chat", text: $titleText)
              .textInputAutocapitalization(.sentences)
              .autocorrectionDisabled()
              .adeInsetField(cornerRadius: 14, padding: 12)
          }

          GlassSection(title: "Model") {
            VStack(alignment: .leading, spacing: 12) {
              if models.isEmpty && errorMessage == nil {
                HStack(spacing: 10) {
                  ProgressView()
                    .tint(ADEColor.accent)
                  Text("Loading \(providerLabel(summary.provider)) models…")
                    .font(.subheadline)
                    .foregroundStyle(ADEColor.textSecondary)
                }
              } else if models.isEmpty {
                Text(errorMessage ?? "No models are currently available for \(providerLabel(summary.provider)).")
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
                        .fill(selectedModelId == model.id ? providerTint(summary.provider).opacity(0.14) : ADEColor.surfaceBackground.opacity(0.55))
                    )
                    .overlay(
                      RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .stroke(selectedModelId == model.id ? providerTint(summary.provider).opacity(0.42) : ADEColor.border.opacity(0.18), lineWidth: selectedModelId == model.id ? 1.3 : 0.8)
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

          if summary.provider == "cursor", !cursorModeOptions.isEmpty {
            GlassSection(title: "Cursor mode") {
              VStack(alignment: .leading, spacing: 12) {
                ForEach(cursorModeOptions) { option in
                  Button {
                    selectedCursorModeId = option.id
                  } label: {
                    runtimeCard(option: option, isSelected: selectedCursorModeId == option.id)
                  }
                  .buttonStyle(.plain)
                }
              }
            }
          } else if !runtimeOptions.isEmpty {
            GlassSection(title: "Runtime mode") {
              VStack(alignment: .leading, spacing: 12) {
                ForEach(runtimeOptions) { option in
                  Button {
                    selectedRuntimeMode = option.id
                  } label: {
                    runtimeCard(option: option, isSelected: selectedRuntimeMode == option.id)
                  }
                  .buttonStyle(.plain)
                }
              }
            }
          }

          if let errorMessage, !models.isEmpty {
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
              Text("Updating chat settings…")
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
      .navigationTitle("Chat settings")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
            .disabled(busy)
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Save") {
            Task { await submit() }
          }
          .disabled(busy || selectedModelId.isEmpty)
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
      .task {
        await loadModels()
      }
    }
  }
}
