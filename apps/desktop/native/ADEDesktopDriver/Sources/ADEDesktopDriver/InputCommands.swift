/// The `input` op: the accessibility commands, the real-event commands, the
/// wait, and the element resolver they share.
///
/// Split out of `main.swift` so the dispatcher there reads as a table of ops
/// rather than as a table of ops with one of them inlined at four hundred
/// lines. Nothing here changed shape in the move.

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ADEDesktopDriverCore

extension DriverRuntime {

    func input(_ request: DriverRequest) throws -> [String: JSONValue] {
        let laneId = try request.requireString("laneId")
        let command = try request.requireString("command")
        let mode = request.string("mode") ?? "accessibility"
        let payload = request.object("payload") ?? [:]
        touch(laneId)

        // `wait` is not an action, so it is not routed by mode: a real-input
        // lease buys the right to post events, not a different way to look.
        if command == "wait" {
            return try waitFor(laneId: laneId, payload: payload)
        }
        if mode == "real" {
            return try realCommand(laneId: laneId, command: command, payload: payload, request: request)
        }
        return try accessibilityCommand(laneId: laneId, command: command, payload: payload)
    }

    /// How many elements a wait poll walks. Smaller than the `observe` default
    /// because a wait runs this walk several times a second.
    private static let waitObservationLimit = 200

    /// Polls the lane until the condition holds or the timeout lapses.
    ///
    /// It answers `ok` itself rather than leaving the service to infer success
    /// from an index: a `gone` or `windowTitle` wait succeeds with no element,
    /// so "matched something" and "the wait was satisfied" are two facts.
    private func waitFor(laneId: String, payload: [String: JSONValue]) throws -> [String: JSONValue] {
        // The gate lets `wait` through rather than parking it, but "not parked"
        // is not "safe to run": this call is nested inside the drag's own
        // run-loop pump, so polling here would hold the pressed button for the
        // whole timeout. Refuse, and let the Node client retry against its own
        // deadline once the button is up.
        if let refusal = gestures.waitRefusal() { throw refusal }
        guard let condition = WaitCondition(
            text: payload["text"]?.stringValue,
            gone: payload["gone"]?.stringValue,
            windowTitle: payload["windowTitle"]?.stringValue,
            timeoutMs: payload["timeoutMs"]?.intValue
        ) else {
            throw DriverError(
                code: DriverErrorCode.invalidArgument,
                message: "wait needs one of \"text\", \"gone\", or \"windowTitle\"."
            )
        }
        let deadline = Date().addingTimeInterval(Double(condition.timeoutMs) / 1000)
        var outcome = WaitOutcome.pending
        repeat {
            let parked = windows.listWindows(laneId: laneId)
            var matchedIndex: Int? = nil
            if let needle = condition.elementNeedle {
                let observation = accessibility.observe(
                    windows: parked,
                    limit: Self.waitObservationLimit,
                    windowControl: windows
                )
                matchedIndex = observation.elements.first { $0.matches(text: needle) }?.index
            }
            outcome = condition.outcome(
                matchedIndex: matchedIndex,
                windowTitles: parked.compactMap(\.title)
            )
            if case .met = outcome { break }
            guard let delay = WaitCondition.pollDelaySeconds(now: Date(), deadline: deadline) else { break }
            // Pumped, not slept. Every request this driver handles runs on the
            // main thread, so a two-minute `Thread.sleep` here would hold the
            // health `ping` and every other lane's work behind one lane's wait.
            // Pumping the run loop lets the queued requests, the AX observer
            // sources and the window watcher all run while this lane waits.
            RunLoopPump.wait(until: { false }, timeout: delay)
        } while Date() < deadline
        touch(laneId)
        switch outcome {
        case .pending:
            return ["ok": .bool(false), "resolvedIndex": .null]
        case let .met(index):
            return ["ok": .bool(true), "resolvedIndex": index.map(JSONValue.int) ?? .null]
        }
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
        // The holder the caller claims to be. The service sends
        // `lease: {holderId}` on every real-input request; `RealInput` refuses
        // the call outright when it is absent, so a replayed line stripped of
        // its holder cannot move the pointer.
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
        case "click":
            let target = try point("at")
            try realInput.click(
                laneId: laneId,
                holderId: holderId,
                at: target,
                button: payload["button"]?.stringValue ?? "left",
                count: payload["count"]?.intValue ?? 1
            )
        case "drag":
            let from = try point("from")
            let to = try point("to")
            // The gesture is announced *before* the button goes down and ended
            // in a `defer`, so every exit — success, a lapsed lease, a thrown
            // CGEvent failure — leaves the gate open and drains whatever piled
            // up behind it.
            try gestures.begin(laneId: laneId)
            defer {
                gestures.end()
                scheduleDeferredDrain()
            }
            try realInput.drag(
                laneId: laneId,
                holderId: holderId,
                from: from,
                to: to,
                durationMs: payload["durationMs"]?.intValue ?? 300,
                verify: laneBoundsCheck(laneId: laneId)
            )
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

    /// "Is this point still somewhere this lane is allowed to drag?", re-asked
    /// on every step of a gesture.
    ///
    /// Both halves can change mid-drag: `display.destroy` on another thread's
    /// request clears the placement, and a caller can walk a drag off the edge
    /// of its own display and onto the user's. A point of tolerance keeps a
    /// drag that ends exactly on the boundary from failing on a rounding error.
    private func laneBoundsCheck(laneId: String) -> (CGPoint) -> DriverError? {
        { [weak self] point in
            guard let self else { return nil }
            guard let placement = self.windows.placement(forLane: laneId) else {
                return DriverError(
                    code: DriverErrorCode.noDisplay,
                    message: "Lane \(laneId) no longer has a display to drag on."
                )
            }
            guard placement.frame.insetBy(dx: -1, dy: -1).contains(point) else {
                return DriverError(
                    code: DriverErrorCode.invalidArgument,
                    message: "A drag on lane \(laneId) may not leave that lane's display."
                )
            }
            return nil
        }
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
}
