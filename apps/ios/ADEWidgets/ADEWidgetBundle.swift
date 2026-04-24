import SwiftUI
import WidgetKit

/// The single `@main` entry point for the ADE widget extension. Registers
/// the Live Activity (owned by WS3), the workspace dashboard widget, the
/// lock-screen glance widgets, and — on iOS 18+ — the Control Center widget.
@main
struct ADEWidgetBundle: WidgetBundle {
    @WidgetBundleBuilder
    var body: some Widget {
        if #available(iOS 16.2, *) {
            ADELiveActivity()
        }
        ADEWorkspaceWidget()
        ADELockScreenWidget()
        if #available(iOS 18.0, *) {
            ADEControlWidget()
            ADEMuteControlWidget()
        }
    }
}
