import AppIntents
import SwiftUI
import WidgetKit

/// Control Center widgets for iOS 18+. Each control is its own
/// `ControlWidget` and registered by `ADEWidgetBundle`.
///
/// Intent types (`OpenADEIntent`, `ToggleMutePushIntent`) live in
/// `LiveActivityIntentsForward.swift`; the mute intent persists its window via
/// `ADEMutePreferences.setMute(until:)` and forwards the ISO string to the
/// desktop host through the intent command bridge.

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

@available(iOS 18.0, *)
struct ADEMuteControlWidget: ControlWidget {
    static let kind = "com.ade.ios.control.muteNotifications"

    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: Self.kind) {
            ControlWidgetToggle(
                "Mute ADE notifications",
                isOn: ADEMuteControlState.isMuted,
                action: ToggleMutePushIntent()
            ) { isOn in
                Label(
                    isOn ? mutedUntilLabel() : "Mute",
                    systemImage: isOn ? "bell.slash.fill" : "bell.fill"
                )
            }
        }
        .displayName("Mute ADE")
        .description("Silence ADE pushes for an hour.")
    }

    private func mutedUntilLabel() -> String {
        if let until = ADEMutePreferences.muteUntil, until.timeIntervalSinceNow > 0 {
            let formatted = until.formatted(date: .omitted, time: .shortened)
            return "Muted until \(formatted)"
        }
        return "Muted"
    }
}

/// Reads the unified mute state from `ADEMutePreferences` so the Control
/// Center toggle renders the correct "is muted" pill without having to parse
/// the ISO date in-line.
@available(iOS 18.0, *)
enum ADEMuteControlState {
    static var isMuted: Bool { ADEMutePreferences.isMuted }
}

// MARK: - Previews

#if DEBUG

/// Control widgets don't support `#Preview(as:)` the way home/lock widgets do —
/// the system renders them inside the Controls gallery. These inline views let
/// the canvas show the OFF / ON label content in isolation.
@available(iOS 18.0, *)
#Preview("Mute label · OFF") {
    Label("Mute", systemImage: "bell.fill")
        .labelStyle(.titleAndIcon)
        .padding()
}

@available(iOS 18.0, *)
#Preview("Mute label · ON") {
    Label("Muted until 9:00 AM", systemImage: "bell.slash.fill")
        .labelStyle(.titleAndIcon)
        .padding()
}

@available(iOS 18.0, *)
#Preview("Open ADE label") {
    Label("Open", systemImage: "sparkles")
        .labelStyle(.titleAndIcon)
        .padding()
}

#endif
