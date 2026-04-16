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

  @State private var draft: String = ""
  @State private var selectedLaneId: String = ""
  @State private var provider: String = "claude"
  @State private var modelId: String = "claude-sonnet-4-6"
  @State private var busy: Bool = false
  @State private var errorMessage: String?
  @State private var modelPickerPresented = false
  @FocusState private var composerFocused: Bool

  private var selectedLaneName: String {
    if let match = lanes.first(where: { $0.id == selectedLaneId }) {
      return match.name
    }
    return "Choose lane"
  }

  private var trimmedDraft: String {
    draft.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private var canSend: Bool {
    !busy && !trimmedDraft.isEmpty && !selectedLaneId.isEmpty && !modelId.isEmpty
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
    }
    .sheet(isPresented: $modelPickerPresented) {
      WorkModelPickerSheet(
        currentModelId: modelId,
        currentProvider: provider,
        isBusy: false,
        onSelect: { option in
          modelId = option.id
          provider = option.provider
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
        Text("No lanes available").disabled(true)
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
      .background(ADEColor.surfaceBackground.opacity(0.65), in: Capsule(style: .continuous))
      .overlay(
        Capsule(style: .continuous)
          .stroke(ADEColor.accent.opacity(0.28), lineWidth: 0.6)
      )
    }
    .buttonStyle(.plain)
  }

  @ViewBuilder
  private var composerBar: some View {
    VStack(alignment: .leading, spacing: 12) {
      TextField("Type to vibecode…", text: $draft, axis: .vertical)
        .textFieldStyle(.plain)
        .lineLimit(1...6)
        .font(.body)
        .foregroundStyle(ADEColor.textPrimary)
        .tint(ADEColor.accent)
        .focused($composerFocused)
        .frame(maxWidth: .infinity, minHeight: 28, alignment: .leading)

      HStack(alignment: .center, spacing: 8) {
        Button {
          modelPickerPresented = true
        } label: {
          HStack(spacing: 6) {
            WorkProviderLogo(
              provider: provider,
              fallbackSymbol: providerIcon(provider),
              tint: providerTint(provider),
              size: 16
            )
            Text(prettyNewChatModelName(modelId))
              .font(.caption.weight(.semibold))
              .foregroundStyle(ADEColor.textPrimary)
              .lineLimit(1)
            Image(systemName: "chevron.down")
              .font(.system(size: 9, weight: .bold))
              .foregroundStyle(ADEColor.textMuted)
          }
          .padding(.horizontal, 9)
          .padding(.vertical, 6)
          .background(ADEColor.surfaceBackground.opacity(0.7), in: Capsule(style: .continuous))
          .overlay(
            Capsule(style: .continuous)
              .stroke(ADEColor.border.opacity(0.28), lineWidth: 0.6)
          )
        }
        .buttonStyle(.plain)

        Spacer(minLength: 0)

        Button {
          Task { await submit() }
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
        .fill(Color.black.opacity(0.55))
        .background(
          RoundedRectangle(cornerRadius: 24, style: .continuous)
            .fill(.ultraThinMaterial)
        )
    )
    .overlay(
      RoundedRectangle(cornerRadius: 24, style: .continuous)
        .stroke(ADEColor.border.opacity(0.45), lineWidth: 1)
    )
    .shadow(color: Color.black.opacity(0.4), radius: 20, y: 8)
    .padding(.horizontal, 16)
    .padding(.bottom, 0)
  }

  private func prettyNewChatModelName(_ model: String) -> String {
    let trimmed = model.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return "Model" }
    let lower = trimmed.lowercased()
    switch lower {
    case "opus": return "Claude Opus 4.6"
    case "opus[1m]", "opus-1m": return "Claude Opus 4.6 1M"
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
  private func submit() async {
    guard canSend else { return }
    busy = true
    errorMessage = nil
    do {
      let summary = try await syncService.createChatSession(
        laneId: selectedLaneId,
        provider: provider,
        model: modelId,
        reasoningEffort: nil
      )
      let opener = trimmedDraft
      draft = ""
      await onStarted(summary, opener)
      busy = false
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
      busy = false
    }
  }
}

struct WorkNewChatRoute: Hashable {
  let preferredLaneId: String?
}
