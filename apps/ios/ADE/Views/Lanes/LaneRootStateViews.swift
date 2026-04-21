import SwiftUI

extension LanesTabView {
  var emptyStatePresentation: LaneEmptyStatePresentation? {
    laneRootEmptyState(
      connectionState: syncService.connectionState,
      laneStatus: laneStatus,
      hasHostProfile: syncService.activeHostProfile != nil
    )
  }

  var liveActionNoticePresentation: LaneEmptyStatePresentation? {
    guard !laneSnapshots.isEmpty else { return nil }
    return laneLiveActionNotice(
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
      if !primaryBranches.isEmpty {
        primaryBranches = []
      }
      if primaryBranchLaneId != nil {
        primaryBranchLaneId = nil
      }
      if primaryBranchError != nil {
        primaryBranchError = nil
      }
      return
    }
    if !force, primaryBranchLaneId == primaryLane.id, primaryBranchError == nil {
      return
    }
    guard canRunLiveActions else {
      if !primaryBranches.isEmpty {
        primaryBranches = []
      }
      if primaryBranchLaneId != primaryLane.id {
        primaryBranchLaneId = primaryLane.id
      }
      if primaryBranchError != nil {
        primaryBranchError = nil
      }
      return
    }
    do {
      let branches = try await syncService.listBranches(laneId: primaryLane.id)
      if primaryBranches != branches {
        primaryBranches = branches
      }
      if primaryBranchLaneId != primaryLane.id {
        primaryBranchLaneId = primaryLane.id
      }
      if primaryBranchError != nil {
        primaryBranchError = nil
      }
    } catch {
      if !primaryBranches.isEmpty {
        primaryBranches = []
      }
      if primaryBranchLaneId != primaryLane.id {
        primaryBranchLaneId = primaryLane.id
      }
      ADEHaptics.error()
      let message = error.localizedDescription
      if primaryBranchError != message {
        primaryBranchError = message
      }
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

  func handleBlockedLiveAction() {
    ADEHaptics.warning()
    if let action = liveActionNoticePresentation?.action {
      handleNoticeAction(action)
    }
  }
}
