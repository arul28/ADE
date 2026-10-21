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

    /// Apply a preset or a raw angle. Returns false when the device has no hinge
    /// or CoreDevice refused the send; never throws for "this is not a Duo".
    static func apply(udid: String, pose: String?, angle: Double?) async -> Bool {
        let bridge = CoreDeviceBridge.shared
        guard await bridge.supportsHingeAngle(udid: udid) else { return false }
        if let pose { return await bridge.setHingePose(udid: udid, pose: pose) }
        if let angle { return await bridge.setHingeAngle(udid: udid, angle: angle) }
        return false
    }
}

/// One watcher per device: CoreDevice's device-state stream, plus a display
/// read on each change so the pane knows which panel to show and route input to.
actor DevicePostureWatchers {
    private var stops: [String: @Sendable () async -> Void] = [:]

    func start(udid: String, onChange: @escaping @Sendable (DevicePosture.State) -> Void) async -> Bool {
        if stops[udid] != nil { return true }
        guard await CoreDeviceBridge.shared.supportsHingeAngle(udid: udid) else { return false }
        let stop = await CoreDeviceBridge.shared.subscribeDeviceState(udid: udid) { snapshot in
            Task {
                let displays = await DevicePosture.displays(udid: udid)
                onChange(DevicePosture.State(
                    supported: true,
                    angle: snapshot.state.angle,
                    orientation: snapshot.state.orientation,
                    tableMode: snapshot.state.tableMode,
                    displays: displays
                ))
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
