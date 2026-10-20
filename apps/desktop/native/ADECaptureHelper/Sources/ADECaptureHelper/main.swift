import ADECaptureHelperCore
import AppKit
import CoreGraphics
import Foundation

/// ADE's global capture helper.
///
/// Watches for both Command keys, captures the frontmost window, and speaks
/// NDJSON to the ADE main process:
///
///   stdin   {"type":"capture"} | {"type":"settings","enabled":bool} | {"type":"retry"} | {"type":"quit"}
///   stdout  {"type":"ready"} | {"type":"chord-ready"} | {"type":"chord"} | {"type":"captured",...}
///           | {"type":"input-monitoring-required"}
///           | {"type":"permission-denied"} | {"type":"no-window"}
///           | {"type":"capture-failed","message":...}
///
/// Two deliberate choices worth not undoing:
///
/// 1. The chord is read from `.flagsChanged` key codes through a listen-only
///    event tap (55 left Command, 54 right Command), and only where that tap is
///    unavailable on an older macOS does it fall back to polling the static
///    `NSEvent.modifierFlags` device bits.
///
///    Until macOS 27 the static poll was enough: it returned the device-
///    dependent left/right masks without any permission. macOS 27 folds both
///    keys into the generic Command bit, so the poll can never see the chord.
///    A tap is the API that still names the physical key; macOS gates it behind
///    Input Monitoring, and the host says so in health rather than leaving a
///    toggle that looks on and does nothing.
/// 2. The pixels come from `/usr/sbin/screencapture -l<windowID>`, not from
///    `CGWindowListCreateImage`. The CG call was deprecated in macOS 14 in
///    favour of ScreenCaptureKit, whose window capture is async and pulls in a
///    much larger surface; `screencapture` is a supported, stable tool that does
///    exactly one window. It still requires the Screen Recording grant, which is
///    why the app ships `NSScreenCaptureUsageDescription`.

// MARK: - stdout

/// Serialised writes to stdout. The capture runs off the main thread, so two
/// events can be produced concurrently and interleaved bytes would corrupt the
/// NDJSON stream ADE is parsing.
final class EventWriter {
    private let queue = DispatchQueue(label: "com.ade.capture-helper.stdout")

    func emit(_ event: HelperEvent) {
        guard let line = event.encoded() else { return }
        queue.async {
            FileHandle.standardOutput.write(Data(line.utf8))
        }
    }
}

// MARK: - Window capture

struct FrontmostWindow {
    let windowID: CGWindowID
    let ownerPid: Int32
    let appName: String?
    let title: String?
    let bounds: CGRect
}

enum CaptureError: Error {
    case noWindow
    case permissionDenied
    case failed(String)
}

final class WindowCapturer {
    private let outputDirectory: URL
    private let selfPid = ProcessInfo.processInfo.processIdentifier

    init(outputDirectory: URL) {
        self.outputDirectory = outputDirectory
    }

    /// The topmost normal window that is not one of ours.
    ///
    /// `CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID)` returns
    /// windows front-to-back, so the first match wins. Layer 0 filters out the
    /// menu bar, the Dock, notification banners and every other chrome surface —
    /// capturing the Dock because the pointer was near it is the obvious way to
    /// get this wrong. The helper's own (invisible) windows are excluded by pid:
    /// the flash overlay must never be what gets captured.
    func frontmostWindow() -> FrontmostWindow? {
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let raw = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
            return nil
        }
        for entry in raw {
            guard
                let layer = entry[kCGWindowLayer as String] as? Int, layer == 0,
                let windowNumber = entry[kCGWindowNumber as String] as? Int,
                let ownerPid = entry[kCGWindowOwnerPID as String] as? Int,
                Int32(ownerPid) != selfPid,
                let boundsDict = entry[kCGWindowBounds as String] as? [String: Any],
                let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary)
            else { continue }
            // Zero-area and hairline windows are helper surfaces (status item
            // shadows, tooltips that report layer 0), never what the user meant.
            guard bounds.width >= 40, bounds.height >= 40 else { continue }
            return FrontmostWindow(
                windowID: CGWindowID(windowNumber),
                ownerPid: Int32(ownerPid),
                appName: entry[kCGWindowOwnerName as String] as? String,
                title: entry[kCGWindowName as String] as? String,
                bounds: bounds
            )
        }
        return nil
    }

    func capture() throws -> (window: FrontmostWindow, path: URL) {
        // Preflight rather than discovering the refusal as an empty PNG:
        // `screencapture` exits 0 and writes nothing useful when the grant is
        // missing, which would surface to the user as "capture failed" instead
        // of the one message that tells them what to do.
        if !CGPreflightScreenCaptureAccess() {
            // Fire the system prompt once; the user still has to restart ADE
            // after granting, which is what the renderer's copy says.
            CGRequestScreenCaptureAccess()
            throw CaptureError.permissionDenied
        }
        guard let window = frontmostWindow() else { throw CaptureError.noWindow }

        try? FileManager.default.createDirectory(
            at: outputDirectory,
            withIntermediateDirectories: true
        )
        let destination = outputDirectory.appendingPathComponent(
            "capture-\(UInt64(Date().timeIntervalSince1970 * 1000)).png"
        )

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        process.arguments = [
            "-x",                       // no shutter sound
            "-o",                       // no window shadow
            "-l\(window.windowID)",     // this window only
            destination.path,
        ]
        let errorPipe = Pipe()
        process.standardError = errorPipe
        process.standardOutput = Pipe()
        do {
            try process.run()
        } catch {
            throw CaptureError.failed("screencapture could not be started: \(error.localizedDescription)")
        }
        // Read stderr BEFORE waiting: a pipe that fills while we block in
        // waitUntilExit deadlocks the child. screencapture is not chatty, but
        // the deadlock is silent and permanent when it happens.
        let errorData = errorPipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()

        let attributes = try? FileManager.default.attributesOfItem(atPath: destination.path)
        let size = (attributes?[.size] as? NSNumber)?.intValue ?? 0
        guard process.terminationStatus == 0, size > 0 else {
            try? FileManager.default.removeItem(at: destination)
            let message = String(data: errorData, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            throw CaptureError.failed(
                message?.isEmpty == false
                    ? message!
                    : "screencapture exited with status \(process.terminationStatus)."
            )
        }
        return (window, destination)
    }
}

// MARK: - Flash

/// A brief wash of light over the window that was captured.
///
/// Borderless, ignores mouse events, and lives above everything so it reads as
/// feedback rather than a window. Suppressed entirely under Reduce Motion —
/// under that setting a full-window flash is exactly the kind of thing the user
/// asked the system to stop doing.
///
/// Not an actor and not `@MainActor`: this process has no Swift concurrency in
/// it at all. Everything that touches AppKit is hopped onto the main queue with
/// `DispatchQueue.main.async`, which is also where top-level code and the poll
/// timer already run, so there is exactly one thread with a claim on this state.
final class FlashPresenter {
    private var window: NSWindow?

    func flash(bounds: CGRect) {
        guard !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else { return }
        // CGWindow bounds are top-left origin; AppKit windows are bottom-left,
        // measured from the primary display. Without this flip the flash lands
        // mirrored vertically — near the Dock for a window near the menu bar.
        guard let primary = NSScreen.screens.first else { return }
        let flipped = NSRect(
            x: bounds.origin.x,
            y: primary.frame.maxY - bounds.origin.y - bounds.height,
            width: bounds.width,
            height: bounds.height
        )
        let panel = NSWindow(
            contentRect: flipped,
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        panel.isOpaque = false
        panel.backgroundColor = NSColor.white.withAlphaComponent(0.35)
        panel.level = .screenSaver
        panel.ignoresMouseEvents = true
        panel.hasShadow = false
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        panel.alphaValue = 1
        panel.orderFrontRegardless()
        window = panel

        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.22
            panel.animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            panel.orderOut(nil)
            if self?.window === panel { self?.window = nil }
        })
    }
}

// MARK: - Helper

/// The event tap's C callback. The app object is the `userInfo` pointer, so the
/// callback carries no captured state and can be a plain function.
private func captureChordTapCallback(
    proxy: CGEventTapProxy,
    type: CGEventType,
    event: CGEvent,
    userInfo: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    guard let userInfo else { return Unmanaged.passUnretained(event) }
    let app = Unmanaged<CaptureHelperApp>.fromOpaque(userInfo).takeUnretainedValue()
    app.handleTapEvent(type: type, event: event)
    return Unmanaged.passUnretained(event)
}

/// Main-queue confined. See `FlashPresenter` for why this is a plain class.
final class CaptureHelperApp: NSObject {
    private let writer = EventWriter()
    private let capturer: WindowCapturer
    private let flash = FlashPresenter()
    /// `.flagsChanged` key codes, the route that still works on macOS 27.
    private var detector = CommandKeyChordDetector()
    /// The pre-macOS-27 device-bit poll, kept as the no-grant fallback there.
    private var pollDetector = ChordDetector()
    private var enabled = true
    private var pollTimer: Timer?
    private var eventTap: CFMachPort?
    private var eventTapSource: CFRunLoopSource?
    private var capturing = false

    /// 40ms. Fast enough that a deliberate two-hand press is never missed (the
    /// shortest realistic both-down overlap is ~80ms), slow enough that the poll
    /// is invisible in Activity Monitor.
    private let pollInterval: TimeInterval = 0.04

    init(outputDirectory: URL) {
        capturer = WindowCapturer(outputDirectory: outputDirectory)
        super.init()
    }

    func start() {
        readCommandsInBackground()
        writer.emit(.ready)
        installChordMonitor()
    }

    private func poll() {
        let raw = NSEvent.modifierFlags.rawValue
        guard pollDetector.consume(rawFlags: raw) else { return }
        guard enabled else { return }
        writer.emit(.chord)
    }

    /// Install the chord monitor, preferring the event tap and falling back to
    /// the old poll only where the poll still carries the left/right bits.
    private func installChordMonitor() {
        // A reinstall can happen while a key is held, and the events that would
        // have released it are gone. Start both detectors from a known state.
        detector.reset()
        pollDetector.reset()
        stopPolling()
        removeEventTap()
        // Before macOS 27 the static poll still carries the device bits and
        // costs no permission. Only the version that lost them needs the tap.
        guard ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 27 else {
            startPolling()
            return
        }
        if !CGPreflightListenEventAccess() {
            // The prompt names ADE (the responsible app), not this helper.
            _ = CGRequestListenEventAccess()
        }
        if installEventTap() { return }
        // macOS 27 has no working poll fallback here, so a missing tap means
        // the gesture cannot fire at all. Say which remedy applies instead of
        // reporting a healthy gesture that never will.
        writer.emit(CGPreflightListenEventAccess() ? .chordUnavailable : .inputMonitoringRequired)
    }

    private func installEventTap() -> Bool {
        let mask = CGEventMask(1 << CGEventType.flagsChanged.rawValue)
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: mask,
            callback: captureChordTapCallback,
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        ) else {
            return false
        }
        guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
            CGEvent.tapEnable(tap: tap, enable: false)
            CFMachPortInvalidate(tap)
            return false
        }
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        eventTap = tap
        eventTapSource = source
        writer.emit(.chordReady)
        return true
    }

    private func removeEventTap() {
        if let tap = eventTap {
            CGEvent.tapEnable(tap: tap, enable: false)
            CFMachPortInvalidate(tap)
        }
        if let source = eventTapSource {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes)
        }
        eventTap = nil
        eventTapSource = nil
    }

    private func startPolling() {
        guard pollTimer == nil else { return }
        let timer = Timer(timeInterval: pollInterval, repeats: true) { [weak self] _ in
            // Already on the main thread: the timer is scheduled on the main run
            // loop, so no hop is needed (or wanted — a hop would let two polls
            // interleave around the detector's latch).
            self?.poll()
        }
        // `.common` so the poll keeps running while a menu or a window drag has
        // the run loop in tracking mode — those are exactly the moments someone
        // reaches for the gesture.
        RunLoop.main.add(timer, forMode: .common)
        pollTimer = timer
        writer.emit(.chordReady)
    }

    private func stopPolling() {
        pollTimer?.invalidate()
        pollTimer = nil
    }

    fileprivate func handleTapEvent(type: CGEventType, event: CGEvent) {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap = eventTap {
                CGEvent.tapEnable(tap: tap, enable: true)
                // A tap disabled by secure input or a revoked grant can refuse
                // to come back. Falling silent leaves health claiming running.
                if !CGEvent.tapIsEnabled(tap: tap) {
                    writer.emit(CGPreflightListenEventAccess() ? .chordUnavailable : .inputMonitoringRequired)
                }
            }
            detector.reset()
            return
        }
        guard type == .flagsChanged else { return }
        let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
        let commandDown = event.flags.contains(.maskCommand)
        guard detector.consume(keyCode: keyCode, commandDown: commandDown) else { return }
        guard enabled else { return }
        writer.emit(.chord)
    }

    private func readCommandsInBackground() {
        // A dedicated thread rather than readabilityHandler: the handler runs on
        // a run loop this process has no other use for, and a blocking line read
        // here cannot starve the poll timer on main.
        Thread.detachNewThread { [weak self] in
            while let line = readLine(strippingNewline: true) {
                guard let command = HelperCommand.parse(line: line) else { continue }
                DispatchQueue.main.async { self?.handle(command) }
            }
            // stdin closed: ADE is gone, so nothing is listening for events any
            // more. Exiting here is what stops an orphaned helper polling
            // forever if the parent dies without sending `quit`.
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }

    private func handle(_ command: HelperCommand) {
        switch command {
        case .quit:
            stopPolling()
            removeEventTap()
            NSApp.terminate(nil)
        case let .settings(enabled):
            self.enabled = enabled
            // Drop the latch so re-enabling does not fire on keys already held.
            detector.reset()
            pollDetector.reset()
        case .retry:
            installChordMonitor()
        case .capture:
            performCapture()
        }
    }

    private func performCapture() {
        guard !capturing else { return }
        capturing = true
        // Off the main thread: screencapture takes 100-300ms and blocking main
        // would stall the poll timer, so the chord would appear to stick.
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                let result = try self.capturer.capture()
                DispatchQueue.main.async {
                    self.capturing = false
                    self.flash.flash(bounds: result.window.bounds)
                    self.writer.emit(.captured(
                        path: result.path.path,
                        appName: result.window.appName,
                        windowTitle: result.window.title,
                        ownerPid: result.window.ownerPid,
                        bounds: result.window.bounds
                    ))
                }
            } catch {
                DispatchQueue.main.async {
                    self.capturing = false
                    switch error {
                    case CaptureError.permissionDenied:
                        self.writer.emit(.permissionDenied)
                    case CaptureError.noWindow:
                        self.writer.emit(.noWindow)
                    case let CaptureError.failed(message):
                        self.writer.emit(.captureFailed(message: message))
                    default:
                        self.writer.emit(.captureFailed(message: error.localizedDescription))
                    }
                }
            }
        }
    }
}

// MARK: - Entry point

let outputDirectory = URL(fileURLWithPath:
    ProcessInfo.processInfo.environment["ADE_CAPTURE_OUTPUT_DIR"]
        // Only reached when the host passed no directory. The host always does,
        // and its path is per channel; this is a last resort, not a shared location.
        ?? NSTemporaryDirectory().appending("ade-capture-fallback")
)

let application = NSApplication.shared
// `.accessory`, not `.regular` or `.prohibited`. `.regular` would put a Dock
// icon and a menu bar on a process with no UI; `.prohibited` cannot reliably
// order a window on screen at all, which would silently cost us the flash. An
// accessory app shows windows without a Dock tile and never becomes the active
// app on its own — so the window we are about to capture keeps its focus.
application.setActivationPolicy(.accessory)

let helper = CaptureHelperApp(outputDirectory: outputDirectory)
helper.start()
application.run()
