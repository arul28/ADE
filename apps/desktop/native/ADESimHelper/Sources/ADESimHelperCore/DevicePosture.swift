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

    /// Each integrated panel's pixel size by screen id, from `simctl io
    /// enumerate` ("Screen ID: 1 … Pixel Size: {1398, 2034}"). Used to map a
    /// tap when no capture is running to measure the panel.
    static func panelPixelSizes(udid: String) -> [UInt32: (width: Int, height: Int)] {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
        process.arguments = ["simctl", "io", udid, "enumerate"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            return [:]
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let text = String(decoding: data, as: UTF8.self)
        var sizes: [UInt32: (width: Int, height: Int)] = [:]
        var screen: UInt32?
        var integrated = false
        for line in text.split(separator: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("Screen ID:") {
                screen = UInt32(trimmed.dropFirst("Screen ID:".count).trimmingCharacters(in: .whitespaces))
                integrated = false
            } else if trimmed.hasPrefix("Screen Type:") {
                integrated = trimmed.contains("Integrated")
            } else if trimmed.hasPrefix("Pixel Size:"), let screen, integrated {
                let digits = trimmed.split(whereSeparator: { !$0.isNumber }).compactMap { Int($0) }
                if digits.count >= 2 { sizes[screen] = (digits[0], digits[1]) }
            }
        }
        return sizes
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
        // A raw angle leaves the presets: like Device Hub's slider it releases
        // Table Mode (Tent's), and a phone left face down by Tent stands back
        // up, or the cover stays the live panel at any angle.
        guard await bridge.setHingeAngle(udid: udid, angle: target) else { return false }
        _ = await bridge.setTableMode(udid: udid, enabled: false)
        if await bridge.hingeState(udid: udid).orientation == "facedown" {
            _ = await bridge.setPhysicalOrientation(udid: udid, value: "portrait")
        }
        return true
    }
}

/// One watcher per device: CoreDevice's device-state stream, plus a display
/// read on each change so the pane knows which panel to show and route input to.
actor DevicePostureWatchers {
    private var stops: [String: @Sendable () async -> Void] = [:]
    /// The newest device-state snapshot per device, as (generation, revision).
    /// A sweep delivers a burst of snapshots whose display re-reads finish out
    /// of order; only the newest may be reported, or a stale mid-sweep angle
    /// lands last. The generation leads: a reset (`resetForNewCapture`) starts
    /// revisions again at 0 under a new generation, and must not be mistaken
    /// for an old snapshot.
    private var latest: [String: (generation: UInt64, revision: UInt64)] = [:]

    private func note(udid: String, generation: UInt64, revision: UInt64) {
        if let current = latest[udid],
           current.generation > generation || (current.generation == generation && current.revision >= revision) {
            return
        }
        latest[udid] = (generation, revision)
    }

    private func isLatest(udid: String, generation: UInt64, revision: UInt64) -> Bool {
        guard let current = latest[udid] else { return true }
        return generation > current.generation || (generation == current.generation && revision >= current.revision)
    }

    func start(udid: String, onChange: @escaping @Sendable (DevicePosture.State) -> Void) async -> Bool {
        if stops[udid] != nil { return true }
        guard await CoreDeviceBridge.shared.supportsHingeAngle(udid: udid) else { return false }
        let stop = await CoreDeviceBridge.shared.subscribeDeviceState(udid: udid) { snapshot in
            Task {
                await self.note(udid: udid, generation: snapshot.generation, revision: snapshot.revision)
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
                    guard await self.isLatest(udid: udid, generation: snapshot.generation, revision: snapshot.revision) else { return }
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
        latest.removeValue(forKey: udid)
        guard let stop = stops.removeValue(forKey: udid) else { return }
        await stop()
    }

    func stopAll() async {
        let all = stops
        stops.removeAll()
        latest.removeAll()
        for stop in all.values { await stop() }
    }
}
