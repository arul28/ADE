import SwiftUI
import UIKit

/// Top-level CTO tab screen. Hosts a persistent NavigationStack and segmented
/// picker (Team / Workflows / Settings). The stack drives drill-down into
/// per-worker chat (CtoSessionDestinationView) and per-worker detail
/// (CtoWorkerDetailScreen).
struct CtoRootScreen: View {
  @EnvironmentObject private var syncService: SyncService
  var isTabActive = true

  @State private var selectedTab: CtoTab = .team
  @State private var path = NavigationPath()
  @State private var snapshot: CtoSnapshot?
  @State private var isLoadingSnapshot = false
  @State private var snapshotLoadError: String?

  var body: some View {
    NavigationStack(path: $path) {
      VStack(spacing: 0) {
        CtoTabShell(active: $selectedTab)

        if let snapshotLoadError, !syncService.connectionState.isHostUnreachable {
          ADENoticeCard(
            title: "Couldn't load CTO state",
            message: snapshotLoadError,
            icon: "exclamationmark.triangle.fill",
            tint: ADEColor.warning,
            actionTitle: "Retry",
            action: { Task { await loadSnapshot() } }
          )
          .padding(.horizontal, 20)
          .padding(.top, 8)
        }

        tabBody
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      }
      .tint(ADEColor.ctoAccent)
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("CTO")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ADERootToolbarLeadingItems()
      }
      .task(id: isTabActive) {
        guard isTabActive, snapshot == nil else { return }
        await loadSnapshot()
      }
      .task(id: ctoLiveReloadKey) {
        guard ctoLiveReloadKey != nil else { return }
        await loadSnapshot()
      }
      .navigationDestination(for: CtoSessionRoute.self) { route in
        switch route {
        case .cto:
          CtoSessionDestinationView(kind: .cto)
            .environmentObject(syncService)
        case .worker(let agentId, let displayName):
          CtoSessionDestinationView(kind: .worker(agentId: agentId, displayName: displayName))
            .environmentObject(syncService)
        case .workerDetail(let agentId, let displayName):
          CtoWorkerDetailScreen(agentId: agentId, displayName: displayName)
            .environmentObject(syncService)
        }
      }
    }
  }

  @ViewBuilder
  private var tabBody: some View {
    switch selectedTab {
    case .team:
      CtoTeamScreen(path: $path)
        .environmentObject(syncService)
    case .workflows:
      CtoWorkflowsScreen()
        .environmentObject(syncService)
    case .settings:
      CtoSettingsScreen()
        .environmentObject(syncService)
    }
  }

  @MainActor
  private func loadSnapshot() async {
    if isLoadingSnapshot { return }
    isLoadingSnapshot = true
    defer { isLoadingSnapshot = false }
    do {
      snapshot = try await syncService.fetchCtoState()
      snapshotLoadError = nil
    } catch {
      // Connection failures are owned by the top-right gear dot. For anything
      // else (command error, parse error, timeouts while connected) surface the
      // message so the user has a retry/diagnostic path instead of stale state.
      if syncService.connectionState.isHostUnreachable {
        snapshotLoadError = nil
      } else {
        snapshotLoadError = (error as NSError).localizedDescription
      }
    }
  }

  private var ctoLiveReloadKey: String? {
    guard isTabActive else { return nil }
    switch syncService.connectionState {
    case .connected, .syncing:
      return "live-\(syncService.localStateRevision)"
    case .connecting, .disconnected, .error:
      return nil
    }
  }
}

/// Routes surfaced by the CTO NavigationStack. `.cto` and `.worker` drill into
/// the shared chat destination; `.workerDetail` drills into the worker
/// dashboard (status, runs, memory, revisions).
enum CtoSessionRoute: Hashable {
  case cto
  case worker(agentId: String, displayName: String)
  case workerDetail(agentId: String, displayName: String)
}
