import SwiftUI

/// CTO Chat tab — compact agent launcher row. Actual CTO/worker chats are
/// pushed as detail destinations so they get the same clean chrome as Work
/// chat sessions.
struct CtoChatScreen: View {
  @EnvironmentObject private var syncService: SyncService
  @Binding var path: NavigationPath

  @State private var selectedKind: CtoSessionDestinationView.Kind = .cto
  @State private var agents: [AgentIdentity] = []
  @State private var fallbackWorkers: [CtoWorkerEntry] = []
  @State private var loadState: LoadState = .idle
  @State private var errorMessage: String?

  private enum LoadState: Equatable {
    case idle
    case loading
    case ready
    case failed
  }

  var body: some View {
    VStack(spacing: 0) {
      if let errorMessage, shouldShowAgentsLoadError {
        ADENoticeCard(
          title: "Unable to load CTO agents",
          message: errorMessage,
          icon: "exclamationmark.triangle.fill",
          tint: ADEColor.danger,
          actionTitle: "Retry",
          action: { Task { await loadAgentsIfNeeded(force: true) } }
        )
        .padding(.horizontal, 12)
        .padding(.top, 8)
      }

      pillsRow
      Divider()
        .opacity(0.08)
        .padding(.top, 2)

      agentListBody
    }
    .task { await loadAgentsIfNeeded() }
    .task(id: ctoAgentsLiveReloadKey) {
      guard ctoAgentsLiveReloadKey != nil else { return }
      await loadAgentsIfNeeded(force: loadState == .failed)
    }
  }

  // MARK: - Agent list

  @ViewBuilder
  private var agentListBody: some View {
    ScrollView {
      VStack(spacing: 8) {
        // CTO row
        chatListRow(
          name: "CTO",
          subtitle: "Persistent technical lead",
          statusDot: ADEColor.ctoAccent,
          seed: nil,
          isActive: isCtoSelected
        ) { openChat(.cto) }

        Divider().opacity(0.07).padding(.horizontal, 16)

        if loadState == .loading && displayAgents.isEmpty {
          ForEach(0..<3, id: \.self) { _ in
            ADECardSkeleton(rows: 1).padding(.horizontal, 16)
          }
        } else if displayAgents.isEmpty && loadState == .ready {
          Text("No workers hired yet.")
            .font(.subheadline)
            .foregroundStyle(ADEColor.textSecondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20)
            .padding(.top, 12)
        } else {
          ForEach(Array(displayAgents.enumerated()), id: \.element.id) { idx, entry in
            chatListRow(
              name: entry.name,
              subtitle: entry.statusText,
              statusDot: ctoStatusTint(entry.statusRaw),
              seed: entry.seed,
              isActive: isSelected(agentId: entry.agentId)
            ) {
              openChat(.worker(agentId: entry.agentId, displayName: entry.name))
            }
            if idx < displayAgents.count - 1 {
              Divider().opacity(0.07).padding(.horizontal, 16)
            }
          }
        }

        Color.clear.frame(height: 24)
      }
      .padding(.top, 8)
    }
  }

  private func chatListRow(
    name: String,
    subtitle: String,
    statusDot: Color,
    seed: String?,
    isActive: Bool,
    onTap: @escaping () -> Void
  ) -> some View {
    Button(action: onTap) {
      HStack(spacing: 12) {
        ZStack {
          let tint = ctoAvatarTint(name: name, seed: seed)
          RoundedRectangle(cornerRadius: 11, style: .continuous)
            .fill(isActive ? tint.opacity(0.25) : ADEColor.recessedBackground.opacity(0.55))
          RoundedRectangle(cornerRadius: 11, style: .continuous)
            .stroke(isActive ? tint.opacity(0.4) : ADEColor.glassBorder, lineWidth: 0.5)
          Text(ctoAvatarInitial(for: name))
            .font(.system(size: 14, weight: .heavy))
            .foregroundStyle(isActive ? ctoAvatarTint(name: name, seed: seed) : ADEColor.textSecondary)
        }
        .frame(width: 38, height: 38)

        VStack(alignment: .leading, spacing: 2) {
          Text(name)
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
          HStack(spacing: 4) {
            Circle()
              .fill(statusDot)
              .frame(width: 5, height: 5)
              .shadow(color: statusDot.opacity(0.6), radius: 2)
            Text(subtitle)
              .font(.system(size: 10.5, design: .monospaced))
              .foregroundStyle(ADEColor.textMuted)
              .lineLimit(1)
          }
        }

        Spacer(minLength: 8)

        Image(systemName: "chevron.right")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(ADEColor.textMuted)
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 10)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .background(isActive ? ADEColor.ctoAccent.opacity(0.05) : Color.clear)
    .accessibilityLabel("\(name), \(subtitle)")
    .accessibilityHint("Opens chat with \(name).")
    .accessibilityAddTraits(isActive ? [.isSelected] : [])
  }

  // MARK: - Pills

  private var pillsRow: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        AgentPill(
          name: "CTO",
          statusText: "persistent",
          statusDot: ADEColor.ctoAccent,
          isActive: isCtoSelected,
          seed: nil
        ) {
          openChat(.cto)
        }

        if loadState == .loading && agents.isEmpty && fallbackWorkers.isEmpty {
          ForEach(0..<3, id: \.self) { _ in
            pillSkeleton
          }
        } else {
          ForEach(Array(displayAgents.enumerated()), id: \.element.id) { _, entry in
            AgentPill(
              name: entry.name,
              statusText: entry.statusText,
              statusDot: ctoStatusTint(entry.statusRaw),
              isActive: isSelected(agentId: entry.agentId),
              seed: entry.seed
            ) {
              openChat(.worker(agentId: entry.agentId, displayName: entry.name))
            }
          }
        }
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 6)
    }
    .background(Color.clear)
  }

  private var pillSkeleton: some View {
    RoundedRectangle(cornerRadius: 999, style: .continuous)
      .fill(ADEColor.recessedBackground.opacity(0.5))
      .frame(width: 112, height: 28)
      .redacted(reason: .placeholder)
  }

  private var isCtoSelected: Bool {
    if case .cto = selectedKind { return true }
    return false
  }

  private var hasDisplayAgents: Bool {
    !displayAgents.isEmpty
  }

  private var shouldShowAgentsLoadError: Bool {
    errorMessage != nil && !hasDisplayAgents
  }

  private var ctoAgentsLiveReloadKey: String? {
    switch syncService.connectionState {
    case .connected, .syncing:
      return "live-\(syncService.localStateRevision)"
    case .connecting, .disconnected, .error:
      return nil
    }
  }

  private func isSelected(agentId: String) -> Bool {
    if case .worker(let id, _) = selectedKind { return id == agentId }
    return false
  }

  private func openChat(_ kind: CtoSessionDestinationView.Kind) {
    selectedKind = kind
    path.append(route(for: kind))
  }

  private func route(for kind: CtoSessionDestinationView.Kind) -> CtoSessionRoute {
    switch kind {
    case .cto:
      return .cto
    case .worker(let agentId, let displayName):
      return .worker(agentId: agentId, displayName: displayName)
    }
  }

  // MARK: - Data

  /// Unified view-model that folds AgentIdentity (preferred) or CtoWorkerEntry
  /// (fallback) into one shape so the pill row doesn't care which source hit.
  private struct DisplayAgent: Identifiable {
    let id: String
    let agentId: String
    let name: String
    let statusRaw: String
    let statusText: String
    let seed: String?
  }

  private var displayAgents: [DisplayAgent] {
    if !agents.isEmpty {
      return agents.map { agent in
        DisplayAgent(
          id: agent.id,
          agentId: agent.id,
          name: agent.name,
          statusRaw: agent.status,
          statusText: agent.status,
          seed: agent.id
        )
      }
    }
    return fallbackWorkers.map { worker in
      DisplayAgent(
        id: worker.agentId,
        agentId: worker.agentId,
        name: worker.name,
        statusRaw: worker.status,
        statusText: worker.status,
        seed: worker.avatarSeed
      )
    }
  }

  @MainActor
  private func loadAgentsIfNeeded(force: Bool = false) async {
    if loadState == .loading || (!force && loadState == .ready) { return }
    loadState = .loading
    errorMessage = nil
    do {
      let fetched = try await syncService.fetchCtoAgents()
      agents = fetched
      if fetched.isEmpty {
        // Fall back to the legacy roster if the new listAgents endpoint is empty.
        if let roster = try? await syncService.fetchCtoRoster() {
          fallbackWorkers = roster.workers
        }
      }
      loadState = .ready
    } catch {
      errorMessage = error.localizedDescription
      loadState = .failed
      // Best-effort fallback so the pill row isn't completely empty.
      if let roster = try? await syncService.fetchCtoRoster() {
        fallbackWorkers = roster.workers
      }
    }
  }
}

// MARK: - AgentPill

private struct AgentPill: View {
  let name: String
  let statusText: String
  let statusDot: Color
  let isActive: Bool
  let seed: String?
  let onTap: () -> Void

  var body: some View {
    Button(action: onTap) {
      HStack(spacing: 6) {
        initialBadge
        Text(name)
          .font(.system(size: 11.5, weight: .semibold))
          .foregroundStyle(isActive ? ADEColor.textPrimary : ADEColor.textSecondary)
          .lineLimit(1)
        Circle()
          .fill(statusDot)
          .frame(width: 6, height: 6)
          .shadow(color: statusDot.opacity(0.7), radius: 2)
        Text("· \(statusText)")
          .font(.system(size: 9.5, design: .monospaced))
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(1)
      }
      .padding(.leading, 5)
      .padding(.trailing, 9)
      .padding(.vertical, 5)
      .background(
        Capsule(style: .continuous)
          .fill(isActive ? ADEColor.ctoAccent.opacity(0.14) : ADEColor.recessedBackground.opacity(0.55))
      )
      .overlay(
        Capsule(style: .continuous)
          .stroke(
            isActive ? ADEColor.ctoAccent.opacity(0.35) : ADEColor.glassBorder,
            lineWidth: 0.5
          )
      )
      .contentShape(Capsule())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(name), \(statusText)")
    .accessibilityHint("Opens this chat.")
    .accessibilityAddTraits(isActive ? [.isSelected] : [])
  }

  private var initialBadge: some View {
    let tint = ctoAvatarTint(name: name, seed: seed)
    return Text(ctoAvatarInitial(for: name))
      .font(.system(size: 10, weight: .heavy))
      .foregroundStyle(isActive ? Color.black : ADEColor.textPrimary)
      .frame(width: 20, height: 20)
      .background(
        Circle().fill(isActive ? tint : ADEColor.recessedBackground.opacity(0.8))
      )
  }
}
