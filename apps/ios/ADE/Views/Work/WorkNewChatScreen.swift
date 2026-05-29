import SwiftUI

enum WorkNewSessionMode: String, CaseIterable, Identifiable {
  case chat
  case cli

  var id: String { rawValue }

  var title: String {
    switch self {
    case .chat: return "ADE chat"
    case .cli: return "CLI session"
    }
  }
}

struct WorkCliProviderOption: Identifiable, Hashable {
  let id: String
  let title: String
}

private let workCliProviderOptions: [WorkCliProviderOption] = [
  WorkCliProviderOption(id: "claude", title: "Claude Code"),
  WorkCliProviderOption(id: "codex", title: "Codex"),
  WorkCliProviderOption(id: "cursor", title: "Cursor Agent CLI"),
  WorkCliProviderOption(id: "opencode", title: "OpenCode CLI"),
  WorkCliProviderOption(id: "droid", title: "Factory Droid CLI"),
  WorkCliProviderOption(id: "shell", title: "Shell"),
]

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

  private var selectedLaneName: String {
    if let match = lanes.first(where: { $0.id == selectedLaneId }) {
      return match.name
    }
    return "Choose lane"
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
          modeSelector
          if sessionMode == .cli {
            cliProviderSelector
          }
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
    .navigationTitle("New Chat")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar(.hidden, for: .tabBar)
    .adeRootTabBarHidden()
    .toolbar {
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
      if sessionMode == .cli {
        normalizeCliSelection()
      } else if !workNewChatModel(modelId, belongsTo: workNormalizedNewChatProvider(newProvider)) {
        modelId = workDefaultNewChatModelId(provider: newProvider)
      }
      if !modelSupportsReasoning(modelId: modelId, provider: newProvider) {
        reasoningEffort = ""
      }
    }
    .onChange(of: sessionMode) { _, newMode in
      if newMode == .chat {
        normalizeChatSelection()
      } else {
        normalizeCliSelection()
      }
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
          provider = runtimeProvider
          reasoningEffort = pickedReasoning ?? ""
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

  @ViewBuilder
  private var laneSelector: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        ForEach(lanes) { lane in
          compactChoiceChip(
            title: lane.name,
            systemImage: "arrow.triangle.branch",
            tint: ADEColor.accent,
            isSelected: lane.id == selectedLaneId,
            accessibilityPrefix: "Lane"
          ) {
            selectedLaneId = lane.id
          }
        }
        if lanes.isEmpty {
          Text("No lanes available")
            .font(.footnote.weight(.semibold))
            .foregroundStyle(ADEColor.textMuted)
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .background(ADEColor.surfaceBackground.opacity(0.55), in: Capsule(style: .continuous))
        }
        Button {
          Task { await onRefreshLanes() }
        } label: {
          Image(systemName: "arrow.clockwise")
            .font(.caption.weight(.semibold))
            .foregroundStyle(ADEColor.accent)
            .frame(width: 34, height: 34)
            .background(ADEColor.surfaceBackground.opacity(0.55), in: Circle())
            .glassEffect()
            .overlay(Circle().stroke(ADEColor.accent.opacity(0.26), lineWidth: 0.6))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Refresh lanes")
      }
    }
    .frame(maxWidth: .infinity)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Lane selector. Current lane \(selectedLaneName).")
  }

  @ViewBuilder
  private var modeSelector: some View {
    HStack(spacing: 3) {
      ForEach(WorkNewSessionMode.allCases) { mode in
        let isSelected = sessionMode == mode
        Button {
          guard !isSelected else { return }
          withAnimation(.snappy(duration: 0.16)) {
            sessionMode = mode
          }
        } label: {
          Text(mode.title)
            .font(.caption.weight(.semibold))
            .foregroundStyle(isSelected ? ADEColor.textPrimary : ADEColor.textSecondary)
            .lineLimit(1)
            .minimumScaleFactor(0.85)
            .frame(maxWidth: .infinity, minHeight: 34)
            .padding(.horizontal, 8)
            .background {
              if isSelected {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                  .fill(ADEColor.accent.opacity(0.18))
              }
            }
            .overlay {
              if isSelected {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                  .stroke(ADEColor.accent.opacity(0.35), lineWidth: 0.75)
              }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Session type: \(mode.title)")
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
      }
    }
    .padding(3)
    .background(ADEColor.recessedBackground.opacity(0.72), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .overlay {
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .stroke(ADEColor.glassBorder, lineWidth: 0.5)
    }
    .padding(.horizontal, 8)
  }

  @ViewBuilder
  private var cliProviderSelector: some View {
    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
      ForEach(workCliProviderOptions) { option in
        let isSelected = provider == option.id
        Button {
          provider = option.id
        } label: {
          HStack(spacing: 8) {
            WorkProviderLogo(
              provider: option.id,
              fallbackSymbol: option.id == "shell" ? "terminal.fill" : providerIcon(option.id),
              tint: providerTint(option.id),
              size: 16
            )
            Text(option.title)
              .font(.caption.weight(.semibold))
              .foregroundStyle(isSelected ? ADEColor.textPrimary : ADEColor.textSecondary)
              .lineLimit(1)
              .minimumScaleFactor(0.78)
            Spacer(minLength: 0)
          }
          .frame(maxWidth: .infinity, minHeight: 34, alignment: .leading)
          .padding(.horizontal, 10)
          .background {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
              .fill(isSelected ? providerTint(option.id).opacity(0.16) : ADEColor.surfaceBackground.opacity(0.55))
          }
          .overlay {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
              .stroke(isSelected ? providerTint(option.id).opacity(0.36) : ADEColor.border.opacity(0.22), lineWidth: 0.6)
          }
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("CLI provider: \(option.title)")
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
      }
    }
    .padding(.horizontal, 8)
  }

  @ViewBuilder
  private var composerBar: some View {
    WorkNewChatComposerBar(
      sessionMode: sessionMode,
      provider: $provider,
      modelId: modelId,
      modelName: prettyNewChatModelName(modelId),
      busy: busy,
      canStart: !busy && !selectedLaneId.isEmpty && (sessionMode == .cli || !modelId.isEmpty),
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
    guard !busy && !selectedLaneId.isEmpty else { return false }
    if sessionMode == .chat {
      guard !opener.isEmpty && !modelId.isEmpty else { return false }
    }
    busy = true
    errorMessage = nil
    let wire = workRuntimeWireFields(provider: provider, mode: runtimeMode)
    let normalizedReasoning = reasoningEffort.trimmingCharacters(in: .whitespacesAndNewlines)
    do {
      if sessionMode == .cli {
        let cliModelId = workCliSupportsModelSelection(provider: provider) ? modelId : nil
        let cliReasoningEffort = workCliSupportsReasoningSelection(provider: provider) && !normalizedReasoning.isEmpty
          ? normalizedReasoning
          : nil
        let result = try await syncService.startCliSession(
          laneId: selectedLaneId,
          provider: provider,
          permissionMode: workCliPermissionMode(provider: provider, runtimeMode: runtimeMode),
          title: workCliInitialSessionTitle(provider: provider, opener: opener),
          initialInput: opener.isEmpty ? nil : opener,
          modelId: cliModelId,
          reasoningEffort: cliReasoningEffort,
          cols: 48,
          rows: 24
        )
        if let session = result.session {
          await onCliStarted(session)
        } else {
          let lane = lanes.first(where: { $0.id == selectedLaneId })
          await onCliStarted(TerminalSessionSummary(
            id: result.sessionId,
            laneId: selectedLaneId,
            laneName: lane?.name ?? selectedLaneId,
            ptyId: result.ptyId,
            tracked: true,
            pinned: false,
            manuallyNamed: nil,
            goal: opener.isEmpty ? nil : opener,
            toolType: workCliToolType(provider: provider),
            title: workCliInitialSessionTitle(provider: provider, opener: opener),
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
        laneId: selectedLaneId,
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
      busy = false
      return false
    }
  }

  private func normalizeChatSelection() {
    let normalizedProvider = workNormalizedNewChatProvider(provider)
    if provider != normalizedProvider {
      provider = normalizedProvider
    }
    if !workNewChatModel(modelId, belongsTo: normalizedProvider) {
      modelId = workDefaultNewChatModelId(provider: normalizedProvider)
    }
    runtimeMode = workDefaultRuntimeMode(provider: normalizedProvider)
    if !modelSupportsReasoning(modelId: modelId, provider: normalizedProvider) {
      reasoningEffort = ""
    }
  }

  private func normalizeCliSelection() {
    let family = providerFamilyKey(provider)
    guard workCliSupportsModelSelection(provider: family) else {
      reasoningEffort = ""
      return
    }
    if !workNewChatModel(modelId, belongsTo: family) {
      modelId = workDefaultNewChatModelId(provider: family)
    }
    if (!workCliSupportsReasoningSelection(provider: family)
        || !modelSupportsReasoning(modelId: modelId, provider: family)) {
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

private func workCliSupportsModelSelection(provider: String) -> Bool {
  providerFamilyKey(provider) != "shell"
}

private func workCliSupportsReasoningSelection(provider: String) -> Bool {
  let family = providerFamilyKey(provider)
  return family == "claude" || family == "codex" || family == "droid"
}

private func workCliInitialSessionTitle(provider: String, opener: String) -> String {
  let fallback = workCliProviderOptions.first(where: { $0.id == provider })?.title ?? providerLabel(provider)
  let seed = opener
    .replacingOccurrences(of: "\n", with: " ")
    .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
    .trimmingCharacters(in: .whitespacesAndNewlines)
  guard !seed.isEmpty, providerFamilyKey(provider) != "shell" else {
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
  if provider.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "shell" {
    return nil
  }
  let wire = workRuntimeWireFields(provider: provider, mode: runtimeMode)
  return wire.permissionMode ?? (runtimeMode.isEmpty ? nil : runtimeMode)
}

private func workCliToolType(provider: String) -> String {
  switch providerFamilyKey(provider) {
  case "claude": return "claude"
  case "codex": return "codex"
  case "cursor": return "cursor-cli"
  case "opencode": return "opencode"
  case "droid": return "droid"
  default: return "shell"
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

  private var trimmedDraft: String {
    draft.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private var canSend: Bool {
    canStart && (sessionMode == .cli || !trimmedDraft.isEmpty)
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

  private var acceptsOpeningMessage: Bool {
    !(sessionMode == .cli && provider == "shell")
  }

  private var placeholder: String {
    if sessionMode == .cli && provider == "shell" {
      return "Shell starts empty; type after it opens"
    }
    return sessionMode == .cli ? "Optional first instruction…" : "Type to vibecode…"
  }

  private var sendLabel: String {
    sessionMode == .cli ? "Start" : "Send"
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
        .disabled(!acceptsOpeningMessage)
        .opacity(acceptsOpeningMessage ? 1 : 0.62)

      HStack(alignment: .center, spacing: 8) {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(alignment: .center, spacing: 10) {
            if sessionMode == .chat {
              modelPickerButton
            } else {
              cliProviderChips
              if workCliSupportsModelSelection(provider: provider) {
                modelPickerButton
              }
            }

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

        Button {
          let text = acceptsOpeningMessage ? trimmedDraft : ""
          draft = ""
          Task {
            let started = await onSubmit(text)
            if !started {
              draft = text
            }
          }
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
        .disabled(!canSend)
        .accessibilityLabel(canSend ? (sessionMode == .cli ? "Start CLI session" : "Start chat") : "Enter a message to start")
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
    .onChange(of: provider) { _, _ in
      if !acceptsOpeningMessage { draft = "" }
    }
    .onChange(of: sessionMode) { _, _ in
      if !acceptsOpeningMessage { draft = "" }
    }
  }

  private var cliProviderChips: some View {
    HStack(spacing: 6) {
      ForEach(workCliProviderOptions) { option in
        compactChoiceChip(
          title: option.title,
          systemImage: option.id == "shell" ? "terminal.fill" : providerIcon(option.id),
          tint: providerTint(option.id),
          isSelected: option.id == provider,
          accessibilityPrefix: "CLI provider"
        ) {
          provider = option.id
        }
      }
    }
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
