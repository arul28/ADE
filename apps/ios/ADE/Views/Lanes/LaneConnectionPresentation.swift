import SwiftUI

enum LaneConnectionNoticeAction: Equatable {
  case openSettings
  case reconnect
  case retry
}

enum LaneConnectionNoticeTintRole: Equatable {
  case accent
  case warning
  case danger
  case secondary

  var color: Color {
    switch self {
    case .accent:
      return ADEColor.accent
    case .warning:
      return ADEColor.warning
    case .danger:
      return ADEColor.danger
    case .secondary:
      return ADEColor.textSecondary
    }
  }
}

struct LaneConnectionNoticePresentation: Equatable {
  let title: String
  let message: String
  let icon: String
  let tintRole: LaneConnectionNoticeTintRole
  let actionTitle: String?
  let action: LaneConnectionNoticeAction?
  let allowsLiveActions: Bool
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

func laneRootConnectionNotice(
  connectionState: RemoteConnectionState,
  laneStatus: SyncDomainStatus,
  hasCachedLanes: Bool,
  hasHostProfile: Bool,
  needsRepairing: Bool
) -> LaneConnectionNoticePresentation? {
  let allowsLiveActions = laneAllowsLiveActions(connectionState: connectionState, laneStatus: laneStatus)
  if allowsLiveActions {
    return nil
  }

  if laneStatus.phase == .failed {
    return LaneConnectionNoticePresentation(
      title: "Lane hydration failed",
      message: laneStatus.lastError ?? "Lane hydration did not complete.",
      icon: "exclamationmark.triangle.fill",
      tintRole: .danger,
      actionTitle: "Retry",
      action: .retry,
      allowsLiveActions: false
    )
  }

  if connectionState == .connecting {
    return LaneConnectionNoticePresentation(
      title: hasCachedLanes ? "Reconnecting to lanes" : "Connecting to host",
      message: hasCachedLanes
        ? "Cached lanes stay visible while ADE reconnects to refresh live state."
        : "Looking for the current lane graph from the host.",
      icon: "bolt.horizontal.circle",
      tintRole: .accent,
      actionTitle: nil,
      action: nil,
      allowsLiveActions: false
    )
  }

  if laneStatus.phase == .hydrating {
    return LaneConnectionNoticePresentation(
      title: hasCachedLanes ? "Refreshing lane graph" : "Hydrating lane graph",
      message: hasCachedLanes
        ? "Cached lanes remain visible while the latest lane graph loads."
        : "Pulling lane snapshots from the host.",
      icon: "arrow.trianglehead.2.clockwise.rotate.90",
      tintRole: .accent,
      actionTitle: nil,
      action: nil,
      allowsLiveActions: false
    )
  }

  if connectionState == .syncing || laneStatus.phase == .syncingInitialData {
    return LaneConnectionNoticePresentation(
      title: hasCachedLanes ? "Syncing live lane state" : "Syncing initial data",
      message: hasCachedLanes
        ? "Cached lanes remain readable while sync catches up. Live actions will unlock when sync finishes."
        : "Waiting for the host to finish syncing before lanes load.",
      icon: "arrow.trianglehead.2.clockwise.rotate.90",
      tintRole: .warning,
      actionTitle: nil,
      action: nil,
      allowsLiveActions: false
    )
  }

  if connectionState == .disconnected || connectionState == .error || laneStatus.phase == .disconnected {
    let offlineAction = laneOfflineAction(hasHostProfile: hasHostProfile, needsRepairing: needsRepairing)
    return LaneConnectionNoticePresentation(
      title: hasCachedLanes ? "Showing cached lanes" : "Host disconnected",
      message: hasCachedLanes
        ? (needsRepairing
            ? "Cached lanes remain visible, but host trust was cleared. Pair again before running live lane actions."
            : "Cached lane state stays visible. Reconnect to refresh or run live lane actions.")
        : (hasHostProfile
            ? "Reconnect to load the current lane graph from the host."
            : "Pair with a host to load the current lane graph."),
      icon: "bolt.horizontal.circle",
      tintRole: .warning,
      actionTitle: offlineAction?.title,
      action: offlineAction?.action,
      allowsLiveActions: false
    )
  }

  return nil
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

func laneDetailConnectionNotice(
  connectionState: RemoteConnectionState,
  laneStatus: SyncDomainStatus,
  hasCachedDetail: Bool,
  hasHostProfile: Bool,
  needsRepairing: Bool
) -> LaneConnectionNoticePresentation? {
  let allowsLiveActions = laneAllowsLiveActions(connectionState: connectionState, laneStatus: laneStatus)
  if allowsLiveActions {
    return nil
  }

  if laneStatus.phase == .failed {
    return LaneConnectionNoticePresentation(
      title: "Lane detail failed",
      message: laneStatus.lastError ?? "Lane detail did not load.",
      icon: "exclamationmark.triangle.fill",
      tintRole: .danger,
      actionTitle: "Retry",
      action: .retry,
      allowsLiveActions: false
    )
  }

  if connectionState == .connecting {
    return LaneConnectionNoticePresentation(
      title: hasCachedDetail ? "Reconnecting to lane detail" : "Connecting to lane detail",
      message: hasCachedDetail
        ? "Cached lane detail stays visible while ADE reconnects to refresh live git state."
        : "Waiting for the host to load this lane detail.",
      icon: "bolt.horizontal.circle",
      tintRole: .accent,
      actionTitle: nil,
      action: nil,
      allowsLiveActions: false
    )
  }

  if laneStatus.phase == .hydrating {
    return LaneConnectionNoticePresentation(
      title: hasCachedDetail ? "Refreshing lane detail" : "Hydrating lane detail",
      message: hasCachedDetail
        ? "Cached lane detail remains visible while the latest lane state loads."
        : "Pulling lane detail, git status, and conflict state from the host.",
      icon: "arrow.trianglehead.2.clockwise.rotate.90",
      tintRole: .accent,
      actionTitle: nil,
      action: nil,
      allowsLiveActions: false
    )
  }

  if connectionState == .syncing || laneStatus.phase == .syncingInitialData {
    return LaneConnectionNoticePresentation(
      title: hasCachedDetail ? "Syncing live lane detail" : "Syncing lane detail",
      message: hasCachedDetail
        ? "Cached lane detail remains visible while sync catches up. Live git actions unlock when sync finishes."
        : "Waiting for the host to finish syncing before this lane detail becomes live.",
      icon: "arrow.trianglehead.2.clockwise.rotate.90",
      tintRole: .warning,
      actionTitle: nil,
      action: nil,
      allowsLiveActions: false
    )
  }

  if connectionState == .disconnected || connectionState == .error || laneStatus.phase == .disconnected {
    let offlineAction = laneOfflineAction(hasHostProfile: hasHostProfile, needsRepairing: needsRepairing)
    return LaneConnectionNoticePresentation(
      title: hasCachedDetail ? "Showing cached lane detail" : "Lane detail offline",
      message: hasCachedDetail
        ? (needsRepairing
            ? "Cached lane context stays visible, but host trust was cleared. Pair again before staging, committing, or resolving conflicts."
            : "Cached lane context stays visible. Reconnect before staging, committing, pushing, or resolving conflicts.")
        : (hasHostProfile
            ? "Reconnect to load git status, conflicts, and stack context for this lane."
            : "Pair with a host to load live lane detail on iPhone."),
      icon: "icloud.slash",
      tintRole: .secondary,
      actionTitle: offlineAction?.title,
      action: offlineAction?.action,
      allowsLiveActions: false
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
  if hasHostProfile {
    return ("Reconnect", .reconnect)
  }
  return (needsRepairing ? "Pair again" : "Pair with host", .openSettings)
}
