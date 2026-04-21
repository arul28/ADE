import UserNotifications

/// Declares the `UNNotificationCategory` set backing every push ADE delivers.
///
/// Categories map 1:1 to the categories referenced by the desktop
/// `notificationEventBus` and the iOS AppDelegate response handler. Adding a
/// new category here also requires a matching action-identifier branch in
/// `AppDelegate.userNotificationCenter(_:didReceive:withCompletionHandler:)`.
enum NotificationCategories {
  /// Category identifiers kept as constants so AppDelegate and the
  /// notification-service extension can reference them without stringly-typed
  /// duplication.
  enum Identifier {
    static let chatAwaitingInput = "CHAT_AWAITING_INPUT"
    static let chatFailed = "CHAT_FAILED"
    static let chatTurnCompleted = "CHAT_TURN_COMPLETED"
    static let prCiFailing = "PR_CI_FAILING"
    static let prReviewRequested = "PR_REVIEW_REQUESTED"
    static let prChangesRequested = "PR_CHANGES_REQUESTED"
    static let prMergeReady = "PR_MERGE_READY"
    static let ctoSubagentFinished = "CTO_SUBAGENT_FINISHED"
    static let ctoMissionPhase = "CTO_MISSION_PHASE"
    static let systemAlert = "SYSTEM_ALERT"
  }

  /// Action identifiers referenced by `AppDelegate`'s response handler.
  enum Action {
    static let approve = "APPROVE"
    static let deny = "DENY"
    static let reply = "REPLY"
    static let open = "OPEN"
    static let restart = "RESTART"
    static let openPr = "OPEN_PR"
    static let retryChecks = "RETRY_CHECKS"
  }

  /// Build and register the full category set with the notification center.
  /// Call once during app launch, before requesting authorization.
  static func register() {
    UNUserNotificationCenter.current().setNotificationCategories(makeCategorySet())
  }

  static func makeCategorySet() -> Set<UNNotificationCategory> {
    let approve = UNNotificationAction(
      identifier: Action.approve,
      title: "Approve",
      options: [.authenticationRequired, .foreground]
    )

    let deny = UNNotificationAction(
      identifier: Action.deny,
      title: "Deny",
      options: [.destructive]
    )

    let reply = UNTextInputNotificationAction(
      identifier: Action.reply,
      title: "Reply",
      options: [],
      textInputButtonTitle: "Send",
      textInputPlaceholder: "Message"
    )

    let open = UNNotificationAction(
      identifier: Action.open,
      title: "Open",
      options: [.foreground]
    )

    let restart = UNNotificationAction(
      identifier: Action.restart,
      title: "Restart",
      options: []
    )

    let openPr = UNNotificationAction(
      identifier: Action.openPr,
      title: "Open PR",
      options: [.foreground]
    )

    let retryChecks = UNNotificationAction(
      identifier: Action.retryChecks,
      title: "Retry checks",
      options: []
    )

    let chatAwaitingInput = UNNotificationCategory(
      identifier: Identifier.chatAwaitingInput,
      actions: [approve, deny, reply],
      intentIdentifiers: [],
      options: [.customDismissAction]
    )

    let chatFailed = UNNotificationCategory(
      identifier: Identifier.chatFailed,
      actions: [open, restart],
      intentIdentifiers: [],
      options: []
    )

    let chatTurnCompleted = UNNotificationCategory(
      identifier: Identifier.chatTurnCompleted,
      actions: [open],
      intentIdentifiers: [],
      options: []
    )

    let prCiFailing = UNNotificationCategory(
      identifier: Identifier.prCiFailing,
      actions: [openPr, retryChecks],
      intentIdentifiers: [],
      options: []
    )

    let prReviewRequested = UNNotificationCategory(
      identifier: Identifier.prReviewRequested,
      actions: [openPr],
      intentIdentifiers: [],
      options: []
    )

    let prChangesRequested = UNNotificationCategory(
      identifier: Identifier.prChangesRequested,
      actions: [openPr],
      intentIdentifiers: [],
      options: []
    )

    let prMergeReady = UNNotificationCategory(
      identifier: Identifier.prMergeReady,
      actions: [openPr],
      intentIdentifiers: [],
      options: []
    )

    let ctoSubagentFinished = UNNotificationCategory(
      identifier: Identifier.ctoSubagentFinished,
      actions: [open],
      intentIdentifiers: [],
      options: []
    )

    let ctoMissionPhase = UNNotificationCategory(
      identifier: Identifier.ctoMissionPhase,
      actions: [open],
      intentIdentifiers: [],
      options: []
    )

    let systemAlert = UNNotificationCategory(
      identifier: Identifier.systemAlert,
      actions: [open],
      intentIdentifiers: [],
      options: []
    )

    return [
      chatAwaitingInput,
      chatFailed,
      chatTurnCompleted,
      prCiFailing,
      prReviewRequested,
      prChangesRequested,
      prMergeReady,
      ctoSubagentFinished,
      ctoMissionPhase,
      systemAlert,
    ]
  }
}
