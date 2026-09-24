/// The pid watcher: new windows of a watched app get parked, escaped windows get
/// dragged back, and a window that keeps leaving is released rather than fought.
/// Only watched pids and held windows are read: nothing here lists the other
/// apps on the Mac.
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
        guard newWindows.watch(pid: pid, laneId: laneId, launched: launched, existing: existing) else {
            // Another lane launched this app and keeps watching it.
            log("pid \(pid) stays watched by lane \(newWindows.laneId(forPid: pid) ?? "?"), which launched it; lane \(laneId) does not take the watch over")
            return
        }
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
            let candidates = newWindows.candidates(
                pid: pid,
                current: current.map(\.id),
                unowned: unowned,
                minimized: Set(current.filter(\.minimized).map(\.id))
            )
            for windowId in candidates {
                // Re-checked before every candidate, because every park pumps
                // the run loop: a `display.destroy`, a Release that handed the
                // app to the user, or another lane's watch can all have run
                // inside the previous one.
                guard placement(forLane: laneId) != nil,
                      !stopGate.isStopping(laneId),
                      newWindows.laneId(forPid: pid) == laneId
                else { break }
                // A window some lane took inside the previous park's wait is
                // no longer a new window.
                guard ownership.owner(ofWindow: Int(windowId)) == nil else { continue }
                let origin = newWindows.originForNewWindow(pid: pid)
                do {
                    _ = try park(laneId: laneId, windowId: windowId, origin: origin)
                    touchedLanes.insert(laneId)
                } catch {
                    let code = (error as? DriverError)?.code
                    if ParkRecheck.isLaneGone(code: code) {
                        // The lane is going or gone: not news about the window.
                        break
                    }
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

        // One listing for every held window, scoped to their ids: a lookup
        // per window was an unscoped listing per window, and each one read
        // every app on the Mac with an off-screen window through
        // Accessibility.
        let held = ownership.all
        let live = Dictionary(
            listWindows(windowIds: Set(held.map { CGWindowID($0.windowId) })).map { ($0.id, $0) },
            uniquingKeysWith: { first, _ in first }
        )
        for record in held {
            let windowId = CGWindowID(record.windowId)
            // A release earlier in this loop can hand over a whole app, so
            // its other windows are no longer the lane's to drag back.
            guard ownership.owner(ofWindow: record.windowId) == record.laneId else { continue }
            guard let placement = placement(forLane: record.laneId) else { continue }
            guard let window = live[windowId] else {
                // The window is gone; so is its ownership.
                ownership.unpark(windowId: record.windowId)
                touchedLanes.insert(record.laneId)
                continue
            }
            // A minimized window is on no screen, and a move cannot bring it
            // back. Counting it as an escape "released" windows the user
            // had only minimized.
            guard !window.minimized, Geometry.isFullyOutside(window.frame, of: placement.frame) else {
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
                // The same release as the Release button: an app the lane
                // launched is handed over whole and never parked again.
                _ = release(windowId: windowId)
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
