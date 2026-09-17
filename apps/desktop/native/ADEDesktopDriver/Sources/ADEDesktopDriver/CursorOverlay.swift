/// The cursor the human sees on the lane's screen.
///
/// The real pointer never moves for an accessibility action, which is the whole
/// point — but it also means a person watching the live view sees buttons
/// depress with nothing touching them. This draws a cursor glyph at the last
/// point the driver acted on, so the stream reads as somebody working rather
/// than as a haunting.
///
/// The panel is borderless, non-activating, and ignores mouse events: it must
/// never take focus from the app being driven, and it must never swallow a
/// click if the user takes over. It hides itself after a few idle seconds so a
/// screenshot taken later is not decorated with a stale pointer.

import AppKit
import Foundation

final class CursorOverlay {
    static let idleHideAfter: TimeInterval = 3
    private static let glyphSize = CGSize(width: 28, height: 28)

    private var panel: NSPanel?
    private var hideTimer: Timer?
    private var visible = false

    /// Moves the glyph to a global screen point and shows it.
    func show(at point: CGPoint) {
        let panel = ensurePanel()
        // AppKit screen coordinates are bottom-left origin; the rest of this
        // driver speaks the CoreGraphics top-left plane, so the y flips here and
        // nowhere else.
        let flippedY = Self.globalHeight() - point.y - Self.glyphSize.height
        panel.setFrameOrigin(NSPoint(x: point.x - 4, y: flippedY + 4))
        if !visible {
            panel.orderFrontRegardless()
            visible = true
        }
        hideTimer?.invalidate()
        let timer = Timer(timeInterval: Self.idleHideAfter, repeats: false) { [weak self] _ in
            self?.hide()
        }
        RunLoop.main.add(timer, forMode: .common)
        hideTimer = timer
    }

    func hide() {
        hideTimer?.invalidate()
        hideTimer = nil
        panel?.orderOut(nil)
        visible = false
    }

    var isVisible: Bool { visible }

    func dispose() {
        hide()
        panel = nil
    }

    private static func globalHeight() -> CGFloat {
        // The union of every screen, in AppKit coordinates. Using the main
        // screen's height alone would put the glyph on the wrong row for any
        // display that is not the main one — which is every lane display.
        NSScreen.screens.reduce(CGRect.zero) { $0.union($1.frame) }.maxY
    }

    private func ensurePanel() -> NSPanel {
        if let panel { return panel }
        let panel = NSPanel(
            contentRect: NSRect(origin: .zero, size: Self.glyphSize),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isFloatingPanel = true
        panel.level = .screenSaver
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
        panel.contentView = CursorGlyphView(frame: NSRect(origin: .zero, size: Self.glyphSize))
        self.panel = panel
        return panel
    }
}

private final class CursorGlyphView: NSView {
    override func draw(_ dirtyRect: NSRect) {
        guard let context = NSGraphicsContext.current?.cgContext else { return }
        let path = CGMutablePath()
        // A plain arrow pointer, drawn rather than loaded: a bundled image would
        // mean a resource bundle for one glyph.
        path.move(to: CGPoint(x: 3, y: 25))
        path.addLine(to: CGPoint(x: 3, y: 5))
        path.addLine(to: CGPoint(x: 9, y: 11))
        path.addLine(to: CGPoint(x: 13, y: 3))
        path.addLine(to: CGPoint(x: 17, y: 5))
        path.addLine(to: CGPoint(x: 13, y: 13))
        path.addLine(to: CGPoint(x: 20, y: 13))
        path.closeSubpath()
        context.addPath(path)
        context.setFillColor(NSColor.white.cgColor)
        context.setStrokeColor(NSColor.black.withAlphaComponent(0.85).cgColor)
        context.setLineWidth(1.5)
        context.drawPath(using: .fillStroke)
    }
}
