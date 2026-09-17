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
    func startWatching(pid: pid_t, laneId: String) {
        lock.lock()
        let alreadyWatching = watchedPids[pid] != nil
        watchedPids[pid] = laneId
        knownWindowsByPid[pid] = Set(listWindows(pid: pid).map(\.id))
        lock.unlock()
        if !alreadyWatching {
            installObserver(pid: pid)
        }
        ensurePollTimer()
    }

    func stopWatching(pid: pid_t) {
        lock.lock()
        defer { lock.unlock() }
        watchedPids.removeValue(forKey: pid)
        knownWindowsByPid.removeValue(forKey: pid)
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
        lock.lock()
        let watched = watchedPids
        lock.unlock()
        var touchedLanes = Set<String>()

        for (pid, laneId) in watched {
            guard NSRunningApplication(processIdentifier: pid) != nil else {
                stopWatching(pid: pid)
                touchedLanes.insert(laneId)
                continue
            }
            let current = listWindows(pid: pid)
            lock.lock()
            let known = knownWindowsByPid[pid] ?? []
            knownWindowsByPid[pid] = Set(current.map(\.id))
            lock.unlock()
            for window in current where !known.contains(window.id) && window.laneId == nil {
                do {
                    _ = try park(laneId: laneId, windowId: window.id, origin: "ade_launched")
                    touchedLanes.insert(laneId)
                } catch {
                    let code = (error as? DriverError)?.code
                    if code == DriverErrorCode.windowNotReady {
                        // Not a failure, a "not yet". Forgetting the window here
                        // is what makes the next poll try again: `known` is the
                        // only record that this sweep already considered it.
                        lock.lock()
                        knownWindowsByPid[pid]?.remove(window.id)
                        lock.unlock()
                        emit(
                            DriverEvent(
                                event: "window-not-parked",
                                fields: [
                                    "laneId": .string(laneId),
                                    "windowId": .int(Int(window.id)),
                                    "reason": .string("not_ready"),
                                ]
                            )
                        )
                        log("window \(window.id) of pid \(pid) is not ready yet; retrying on the next poll")
                    } else {
                        emit(
                            DriverEvent(
                                event: "window-not-parked",
                                fields: [
                                    "laneId": .string(laneId),
                                    "windowId": .int(Int(window.id)),
                                    "reason": .string(code ?? "error"),
                                    "message": .string((error as? DriverError)?.message ?? "\(error)"),
                                ]
                            )
                        )
                        log("could not park new window \(window.id) of pid \(pid): \(error)")
                    }
                }
            }
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
        lock.lock()
        let pids = Array(watchedPids.keys)
        lock.unlock()
        for pid in pids {
            stopWatching(pid: pid)
        }
    }
}
