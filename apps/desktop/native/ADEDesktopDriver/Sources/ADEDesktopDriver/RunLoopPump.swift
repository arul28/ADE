import Foundation

/// Turning an async framework call back into a straight line.
///
/// The driver does every piece of work on the main thread — AppKit, the
/// Accessibility API and the `AXObserver` sources all require it — but
/// ScreenCaptureKit and AVFoundation only speak callbacks. Pumping the run loop
/// keeps AppKit, those observer sources, the window watcher *and the queued
/// requests of every other lane* alive while this one waits; a bare semaphore
/// wait, or a `Thread.sleep`, on the main thread would starve the very
/// callbacks it is waiting for.
///
/// `until: { false }` is the deliberate spelling of "pump for this long": it is
/// how a poll interval is spent without blocking anybody else.
enum RunLoopPump {
    static func wait(until condition: () -> Bool, timeout: TimeInterval) {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline {
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.02))
        }
    }
}
