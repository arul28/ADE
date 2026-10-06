/// Pointer input for one window, delivered to its process and nowhere else.
///
/// `RealInput` posts through the HID tap, which moves the one system pointer:
/// on a Mac, every agent click on the lane's display yanked the user's mouse
/// onto a screen they cannot see. This file posts the same clicks, scrolls and
/// drags straight to the process that owns the window under the point. The
/// window server never sees them, so the pointer stays where the user has it
/// and the user's frontmost app stays frontmost. That is why this path needs no
/// lease, exactly like the process-targeted keys in `AccessibilityDriver`.
///
/// A bare `CGEventPostToPid` is not enough, and an earlier version of
/// `RealInput` gave up on it for that reason: AppKit drops a posted click whose
/// window number is 0. What makes it land, measured live on macOS 27 against
/// AppKit, Electron and Ableton Live:
///
/// - **Routing fields.** The window id in fields 91/92 and 51, the target pid
///   (40), click group (58), button number, the touch subtype, pressure, and
///   the window-local location from the private `CGEventSetWindowLocation`,
///   so AppKit can find the `NSWindow` without the window server's hit test.
/// - **SkyLight posting.** `SLEventPostToPid`, the window server clients' own
///   path, falling back to `CGEventPostToPid` when the symbol is missing.
/// - **Focus without activation.** `BackgroundEventRecord.focus` then
///   `makeKey`, to the target only: the app believes its window is focused and
///   spends its "activating click" on the make-key pair instead of the real
///   click. Without it a view that refuses first mouse drops the click.
/// - **A guard.** If the target makes itself frontmost anyway, the user's app
///   is put back without raising any window.
///
/// Every private symbol is resolved at runtime. A missing one degrades that
/// step and is reported; nothing here can fall back to the HID tap.
///
/// Known limits: a hover (`mouseMoved`) is not delivered (AppKit routes moves
/// by the real pointer), and Chromium reports no held button during a drag.
/// Those stay on `RealInput` behind the lease.

import AppKit
import CoreGraphics
import Foundation
import ADEDesktopDriverCore

final class BackgroundInput {
    struct Target {
        let pid: pid_t
        let windowId: UInt32
        let frame: CGRect
    }

    /// What one delivery did, for the reply. The caller still observes the
    /// effect: an app is free to ignore any event it is sent.
    struct Report {
        var frontmostBefore: pid_t?
        var frontmostAfter: pid_t?
        var restoredFrontmost = 0
        var degraded: [String] = []

        func asJSON(target: Target) -> [String: JSONValue] {
            [
                "pid": .int(Int(target.pid)),
                "windowId": .int(Int(target.windowId)),
                "frontmostBefore": frontmostBefore.map { .int(Int($0)) } ?? .null,
                "frontmostAfter": frontmostAfter.map { .int(Int($0)) } ?? .null,
                "restoredFrontmost": .int(restoredFrontmost),
                "degraded": .array(degraded.map(JSONValue.string)),
            ]
        }
    }

    private let log: (String) -> Void
    private let source: CGEventSource?
    private let symbols = Symbols.shared

    init(log: @escaping (String) -> Void) {
        self.log = log
        let source = CGEventSource(stateID: .hidSystemState)
        source?.localEventsSuppressionInterval = 0
        self.source = source
    }

    func click(target: Target, at point: CGPoint, button: String, count: Int) -> Report {
        let isRight = button.lowercased() == "right"
        let downType: CGEventType = isRight ? .rightMouseDown : .leftMouseDown
        let upType: CGEventType = isRight ? .rightMouseUp : .leftMouseUp
        let mouseButton: CGMouseButton = isRight ? .right : .left
        return deliver(target) { report in
            post(.mouseMoved, at: point, button: .left, target: target, report: &report)
            pause(0.015)
            for click in 1...max(1, min(3, count)) {
                post(downType, at: point, button: mouseButton, clickState: click, pressed: true, target: target, report: &report)
                pause(0.01)
                post(upType, at: point, button: mouseButton, clickState: click, pressed: false, target: target, report: &report)
                if click < count { pause(0.03) }
            }
        }
    }

    func scroll(target: Target, at point: CGPoint, direction: String, amount: Int) throws -> Report {
        let lines = Int32(max(1, min(50, amount)))
        let (vertical, horizontal): (Int32, Int32)
        switch direction.lowercased() {
        case "up": (vertical, horizontal) = (lines, 0)
        case "down": (vertical, horizontal) = (-lines, 0)
        case "left": (vertical, horizontal) = (0, lines)
        case "right": (vertical, horizontal) = (0, -lines)
        default:
            throw DriverError(
                code: DriverErrorCode.invalidArgument,
                message: "\"\(direction)\" is not a scroll direction; use up, down, left or right."
            )
        }
        return deliver(target) { report in
            post(.mouseMoved, at: point, button: .left, target: target, report: &report)
            pause(0.015)
            guard let wheel = CGEvent(
                scrollWheelEvent2Source: source,
                units: .line,
                wheelCount: 2,
                wheel1: vertical,
                wheel2: horizontal,
                wheel3: 0
            ) else {
                report.degraded.append("scroll:event_unavailable")
                return
            }
            wheel.location = point
            route(wheel, at: point, buttonNumber: 0, pressed: nil, target: target, report: &report)
            send(wheel, to: target.pid, report: &report)
        }
    }

    /// The button goes down at `from`, moves in steps, and comes up at `to`,
    /// all to the window under `from`, the way a real drag stays with the view
    /// it started in. Nothing global is held, so no gesture gate is needed.
    func drag(target: Target, from: CGPoint, to: CGPoint, durationMs: Int) -> Report {
        deliver(target) { report in
            post(.mouseMoved, at: from, button: .left, target: target, report: &report)
            pause(0.015)
            post(.leftMouseDown, at: from, button: .left, clickState: 1, pressed: true, target: target, report: &report)
            let steps = max(2, min(60, durationMs / 16))
            for step in 1...steps {
                let progress = CGFloat(step) / CGFloat(steps)
                let point = CGPoint(x: from.x + (to.x - from.x) * progress, y: from.y + (to.y - from.y) * progress)
                post(.leftMouseDragged, at: point, button: .left, pressed: true, target: target, report: &report)
                pause(Double(max(1, durationMs)) / 1000.0 / Double(steps))
            }
            post(.leftMouseUp, at: to, button: .left, clickState: 1, pressed: false, target: target, report: &report)
        }
    }

    // -----------------------------------------------------------------------
    // Delivery
    // -----------------------------------------------------------------------

    private func deliver(_ target: Target, _ body: (inout Report) -> Void) -> Report {
        var report = Report()
        report.frontmostBefore = symbols.frontmostPid()
        focus(target, report: &report)
        body(&report)
        guardFrontmost(target: target, report: &report)
        report.frontmostAfter = symbols.frontmostPid()
        return report
    }

    /// The two target-only records, then a beat for the app to process them
    /// before the input arrives.
    private func focus(_ target: Target, report: inout Report) {
        guard let psn = symbols.processSerialNumber(target.pid) else {
            report.degraded.append("focus:process_unavailable")
            return
        }
        let records = [
            BackgroundEventRecord.focus(windowId: target.windowId),
            BackgroundEventRecord.makeKey(windowId: target.windowId, down: true),
            BackgroundEventRecord.makeKey(windowId: target.windowId, down: false),
        ]
        for record in records {
            guard let status = symbols.postRecord(psn, record) else {
                report.degraded.append("focus:SLPSPostEventRecordTo_unavailable")
                return
            }
            if status != 0 {
                report.degraded.append("focus:status_\(status)")
                return
            }
        }
        pause(0.05)
    }

    /// Watches the front for a moment after the input. Only the TARGET taking
    /// the front counts: any other change is the user switching apps, which is
    /// theirs to do and is never undone.
    private func guardFrontmost(target: Target, report: inout Report) {
        guard let user = report.frontmostBefore, user != target.pid else {
            pause(0.05)
            return
        }
        for _ in 0..<6 {
            pause(0.025)
            guard let front = symbols.frontmostPid() else { continue }
            if front == target.pid, report.restoredFrontmost < 3 {
                if symbols.restoreFrontmost(user) {
                    report.restoredFrontmost += 1
                    log("background input: pid \(target.pid) took the front; gave it back to pid \(user)")
                } else {
                    report.degraded.append("guard:restore_unavailable")
                    return
                }
            } else if front != target.pid && front != user {
                return
            }
        }
    }

    private func post(
        _ type: CGEventType,
        at point: CGPoint,
        button: CGMouseButton,
        clickState: Int = 0,
        pressed: Bool? = nil,
        target: Target,
        report: inout Report
    ) {
        guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button) else {
            report.degraded.append("post:event_unavailable")
            return
        }
        if clickState > 0 { event.setIntegerValueField(.mouseEventClickState, value: Int64(clickState)) }
        route(event, at: point, buttonNumber: button == .right ? 1 : 0, pressed: pressed, target: target, report: &report)
        send(event, to: target.pid, report: &report)
    }

    private func route(
        _ event: CGEvent,
        at point: CGPoint,
        buttonNumber: Int64,
        pressed: Bool?,
        target: Target,
        report: inout Report
    ) {
        let windowId = Int64(target.windowId)
        event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: windowId)
        event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: windowId)
        event.setIntegerValueField(.eventTargetUnixProcessID, value: Int64(target.pid))
        if let windowNumber = CGEventField(rawValue: 51) { event.setIntegerValueField(windowNumber, value: windowId) }
        if let clickGroup = CGEventField(rawValue: 58) { event.setIntegerValueField(clickGroup, value: 1) }
        event.setIntegerValueField(.mouseEventButtonNumber, value: buttonNumber)
        event.setIntegerValueField(.mouseEventSubtype, value: 3)
        if let pressed { event.setDoubleValueField(.mouseEventPressure, value: pressed ? 1 : 0) }
        let local = CGPoint(x: point.x - target.frame.minX, y: point.y - target.frame.minY)
        if !symbols.setWindowLocation(event, local), !report.degraded.contains("route:CGEventSetWindowLocation_unavailable") {
            report.degraded.append("route:CGEventSetWindowLocation_unavailable")
        }
    }

    private func send(_ event: CGEvent, to pid: pid_t, report: inout Report) {
        if symbols.postToPid(pid, event) { return }
        if !report.degraded.contains("post:SLEventPostToPid_unavailable") {
            report.degraded.append("post:SLEventPostToPid_unavailable")
        }
        event.postToPid(pid)
    }

    /// Short gaps are slept; longer ones pump the run loop, because every
    /// request this driver handles runs on the main thread.
    private func pause(_ seconds: Double) {
        if seconds <= 0.02 {
            usleep(useconds_t(seconds * 1_000_000))
        } else {
            RunLoopPump.wait(until: { false }, timeout: seconds)
        }
    }
}

/// The private SkyLight and Carbon entry points, resolved once.
///
/// `GetProcessForPID` lives in HIServices, which a process that never touched
/// Carbon has not loaded, so it is opened explicitly; without it every
/// focus record silently degrades.
private final class Symbols {
    static let shared = Symbols()

    private typealias PostToPid = @convention(c) (pid_t, CGEvent) -> Void
    private typealias SetWindowLocation = @convention(c) (CGEvent, CGPoint) -> Void
    private typealias PostRecord = @convention(c) (UnsafePointer<ProcessSerialNumber>, UnsafePointer<UInt8>) -> Int32
    private typealias ProcessForPid = @convention(c) (pid_t, UnsafeMutablePointer<ProcessSerialNumber>) -> Int32
    private typealias PidForProcess = @convention(c) (UnsafePointer<ProcessSerialNumber>, UnsafeMutablePointer<pid_t>) -> Int32
    private typealias GetFront = @convention(c) (UnsafeMutablePointer<ProcessSerialNumber>) -> Int32
    private typealias SetFront = @convention(c) (UnsafePointer<ProcessSerialNumber>, UInt32, UInt32) -> Int32

    private let postToPidFn: PostToPid?
    private let setWindowLocationFn: SetWindowLocation?
    private let postRecordFn: PostRecord?
    private let processForPidFn: ProcessForPid?
    private let pidForProcessFn: PidForProcess?
    private let getFrontFn: GetFront?
    private let setFrontFn: SetFront?

    /// yabai's `kCPSNoWindows`: frontmost without raising or reordering.
    private static let noWindows: UInt32 = 0x400

    private init() {
        let skyLight = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY)
        let hiServices = dlopen(
            "/System/Library/Frameworks/ApplicationServices.framework/Frameworks/HIServices.framework/HIServices",
            RTLD_LAZY
        )
        func lookup<T>(_ names: [String], in handles: [UnsafeMutableRawPointer?], as _: T.Type) -> T? {
            for name in names {
                for handle in handles {
                    if let symbol = dlsym(handle ?? UnsafeMutableRawPointer(bitPattern: -2), name) {
                        return unsafeBitCast(symbol, to: T.self)
                    }
                }
            }
            return nil
        }
        postToPidFn = lookup(["SLEventPostToPid"], in: [skyLight], as: PostToPid.self)
        setWindowLocationFn = lookup(["CGEventSetWindowLocation"], in: [skyLight, nil], as: SetWindowLocation.self)
        postRecordFn = lookup(["SLPSPostEventRecordTo"], in: [skyLight], as: PostRecord.self)
        processForPidFn = lookup(["GetProcessForPID"], in: [hiServices, nil], as: ProcessForPid.self)
        pidForProcessFn = lookup(["GetProcessPID"], in: [hiServices, nil], as: PidForProcess.self)
        getFrontFn = lookup(["_SLPSGetFrontProcess", "SLPSGetFrontProcess"], in: [skyLight], as: GetFront.self)
        setFrontFn = lookup(["_SLPSSetFrontProcessWithOptions", "SLPSSetFrontProcessWithOptions"], in: [skyLight], as: SetFront.self)
    }

    func postToPid(_ pid: pid_t, _ event: CGEvent) -> Bool {
        guard let postToPidFn else { return false }
        postToPidFn(pid, event)
        return true
    }

    func setWindowLocation(_ event: CGEvent, _ point: CGPoint) -> Bool {
        guard let setWindowLocationFn else { return false }
        setWindowLocationFn(event, point)
        return true
    }

    func processSerialNumber(_ pid: pid_t) -> ProcessSerialNumber? {
        guard let processForPidFn else { return nil }
        var psn = ProcessSerialNumber()
        return processForPidFn(pid, &psn) == 0 ? psn : nil
    }

    /// nil when the symbol is missing, otherwise the status.
    func postRecord(_ psn: ProcessSerialNumber, _ record: [UInt8]) -> Int32? {
        guard let postRecordFn else { return nil }
        var psn = psn
        return record.withUnsafeBufferPointer { postRecordFn(&psn, $0.baseAddress!) }
    }

    /// The window server's frontmost process, which stays current in a helper
    /// that does not own the AppKit notifications `NSWorkspace` relies on.
    func frontmostPid() -> pid_t? {
        if let getFrontFn, let pidForProcessFn {
            var psn = ProcessSerialNumber()
            var pid: pid_t = 0
            if getFrontFn(&psn) == 0, pidForProcessFn(&psn, &pid) == 0, pid > 0 { return pid }
        }
        return NSWorkspace.shared.frontmostApplication?.processIdentifier
    }

    /// Makes the user's own app frontmost again without raising its windows.
    /// Never called for the target.
    func restoreFrontmost(_ pid: pid_t) -> Bool {
        guard let setFrontFn, var psn = processSerialNumber(pid) else { return false }
        return setFrontFn(&psn, 0, Self.noWindows) == 0
    }
}
