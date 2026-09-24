/// The pid watcher: new windows of a watched app get parked, escaped windows get
/// dragged back, and a window that keeps leaving is released rather than fought.
///
/// An `AXObserver` per watched pid is the fast path; the 1-second poll is the
/// belt to its braces, because an observer misses windows created before it was
/// installed and never fires at all for apps that make windows in a helper
/// process. Lifted out of `WindowControl.swift` unchanged.

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ADEDesktopDriverCore

extension WindowControl {
    /// Watches a pid for new windows. `launched` is whether the lane started
    /// this instance: every window of a launched app is the lane's, while
    /// only the windows a claimed (user) app opens later are parked.
    func startWatching(pid: pid_t, laneId: String, launched: Bool) {
        let alreadyWatching = newWindows.isWatching(pid: pid)
        let existing = alreadyWatching || launched ? [] : listWindows(pid: pid).map(\.id)
        newWindows.watch(pid: pid, laneId: laneId, launched: launched, existing: existing)
        if !alreadyWatching {
            installObserver(pid: pid)
        }
        ensurePollTimer()
    }

    func stopWatching(pid: pid_t) {
        newWindows.unwatch(pid: pid)
        lock.lock()
        defer { lock.unlock() }
        if let observer = observers.removeValue(forKey: pid) {
            CFRunLoopRemoveSource(
                CFRunLoopGetMain(),
                AXObserverGetRunLoopSource(observer),
                .defaultMode
            )
        }
    }

    private func installObserver(pid: pid_t) {
        var observer: AXObserver?
        let callback: AXObserverCallback = { _, _, _, refcon in
            guard let refcon else { return }
            let control = Unmanaged<WindowControl>.fromOpaque(refcon).takeUnretainedValue()
            // The notification fires before the window has its final frame, so
            // the sweep runs a beat later rather than inline.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                control.sweep()
            }
        }
        guard AXObserverCreate(pid, callback, &observer) == .success, let observer else {
            log("no AX observer for pid \(pid); falling back to polling")
            return
        }
        let application = AXUIElementCreateApplication(pid)
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        AXObserverAddNotification(observer, application, kAXWindowCreatedNotification as CFString, refcon)
        AXObserverAddNotification(observer, application, kAXUIElementDestroyedNotification as CFString, refcon)
        AXObserverAddNotification(observer, application, kAXWindowMovedNotification as CFString, refcon)
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode)
        lock.lock()
        observers[pid] = observer
        lock.unlock()
    }

    /// The 1 s belt to the observer's braces.
    ///
    /// An `AXObserver` misses windows created before the observer was installed,
    /// and apps that create windows in a helper process never fire it at all.
    private func ensurePollTimer() {
        guard pollTimer == nil else { return }
        let timer = Timer(timeInterval: 1.0, repeats: true) { [weak self] _ in
            self?.sweep()
        }
        RunLoop.main.add(timer, forMode: .common)
        pollTimer = timer
    }

    /// Adopt new windows of watched pids, and drag escaped windows back.
    func sweep() {
        // A park pumps the run loop while it waits for a window to be ready,
        // and the poll timer and the observer callbacks fire inside that
        // pump. A nested sweep would try the same window again inside the
        // first attempt, so it is skipped; the next tick does its work.
        guard !isSweeping else { return }
        isSweeping = true
        defer { isSweeping = false }
        let watched = newWindows.watchedPids
        var touchedLanes = Set<String>()

        for (pid, laneId) in watched {
            guard NSRunningApplication(processIdentifier: pid) != nil else {
                stopWatching(pid: pid)
                launchedApps.forget(pid: pid)
                touchedLanes.insert(laneId)
                continue
            }
            let current = listWindows(pid: pid)
            let unowned = Set(current.filter { $0.laneId == nil }.map(\.id))
            let candidates = newWindows.candidates(pid: pid, current: current.map(\.id), unowned: unowned)
            let origin = newWindows.originForNewWindow(pid: pid)
            for windowId in candidates {
                // The display can go away inside this loop: a park pumps the
                // run loop, and a `display.destroy` runs inside that pump.
                guard placement(forLane: laneId) != nil, newWindows.isWatching(pid: pid) else { break }
                do {
                    _ = try park(laneId: laneId, windowId: windowId, origin: origin)
                    touchedLanes.insert(laneId)
                } catch {
                    let code = (error as? DriverError)?.code
                    if code == DriverErrorCode.windowNotReady {
                        // Not a failure, a "not yet" — but not forever. A
                        // restored window that never publishes an element
                        // cost a 1.5-second readiness wait on every sweep.
                        let decision = newWindows.noteNotReady(pid: pid, windowId: windowId)
                        emit(
                            DriverEvent(
                                event: "window-not-parked",
                                fields: [
                                    "laneId": .string(laneId),
                                    "windowId": .int(Int(windowId)),
                                    "reason": .string("not_ready"),
                                ]
                            )
                        )
                        switch decision {
                        case .retry(let isFirst):
                            if isFirst {
                                log("window \(windowId) of pid \(pid) is not ready yet; retrying up to \(newWindows.maxNotReadyAttempts) times")
                            }
                        case .giveUp:
                            log("window \(windowId) of pid \(pid) never became ready; leaving it where it is")
                        }
                    } else {
                        newWindows.noteFailed(pid: pid, windowId: windowId)
                        // A window that ended between the listing and the park
                        // is not news.
                        guard code != DriverErrorCode.windowNotFound else { continue }
                        emit(
                            DriverEvent(
                                event: "window-not-parked",
                                fields: [
                                    "laneId": .string(laneId),
                                    "windowId": .int(Int(windowId)),
                                    "reason": .string(code ?? "error"),
                                    "message": .string((error as? DriverError)?.message ?? "\(error)"),
                                ]
                            )
                        )
                        log("could not park new window \(windowId) of pid \(pid): \(error)")
                    }
                }
            }
        }

        // Repark moves are skipped, not merely postponed by luck, while a real
        // gesture is in flight: `setFrame` on a window the user's pointer is
        // dragging fights the drag, and the escape counter would charge the
        // window for a displacement the driver itself is causing. The gesture
        // is bounded, so the next sweep a second later does the work.
        guard !isGestureInFlight() else {
            for laneId in touchedLanes {
                emitWindowsChanged(laneId: laneId)
            }
            return
        }

        for record in ownership.all {
            let windowId = CGWindowID(record.windowId)
            guard let placement = placement(forLane: record.laneId) else { continue }
            guard let window = window(withId: windowId) else {
                // The window is gone; so is its ownership.
                ownership.unpark(windowId: record.windowId)
                touchedLanes.insert(record.laneId)
                continue
            }
            guard Geometry.isFullyOutside(window.frame, of: placement.frame) else {
                lock.lock()
                reparkAttempts[windowId] = 0
                lock.unlock()
                continue
            }
            lock.lock()
            let attempts = (reparkAttempts[windowId] ?? 0) + 1
            reparkAttempts[windowId] = attempts
            lock.unlock()
            if attempts > Self.maxReparkAttempts {
                log("window \(windowId) keeps leaving lane \(record.laneId); releasing it")
                emit(
                    DriverEvent(
                        event: "window-escaped",
                        fields: [
                            "laneId": .string(record.laneId),
                            "windowId": .int(record.windowId),
                            "attempts": .int(attempts - 1),
                        ]
                    )
                )
                _ = unpark(windowId: windowId)
                touchedLanes.insert(record.laneId)
                continue
            }
            if let element = axWindow(for: window) {
                let target = Geometry.cascadeFrame(index: 0, size: window.frame.size, display: placement)
                _ = Self.setFrame(element, target)
                touchedLanes.insert(record.laneId)
            }
        }

        for laneId in touchedLanes {
            emitWindowsChanged(laneId: laneId)
        }
    }

    func dispose() {
        pollTimer?.invalidate()
        pollTimer = nil
        for pid in newWindows.watchedPids.keys {
            stopWatching(pid: pid)
        }
    }
}
