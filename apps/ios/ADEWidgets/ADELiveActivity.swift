import ActivityKit
import SwiftUI
import WidgetKit

/// Attributes for the ADE **workspace** Live Activity.
///
/// The activity is intentionally workspace-scoped, not per-session: Apple's
/// HIG discourages multiple simultaneous activities for the same app and
/// the Lock Screen quickly becomes unreadable when every chat spawns its
/// own tile. The `ContentState` carries everything the views need to
/// adapt to one-chat-focused vs multi-chat-roster vs attention-demanding
/// presentations.
///
/// Stable attributes key the activity so `.update(...)` targets the right
/// instance across the 8h Apple-enforced budget.
public struct ADESessionAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        /// Single active chat session rendered in the workspace roster.
        public struct ActiveSession: Codable, Hashable, Identifiable {
            public var id: String
            public var providerSlug: String
            public var title: String
            /// Drives the coloured dot + progress feel on the roster row.
            public var isAwaitingInput: Bool
            public var isFailed: Bool
            public var startedAt: Date
            public var progress: Double?
            public var preview: String?

            public init(
                id: String,
                providerSlug: String,
                title: String,
                isAwaitingInput: Bool,
                isFailed: Bool,
                startedAt: Date,
                progress: Double? = nil,
                preview: String? = nil
            ) {
                self.id = id
                self.providerSlug = providerSlug
                self.title = title
                self.isAwaitingInput = isAwaitingInput
                self.isFailed = isFailed
                self.startedAt = startedAt
                self.progress = progress
                self.preview = preview
            }
        }

        /// The single most important "do something" signal in the workspace.
        /// When set, the island + lock screen surface it with action chips.
        public struct Attention: Codable, Hashable {
            public enum Kind: String, Codable, Hashable, Sendable {
                case awaitingInput
                case failed
                case ciFailing
                case reviewRequested
                case mergeReady
            }
            public var kind: Kind
            public var title: String
            public var subtitle: String?
            public var providerSlug: String?
            public var sessionId: String?
            public var itemId: String?
            public var prId: String?
            public var prNumber: Int?

            public init(
                kind: Kind,
                title: String,
                subtitle: String? = nil,
                providerSlug: String? = nil,
                sessionId: String? = nil,
                itemId: String? = nil,
                prId: String? = nil,
                prNumber: Int? = nil
            ) {
                self.kind = kind
                self.title = title
                self.subtitle = subtitle
                self.providerSlug = providerSlug
                self.sessionId = sessionId
                self.itemId = itemId
                self.prId = prId
                self.prNumber = prNumber
            }
        }

        /// Sorted by relevance (awaiting-input first, then running, then stale).
        public var sessions: [ActiveSession]
        /// Nil when nothing urgent; presence flips compact/expanded layouts
        /// into the attention-first mode.
        public var attention: Attention?
        public var failingCheckCount: Int
        public var awaitingReviewCount: Int
        public var mergeReadyCount: Int
        public var generatedAt: Date

        public init(
            sessions: [ActiveSession],
            attention: Attention?,
            failingCheckCount: Int,
            awaitingReviewCount: Int,
            mergeReadyCount: Int,
            generatedAt: Date
        ) {
            self.sessions = sessions
            self.attention = attention
            self.failingCheckCount = failingCheckCount
            self.awaitingReviewCount = awaitingReviewCount
            self.mergeReadyCount = mergeReadyCount
            self.generatedAt = generatedAt
        }

        // Derived helpers used by views.
        public var hasAttention: Bool { attention != nil }
        public var pendingPrCount: Int {
            failingCheckCount + awaitingReviewCount + mergeReadyCount
        }
        /// The single session to "focus" on when there's no attention.
        /// Awaiting-input always wins, then failures, then the newest running.
        public var focusedSession: ActiveSession? {
            if let awaiting = sessions.first(where: { $0.isAwaitingInput }) { return awaiting }
            if let failed = sessions.first(where: { $0.isFailed }) { return failed }
            return sessions.first
        }
    }

    /// Stable identifier for the workspace activity. Since there is only
    /// ever one active per device, a sentinel value is fine — but naming
    /// it gives debuggers + logs something readable.
    public let workspaceId: String
    public let workspaceName: String

    public init(workspaceId: String = "default", workspaceName: String) {
        self.workspaceId = workspaceId
        self.workspaceName = workspaceName
    }
}

// MARK: - Widget

@available(iOS 16.2, *)
public struct ADELiveActivity: Widget {
    public init() {}

    public var body: some WidgetConfiguration {
        ActivityConfiguration(for: ADESessionAttributes.self) { ctx in
            // Lock Screen / banner presentation.
            WorkspaceLockScreenPresentation(state: ctx.state, attrs: ctx.attributes)
                .activityBackgroundTint(WorkspaceStyle.lockBackgroundTint(for: ctx.state))
                .activitySystemActionForegroundColor(.primary)
        } dynamicIsland: { ctx in
            DynamicIsland {
                // Expanded regions long-press / presented state.
                DynamicIslandExpandedRegion(.leading) {
                    WorkspaceExpandedLeading(state: ctx.state)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    WorkspaceExpandedTrailing(state: ctx.state)
                }
                DynamicIslandExpandedRegion(.center) {
                    WorkspaceExpandedCenter(state: ctx.state, attrs: ctx.attributes)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    WorkspaceExpandedBottom(state: ctx.state)
                }
            } compactLeading: {
                WorkspaceCompactLeading(state: ctx.state)
            } compactTrailing: {
                WorkspaceCompactTrailing(state: ctx.state)
            } minimal: {
                WorkspaceMinimalGlyph(state: ctx.state)
            }
            .keylineTint(WorkspaceStyle.keylineTint(for: ctx.state))
            .widgetURL(URL(string: WorkspaceStyle.primaryDeepLink(for: ctx.state)))
        }
    }
}
