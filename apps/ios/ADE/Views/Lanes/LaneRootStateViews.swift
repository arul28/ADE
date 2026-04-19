import SwiftUI

extension LanesTabView {
  var emptyStatePresentation: LaneEmptyStatePresentation? {
    laneRootEmptyState(
      connectionState: syncService.connectionState,
      laneStatus: laneStatus,
      hasHostProfile: syncService.activeHostProfile != nil
    )
  }

  var showsLaneLoadingSkeletons: Bool {
    laneSnapshots.isEmpty && (
      syncService.connectionState == .connecting
        || syncService.connectionState == .syncing
        || laneStatus.phase == .hydrating
        || laneStatus.phase == .syncingInitialData
    )
  }

  @MainActor
  func refreshPrimaryBranches(force: Bool = false) async {
    guard let primaryLane else {
      primaryBranches = []
      primaryBranchLaneId = nil
      primaryBranchError = nil
      return
    }
    if !force, primaryBranchLaneId == primaryLane.id, !primaryBranches.isEmpty {
      return
    }
    guard canRunLiveActions else {
      primaryBranches = []
      primaryBranchLaneId = primaryLane.id
      primaryBranchError = nil
      return
    }
    do {
      primaryBranches = try await syncService.listBranches(laneId: primaryLane.id)
      primaryBranchLaneId = primaryLane.id
      primaryBranchError = nil
    } catch {
      primaryBranches = []
      primaryBranchLaneId = primaryLane.id
      ADEHaptics.error()
      primaryBranchError = error.localizedDescription
    }
  }

  @ViewBuilder
  func emptyStateCard(_ presentation: LaneEmptyStatePresentation) -> some View {
    ADEEmptyStateView(symbol: presentation.symbol, title: presentation.title, message: presentation.message) {
      if let actionTitle = presentation.actionTitle, let action = presentation.action {
        Button(actionTitle) {
          handleNoticeAction(action)
        }
        .buttonStyle(.glassProminent)
        .tint(ADEColor.accent)
      }
    }
  }

  func handleNoticeAction(_ action: LaneConnectionNoticeAction) {
    switch action {
    case .openSettings:
      syncService.settingsPresented = true
    case .reconnect:
      Task {
        await syncService.reconnectIfPossible(userInitiated: true)
        await reload(refreshRemote: true)
      }
    case .retry:
      Task { await reload(refreshRemote: true) }
    }
  }
}
