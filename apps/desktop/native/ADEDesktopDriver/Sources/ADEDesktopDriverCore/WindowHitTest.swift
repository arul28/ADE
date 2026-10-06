import CoreGraphics
import Foundation

/// Which process a real event should be handed to, from where it lands.
///
/// A `CGEvent` posted to the HID tap moves the one system cursor to the event's
/// coordinate: on the Mac that hosts the lane's display, that is the user's own
/// mouse being yanked onto a screen they cannot see, on every click. An event
/// posted to a process (`postToPid`) is delivered to that app at the same
/// coordinate and leaves the cursor where the user has it. So a click on one
/// of the lane's windows goes to that window's process; only a click on empty
/// desktop, which has no process, still goes through the HID tap.
public struct WindowHitCandidate: Equatable {
    public var pid: pid_t
    public var frame: CGRect
    public var minimized: Bool
    /// The window-server id, for a background event that must name the exact
    /// window it is for. Zero when the caller only needs the process.
    public var windowId: UInt32

    public init(pid: pid_t, frame: CGRect, minimized: Bool, windowId: UInt32 = 0) {
        self.pid = pid
        self.frame = frame
        self.minimized = minimized
        self.windowId = windowId
    }
}

public enum WindowHitTest {
    /// The frontmost candidate whose frame contains `point`. `candidates` is in
    /// window-server order, front to back, which is what `CGWindowListCopyWindowInfo`
    /// returns. A minimized window has no frame on screen and is skipped.
    public static func pid(at point: CGPoint, in candidates: [WindowHitCandidate]) -> pid_t? {
        window(at: point, in: candidates)?.pid
    }

    /// The frontmost candidate under `point`, whole: a background event names
    /// its window as well as its process.
    public static func window(at point: CGPoint, in candidates: [WindowHitCandidate]) -> WindowHitCandidate? {
        candidates.first { !$0.minimized && $0.frame.contains(point) }
    }

    /// One window-server entry, as `CGWindowListCopyWindowInfo` reports it.
    public struct WindowServerRow: Equatable {
        public var pid: pid_t
        public var windowId: UInt32
        public var layer: Int
        public var frame: CGRect

        public init(pid: pid_t, windowId: UInt32, layer: Int, frame: CGRect) {
            self.pid = pid
            self.windowId = windowId
            self.layer = layer
            self.frame = frame
        }
    }

    /// The windows a background event may be delivered to, front to back.
    ///
    /// This is the whole "background input never reaches the user's screen"
    /// guarantee. An ordinary window must be one of the lane's own
    /// (`laneWindowIds`): one Safari process can have a user's window on the
    /// lane display too. A window above it — a context menu or popover is its
    /// own window over the one that opened it, with an id nobody listed — is
    /// admitted only for an app with a window on the lane, and only when it
    /// lies wholly on the lane's display. Nothing at the screen-saver band or
    /// above.
    public static func backgroundCandidates(
        _ rows: [WindowServerRow],
        laneWindowIds: Set<UInt32>,
        lanePids: Set<pid_t>,
        display: CGRect
    ) -> [WindowHitCandidate] {
        rows.compactMap { row in
            let admitted = row.layer == 0
                ? laneWindowIds.contains(row.windowId) && display.intersects(row.frame)
                : row.layer < 1000 && lanePids.contains(row.pid) && display.contains(row.frame)
            guard admitted else { return nil }
            return WindowHitCandidate(pid: row.pid, frame: row.frame, minimized: false, windowId: row.windowId)
        }
    }

    /// Whether `pid` has an ordinary window on the user's own screen: off
    /// every ADE lane display (`laneDisplays`, this lane's and the others').
    /// With `pid` frontmost, that is the app the user is working in.
    public static func hasWindowOnUserScreen(_ rows: [WindowServerRow], pid: pid_t, laneDisplays: [CGRect]) -> Bool {
        rows.contains { row in
            row.pid == pid && row.layer == 0 && !laneDisplays.contains { $0.intersects(row.frame) }
        }
    }

    /// Where keys go: the frontmost window of the lane, or nil for none.
    public static func frontmostPid(in candidates: [WindowHitCandidate]) -> pid_t? {
        candidates.first(where: { !$0.minimized })?.pid
    }
}
