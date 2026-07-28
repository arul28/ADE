import AppKit
import Combine

@MainActor
final class NotchStatusItemController {
    private let model: NotchViewModel
    private let panelController: NotchPanelController
    private var statusItem: NSStatusItem?
    private var cancellables = Set<AnyCancellable>()

    init(model: NotchViewModel, panelController: NotchPanelController) {
        self.model = model
        self.panelController = panelController
        Publishers.CombineLatest3(model.$items, model.$interaction, model.$settings)
            .sink { [weak self] _, _, _ in self?.refresh() }
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

        let item = statusItem ?? NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem = item
        guard let button = item.button else { return }
        button.target = self
        button.action = #selector(togglePanel)
        button.image = NSImage(systemSymbolName: statusSymbol, accessibilityDescription: "ADE Attention Center")
        button.imagePosition = .imageOnly
        button.toolTip = statusToolTip
        button.setAccessibilityLabel("ADE Attention Center, \(statusToolTip)")
    }

    private var statusSymbol: String {
        if model.items.contains(where: \.isAttention) { return "bell.badge.fill" }
        if model.items.contains(where: { $0.phase == "running" || $0.phase == "starting" }) {
            return "sparkles"
        }
        return "checkmark.circle"
    }

    private var statusToolTip: String {
        guard let item = model.selectedItem else { return "No active attention items" }
        let presentation = item.presentation(hideDetails: model.settings.hideDetails)
        return "\(item.statusLabel): \(presentation.title)"
    }

    @objc private func togglePanel() {
        panelController.explicitToggle()
    }
}
