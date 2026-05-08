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
      if !modelSupportsReasoning(modelId: modelId, provider: newProvider) {
        reasoningEffort = ""
      }
    }
    .onChange(of: sessionMode) { _, newMode in
      if newMode == .chat {
        normalizeChatSelection()
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

  @ViewBuilder
  private var laneSelector: some View {
    Menu {
      ForEach(lanes) { lane in
        Button {
          selectedLaneId = lane.id
        } label: {
          if lane.id == selectedLaneId {
            Label(lane.name, systemImage: "checkmark")
          } else {
            Text(lane.name)
          }
        }
      }
      if lanes.isEmpty {
        Text("No lanes available")
          .font(.footnote)
          .foregroundStyle(ADEColor.textMuted)
      }
      Divider()
      Button {
        Task { await onRefreshLanes() }
      } label: {
        Label("Refresh lanes", systemImage: "arrow.clockwise")
      }
    } label: {
      HStack(spacing: 8) {
        Image(systemName: "arrow.triangle.branch")
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.accent)
        Text(selectedLaneName)
          .font(.footnote.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Image(systemName: "chevron.down")
          .font(.caption2.weight(.bold))
          .foregroundStyle(ADEColor.textMuted)
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 9)
      .background(ADEColor.surfaceBackground.opacity(0.7), in: Capsule(style: .continuous))
      .glassEffect()
      .overlay(
        Capsule(style: .continuous)
          .stroke(ADEColor.accent.opacity(0.32), lineWidth: 0.6)
      )
    }
    .buttonStyle(.plain)
  }

  @ViewBuilder
  private var modeSelector: some View {
    Picker("Session type", selection: $sessionMode) {
      ForEach(WorkNewSessionMode.allCases) { mode in
        Text(mode.title).tag(mode)
      }
    }
    .pickerStyle(.segmented)
    .padding(.horizontal, 8)
    .accessibilityLabel("Session type")
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
        let result = try await syncService.startCliSession(
          laneId: selectedLaneId,
          provider: provider,
          permissionMode: wire.permissionMode ?? (runtimeMode.isEmpty ? nil : runtimeMode),
          title: workCliProviderOptions.first(where: { $0.id == provider })?.title,
          initialInput: opener.isEmpty ? nil : opener,
          cols: 88,
          rows: 28
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
            goal: nil,
            toolType: workCliToolType(provider: provider),
            title: workCliProviderOptions.first(where: { $0.id == provider })?.title ?? providerLabel(provider),
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
        opencodePermissionMode: wire.opencodePermissionMode
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
  switch workNormalizedNewChatProvider(provider) {
  case "codex": return workDefaultCatalogModelId(provider: "codex") ?? "gpt-5.5"
  case "cursor": return "auto"
  case "opencode": return "opencode/anthropic/claude-sonnet-4-6"
  default: return "claude-sonnet-4-6"
  }
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
            } else {
              cliProviderMenu
            }

            if !runtimeOptions.isEmpty {
              Menu {
                ForEach(runtimeOptions) { option in
                  Button {
                    runtimeMode = option.id
                  } label: {
                    if option.id == runtimeMode {
                      Label(option.title, systemImage: "checkmark")
                    } else {
                      Text(option.title)
                    }
                  }
                }
              } label: {
                HStack(spacing: 6) {
                  Circle().fill(runtimeTint).frame(width: 6, height: 6)
                  Text(runtimeLabel)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(ADEColor.textPrimary)
                    .lineLimit(1)
                  Image(systemName: "chevron.down")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(ADEColor.textMuted)
                }
                .padding(.horizontal, 9)
                .padding(.vertical, 6)
                .background(runtimeTint.opacity(0.06), in: Capsule(style: .continuous))
                .overlay(
                  Capsule(style: .continuous)
                    .stroke(runtimeTint.opacity(0.22), lineWidth: 0.5)
                )
              }
              .menuStyle(.borderlessButton)
              .buttonStyle(.plain)
              .accessibilityLabel("Access mode: \(runtimeLabel). Tap to change.")
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

  private var cliProviderMenu: some View {
    Menu {
      ForEach(workCliProviderOptions) { option in
        Button {
          provider = option.id
        } label: {
          if option.id == provider {
            Label(option.title, systemImage: "checkmark")
          } else {
            Text(option.title)
          }
        }
      }
    } label: {
      HStack(spacing: 6) {
        WorkProviderLogo(
          provider: provider,
          fallbackSymbol: provider == "shell" ? "terminal.fill" : providerIcon(provider),
          tint: providerTint(provider),
          size: 16
        )
        Text(workCliProviderOptions.first(where: { $0.id == provider })?.title ?? providerLabel(provider))
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
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
    .menuStyle(.borderlessButton)
    .buttonStyle(.plain)
    .accessibilityLabel("CLI provider: \(workCliProviderOptions.first(where: { $0.id == provider })?.title ?? provider). Tap to change.")
  }
}

struct WorkNewChatRoute: Hashable {
  let preferredLaneId: String?
}
