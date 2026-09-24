/// Which window-server entries a window listing keeps, decided before any
/// Accessibility read.
///
/// `CGWindowListCopyWindowInfo` is one cheap call that returns every window
/// on the Mac. The expensive part of a listing is the Accessibility read that
/// tells a minimized window from an off-screen surface: one read per app, and
/// up to a second for an app that does not answer. The watcher looked up
/// windows by id through an unscoped listing, so every sweep read the windows
/// of Zed, Music, System Settings and every other app with an off-screen
/// entry, each "did not answer accessibility within 1.0s". The scope drops an
/// entry from the listing before that read, so only the lanes' own apps are
/// asked.

import Foundation

public struct WindowListScope: Equatable, Sendable {
    /// Keep only the windows this lane holds or that sit on its display.
    public var laneId: String?
    /// Keep only the windows of this process.
    public var pid: Int32?
    /// Keep only these windows.
    public var windowIds: Set<UInt32>?

    public init(laneId: String? = nil, pid: Int32? = nil, windowIds: Set<UInt32>? = nil) {
        self.laneId = laneId
        self.pid = pid
        self.windowIds = windowIds
    }

    /// True for the claim picker's listing of every window on the Mac. No
    /// periodic path may use it.
    public var isUnscoped: Bool {
        laneId == nil && pid == nil && windowIds == nil
    }

    /// Whether the listing keeps an entry. Every argument is a window-server
    /// fact or a registry lookup; none of them costs an Accessibility read.
    ///
    /// `ownedBy` is the lane that holds the window. `displayId` is the display
    /// that holds the window's center, and `laneDisplayId` is the scope
    /// lane's display. Both are nil when unknown.
    public func admits(
        windowId: UInt32,
        ownerPid: Int32,
        ownedBy: String?,
        displayId: UInt32?,
        laneDisplayId: UInt32?
    ) -> Bool {
        if let pid, ownerPid != pid { return false }
        if let windowIds, !windowIds.contains(windowId) { return false }
        if let laneId, ownedBy != laneId {
            // A window the user dragged onto the lane's display by hand is an
            // app on that desktop too, so the display decides, not ownership.
            guard let laneDisplayId, let displayId, displayId == laneDisplayId else { return false }
        }
        return true
    }
}
