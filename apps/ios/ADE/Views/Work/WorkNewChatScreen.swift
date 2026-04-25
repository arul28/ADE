import SwiftUI

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
  let onRefreshLanes: @MainActor () async -> Void

  @State private var selectedLaneId: String = ""
  @State private var provider: String = "claude"
  @State private var modelId: String = "claude-sonnet-4-6"
  @State private var busy: Bool = false
  @State private var errorMessage: String?
  @State private var modelPickerPresented = false
  @State private var runtimeMode: String = "default"
  @State private var reasoningEffort: String = ""
  @State private var mentionsSheetPresented = false
  @State private var slashSheetPresented = false
  @State private var pendingDraftInsert: String?

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
    .sheet(isPresented: $mentionsSheetPresented) {
      WorkMentionsPickerSheet(lanes: lanes) { token in
        pendingDraftInsert = token
        mentionsSheetPresented = false
      }
    }
    .sheet(isPresented: $slashSheetPresented) {
      WorkSlashCommandsSheet(provider: provider) { token in
        pendingDraftInsert = token
        slashSheetPresented = false
      }
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
  private var composerBar: some View {
    WorkNewChatComposerBar(
      provider: provider,
      modelId: modelId,
      modelName: prettyNewChatModelName(modelId),
      busy: busy,
      canStart: !busy && !selectedLaneId.isEmpty && !modelId.isEmpty,
      runtimeMode: $runtimeMode,
      reasoningEffort: $reasoningEffort,
      pendingInsert: $pendingDraftInsert,
      onOpenModelPicker: { modelPickerPresented = true },
      onOpenMentions: { mentionsSheetPresented = true },
      onOpenSlash: { slashSheetPresented = true },
      onSubmit: submit(openingMessage:)
    )
  }

  private func prettyNewChatModelName(_ model: String) -> String {
    let trimmed = model.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return "Model" }
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
    guard !busy && !opener.isEmpty && !selectedLaneId.isEmpty && !modelId.isEmpty else { return false }
    busy = true
    errorMessage = nil
    let wire = workRuntimeWireFields(provider: provider, mode: runtimeMode)
    let normalizedReasoning = reasoningEffort.trimmingCharacters(in: .whitespacesAndNewlines)
    do {
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
}

private struct WorkNewChatComposerBar: View {
  let provider: String
  let modelId: String
  let modelName: String
  let busy: Bool
  let canStart: Bool
  @Binding var runtimeMode: String
  @Binding var reasoningEffort: String
  @Binding var pendingInsert: String?
  let onOpenModelPicker: () -> Void
  let onOpenMentions: () -> Void
  let onOpenSlash: () -> Void
  let onSubmit: @MainActor (String) async -> Bool

  @State private var draft: String = ""
  @FocusState private var composerFocused: Bool

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

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      TextField("Type to vibecode…", text: $draft, axis: .vertical)
        .textFieldStyle(.plain)
        .lineLimit(1...6)
        .font(.body)
        .foregroundStyle(ADEColor.textPrimary)
        .tint(ADEColor.accent)
        .autocorrectionDisabled(false)
        .textInputAutocapitalization(.sentences)
        .focused($composerFocused)
        .frame(maxWidth: .infinity, minHeight: 28, alignment: .leading)
        .onChange(of: pendingInsert) { _, newValue in
          guard let token = newValue, !token.isEmpty else { return }
          if !draft.isEmpty && !draft.hasSuffix(" ") && !draft.hasSuffix("\n") {
            draft += " "
          }
          draft += token
          pendingInsert = nil
          composerFocused = true
        }

      HStack(alignment: .center, spacing: 8) {
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(alignment: .center, spacing: 6) {
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
          .background(ADEColor.surfaceBackground.opacity(0.7), in: Capsule(style: .continuous))
          .glassEffect()
          .overlay(
            Capsule(style: .continuous)
              .stroke(ADEColor.glassBorder, lineWidth: 0.6)
          )
        }
        .buttonStyle(.plain)

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
            .background(runtimeTint.opacity(0.14), in: Capsule(style: .continuous))
            .glassEffect()
            .overlay(
              Capsule(style: .continuous)
                .stroke(runtimeTint.opacity(0.38), lineWidth: 0.6)
            )
          }
          .menuStyle(.borderlessButton)
          .buttonStyle(.plain)
          .accessibilityLabel("Access mode: \(runtimeLabel). Tap to change.")
        }

        Button(action: onOpenMentions) {
          Image(systemName: "at")
            .font(.system(size: 12, weight: .bold))
            .foregroundStyle(ADEColor.textSecondary)
            .frame(width: 28, height: 28)
            .background(ADEColor.surfaceBackground.opacity(0.7), in: Circle())
            .glassEffect()
            .overlay(Circle().stroke(ADEColor.glassBorder, lineWidth: 0.6))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Insert @ mention")

        Button(action: onOpenSlash) {
          Text("/")
            .font(.system(size: 14, weight: .bold))
            .foregroundStyle(ADEColor.textSecondary)
            .frame(width: 28, height: 28)
            .background(ADEColor.surfaceBackground.opacity(0.7), in: Circle())
            .glassEffect()
            .overlay(Circle().stroke(ADEColor.glassBorder, lineWidth: 0.6))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Insert slash command")
        }
        .padding(.trailing, 4)
      }

        Button {
          let text = trimmedDraft
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
            Text("Send")
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
        .accessibilityLabel(canSend ? "Start chat" : "Enter a message to start")
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
}

struct WorkNewChatRoute: Hashable {
  let preferredLaneId: String?
}
