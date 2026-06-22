import SwiftUI
import WidgetKit

/// The single `@main` entry point for the ADE widget extension. Registers
/// only the lock-screen glance widget. ADE keeps external system surfaces calm:
/// the in-app Attention Drawer owns details, while this widget owns glanceable
/// status.
@main
struct ADEWidgetBundle: WidgetBundle {
    @WidgetBundleBuilder
    var body: some Widget {
        ADELockScreenWidget()
    }
}
