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
        /// After the user dismisses an activity (swipe-off / long-press),
        /// suppress recreating an ambient one for this long. Attention signals
        /// (awaiting-input / failed / CI failing / etc.) override the cooldown
        /// because the user actually needs to see those.
        public var dismissedCooldown: TimeInterval

        public init(
            staleInterval: TimeInterval = 300,
            terminalDismissalDelay: TimeInterval = 120,
            dismissedCooldown: TimeInterval = 600
        ) {
            self.staleInterval = staleInterval
            self.terminalDismissalDelay = terminalDismissalDelay
            self.dismissedCooldown = dismissedCooldown
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
    /// Per-activity state listener that flips `lastUserDismissalAt` when iOS
    /// reports the user dismissed the LA from the Lock Screen / Dynamic Island.
    private var activityStateTask: Task<Void, Never>?
    /// ID of the activity the listener above is attached to. Lets reconcile
    /// skip re-attaching when we update the same activity repeatedly — the
    /// cancel/restart gap was a window where a `.dismissed` event could be lost.
    private var observedActivityId: String?
    /// Serializes ActivityKit mutations so updates/end/start calls do not race.
    private var reconcileTask: Task<Void, Never>?

    /// Last time the user dismissed our Live Activity. Within
    /// `Configuration.dismissedCooldown`, we suppress ambient recreation;
    /// attention signals always override.
    private var lastUserDismissalAt: Date?

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
        MainActor.assumeIsolated {
            pushTokenTask?.cancel()
            pushToStartTask?.cancel()
            activityStateTask?.cancel()
            reconcileTask?.cancel()
        }
    }

    // MARK: - Public entry point

    /// Called by the host whenever the set of active sessions changes.
    /// - Parameters:
    ///   - sessions: live sessions actively producing output (filtered to
    ///     `runtimeState == "running"` by `SyncService`).
    ///   - prs: optional PR snapshot for the pending-PR counts. Pass nil
    ///     to leave the PR counts unchanged from the previous tick.
    ///   - awaitingInputCount: chats waiting on user input — rendered as a
    ///     count chip rather than a roster row.
    ///   - idleCount: chats connected but not currently producing output.
    public func reconcile(
        with sessions: [AgentSnapshot],
        prs: [PrSnapshot] = [],
        awaitingInputCount: Int = 0,
        idleCount: Int = 0
    ) {
        let previousTask = reconcileTask
        reconcileTask = Task { @MainActor [weak self] in
            await previousTask?.value
            guard let self else { return }
            await self.reconcileNow(
                with: sessions,
                prs: prs,
                awaitingInputCount: awaitingInputCount,
                idleCount: idleCount
            )
        }
    }

    private func reconcileNow(
        with sessions: [AgentSnapshot],
        prs: [PrSnapshot],
        awaitingInputCount: Int,
        idleCount: Int
    ) async {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            await endAllActivities(dismissalPolicy: .immediate)
            return
        }

        let desiredState = makeContentState(
            sessions: sessions,
            prs: prs,
            awaitingInputCount: awaitingInputCount,
            idleCount: idleCount
        )

        // If there's literally nothing to show, make sure no activity is
        // visible and return. Counts alone (awaiting / idle) don't justify
        // surfacing a Live Activity — only an actively-running roster, an
        // attention signal, or pending PRs do.
        if sessions.isEmpty && desiredState.attention == nil && desiredState.pendingPrCount == 0 {
            await endAllActivities(dismissalPolicy: .after(Date().addingTimeInterval(configuration.terminalDismissalDelay)))
            return
        }

        let existing = Activity<ADESessionAttributes>.activities
        if let canonical = canonicalActivity(from: existing) {
            // End everything except the canonical; update it.
            for stray in existing where stray.id != canonical.id {
                await stray.end(nil, dismissalPolicy: .immediate)
            }
            await update(canonical, to: desiredState)
            observeActivityStateUpdates(for: canonical)
        } else if shouldStartFreshActivity(for: desiredState) {
            await startActivity(with: desiredState)
        }
        // else: user dismissed recently and there's no urgent reason to re-summon.
        // Home widget still reflects state; the LA stays out of the way.
    }

    /// Guard against re-summoning a freshly-dismissed Live Activity. Within
    /// the cooldown window, ambient flavors (running roster, count summary)
    /// stay suppressed — but attention signals (awaiting-input / failed /
    /// CI failing / review-requested / merge-ready) override it because the
    /// user actually needs to see those.
    private func shouldStartFreshActivity(
        for state: ADESessionAttributes.ContentState
    ) -> Bool {
        guard let dismissedAt = lastUserDismissalAt else { return true }
        if Date().timeIntervalSince(dismissedAt) >= configuration.dismissedCooldown {
            lastUserDismissalAt = nil
            return true
        }
        // Attention signals (awaiting-input / failed / CI failing / review-requested
        // / merge-ready) override the cooldown — the user needs to see these even
        // if they dismissed an ambient activity recently.
        if state.attention != nil {
            lastUserDismissalAt = nil
            return true
        }
        return false
    }

    // MARK: - State construction

    private func makeContentState(
        sessions: [AgentSnapshot],
        prs: [PrSnapshot],
        awaitingInputCount: Int = 0,
        idleCount: Int = 0
    ) -> ADESessionAttributes.ContentState {
        // Prioritise: failed first (rare, urgent), then most-recently-active.
        // Awaiting-input is no longer in this list (rolled into the count chip).
        let sorted = sessions.sorted { a, b in
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
            awaitingInputCount: awaitingInputCount,
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
            awaitingInputCount: awaitingInputCount,
            idleCount: idleCount,
            generatedAt: Date()
        )
    }

    private func selectAttention(
        sessions: [AgentSnapshot],
        prs: [PrSnapshot],
        awaitingInputCount: Int,
        failingChecks: Int,
        awaitingReviews: Int,
        mergeReady: Int
    ) -> ADESessionAttributes.ContentState.Attention? {
        if awaitingInputCount > 0 {
            let title = awaitingInputCount == 1
                ? "1 chat waiting for input"
                : "\(awaitingInputCount) chats waiting for input"
            return .init(
                kind: .awaitingInput,
                title: title,
                subtitle: "Tap to respond"
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
            observeActivityStateUpdates(for: activity)
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
        activityStateTask?.cancel()
        activityStateTask = nil
        observedActivityId = nil
    }

    // MARK: - Push tokens

    /// Observe the user-dismissal signal on a live activity. ActivityKit flips
    /// state to `.dismissed` when the user swipes the LA away on the Lock
    /// Screen or long-press → Hide on Dynamic Island. We record the timestamp
    /// so `shouldStartFreshActivity(for:)` can suppress recreation.
    ///
    /// Idempotent — if we're already attached to this activity, skip. Prevents
    /// the cancel/restart race where a `.dismissed` event could fire during
    /// the gap and be lost.
    private func observeActivityStateUpdates(for activity: Activity<ADESessionAttributes>) {
        if observedActivityId == activity.id, activityStateTask != nil { return }
        activityStateTask?.cancel()
        observedActivityId = activity.id
        activityStateTask = Task { @MainActor [weak self] in
            for await newState in activity.activityStateUpdates {
                switch newState {
                case .dismissed:
                    self?.lastUserDismissalAt = Date()
                case .ended, .stale:
                    // Ended-by-us or system-staled — leave dismissal flag alone.
                    break
                case .active:
                    // Re-activated (e.g. via a new request after cooldown).
                    self?.lastUserDismissalAt = nil
                @unknown default:
                    break
                }
            }
        }
    }

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
