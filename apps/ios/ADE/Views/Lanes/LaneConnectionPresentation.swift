import SwiftUI

enum LaneConnectionNoticeAction: Equatable {
  case openSettings
  case reconnect
  case retry
}

struct LaneEmptyStatePresentation: Equatable {
  let symbol: String
  let title: String
  let message: String
  let actionTitle: String?
  let action: LaneConnectionNoticeAction?
}

func laneAllowsLiveActions(connectionState: RemoteConnectionState, laneStatus: SyncDomainStatus) -> Bool {
  connectionState == .connected && laneStatus.phase == .ready
}

func laneAllowsDiffInspection(
  connectionState: RemoteConnectionState,
  laneStatus: SyncDomainStatus,
  hasCachedTargets: Bool
) -> Bool {
  hasCachedTargets || laneAllowsLiveActions(connectionState: connectionState, laneStatus: laneStatus)
}

func laneRootEmptyState(
  connectionState: RemoteConnectionState,
  laneStatus: SyncDomainStatus,
  hasHostProfile: Bool
) -> LaneEmptyStatePresentation? {
  if laneStatus.phase == .failed {
    return LaneEmptyStatePresentation(
      symbol: "exclamationmark.triangle.fill",
      title: "Lane hydration unavailable",
      message: laneStatus.lastError ?? "Retry lane sync or reconnect the host.",
      actionTitle: "Retry",
      action: .retry
    )
  }

  if connectionState == .disconnected || connectionState == .error || laneStatus.phase == .disconnected {
    let offlineAction = laneOfflineAction(hasHostProfile: hasHostProfile, needsRepairing: false)
    return LaneEmptyStatePresentation(
      symbol: "square.stack.3d.up",
      title: hasHostProfile ? "Reconnect to load lanes" : "Pair to load lanes",
      message: hasHostProfile
        ? "Reconnect to the host before triaging or creating lanes from iPhone."
        : "Pair with a host from Settings to load the current lane graph.",
      actionTitle: offlineAction?.title,
      action: offlineAction?.action
    )
  }

  return nil
}

func laneDetailEmptyState(
  connectionState: RemoteConnectionState,
  laneStatus: SyncDomainStatus,
  hasHostProfile: Bool
) -> LaneEmptyStatePresentation? {
  if laneStatus.phase == .failed {
    return LaneEmptyStatePresentation(
      symbol: "exclamationmark.triangle.fill",
      title: "Lane detail unavailable",
      message: laneStatus.lastError ?? "Retry loading the lane detail.",
      actionTitle: "Retry",
      action: .retry
    )
  }

  if connectionState == .disconnected || connectionState == .error || laneStatus.phase == .disconnected {
    let offlineAction = laneOfflineAction(hasHostProfile: hasHostProfile, needsRepairing: false)
    return LaneEmptyStatePresentation(
      symbol: "square.stack.3d.up",
      title: hasHostProfile ? "Reconnect for live lane detail" : "Pair to load lane detail",
      message: hasHostProfile
        ? "No cached lane detail is available yet. Reconnect to load git status, conflicts, and stack context."
        : "Pair with a host from Settings to load lane detail on iPhone.",
      actionTitle: offlineAction?.title,
      action: offlineAction?.action
    )
  }

  return nil
}

private func laneOfflineAction(
  hasHostProfile: Bool,
  needsRepairing: Bool
) -> (title: String, action: LaneConnectionNoticeAction)? {
  if needsRepairing {
    return ("Pair again", .openSettings)
  }
  if hasHostProfile {
    return ("Reconnect", .reconnect)
  }
  return ("Pair with host", .openSettings)
}
