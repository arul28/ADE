import Foundation
import AppKit
import ObjectiveC.runtime

/// ADE's additions to the vendored `AccessibilityBridge`
/// (`Vendor/serve-sim/AccessibilityBridge.swift`), kept out of `Vendor/`:
///
/// - which caps cut a describe short (`Description`, `limits`);
/// - placing an iPadOS window's elements on the screen (`placeTree`,
///   `alignToGrabber`, `placeLater`, with `WindowPlacement`);
/// - the one-element reads behind `ax-hit` and `ax-focused`
///   (`describeElement`, `focusedElement`);
/// - which elements also get their value description (`adjustableRoles`).
///
/// The vendored file keeps only the small hooks that call into these, listed
/// in `Vendor/serve-sim/VENDORED.md`.
extension AccessibilityBridge {
    static let maxProbePoints = 600

    /// The tree, and which caps cut the walk short (ADE patch): `elements`
    /// (500 serialized), `depth` (80 levels) or `probe-points` (600 grid
    /// hit-tests). Empty when the walk saw everything it was looking for.
    struct Description {
        let json: Data
        let truncatedBy: [String]
        /// A window could not be placed on the screen (ADE patch, see
        /// `WindowPlacement`), so some frames stayed relative to it.
        let unplaced: Bool
    }

    static let limits: [String: Int] = [
        "elements": maxSerializedElements,
        "depth": maxSerializationDepth,
        "probe-points": maxProbePoints,
    ]

    /// Whether any element is still marked `ADEUnplaced`.
    static func anyUnplaced(_ node: [String: Any]) -> Bool {
        if node["ADEUnplaced"] as? Bool == true { return true }
        return ((node["children"] as? [[String: Any]]) ?? []).contains(where: anyUnplaced)
    }

    private static func frameOf(_ node: [String: Any]) -> CGRect? {
        guard let frame = node["frame"] as? [String: Any],
              let x = frame["x"] as? CGFloat, let y = frame["y"] as? CGFloat,
              let width = frame["width"] as? CGFloat, let height = frame["height"] as? CGFloat else { return nil }
        return CGRect(x: x, y: y, width: width, height: height)
    }

    /// Places each window the walk saw (its elements carry `ADEContext`) and
    /// moves their frames onto the screen; what cannot be placed is marked
    /// `ADEUnplaced` and keeps its window-relative frame.
    static func placeTree(_ root: [String: Any], placement: WindowPlacement) -> [String: Any] {
        var leaves: [UInt32: [CGRect]] = [:]
        var first: [UInt32: CGRect] = [:]
        var order: [UInt32] = []
        func collect(_ node: [String: Any]) {
            let children = (node["children"] as? [[String: Any]]) ?? []
            if let context = (node["ADEContext"] as? Int).map(UInt32.init), let frame = frameOf(node) {
                if first[context] == nil {
                    first[context] = frame
                    order.append(context)
                }
                if children.isEmpty { leaves[context, default: []].append(frame) }
            }
            children.forEach(collect)
        }
        collect(root)
        // A scroll view's rows past the window's edge are in the tree too, but
        // nothing answers there: only leaves inside the window can vote.
        let rootContext = (root["ADEContext"] as? Int).map(UInt32.init)
        let window = frameOf(root)
        for context in order {
            var candidates = leaves[context] ?? []
            if context == rootContext, let window {
                candidates = candidates.filter { window.insetBy(dx: -0.5, dy: -0.5).contains($0) }
            }
            _ = placement.place(context: context, leaves: candidates, any: first[context] ?? .zero, isWindow: context == rootContext)
        }
        func move(_ node: [String: Any]) -> [String: Any] {
            var node = node
            if let context = (node["ADEContext"] as? Int).map(UInt32.init) {
                if let offset = placement.knownOffset(context: context), var frame = node["frame"] as? [String: Any],
                   let x = frame["x"] as? CGFloat, let y = frame["y"] as? CGFloat {
                    frame["x"] = x + offset.x
                    frame["y"] = y + offset.y
                    node["frame"] = frame
                } else {
                    node["ADEUnplaced"] = true
                }
            }
            if let children = node["children"] as? [[String: Any]] {
                node["children"] = children.map(move)
            }
            return node
        }
        return move(root)
    }

    /// The grid's coverage, from frames already on the screen: the same rule
    /// as the walk (a leaf blocks probes, a container does not).
    static func cover(_ node: [String: Any], into coverage: inout AccessibilityCoverage) {
        let children = (node["children"] as? [[String: Any]]) ?? []
        if let frame = frameOf(node) {
            if !children.isEmpty || max(frame.width, frame.height) >= 250 {
                coverage.insertContainer(frame)
            } else {
                coverage.insertLeaf(frame)
            }
        }
        for child in children { cover(child, into: &coverage) }
    }

    /// The window's resize grabber is SpringBoard's, drawn in screen points,
    /// and its centre is the window's corner (its value names which). Where
    /// the app's own grabber is on the screen, the window origin it gives
    /// wins over the hit-test measurement: for a window hanging off the
    /// screen's edge, hit-tests answer in a space shifted from what is drawn
    /// (measured on iPadOS 27), and taps go where things are drawn.
    static func alignToGrabber(_ root: [String: Any], placement: WindowPlacement) -> (root: [String: Any], shift: CGPoint?) {
        guard let rootContext = (root["ADEContext"] as? Int).map(UInt32.init),
              let measured = placement.knownOffset(context: rootContext),
              let window = frameOf(root) else { return (root, nil) }
        let label = (root["AXLabel"] as? String).map { "Resize \($0)" }
        func findGrabber(_ node: [String: Any]) -> [String: Any]? {
            if node["AXUniqueId"] as? String == "resize-grabber",
               label == nil || node["AXLabel"] as? String == nil || node["AXLabel"] as? String == label {
                return node
            }
            for child in (node["children"] as? [[String: Any]]) ?? [] {
                if let found = findGrabber(child) { return found }
            }
            return nil
        }
        guard let grabber = findGrabber(root), let corner = frameOf(grabber) else { return (root, nil) }
        let names = ((grabber["AXValue"] as? String) ?? "").lowercased()
        let originX = names.contains("left") ? corner.midX : corner.midX - window.width
        let originY = names.contains("top") ? corner.midY : corner.midY - window.height
        let dx = ((originX - window.minX) * 2).rounded() / 2
        let dy = ((originY - window.minY) * 2).rounded() / 2
        guard abs(dx) > 2 || abs(dy) > 2 else { return (root, nil) }
        // Every window context placed with the app window's offset moves
        // with it (the keyboard's toolbar is the app window's).
        let corrected = CGPoint(x: measured.x + dx, y: measured.y + dy)
        var moved = Set(placement.contexts(withOffset: measured))
        if let grabberContext = (grabber["ADEContext"] as? Int).map(UInt32.init) { moved.remove(grabberContext) }
        for context in moved { placement.correct(context: context, to: corrected) }
        func shift(_ node: [String: Any]) -> [String: Any] {
            var node = node
            if let context = (node["ADEContext"] as? Int).map(UInt32.init), moved.contains(context),
               node["ADEUnplaced"] as? Bool != true,
               var frame = node["frame"] as? [String: Any],
               let x = frame["x"] as? CGFloat, let y = frame["y"] as? CGFloat {
                frame["x"] = x + dx
                frame["y"] = y + dy
                node["frame"] = frame
            }
            if let children = node["children"] as? [[String: Any]] {
                node["children"] = children.map(shift)
            }
            return node
        }
        return (shift(root), CGPoint(x: dx, y: dy))
    }

    /// Frames written before their window was placed (a container whose
    /// window was measured from a later child): moved now, and the marks
    /// dropped. What stays marked could not be placed at all.
    static func placeLater(_ node: [String: Any], placement: WindowPlacement) -> [String: Any] {
        var node = node
        if node["ADEUnplaced"] as? Bool == true,
           let context = (node["ADEContext"] as? Int).map(UInt32.init),
           let offset = placement.knownOffset(context: context),
           var frame = node["frame"] as? [String: Any],
           let x = frame["x"] as? CGFloat, let y = frame["y"] as? CGFloat {
            frame["x"] = x + offset.x
            frame["y"] = y + offset.y
            node["frame"] = frame
            node.removeValue(forKey: "ADEUnplaced")
        }
        node.removeValue(forKey: "ADEContext")
        if let children = node["children"] as? [[String: Any]] {
            node["children"] = children.map { placeLater($0, placement: placement) }
        }
        return node
    }

    /// The window context an element belongs to (ADE patch): each iPadOS
    /// window is its own, and so is SpringBoard's status bar.
    static func contextId(of element: NSObject) -> UInt32? {
        let selector = NSSelectorFromString("_windowContextId")
        guard element.responds(to: selector), let imp = element.method(for: selector) else { return nil }
        typealias ContextFunc = @convention(c) (AnyObject, Selector) -> UInt32
        return unsafeBitCast(imp, to: ContextFunc.self)(element, selector)
    }

    /// SpringBoard's element (the status bar, window controls, resize
    /// grabbers): its frame is in screen (framebuffer) points, never relative
    /// to a window.
    func isSystemElement(_ element: NSObject) -> Bool {
        guard let translation = element.value(forKey: "translation") as? NSObject,
              let pid = (translation.value(forKey: "pid") as? NSNumber)?.int32Value, pid > 0 else { return false }
        lock.lock()
        let known = systemPids[pid]
        lock.unlock()
        if let known { return known }
        let system = Self.bundleIdForPid(pid) == "com.apple.springboard"
        lock.lock()
        systemPids[pid] = system
        lock.unlock()
        return system
    }

    /// One hit-test at a screen point, as `WindowPlacement` reads it: the
    /// element's own (window-relative) frame and its window context.
    private func placementHitTest(token: String, displayId: UInt32) -> (CGPoint) -> WindowPlacement.Hit? {
        guard let translator,
              let pointIMP = translator.method(for: NSSelectorFromString("objectAtPoint:displayId:bridgeDelegateToken:")),
              let macIMP = translator.method(for: NSSelectorFromString("macPlatformElementFromTranslation:")) else {
            return { _ in nil }
        }
        let pointSel = NSSelectorFromString("objectAtPoint:displayId:bridgeDelegateToken:")
        let macSel = NSSelectorFromString("macPlatformElementFromTranslation:")
        typealias PointFunc = @convention(c) (AnyObject, Selector, CGPoint, UInt32, NSString) -> AnyObject?
        typealias MacFunc = @convention(c) (AnyObject, Selector, AnyObject) -> AnyObject?
        let objectAtPoint = unsafeBitCast(pointIMP, to: PointFunc.self)
        let toMacElement = unsafeBitCast(macIMP, to: MacFunc.self)
        let turn = currentTurn
        return { [weak self] point in
            let probe = turn?.toFrame(point) ?? point
            guard let self,
                  let translation = objectAtPoint(translator, pointSel, probe, displayId, token as NSString) as? NSObject else {
                return nil
            }
            translation.setValue(token, forKey: "bridgeDelegateToken")
            guard let element = toMacElement(translator, macSel, translation) as? NSObject else { return nil }
            if let inner = element.value(forKey: "translation") as? NSObject {
                inner.setValue(token, forKey: "bridgeDelegateToken")
            }
            let frame = (element as? NSAccessibilityElement)?.accessibilityFrame() ?? .zero
            guard self.isSystemElement(element) else {
                return WindowPlacement.Hit(frame: frame, context: Self.contextId(of: element))
            }
            // SpringBoard's chrome is told by its identifier, label and value.
            return WindowPlacement.Hit(
                frame: turn?.toScreen(frame) ?? frame,
                context: Self.contextId(of: element),
                system: true,
                identifier: self.stringValue(element, key: "accessibilityIdentifier"),
                label: self.stringValue(element, key: "accessibilityLabel"),
                value: self.stringValue(element, key: "accessibilityValue")
            )
        }
    }

    func makePlacement(
        udid: String,
        token: String,
        displayId: UInt32,
        rootElement: NSObject,
        displayOrientation: String?,
        displaySize: CGSize?,
        allowSearch: Bool
    ) -> WindowPlacement {
        let rootFrame = (rootElement as? NSAccessibilityElement)?.accessibilityFrame() ?? .zero
        // A foldable's turned panel keeps its own probe space and is never
        // placed; a rigid device's turn is handled by `currentTurn`.
        let foldableTurn = displayOrientation?.replacingOccurrences(of: "_", with: "-")
        let turned = currentTurn == nil && foldableTurn != nil && foldableTurn != "portrait"
        let screen = currentTurn?.screen ?? displaySize.map { display -> CGSize in
            let landscape = rootFrame.width > display.width + 1 || rootFrame.height > display.height + 1
            return landscape ? CGSize(width: display.height, height: display.width) : display
        }
        return WindowPlacement(
            udid: udid,
            enabled: WindowPlacement.needed(rootFrame: rootFrame, screen: screen, turned: turned),
            rootFrame: rootFrame,
            screen: screen,
            appLabel: stringValue(rootElement, key: "accessibilityLabel"),
            allowSearch: allowSearch,
            hitTest: placementHitTest(token: token, displayId: displayId)
        )
    }

    /// The frontmost application's root element on a display (ADE patch,
    /// shared by the point and focus reads below).
    private func frontmostRoot(device: NSObject, token: String, displayId: UInt32) throws -> NSObject {
        guard let translator = translator else { throw AccessibilityError.translatorUnavailable }
        let frontmostSel = NSSelectorFromString("frontmostApplicationWithDisplayId:bridgeDelegateToken:")
        typealias FrontmostFunc = @convention(c) (AnyObject, Selector, UInt32, NSString) -> AnyObject?
        guard let frontmostIMP = translator.method(for: frontmostSel) else {
            throw AccessibilityError.translatorUnavailable
        }
        let frontmost = unsafeBitCast(frontmostIMP, to: FrontmostFunc.self)
        guard let translation = frontmost(translator, frontmostSel, displayId, token as NSString) as? NSObject else {
            throw AccessibilityError.noFrontmostApplication
        }
        translation.setValue(token, forKey: "bridgeDelegateToken")
        let macElementSel = NSSelectorFromString("macPlatformElementFromTranslation:")
        typealias MacElementFunc = @convention(c) (AnyObject, Selector, AnyObject) -> AnyObject?
        guard let macIMP = translator.method(for: macElementSel) else {
            throw AccessibilityError.translatorUnavailable
        }
        let toMacElement = unsafeBitCast(macIMP, to: MacElementFunc.self)
        guard let rootElement = toMacElement(translator, macElementSel, translation) as? NSObject else {
            throw AccessibilityError.noFrontmostApplication
        }
        if let rootTranslation = rootElement.value(forKey: "translation") as? NSObject {
            rootTranslation.setValue(token, forKey: "bridgeDelegateToken")
        }
        return rootElement
    }

    private func simDevice(udid: String) throws -> NSObject {
        guard let device = FrameCapture.findSimDevice(udid: udid) else {
            throw NSError(domain: "Accessibility", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "Device \(udid) not found"])
        }
        return device
    }

    /// The one element under a point, with its children (ADE patch). The
    /// point is in the tree's own space (element frames, the picture), so on a
    /// panel whose picture is turned it is turned back into the probe space
    /// first. One hit-test and one small walk: what `fill-element` needs to
    /// read a field back after typing, at a fraction of a full describe.
    /// Returns nil when nothing answers there.
    func describeElement(
        udid: String,
        x: Double,
        y: Double,
        displayId: UInt32 = 0,
        displayOrientation: String? = nil,
        displaySize: CGSize? = nil,
        screenTurn: ScreenTurn? = nil
    ) throws -> Data? {
        try ensureLoaded()
        currentTurn = screenTurn
        defer { currentTurn = nil }
        let device = try simDevice(udid: udid)
        guard let translator = translator else { throw AccessibilityError.translatorUnavailable }
        let token = UUID().uuidString
        registerToken(token, device: device)
        defer { unregisterToken(token) }

        let rootElement = try frontmostRoot(device: device, token: token, displayId: displayId)
        let bounds = (rootElement as? NSAccessibilityElement)?.accessibilityFrame() ?? .zero
        let point = CGPoint(x: x, y: y)
        let probe = screenTurn?.toFrame(point) ?? Self.frameToProbe(orientation: displayOrientation, bounds: bounds)(point)

        let pointSel = NSSelectorFromString("objectAtPoint:displayId:bridgeDelegateToken:")
        typealias PointFunc = @convention(c) (AnyObject, Selector, CGPoint, UInt32, NSString) -> AnyObject?
        guard let pointIMP = translator.method(for: pointSel) else { throw AccessibilityError.translatorUnavailable }
        let objectAtPoint = unsafeBitCast(pointIMP, to: PointFunc.self)
        let macSel = NSSelectorFromString("macPlatformElementFromTranslation:")
        typealias MacFunc = @convention(c) (AnyObject, Selector, AnyObject) -> AnyObject?
        guard let macIMP = translator.method(for: macSel) else { throw AccessibilityError.translatorUnavailable }
        let toMacElement = unsafeBitCast(macIMP, to: MacFunc.self)

        guard let translation = objectAtPoint(translator, pointSel, probe, displayId, token as NSString) as? NSObject else {
            return nil
        }
        translation.setValue(token, forKey: "bridgeDelegateToken")
        guard let element = toMacElement(translator, macSel, translation) as? NSObject else { return nil }
        if let t = element.value(forKey: "translation") as? NSObject {
            t.setValue(token, forKey: "bridgeDelegateToken")
        }
        var coverage = AccessibilityCoverage()
        var visited = Set<ObjectIdentifier>()
        var remaining = 40
        var truncatedBy = Set<String>()
        let placement = makePlacement(
            udid: udid,
            token: token,
            displayId: displayId,
            rootElement: rootElement,
            displayOrientation: displayOrientation,
            displaySize: displaySize,
            allowSearch: false
        )
        guard let serialized = serialize(
            element: element,
            token: token,
            coverage: &coverage,
            visited: &visited,
            remainingElements: &remaining,
            truncatedBy: &truncatedBy,
            depth: 0,
            placement: placement,
            seed: screenTurn == nil ? probe : point
        ) else { return nil }
        return try JSONSerialization.data(withJSONObject: [Self.placeLater(serialized, placement: placement)])
    }

    /// The element with keyboard focus in the frontmost app (ADE patch), or
    /// nil when none has it. `supported` is false when this runtime's
    /// translation does not answer the focus question at all, so "nil" there
    /// means "unknown", not "nothing focused".
    func focusedElement(
        udid: String,
        displayId: UInt32 = 0,
        displaySize: CGSize? = nil,
        screenTurn: ScreenTurn? = nil
    ) throws -> (supported: Bool, element: [String: Any]?) {
        try ensureLoaded()
        currentTurn = screenTurn
        defer { currentTurn = nil }
        let device = try simDevice(udid: udid)
        let token = UUID().uuidString
        registerToken(token, device: device)
        defer { unregisterToken(token) }
        let rootElement = try frontmostRoot(device: device, token: token, displayId: displayId)
        let focusSel = NSSelectorFromString("accessibilityFocusedUIElement")
        let attributeSel = NSSelectorFromString("accessibilityAttributeValue:")
        let focusedValue: Any?
        if rootElement.responds(to: focusSel) {
            focusedValue = rootElement.value(forKey: "accessibilityFocusedUIElement")
        } else if rootElement.responds(to: attributeSel) {
            focusedValue = rootElement.perform(attributeSel, with: "AXFocusedUIElement")?.takeUnretainedValue()
        } else {
            return (false, nil)
        }
        guard let focused = focusedValue as? NSObject, focused !== rootElement else { return (true, nil) }
        if let t = focused.value(forKey: "translation") as? NSObject {
            t.setValue(token, forKey: "bridgeDelegateToken")
        }
        var coverage = AccessibilityCoverage()
        var visited = Set<ObjectIdentifier>()
        var remaining = 1
        var truncatedBy = Set<String>()
        let placement = makePlacement(
            udid: udid,
            token: token,
            displayId: displayId,
            rootElement: rootElement,
            displayOrientation: nil,
            displaySize: displaySize,
            allowSearch: false
        )
        let serialized = serialize(
            element: focused,
            token: token,
            coverage: &coverage,
            visited: &visited,
            remainingElements: &remaining,
            truncatedBy: &truncatedBy,
            depth: 0,
            placement: placement
        )
        return (true, serialized)
    }

    /// The inverse of `probeToFrame` (ADE patch): a point in the tree's own
    /// space turned back into the probe space a hit-test is asked in.
    static func frameToProbe(orientation: String?, bounds: CGRect) -> (CGPoint) -> CGPoint {
        let width = bounds.width, height = bounds.height
        switch orientation?.replacingOccurrences(of: "_", with: "-") {
        case "landscape-left": return { CGPoint(x: $0.y, y: height - $0.x) }
        case "portrait-upside-down": return { CGPoint(x: width - $0.x, y: height - $0.y) }
        case "landscape-right": return { CGPoint(x: width - $0.y, y: $0.x) }
        default: return { $0 }
        }
    }

    /// Roles whose value is a position on a scale (ADE patch, see the value
    /// description above), with the AX prefix stripped as `type` has it.
    static let adjustableRoles: Set<String> = [
        "Slider", "Incrementor", "ValueIndicator", "ProgressIndicator", "LevelIndicator", "ScrollBar",
    ]

    static let toggleRoles: Set<String> = ["CheckBox", "RadioButton", "Switch", "Toggle", "MenuItemCheckbox"]
}
