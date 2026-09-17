/// `ade-desktop-driver`: one NDJSON request per line in, one reply per line out.
///
/// Transport note: the attention notch helper this package's layout mirrors uses
/// a unix socket, because it is a long-lived UI process the app may reconnect
/// to. This helper is the opposite — the runtime owns it, starts it, and dies
/// with it — so stdin/stdout is the right pipe: no socket path to leak, no
/// stale file after a crash, and the process group cleans itself up.
///
/// Three invariants hold for every line:
///
///   * A request carrying an `id` is *always* answered. An unknown op is
///     `ok:false`, never silence and never a crash: a newer Node talking to an
///     older helper is a normal state during an update, and an unsettled promise
///     on the other side is a hang nobody can diagnose.
///   * stdout carries protocol only. Every log line goes to stderr, because one
///     stray `print` would corrupt the stream.
///   * Work happens on the main thread. AppKit, the Accessibility API and the
///     `AXObserver` run-loop sources all require it, so stdin is read on a
///     background thread and every request is hopped to the main queue.

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ADEDesktopDriverCore

let driverVersion = "1.0.0"

final class DriverRuntime {
    private let output = OutputWriter()
    private let ownership = OwnershipRegistry()
    private let handles = HandleRegistry()
    private let leases = InputLeaseStore()

    private lazy var displays = VirtualDisplayHost(log: log)
    private lazy var windows = WindowControl(ownership: ownership, log: log, emit: emit)
    private lazy var accessibility = AccessibilityDriver(handles: handles, log: log)
    private lazy var capture = CaptureEngine(log: log, emit: emit)
    private lazy var realInput = RealInput(leases: leases, log: log)
    private let cursor = CursorOverlay()

    private var lastActivity: [String: Date] = [:]
    private var recordingCaptions: [String: String] = [:]

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    func run() {
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        startReading()
        log("ade-desktop-driver \(driverVersion) ready (pid \(getpid()))")
        application.run()
    }

    private func startReading() {
        let thread = Thread { [weak self] in
            let handle = FileHandle.standardInput
            var buffer = Data()
            while true {
                let chunk = handle.availableData
                if chunk.isEmpty {
                    DispatchQueue.main.async { self?.shutdown(reason: "stdin closed") }
                    return
                }
                buffer.append(chunk)
                while let newline = buffer.firstIndex(of: 0x0A) {
                    let lineData = buffer.subdata(in: buffer.startIndex..<newline)
                    buffer.removeSubrange(buffer.startIndex...newline)
                    guard let line = String(data: lineData, encoding: .utf8) else { continue }
                    let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !trimmed.isEmpty else { continue }
                    DispatchQueue.main.async { self?.accept(line: trimmed) }
                }
            }
        }
        thread.name = "ade-desktop-driver.stdin"
        thread.start()
    }

    private func shutdown(reason: String) {
        log("shutting down: \(reason)")
        capture.dispose()
        windows.dispose()
        cursor.dispose()
        displays.destroyAll()
        exit(0)
    }

    // -----------------------------------------------------------------------
    // Dispatch
    // -----------------------------------------------------------------------

    private func accept(line: String) {
        let input: DriverInput
        do {
            input = try DriverInputDecoder.decode(line: line)
        } catch {
            output.write(.event(DriverEvent.protocolError("\(error)")))
            return
        }
        guard case .request(let request) = input else { return }
        do {
            let result = try handle(request)
            output.write(.reply(.success(id: request.id, result: result)))
        } catch let error as DriverError {
            output.write(.reply(.failure(id: request.id, error: error)))
        } catch let error as CaptureError {
            output.write(.reply(.failure(id: request.id, error: Self.driverError(for: error))))
        } catch {
            output.write(
                .reply(
                    .failure(
                        id: request.id,
                        code: DriverErrorCode.internalError,
                        message: "\(error)"
                    )
                )
            )
        }
    }

    private static func driverError(for error: CaptureError) -> DriverError {
        switch error {
        case .noSurface(let message):
            return DriverError(code: DriverErrorCode.displayUnavailable, message: message)
        case .failed(let message):
            return DriverError(code: DriverErrorCode.internalError, message: message)
        }
    }

    private func handle(_ request: DriverRequest) throws -> [String: JSONValue] {
        guard let op = request.knownOp else {
            throw DriverError(
                code: DriverErrorCode.unknownOp,
                message: "This ade-desktop-driver build does not implement \"\(request.op)\"."
            )
        }
        switch op {
        case .health: return health()
        case .probePermissions: return Permissions.snapshot()
        case .requestPermissions: return Permissions.request(which: request.string("which") ?? "all")
        case .createDisplay: return try createDisplay(request)
        case .destroyDisplay: return try destroyDisplay(request)
        case .listDisplays: return listDisplays()
        case .reconcileDisplays: return reconcileDisplays(request)
        case .listWindows: return listWindows(request)
        case .parkWindow: return try parkWindow(request)
        case .unparkWindow: return try unparkWindow(request)
        case .launch: return try launch(request)
        case .present: return try present(request)
        case .observe: return try observe(request)
        case .input: return try input(request)
        case .setLease: return try setLease(request)
        case .clearLease: return clearLease(request)
        case .screenshot: return try screenshot(request)
        case .startStream: return try startStream(request)
        case .setStreamRate: return try setStreamRate(request)
        case .stopStream: return try stopStream(request)
        case .lastFrame: return try lastFrame(request)
        case .startRecording: return try startRecording(request)
        case .stopRecording: return try stopRecording(request)
        case .setCursorOverlay: return setCursorOverlay(request)
        case .idleSeconds: return ["seconds": .double(PhysicalInput.secondsSinceLastEvent())]
        case .quit:
            DispatchQueue.main.async { [weak self] in self?.shutdown(reason: "quit op") }
            return ["stopping": .bool(true)]
        }
    }

    // -----------------------------------------------------------------------
    // Health and permissions
    // -----------------------------------------------------------------------

    private func health() -> [String: JSONValue] {
        [
            "version": .string(driverVersion),
            "pid": .int(Int(getpid())),
            "permissions": .object(Permissions.snapshot()),
            "displayMode": .string(displays.displayMode),
            "virtualDisplay": .object([
                "available": .bool(displays.isVirtualDisplayAvailable),
                "reason": displays.unavailableReason.map(JSONValue.string) ?? .null,
            ]),
            "axWindowBridge": .bool(AXWindowBridge.isAvailable),
            "idleSeconds": .double(PhysicalInput.secondsSinceLastEvent()),
        ]
    }

    // -----------------------------------------------------------------------
    // Displays
    // -----------------------------------------------------------------------

    private func createDisplay(_ request: DriverRequest) throws -> [String: JSONValue] {
        let laneId = try request.requireString("laneId")
        let name = request.string("name") ?? "\(VirtualDisplayIdentity.namePrefix)\(laneId)"
        let width = request.int("width") ?? 2560
        let height = request.int("height") ?? 1440
        let scale = request.int("scale") ?? 2
        let handle = displays.create(laneId: laneId, name: name, width: width, height: height, scale: scale)
        windows.setPlacement(laneId: laneId, placement: handle.placement, displayId: handle.displayId)
        touch(laneId)
        let json = handle.asJSON(
            windowCount: ownership.windows(forLane: laneId).count,
            lastActivityAt: lastActivity[laneId] ?? Date()
        )
        emit(DriverEvent(event: "display-created", fields: ["display": .object(json)]))
        return json
    }

    private func destroyDisplay(_ request: DriverRequest) throws -> [String: JSONValue] {
        let laneId = try request.requireString("laneId")
        capture.stopStream(laneId: laneId)
        _ = try? capture.stopRecording(laneId: laneId)
        let released = windows.releaseLane(laneId)
        let destroyed = displays.destroy(laneId: laneId)
        lastActivity.removeValue(forKey: laneId)
        emit(
            DriverEvent(
                event: "display-destroyed",
                fields: ["laneId": .string(laneId), "reason": .string(request.string("reason") ?? "stopped")]
            )
        )
        return ["destroyed": .bool(destroyed), "releasedWindows": .int(released)]
    }

    private func listDisplays() -> [String: JSONValue] {
        let list = displays.all().map { handle in
            JSONValue.object(
                handle.asJSON(
                    windowCount: ownership.windows(forLane: handle.laneId).count,
                    lastActivityAt: lastActivity[handle.laneId] ?? handle.createdAt
                )
            )
        }
        return ["displays": .array(list)]
    }

    private func reconcileDisplays(_ request: DriverRequest) -> [String: JSONValue] {
        let live = Set(request.stringArray("liveLaneIds") ?? [])
        var destroyed: [String] = []
        for laneId in displays.reconcile(liveLaneIds: live) {
            capture.stopStream(laneId: laneId)
            _ = windows.releaseLane(laneId)
            destroyed.append(laneId)
        }
        return ["destroyed": .array(destroyed.map(JSONValue.string))]
    }

    // -----------------------------------------------------------------------
    // Windows
    // -----------------------------------------------------------------------

    private func listWindows(_ request: DriverRequest) -> [String: JSONValue] {
        let laneId = request.string("laneId")
        let pid = request.int("pid").map { pid_t($0) }
        let list = windows.listWindows(laneId: laneId, pid: pid)
        return ["windows": .array(list.map { .object($0.asJSON()) })]
    }

    private func parkWindow(_ request: DriverRequest) throws -> [String: JSONValue] {
        let laneId = try request.requireString("laneId")
        let windowId = CGWindowID(try request.requireInt("windowId"))
        let parked = try windows.park(
            laneId: laneId,
            windowId: windowId,
            origin: request.string("origin") ?? "claimed"
        )
        touch(laneId)
        return parked.asJSON()
    }

    private func unparkWindow(_ request: DriverRequest) throws -> [String: JSONValue] {
        let windowId = CGWindowID(try request.requireInt("windowId"))
        guard let window = windows.unpark(windowId: windowId) else {
            return ["window": .null]
        }
        return ["window": .object(window.asJSON())]
    }

    private func launch(_ request: DriverRequest) throws -> [String: JSONValue] {
        let laneId = try request.requireString("laneId")
        let target = try request.requireString("target")
        let result = try windows.launch(
            laneId: laneId,
            target: target,
            arguments: request.stringArray("args") ?? []
        )
        touch(laneId)
        return [
            "laneId": .string(laneId),
            "pid": result.pid.map { JSONValue.int(Int($0)) } ?? .null,
            "appName": result.appName.map(JSONValue.string) ?? .null,
            "bundleId": result.bundleId.map(JSONValue.string) ?? .null,
            "windows": .array(result.windows.map { .object($0.asJSON()) }),
            "watching": .bool(result.watching),
        ]
    }

    private func present(_ request: DriverRequest) throws -> [String: JSONValue] {
        let laneId = try request.requireString("laneId")
        let destination = request.string("destination") ?? "main"
        let moved = windows.present(laneId: laneId, destination: destination)
        touch(laneId)
        return ["moved": .int(moved)]
    }

    // -----------------------------------------------------------------------
    // Observation
    // -----------------------------------------------------------------------

    private func observe(_ request: DriverRequest) throws -> [String: JSONValue] {
        let laneId = try request.requireString("laneId")
        guard let handle = displays.handle(forLane: laneId) else {
            throw DriverError(
                code: DriverErrorCode.noDisplay,
                message: "Lane \(laneId) has no display. Start one before observing it."
            )
        }
        let limit = max(1, min(2_000, request.int("limit") ?? 200))
        let requestedWindowId = request.int("windowId").map { CGWindowID($0) }
        var parked = windows.listWindows(laneId: laneId)
        if let requestedWindowId {
            parked = parked.filter { $0.id == requestedWindowId }
            guard !parked.isEmpty else {
                throw DriverError(
                    code: DriverErrorCode.windowNotFound,
                    message: "Window \(requestedWindowId) is not parked on lane \(laneId)."
                )
            }
        }

        let capturedAt = Date()
        let screenshotPath = request.string("screenshotPath")
            ?? Self.scratchPath(laneId: laneId, suffix: "observe", extension: "png")
        var size = (width: 0, height: 0)
        var captureFailure: String?
        do {
            size = try capture.screenshot(
                laneId: laneId,
                displayId: handle.displayId,
                windowId: requestedWindowId ?? (handle.displayId == 0 ? parked.first?.id : nil),
                path: screenshotPath
            )
        } catch {
            // An observation without a frame is still worth returning: the
            // element tree is the half an agent acts on, and a missing Screen
            // Recording grant must not make the whole feature unusable.
            captureFailure = "\(error)"
            log("observe on lane \(laneId) captured no frame: \(error)")
        }

        let observation = accessibility.observe(windows: parked, limit: limit, windowControl: windows)

        var mapPath: JSONValue = .null
        if request.bool("map") == true, captureFailure == nil {
            let path = request.string("mapPath")
                ?? Self.scratchPath(laneId: laneId, suffix: "map", extension: "png")
            do {
                try capture.writeElementMap(
                    laneId: laneId,
                    screenshotPath: screenshotPath,
                    mapPath: path,
                    display: handle.placement,
                    elements: observation.elements
                )
                mapPath = .string(path)
            } catch {
                log("element map for lane \(laneId) failed: \(error)")
            }
        }

        touch(laneId)
        var result: [String: JSONValue] = [
            "id": .string(observation.id),
            "laneId": .string(laneId),
            "capturedAt": .string(ISO8601.string(capturedAt)),
            "screenshotPath": .string(screenshotPath),
            "mapPath": mapPath,
            "display": .object([
                "width": .int(size.width > 0 ? size.width : Int(handle.placement.width)),
                "height": .int(size.height > 0 ? size.height : Int(handle.placement.height)),
                "scale": .double(Double(handle.placement.scale)),
            ]),
            "windows": .array(parked.map { .object($0.asJSON()) }),
            "elements": .array(observation.elements.map { .object($0.asJSON()) }),
            "elementCount": .int(observation.elementCount),
            "truncated": .bool(observation.truncated),
            "caption": request.string("caption").map(JSONValue.string) ?? .null,
        ]
        if let captureFailure {
            result["captureError"] = .string(captureFailure)
        }
        return result
    }

    // -----------------------------------------------------------------------
    // Input
    // -----------------------------------------------------------------------

    private func input(_ request: DriverRequest) throws -> [String: JSONValue] {
        let laneId = try request.requireString("laneId")
        let command = try request.requireString("command")
        let mode = request.string("mode") ?? "accessibility"
        let payload = request.object("payload") ?? [:]
        touch(laneId)

        if mode == "real" {
            return try realCommand(laneId: laneId, command: command, payload: payload, request: request)
        }
        return try accessibilityCommand(laneId: laneId, command: command, payload: payload)
    }

    private func accessibilityCommand(
        laneId: String,
        command: String,
        payload: [String: JSONValue]
    ) throws -> [String: JSONValue] {
        switch command {
        case "click":
            let (element, record) = try resolve(payload: payload)
            try accessibility.click(element, record: record)
            cursor.show(at: CGPoint(x: record.frame.midX, y: record.frame.midY))
            return ["resolvedIndex": .int(record.index)]
        case "type":
            let text = payload["text"]?.stringValue ?? ""
            let (element, record) = try resolve(payload: payload)
            try accessibility.type(
                element,
                record: record,
                text: text,
                clear: payload["clear"]?.boolValue ?? false
            )
            cursor.show(at: CGPoint(x: record.frame.midX, y: record.frame.midY))
            return ["resolvedIndex": .int(record.index)]
        case "setValue":
            let (element, record) = try resolve(payload: payload)
            guard accessibility.setValue(element, to: payload["value"]?.stringValue ?? "") else {
                throw DriverError(
                    code: DriverErrorCode.invalidArgument,
                    message: "\(record.role) refused a value."
                )
            }
            return ["resolvedIndex": .int(record.index)]
        case "press":
            let key = payload["key"]?.stringValue ?? ""
            let modifiers = payload["modifiers"]?.arrayValue?.compactMap(\.stringValue) ?? []
            let pid: pid_t
            var resolvedIndex: JSONValue = .null
            if let resolved = try? resolve(payload: payload) {
                pid = resolved.1.pid
                resolvedIndex = .int(resolved.1.index)
            } else if let first = windows.listWindows(laneId: laneId).first {
                pid = first.pid
            } else {
                throw DriverError(
                    code: DriverErrorCode.noDisplay,
                    message: "Lane \(laneId) has no window to send a key to."
                )
            }
            try accessibility.press(pid: pid, key: key, modifiers: modifiers)
            return ["resolvedIndex": resolvedIndex]
        case "scroll":
            let (element, record) = try resolve(payload: payload)
            try accessibility.scroll(
                element,
                record: record,
                direction: payload["direction"]?.stringValue ?? "down",
                amount: payload["amount"]?.intValue ?? 3
            )
            return ["resolvedIndex": .int(record.index)]
        case "drag":
            throw DriverError(
                code: DriverErrorCode.inputLeaseRequired,
                message: "A drag has no accessibility equivalent; it needs mode \"real\" and an input lease."
            )
        default:
            throw DriverError(
                code: DriverErrorCode.invalidArgument,
                message: "\"\(command)\" is not an input command this driver knows."
            )
        }
    }

    private func realCommand(
        laneId: String,
        command: String,
        payload: [String: JSONValue],
        request: DriverRequest
    ) throws -> [String: JSONValue] {
        // The holder the caller claims to be, if it says. `RealInput` checks it
        // against the lease the driver itself holds.
        let holderId = request.object("lease")?["holderId"]?.stringValue
        var resolvedIndex: JSONValue = .null
        func point(_ key: String) throws -> CGPoint {
            if let object = payload[key]?.objectValue,
               let x = object["x"]?.doubleValue,
               let y = object["y"]?.doubleValue {
                return CGPoint(x: x, y: y)
            }
            if let x = payload["x"]?.doubleValue, let y = payload["y"]?.doubleValue {
                return CGPoint(x: x, y: y)
            }
            let (_, record) = try resolve(payload: payload)
            resolvedIndex = .int(record.index)
            return CGPoint(x: record.frame.midX, y: record.frame.midY)
        }

        switch command {
        case "move":
            let target = try point("to")
            try realInput.move(laneId: laneId, holderId: holderId, to: target)
            cursor.show(at: target)
        case "click":
            let target = try point("at")
            try realInput.click(
                laneId: laneId,
                holderId: holderId,
                at: target,
                button: payload["button"]?.stringValue ?? "left",
                count: payload["count"]?.intValue ?? 1
            )
            cursor.show(at: target)
        case "drag":
            let from = try point("from")
            let to = try point("to")
            try realInput.drag(
                laneId: laneId,
                holderId: holderId,
                from: from,
                to: to,
                durationMs: payload["durationMs"]?.intValue ?? 300
            )
            cursor.show(at: to)
        case "press":
            try realInput.key(
                laneId: laneId,
                holderId: holderId,
                key: payload["key"]?.stringValue ?? "",
                modifiers: payload["modifiers"]?.arrayValue?.compactMap(\.stringValue) ?? []
            )
        case "type":
            try realInput.text(laneId: laneId, holderId: holderId, text: payload["text"]?.stringValue ?? "")
        default:
            throw DriverError(
                code: DriverErrorCode.invalidArgument,
                message: "\"\(command)\" is not a real-input command this driver knows."
            )
        }
        return ["resolvedIndex": resolvedIndex]
    }

    private func resolve(payload: [String: JSONValue]) throws -> (AXUIElement, ObservedElement) {
        if let handle = payload["handle"]?.stringValue, !handle.isEmpty {
            return try accessibility.element(forHandle: handle)
        }
        if let text = payload["text"]?.stringValue, !text.isEmpty,
           let match = try? accessibility.element(matchingText: text) {
            return match
        }
        if let target = payload["target"]?.objectValue {
            return try resolve(payload: target)
        }
        throw DriverError(
            code: DriverErrorCode.invalidArgument,
            message: "This command needs a handle or a text match. Observe first."
        )
    }

    // -----------------------------------------------------------------------
    // Lease
    // -----------------------------------------------------------------------

    private func setLease(_ request: DriverRequest) throws -> [String: JSONValue] {
        let laneId = try request.requireString("laneId")
        let holderId = try request.requireString("holderId")
        guard let expiresAtMs = InputLeaseStore.expiryMilliseconds(request.fields["expiresAt"]) else {
            throw DriverError(
                code: DriverErrorCode.invalidArgument,
                message: "lease.set needs an \"expiresAt\" as epoch milliseconds or an ISO-8601 string."
            )
        }
        leases.set(InputLease(laneId: laneId, holderId: holderId, expiresAtMs: expiresAtMs))
        return [
            "laneId": .string(laneId),
            "holderId": .string(holderId),
            "expiresAt": .double(expiresAtMs),
        ]
    }

    private func clearLease(_ request: DriverRequest) -> [String: JSONValue] {
        guard let laneId = request.string("laneId") else {
            return ["cleared": .bool(false)]
        }
        return ["cleared": .bool(leases.clear(laneId: laneId) != nil)]
    }

    // -----------------------------------------------------------------------
    // Capture
    // -----------------------------------------------------------------------

    private func screenshot(_ request: DriverRequest) throws -> [String: JSONValue] {
        let laneId = try request.requireString("laneId")
        guard let handle = displays.handle(forLane: laneId) else {
            throw DriverError(
                code: DriverErrorCode.noDisplay,
                message: "Lane \(laneId) has no display."
            )
        }
        let path = request.string("path")
            ?? Self.scratchPath(laneId: laneId, suffix: "shot", extension: "png")
        let windowId = request.int("windowId").map { CGWindowID($0) }
            ?? (handle.displayId == 0 ? windows.listWindows(laneId: laneId).first?.id : nil)
        let size = try capture.screenshot(
            laneId: laneId,
            displayId: handle.displayId,
            windowId: windowId,
            path: path
        )
        touch(laneId)
        return [
            "laneId": .string(laneId),
            "filePath": .string(path),
            "width": .int(size.width),
            "height": .int(size.height),
            "capturedAt": .string(ISO8601.string(Date())),
        ]
    }

    private func startStream(_ request: DriverRequest) throws -> [String: JSONValue] {
        let laneId = try request.requireString("laneId")
        guard let handle = displays.handle(forLane: laneId) else {
            throw DriverError(code: DriverErrorCode.noDisplay, message: "Lane \(laneId) has no display.")
        }
        let fps = max(1, min(60, request.int("fps") ?? 30))
        let started = try capture.startStream(laneId: laneId, displayId: handle.displayId, fps: fps)
        touch(laneId)
        let result: [String: JSONValue] = [
            "laneId": .string(laneId),
            "port": .int(Int(started.port)),
            "url": .null,
            "token": .null,
            "codec": started.codec.map(JSONValue.string) ?? .null,
            "width": .int(started.width),
            "height": .int(started.height),
            "fps": .int(fps),
        ]
        emit(DriverEvent(event: "stream-started", fields: result))
        return result
    }

    private func setStreamRate(_ request: DriverRequest) throws -> [String: JSONValue] {
        let laneId = try request.requireString("laneId")
        let fps = max(1, min(60, try request.requireInt("fps")))
        try capture.setStreamRate(laneId: laneId, fps: fps)
        return ["fps": .int(fps)]
    }

    private func stopStream(_ request: DriverRequest) throws -> [String: JSONValue] {
        let laneId = try request.requireString("laneId")
        let stopped = capture.stopStream(laneId: laneId)
        emit(DriverEvent(event: "stream-stopped", fields: ["laneId": .string(laneId)]))
        return ["stopped": .bool(stopped)]
    }

    private func lastFrame(_ request: DriverRequest) throws -> [String: JSONValue] {
        let laneId = try request.requireString("laneId")
        let path = request.string("path")
            ?? Self.scratchPath(laneId: laneId, suffix: "frame", extension: "png")
        let size = try capture.writeLastFrame(laneId: laneId, path: path)
        return [
            "filePath": .string(path),
            "width": .int(size.width),
            "height": .int(size.height),
            "capturedAt": .string(ISO8601.string(Date())),
        ]
    }

    private func startRecording(_ request: DriverRequest) throws -> [String: JSONValue] {
        let laneId = try request.requireString("laneId")
        guard let handle = displays.handle(forLane: laneId) else {
            throw DriverError(code: DriverErrorCode.noDisplay, message: "Lane \(laneId) has no display.")
        }
        let fps = max(1, min(60, request.int("fps") ?? 30))
        let filePath = request.string("filePath")
            ?? Self.scratchPath(laneId: laneId, suffix: "recording", extension: "mp4")
        let startedAt = try capture.startRecording(
            laneId: laneId,
            displayId: handle.displayId,
            fps: fps,
            filePath: filePath
        )
        if let caption = request.string("caption") {
            recordingCaptions[laneId] = caption
        }
        touch(laneId)
        let result: [String: JSONValue] = [
            "laneId": .string(laneId),
            "running": .bool(true),
            "startedAt": .string(ISO8601.string(startedAt)),
            "filePath": .string(filePath),
            "caption": recordingCaptions[laneId].map(JSONValue.string) ?? .null,
        ]
        emit(DriverEvent(event: "recording-changed", fields: result))
        return result
    }

    private func stopRecording(_ request: DriverRequest) throws -> [String: JSONValue] {
        let laneId = try request.requireString("laneId")
        let finished = try capture.stopRecording(laneId: laneId)
        let caption = recordingCaptions.removeValue(forKey: laneId)
        let result: [String: JSONValue] = [
            "laneId": .string(laneId),
            "running": .bool(false),
            "filePath": .string(finished.filePath),
            "durationMs": .int(finished.durationMs),
            "caption": caption.map(JSONValue.string) ?? .null,
        ]
        emit(DriverEvent(event: "recording-changed", fields: result))
        return result
    }

    private func setCursorOverlay(_ request: DriverRequest) -> [String: JSONValue] {
        let visible = request.bool("visible") ?? true
        if visible, let x = request.double("x"), let y = request.double("y") {
            cursor.show(at: CGPoint(x: x, y: y))
        } else if !visible {
            cursor.hide()
        }
        return ["visible": .bool(cursor.isVisible)]
    }

    // -----------------------------------------------------------------------
    // Plumbing
    // -----------------------------------------------------------------------

    private func touch(_ laneId: String) {
        lastActivity[laneId] = Date()
    }

    private static func scratchPath(laneId: String, suffix: String, extension pathExtension: String) -> String {
        let safeLane = laneId.replacingOccurrences(of: "/", with: "-")
        let directory = NSTemporaryDirectory() + "ade-desktop-driver"
        try? FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        let stamp = Int(Date().timeIntervalSince1970 * 1000)
        return "\(directory)/\(safeLane)-\(suffix)-\(stamp).\(pathExtension)"
    }

    private func emit(_ event: DriverEvent) {
        output.write(.event(event))
    }

    private func log(_ message: String) {
        FileHandle.standardError.write(Data("[ade-desktop-driver] \(message)\n".utf8))
    }
}

/// stdout, one JSON line at a time.
///
/// Serialised because events are emitted from timers and stream callbacks while
/// a reply may be on its way out; two interleaved writes would produce one
/// unparseable line and take the whole session down with it.
final class OutputWriter {
    private let lock = NSLock()
    private let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        return encoder
    }()

    func write(_ output: DriverOutput) {
        guard let data = try? encoder.encode(output) else { return }
        lock.lock()
        defer { lock.unlock() }
        var line = data
        line.append(0x0A)
        FileHandle.standardOutput.write(line)
    }
}

// Held in a top-level binding, not `DriverRuntime().run()`: a temporary would
// let ARC consider the runtime dead at the end of that statement, and every
// `[weak self]` capture inside the timers and stream callbacks would read nil.
let runtime = DriverRuntime()
runtime.run()
