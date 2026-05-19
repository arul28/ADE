import SwiftUI

func notificationHasActiveOverride(_ override: SessionNotificationOverride) -> Bool {
  override.muted || override.awaitingInputOnly
}

func notificationStaleOverrideIds(
  overrides: [String: SessionNotificationOverride],
  agents: [AgentSnapshot]
) -> [String] {
  let agentIds = Set(agents.map(\.sessionId))
  return overrides
    .filter { sessionId, override in
      !agentIds.contains(sessionId) && notificationHasActiveOverride(override)
    }
    .map(\.key)
    .sorted()
}

/// Lists every session we know about from the shared workspace snapshot and
/// lets the user mute a session or restrict it to awaiting-input alerts only.
///
/// Snapshot reads are cheap (JSON from the App Group `UserDefaults`), so this
/// refreshes when shown rather than subscribing to a publisher.
struct PerSessionOverrideView: View {
  @Binding var overrides: [String: SessionNotificationOverride]

  @State private var agents: [AgentSnapshot] = []

  var body: some View {
    let staleOverrideIds = notificationStaleOverrideIds(overrides: overrides, agents: agents)

    Form {
      if agents.isEmpty && staleOverrideIds.isEmpty {
        Section {
          emptyState
        }
      } else {
        Section {
          ForEach(agents) { agent in
            sessionRow(for: agent)
          }
          ForEach(staleOverrideIds, id: \.self) { sessionId in
            staleOverrideRow(for: sessionId)
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
    .task { reloadIfChanged() }
    .refreshable { reloadIfChanged() }
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

  @ViewBuilder
  private func staleOverrideRow(for sessionId: String) -> some View {
    let override = overrides[sessionId] ?? SessionNotificationOverride()

    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 10) {
        Circle()
          .fill(ADEColor.textMuted)
          .frame(width: 10, height: 10)
          .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 2) {
          Text(shortSessionId(sessionId))
            .font(.subheadline.weight(.medium))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
          Text("Saved override")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }
        Spacer()
      }

      Toggle(isOn: mutedBinding(sessionId, fallback: override)) {
        Label("Mute this session", systemImage: "bell.slash")
          .labelStyle(.titleAndIcon)
          .font(.caption)
      }
      .tint(ADEColor.purpleAccent)
      .accessibilityHint("Silence all push alerts from this saved session")

      Toggle(isOn: awaitingOnlyBinding(sessionId, fallback: override)) {
        Label("Awaiting-input only", systemImage: "hand.raised")
          .labelStyle(.titleAndIcon)
          .font(.caption)
      }
      .tint(ADEColor.purpleAccent)
      .disabled(override.muted)
      .accessibilityHint("Only alert when this saved session pauses for your input")
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
      Text("Sessions appear here once your paired machine starts syncing them.")
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)
        .multilineTextAlignment(.center)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 24)
    .accessibilityElement(children: .combine)
  }

  // MARK: - Helpers

  private func reloadIfChanged() {
    let nextAgents = ADESharedContainer.readWorkspaceSnapshot()?.agents ?? []
    guard nextAgents != agents else { return }
    agents = nextAgents
  }

  private func mutedBinding(_ sessionId: String, fallback: SessionNotificationOverride) -> Binding<Bool> {
    Binding(
      get: { (overrides[sessionId] ?? fallback).muted },
      set: { newValue in
        var current = overrides[sessionId] ?? fallback
        current.muted = newValue
        if newValue { current.awaitingInputOnly = false }
        writeOverride(current, for: sessionId)
      }
    )
  }

  private func awaitingOnlyBinding(_ sessionId: String, fallback: SessionNotificationOverride) -> Binding<Bool> {
    Binding(
      get: { (overrides[sessionId] ?? fallback).awaitingInputOnly },
      set: { newValue in
        var current = overrides[sessionId] ?? fallback
        current.awaitingInputOnly = newValue
        writeOverride(current, for: sessionId)
      }
    )
  }

  private func writeOverride(_ override: SessionNotificationOverride, for sessionId: String) {
    if notificationHasActiveOverride(override) {
      overrides[sessionId] = override
    } else {
      overrides.removeValue(forKey: sessionId)
    }
  }

  private func shortSessionId(_ sessionId: String) -> String {
    guard sessionId.count > 12 else { return sessionId }
    return "\(sessionId.prefix(8))…\(sessionId.suffix(4))"
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
