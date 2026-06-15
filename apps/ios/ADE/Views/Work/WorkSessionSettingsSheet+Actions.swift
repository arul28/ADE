import SwiftUI
import UIKit
import AVKit

extension WorkSessionSettingsSheet {
  @MainActor
  func loadModels() async {
    do {
      let loadedModels = try await syncService.listChatModels(provider: summary.provider)
      let scopedModels = summary.provider == "cursor"
        ? workFilterChatModelsForCursorAvailability(loadedModels, mode: .chat)
        : loadedModels
      models = scopedModels

      let matchedModelId =
        scopedModels.first(where: { workModelIdsEquivalent($0.id, selectedModelId) || workModelIdsEquivalent($0.modelId, selectedModelId) })?.id
        ?? scopedModels.first(where: { workModelIdsEquivalent($0.id, summary.modelId) || workModelIdsEquivalent($0.modelId, summary.modelId) })?.id
        ?? scopedModels.first(where: { workModelIdsEquivalent($0.id, summary.model) || workModelIdsEquivalent($0.modelId, summary.model) })?.id
        ?? scopedModels.first(where: { $0.displayName == summary.model })?.id
        ?? scopedModels.first(where: \.isDefault)?.id
        ?? scopedModels.first?.id
        ?? ""

      selectedModelId = matchedModelId
      if let selectedModel,
         let reasoningEfforts = selectedModel.reasoningEfforts,
         reasoningEfforts.contains(where: { $0.effort == selectedReasoningEffort }) == false {
        selectedReasoningEffort = ""
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
    let trimmedTitle = titleText.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedTitle.isEmpty else {
      ADEHaptics.error()
      errorMessage = "Chat title cannot be empty."
      return
    }

    let titleChanged = trimmedTitle != resolvedInitialTitle
    let modelChanged = !workModelIdsEquivalent(selectedModelId, resolvedInitialModelId)
    let normalizedReasoning = selectedReasoningEffort.trimmingCharacters(in: .whitespacesAndNewlines)
    let reasoningPayload = normalizedReasoning.isEmpty ? "" : normalizedReasoning
    let reasoningChanged = reasoningPayload != resolvedInitialReasoningEffort
    let effectiveCodexFastMode = supportsCodexFastModeToggle ? selectedCodexFastMode : false
    let codexFastModeChanged = effectiveCodexFastMode != resolvedInitialCodexFastMode
    let initialRuntimeMode = workInitialRuntimeMode(summary)

    var permissionMode: String?
    var interactionMode: String?
    var claudePermissionMode: String?
    var codexApprovalPolicy: String?
    var codexSandbox: String?
    var codexConfigSource: String?
    var opencodePermissionMode: String?
    var droidPermissionMode: String?
    var cursorModeId: String?
    var runtimeChanged = false

    switch summary.provider {
    case "claude":
      if selectedRuntimeMode != initialRuntimeMode {
        runtimeChanged = true
        let wire = workRuntimeWireFields(provider: summary.provider, mode: selectedRuntimeMode)
        permissionMode = wire.permissionMode
        interactionMode = wire.interactionMode
        claudePermissionMode = wire.claudePermissionMode
      }
    case "codex":
      if selectedRuntimeMode != initialRuntimeMode {
        runtimeChanged = true
        let wire = workRuntimeWireFields(provider: summary.provider, mode: selectedRuntimeMode)
        permissionMode = wire.permissionMode
        codexApprovalPolicy = wire.codexApprovalPolicy
        codexSandbox = wire.codexSandbox
        codexConfigSource = wire.codexConfigSource
      }
    case "opencode":
      if selectedRuntimeMode != initialRuntimeMode {
        runtimeChanged = true
        let wire = workRuntimeWireFields(provider: summary.provider, mode: selectedRuntimeMode)
        opencodePermissionMode = wire.opencodePermissionMode
        permissionMode = wire.permissionMode
      }
    case "droid", "factory":
      if selectedRuntimeMode != initialRuntimeMode {
        runtimeChanged = true
        let wire = workRuntimeWireFields(provider: "droid", mode: selectedRuntimeMode)
        droidPermissionMode = wire.droidPermissionMode
        permissionMode = wire.permissionMode
      }
    case "cursor":
      if selectedRuntimeMode != initialRuntimeMode {
        runtimeChanged = true
        let wire = workRuntimeWireFields(provider: summary.provider, mode: selectedRuntimeMode)
        permissionMode = wire.permissionMode
        cursorModeId = wire.cursorModeId
      }
    default:
      break
    }

    guard titleChanged || modelChanged || reasoningChanged || runtimeChanged || codexFastModeChanged else {
      dismiss()
      return
    }

    do {
      busy = true
      _ = try await syncService.updateChatSession(
        sessionId: sessionId,
        title: titleChanged ? trimmedTitle : nil,
        modelId: modelChanged ? selectedModelId : nil,
        reasoningEffort: reasoningChanged ? reasoningPayload : nil,
        codexFastMode: codexFastModeChanged ? effectiveCodexFastMode : nil,
        permissionMode: permissionMode,
        interactionMode: interactionMode,
        claudePermissionMode: claudePermissionMode,
        codexApprovalPolicy: codexApprovalPolicy,
        codexSandbox: codexSandbox,
        codexConfigSource: codexConfigSource,
        opencodePermissionMode: opencodePermissionMode,
        droidPermissionMode: droidPermissionMode,
        cursorModeId: cursorModeId,
        manuallyNamed: titleChanged ? true : nil
      )
      if titleChanged {
        try await syncService.updateSessionMeta(
          sessionId: sessionId,
          title: trimmedTitle,
          manuallyNamed: true
        )
      }
      await onSaved()
      dismiss()
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
    busy = false
  }

  func runtimeCard(option: WorkRuntimeOption, isSelected: Bool) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 10) {
        VStack(alignment: .leading, spacing: 4) {
          Text(option.title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text(option.subtitle)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(2)
        }

        Spacer(minLength: 8)

        if isSelected {
          Image(systemName: "checkmark.circle.fill")
            .foregroundStyle(ADEColor.accent)
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(12)
    .background(
      RoundedRectangle(cornerRadius: 16, style: .continuous)
        .fill(isSelected ? providerTint(summary.provider).opacity(0.14) : ADEColor.surfaceBackground.opacity(0.55))
    )
    .overlay(
      RoundedRectangle(cornerRadius: 16, style: .continuous)
        .stroke(isSelected ? providerTint(summary.provider).opacity(0.42) : ADEColor.border.opacity(0.18), lineWidth: isSelected ? 1.3 : 0.8)
    )
    .glassEffect(in: .rect(cornerRadius: 16))
  }
}
