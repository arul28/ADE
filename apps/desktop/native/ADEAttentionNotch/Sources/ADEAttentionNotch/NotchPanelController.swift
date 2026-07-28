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
    private var hostingView: ShapeHostingView<NotchSurfaceView>?
    private var cancellables = Set<AnyCancellable>()
    private var eventMonitors: [Any] = []
    private var lastPointerInside = false

    private(set) var hasPhysicalNotch = false
    private(set) var displayId: UInt32?
    private var physicalNotchWidth: Double?
    private var safeAreaTop: Double = 0
    var surfaceChanged: ((UInt32, Bool) -> Void)?

    init(model: NotchViewModel) {
        self.model = model
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

    func close() {
        panel.orderOut(nil)
    }

    private func observeModel() {
        Publishers.CombineLatest3(model.$interaction, model.$items, model.$settings)
            .receive(on: RunLoop.main)
            .sink { [weak self] _, _, _ in
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
        let shouldShow = model.shouldPresentSurface
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
            matching: [.mouseMoved, .leftMouseDragged, .leftMouseDown],
            handler: { [weak self] event in
            if event.type != .leftMouseDown {
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
            matching: [.mouseMoved, .leftMouseDragged, .leftMouseDown, .keyDown],
            handler: { [weak self] event in
            guard let self else { return event }
            return self.handleLocalEvent(event)
        }) {
            eventMonitors.append(local)
        }
    }

    private func handleLocalEvent(_ event: NSEvent) -> NSEvent? {
        if event.type == .keyDown, model.interaction.isExplicitlyInteractive {
            switch event.keyCode {
            case 53:
                model.dismissExpanded()
                return nil
            case 123:
                model.navigate(delta: -1)
                return nil
            case 124:
                model.navigate(delta: 1)
                return nil
            case 36, 76:
                model.openSelected()
                return nil
            default:
                break
            }
        }
        handleMouseEvent(event, global: false)
        return event
    }

    private func handleMouseEvent(_ event: NSEvent, global: Bool) {
        let location = NSEvent.mouseLocation
        let inside = isInsideInteractiveShape(screenPoint: location)
        if event.type == .leftMouseDown {
            if inside {
                panel.allowsKeyActivation = true
                panel.makeKey()
                if !global {
                    switch model.interaction.presentation {
                    case .compact, .prehover, .peek:
                        model.toggleExpanded()
                    case .celebration:
                        model.openSelected()
                    case .expanded, .attention:
                        break
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
        guard let hostingView else { return false }
        let windowPoint = panel.convertPoint(fromScreen: screenPoint)
        let viewPoint = hostingView.convert(windowPoint, from: nil)
        return interactivePath(in: hostingView.bounds).contains(viewPoint)
    }

    private func interactivePath(in bounds: NSRect) -> NSBezierPath {
        let size = notchSurfaceSize(
            presentation: model.interaction.presentation,
            physicalNotchWidth: hasPhysicalNotch ? physicalNotchWidth : nil,
            safeAreaTop: safeAreaTop
        )
        let y = hostingView?.isFlipped == true
            ? bounds.minY
            : bounds.maxY - size.height
        let rect = NSRect(
            x: bounds.midX - size.width / 2,
            y: y,
            width: size.width,
            height: size.height
        )
        if hasPhysicalNotch, let physicalNotchWidth {
            return physicalInteractivePath(
                in: rect,
                notchWidth: physicalNotchWidth,
                isFlipped: hostingView?.isFlipped == true
            )
        }
        return NSBezierPath(
            roundedRect: rect,
            xRadius: min(22, size.height / 3),
            yRadius: min(22, size.height / 3)
        )
    }

    private func physicalInteractivePath(
        in rect: NSRect,
        notchWidth: Double,
        isFlipped: Bool
    ) -> NSBezierPath {
        let path = NSBezierPath()
        let resolvedNotchWidth = min(rect.width - 20, max(120, notchWidth))
        let notchLeft = rect.midX - resolvedNotchWidth / 2
        let notchRight = rect.midX + resolvedNotchWidth / 2
        let shoulder = min(24, max(15, rect.height * 0.18))
        let bottomRadius = min(25, max(12, rect.height * 0.16))
        let y: (Double) -> Double = { offset in
            isFlipped ? rect.minY + offset : rect.maxY - offset
        }
        path.move(to: NSPoint(x: notchLeft, y: y(0)))
        path.line(to: NSPoint(x: notchRight, y: y(0)))
        path.line(to: NSPoint(x: notchRight, y: y(shoulder * 0.34)))
        path.curve(
            to: NSPoint(x: rect.maxX - 7, y: y(shoulder)),
            controlPoint1: NSPoint(x: notchRight + 2, y: y(shoulder * 0.72)),
            controlPoint2: NSPoint(x: rect.maxX - 18, y: y(shoulder * 0.84))
        )
        path.curve(
            to: NSPoint(x: rect.maxX, y: y(shoulder + 7)),
            controlPoint1: NSPoint(x: rect.maxX - 2, y: y(shoulder)),
            controlPoint2: NSPoint(x: rect.maxX, y: y(shoulder + 2))
        )
        path.line(to: NSPoint(x: rect.maxX, y: y(rect.height - bottomRadius)))
        path.curve(
            to: NSPoint(x: rect.maxX - bottomRadius, y: y(rect.height)),
            controlPoint1: NSPoint(x: rect.maxX, y: y(rect.height)),
            controlPoint2: NSPoint(x: rect.maxX, y: y(rect.height))
        )
        path.line(to: NSPoint(x: rect.minX + bottomRadius, y: y(rect.height)))
        path.curve(
            to: NSPoint(x: rect.minX, y: y(rect.height - bottomRadius)),
            controlPoint1: NSPoint(x: rect.minX, y: y(rect.height)),
            controlPoint2: NSPoint(x: rect.minX, y: y(rect.height))
        )
        path.line(to: NSPoint(x: rect.minX, y: y(shoulder + 7)))
        path.curve(
            to: NSPoint(x: rect.minX + 7, y: y(shoulder)),
            controlPoint1: NSPoint(x: rect.minX, y: y(shoulder + 2)),
            controlPoint2: NSPoint(x: rect.minX + 2, y: y(shoulder))
        )
        path.curve(
            to: NSPoint(x: notchLeft, y: y(shoulder * 0.34)),
            controlPoint1: NSPoint(x: rect.minX + 18, y: y(shoulder * 0.84)),
            controlPoint2: NSPoint(x: notchLeft - 2, y: y(shoulder * 0.72))
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
