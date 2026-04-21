import AppIntents
import Foundation

/// Real implementations of the Live-Activity / Control-Widget intents.
///
/// Referenced by `ADELiveActivityViews.swift` (Live Activity buttons) and
/// `ADEControlWidget.swift` (Control Center widgets). This file is included
/// in the main ADE target, the ADEWidgets extension, and the
/// ADENotificationService extension so the same symbols resolve in every
/// process that hosts interactive regions.
///
/// All `perform()` bodies route through a `ADEIntentCommandBridge` that the
/// main app registers at launch. We avoid importing `SyncService` here
/// because this file is compiled into the widget + notification-service
/// extensions too, which don't link `SyncService.swift`.
///
/// NOTE (naming): the file is still called `LiveActivityIntentsForward.swift`
/// for pbxproj-stability reasons; it now carries the real impls.

// MARK: - Cross-target command bridge

/// String-keyed mirror of `SyncService.RemoteCommandKind` — duplicated here
/// so the widget + NS extensions can reference it without importing the
/// full `SyncService` translation unit.
public enum ADEIntentCommandKind: String, Sendable {
    case approveSession
    case denySession
    case pauseSession
    case replyToSession
    case retryPrChecks
    case openPr
    case setMutePush
}

/// Main-app adapter installed by `SyncService` at launch. The widget /
/// notification-service processes never register an implementation, so
/// `perform()` becomes a no-op there (which is correct — interactive intents
/// from a Live Activity always execute in the main app process anyway).
@MainActor
public protocol ADEIntentCommandBridge: AnyObject {
    func dispatch(_ kind: ADEIntentCommandKind, payload: [String: Any]) async
}

@MainActor
public enum ADEIntentCommandRegistry {
    public private(set) static weak var bridge: ADEIntentCommandBridge?

    public static func register(_ bridge: ADEIntentCommandBridge) {
        self.bridge = bridge
    }

    static func dispatch(_ kind: ADEIntentCommandKind, payload: [String: Any]) async {
        await bridge?.dispatch(kind, payload: payload)
    }
}

// MARK: - Mute preferences (shared container key)

@available(iOS 17.0, *)
public enum ADEMutePreferences {
    /// ISO-8601 date at which the mute should expire. `nil` means not muted.
    /// Shared between the main app, widget extension, and notification
    /// extension via the App Group `UserDefaults`.
    public static let muteUntilKey = "ade.notifications.muteUntil"
    /// Legacy boolean flag still read by `ADEControlWidget.swift` so the
    /// Control Center toggle renders the correct "is muted" state without
    /// having to parse a date.
    public static let mutedBoolKey = "ade.notifications.muted"

    public static var muteUntil: Date? {
        let defaults = ADESharedContainer.defaults
        guard let iso = defaults.string(forKey: muteUntilKey), !iso.isEmpty else {
            return nil
        }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        if let d = formatter.date(from: iso) { return d }
        // Fall back to fractional-seconds variant.
        let withFractional = ISO8601DateFormatter()
        withFractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return withFractional.date(from: iso)
    }

    public static var isMuted: Bool {
        guard let until = muteUntil else { return false }
        return until.timeIntervalSinceNow > 0
    }

    /// Persist a new mute window. `until == nil` clears the mute.
    /// Returns the ISO-8601 representation that was written (or `nil` if the
    /// mute was cleared), which is what we forward to the desktop host.
    @discardableResult
    public static func setMute(until: Date?) -> String? {
        let defaults = ADESharedContainer.defaults
        if let until = until, until.timeIntervalSinceNow > 0 {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime]
            let iso = formatter.string(from: until)
            defaults.set(iso, forKey: muteUntilKey)
            defaults.set(true, forKey: mutedBoolKey)
            return iso
        } else {
            defaults.removeObject(forKey: muteUntilKey)
            defaults.set(false, forKey: mutedBoolKey)
            return nil
        }
    }
}

// MARK: - Live Activity intents

@available(iOS 17.0, *)
public struct ApproveSessionIntent: LiveActivityIntent {
    public static var title: LocalizedStringResource = "Approve"
    public static var description = IntentDescription(
        "Approve the pending action in the current ADE session."
    )
    /// Keep this `false` so the Live Activity can resolve the intent without
    /// bringing the app forward.
    public static var openAppWhenRun: Bool = false

    @Parameter(title: "Session ID")
    public var sessionId: String

    /// Desktop's `chat.approve` handler requires `itemId`; carry it through.
    /// Empty string is tolerated for intents constructed without one.
    @Parameter(title: "Item ID", default: "")
    public var itemId: String

    public init() {}

    public init(sessionId: String, itemId: String = "") {
        self.sessionId = sessionId
        self.itemId = itemId
    }

    @MainActor
    public func perform() async throws -> some IntentResult {
        await ADEIntentCommandRegistry.dispatch(
            .approveSession,
            payload: ["sessionId": sessionId, "itemId": itemId]
        )
        return .result()
    }
}

@available(iOS 17.0, *)
public struct DenySessionIntent: LiveActivityIntent {
    public static var title: LocalizedStringResource = "Deny"
    public static var description = IntentDescription(
        "Deny the pending action in the current ADE session."
    )
    public static var openAppWhenRun: Bool = false

    @Parameter(title: "Session ID")
    public var sessionId: String

    @Parameter(title: "Item ID", default: "")
    public var itemId: String

    public init() {}

    public init(sessionId: String, itemId: String = "") {
        self.sessionId = sessionId
        self.itemId = itemId
    }

    @MainActor
    public func perform() async throws -> some IntentResult {
        await ADEIntentCommandRegistry.dispatch(
            .denySession,
            payload: ["sessionId": sessionId, "itemId": itemId]
        )
        return .result()
    }
}

@available(iOS 17.0, *)
public struct PauseSessionIntent: LiveActivityIntent {
    public static var title: LocalizedStringResource = "Pause"
    public static var description = IntentDescription(
        "Pause the current ADE session."
    )
    public static var openAppWhenRun: Bool = false

    @Parameter(title: "Session ID")
    public var sessionId: String

    public init() {}

    public init(sessionId: String) {
        self.sessionId = sessionId
    }

    @MainActor
    public func perform() async throws -> some IntentResult {
        await ADEIntentCommandRegistry.dispatch(.pauseSession, payload: ["sessionId": sessionId])
        return .result()
    }
}

@available(iOS 17.0, *)
public struct RetryCheckIntent: LiveActivityIntent {
    public static var title: LocalizedStringResource = "Retry checks"
    public static var description = IntentDescription(
        "Retry failing CI checks for the associated pull request."
    )
    public static var openAppWhenRun: Bool = false

    @Parameter(title: "PR Number")
    public var prNumber: Int

    /// Desktop's `prs.rerunChecks` handler requires an internal `prId`.
    @Parameter(title: "PR ID", default: "")
    public var prId: String

    public init() {}

    public init(prNumber: Int, prId: String = "") {
        self.prNumber = prNumber
        self.prId = prId
    }

    @MainActor
    public func perform() async throws -> some IntentResult {
        await ADEIntentCommandRegistry.dispatch(
            .retryPrChecks,
            payload: ["prNumber": prNumber, "prId": prId]
        )
        return .result()
    }
}

/// Free-text reply intent for the Live Activity "quick reply" affordance.
/// Never logs `text` in plaintext — the value only travels through the
/// registered bridge, which itself avoids logging payloads.
@available(iOS 17.0, *)
public struct ReplySessionIntent: LiveActivityIntent {
    public static var title: LocalizedStringResource = "Reply"
    public static var description = IntentDescription(
        "Reply to the current ADE session from the Live Activity."
    )
    public static var openAppWhenRun: Bool = false

    @Parameter(title: "Session")
    public var sessionId: String

    @Parameter(title: "Message", inputOptions: String.IntentInputOptions(keyboardType: .default))
    public var text: String

    public init() {}

    public init(sessionId: String, text: String) {
        self.sessionId = sessionId
        self.text = text
    }

    @MainActor
    public func perform() async throws -> some IntentResult {
        await ADEIntentCommandRegistry.dispatch(
            .replyToSession,
            payload: ["sessionId": sessionId, "text": text]
        )
        return .result()
    }
}

// MARK: - Control Widget intents (iOS 18+)

@available(iOS 18.0, *)
public struct OpenADEIntent: AppIntent {
    public static var title: LocalizedStringResource = "Open ADE"
    public static var description = IntentDescription("Open the ADE app.")
    /// Setting `openAppWhenRun = true` is enough for the Control Widget
    /// "Open ADE" button — iOS foregrounds the host app automatically.
    public static var openAppWhenRun: Bool = true

    public init() {}

    public func perform() async throws -> some IntentResult {
        return .result()
    }
}

/// Toggles the global "mute ADE pushes" flag stored in the shared App Group
/// container. When enabled, we mute for one hour — the Control Widget doesn't
/// offer a duration picker, so a fixed window keeps the UX predictable.
@available(iOS 18.0, *)
public struct ToggleMutePushIntent: SetValueIntent {
    public static var title: LocalizedStringResource = "Mute ADE notifications"
    public static var description = IntentDescription(
        "Toggle whether ADE push notifications are silenced."
    )

    /// Driven by `ControlWidgetToggle`'s two-way binding. `true` means "mute
    /// now for one hour"; `false` means "unmute".
    @Parameter(title: "Muted")
    public var value: Bool

    public init() {}

    public init(value: Bool) {
        self.value = value
    }

    @MainActor
    public func perform() async throws -> some IntentResult {
        let iso: String?
        if value {
            let oneHourFromNow = Date(timeIntervalSinceNow: 60 * 60)
            iso = ADEMutePreferences.setMute(until: oneHourFromNow)
        } else {
            iso = ADEMutePreferences.setMute(until: nil)
        }

        var payload: [String: Any] = [:]
        if let iso = iso {
            payload["muteUntil"] = iso
        } else {
            payload["muteUntil"] = NSNull()
        }
        await ADEIntentCommandRegistry.dispatch(.setMutePush, payload: payload)
        return .result()
    }
}
