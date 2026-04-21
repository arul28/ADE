import SwiftUI

/// Lists every session we know about from the shared workspace snapshot and
/// lets the user mute a session or restrict it to awaiting-input alerts only.
///
/// Snapshot reads are cheap (JSON from the App Group `UserDefaults`), so we
/// refresh on appear rather than subscribing to a publisher.
struct PerSessionOverrideView: View {
  @Binding var overrides: [String: SessionNotificationOverride]

  @State private var agents: [AgentSnapshot] = []

  var body: some View {
    Form {
      if agents.isEmpty {
        Section {
          emptyState
        }
      } else {
        Section {
          ForEach(agents) { agent in
            sessionRow(for: agent)
          }
        } footer: {
          Text("Overrides only affect push notifications — the session itself keeps running.")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }
      }
    }
    .navigationTitle("Per-session overrides")
    .navigationBarTitleDisplayMode(.inline)
    .onAppear(perform: reload)
    .refreshable { reload() }
  }

  // MARK: - Rows

  @ViewBuilder
  private func sessionRow(for agent: AgentSnapshot) -> some View {
    let override = overrides[agent.sessionId] ?? SessionNotificationOverride()

    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 10) {
        Circle()
          .fill(ADESharedTheme.brandColor(for: agent.provider))
          .frame(width: 10, height: 10)
          .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 2) {
          Text(agent.title ?? "Untitled session")
            .font(.subheadline.weight(.medium))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
          Text(statusLine(for: agent))
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }
        Spacer()
      }

      Toggle(isOn: mutedBinding(agent.sessionId, fallback: override)) {
        Label("Mute this session", systemImage: "bell.slash")
          .labelStyle(.titleAndIcon)
          .font(.caption)
      }
      .tint(ADEColor.purpleAccent)
      .accessibilityHint("Silence all push alerts from \(agent.title ?? "this session")")

      Toggle(isOn: awaitingOnlyBinding(agent.sessionId, fallback: override)) {
        Label("Awaiting-input only", systemImage: "hand.raised")
          .labelStyle(.titleAndIcon)
          .font(.caption)
      }
      .tint(ADEColor.purpleAccent)
      .disabled(override.muted)
      .accessibilityHint("Only alert when \(agent.title ?? "this session") pauses for your input")
    }
    .padding(.vertical, 4)
  }

  private var emptyState: some View {
    VStack(alignment: .center, spacing: 10) {
      Image(systemName: "tray")
        .font(.largeTitle)
        .foregroundStyle(ADEColor.textMuted)
        .accessibilityHidden(true)
      Text("No active sessions")
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
      Text("Sessions appear here once your Mac starts syncing them.")
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)
        .multilineTextAlignment(.center)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 24)
    .accessibilityElement(children: .combine)
  }

  // MARK: - Helpers

  private func reload() {
    agents = ADESharedContainer.readWorkspaceSnapshot()?.agents ?? []
  }

  private func mutedBinding(_ sessionId: String, fallback: SessionNotificationOverride) -> Binding<Bool> {
    Binding(
      get: { (overrides[sessionId] ?? fallback).muted },
      set: { newValue in
        var current = overrides[sessionId] ?? fallback
        current.muted = newValue
        if newValue { current.awaitingInputOnly = false }
        overrides[sessionId] = current
      }
    )
  }

  private func awaitingOnlyBinding(_ sessionId: String, fallback: SessionNotificationOverride) -> Binding<Bool> {
    Binding(
      get: { (overrides[sessionId] ?? fallback).awaitingInputOnly },
      set: { newValue in
        var current = overrides[sessionId] ?? fallback
        current.awaitingInputOnly = newValue
        overrides[sessionId] = current
      }
    )
  }

  private func statusLine(for agent: AgentSnapshot) -> String {
    if agent.awaitingInput {
      return "Awaiting your reply"
    }
    switch agent.status {
    case "running":   return "Running"
    case "failed":    return "Failed"
    case "completed": return "Completed"
    default:          return agent.status.capitalized
    }
  }
}
