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

    /// Where keys go: the frontmost window of the lane, or nil for none.
    public static func frontmostPid(in candidates: [WindowHitCandidate]) -> pid_t? {
        candidates.first(where: { !$0.minimized })?.pid
    }
}
