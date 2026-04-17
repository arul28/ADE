import SwiftUI
import UIKit
import AVKit

extension WorkSessionSettingsSheet {
  @MainActor
  func loadModels() async {
    do {
      let loadedModels = try await syncService.listChatModels(provider: summary.provider)
      models = loadedModels

      let matchedModelId =
        loadedModels.first(where: { $0.id == selectedModelId })?.id
        ?? loadedModels.first(where: { $0.id == summary.modelId })?.id
        ?? loadedModels.first(where: { $0.id == summary.model })?.id
        ?? loadedModels.first(where: { $0.displayName == summary.model })?.id
        ?? loadedModels.first(where: \.isDefault)?.id
        ?? loadedModels.first?.id
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
    let modelChanged = selectedModelId != resolvedInitialModelId
    let normalizedReasoning = selectedReasoningEffort.trimmingCharacters(in: .whitespacesAndNewlines)
    let reasoningPayload = normalizedReasoning.isEmpty ? "" : normalizedReasoning
    let reasoningChanged = reasoningPayload != resolvedInitialReasoningEffort
    let initialRuntimeMode = workInitialRuntimeMode(summary)
    let initialCursorModeId = workInitialCursorModeId(summary)

    var permissionMode: String?
    var interactionMode: String?
    var claudePermissionMode: String?
    var codexApprovalPolicy: String?
    var codexSandbox: String?
    var codexConfigSource: String?
    var opencodePermissionMode: String?
    var cursorModeId: String?
    var runtimeChanged = false

    switch summary.provider {
    case "claude":
      if selectedRuntimeMode != initialRuntimeMode {
        runtimeChanged = true
        switch selectedRuntimeMode {
        case "plan":
          interactionMode = "plan"
          claudePermissionMode = "default"
          permissionMode = "plan"
        case "edit":
          interactionMode = "default"
          claudePermissionMode = "acceptEdits"
          permissionMode = "edit"
        case "full-auto":
          interactionMode = "default"
          claudePermissionMode = "bypassPermissions"
          permissionMode = "full-auto"
        default:
          interactionMode = "default"
          claudePermissionMode = "default"
          permissionMode = "default"
        }
      }
    case "codex":
      if selectedRuntimeMode != initialRuntimeMode {
        runtimeChanged = true
        codexConfigSource = "flags"
        switch selectedRuntimeMode {
        case "plan":
          codexApprovalPolicy = "untrusted"
          codexSandbox = "read-only"
          permissionMode = "plan"
        case "edit":
          codexApprovalPolicy = "on-failure"
          codexSandbox = "workspace-write"
          permissionMode = "edit"
        case "full-auto":
          codexApprovalPolicy = "never"
          codexSandbox = "danger-full-access"
          permissionMode = "full-auto"
        default:
          codexApprovalPolicy = "on-request"
          codexSandbox = "workspace-write"
          permissionMode = "default"
        }
      }
    case "opencode":
      if selectedRuntimeMode != initialRuntimeMode {
        runtimeChanged = true
        opencodePermissionMode = selectedRuntimeMode
        permissionMode = selectedRuntimeMode
      }
    case "cursor":
      if !selectedCursorModeId.isEmpty && selectedCursorModeId != initialCursorModeId {
        runtimeChanged = true
        cursorModeId = selectedCursorModeId
      }
    default:
      break
    }

    guard titleChanged || modelChanged || reasoningChanged || runtimeChanged else {
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
        permissionMode: permissionMode,
        interactionMode: interactionMode,
        claudePermissionMode: claudePermissionMode,
        codexApprovalPolicy: codexApprovalPolicy,
        codexSandbox: codexSandbox,
        codexConfigSource: codexConfigSource,
        opencodePermissionMode: opencodePermissionMode,
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
