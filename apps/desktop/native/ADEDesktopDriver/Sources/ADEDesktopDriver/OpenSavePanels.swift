/// The Open and Save panels macOS draws for a lane's apps.
///
/// A sandboxed app (TextEdit, Preview, most App Store apps) does not draw its
/// own Open or Save panel: AppKit runs it in an XPC service instance,
/// `com.apple.appkit.xpc.openAndSavePanelService`, one per client app, and the
/// window belongs to that process. A free-standing panel opens on the user's
/// display even when the app's window is on a lane's screen, and nothing tied
/// it back to the lane: the watcher reads only the lane's own app pids, and a
/// lane's listing shows only what is already on its screen. The agent never
/// heard of it, and the user found a panel nobody had told them about.
///
/// macOS records the client as the service's responsible process. That ties a
/// panel to exactly one app, so the sweep can move a lane app's panel onto the
/// lane's screen, and say so on `observe` when macOS does not let it.

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ADEDesktopDriverCore

/// `responsibility_get_pid_responsible_for_pid`, resolved at runtime.
///
/// Private libsystem API: the process macOS holds responsible for another,
/// which for an XPC service instance is the app it serves (checked on this
/// Mac: every WebKit content process maps to Safari). Resolved with `dlsym`,
/// so a macOS without it costs this feature, not the driver's launch.
enum ResponsibleProcess {
    private typealias Get = @convention(c) (pid_t) -> pid_t
    private static let get: Get? = {
        let rtldDefault = UnsafeMutableRawPointer(bitPattern: -2)
        guard let symbol = dlsym(rtldDefault, "responsibility_get_pid_responsible_for_pid") else { return nil }
        return unsafeBitCast(symbol, to: Get.self)
    }()

    /// The app `pid` works for, or nil when it answers for itself.
    static func pid(responsibleFor pid: pid_t) -> pid_t? {
        guard let get else { return nil }
        let responsible = get(pid)
        return responsible > 0 && responsible != pid ? responsible : nil
    }
}

/// One on-screen panel window of a service instance, and the app it serves.
struct OpenSavePanelWindow {
    let windowId: CGWindowID
    let servicePid: pid_t
    let clientPid: pid_t
    let frame: CGRect
    let title: String?
}

extension WindowControl {
    /// How many moves a panel gets before the sweep reports it instead.
    static let maxPanelMoveAttempts = 2

    /// On-screen panel windows whose service serves one of `clientPids`.
    ///
    /// One on-screen window-server read. A process is asked for its bundle id
    /// and its responsible process once, then remembered by pid.
    func openSavePanels(clientPids: Set<pid_t>) -> [OpenSavePanelWindow] {
        guard !clientPids.isEmpty,
              let raw = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
                as? [[String: Any]]
        else { return [] }
        var panels: [OpenSavePanelWindow] = []
        var livePids = Set<pid_t>()
        for entry in raw {
            guard let ownerPid = entry[kCGWindowOwnerPID as String] as? Int32,
                  let layer = entry[kCGWindowLayer as String] as? Int,
                  layer >= 0, layer < WindowLayerPolicy.menuBand,
                  let windowNumber = entry[kCGWindowNumber as String] as? UInt32
            else { continue }
            livePids.insert(ownerPid)
            guard let clientPid = panelServiceClient(pid: ownerPid), clientPids.contains(clientPid) else { continue }
            let bounds = entry[kCGWindowBounds as String] as? [String: Any]
            let frame = bounds.flatMap { CGRect(dictionaryRepresentation: $0 as CFDictionary) } ?? .zero
            guard frame.width > 0, frame.height > 0 else { continue }
            let title = (entry[kCGWindowName as String] as? String).flatMap { $0.isEmpty ? nil : $0 }
            panels.append(OpenSavePanelWindow(
                windowId: CGWindowID(windowNumber),
                servicePid: ownerPid,
                clientPid: clientPid,
                frame: frame,
                title: title
            ))
        }
        // A pid can be reused by an unrelated process later.
        lock.lock()
        panelServiceClients = panelServiceClients.filter { livePids.contains($0.key) }
        lock.unlock()
        return panels
    }

    /// The app a panel service instance serves; nil for any other process.
    private func panelServiceClient(pid: pid_t) -> pid_t? {
        lock.lock()
        if let known = panelServiceClients[pid] {
            lock.unlock()
            return known
        }
        lock.unlock()
        let bundleId = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier
        let client = WindowLayerPolicy.isOpenSavePanelService(bundleId: bundleId)
            ? ResponsibleProcess.pid(responsibleFor: pid)
            : nil
        lock.lock()
        panelServiceClients[pid] = .some(client)
        lock.unlock()
        return client
    }

    /// The sweep's pass over the panels of watched apps: one that sits off
    /// every lane screen is moved onto its app's lane screen, at most
    /// `maxPanelMoveAttempts` times; then it is reported on `observe`. Never
    /// held: a hold would make the service's next panel the lane's too.
    /// Returns the lanes whose screens changed.
    func sweepOpenSavePanels(watched: [pid_t: String]) -> Set<String> {
        let panels = openSavePanels(clientPids: Set(watched.keys))
        var touched = Set<String>()
        var seen = Set<CGWindowID>()
        for panel in panels {
            seen.insert(panel.windowId)
            guard let laneId = watched[panel.clientPid] else { continue }
            if isOnLaneDisplay(panel.frame) {
                if forgetPanel(windowId: panel.windowId) { touched.insert(laneId) }
                continue
            }
            guard let placement = placement(forLane: laneId), !stopGate.isStopping(laneId) else { continue }
            lock.lock()
            let attempts = panelMoveAttempts[panel.windowId] ?? 0
            lock.unlock()
            if attempts < Self.maxPanelMoveAttempts {
                lock.lock()
                panelMoveAttempts[panel.windowId] = attempts + 1
                lock.unlock()
                if movePanel(panel, to: placement) {
                    log("moved the Open/Save panel \(panel.windowId) of pid \(panel.clientPid) to lane \(laneId)'s screen")
                    touched.insert(laneId)
                }
                // Checked on the next sweep: the window server reports the
                // new frame a beat later, and macOS may put it back.
                continue
            }
            if notePanelOffLane(panel, laneId: laneId) { touched.insert(laneId) }
        }
        // Panels that closed.
        lock.lock()
        let gone = panelMoveAttempts.keys.filter { !seen.contains($0) }
        lock.unlock()
        for windowId in gone {
            let laneId = offLaneLaneId(windowId: windowId)
            if forgetPanel(windowId: windowId), let laneId { touched.insert(laneId) }
        }
        return touched
    }

    /// Moves a panel by Accessibility on its service process, keeping its
    /// size. A short messaging timeout: a call that touches a panel has
    /// stalled for seconds before (see `AXWalkBudget.swift`).
    private func movePanel(_ panel: OpenSavePanelWindow, to placement: DisplayPlacement) -> Bool {
        guard let elements = axWindowElements(pid: panel.servicePid) else { return false }
        let element = elements.first { AXWindowBridge.windowId(of: $0) == panel.windowId }
            ?? elements.first { element in
                guard let frame = Self.frame(of: element) else { return false }
                return abs(frame.origin.x - panel.frame.origin.x) < 2 && abs(frame.origin.y - panel.frame.origin.y) < 2
            }
        guard let element else { return false }
        var origin = Geometry.cascadeFrame(index: 0, size: panel.frame.size, display: placement).origin
        guard let position = AXValueCreate(.cgPoint, &origin) else { return false }
        return AXUIElementSetAttributeValue(element, kAXPositionAttribute as CFString, position) == .success
    }

    /// Reports a panel the sweep could not move. True when the note is new.
    private func notePanelOffLane(_ panel: OpenSavePanelWindow, laneId: String) -> Bool {
        let appName = NSRunningApplication(processIdentifier: panel.clientPid)?.localizedName ?? "pid \(panel.clientPid)"
        lock.lock()
        let isNew = offLaneWindows[panel.windowId] == nil
        offLaneWindows[panel.windowId] = OffLaneWindow(
            laneId: laneId,
            pid: panel.servicePid,
            appName: "\(appName)'s Open/Save panel",
            title: panel.title,
            reason: "macOS draws this panel for \(appName) in its own process and did not let ADE move it. "
                + "Cancel it, keep \(appName)'s window on this lane's screen, and open the panel again: "
                + "it then opens over that window",
            panelClientPid: panel.clientPid
        )
        lock.unlock()
        if isNew {
            log("the Open/Save panel \(panel.windowId) of \(appName) stays on the user's display")
        }
        return isNew
    }

    /// Drops a panel's move count and off-lane note. True when a note went.
    @discardableResult
    private func forgetPanel(windowId: CGWindowID) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        panelMoveAttempts.removeValue(forKey: windowId)
        guard offLaneWindows[windowId]?.panelClientPid != nil else { return false }
        offLaneWindows.removeValue(forKey: windowId)
        return true
    }

    private func offLaneLaneId(windowId: CGWindowID) -> String? {
        lock.lock()
        defer { lock.unlock() }
        return offLaneWindows[windowId]?.laneId
    }
}
