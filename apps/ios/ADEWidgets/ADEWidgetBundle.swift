import SwiftUI
import WidgetKit

/// The single `@main` entry point for the ADE widget extension. Registers the
/// lock-screen glance widget plus the "agent runs" Live Activity. ADE keeps
/// external system surfaces calm: the in-app Activity drawer owns details,
/// while these surfaces own glanceable status.
@main
struct ADEWidgetBundle: WidgetBundle {
    @WidgetBundleBuilder
    var body: some Widget {
        ADELockScreenWidget()
        ADEAgentActivityWidget()
    }
}
