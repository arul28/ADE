import AppIntents
import Foundation

/// Real implementations of the Live-Activity / Control-Widget intents.
///
/// Referenced by `ADELiveActivityViews.swift` (Live Activity buttons) and
/// `ADEControlWidget.swift` (Control Center widgets). This file is included
/// in the main ADE target and the ADEWidgets extension so the same symbols
/// resolve in every process that hosts interactive regions.
///
/// All `perform()` bodies route through a `ADEIntentCommandBridge` that the
/// main app registers at launch. We avoid importing `SyncService` here
/// because this file is compiled into the widget extension too, which doesn't
/// link `SyncService.swift`.
///
/// NOTE (naming): the file is still called `LiveActivityIntentsForward.swift`
/// for pbxproj-stability reasons; it now carries the real impls.

// MARK: - Cross-target command bridge

/// String-keyed mirror of `SyncService.RemoteCommandKind` — duplicated here
/// so the widget extension can reference it without importing the full
/// `SyncService` translation unit.
public enum ADEIntentCommandKind: String, Sendable {
    case approveSession
    case denySession
    case pauseSession
    case replyToSession
    case retryPrChecks
    case openPr
    /// Restart a failed session from the Live Activity "Failed" action row.
    case restartSession
}

/// Main-app adapter installed by `SyncService` at launch. The widget /
/// extension process never registers an implementation, so `perform()` becomes
/// a no-op there (which is correct — interactive intents from a Live Activity
/// always execute in the main app process anyway).
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

/// Restart a failed session from the Live Activity "Failed" attention state.
/// Dispatches `chat.restart` on the desktop, which aliases `resumeSession`
/// under the hood (see syncRemoteCommandService.ts).
@available(iOS 17.0, *)
public struct RestartSessionIntent: LiveActivityIntent {
    public static var title: LocalizedStringResource = "Restart"
    public static var description = IntentDescription(
        "Restart the failed ADE session."
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
        await ADEIntentCommandRegistry.dispatch(
            .restartSession,
            payload: ["sessionId": sessionId]
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
