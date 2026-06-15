import SwiftUI

enum WorkNewSessionMode: String, CaseIterable, Identifiable {
  case chat
  case cli

  var id: String { rawValue }

  var title: String {
    switch self {
    case .chat: return "Chat"
    case .cli: return "CLI"
    }
  }

  var systemImage: String {
    switch self {
    case .chat: return "bubble.left.and.bubble.right"
    case .cli: return "chevron.left.forwardslash.chevron.right"
    }
  }

  var accessibilityDescription: String {
    switch self {
    case .chat: return "In-app chat agent"
    case .cli: return "Terminal CLI agent"
    }
  }
}

/// Desktop `ModeSwitcherPills` parity: compact Chat/CLI toggle for the nav bar.
struct WorkSessionTypeSwitcher: View {
  @Binding var selection: WorkNewSessionMode

  var body: some View {
    HStack(spacing: 4) {
      ForEach(WorkNewSessionMode.allCases) { mode in
        let isSelected = selection == mode
        Button {
          guard !isSelected else { return }
          withAnimation(.snappy(duration: 0.16)) {
            selection = mode
          }
        } label: {
          HStack(spacing: 6) {
            Image(systemName: mode.systemImage)
              .font(.system(size: 12, weight: isSelected ? .semibold : .regular))
              .foregroundStyle(isSelected ? ADEColor.textPrimary : ADEColor.textSecondary)
              .opacity(0.85)
            Text(mode.title)
              .font(.caption.weight(.semibold))
              .foregroundStyle(isSelected ? ADEColor.textPrimary : ADEColor.textSecondary)
          }
          .padding(.horizontal, 14)
          .padding(.vertical, 8)
          .background {
            if isSelected {
              Capsule(style: .continuous)
                .fill(ADEColor.surfaceBackground.opacity(0.85))
            }
          }
          .overlay {
            if isSelected {
              Capsule(style: .continuous)
                .stroke(ADEColor.glassBorder, lineWidth: 0.5)
            }
          }
          .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(mode.title)
        .accessibilityHint(mode.accessibilityDescription)
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
      }
    }
    .padding(4)
    .background(ADEColor.recessedBackground.opacity(0.72), in: Capsule(style: .continuous))
    .overlay {
      Capsule(style: .continuous)
        .stroke(ADEColor.glassBorder, lineWidth: 0.5)
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Session type")
  }
}

/// `yyyyMMdd-HHmmss` stamp for the auto-created lane fallback name, mirroring
/// the desktop `chat-YYYYMMDD-HHMMSS` convention.
private let workAutoLaneNameFormatter: DateFormatter = {
  let formatter = DateFormatter()
  formatter.locale = Locale(identifier: "en_US_POSIX")
  formatter.dateFormat = "yyyyMMdd-HHmmss"
  return formatter
}()

/// Full-screen "Start a new conversation" composer that replaces the modal
/// WorkNewChatSheet. Mirrors the desktop welcome screen: big ADE word-mark,
/// one-line tagline, a minimal workspace pill users can change inline, and a
/// prominent composer anchored at the bottom. Sending fires the host create
/// call and immediately pushes the new session route on top of the current
/// navigation path so the screen flows straight into the live chat instead
/// of bouncing back to the sidebar.
struct WorkNewChatScreen: View {
  @EnvironmentObject var syncService: SyncService
  @Environment(\.dismiss) private var dismiss

  let lanes: [LaneSummary]
  let preferredLaneId: String?
  let onStarted: @MainActor (AgentChatSessionSummary, String) async -> Void
  let onCliStarted: @MainActor (TerminalSessionSummary) async -> Void
  let onRefreshLanes: @MainActor () async -> Void

  @State private var selectedLaneId: String = ""
  @State private var provider: String = "claude"
  @State private var modelId: String = "claude-sonnet-4-6"
  @State private var busy: Bool = false
  @State private var errorMessage: String?
  @State private var modelPickerPresented = false
  @State private var runtimeMode: String = "default"
  @State private var reasoningEffort: String = ""
  @State private var sessionMode: WorkNewSessionMode = .chat

  /// Whether the synthetic "Auto-create lane" entry is the current selection.
  private var isAutoCreateLane: Bool {
    selectedLaneId == workAutoCreateLaneSentinelId
  }

  /// The fallback lane whose tools run until the auto-created lane is ready —
  /// the preferred lane if available, otherwise the first known lane.
  private var autoCreateToolsLane: LaneSummary? {
    if let preferredLaneId, let match = lanes.first(where: { $0.id == preferredLaneId }) {
      return match
    }
    return lanes.first
  }

  var body: some View {
    VStack(spacing: 0) {
      Spacer(minLength: 24)

      ScrollView {
        VStack(spacing: 18) {
          brandMark
          VStack(spacing: 6) {
            Text("Start a new conversation")
              .font(.title3.weight(.semibold))
              .foregroundStyle(ADEColor.textPrimary)
            Text("Ask ADE anything — refactor code, debug issues, or explore ideas.")
              .font(.footnote)
              .foregroundStyle(ADEColor.textSecondary)
              .multilineTextAlignment(.center)
              .padding(.horizontal, 24)
          }

          laneSelector
          autoCreateHelperText
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 16)
      }
      .scrollBounceBehavior(.basedOnSize)
      .scrollDismissesKeyboard(.interactively)

      if let errorMessage {
        Text(errorMessage)
          .font(.caption)
          .foregroundStyle(ADEColor.danger)
          .padding(.horizontal, 20)
          .padding(.bottom, 6)
      }

      composerBar
    }
    .adeScreenBackground()
    .adeNavigationGlass()
    .navigationTitle("")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar(.hidden, for: .tabBar)
    .adeRootTabBarHidden()
    .toolbar {
      ToolbarItem(placement: .principal) {
        WorkSessionTypeSwitcher(selection: $sessionMode)
      }
      ToolbarItem(placement: .topBarTrailing) {
        if busy {
          ProgressView().controlSize(.small)
        }
      }
    }
    .onAppear {
      if selectedLaneId.isEmpty {
        selectedLaneId = preferredLaneId ?? lanes.first?.id ?? ""
      }
      if runtimeMode.isEmpty {
        runtimeMode = workDefaultRuntimeMode(provider: provider)
      }
    }
    .onChange(of: provider) { _, newProvider in
      runtimeMode = workDefaultRuntimeMode(provider: newProvider)
      if !workNewChatModel(modelId, belongsTo: workNormalizedNewChatProvider(newProvider)) {
        modelId = workDefaultNewChatModelId(provider: newProvider)
      }
      if !modelSupportsReasoning(modelId: modelId, provider: newProvider) {
        reasoningEffort = ""
      }
    }
    .onChange(of: sessionMode) { _, newMode in
      normalizeSelection(for: newMode)
    }
    .onChange(of: modelId) { _, newModel in
      if !modelSupportsReasoning(modelId: newModel, provider: provider) {
        reasoningEffort = ""
      }
    }
    .sheet(isPresented: $modelPickerPresented) {
      WorkModelPickerSheet(
        currentModelId: modelId,
        currentProvider: provider,
        currentReasoningEffort: reasoningEffort,
        cursorAvailabilityMode: sessionMode == .cli ? .cli : .chat,
        isBusy: false,
        onSelect: { option, pickedReasoning, runtimeProvider in
          modelId = option.id
          provider = sessionMode == .chat
            ? workNormalizedNewChatProvider(runtimeProvider)
            : workResolveCliProvider(for: option.id, provider: runtimeProvider)
          reasoningEffort = pickedReasoning ?? ""
          runtimeMode = workDefaultRuntimeMode(provider: provider)
          modelPickerPresented = false
        }
      )
    }
  }

  @ViewBuilder
  private var brandMark: some View {
    ZStack {
      Text("ADE")
        .font(.system(size: 84, weight: .heavy, design: .default))
        .foregroundStyle(ADEColor.accent.opacity(0.18))
        .offset(x: 4, y: 4)
      Text("ADE")
        .font(.system(size: 84, weight: .heavy, design: .default))
        .foregroundStyle(
          LinearGradient(
            colors: [ADEColor.textPrimary, ADEColor.accent.opacity(0.9)],
            startPoint: .top,
            endPoint: .bottom
          )
        )
    }
    .padding(.top, 8)
    .accessibilityLabel("ADE")
  }

  @ViewBuilder
  private var laneSelector: some View {
    HStack {
      Spacer(minLength: 0)
      WorkLanePickerDropdown(
        lanes: lanes,
        selectedLaneId: $selectedLaneId,
        onRefresh: onRefreshLanes
      )
      Spacer(minLength: 0)
    }
  }

  /// Helper text shown when auto-create is selected, mirroring desktop's
  /// "Tools use {lane} until the lane is created" notice. Falls back to a generic
  /// phrasing when there is no existing lane to run tools against yet.
  @ViewBuilder
  private var autoCreateHelperText: some View {
    if isAutoCreateLane {
      HStack(spacing: 6) {
        Image(systemName: "info.circle")
          .font(.system(size: 10, weight: .semibold))
          .foregroundStyle(ADEColor.accent)
        Text(autoCreateToolsLane.map { "Tools use \($0.name) until the lane is created." }
          ?? "A fresh lane is created on launch.")
          .font(.caption2)
          .foregroundStyle(ADEColor.textSecondary)
          .multilineTextAlignment(.leading)
        Spacer(minLength: 0)
      }
      .padding(.horizontal, 4)
      .transition(.opacity)
    }
  }

  @ViewBuilder
  private var composerBar: some View {
    WorkNewChatComposerBar(
      sessionMode: sessionMode,
      provider: $provider,
      modelId: modelId,
      modelName: prettyNewChatModelName(modelId),
      busy: busy,
      canStart: !busy && (isAutoCreateLane || !selectedLaneId.isEmpty) && !modelId.isEmpty,
      runtimeMode: $runtimeMode,
      reasoningEffort: $reasoningEffort,
      onOpenModelPicker: { modelPickerPresented = true },
      onSubmit: submit(openingMessage:)
    )
  }

  private func prettyNewChatModelName(_ model: String) -> String {
    let trimmed = model.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return "Model" }
    if let known = workKnownModelDisplayName(trimmed) {
      return known
    }
    let lower = trimmed.lowercased()
    switch lower {
    case "opus": return "Claude Opus 4.7"
    case "opus[1m]", "opus-1m": return "Claude Opus 4.7 1M"
    case "sonnet": return "Claude Sonnet 4.6"
    case "haiku": return "Claude Haiku 4.5"
    default: break
    }
    if lower.hasPrefix("claude-") {
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

  @MainActor
  private func submit(openingMessage: String) async -> Bool {
    let opener = openingMessage.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !busy && (isAutoCreateLane || !selectedLaneId.isEmpty) else { return false }
    guard !opener.isEmpty && !modelId.isEmpty else { return false }
    busy = true
    errorMessage = nil
    let wire = workRuntimeWireFields(provider: provider, mode: runtimeMode)
    let normalizedReasoning = reasoningEffort.trimmingCharacters(in: .whitespacesAndNewlines)

    // Resolve the target lane. When auto-create is selected we mint a fresh
    // lane first; on failure we surface the error and never create the session.
    // Track whether we created the lane so we can clean it up if the session
    // launch fails immediately afterwards (desktop parity).
    let targetLaneId: String
    var createdLaneId: String?
    if isAutoCreateLane {
      do {
        let laneName = autoCreatedLaneName(opener: opener)
        let lane = try await syncService.createLane(
          name: laneName,
          description: opener.isEmpty ? "" : String(opener.prefix(280))
        )
        targetLaneId = lane.id
        createdLaneId = lane.id
        await onRefreshLanes()
      } catch {
        ADEHaptics.error()
        errorMessage = error.localizedDescription
        busy = false
        return false
      }
    } else {
      targetLaneId = selectedLaneId
    }

    do {
      if sessionMode == .cli {
        let cliProvider = workResolveCliProvider(for: modelId, provider: provider)
        let cliReasoningEffort = workCliSupportsReasoningSelection(provider: cliProvider) && !normalizedReasoning.isEmpty
          ? normalizedReasoning
          : nil
        let result = try await syncService.startCliSession(
          laneId: targetLaneId,
          provider: cliProvider,
          permissionMode: workCliPermissionMode(provider: cliProvider, runtimeMode: runtimeMode),
          title: workCliInitialSessionTitle(provider: cliProvider, opener: opener),
          initialInput: opener,
          modelId: modelId,
          reasoningEffort: cliReasoningEffort,
          cols: 48,
          rows: 24
        )
        if let session = result.session {
          await onCliStarted(session)
        } else {
          let lane = lanes.first(where: { $0.id == targetLaneId })
          await onCliStarted(TerminalSessionSummary(
            id: result.sessionId,
            laneId: targetLaneId,
            laneName: lane?.name ?? targetLaneId,
            ptyId: result.ptyId,
            tracked: true,
            pinned: false,
            manuallyNamed: nil,
            goal: opener.isEmpty ? nil : opener,
            toolType: workCliToolType(provider: cliProvider),
            title: workCliInitialSessionTitle(provider: cliProvider, opener: opener),
            status: "running",
            startedAt: workDateFormatter.string(from: Date()),
            endedAt: nil,
            exitCode: nil,
            transcriptPath: "",
            headShaStart: nil,
            headShaEnd: nil,
            lastOutputPreview: nil,
            summary: nil,
            runtimeState: "running",
            resumeCommand: nil,
            resumeMetadata: nil,
            chatIdleSinceAt: nil
          ))
        }
        busy = false
        return true
      }
      let summary = try await syncService.createChatSession(
        laneId: targetLaneId,
        provider: provider,
        model: modelId,
        reasoningEffort: normalizedReasoning.isEmpty ? nil : normalizedReasoning,
        permissionMode: wire.permissionMode,
        interactionMode: wire.interactionMode,
        claudePermissionMode: wire.claudePermissionMode,
        codexApprovalPolicy: wire.codexApprovalPolicy,
        codexSandbox: wire.codexSandbox,
        codexConfigSource: wire.codexConfigSource,
        opencodePermissionMode: wire.opencodePermissionMode,
        droidPermissionMode: wire.droidPermissionMode,
        cursorModeId: wire.cursorModeId
      )
      await onStarted(summary, opener)
      busy = false
      return true
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
      // The session never launched into a lane we just minted — tear it back
      // down so an auto-create failure doesn't leave an orphaned empty lane.
      if let createdLaneId {
        try? await syncService.deleteLane(createdLaneId)
        await onRefreshLanes()
      }
      busy = false
      return false
    }
  }

  /// Builds a reasonable lane name for an auto-created lane: derived from the
  /// prompt's leading words when present, otherwise a timestamped default that
  /// mirrors desktop's `chat-YYYYMMDD-HHMMSS` fallback.
  private func autoCreatedLaneName(opener: String) -> String {
    let seed = opener
      .replacingOccurrences(of: "\n", with: " ")
      .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
      .trimmingCharacters(in: .whitespacesAndNewlines)
    if !seed.isEmpty {
      let words = seed.split(separator: " ").prefix(6).joined(separator: " ")
      let clipped = words.count > 48 ? String(words.prefix(48)) : words
      let trimmed = clipped.trimmingCharacters(in: CharacterSet(charactersIn: ".?!,:; ").union(.whitespacesAndNewlines))
      if !trimmed.isEmpty {
        return trimmed
      }
    }
    let now = Date()
    let stamp = workAutoLaneNameFormatter.string(from: now)
    return "chat-\(stamp)"
  }

  private func normalizeSelection(for mode: WorkNewSessionMode) {
    let availabilityMode: WorkCursorAvailabilityMode = mode == .cli ? .cli : .chat
    if !workModelAllowedForAvailabilityMode(modelId: modelId, provider: provider, mode: availabilityMode),
       let replacement = workDefaultModelIdForAvailabilityMode(preferredProvider: provider, mode: availabilityMode) {
      modelId = replacement.modelId
      provider = mode == .chat
        ? workNormalizedNewChatProvider(replacement.provider)
        : workResolveCliProvider(for: replacement.modelId, provider: replacement.provider)
    } else if mode == .chat {
      provider = workNormalizedNewChatProvider(provider)
      if !workNewChatModel(modelId, belongsTo: provider) {
        modelId = workDefaultNewChatModelId(provider: provider)
      }
    } else {
      provider = workResolveCliProvider(for: modelId, provider: provider)
    }
    runtimeMode = workDefaultRuntimeMode(provider: provider)
    if !modelSupportsReasoning(modelId: modelId, provider: provider) {
      reasoningEffort = ""
    }
  }
}

private func workNormalizedNewChatProvider(_ provider: String) -> String {
  let family = providerFamilyKey(provider)
  return ["claude", "codex", "cursor", "opencode"].contains(family) ? family : "claude"
}

private func workNewChatModel(_ modelId: String, belongsTo provider: String) -> Bool {
  let trimmed = modelId.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmed.isEmpty else { return false }
  return workModelCatalogGroupKey(for: trimmed, currentProvider: provider) == provider
}

private func workDefaultNewChatModelId(provider: String) -> String {
  let family = providerFamilyKey(provider)
  if let defaultModel = workDefaultCatalogModelId(provider: family) {
    return defaultModel
  }
  switch workNormalizedNewChatProvider(provider) {
  case "codex": return workDefaultCatalogModelId(provider: "codex") ?? "gpt-5.5"
  case "cursor": return "auto"
  case "opencode": return "opencode/anthropic/claude-sonnet-4-6"
  default: return "claude-sonnet-4-6"
  }
}

private func workCliSupportsReasoningSelection(provider: String) -> Bool {
  let family = providerFamilyKey(provider)
  return family == "claude" || family == "codex" || family == "droid"
}

private func workCliInitialSessionTitle(provider: String, opener: String) -> String {
  let fallback = providerLabel(provider)
  let seed = opener
    .replacingOccurrences(of: "\n", with: " ")
    .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
    .trimmingCharacters(in: .whitespacesAndNewlines)
  guard !seed.isEmpty else {
    return fallback
  }
  let clipped: String
  if seed.count > 72 {
    let prefix = String(seed.prefix(72))
    clipped = prefix.replacingOccurrences(of: #"\s+\S*$"#, with: "", options: .regularExpression)
  } else {
    clipped = seed
  }
  return clipped.trimmingCharacters(in: CharacterSet(charactersIn: ".?!,:; ").union(.whitespacesAndNewlines))
}

func workCliPermissionMode(provider: String, runtimeMode: String) -> String? {
  let wire = workRuntimeWireFields(provider: provider, mode: runtimeMode)
  guard let permissionMode = wire.permissionMode, !permissionMode.isEmpty else {
    return nil
  }
  return permissionMode
}

private func workCliToolType(provider: String) -> String {
  switch providerFamilyKey(provider) {
  case "claude": return "claude"
  case "codex": return "codex"
  case "cursor": return "cursor-cli"
  case "opencode": return "opencode"
  case "droid": return "droid"
  default: return "opencode"
  }
}

private struct WorkNewChatComposerBar: View {
  let sessionMode: WorkNewSessionMode
  @Binding var provider: String
  let modelId: String
  let modelName: String
  let busy: Bool
  let canStart: Bool
  @Binding var runtimeMode: String
  @Binding var reasoningEffort: String
  let onOpenModelPicker: () -> Void
  let onSubmit: @MainActor (String) async -> Bool

  @State private var draft: String = ""
  @FocusState private var composerFocused: Bool
  @StateObject private var dictationCoordinator = DictationInsertionCoordinator()
  @State private var isDictating = false
  private let dictationTargetId = "work-new-chat-screen"

  private var trimmedDraft: String {
    draft.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private var canSend: Bool {
    canStart && !trimmedDraft.isEmpty
  }

  private var runtimeOptions: [WorkRuntimeModeOption] {
    workRuntimeModeOptions(provider: provider)
  }

  private var runtimeLabel: String {
    workRuntimeModeLabel(provider: provider, mode: runtimeMode)
  }

  private var runtimeTint: Color {
    workRuntimeModeTint(runtimeMode)
  }

  private var placeholder: String {
    "Type to vibecode…"
  }

  private var sendLabel: String {
    "Send"
  }

  @MainActor
  private func dispatch() {
    let text = trimmedDraft
    draft = ""
    Task {
      let started = await onSubmit(text)
      if !started {
        draft = text
      }
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      TextField(placeholder, text: $draft, axis: .vertical)
        .textFieldStyle(.plain)
        .lineLimit(1...6)
        .font(.body)
        .foregroundStyle(ADEColor.textPrimary)
        .tint(ADEColor.accent)
        .autocorrectionDisabled(false)
        .textInputAutocapitalization(.sentences)
        .focused($composerFocused)
        .frame(maxWidth: .infinity, minHeight: 28, alignment: .leading)

      HStack(alignment: .center, spacing: 8) {
        if !isDictating {
          ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .center, spacing: 10) {
              modelPickerButton

              if !runtimeOptions.isEmpty {
                HStack(spacing: 6) {
                  ForEach(runtimeOptions) { option in
                    compactChoiceChip(
                      title: option.title,
                      systemImage: nil,
                      tint: workRuntimeModeTint(option.id),
                      isSelected: option.id == runtimeMode,
                      accessibilityPrefix: "Access mode"
                    ) {
                      runtimeMode = option.id
                    }
                  }
                }
              }
            }
            .padding(.trailing, 4)
          }

          DictationRawUndoChip(coordinator: dictationCoordinator, draft: $draft)
        }

        DictationMicButton(
          draft: $draft,
          coordinator: dictationCoordinator,
          targetId: dictationTargetId,
          onRecordingChange: { isDictating = $0 }
        )
        .frame(maxWidth: isDictating ? .infinity : nil)

        if !isDictating {
          foregroundSendButton
        }
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 14)
    .background(
      RoundedRectangle(cornerRadius: 24, style: .continuous)
        .fill(ADEColor.composerBackground)
    )
    .glassEffect(in: .rect(cornerRadius: 24))
    .overlay(
      RoundedRectangle(cornerRadius: 24, style: .continuous)
        .fill(
          LinearGradient(
            colors: [Color.white.opacity(0.10), .clear],
            startPoint: .top,
            endPoint: .bottom
          )
        )
        .allowsHitTesting(false)
    )
    .overlay(
      RoundedRectangle(cornerRadius: 24, style: .continuous)
        .stroke(ADEColor.glassBorder, lineWidth: 1)
    )
    .shadow(color: Color.black.opacity(0.32), radius: 14, y: 6)
    .padding(.horizontal, 16)
    .padding(.bottom, 0)
  }

  /// Primary foreground launch button — navigates into the new live chat.
  private var foregroundSendButton: some View {
    Button {
      dispatch()
    } label: {
      HStack(spacing: 5) {
        if busy {
          ProgressView()
            .controlSize(.mini)
            .tint(canSend ? Color.white : ADEColor.textSecondary)
        } else {
          Image(systemName: "paperplane.fill")
            .font(.system(size: 12, weight: .bold))
        }
        Text(sendLabel)
          .font(.caption.weight(.semibold))
      }
      .foregroundStyle(canSend ? Color.white : ADEColor.textSecondary)
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      .background(
        Capsule(style: .continuous)
          .fill(canSend ? ADEColor.accent : ADEColor.surfaceBackground.opacity(0.85))
      )
      .overlay(
        Capsule(style: .continuous)
          .stroke(canSend ? Color.clear : ADEColor.border.opacity(0.35), lineWidth: 0.8)
      )
      .shadow(color: canSend ? ADEColor.accent.opacity(0.4) : .clear, radius: 8, y: 2)
    }
    .buttonStyle(.plain)
    .disabled(!canSend || busy)
    .accessibilityLabel(canSend ? "Send" : "Enter a message to send")
  }

  private func compactChoiceChip(
    title: String,
    systemImage: String?,
    tint: Color,
    isSelected: Bool,
    accessibilityPrefix: String,
    action: @escaping () -> Void
  ) -> some View {
    Button(action: action) {
      HStack(spacing: 6) {
        Circle().fill(tint).frame(width: 6, height: 6)
        if let systemImage {
          Image(systemName: systemImage)
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(isSelected ? tint : ADEColor.textMuted)
        }
        Text(title)
          .font(.caption.weight(.semibold))
          .foregroundStyle(isSelected ? ADEColor.textPrimary : ADEColor.textSecondary)
          .lineLimit(1)
        if isSelected {
          Image(systemName: "checkmark")
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(tint)
        }
      }
      .padding(.horizontal, 9)
      .padding(.vertical, 6)
      .background((isSelected ? tint.opacity(0.12) : Color.clear), in: Capsule(style: .continuous))
      .overlay(
        Capsule(style: .continuous)
          .stroke(isSelected ? tint.opacity(0.4) : ADEColor.border.opacity(0.22), lineWidth: 0.5)
      )
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(accessibilityPrefix): \(title)")
    .accessibilityValue(isSelected ? "Selected" : "")
  }

  private var modelPickerButton: some View {
    Button {
      onOpenModelPicker()
    } label: {
      HStack(spacing: 6) {
        WorkProviderLogo(
          provider: provider,
          fallbackSymbol: providerIcon(provider),
          tint: providerTint(provider),
          size: 16
        )
        Text(modelName)
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
        if !reasoningEffort.isEmpty {
          Text("·")
            .font(.caption2)
            .foregroundStyle(ADEColor.textMuted.opacity(0.5))
          Text(reasoningEffort.capitalized)
            .font(.system(size: 10, weight: .medium))
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
        }
        Image(systemName: "chevron.down")
          .font(.system(size: 9, weight: .bold))
          .foregroundStyle(ADEColor.textMuted)
      }
      .padding(.horizontal, 9)
      .padding(.vertical, 6)
      .background(Color.clear, in: Capsule(style: .continuous))
      .overlay(
        Capsule(style: .continuous)
          .stroke(ADEColor.border.opacity(0.22), lineWidth: 0.5)
      )
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Model: \(modelName). Tap to change.")
  }
}

struct WorkNewChatRoute: Hashable {
  let preferredLaneId: String?
}
