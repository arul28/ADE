import AppKit
import SwiftUI
import ADEAttentionNotchCore

@main
struct ADEAttentionNotchApp: App {
    @NSApplicationDelegateAdaptor(NotchAppDelegate.self) private var appDelegate

    var body: some Scene {
        Settings {
            EmptyView()
        }
    }
}

@MainActor
final class NotchAppDelegate: NSObject, NSApplicationDelegate {
    private let model = NotchViewModel()
    private let transport = StandardIOTransport()
    private var panelController: NotchPanelController?
    private var statusController: NotchStatusItemController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApplication.shared.setActivationPolicy(.accessory)

        let panelController = NotchPanelController(model: model)
        self.panelController = panelController
        let statusController = NotchStatusItemController(model: model, panelController: panelController)
        self.statusController = statusController
        panelController.surfaceChanged = { [weak transport, weak statusController] displayId, physical in
            statusController?.refresh()
            transport?.send(NotchOutput(
                type: "surface",
                displayId: displayId,
                surface: physical ? "physical_notch" : "menu_bar"
            ))
        }
        panelController.reanchor()

        model.emit = { [weak transport] output in
            transport?.send(output)
        }
        model.requestReanchor = { [weak panelController, weak statusController] in
            panelController?.reanchor()
            statusController?.refresh()
        }
        model.requestQuit = {
            NSApplication.shared.terminate(nil)
        }
        transport.start { [weak model] input in
            model?.handle(input)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        panelController?.close()
    }
}
