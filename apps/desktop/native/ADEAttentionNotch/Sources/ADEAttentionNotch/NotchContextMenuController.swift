import AppKit
import ADEAttentionNotchCore

@MainActor
final class NotchContextMenuController: NSObject {
    private let model: NotchViewModel

    init(model: NotchViewModel) {
        self.model = model
    }

    func present(at screenPoint: NSPoint) {
        menu().popUp(positioning: nil, at: screenPoint, in: nil)
    }

    func present(relativeTo view: NSView) {
        menu().popUp(
            positioning: nil,
            at: NSPoint(x: view.bounds.midX, y: view.bounds.minY - 4),
            in: view
        )
    }

    private func menu() -> NSMenu {
        let menu = NSMenu(title: "ADE Notch")
        menu.autoenablesItems = false
        menu.addItem(item("Open Activity", action: #selector(openActivity)))
        menu.addItem(item("Refresh", action: #selector(refresh)))
        menu.addItem(.separator())

        for (mode, title) in [
            (NotchRevealMode.minimal, "Compact + peek"),
            (.hover, "Reveal on hover"),
            (.click, "Click only"),
        ] {
            let modeItem = item(title, action: #selector(setRevealMode(_:)))
            modeItem.representedObject = mode.rawValue
            modeItem.state = model.settings.revealMode == mode ? .on : .off
            menu.addItem(modeItem)
        }

        menu.addItem(.separator())
        let expanded = item("Allow expanded panel", action: #selector(toggleExpandedPanel))
        expanded.state = model.settings.expandedPanelEnabled ? .on : .off
        menu.addItem(expanded)
        let automaticReveal = item("Automatic reveal", action: #selector(toggleAutomaticReveal))
        automaticReveal.state = model.settings.automaticRevealEnabled ? .on : .off
        // "Click only" already means nothing but a click opens anything, so the
        // checkmark would claim a behaviour the mode overrides.
        automaticReveal.isEnabled = model.settings.revealMode != .click
        menu.addItem(automaticReveal)
        let ticker = item("Live ticker", action: #selector(toggleTicker))
        ticker.state = model.settings.tickerEnabled ? .on : .off
        // The ticker lives in the pinned strip, which only compact mode keeps
        // on screen at rest.
        ticker.isEnabled = model.settings.revealMode == .minimal
        menu.addItem(ticker)
        menu.addItem(.separator())
        menu.addItem(item("Hide ADE Notch…", action: #selector(confirmHide)))
        return menu
    }

    private func item(_ title: String, action: Selector) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self
        return item
    }

    @objc private func openActivity() {
        model.openActivity()
    }

    @objc private func refresh() {
        model.requestRefresh()
    }

    @objc private func setRevealMode(_ sender: NSMenuItem) {
        guard
            let rawMode = sender.representedObject as? String,
            let mode = NotchRevealMode(rawValue: rawMode)
        else { return }
        model.applySettingsMenuAction(.setRevealMode(mode))
    }

    @objc private func toggleExpandedPanel() {
        model.applySettingsMenuAction(.toggleExpandedPanel)
    }

    @objc private func toggleAutomaticReveal() {
        model.applySettingsMenuAction(.toggleAutomaticReveal)
    }

    @objc private func toggleTicker() {
        model.applySettingsMenuAction(.toggleTicker)
    }

    @objc private func confirmHide() {
        let alert = NSAlert()
        alert.alertStyle = .informational
        alert.messageText = "Hide ADE Notch?"
        alert.informativeText = "This removes the notch and menu-bar activity surface. You can turn it back on anytime in ADE’s Activity settings."
        alert.addButton(withTitle: "Hide ADE Notch")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        model.applySettingsMenuAction(.hide)
    }
}
