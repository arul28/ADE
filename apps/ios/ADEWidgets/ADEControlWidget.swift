import AppIntents
import SwiftUI
import WidgetKit

/// Control Center widgets for iOS 18+. Each control is its own
/// `ControlWidget`. The widget bundle references both via
/// `ADEControlWidget`, which composes them under a single `@available`.
///
/// Intent types (`OpenADEIntent`, `ToggleMutePushIntent`) are declared in
/// `LiveActivityIntentsForward.swift` as stubs. `ios-app-wiring` will swap
/// the stub `perform()` bodies for real sync-service calls later.

@available(iOS 18.0, *)
struct ADEControlWidget: ControlWidget {
    static let kind = "com.ade.ios.control.open"

    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: Self.kind) {
            ControlWidgetButton(action: OpenADEIntent()) {
                Label("Open ADE", systemImage: "square.and.arrow.up.on.square")
            }
        }
        .displayName("Open ADE")
        .description("Jump straight to the ADE app.")
    }
}

@available(iOS 18.0, *)
struct ADEMuteControlWidget: ControlWidget {
    static let kind = "com.ade.ios.control.muteNotifications"

    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: Self.kind) {
            ControlWidgetToggle(
                "Mute ADE notifications",
                isOn: ADEMuteStateProvider.isMuted,
                action: ToggleMutePushIntent()
            ) { isOn in
                Label(
                    isOn ? "ADE muted" : "ADE alerts on",
                    systemImage: isOn ? "bell.slash.fill" : "bell.fill"
                )
            }
        }
        .displayName("Mute ADE")
        .description("Silence ADE push notifications until you turn them back on.")
    }
}

/// Reads the mute flag that the mute intent toggles. Stored in the App Group
/// `UserDefaults` so both Control Center and the main app see the same value.
@available(iOS 18.0, *)
enum ADEMuteStateProvider {
    static let key = "ade.notifications.muted"

    static var isMuted: Bool {
        ADESharedContainer.defaults.bool(forKey: key)
    }
}
