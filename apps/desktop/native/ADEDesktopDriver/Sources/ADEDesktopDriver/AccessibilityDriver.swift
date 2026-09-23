/// The accessibility tree, and everything an agent can do without touching the
/// user's pointer.
///
/// This is the default input path for the whole feature, and the reason a lane
/// can drive an app while the person at the Mac keeps typing somewhere else:
/// `AXUIElementPerformAction` and `AXUIElementSetAttributeValue` act on one
/// element inside one process. They move no pointer, steal no focus, and need
/// no lease.
///
/// Keyboard is the one place that needed a judgement call. Some elements — a
/// canvas, a terminal view, an Electron text area — expose no settable
/// `AXValue`, so "type" has nothing to set. Those fall back to `CGEvent`
/// keyboard events posted with `CGEventPostToPid`, which is *process-targeted*:
/// the event is delivered to that application's event queue and never enters
/// the window server's global stream. That is why it is allowed here without an
/// input lease, while everything in `RealInput.swift` is not. The distinction is
/// the whole safety story of this file; do not "simplify" a
/// `CGEventPostToPid` into a `CGEventPost`.
///
/// Frames are reported in global screen points — the same plane
/// `DisplayPlacement.origin` uses — so a point on the stream and a point on an
/// element are the same kind of number.

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ADEDesktopDriverCore

struct ObservedElement {
    var index: Int
    var handle: String
    var role: String
    var subrole: String?
    var title: String?
    var label: String?
    var value: String?
    var identifier: String?
    var help: String?
    var enabled: Bool
    var focused: Bool
    var actions: [String]
    var frame: CGRect
    var windowId: CGWindowID?
    var pid: pid_t
    var parentIndex: Int?

    /// `MacDesktopElement`, field for field.
    func asJSON() -> [String: JSONValue] {
        [
            "index": .int(index),
            "handle": .string(handle),
            "role": .string(role),
            "subrole": subrole.map(JSONValue.string) ?? .null,
            "title": title.map(JSONValue.string) ?? .null,
            "label": label.map(JSONValue.string) ?? .null,
            "value": value.map(JSONValue.string) ?? .null,
            "identifier": identifier.map(JSONValue.string) ?? .null,
            "help": help.map(JSONValue.string) ?? .null,
            "enabled": .bool(enabled),
            "focused": .bool(focused),
            "actions": .array(actions.map(JSONValue.string)),
            "frame": .object([
                "x": .double(Double(frame.origin.x)),
                "y": .double(Double(frame.origin.y)),
                "width": .double(Double(frame.width)),
                "height": .double(Double(frame.height)),
            ]),
            "center": .object([
                "x": .double(Double(frame.midX)),
                "y": .double(Double(frame.midY)),
            ]),
            "windowId": windowId.map { JSONValue.int(Int($0)) } ?? .null,
            "pid": .int(Int(pid)),
            "parentIndex": parentIndex.map(JSONValue.int) ?? .null,
        ]
    }

    /// What `text` targeting matches against.
    func matches(text: String) -> Bool {
        let needle = text.lowercased()
        for candidate in [title, label, value, identifier] {
            if let candidate, candidate.lowercased().contains(needle) { return true }
        }
        return false
    }
}

struct ObservationResult {
    let id: String
    let elements: [ObservedElement]
    let elementCount: Int
    let truncated: Bool
}

final class AccessibilityDriver {
    /// Hard ceiling on the walk, independent of the caller's `limit`.
    ///
    /// The cap on returned elements does not bound the *walk*: a Finder window
    /// with a long list still has thousands of nodes underneath it, and an
    /// unbounded depth-first walk of an Electron app can take minutes. This
    /// bounds the visiting.
    static let maxVisitedNodes = 6_000
    static let maxDepth = 24

    private let handles: HandleRegistry
    private let log: (String) -> Void
    private var elementsByObservation: [String: [AXUIElement]] = [:]
    private var recordsByObservation: [String: [ObservedElement]] = [:]
    private let lock = NSRecursiveLock()
    private var sequence = 0

    init(handles: HandleRegistry, log: @escaping (String) -> Void) {
        self.handles = handles
        self.log = log
    }

    // -----------------------------------------------------------------------
    // Observation
    // -----------------------------------------------------------------------

    /// Walks the tree for one window, or for every window in `windows`.
    func observe(windows: [DesktopWindow], limit: Int, windowControl: WindowControl) -> ObservationResult {
        lock.lock()
        sequence += 1
        let observationId = "\(Int(Date().timeIntervalSince1970 * 1000))-\(sequence)"
        lock.unlock()

        var records: [ObservedElement] = []
        var elements: [AXUIElement] = []
        var visited = 0
        var total = 0

        for window in windows {
            guard let root = windowControl.axWindow(for: window) else { continue }
            var queue: [(element: AXUIElement, parentIndex: Int?, depth: Int)] = [(root, nil, 0)]
            while !queue.isEmpty {
                let node = queue.removeFirst()
                visited += 1
                if visited > Self.maxVisitedNodes { break }
                guard let record = describe(
                    node.element,
                    index: records.count,
                    parentIndex: node.parentIndex,
                    observationId: observationId,
                    window: window
                ) else { continue }
                total += 1
                let ownIndex = records.count
                if records.count < limit {
                    records.append(record)
                    elements.append(node.element)
                }
                guard node.depth < Self.maxDepth else { continue }
                for child in Self.children(of: node.element) {
                    queue.append((child, records.count <= limit ? ownIndex : nil, node.depth + 1))
                }
            }
        }

        lock.lock()
        elementsByObservation[observationId] = elements
        recordsByObservation[observationId] = records
        for dropped in handles.record(observationId: observationId, elementCount: records.count) {
            elementsByObservation.removeValue(forKey: dropped)
            recordsByObservation.removeValue(forKey: dropped)
        }
        lock.unlock()

        return ObservationResult(
            id: observationId,
            elements: records,
            elementCount: total,
            truncated: total > records.count
        )
    }

    func records(forObservation observationId: String) -> [ObservedElement] {
        lock.lock()
        defer { lock.unlock() }
        return recordsByObservation[observationId] ?? []
    }

    var newestObservationId: String? { handles.newestObservationId }

    /// Resolves a handle to the element it was minted for, refusing a stale one.
    func element(forHandle handle: String) throws -> (element: AXUIElement, record: ObservedElement) {
        let resolved: ResolvedHandle
        do {
            resolved = try handles.resolve(handle)
        } catch let error as HandleError {
            throw error.driverError
        }
        lock.lock()
        defer { lock.unlock() }
        guard let elements = elementsByObservation[resolved.observationId],
              let records = recordsByObservation[resolved.observationId],
              resolved.index < elements.count,
              resolved.index < records.count
        else {
            throw HandleError.expired(handle).driverError
        }
        return (elements[resolved.index], records[resolved.index])
    }

    /// Case-insensitive match over the newest observation.
    func element(matchingText text: String) throws -> (element: AXUIElement, record: ObservedElement) {
        guard let observationId = handles.newestObservationId else {
            throw DriverError(
                code: DriverErrorCode.handleExpired,
                message: "Nothing has been observed yet. Observe before targeting by text."
            )
        }
        lock.lock()
        let elements = elementsByObservation[observationId] ?? []
        let records = recordsByObservation[observationId] ?? []
        lock.unlock()
        for (offset, record) in records.enumerated() where record.matches(text: text) {
            guard offset < elements.count else { continue }
            return (elements[offset], record)
        }
        throw DriverError(
            code: DriverErrorCode.windowNotFound,
            message: "No element matching \"\(text)\" in the latest observation."
        )
    }

    /// The element the newest observation saw holding keyboard focus: where
    /// `type` with no target goes, as a person's typing would.
    func focusedElementInNewestObservation() throws -> (element: AXUIElement, record: ObservedElement) {
        guard let observationId = handles.newestObservationId else {
            throw DriverError(
                code: DriverErrorCode.handleExpired,
                message: "Nothing has been observed yet. Observe first, or name a target."
            )
        }
        lock.lock()
        let elements = elementsByObservation[observationId] ?? []
        let records = recordsByObservation[observationId] ?? []
        lock.unlock()
        for (offset, record) in records.enumerated() where record.focused {
            guard offset < elements.count else { continue }
            return (elements[offset], record)
        }
        throw DriverError(
            code: DriverErrorCode.invalidArgument,
            message: "Nothing has keyboard focus in the latest observation. Name a target: a handle from observe, or --target \"<label>\"."
        )
    }

    private static func children(of element: AXUIElement) -> [AXUIElement] {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value) == .success,
              let children = value as? [AXUIElement]
        else { return [] }
        return children
    }

    private func describe(
        _ element: AXUIElement,
        index: Int,
        parentIndex: Int?,
        observationId: String,
        window: DesktopWindow
    ) -> ObservedElement? {
        guard let role = WindowControl.stringAttribute(element, kAXRoleAttribute) else { return nil }
        var actionNames: CFArray?
        var actions: [String] = []
        if AXUIElementCopyActionNames(element, &actionNames) == .success,
           let list = actionNames as? [String] {
            actions = list
        }
        var pid: pid_t = window.pid
        AXUIElementGetPid(element, &pid)
        return ObservedElement(
            index: index,
            handle: HandleRegistry.handle(observationId: observationId, index: index),
            role: role,
            subrole: WindowControl.stringAttribute(element, kAXSubroleAttribute),
            title: WindowControl.stringAttribute(element, kAXTitleAttribute),
            label: WindowControl.stringAttribute(element, kAXDescriptionAttribute),
            value: Self.stringValue(of: element),
            identifier: WindowControl.stringAttribute(element, kAXIdentifierAttribute),
            help: WindowControl.stringAttribute(element, kAXHelpAttribute),
            enabled: Self.boolAttribute(element, kAXEnabledAttribute) ?? true,
            focused: Self.boolAttribute(element, kAXFocusedAttribute) ?? false,
            actions: actions,
            frame: WindowControl.frame(of: element) ?? .zero,
            windowId: window.id,
            pid: pid,
            parentIndex: parentIndex
        )
    }

    static func stringValue(of element: AXUIElement) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &value) == .success,
              let value
        else { return nil }
        if let text = value as? String { return text }
        if let number = value as? NSNumber { return number.stringValue }
        return nil
    }

    static func boolAttribute(_ element: AXUIElement, _ attribute: String) -> Bool? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
        return (value as? NSNumber)?.boolValue
    }

    // -----------------------------------------------------------------------
    // Actions
    // -----------------------------------------------------------------------

    /// A press, with a per-role fallback.
    ///
    /// Not every clickable thing answers `AXPress`: a menu bar item wants
    /// `AXShowMenu`, and a sheet's default button sometimes only answers
    /// `AXConfirm`. Trying the element's own action list beats guessing.
    func click(_ element: AXUIElement, record: ObservedElement) throws {
        let preferred: [String]
        switch record.role {
        case kAXMenuBarItemRole, kAXMenuButtonRole, kAXPopUpButtonRole:
            preferred = ["AXPress", "AXShowMenu"]
        case kAXTextFieldRole, kAXTextAreaRole:
            preferred = ["AXPress", "AXConfirm"]
        default:
            preferred = ["AXPress", "AXConfirm", "AXShowMenu", "AXOpen"]
        }
        for action in preferred where record.actions.contains(action) {
            if AXUIElementPerformAction(element, action as CFString) == .success { return }
        }
        // Last resort: whatever the element says it can do, in its own order.
        for action in record.actions where action != "AXShowAlternateUI" && action != "AXShowDefaultUI" {
            if AXUIElementPerformAction(element, action as CFString) == .success { return }
        }
        throw DriverError(
            code: DriverErrorCode.invalidArgument,
            message: "\(record.role) \"\(record.title ?? record.label ?? "untitled")\" answered no press action."
        )
    }

    func setValue(_ element: AXUIElement, to text: String) -> Bool {
        AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, text as CFTypeRef) == .success
    }

    /// `type`, in the order that disturbs the least.
    ///
    /// Setting `AXValue` is instantaneous and invisible to the rest of the
    /// machine. Only when the element has no settable value does this reach for
    /// process-targeted key events.
    func type(
        _ element: AXUIElement,
        record: ObservedElement,
        text: String,
        clear: Bool
    ) throws {
        _ = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        var isSettable: DarwinBoolean = false
        AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &isSettable)
        if isSettable.boolValue {
            let existing = clear ? "" : (Self.stringValue(of: element) ?? "")
            if setValue(element, to: existing + text) { return }
        }
        if clear {
            // Select-all then type over it: the only "clear" a value-less
            // element understands.
            try postKey(pid: record.pid, keyCode: KeyCodes.table["a"]!, modifiers: [.maskCommand])
        }
        try postText(pid: record.pid, text: text)
    }

    /// Presses a window's own close button. The way ⌘W reaches a lane window:
    /// a key posted to an app that is not active never runs its menu shortcut.
    func closeWindow(_ window: AXUIElement) -> Bool {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(window, kAXCloseButtonAttribute as CFString, &value) == .success,
              let value, CFGetTypeID(value) == AXUIElementGetTypeID()
        else { return false }
        let button = value as! AXUIElement
        return AXUIElementPerformAction(button, kAXPressAction as CFString) == .success
    }

    /// One key, by name, to one process.
    func press(pid: pid_t, key: String, modifiers: [String]) throws {
        guard let keyCode = KeyCodes.code(for: key) else {
            throw DriverError(
                code: DriverErrorCode.invalidArgument,
                message: "\"\(key)\" is not a key this driver knows. Use a name like return, tab, escape, f5, or a single character."
            )
        }
        try postKey(pid: pid, keyCode: keyCode, modifiers: KeyCodes.flags(for: modifiers))
    }

    /// Scroll, accessibility-first.
    func scroll(
        _ element: AXUIElement,
        record: ObservedElement,
        direction: String,
        amount: Int
    ) throws {
        if record.actions.contains("AXScrollToVisible"),
           AXUIElementPerformAction(element, "AXScrollToVisible" as CFString) == .success,
           direction == "visible" {
            return
        }
        try scrollNearest(from: element, pid: record.pid, direction: direction, amount: amount)
    }

    /// A scroll with no observed target: "scroll whatever this app is showing".
    ///
    /// `ade mac-desktop scroll down` is documented to scroll the display, so a
    /// caller that never observed still has to get a scroll. The app's focused
    /// window stands in for the element, and the wheel fallback below is the
    /// same process-targeted post the element path ends in.
    func scroll(pid: pid_t, direction: String, amount: Int) throws {
        let app = AXUIElementCreateApplication(pid)
        var focused: CFTypeRef?
        let root: AXUIElement =
            AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &focused) == .success
            ? unsafeBitCast(focused, to: AXUIElement.self)
            : app
        try scrollNearest(from: root, pid: pid, direction: direction, amount: amount)
    }

    private func scrollNearest(
        from element: AXUIElement,
        pid: pid_t,
        direction: String,
        amount: Int
    ) throws {
        if let scrollBar = findScrollBar(from: element, direction: direction),
           let current = Self.stringValue(of: scrollBar).flatMap(Double.init) {
            let step = 0.1 * Double(max(1, amount))
            let next = max(0, min(1, direction == "down" || direction == "right" ? current + step : current - step))
            if AXUIElementSetAttributeValue(scrollBar, kAXValueAttribute as CFString, NSNumber(value: next)) == .success {
                return
            }
        }
        // Process-targeted scroll wheel. Same rule as the keyboard fallback:
        // delivered to this pid's event queue, not to the window server.
        let lines = Int32(max(1, amount))
        let (deltaY, deltaX): (Int32, Int32)
        switch direction {
        case "up": (deltaY, deltaX) = (lines, 0)
        case "down": (deltaY, deltaX) = (-lines, 0)
        case "left": (deltaY, deltaX) = (0, lines)
        default: (deltaY, deltaX) = (0, -lines)
        }
        guard let event = CGEvent(
            scrollWheelEvent2Source: nil,
            units: .line,
            wheelCount: 2,
            wheel1: deltaY,
            wheel2: deltaX,
            wheel3: 0
        ) else {
            throw DriverError(code: DriverErrorCode.internalError, message: "Could not build a scroll event.")
        }
        event.postToPid(pid)
    }

    private func findScrollBar(from element: AXUIElement, direction: String) -> AXUIElement? {
        var current: AXUIElement? = element
        var depth = 0
        while let node = current, depth < 8 {
            for child in Self.children(of: node) {
                guard WindowControl.stringAttribute(child, kAXRoleAttribute) == kAXScrollAreaRole else { continue }
                for grandchild in Self.children(of: child)
                where WindowControl.stringAttribute(grandchild, kAXRoleAttribute) == kAXScrollBarRole {
                    let orientation = WindowControl.stringAttribute(grandchild, kAXOrientationAttribute)
                    let wantsVertical = direction == "up" || direction == "down"
                    let isVertical = orientation == (kAXVerticalOrientationValue as String)
                    if wantsVertical == isVertical { return grandchild }
                }
            }
            var parent: CFTypeRef?
            guard AXUIElementCopyAttributeValue(node, kAXParentAttribute as CFString, &parent) == .success else {
                return nil
            }
            // swiftlint:disable:next force_cast
            current = parent.map { ($0 as! AXUIElement) }
            depth += 1
        }
        return nil
    }

    // -----------------------------------------------------------------------
    // Process-targeted keyboard
    // -----------------------------------------------------------------------

    /// Posts a key down/up pair to one process.
    ///
    /// `postToPid`, never `post(tap:)`. See the note at the top of this file:
    /// this is what makes keyboard input safe without the lease, and a change to
    /// a global post here would silently give every accessibility caller the
    /// user's keyboard.
    func postKey(pid: pid_t, keyCode: CGKeyCode, modifiers: CGEventFlags) throws {
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false)
        else {
            throw DriverError(code: DriverErrorCode.internalError, message: "Could not build a key event.")
        }
        down.flags = modifiers
        up.flags = modifiers
        down.postToPid(pid)
        up.postToPid(pid)
    }

    /// Types a string as unicode key events, so layouts and emoji survive.
    func postText(pid: pid_t, text: String) throws {
        for character in text {
            var utf16 = Array(String(character).utf16)
            guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
            else {
                throw DriverError(code: DriverErrorCode.internalError, message: "Could not build a key event.")
            }
            down.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
            up.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
            down.postToPid(pid)
            up.postToPid(pid)
        }
    }
}

/// Key names to virtual key codes.
///
/// ANSI layout codes, which is what `CGEvent(keyboardEventSource:virtualKey:)`
/// wants regardless of the user's layout — the layout is applied downstream.
enum KeyCodes {
    static let table: [String: CGKeyCode] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
        "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
        "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26,
        "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35,
        "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45,
        "m": 46, ".": 47, "`": 50,
        "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51,
        "escape": 53, "esc": 53, "forwarddelete": 117,
        "left": 123, "right": 124, "down": 125, "up": 126,
        "arrowleft": 123, "arrowright": 124, "arrowdown": 125, "arrowup": 126,
        "control": 59, "ctrl": 59, "shift": 56, "command": 55, "cmd": 55, "meta": 55,
        "option": 58, "alt": 58, "capslock": 57,
        "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
        "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
        "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    ]

    static func code(for key: String) -> CGKeyCode? {
        let normalized = key.lowercased().replacingOccurrences(of: "_", with: "")
        if let code = table[normalized] { return code }
        if key.count == 1, let code = table[String(key.lowercased())] { return code }
        return nil
    }

    static func flags(for modifiers: [String]) -> CGEventFlags {
        var flags: CGEventFlags = []
        for modifier in modifiers {
            switch modifier.lowercased() {
            case "cmd", "command", "meta": flags.insert(.maskCommand)
            case "shift": flags.insert(.maskShift)
            case "option", "alt": flags.insert(.maskAlternate)
            case "control", "ctrl": flags.insert(.maskControl)
            default: break
            }
        }
        return flags
    }
}
