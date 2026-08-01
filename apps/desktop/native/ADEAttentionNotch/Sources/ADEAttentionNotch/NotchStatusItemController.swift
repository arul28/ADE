import AppKit
import Combine

@MainActor
final class NotchStatusItemController {
    private let model: NotchViewModel
    private let panelController: NotchPanelController
    private let contextMenuController: NotchContextMenuController
    private var statusItem: NSStatusItem?
    private var cancellables = Set<AnyCancellable>()

    init(model: NotchViewModel, panelController: NotchPanelController) {
        self.model = model
        self.panelController = panelController
        contextMenuController = NotchContextMenuController(model: model)
        panelController.fallbackHotZone = { [weak self] in
            self?.statusItemScreenFrame
        }
        panelController.fallbackAnchorFrame = { [weak self] in
            self?.statusItemScreenFrame
        }
        Publishers.CombineLatest4(model.$items, model.$interaction, model.$settings, model.$counts)
            .sink { [weak self] _, _, _, _ in self?.refresh() }
            .store(in: &cancellables)
        refresh()
    }

    func refresh() {
        if !model.settings.enabled || panelController.hasPhysicalNotch {
            if let statusItem {
                NSStatusBar.system.removeStatusItem(statusItem)
                self.statusItem = nil
            }
            return
        }

        let item = statusItem ?? NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem = item
        guard let button = item.button else { return }
        button.target = self
        button.action = #selector(handleStatusItemClick)
        button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        button.image = statusIcon
        button.imagePosition = .imageOnly
        button.toolTip = statusToolTip
        button.setAccessibilityLabel("ADE Activity, \(statusToolTip)")
    }

    private var statusIcon: NSImage {
        guard
            let url = Bundle.module.url(forResource: "ADEStatusIcon", withExtension: "png"),
            let brandImage = NSImage(contentsOf: url)
        else {
            // The canonical icon is bundled with the helper. This fallback is
            // only a packaging-failure guard so the status item never becomes
            // an invisible, unclickable gap.
            return NSImage(
                systemSymbolName: "app.dashed",
                accessibilityDescription: "ADE Activity"
            ) ?? NSImage()
        }

        let iconSize = NSSize(width: 18, height: 18)
        let image = NSImage(size: iconSize)
        image.lockFocus()
        NSGraphicsContext.current?.imageInterpolation = .high
        brandImage.draw(
            in: NSRect(origin: .zero, size: iconSize),
            from: .zero,
            operation: .sourceOver,
            fraction: 1
        )

        let badgeColor = statusBadgeColor
        let badgeRect = NSRect(x: 12.5, y: 0.5, width: 5, height: 5)
        NSColor.windowBackgroundColor.setFill()
        NSBezierPath(ovalIn: badgeRect.insetBy(dx: -1, dy: -1)).fill()
        badgeColor.setFill()
        NSBezierPath(ovalIn: badgeRect).fill()
        image.unlockFocus()
        image.isTemplate = false
        image.accessibilityDescription = "ADE Activity"
        return image
    }

    /// One hue per section, same table as every other Activity surface: amber
    /// is "your move" and nothing else, blue is work in progress, emerald is
    /// finished cleanly. Read from the account's counts rather than one selected
    /// row, so the badge describes the whole account.
    private var statusBadgeColor: NSColor {
        if let status = model.statusPresentation, status.isProblem {
            switch status.tone {
            case .red: return .systemRed
            case .amber: return .systemOrange
            default: return .systemPurple
            }
        }
        let counts = model.counts
        if counts.needsYou > 0 { return .systemOrange }
        if counts.working > 0 { return .systemBlue }
        if counts.done > 0 { return .systemGreen }
        return .systemGray
    }

    private var statusToolTip: String {
        if let status = model.statusPresentation, status.isProblem {
            return [status.title, status.hint].compactMap { $0 }.joined(separator: " ")
        }
        let counts = model.counts
        var parts: [String] = []
        if counts.needsYou > 0 { parts.append("\(counts.needsYou) need\(counts.needsYou == 1 ? "s" : "") you") }
        if counts.working > 0 { parts.append("\(counts.working) working") }
        if counts.done > 0 { parts.append("\(counts.done) done") }
        guard parts.isEmpty else { return parts.joined(separator: " · ") }
        return model.statusPresentation?.message ?? "All agents idle"
    }

    private var statusItemScreenFrame: NSRect? {
        guard let button = statusItem?.button, let window = button.window else { return nil }
        return window.convertToScreen(button.convert(button.bounds, to: nil))
    }

    @objc private func handleStatusItemClick() {
        if NSApp.currentEvent?.type == .rightMouseUp,
           let button = statusItem?.button {
            contextMenuController.present(relativeTo: button)
        } else {
            panelController.explicitToggle()
        }
    }
}
