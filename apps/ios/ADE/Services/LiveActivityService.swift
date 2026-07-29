import ActivityKit
import Foundation

enum LiveActivityTokenRoute: Equatable {
    case accountOnly
    case pairedMachine
}

func liveActivityTokenRoute(accountWide: Bool) -> LiveActivityTokenRoute {
    accountWide ? .accountOnly : .pairedMachine
}

enum AccountWideActivityObservationAction: Equatable {
    /// Clerk has not resolved the cached session yet. Preserve the activity and
    /// attach its token observer after the account boundary becomes determinate.
    case waitForAccount
    case observe
    /// A real sign-out/account switch is a privacy boundary.
    case end
}

func accountWideActivityObservationAction(
    phase: AccountService.Phase,
    accountObserversSuspended: Bool
) -> AccountWideActivityObservationAction {
    if accountObserversSuspended {
        return .end
    }
    switch phase {
    case .loading:
        return .waitForAccount
    case .signedIn:
        return .observe
    case .signedOut, .unconfigured:
        return .end
    }
}

func accountWideActivityMatchesCurrentOwnership(
    attributesEpoch: Int?,
    contentEpoch: Int?,
    currentOwnership: AccountDeviceOwnershipState
) -> Bool {
    adeAccountWideActivityMatchesCurrentOwnership(
        attributesEpoch: attributesEpoch,
        contentEpoch: contentEpoch,
        currentEpoch: currentOwnership.ownershipEpoch,
        hasCurrentOwner: currentOwnership.ownerId != nil
    )
}

struct AccountWideActivityCandidate: Equatable {
    let id: String
    let updatedAt: Double
}

/// ActivityKit can briefly retain two account-wide activities when a
/// push-to-start retry races the first activity's token handoff. ADE only has
/// one logical account activity, so keep the freshest deterministically.
func preferredAccountWideActivityId(
    _ candidates: [AccountWideActivityCandidate]
) -> String? {
    candidates.max {
        if $0.updatedAt != $1.updatedAt {
            return $0.updatedAt < $1.updatedAt
        }
        return $0.id < $1.id
    }?.id
}

struct PendingAccountActivityTokenRegistration: Codable, Equatable {
    let deviceId: String
    let activityId: String
    let token: String
    /// Explicitly persisted so a retry can never be reinterpreted as a legacy
    /// machine-scoped token after a relaunch or account/network failure.
    let accountWide: Bool
    let updatedAt: Date
}

struct AccountActivityTokenRegistrationStore {
    private let defaults: UserDefaults
    private let key: String

    init(
        defaults: UserDefaults = ADESharedContainer.defaults,
        key: String = ADESharedContainer.pendingAccountActivityTokenKey
    ) {
        self.defaults = defaults
        self.key = key
    }

    var pending: PendingAccountActivityTokenRegistration? {
        guard let data = defaults.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(PendingAccountActivityTokenRegistration.self, from: data)
    }

    @discardableResult
    func persist(
        deviceId: String,
        activityId: String,
        token: String,
        now: Date = Date()
    ) -> PendingAccountActivityTokenRegistration? {
        let normalizedDeviceId = deviceId.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedActivityId = activityId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedDeviceId.isEmpty, !normalizedActivityId.isEmpty else { return nil }
        let registration = PendingAccountActivityTokenRegistration(
            deviceId: normalizedDeviceId,
            activityId: normalizedActivityId,
            token: token.trimmingCharacters(in: .whitespacesAndNewlines),
            accountWide: true,
            updatedAt: now
        )
        guard let data = try? JSONEncoder().encode(registration) else { return nil }
        defaults.set(data, forKey: key)
        defaults.synchronize()
        return registration
    }

    func clear(ifMatching registration: PendingAccountActivityTokenRegistration? = nil) {
        if let registration, pending != registration { return }
        defaults.removeObject(forKey: key)
        defaults.synchronize()
    }
}

/// Bridges ActivityKit's push-token machinery to ADE's push relays so the
/// "agent runs" Live Activity is driven entirely by remote pushes:
///
///  * `pushToStartTokenUpdates` → reported in `push.registerDevice` so the relay
///    can *start* an activity remotely (no local start needed).
///  * each activity's `pushTokenUpdates` → reported via
///    `push.reportLiveActivityToken` so the relay can *update* its content-state.
///
/// On foreground it re-attaches observers (which re-yield current tokens) and
/// ends any machine-scoped activity that belongs to a host we're no longer
/// paired with while preserving the signed-in account aggregate.
@MainActor
final class LiveActivityService {
    static let shared = LiveActivityService()

    /// The single logical activity id the brain/relay keys tokens under. There
    /// is one "agent runs" activity per paired machine; ActivityKit's per-run
    /// activity ids are collapsed to this stable value in reports.
    static let activityId = "agent-runs"

    private var pushToStartTask: Task<Void, Never>?
    private var activityUpdatesTask: Task<Void, Never>?
    private var authorizationUpdatesTask: Task<Void, Never>?
    private var perActivityTokenTasks: [String: Task<Void, Never>] = [:]
    private var started = false
    private var accountObserversSuspended = false
    private var accountReconciliationInFlight = false
    private var accountReconciliationPending = false
    private var pendingPreferredAccountActivityId: String?
    private let accountTokenStore = AccountActivityTokenRegistrationStore()
    private let accountTokenQueue =
        LatestAccountRegistrationQueue<PendingAccountActivityTokenRegistration>()

    private init() {}

    // MARK: - Lifecycle

    /// Begin observing push-to-start and per-activity tokens. Idempotent — safe
    /// to call from pairing success and every foreground transition.
    func start() {
        observeAuthorizationUpdates()
        PushNotificationService.shared.updateLiveActivitiesAuthorization(
            ActivityAuthorizationInfo().areActivitiesEnabled
        )
        startActivityObserversIfAuthorized()
    }

    private func startActivityObserversIfAuthorized() {
        guard !started else { return }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        started = true
        publishCurrentPushToStartToken()
        observePushToStartToken()
        observeActivityUpdates()
        var shouldReconcileAccountActivity = false
        for activity in Activity<ADEAgentRunsAttributes>.activities {
            if activity.attributes.isAccountWide {
                switch accountWideActivityObservationAction(
                    phase: AccountService.shared.phase,
                    accountObserversSuspended: accountObserversSuspended
                ) {
                case .waitForAccount:
                    continue
                case .observe:
                    shouldReconcileAccountActivity = true
                case .end:
                    Task { @MainActor [weak self] in
                        self?.perActivityTokenTasks[activity.id]?.cancel()
                        self?.perActivityTokenTasks[activity.id] = nil
                        await activity.end(nil, dismissalPolicy: .immediate)
                    }
                }
                continue
            }
            observePushToken(for: activity)
        }
        if shouldReconcileAccountActivity {
            scheduleAccountWideActivityReconciliation()
        }
    }

    /// Foreground hook (called from `SyncService.handleForegroundTransition`).
    /// Re-asserts observers, re-reports live tokens, and reaps orphaned
    /// activities from machines we no longer talk to.
    func handleForegroundTransition() async {
        start()
        if ActivityAuthorizationInfo().areActivitiesEnabled {
            publishCurrentPushToStartToken()
        }
        await endOrphanedActivities()
        await retryPendingAccountWideTokenRegistration()
        await reconcileAccountWideActivityTarget()
        for activity in Activity<ADEAgentRunsAttributes>.activities
        where !activity.attributes.isAccountWide {
            observePushToken(for: activity)
        }
    }

    /// Reattach account observers only after Clerk has established the local
    /// account boundary. This covers launch ordering where ActivityKit starts
    /// before cached account restoration finishes.
    func handleAccountSignIn() async {
        start()
        accountObserversSuspended = false
        if ActivityAuthorizationInfo().areActivitiesEnabled {
            publishCurrentPushToStartToken()
        }
        await retryPendingAccountWideTokenRegistration()
        await reconcileAccountWideActivityTarget()
    }

    /// End every running agent-runs activity. `immediate` dismisses without the
    /// system's lingering banner — used on unpair / forget.
    func endAll(immediate: Bool = false) async {
        let policy: ActivityUIDismissalPolicy = immediate ? .immediate : .default
        for activity in Activity<ADEAgentRunsAttributes>.activities {
            await activity.end(nil, dismissalPolicy: policy)
        }
        for task in perActivityTokenTasks.values { task.cancel() }
        perActivityTokenTasks.removeAll()
    }

    /// End only legacy machine-scoped activities. A user can forget the
    /// currently connected Mac while remaining signed in to an account that
    /// still has work on other machines; its aggregate activity must survive.
    func endMachineScopedActivities(immediate: Bool = false) async {
        let policy: ActivityUIDismissalPolicy = immediate ? .immediate : .default
        for activity in Activity<ADEAgentRunsAttributes>.activities
        where !activity.attributes.isAccountWide {
            await activity.end(nil, dismissalPolicy: policy)
            perActivityTokenTasks[activity.id]?.cancel()
            perActivityTokenTasks[activity.id] = nil
        }
    }

    /// End only the signed-in account aggregate during account sign-out. Any
    /// independently paired machine activity remains valid.
    func endAccountWideActivities(immediate: Bool = false) async {
        let policy: ActivityUIDismissalPolicy = immediate ? .immediate : .default
        let accountActivities = Activity<ADEAgentRunsAttributes>.activities.filter {
            $0.attributes.isAccountWide
        }
        // Cancel first so ending the local activity cannot enqueue a fresh
        // account-token DELETE after the sign-out boundary has been committed.
        for activity in accountActivities {
            perActivityTokenTasks[activity.id]?.cancel()
            perActivityTokenTasks[activity.id] = nil
        }
        for activity in accountActivities {
            await activity.end(nil, dismissalPolicy: policy)
        }
    }

    /// Account sign-out is a local privacy boundary: remove every persisted
    /// account token retry in addition to dismissing the aggregate activity.
    /// Relay cleanup is protected independently by the durable device
    /// revocation marker in `AccountService`.
    func prepareForAccountSignOut() {
        accountObserversSuspended = true
        accountTokenStore.clear()
        accountTokenQueue.discardPending()
        for activity in Activity<ADEAgentRunsAttributes>.activities
        where activity.attributes.isAccountWide {
            perActivityTokenTasks[activity.id]?.cancel()
            perActivityTokenTasks[activity.id] = nil
        }
    }

    func handleAccountSignOut(immediate: Bool = true) async {
        prepareForAccountSignOut()
        await endAccountWideActivities(immediate: immediate)
        accountTokenStore.clear()
    }

    // MARK: - Observation

    private func observeAuthorizationUpdates() {
        guard authorizationUpdatesTask == nil else { return }
        let authorization = ActivityAuthorizationInfo()
        authorizationUpdatesTask = Task { @MainActor [weak self] in
            for await enabled in authorization.activityEnablementUpdates {
                PushNotificationService.shared.updateLiveActivitiesAuthorization(enabled)
                guard let self else { return }
                if enabled {
                    self.startActivityObserversIfAuthorized()
                    self.publishCurrentPushToStartToken()
                } else {
                    self.suspendActivityObservers()
                }
            }
        }
    }

    private func publishCurrentPushToStartToken() {
        guard let token = Activity<ADEAgentRunsAttributes>.pushToStartToken else { return }
        PushNotificationService.shared.updateLiveActivityPushToStartToken(
            token.adePushHexString
        )
    }

    private func suspendActivityObservers() {
        started = false
        pushToStartTask?.cancel()
        pushToStartTask = nil
        activityUpdatesTask?.cancel()
        activityUpdatesTask = nil
        // Keep existing per-activity observers alive long enough to observe
        // ActivityKit ending those activities and delete their relay targets.
        // Re-enabling replaces any observer whose activity remains active.
    }

    private func observePushToStartToken() {
        pushToStartTask?.cancel()
        pushToStartTask = Task {
            for await tokenData in Activity<ADEAgentRunsAttributes>.pushToStartTokenUpdates {
                PushNotificationService.shared.updateLiveActivityPushToStartToken(tokenData.adePushHexString)
            }
        }
    }

    private func observeActivityUpdates() {
        activityUpdatesTask?.cancel()
        activityUpdatesTask = Task { @MainActor [weak self] in
            for await activity in Activity<ADEAgentRunsAttributes>.activityUpdates {
                if activity.attributes.isAccountWide {
                    switch accountWideActivityObservationAction(
                        phase: AccountService.shared.phase,
                        accountObserversSuspended: self?.accountObserversSuspended == true
                    ) {
                    case .waitForAccount:
                        // A push-to-start wake commonly races cached Clerk
                        // restoration. Ending here loses the activity before
                        // ActivityKit can hand us its update token.
                        continue
                    case .observe:
                        guard accountWideActivityMatchesCurrentOwnership(
                            attributesEpoch: activity.attributes.ownershipEpoch,
                            contentEpoch: activity.content.state.ownershipEpoch,
                            currentOwnership: AccountService.shared.attentionDeviceOwnership
                        ) else {
                            await activity.end(nil, dismissalPolicy: .immediate)
                            continue
                        }
                        self?.scheduleAccountWideActivityReconciliation(
                            preferredActivityId: activity.id
                        )
                        continue
                    case .end:
                        await activity.end(nil, dismissalPolicy: .immediate)
                        continue
                    }
                }
                self?.observePushToken(for: activity)
            }
        }
    }

    private func observePushToken(for activity: Activity<ADEAgentRunsAttributes>) {
        if activity.attributes.isAccountWide {
            guard accountWideActivityObservationAction(
                phase: AccountService.shared.phase,
                accountObserversSuspended: accountObserversSuspended
            ) == .observe,
            accountWideActivityMatchesCurrentOwnership(
                attributesEpoch: activity.attributes.ownershipEpoch,
                contentEpoch: activity.content.state.ownershipEpoch,
                currentOwnership: AccountService.shared.attentionDeviceOwnership
            ) else {
                return
            }
        }
        // Replace any prior observer for this activity so a re-attach on
        // foreground doesn't stack duplicate reporters.
        perActivityTokenTasks[activity.id]?.cancel()
        perActivityTokenTasks[activity.id] = Task { [weak self] in
            // The async sequence reports rotations, but an activity recovered
            // after a background launch can already have its current token.
            // Publish it eagerly so the relay never waits for another change.
            if let tokenData = activity.pushToken {
                await self?.report(
                    token: tokenData.adePushHexString,
                    accountWide: activity.attributes.isAccountWide
                )
            }
            for await tokenData in activity.pushTokenUpdates {
                await self?.report(
                    token: tokenData.adePushHexString,
                    accountWide: activity.attributes.isAccountWide
                )
            }
            // A re-attach on foreground cancels this task and stores a replacement
            // under the same id; only the observer that ran to natural completion
            // (activity ended) may report the stop-targeting empty token and clear
            // the entry, or it would clobber the live replacement.
            if Task.isCancelled { return }
            await self?.report(
                token: "",
                accountWide: activity.attributes.isAccountWide
            )
            self?.perActivityTokenTasks[activity.id] = nil
        }
    }

    // MARK: - Reporting

    private func report(token hex: String, accountWide: Bool) async {
        switch liveActivityTokenRoute(accountWide: accountWide) {
        case .accountOnly:
            guard let pending = accountTokenStore.persist(
                deviceId: AccountService.shared.attentionDeviceId,
                activityId: Self.activityId,
                token: hex
            ) else { return }
            _ = await submitAccountTokenRegistration(pending)
            // Account-wide activities are account-only by construction. On
            // auth/network failure the durable retry remains; never leak the
            // token into the paired-machine route below.
            return
        case .pairedMachine:
            break
        }
        guard let sync = SyncService.shared, sync.hasPairedHost else { return }
        _ = try? await sync.sendPushCommand(
            action: "push.reportLiveActivityToken",
            args: [
                "deviceId": sync.deviceId,
                "activityId": Self.activityId,
                "token": hex,
            ]
        )
    }

    func retryPendingAccountWideTokenRegistration() async {
        guard let pending = accountTokenStore.pending,
              pending.accountWide else {
            return
        }
        _ = await submitAccountTokenRegistration(pending)
    }

    private func submitAccountTokenRegistration(
        _ pending: PendingAccountActivityTokenRegistration
    ) async -> Bool {
        await accountTokenQueue.submit(pending) { [weak self] registration in
            guard let self else { return false }
            let reported = await AccountService.shared.reportAttentionActivityToken(
                deviceId: registration.deviceId,
                activityId: registration.activityId,
                token: registration.token
            )
            if reported {
                self.accountTokenStore.clear(ifMatching: registration)
            }
            return reported
        }
    }

    private func scheduleAccountWideActivityReconciliation(
        preferredActivityId: String? = nil
    ) {
        Task { @MainActor [weak self] in
            // ActivityKit may yield the update just before its `activities`
            // collection reflects it. One actor turn keeps reconciliation from
            // publishing a false empty token in that gap.
            await Task.yield()
            await self?.reconcileAccountWideActivityTarget(
                preferredActivityId: preferredActivityId
            )
        }
    }

    /// Reconcile Relay's accepted-start state with ActivityKit's actual device
    /// state. APNs accepting a push only means it accepted delivery; if the
    /// activity never materialized or its token handoff was lost, Relay must
    /// be told there is no active target so it can safely retry the start.
    private func reconcileAccountWideActivityTarget(
        preferredActivityId: String? = nil
    ) async {
        guard accountWideActivityObservationAction(
            phase: AccountService.shared.phase,
            accountObserversSuspended: accountObserversSuspended
        ) == .observe else {
            return
        }
        if let preferredActivityId {
            pendingPreferredAccountActivityId = preferredActivityId
        }
        if accountReconciliationInFlight {
            accountReconciliationPending = true
            return
        }
        accountReconciliationInFlight = true
        defer { accountReconciliationInFlight = false }
        repeat {
            accountReconciliationPending = false
            let preferredActivityId = pendingPreferredAccountActivityId
            pendingPreferredAccountActivityId = nil
            await reconcileAccountWideActivityTargetOnce(
                preferredActivityId: preferredActivityId
            )
        } while accountReconciliationPending
    }

    private func reconcileAccountWideActivityTargetOnce(
        preferredActivityId: String?
    ) async {
        let allAccountActivities = Activity<ADEAgentRunsAttributes>.activities.filter {
            $0.attributes.isAccountWide
        }
        let currentOwnership = AccountService.shared.attentionDeviceOwnership
        let activities = allAccountActivities.filter {
            accountWideActivityMatchesCurrentOwnership(
                attributesEpoch: $0.attributes.ownershipEpoch,
                contentEpoch: $0.content.state.ownershipEpoch,
                currentOwnership: currentOwnership
            )
        }
        for activity in allAccountActivities where !activities.contains(where: {
            $0.id == activity.id
        }) {
            perActivityTokenTasks[activity.id]?.cancel()
            perActivityTokenTasks[activity.id] = nil
            await activity.end(nil, dismissalPolicy: .immediate)
        }
        guard !activities.isEmpty else {
            await report(token: "", accountWide: true)
            return
        }

        let canonicalId: String
        if let preferredActivityId,
           activities.contains(where: { $0.id == preferredActivityId }) {
            canonicalId = preferredActivityId
        } else {
            canonicalId = preferredAccountWideActivityId(activities.map {
                AccountWideActivityCandidate(
                    id: $0.id,
                    updatedAt: $0.content.state.updatedAt
                )
            }) ?? activities[0].id
        }

        for activity in activities where activity.id != canonicalId {
            // Cancel first: an observer reaching natural completion after this
            // duplicate ends must not publish an empty token over the canonical
            // activity's live update token.
            perActivityTokenTasks[activity.id]?.cancel()
            perActivityTokenTasks[activity.id] = nil
            await activity.end(nil, dismissalPolicy: .immediate)
        }
        if let canonical = activities.first(where: { $0.id == canonicalId }) {
            observePushToken(for: canonical)
        }
    }

    private func endOrphanedActivities() async {
        // Only reap when we actually know the current machine — a transient
        // disconnect (nil host) must not tear down a valid activity.
        guard let pairedMachine = SyncService.shared?.hostName?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !pairedMachine.isEmpty else { return }

        for activity in Activity<ADEAgentRunsAttributes>.activities {
            guard !activity.attributes.isAccountWide else { continue }
            let machine = activity.attributes.machineName.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !machine.isEmpty, machine != pairedMachine else { continue }
            await activity.end(nil, dismissalPolicy: .immediate)
            perActivityTokenTasks[activity.id]?.cancel()
            perActivityTokenTasks[activity.id] = nil
        }
    }
}

private extension Data {
    /// Lowercase hex encoding used for APNs / ActivityKit tokens.
    var adePushHexString: String {
        map { String(format: "%02x", $0) }.joined()
    }
}
