import Foundation

/// What ⌘W and ⌘Q sent to a lane app do instead of posting keys.
///
/// A key posted to a process that is not the active app does not run its menu
/// shortcuts: `press w --cmd` answered ok and the window stayed open. Pressing
/// the menu item through Accessibility did not work for a background app
/// either, and a menu search is dangerous besides: every app's menu bar holds
/// the Apple menu, where ⇧⌘Q is Log Out and ⌃⌘Q is Lock Screen. So the driver
/// handles only these two, by means that reach a background app, and posts
/// every other shortcut as keys, as before:
/// - ⌘W presses the lane window's own close button.
/// - ⌘Q asks the app to quit only when the lane launched it and every real
///   window it has is on the lane. One process owns all of an app's windows,
///   on every screen, so otherwise it would close the user's own windows; and
///   a window the lane only claimed belongs to an app the user started.
public enum LaneShortcut {
    public enum Plan: Equatable {
        /// Post the key to the process.
        case keys
        /// Press the lane window's own close button.
        case closeLaneWindow
        /// The lane launched the app and holds all of its windows: ask it to quit.
        case quitLaneApp
        /// The app is the user's, or has windows outside the lane: refuse.
        case refuseQuit
    }

    public static func plan(key: String, modifiers: [String], appBelongsToLane: Bool) -> Plan {
        let names = Set(modifiers.map { $0.lowercased() })
        let commandOnly = !names.isDisjoint(with: ["cmd", "command", "meta"])
            && names.isDisjoint(with: ["shift", "option", "alt", "control", "ctrl"])
        guard commandOnly, key.count == 1 else { return .keys }
        switch key.uppercased() {
        case "W": return .closeLaneWindow
        case "Q": return appBelongsToLane ? .quitLaneApp : .refuseQuit
        default: return .keys
        }
    }
}
