import AppKit
import Combine
import SwiftUI
import ADEAttentionNotchCore

final class AttentionNotchPanel: NSPanel {
    var allowsKeyActivation = false

    override var canBecomeKey: Bool { allowsKeyActivation }
    override var canBecomeMain: Bool { false }
}

final class ShapeHostingView<Content: View>: NSHostingView<Content> {
    var interactivePath: (() -> NSBezierPath?)?

    override func hitTest(_ point: NSPoint) -> NSView? {
        guard interactivePath?().map({ $0.contains(point) }) == true else { return nil }
        return super.hitTest(point)
    }
}

@MainActor
final class NotchPanelController {
    private let model: NotchViewModel
    private let panel: AttentionNotchPanel
    private let contextMenuController: NotchContextMenuController
    private var hostingView: ShapeHostingView<NotchSurfaceView>?
    private var cancellables = Set<AnyCancellable>()
    private var eventMonitors: [Any] = []
    private var lastPointerInside = false

    private(set) var hasPhysicalNotch = false
    private(set) var displayId: UInt32?
    private var physicalNotchWidth: Double?
    private var safeAreaTop: Double = 0
    var surfaceChanged: ((UInt32, Bool) -> Void)?
    var fallbackHotZone: (() -> NSRect?)?
    var fallbackAnchorFrame: (() -> NSRect?)?

    init(model: NotchViewModel) {
        self.model = model
        contextMenuController = NotchContextMenuController(model: model)
        panel = AttentionNotchPanel(
            contentRect: .zero,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: true
        )
        panel.level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 8)
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.isMovable = false
        panel.acceptsMouseMovedEvents = true
        panel.animationBehavior = .none
        panel.ignoresMouseEvents = true

        observeModel()
        installEventMonitors()
        installScreenObservers()
        reanchor()
    }

    deinit {
        for monitor in eventMonitors {
            NSEvent.removeMonitor(monitor)
        }
        NotificationCenter.default.removeObserver(self)
        NSWorkspace.shared.notificationCenter.removeObserver(self)
    }

    func reanchor() {
        guard let selected = selectedScreen() else {
            panel.orderOut(nil)
            return
        }
        let geometry = geometry(for: selected)
        hasPhysicalNotch = geometry.hasPhysicalNotch
        physicalNotchWidth = geometry.physicalNotchWidth
        safeAreaTop = geometry.hasPhysicalNotch ? geometry.safeAreaTop : 0
        displayId = geometry.displayId
        let target = geometry.panelFrame
        panel.setFrame(
            NSRect(x: target.x, y: target.y, width: target.width, height: target.height),
            display: false
        )
        rebuildContent()
        updatePresentation()
        updatePointer(at: NSEvent.mouseLocation)
        surfaceChanged?(geometry.displayId, geometry.hasPhysicalNotch)
    }

    func explicitToggle() {
        model.toggleExpanded()
        panel.allowsKeyActivation = model.interaction.isExplicitlyInteractive
        if panel.allowsKeyActivation {
            panel.makeKey()
        }
        updatePresentation()
    }

    /// The strip's own metrics decide its width, so every geometry read has to
    /// go through here rather than calling `notchSurfaceSize` with defaults.
    private func surfaceSize(for presentation: NotchPresentationState) -> NotchSize {
        notchSurfaceSize(
            presentation: presentation,
            physicalNotchWidth: hasPhysicalNotch ? physicalNotchWidth : nil,
            safeAreaTop: safeAreaTop,
            strip: model.stripMetrics
        )
    }

    func close() {
        panel.orderOut(nil)
    }

    private func observeModel() {
        // Counts ride along because the strip's width is derived from what it
        // draws, and a counts-only frame changes both.
        Publishers.CombineLatest4(model.$interaction, model.$items, model.$settings, model.$counts)
            .receive(on: RunLoop.main)
            .sink { [weak self] _, _, _, _ in
                guard let self else { return }
                self.rebuildContent()
                self.updatePresentation()
                self.updatePointer(at: NSEvent.mouseLocation)
            }
            .store(in: &cancellables)
    }

    private func rebuildContent() {
        let root = NotchSurfaceView(
            model: model,
            hasPhysicalNotch: hasPhysicalNotch,
            physicalNotchWidth: physicalNotchWidth,
            safeAreaTop: safeAreaTop
        )
        if let hostingView {
            hostingView.rootView = root
            return
        }
        let view = ShapeHostingView(rootView: root)
        view.frame = NSRect(
            x: 0,
            y: 0,
            width: NotchDisplayGeometry.panelSize.width,
            height: NotchDisplayGeometry.panelSize.height
        )
        view.autoresizingMask = [.width, .height]
        view.interactivePath = { [weak self, weak view] in
            guard let self, let view else { return nil }
            return self.interactivePath(in: view.bounds)
        }
        panel.contentView = view
        hostingView = view
    }

    private func updatePresentation() {
        positionPanelForCurrentSurface()
        let shouldShow = notchPanelShouldShow(
            surfaceEnabled: model.shouldPresentSurface,
            hasPhysicalNotch: hasPhysicalNotch,
            presentation: model.interaction.presentation
        )
        if shouldShow {
            panel.orderFrontRegardless()
        } else {
            panel.orderOut(nil)
        }
        panel.allowsKeyActivation = model.interaction.isExplicitlyInteractive
        if !panel.allowsKeyActivation, panel.isKeyWindow {
            panel.resignKey()
        }
    }

    private func installEventMonitors() {
        var lastGlobalMoveAt = 0.0
        if let global = NSEvent.addGlobalMonitorForEvents(
            matching: [.mouseMoved, .leftMouseDragged, .leftMouseDown, .rightMouseDown],
            handler: { [weak self] event in
            if event.type == .mouseMoved || event.type == .leftMouseDragged {
                let now = ProcessInfo.processInfo.systemUptime
                guard now - lastGlobalMoveAt >= 1 / 30 else { return }
                lastGlobalMoveAt = now
            }
            Task { @MainActor in
                self?.handleMouseEvent(event, global: true)
            }
        }) {
            eventMonitors.append(global)
        }
        if let local = NSEvent.addLocalMonitorForEvents(
            matching: [.mouseMoved, .leftMouseDragged, .leftMouseDown, .rightMouseDown, .keyDown],
            handler: { [weak self] event in
            guard let self else { return event }
            return self.handleLocalEvent(event)
        }) {
            eventMonitors.append(local)
        }
    }

    /// The panel is keyboard navigable while it is open: arrows move focus
    /// through exactly the rows on screen, left/right collapse and expand the
    /// heading or cluster under it, Tab swaps Agents and Events, Return acts.
    private func handleLocalEvent(_ event: NSEvent) -> NSEvent? {
        if event.type == .keyDown, model.interaction.isExplicitlyInteractive {
            switch event.keyCode {
            case 53:
                model.dismissExpanded()
                return nil
            case 36, 76:
                model.activateFocusedRow()
                return nil
            case 125:
                model.moveFocus(by: 1)
                return nil
            case 126:
                model.moveFocus(by: -1)
                return nil
            case 123:
                model.setFocusedRowExpanded(false)
                return nil
            case 124:
                model.setFocusedRowExpanded(true)
                return nil
            case 48:
                model.cycleTab()
                return nil
            default:
                break
            }
        }
        if event.type == .rightMouseDown,
           isInsideSurfaceShape(screenPoint: NSEvent.mouseLocation) {
            contextMenuController.present(at: NSEvent.mouseLocation)
            return nil
        }
        handleMouseEvent(event, global: false)
        return event
    }

    private func handleMouseEvent(_ event: NSEvent, global: Bool) {
        let location = NSEvent.mouseLocation
        let inside = isInsideInteractiveShape(screenPoint: location)
        if event.type == .rightMouseDown {
            if isInsideSurfaceShape(screenPoint: location), global {
                contextMenuController.present(at: location)
            }
            updatePointer(at: location)
            return
        }
        if event.type == .leftMouseDown {
            if inside {
                panel.allowsKeyActivation = true
                panel.makeKey()
                if !global {
                    // Only the strip resolves a click here. The takeover cards
                    // and the panel carry real controls, and consuming their
                    // mouse-downs at this level would beat the buttons to them.
                    if model.interaction.presentation == .compact {
                        model.toggleExpanded()
                    }
                }
            } else if model.interaction.isExplicitlyInteractive {
                model.dismissExpanded()
            }
        }
        updatePointer(at: location)
    }

    private func updatePointer(at screenPoint: NSPoint) {
        let inside = model.shouldPresentSurface && isInsideInteractiveShape(screenPoint: screenPoint)
        panel.ignoresMouseEvents = !inside
        if inside != lastPointerInside {
            lastPointerInside = inside
            model.pointerChanged(isInside: inside)
        }
    }

    private func isInsideInteractiveShape(screenPoint: NSPoint) -> Bool {
        if fallbackHotZone?().map({ $0.insetBy(dx: -4, dy: -4).contains(screenPoint) }) == true {
            return true
        }
        // On non-notch Macs the compact surface is the status item. Do not
        // leave an invisible center-screen hover target behind when the panel
        // itself is intentionally ordered out.
        guard hasPhysicalNotch || model.interaction.presentation != .compact else {
            return false
        }
        return isInsideSurfaceShape(screenPoint: screenPoint)
    }

    private func isInsideSurfaceShape(screenPoint: NSPoint) -> Bool {
        guard let hostingView else { return false }
        let windowPoint = panel.convertPoint(fromScreen: screenPoint)
        let viewPoint = hostingView.convert(windowPoint, from: nil)
        return interactivePath(in: hostingView.bounds).contains(viewPoint)
    }

    /// Mirrors `NotchSurfaceShape` in `NotchSurfaceView`: same size, same
    /// corner metrics, same tangent-arc construction, so the clickable region
    /// and the drawn outline cannot drift apart.
    private func interactivePath(in bounds: NSRect) -> NSBezierPath {
        let presentation = model.interaction.presentation
        if model.isDormantHoverSurface {
            let hotZone = notchHoverHotZoneSize(
                physicalNotchWidth: hasPhysicalNotch ? physicalNotchWidth : nil,
                safeAreaTop: safeAreaTop
            )
            let isFlipped = hostingView?.isFlipped == true
            let topEdge = isFlipped ? bounds.minY : bounds.maxY
            let rect = NSRect(
                x: bounds.midX - hotZone.width / 2,
                y: isFlipped ? topEdge : topEdge - hotZone.height,
                width: hotZone.width,
                height: hotZone.height
            )
            return NSBezierPath(
                roundedRect: rect,
                xRadius: min(12, hotZone.height / 2),
                yRadius: min(12, hotZone.height / 2)
            )
        }
        let size = surfaceSize(for: presentation)
        let corners = notchSurfaceCorners(
            presentation: presentation,
            hasPhysicalNotch: hasPhysicalNotch,
            size: size
        )
        let isFlipped = hostingView?.isFlipped == true
        let topEdge = isFlipped ? bounds.minY : bounds.maxY
        let bottomEdge = isFlipped ? bounds.minY + size.height : bounds.maxY - size.height
        let minX = bounds.midX - size.width / 2
        let maxX = bounds.midX + size.width / 2
        let limit = min(size.width, size.height) / 2
        let top = max(0, min(corners.top, limit))
        let bottom = max(0, min(corners.bottom, limit))

        let path = NSBezierPath()
        path.move(to: NSPoint(x: bounds.midX, y: topEdge))
        path.appendArc(
            from: NSPoint(x: maxX, y: topEdge),
            to: NSPoint(x: maxX, y: bottomEdge),
            radius: top
        )
        path.appendArc(
            from: NSPoint(x: maxX, y: bottomEdge),
            to: NSPoint(x: minX, y: bottomEdge),
            radius: bottom
        )
        path.appendArc(
            from: NSPoint(x: minX, y: bottomEdge),
            to: NSPoint(x: minX, y: topEdge),
            radius: bottom
        )
        path.appendArc(
            from: NSPoint(x: minX, y: topEdge),
            to: NSPoint(x: maxX, y: topEdge),
            radius: top
        )
        path.close()
        return path
    }

    private func installScreenObservers() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(screenParametersChanged),
            name: NSApplication.didChangeScreenParametersNotification,
            object: nil
        )
        NSWorkspace.shared.notificationCenter.addObserver(
            self,
            selector: #selector(screenParametersChanged),
            name: NSWorkspace.didWakeNotification,
            object: nil
        )
    }

    private func positionPanelForCurrentSurface() {
        guard !hasPhysicalNotch, let anchorFrame = fallbackAnchorFrame?() else { return }
        let anchorPoint = NSPoint(x: anchorFrame.midX, y: anchorFrame.midY)
        let screen = NSScreen.screens.first(where: { $0.frame.contains(anchorPoint) })
            ?? selectedScreen()
        guard let screen else { return }

        let size = surfaceSize(for: model.interaction.presentation)
        let target = menuBarAnchoredPanelFrame(
            statusItemFrame: rect(anchorFrame),
            displayFrame: rect(screen.frame),
            surfaceSize: size
        )
        panel.setFrame(
            NSRect(x: target.x, y: target.y, width: target.width, height: target.height),
            display: false
        )
    }

    @objc private func screenParametersChanged() {
        reanchor()
    }

    private func selectedScreen() -> NSScreen? {
        if let preferred = model.settings.preferredDisplayId,
           let preferredScreen = NSScreen.screens.first(where: { displayId(for: $0) == preferred }) {
            return preferredScreen
        }
        if let notchedBuiltIn = NSScreen.screens.first(where: { geometry(for: $0).hasPhysicalNotch }) {
            return notchedBuiltIn
        }
        return NSScreen.main ?? NSScreen.screens.first
    }

    private func geometry(for screen: NSScreen) -> NotchDisplayGeometry {
        let id = displayId(for: screen)
        return NotchDisplayGeometry(
            displayId: id,
            frame: rect(screen.frame),
            visibleFrame: rect(screen.visibleFrame),
            safeAreaTop: screen.safeAreaInsets.top,
            auxiliaryLeft: screen.auxiliaryTopLeftArea.map(rect),
            auxiliaryRight: screen.auxiliaryTopRightArea.map(rect),
            isBuiltIn: CGDisplayIsBuiltin(id) != 0
        )
    }

    private func displayId(for screen: NSScreen) -> CGDirectDisplayID {
        (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value
            ?? CGMainDisplayID()
    }

    private func rect(_ value: NSRect) -> NotchRect {
        NotchRect(x: value.minX, y: value.minY, width: value.width, height: value.height)
    }
}
