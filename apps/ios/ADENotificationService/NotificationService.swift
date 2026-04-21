import UserNotifications

/// APNs `UNNotificationServiceExtension` used by ADE to decorate inbound
/// remote pushes before they are presented to the user.
///
/// Responsibilities:
/// - Prefix the title with the provider brand (e.g. "Claude · …") when the
///   payload includes a `providerSlug` hint.
/// - Set `threadIdentifier` so the system groups pushes per session / PR.
/// - Raise `interruptionLevel` / `relevanceScore` for time-sensitive
///   categories (awaiting input).
///
/// Never logs payload text — APNs content can contain model / user-authored
/// strings.
final class NotificationService: UNNotificationServiceExtension {
    var contentHandler: ((UNNotificationContent) -> Void)?
    var bestAttemptContent: UNMutableNotificationContent?

    override func didReceive(_ request: UNNotificationRequest,
                             withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        self.contentHandler = contentHandler
        bestAttemptContent = request.content.mutableCopy() as? UNMutableNotificationContent
        guard let content = bestAttemptContent else {
            contentHandler(request.content)
            return
        }

        let userInfo = content.userInfo

        // 1) Brand-prefix the title if providerSlug is provided.
        if let slug = userInfo["providerSlug"] as? String, !slug.isEmpty {
            let cap = slug.prefix(1).uppercased() + slug.dropFirst()
            if !content.title.lowercased().hasPrefix(cap.lowercased()) {
                content.title = "\(cap) · \(content.title)"
            }
        }

        // 2) Thread identifier for grouping by session / PR.
        if let sessionId = userInfo["sessionId"] as? String, !sessionId.isEmpty {
            content.threadIdentifier = "session-\(sessionId)"
        } else if let prNumber = userInfo["prNumber"] {
            content.threadIdentifier = "pr-\(prNumber)"
        }

        // 3) Interruption level / relevance for time-sensitive categories.
        let categoryId = content.categoryIdentifier
        if #available(iOS 15.0, *) {
            if categoryId == "CHAT_AWAITING_INPUT" {
                content.interruptionLevel = .timeSensitive
                content.relevanceScore = 1.0
            } else if categoryId.hasPrefix("PR_") || categoryId == "CHAT_FAILED" {
                content.interruptionLevel = .active
                content.relevanceScore = 0.7
            } else {
                content.interruptionLevel = .active
                content.relevanceScore = 0.5
            }
        }

        contentHandler(content)
    }

    override func serviceExtensionTimeWillExpire() {
        if let handler = contentHandler, let content = bestAttemptContent {
            handler(content)
        }
    }
}
