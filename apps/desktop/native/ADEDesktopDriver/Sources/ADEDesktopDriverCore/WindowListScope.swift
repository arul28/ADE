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

/// Which window-server layers a listing keeps.
///
/// Layer 0 is where ordinary document windows live, and for a long time it was
/// the only layer listed. An app's modal alert (`NSAlert.runModal`, layer 8)
/// and its floating palettes (layer 3) are real windows too, and leaving them
/// out meant `observe`, `claim`, `park` and the watcher could not see a panel
/// that blocked the whole app. From the menu band up (the menu bar, status
/// items, pop-up menus, tooltips, the screen saver) nothing is a window a lane
/// should hold.
public enum WindowLayerPolicy {
    /// `kCGMainMenuWindowLevel`. This layer and everything above stay out.
    public static let menuBand = 24
    /// `kCGModalPanelWindowLevel`: an app-modal alert or panel.
    public static let modalPanel = 8

    /// Whether an entry at `layer` may be listed.
    ///
    /// A panel layer (1 up to the menu band) is kept only for an app a lane
    /// watches (it launched it or holds one of its windows), for a lookup that
    /// named the window by id, or for the system Open/Save panel service in a
    /// lane's own listing. Other apps' floating panels never fill the claim
    /// picker.
    public static func admits(
        layer: Int,
        ownerIsLaneApp: Bool,
        lookupById: Bool,
        isOpenSavePanelInLaneListing: Bool
    ) -> Bool {
        if layer == 0 { return true }
        guard layer > 0, layer < menuBand else { return false }
        return ownerIsLaneApp || lookupById || isOpenSavePanelInLaneListing
    }

    /// How an on-screen entry above layer 0 is admitted, once its app was
    /// asked through Accessibility.
    public enum PanelAdmission: Equatable, Sendable {
        /// One of the app's Accessibility windows: a panel, a palette, an alert.
        case window
        /// A sheet attached to one of the app's windows ("Replace?" on a Save
        /// panel). It is no Accessibility window of its own, only a child of
        /// its parent's, so it was dropped, and with it the only row that
        /// told a lane the app was blocked.
        case sheet(parent: UInt32)
        case none
    }

    /// `axKnown` is false when the app could not be read at all. `isAXWindow`
    /// is whether the entry is one of its windows, `sheetParent` the window a
    /// sheet entry is attached to.
    ///
    /// An unreadable lane app's modal panel (layer 8) is still listed: it
    /// blocks the app, and a lane that cannot see it cannot say why nothing
    /// answers. Other unreadable surfaces (tooltips, popover chrome, reused
    /// hidden panels) stay out.
    public static func panelAdmission(
        layer: Int,
        axKnown: Bool,
        isAXWindow: Bool,
        sheetParent: UInt32?,
        ownerIsLaneApp: Bool
    ) -> PanelAdmission {
        if isAXWindow { return .window }
        if let sheetParent { return .sheet(parent: sheetParent) }
        if !axKnown, layer == modalPanel, ownerIsLaneApp { return .window }
        return .none
    }

    /// Whether an entry could be a sheet, before its app is asked: a sheet
    /// hangs from another of its app's windows, centred across it with its
    /// top edge inside it. A tooltip or popover elsewhere on the screen fails
    /// this and costs no Accessibility read. Frames are the window server's
    /// (origin top left, y down).
    public static func couldBeSheet(frame: CGRect, otherWindowFrames: [CGRect]) -> Bool {
        guard frame.width > 0, frame.height > 0 else { return false }
        return otherWindowFrames.contains { parent in
            parent.width > 0 && parent.height > 0
                && frame.midX >= parent.minX && frame.midX <= parent.maxX
                && frame.minY >= parent.minY - 1 && frame.minY < parent.maxY
        }
    }

    /// The process macOS runs an app's Open and Save panels in, when the app
    /// is sandboxed or asks for the remote panel. On macOS 27 the panel window
    /// on screen belongs to the app, which shows the service's content in it;
    /// the service owns only a hidden window. A window it does own is never a
    /// lane's to take.
    public static func isOpenSavePanelService(bundleId: String?) -> Bool {
        guard let bundleId else { return false }
        return bundleId.hasPrefix("com.apple.appkit.xpc.openAndSavePanelService")
    }
}
