import ActivityKit
import Foundation

/// Bridges ActivityKit's push-token machinery to the brain's push relay so the
/// "agent runs" Live Activity is driven entirely by remote pushes:
///
///  * `pushToStartTokenUpdates` → reported in `push.registerDevice` so the relay
///    can *start* an activity remotely (no local start needed).
///  * each activity's `pushTokenUpdates` → reported via
///    `push.reportLiveActivityToken` so the relay can *update* its content-state.
///
/// On foreground it re-attaches observers (which re-yield current tokens) and
/// ends any activity that belongs to a machine we're no longer paired with.
@MainActor
final class LiveActivityService {
    static let shared = LiveActivityService()

    /// The single logical activity id the brain/relay keys tokens under. There
    /// is one "agent runs" activity per paired machine; ActivityKit's per-run
    /// activity ids are collapsed to this stable value in reports.
    static let activityId = "agent-runs"

    private var pushToStartTask: Task<Void, Never>?
    private var activityUpdatesTask: Task<Void, Never>?
    private var perActivityTokenTasks: [String: Task<Void, Never>] = [:]
    private var started = false

    private init() {}

    // MARK: - Lifecycle

    /// Begin observing push-to-start and per-activity tokens. Idempotent — safe
    /// to call from pairing success and every foreground transition.
    func start() {
        guard !started else { return }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        started = true
        observePushToStartToken()
        observeActivityUpdates()
        for activity in Activity<ADEAgentRunsAttributes>.activities {
            observePushToken(for: activity)
        }
    }

    /// Foreground hook (called from `SyncService.handleForegroundTransition`).
    /// Re-asserts observers, re-reports live tokens, and reaps orphaned
    /// activities from machines we no longer talk to.
    func handleForegroundTransition() async {
        start()
        await endOrphanedActivities()
        for activity in Activity<ADEAgentRunsAttributes>.activities {
            observePushToken(for: activity)
        }
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

    // MARK: - Observation

    private func observePushToStartToken() {
        pushToStartTask?.cancel()
        pushToStartTask = Task { [weak self] in
            for await tokenData in Activity<ADEAgentRunsAttributes>.pushToStartTokenUpdates {
                await PushNotificationService.shared.updateLiveActivityPushToStartToken(tokenData.adePushHexString)
            }
        }
    }

    private func observeActivityUpdates() {
        activityUpdatesTask?.cancel()
        activityUpdatesTask = Task { [weak self] in
            for await activity in Activity<ADEAgentRunsAttributes>.activityUpdates {
                self?.observePushToken(for: activity)
            }
        }
    }

    private func observePushToken(for activity: Activity<ADEAgentRunsAttributes>) {
        // Replace any prior observer for this activity so a re-attach on
        // foreground doesn't stack duplicate reporters.
        perActivityTokenTasks[activity.id]?.cancel()
        perActivityTokenTasks[activity.id] = Task { [weak self] in
            for await tokenData in activity.pushTokenUpdates {
                await self?.report(token: tokenData.adePushHexString)
            }
            // A re-attach on foreground cancels this task and stores a replacement
            // under the same id; only the observer that ran to natural completion
            // (activity ended) may report the stop-targeting empty token and clear
            // the entry, or it would clobber the live replacement.
            if Task.isCancelled { return }
            await self?.report(token: "")
            self?.perActivityTokenTasks[activity.id] = nil
        }
    }

    // MARK: - Reporting

    private func report(token hex: String) async {
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

    private func endOrphanedActivities() async {
        // Only reap when we actually know the current machine — a transient
        // disconnect (nil host) must not tear down a valid activity.
        guard let pairedMachine = SyncService.shared?.hostName?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !pairedMachine.isEmpty else { return }

        for activity in Activity<ADEAgentRunsAttributes>.activities {
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
