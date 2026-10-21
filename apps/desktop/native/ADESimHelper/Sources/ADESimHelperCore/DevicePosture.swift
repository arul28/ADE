import Foundation

/// A foldable simulator's physical pose, for ADE: set it, read it, watch it.
///
/// The transport is the vendored `CoreDeviceBridge` (serve-sim): CoreDevice's
/// private `HIDVendorDefined` send with Device Hub's own `hinge-slider-control`
/// and `orientation-picker-control` payloads, and its hinge-angle and display
/// streams for read-back. This file is ADE's: the protocol shape and what a
/// "posture" means to the pane and the CLI.
enum DevicePosture {
    /// Device Hub's presets, as `HingePoseControl` spells them.
    static let poses: Set<String> = ["closed", "open", "laptop", "book", "tent"]

    struct Display: Equatable {
        let screenID: UInt32
        let active: Bool
        let orientation: String?

        var payload: [String: Any] {
            var line: [String: Any] = ["screenId": Int(screenID), "active": active]
            if let orientation { line["orientation"] = orientation }
            return line
        }
    }

    struct State {
        let supported: Bool
        let angle: Double?
        let orientation: String?
        let tableMode: Bool?
        let displays: [Display]

        /// The screen CoreDevice says is showing, else nil.
        var activeScreenID: UInt32? { displays.first(where: \.active)?.screenID }

        var payload: [String: Any] {
            var line: [String: Any] = ["supported": supported, "displays": displays.map(\.payload)]
            if let angle { line["angle"] = angle }
            if let orientation { line["orientation"] = orientation }
            if let tableMode { line["tableMode"] = tableMode }
            if let activeScreenID { line["activeScreenId"] = Int(activeScreenID) }
            return line
        }
    }

    static func displays(udid: String) async -> [Display] {
        let read = (try? await CoreDeviceDisplayInfo.read(udid: udid)) ?? nil
        return (read ?? []).map { Display(screenID: $0.screenID, active: $0.isActive, orientation: $0.orientation) }
    }

    static func read(udid: String) async -> State {
        let bridge = CoreDeviceBridge.shared
        let supported = await bridge.supportsHingeAngle(udid: udid)
        guard supported else {
            return State(supported: false, angle: nil, orientation: nil, tableMode: nil, displays: [])
        }
        let hinge = await bridge.hingeState(udid: udid)
        return State(
            supported: true,
            angle: hinge.angle,
            orientation: hinge.orientation,
            tableMode: hinge.tableMode,
            displays: await displays(udid: udid)
        )
    }

    /// The angle each of Device Hub's presets puts the hinge at.
    private static let poseAngles: [String: Double] = ["closed": 0, "open": 180, "laptop": 90, "book": 90, "tent": 80]

    /// Apply a preset or a raw angle. Returns false when the device has no hinge
    /// or CoreDevice refused the send; never throws for "this is not a Duo".
    ///
    /// The hinge SWEEPS to its target, as Device Hub's default does, rather
    /// than jumping. SpringBoard's fold state machine has hysteresis: a jump
    /// straight between 0° and 180° can leave it on the old panel (the inner
    /// screen stays on with the phone closed, or the cover with it open). A
    /// sweep of ~10° steps, a frame apart, crosses every threshold the way a
    /// real hinge does; the preset is then applied for its orientation and
    /// Table Mode.
    static func apply(udid: String, pose: String?, angle: Double?) async -> Bool {
        let bridge = CoreDeviceBridge.shared
        guard await bridge.supportsHingeAngle(udid: udid) else { return false }
        guard let target = pose.flatMap({ poseAngles[$0] }) ?? angle else { return false }
        // A fresh helper may not know the angle yet. The active panel says
        // which end the hinge is nearer: the cover shows only when closed.
        var current = await bridge.hingeState(udid: udid).angle
        if current == nil, let active = await displays(udid: udid).first(where: \.active)?.screenID {
            current = active == 1 ? 0 : 180
        }
        if let current, abs(current - target) > 10 {
            let steps = Int((abs(current - target) / 10).rounded(.up))
            for step in 1..<steps {
                let value = current + (target - current) * Double(step) / Double(steps)
                guard await bridge.setHingeAngle(udid: udid, angle: value) else { return false }
                try? await Task.sleep(nanoseconds: 16_000_000)
            }
        }
        if let pose { return await bridge.setHingePose(udid: udid, pose: pose) }
        return await bridge.setHingeAngle(udid: udid, angle: target)
    }
}

/// One watcher per device: CoreDevice's device-state stream, plus a display
/// read on each change so the pane knows which panel to show and route input to.
actor DevicePostureWatchers {
    private var stops: [String: @Sendable () async -> Void] = [:]
    /// The newest device-state revision per device. A sweep delivers a burst of
    /// snapshots whose display re-reads finish out of order; only the newest
    /// may be reported, or a stale mid-sweep angle lands last.
    private var latestRevision: [String: UInt64] = [:]

    private func note(udid: String, revision: UInt64) {
        latestRevision[udid] = max(latestRevision[udid] ?? 0, revision)
    }

    private func isLatest(udid: String, revision: UInt64) -> Bool {
        (latestRevision[udid] ?? 0) <= revision
    }

    func start(udid: String, onChange: @escaping @Sendable (DevicePosture.State) -> Void) async -> Bool {
        if stops[udid] != nil { return true }
        guard await CoreDeviceBridge.shared.supportsHingeAngle(udid: udid) else { return false }
        let stop = await CoreDeviceBridge.shared.subscribeDeviceState(udid: udid) { snapshot in
            Task {
                await self.note(udid: udid, revision: snapshot.revision)
                // The guest elects the new panel a moment after the hinge
                // moves, so one read right away still names the old one.
                // Re-read over the next second; report each read that changes
                // the active panel, plus the first.
                var lastActive: UInt32?? = .none
                for delayMs in [0, 250, 600, 1_200] {
                    if delayMs > 0 { try? await Task.sleep(nanoseconds: UInt64(delayMs) * 1_000_000) }
                    let state = DevicePosture.State(
                        supported: true,
                        angle: snapshot.state.angle,
                        orientation: snapshot.state.orientation,
                        tableMode: snapshot.state.tableMode,
                        displays: await DevicePosture.displays(udid: udid)
                    )
                    // A newer snapshot owns the report from here on.
                    guard await self.isLatest(udid: udid, revision: snapshot.revision) else { return }
                    if case let .some(previous) = lastActive, previous == state.activeScreenID { continue }
                    lastActive = .some(state.activeScreenID)
                    onChange(state)
                }
            }
        }
        stops[udid] = stop
        return true
    }

    func stop(udid: String) async {
        guard let stop = stops.removeValue(forKey: udid) else { return }
        await stop()
    }

    func stopAll() async {
        let all = stops
        stops.removeAll()
        for stop in all.values { await stop() }
    }
}
