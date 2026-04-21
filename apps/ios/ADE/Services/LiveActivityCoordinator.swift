import ActivityKit
import Combine
import Foundation

/// Push-token kind reported up to the host so the desktop can tell which
/// APNs topic / token it should use for a given payload.
public enum PushTokenKind: String, Sendable {
    /// Regular user-visible alert topic (bundle id).
    case alert
    /// Live Activity push-to-start token (iOS 17.2+).
    case activityStart
    /// Per-activity `pushTokenUpdates` token.
    case activityUpdate
}

/// Host contract — wired to `SyncService` by the iOS app-wiring layer.
/// The coordinator deliberately does not import `SyncService` so it can be
/// unit-tested in isolation.
@MainActor
public protocol LiveActivityHost: AnyObject {
    /// Snapshot of the sessions that should currently drive the workspace
    /// Live Activity. `reconcile(...)` consults this on each tick.
    var activeSessions: [AgentSnapshot] { get }

    /// Upload an APNs token acquired locally — alert token, push-to-start
    /// token, or per-activity update token.
    func sendPushToken(
        _ token: String,
        kind: PushTokenKind,
        sessionId: String?
    ) async
}

/// Owns the lifecycle of the **single** workspace `Activity<ADESessionAttributes>`.
///
/// Design:
/// - Exactly one activity exists per device. If more than one is somehow
///   alive (e.g. the app was updated from an older per-session build), the
///   coordinator ends all but the newest on its next reconcile.
/// - The `ContentState` aggregates all active sessions + pending PR counts
///   + the single most important `Attention` (awaiting input / failed /
///   CI-failing / review-requested / merge-ready). Views adapt to whatever
///   is most relevant right now.
/// - When nothing is active (no running sessions, no attention), we tear
///   down the activity. Live Activities are meant to be for time-sensitive
///   events, not ambient state.
@available(iOS 16.2, *)
@MainActor
public final class LiveActivityCoordinator: ObservableObject {
    // MARK: - Types

    public struct Configuration {
        /// How far in the future we push `staleDate` on every update. A
        /// silent desktop makes the activity visibly stale after this window.
        public var staleInterval: TimeInterval
        /// How long to keep a terminal activity around before the OS
        /// dismisses it automatically.
        public var terminalDismissalDelay: TimeInterval

        public init(
            staleInterval: TimeInterval = 300,
            terminalDismissalDelay: TimeInterval = 120
        ) {
            self.staleInterval = staleInterval
            self.terminalDismissalDelay = terminalDismissalDelay
        }
    }

    // MARK: - State

    private weak var host: LiveActivityHost?
    private let configuration: Configuration
    private let workspaceName: String

    /// One listener task for push-token updates on the current activity.
    private var pushTokenTask: Task<Void, Never>?
    /// Push-to-start listener (iOS 17.2+).
    private var pushToStartTask: Task<Void, Never>?

    // MARK: - Init

    public init(
        host: LiveActivityHost,
        workspaceName: String = "Workspace",
        configuration: Configuration = Configuration()
    ) {
        self.host = host
        self.workspaceName = workspaceName
        self.configuration = configuration

        startPushToStartListenerIfPossible()

        // Aggressive cleanup: older builds ran one activity per chat
        // session, leaving the Lock Screen littered with per-chat pills.
        // End anything we find on launch so the user gets a clean slate —
        // the first `reconcile(...)` from SyncService will recreate a
        // single workspace activity if warranted.
        Task { await endAllActivities(dismissalPolicy: .immediate) }
    }

    deinit {
        pushTokenTask?.cancel()
        pushToStartTask?.cancel()
    }

    // MARK: - Public entry point

    /// Called by the host whenever the set of active sessions changes.
    /// - Parameters:
    ///   - sessions: live sessions (already pre-filtered for staleness by
    ///     `SyncService.refreshActiveSessionsAndSnapshot`).
    ///   - prs: optional PR snapshot for the pending-PR counts. Pass nil
    ///     to leave the PR counts unchanged from the previous tick.
    public func reconcile(
        with sessions: [AgentSnapshot],
        prs: [PrSnapshot] = []
    ) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            Task { await endAllActivities(dismissalPolicy: .immediate) }
            return
        }

        let desiredState = makeContentState(sessions: sessions, prs: prs)

        // If there's literally nothing to show, make sure no activity is
        // visible and return.
        if sessions.isEmpty && desiredState.attention == nil && desiredState.pendingPrCount == 0 {
            Task { await endAllActivities(dismissalPolicy: .after(Date().addingTimeInterval(configuration.terminalDismissalDelay))) }
            return
        }

        let existing = Activity<ADESessionAttributes>.activities
        if let canonical = canonicalActivity(from: existing) {
            // End everything except the canonical; update it.
            for stray in existing where stray.id != canonical.id {
                Task { await stray.end(nil, dismissalPolicy: .immediate) }
            }
            Task { await update(canonical, to: desiredState) }
        } else {
            Task { await startActivity(with: desiredState) }
        }
    }

    // MARK: - State construction

    private func makeContentState(
        sessions: [AgentSnapshot],
        prs: [PrSnapshot]
    ) -> ADESessionAttributes.ContentState {
        // Prioritise: awaiting-input first, then failed, then recently-started.
        let sorted = sessions.sorted { a, b in
            if a.awaitingInput != b.awaitingInput { return a.awaitingInput }
            if isFailed(a) != isFailed(b) { return isFailed(a) }
            return a.lastActivityAt > b.lastActivityAt
        }

        let activeSessions: [ADESessionAttributes.ContentState.ActiveSession] = sorted.map { snap in
            .init(
                id: snap.sessionId,
                providerSlug: snap.provider,
                title: snap.title ?? snap.sessionId,
                isAwaitingInput: snap.awaitingInput,
                isFailed: isFailed(snap),
                startedAt: snap.lastActivityAt.addingTimeInterval(-Double(snap.elapsedSeconds)),
                progress: snap.progress,
                preview: snap.preview
            )
        }

        // PR tallies — simple counts, used in the header glance row.
        var failingChecks = 0
        var awaitingReviews = 0
        var mergeReady = 0
        for pr in prs {
            if pr.checks == "failing" { failingChecks += 1 }
            if pr.review == "pending" || pr.review == "changes_requested" { awaitingReviews += 1 }
            if pr.mergeReady { mergeReady += 1 }
        }

        // The single most important attention signal. Priority order:
        // awaiting-input > failed > CI-failing > review-requested > merge-ready.
        let attention: ADESessionAttributes.ContentState.Attention? = selectAttention(
            sessions: sorted,
            prs: prs,
            failingChecks: failingChecks,
            awaitingReviews: awaitingReviews,
            mergeReady: mergeReady
        )

        return .init(
            sessions: activeSessions,
            attention: attention,
            failingCheckCount: failingChecks,
            awaitingReviewCount: awaitingReviews,
            mergeReadyCount: mergeReady,
            generatedAt: Date()
        )
    }

    private func selectAttention(
        sessions: [AgentSnapshot],
        prs: [PrSnapshot],
        failingChecks: Int,
        awaitingReviews: Int,
        mergeReady: Int
    ) -> ADESessionAttributes.ContentState.Attention? {
        if let awaiting = sessions.first(where: { $0.awaitingInput }) {
            // Note: itemId isn't on AgentSnapshot today. Push-notification
            // Approve actions carry itemId through APNs; Live Activity
            // buttons currently dispatch without it and rely on the server
            // to fall back to the most-recent pending input per session.
            // TODO: plumb itemId through the snapshot so LA buttons work
            // directly without the server-side fallback.
            return .init(
                kind: .awaitingInput,
                title: humanTitle(for: awaiting),
                subtitle: "Approval needed",
                providerSlug: awaiting.provider,
                sessionId: awaiting.sessionId
            )
        }
        if let failed = sessions.first(where: { isFailed($0) }) {
            return .init(
                kind: .failed,
                title: humanTitle(for: failed),
                subtitle: "Session failed",
                providerSlug: failed.provider,
                sessionId: failed.sessionId
            )
        }
        if failingChecks > 0, let pr = prs.first(where: { $0.checks == "failing" }) {
            return .init(
                kind: .ciFailing,
                title: "PR #\(pr.number) · \(pr.title)",
                subtitle: "\(failingChecks) check\(failingChecks == 1 ? "" : "s") failing",
                prId: pr.id,
                prNumber: pr.number
            )
        }
        if awaitingReviews > 0, let pr = prs.first(where: {
            $0.review == "pending" || $0.review == "changes_requested"
        }) {
            return .init(
                kind: .reviewRequested,
                title: "PR #\(pr.number) · \(pr.title)",
                subtitle: pr.review == "changes_requested" ? "Changes requested" : "Review requested",
                prId: pr.id,
                prNumber: pr.number
            )
        }
        if mergeReady > 0, let pr = prs.first(where: { $0.mergeReady }) {
            return .init(
                kind: .mergeReady,
                title: "PR #\(pr.number) · \(pr.title)",
                subtitle: "Ready to merge",
                prId: pr.id,
                prNumber: pr.number
            )
        }
        return nil
    }

    private func humanTitle(for snap: AgentSnapshot) -> String {
        let provider = snap.provider.capitalized
        let title = snap.title?.isEmpty == false ? snap.title! : snap.sessionId
        return "\(provider) · \(title)"
    }

    private func isFailed(_ snap: AgentSnapshot) -> Bool {
        let s = snap.status.lowercased()
        return s == "failed" || s == "error"
    }

    // MARK: - Activity lifecycle

    private func canonicalActivity(
        from activities: [Activity<ADESessionAttributes>]
    ) -> Activity<ADESessionAttributes>? {
        // Pick the newest (largest generatedAt) as the keeper.
        activities.max { a, b in
            a.content.state.generatedAt < b.content.state.generatedAt
        }
    }

    private func startActivity(with state: ADESessionAttributes.ContentState) async {
        let attrs = ADESessionAttributes(workspaceName: workspaceName)
        let content = ActivityContent(
            state: state,
            staleDate: Date().addingTimeInterval(configuration.staleInterval)
        )
        do {
            let activity = try Activity<ADESessionAttributes>.request(
                attributes: attrs,
                content: content,
                pushType: .token
            )
            observePushTokenUpdates(for: activity)
        } catch {
            // Common failure modes: user disabled Live Activities in
            // Settings, the app was background-launched without a valid
            // foreground gesture, or the budget is exhausted. Swallow —
            // the next reconcile will try again.
        }
    }

    private func update(
        _ activity: Activity<ADESessionAttributes>,
        to state: ADESessionAttributes.ContentState
    ) async {
        let content = ActivityContent(
            state: state,
            staleDate: Date().addingTimeInterval(configuration.staleInterval)
        )
        await activity.update(content)
    }

    private func endAllActivities(
        dismissalPolicy: ActivityUIDismissalPolicy
    ) async {
        for activity in Activity<ADESessionAttributes>.activities {
            await activity.end(nil, dismissalPolicy: dismissalPolicy)
        }
        pushTokenTask?.cancel()
        pushTokenTask = nil
    }

    // MARK: - Push tokens

    private func observePushTokenUpdates(for activity: Activity<ADESessionAttributes>) {
        pushTokenTask?.cancel()
        pushTokenTask = Task { [weak self] in
            for await tokenData in activity.pushTokenUpdates {
                let hex = tokenData.map { String(format: "%02x", $0) }.joined()
                await self?.host?.sendPushToken(
                    hex,
                    kind: .activityUpdate,
                    sessionId: nil
                )
            }
        }
    }

    private func startPushToStartListenerIfPossible() {
        guard #available(iOS 17.2, *) else { return }
        pushToStartTask = Task { [weak self] in
            for await tokenData in Activity<ADESessionAttributes>.pushToStartTokenUpdates {
                let hex = tokenData.map { String(format: "%02x", $0) }.joined()
                await self?.host?.sendPushToken(
                    hex,
                    kind: .activityStart,
                    sessionId: nil
                )
            }
        }
    }
}
