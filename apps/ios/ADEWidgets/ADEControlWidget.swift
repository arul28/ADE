import AppIntents
import SwiftUI
import WidgetKit

/// Control Center widgets for iOS 18+. Each control is its own
/// `ControlWidget` and registered by `ADEWidgetBundle`.

@available(iOS 18.0, *)
struct ADEControlWidget: ControlWidget {
    static let kind = "com.ade.ios.control.open"

    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: Self.kind) {
            ControlWidgetButton(action: OpenADEIntent()) {
                Label("Open", systemImage: "sparkles")
            }
        }
        .displayName("Open ADE")
        .description("Jump to the newest agent in ADE.")
    }
}

// MARK: - Previews

#if DEBUG

@available(iOS 18.0, *)
#Preview("Open ADE label") {
    Label("Open", systemImage: "sparkles")
        .labelStyle(.titleAndIcon)
        .padding()
}

#endif
