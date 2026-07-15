import SwiftUI

/// Streamlined launch config for a single Linear issue: session type + model +
/// permission mode + editable kickoff prompt, then create-lane → launch-agent →
/// navigate to the new session. Model/permission controls reuse the Work
/// composer's catalog + wire-field helpers so provider-native mapping matches.
struct LinearLaunchScreen: View {
  @EnvironmentObject private var syncService: SyncService

  let issue: NormalizedLinearIssue
  /// "Link to new lane" entry — locks to lane-only (no agent config).
  let laneOnly: Bool

  @State private var sessionType: LinearLaunchSessionType = .chat
  @State private var provider: String
  @State private var modelId: String
  @State private var modelName: String
  @State private var reasoningEffort: String
  @State private var codexFastMode: Bool
  @State private var runtimeMode: String
  @State private var kickoff: String
  @State private var selectedModelOption: WorkModelOption?
  @State private var modelPickerPresented = false
  @State private var busy = false
  @State private var errorMessage: String?

  init(issue: NormalizedLinearIssue, laneOnly: Bool = false) {
    self.issue = issue
    self.laneOnly = laneOnly
    _sessionType = State(initialValue: laneOnly ? .laneOnly : .chat)
    let saved = WorkComposerPreferences.load()
    var initialProvider = saved?.provider ?? "claude"
    var initialModelId = saved?.modelId ?? ""
    if initialModelId.isEmpty,
       let fallback = workDefaultModelIdForAvailabilityMode(preferredProvider: initialProvider, mode: .chat) {
      initialModelId = fallback.modelId
      initialProvider = fallback.provider
    }
    let initialRuntime = (saved?.runtimeMode).flatMap { $0.isEmpty ? nil : $0 }
      ?? workDefaultRuntimeMode(provider: initialProvider)
    _provider = State(initialValue: initialProvider)
    _modelId = State(initialValue: initialModelId)
    _modelName = State(initialValue: linearPrettyModelName(initialModelId))
    _reasoningEffort = State(initialValue: saved?.reasoningEffort ?? "")
    _codexFastMode = State(initialValue: saved?.codexFastMode ?? false)
    _runtimeMode = State(initialValue: initialRuntime)
    _kickoff = State(initialValue: linearDefaultKickoff(for: issue))
  }

  private var fastModeSupported: Bool {
    guard sessionType == .chat else { return false }
    if let option = selectedModelOption,
       workModelIdsEquivalent(option.id, modelId),
       option.supportsServiceTier("fast") {
      return true
    }
    return workComposerSupportsFastMode(modelId: modelId, provider: provider)
  }

  private var canLaunch: Bool {
    guard !busy else { return false }
    if sessionType == .laneOnly { return true }
    return !modelId.isEmpty && !kickoff.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        issueSummary
        if !laneOnly { sessionTypePicker }
        if sessionType.needsAgentConfig {
          agentConfig
          kickoffEditor
        } else {
          laneOnlyNote
        }
        if let errorMessage {
          Text(errorMessage)
            .font(.caption)
            .foregroundStyle(ADEColor.danger)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
      }
      .padding(16)
    }
    .scrollContentBackground(.hidden)
    .navigationTitle(laneOnly ? "New lane · \(issue.identifier)" : "Launch \(issue.identifier)")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Button(action: { Task { await performLaunch() } }) {
          if busy {
            ProgressView().controlSize(.small).tint(LinearBrand.primaryBright)
          } else {
            Text(laneOnly ? "Create" : "Launch").font(.body.weight(.semibold))
          }
        }
        .disabled(!canLaunch)
      }
    }
    .sheet(isPresented: $modelPickerPresented) {
      WorkModelPickerSheet(
        currentModelId: modelId,
        currentProvider: provider,
        currentReasoningEffort: reasoningEffort,
        currentCodexFastMode: codexFastMode,
        cursorAvailabilityMode: sessionType == .cli ? .cli : .chat,
        isBusy: false,
        onSelect: { option, pickedReasoning, runtimeProvider, pickedFastMode in
          selectedModelOption = option
          modelId = option.id
          modelName = option.displayName
          provider = sessionType == .cli
            ? workResolveCliProvider(for: option.id, provider: runtimeProvider)
            : runtimeProvider
          reasoningEffort = pickedReasoning ?? ""
          runtimeMode = workDefaultRuntimeMode(provider: provider)
          codexFastMode = option.supportsCodexFastMode ? pickedFastMode : false
        }
      )
    }
    .onAppear {
      normalizeSelection(for: sessionType, resetRuntimeMode: false)
    }
    .onChange(of: sessionType) { _, newType in
      normalizeSelection(for: newType)
    }
  }

  // MARK: Sections

  private var issueSummary: some View {
    HStack(spacing: 10) {
      LinearStateIcon(stateType: issue.stateType, size: 16)
      Text(issue.title)
        .font(.subheadline.weight(.medium))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(2)
      Spacer(minLength: 0)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .adeGlassCard()
  }

  private var sessionTypePicker: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("Session").font(.caption.weight(.semibold)).foregroundStyle(ADEColor.textSecondary)
      HStack(spacing: 6) {
        ForEach([LinearLaunchSessionType.chat, .cli]) { type in
          let isSelected = sessionType == type
          Button {
            withAnimation(.snappy(duration: 0.16)) { sessionType = type }
          } label: {
            HStack(spacing: 6) {
              Image(systemName: type.systemImage).font(.system(size: 12, weight: isSelected ? .semibold : .regular))
              Text(type.title).font(.caption.weight(.semibold))
            }
            .foregroundStyle(isSelected ? .white : ADEColor.textSecondary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 9)
            .background(isSelected ? LinearBrand.primary : ADEColor.surfaceBackground.opacity(0.6), in: Capsule())
            .overlay(Capsule().stroke(isSelected ? Color.clear : ADEColor.glassBorder, lineWidth: 1))
          }
          .buttonStyle(.plain)
        }
      }
    }
  }

  private var agentConfig: some View {
    VStack(spacing: 0) {
      Button { modelPickerPresented = true } label: {
        LinearConfigRow(label: "Model", value: modelName.isEmpty ? "Choose model" : modelName)
      }
      .buttonStyle(.plain)

      Divider().overlay(ADEColor.glassBorder.opacity(0.5))

      Menu {
        ForEach(workRuntimeModeOptions(provider: provider)) { option in
          Button {
            runtimeMode = option.id
          } label: {
            Label(option.title, systemImage: runtimeMode == option.id ? "checkmark" : "")
          }
        }
      } label: {
        LinearConfigRow(label: "Permissions", value: workRuntimeModeLabel(provider: provider, mode: runtimeMode))
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 4)
    .adeGlassCard()
  }

  private var kickoffEditor: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("Kickoff prompt").font(.caption.weight(.semibold)).foregroundStyle(ADEColor.textSecondary)
      TextEditor(text: $kickoff)
        .font(.subheadline)
        .foregroundStyle(ADEColor.textPrimary)
        .adePromptInputTraits()
        .frame(minHeight: 120)
        .scrollContentBackground(.hidden)
        .padding(10)
        .background(ADEColor.surfaceBackground.opacity(0.5), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(ADEColor.glassBorder, lineWidth: 1))
    }
  }

  private var laneOnlyNote: some View {
    ADENoticeCard(
      title: "Create a lane only",
      message: "A lane will be created and attached to \(issue.identifier). No agent is launched \u{2014} start one whenever you\u{2019}re ready.",
      icon: "square.stack.3d.up",
      tint: LinearBrand.primary,
      actionTitle: nil,
      action: nil
    )
  }

  private func normalizeSelection(for type: LinearLaunchSessionType, resetRuntimeMode: Bool = true) {
    guard type.needsAgentConfig else {
      codexFastMode = false
      return
    }

    let availabilityMode: WorkCursorAvailabilityMode = type == .cli ? .cli : .chat
    var replacedModel = false
    if !workModelAllowedForAvailabilityMode(modelId: modelId, provider: provider, mode: availabilityMode),
       let replacement = workDefaultModelIdForAvailabilityMode(preferredProvider: provider, mode: availabilityMode) {
      modelId = replacement.modelId
      modelName = linearPrettyModelName(replacement.modelId)
      provider = type == .cli
        ? workResolveCliProvider(for: replacement.modelId, provider: replacement.provider)
        : replacement.provider
      selectedModelOption = nil
      replacedModel = true
    } else if type == .cli {
      provider = workResolveCliProvider(for: modelId, provider: provider)
    }

    if resetRuntimeMode || replacedModel || runtimeMode.isEmpty {
      runtimeMode = workDefaultRuntimeMode(provider: provider)
    }
    if !modelSupportsReasoning(modelId: modelId, provider: provider) {
      reasoningEffort = ""
    }
    if !fastModeSupported {
      codexFastMode = false
    }
  }

  // MARK: Launch

  private func performLaunch() async {
    guard !busy else { return }
    busy = true
    errorMessage = nil
    ADEHaptics.light()

    let fastSupported = fastModeSupported
    let config = LinearLaunchConfig(
      sessionType: sessionType,
      provider: provider,
      modelId: modelId,
      reasoningEffort: reasoningEffort,
      codexFastMode: codexFastMode,
      runtimeMode: runtimeMode,
      kickoff: kickoff.trimmingCharacters(in: .whitespacesAndNewlines)
    )

    let sync = syncService
    let deps = LinearLaunchDeps(
      createLane: { laneIssue, name, description in
        try await sync.createLane(name: name, description: description, linearIssue: laneIssue).id
      },
      launchChat: { laneId, cfg in
        let wire = workRuntimeWireFields(provider: cfg.provider, mode: cfg.runtimeMode)
        let summary = try await sync.launchChatSession(
          laneId: laneId,
          provider: cfg.provider,
          model: cfg.modelId,
          kickoffText: cfg.kickoff,
          reasoningEffort: cfg.reasoningEffort.isEmpty ? nil : cfg.reasoningEffort,
          codexFastMode: fastSupported ? cfg.codexFastMode : nil,
          permissionMode: wire.permissionMode,
          interactionMode: wire.interactionMode,
          claudePermissionMode: wire.claudePermissionMode,
          codexApprovalPolicy: wire.codexApprovalPolicy,
          codexSandbox: wire.codexSandbox,
          codexConfigSource: wire.codexConfigSource,
          opencodePermissionMode: wire.opencodePermissionMode,
          droidPermissionMode: wire.droidPermissionMode,
          cursorModeId: wire.cursorModeId,
          pendingDisplayName: cfg.kickoff
        )
        return summary.sessionId
      },
      launchCli: { laneId, cfg in
        let cliProvider = workResolveCliProvider(for: cfg.modelId, provider: cfg.provider)
        let wire = workRuntimeWireFields(provider: cliProvider, mode: cfg.runtimeMode)
        let result = try await sync.startCliSession(
          laneId: laneId,
          provider: cliProvider,
          permissionMode: wire.permissionMode,
          title: "\(issue.identifier)",
          initialInput: cfg.kickoff,
          modelId: cfg.modelId,
          reasoningEffort: cfg.reasoningEffort.isEmpty ? nil : cfg.reasoningEffort,
          fastMode: fastSupported ? cfg.codexFastMode : nil,
          cols: 48,
          rows: 24
        )
        return result.sessionId
      },
      deleteLane: { laneId in
        try await sync.deleteLane(laneId)
      }
    )

    do {
      let outcome = try await runLinearLaunch(issue: issue, config: config, deps: deps)
      ADEHaptics.success()
      switch outcome {
      case let .session(_, sessionId):
        WorkComposerPreferences.save(
          provider: provider,
          modelId: modelId,
          runtimeMode: runtimeMode,
          reasoningEffort: reasoningEffort,
          codexFastMode: codexFastMode
        )
        syncService.requestedWorkSessionNavigation = WorkSessionNavigationRequest(sessionId: sessionId)
      case let .laneOnly(laneId):
        syncService.requestedLaneNavigation = LaneNavigationRequest(laneId: laneId)
      }
      syncService.linearPanePresented = false
    } catch is LinearQueuedAgentLaunchError {
      // Offline after lane creation: both chat and CLI launches queue with
      // their initial input, so this handoff is complete from the sheet's view.
      ADEHaptics.medium()
      syncService.linearPanePresented = false
    } catch let error as LinearAmbiguousAgentLaunchError {
      ADEHaptics.error()
      errorMessage = "ADE kept the new lane because the agent may already have started. \(error.localizedDescription)"
      busy = false
    } catch is QueuedRemoteCommandError {
      if config.sessionType.needsAgentConfig {
        ADEHaptics.error()
        errorMessage = "Lane creation was queued, but the agent was not launched yet. Reconnect your machine, wait for the lane to appear, then launch the agent again."
        busy = false
      } else {
        ADEHaptics.medium()
        syncService.linearPanePresented = false
      }
    } catch {
      ADEHaptics.error()
      errorMessage = SyncUserFacingError.message(for: error)
      busy = false
    }
  }
}

// MARK: - Config row

struct LinearConfigRow: View {
  let label: String
  let value: String

  var body: some View {
    HStack {
      Text(label).font(.subheadline).foregroundStyle(ADEColor.textSecondary)
      Spacer()
      Text(value).font(.subheadline.weight(.medium)).foregroundStyle(ADEColor.textPrimary).lineLimit(1)
      Image(systemName: "chevron.up.chevron.down").font(.system(size: 10, weight: .semibold)).foregroundStyle(ADEColor.textMuted)
    }
    .padding(.vertical, 11)
    .contentShape(Rectangle())
  }
}

// MARK: - Model name prettifier

/// Human label for a model id, reusing the Work catalog's known-name table with
/// a Claude-family fallback (mirrors the composer's `prettyNewChatModelName`).
func linearPrettyModelName(_ modelId: String) -> String {
  let trimmed = modelId.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmed.isEmpty else { return "Choose model" }
  if let known = workKnownModelDisplayName(trimmed) { return known }
  if trimmed.lowercased().hasPrefix("claude-") {
    let tail = trimmed.dropFirst("claude-".count)
    let joined = tail.split(separator: "-").map { part -> String in
      let s = String(part)
      if s.range(of: #"^\d+$"#, options: .regularExpression) != nil { return s }
      return s.prefix(1).uppercased() + s.dropFirst()
    }.joined(separator: " ")
    return "Claude " + joined.replacingOccurrences(of: #"(\d+) (\d+)"#, with: "$1.$2", options: .regularExpression)
  }
  return trimmed
}
