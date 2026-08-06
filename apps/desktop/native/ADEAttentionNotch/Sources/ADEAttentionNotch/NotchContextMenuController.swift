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

    /// Two modes and the settings that genuinely still apply.
    ///
    /// The sprawl this replaced offered three modes that all looked different,
    /// an "Automatic reveal" toggle whose behaviour one mode silently overrode,
    /// and a ticker that only existed in one of them. There is one thing to
    /// choose now — whether the strip rests on the menu bar or on the pointer.
    private func menu() -> NSMenu {
        let menu = NSMenu(title: "ADE Notch")
        menu.autoenablesItems = false
        menu.addItem(item("Open Activity", action: #selector(openActivity)))
        menu.addItem(item("Refresh", action: #selector(refresh)))
        menu.addItem(.separator())

        for mode in NotchRevealMode.allCases {
            let modeItem = item(mode.menuTitle, action: #selector(setRevealMode(_:)))
            modeItem.representedObject = mode.rawValue
            modeItem.state = model.settings.revealMode == mode ? .on : .off
            menu.addItem(modeItem)
        }

        menu.addItem(.separator())
        let hideDetails = item("Hide details", action: #selector(toggleHideDetails))
        hideDetails.state = model.settings.hideDetails ? .on : .off
        menu.addItem(hideDetails)
        let celebrations = item("Celebrate merges", action: #selector(toggleCelebrations))
        celebrations.state = model.settings.celebrationsEnabled ? .on : .off
        menu.addItem(celebrations)
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

    @objc private func toggleHideDetails() {
        model.applySettingsMenuAction(.toggleHideDetails)
    }

    @objc private func toggleCelebrations() {
        model.applySettingsMenuAction(.toggleCelebrations)
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
