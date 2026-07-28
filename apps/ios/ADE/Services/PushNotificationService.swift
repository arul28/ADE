import ActivityKit
import Foundation
import UIKit
import UserNotifications
import WidgetKit

func pushRegistrationRequiredAfterLiveActivityTokenChange(
    hasApnsToken: Bool,
    hasSignedInAccount: Bool,
    hasPairedHost: Bool
) -> Bool {
    hasApnsToken || hasSignedInAccount || hasPairedHost
}

struct PushToStartTokenRegistrationMutation: Equatable {
    let token: String?
    let clear: Bool
}

func pushToStartTokenRegistrationMutation(
    token: String?,
    clearPending: Bool
) -> PushToStartTokenRegistrationMutation {
    if let token {
        return PushToStartTokenRegistrationMutation(token: token, clear: false)
    }
    return PushToStartTokenRegistrationMutation(token: nil, clear: clearPending)
}

@MainActor
final class PushPreferenceSyncRetrier {
    typealias Sleeper = @MainActor (UInt64) async -> Void

    private let sleep: Sleeper
    private var task: Task<Void, Never>?

    init(
        sleep: @escaping Sleeper = { nanoseconds in
            try? await Task.sleep(nanoseconds: nanoseconds)
        }
    ) {
        self.sleep = sleep
    }

    @discardableResult
    func start(
        sync: @escaping @MainActor () async -> Bool
    ) -> Task<Void, Never> {
        cancel()
        let task = Task { @MainActor [sleep] in
            var retry = 0
            while !Task.isCancelled {
                if await sync() {
                    return
                }
                let delaySeconds = min(60, 5 * (1 << min(retry, 3)))
                retry += 1
                await sleep(UInt64(delaySeconds) * 1_000_000_000)
            }
        }
        self.task = task
        return task
    }

    func cancel() {
        task?.cancel()
        task = nil
    }
}

/// Owns iOS remote-push registration and the local diagnostics the "Push
/// delivery" settings panel renders. A single instance (`shared`) is driven by
/// `ADEAppDelegate` (token callbacks, received pushes) and `SyncService`
/// (pairing / foreground / forget hooks).
///
/// Registration only ever happens *after* a machine is paired — we never prompt
/// for notifications on first launch, so the permission ask lands in a moment
/// the user already opted into (they just connected a Mac).
@MainActor
final class PushNotificationService: ObservableObject {
    static let shared = PushNotificationService()

    // MARK: - Published state (settings panel mirrors)

    @Published private(set) var registrationState: PushRegistrationState
    @Published private(set) var permissionStatus: UNAuthorizationStatus = .notDetermined
    @Published private(set) var liveActivitiesAuthorized: Bool
    @Published private(set) var prefs: PushPrefs
    @Published private(set) var diagnostics: PushDiagnostics
    @Published private(set) var relayStatus: PushRelayStatus?
    @Published private(set) var relayRefreshError: String?
    @Published private(set) var isRefreshingStatus = false

    // MARK: - Internal state

    /// Latest APNs device token (hex). Held so a prefs change or Live Activity
    /// token update can re-register without waiting for a fresh APNs callback.
    private var apnsTokenHex: String?
    /// Latest ActivityKit push-to-start token (hex), reported by
    /// `LiveActivityService`. Included in `push.registerDevice`.
    private var liveActivityPushToStartTokenHex: String?
    /// Explicit clear is distinct from an omitted token, which preserves the
    /// relay's current value. It remains pending until every active route has
    /// acknowledged the clear.
    private var liveActivityTokenClearPending = false
    private var didRequestAuthorizationOffTokenClear = false
    private var registerInFlight = false
    /// Set when a token/pref change arrives while a registration is in flight, so
    /// the in-flight run re-registers once more with the latest token state.
    private var registerPending = false
    private let prefsSyncRetrier = PushPreferenceSyncRetrier()

    private let defaults = ADESharedContainer.defaults
    private let prefsKey = ADESharedContainer.pushPreferencesKey
    private let diagnosticsKey = "ade.push.diagnostics"

    private init() {
        let loadedPrefs = Self.loadPrefs(from: defaults, key: prefsKey)
        var loadedDiagnostics = Self.loadDiagnostics(from: defaults, key: diagnosticsKey)
        let migratedTransientFailure = Self.isLiveConnectionRequiredMessage(loadedDiagnostics.lastError)
            && loadedDiagnostics.registrationStateRaw == PushRegistrationState.failed.rawValue
        if migratedTransientFailure {
            loadedDiagnostics.registrationStateRaw = PushRegistrationState.waitingForMachine.rawValue
            loadedDiagnostics.lastError = nil
        }
        self.prefs = loadedPrefs
        self.diagnostics = loadedDiagnostics
        self.liveActivitiesAuthorized = ActivityAuthorizationInfo().areActivitiesEnabled
        self.registrationState = PushRegistrationState(rawValue: loadedDiagnostics.registrationStateRaw) ?? .notDetermined
        if migratedTransientFailure {
            persistDiagnostics()
        }
    }

    // MARK: - Enablement

    /// Refreshes the local system authorization snapshot without prompting or
    /// registering. Settings surfaces call this on appearance so a permission
    /// changed in the iOS Settings app cannot leave the published UI stale.
    func refreshNotificationSettings() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        permissionStatus = settings.authorizationStatus
        updateLiveActivitiesAuthorization(
            ActivityAuthorizationInfo().areActivitiesEnabled
        )
    }

    /// Request notification authorization (full prompt, not provisional) and
    /// register for remote notifications once ADE has either a paired machine
    /// or a signed-in account. Safe to call repeatedly.
    func enableIfPaired() async {
        guard SyncService.shared?.hasPairedHost == true
                || AccountService.shared.isSignedIn else {
            setRegistrationState(.unsupported)
            relayRefreshError = nil
            return
        }
        if liveActivityTokenClearPending {
            await registerDevice()
        }

        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        permissionStatus = settings.authorizationStatus

        switch settings.authorizationStatus {
        case .denied:
            setRegistrationState(.permissionDenied)
            return
        case .notDetermined:
            do {
                let granted = try await center.requestAuthorization(options: [.alert, .sound, .badge])
                permissionStatus = granted ? .authorized : .denied
                guard granted else {
                    setRegistrationState(.permissionDenied)
                    return
                }
            } catch {
                setRegistrationState(.failed, error: error.localizedDescription)
                return
            }
        default:
            break
        }

        if registrationState == .notDetermined || registrationState == .unsupported || registrationState == .permissionDenied {
            setRegistrationState(.awaitingToken)
        }
        UIApplication.shared.registerForRemoteNotifications()
    }

    /// Rebind an already-authorized APNs installation after account sign-in or
    /// switching accounts without presenting a surprise permission prompt.
    /// If iOS has not issued a token in this process yet, asking UIApplication
    /// to register causes the normal delegate callback with the stable token.
    func resumeAccountRegistrationIfAuthorized() async {
        guard AccountService.shared.isSignedIn else { return }
        // A failed/remote sign-out can leave a durable old-owner revocation.
        // Renew the account device row even before notification authorization
        // is resolved so Relay can atomically transfer this installation away
        // from the prior account. This does not prompt and nil tokens do not
        // create a deliverable APNs target.
        if liveActivityTokenClearPending {
            await registerDevice()
        } else if AccountService.shared.hasPendingAttentionDeviceRevocation
            || liveActivityPushToStartTokenHex != nil {
            if await registerAccountAttentionDevice() {
                markLiveActivityTokenRegisteredIfPresent()
            }
        }
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        permissionStatus = settings.authorizationStatus
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            if apnsTokenHex != nil {
                await registerDevice()
            } else {
                setRegistrationState(.awaitingToken)
                UIApplication.shared.registerForRemoteNotifications()
            }
        case .denied:
            setRegistrationState(.permissionDenied)
        case .notDetermined:
            break
        @unknown default:
            break
        }
        startPreferencesSync()
    }

    /// Account auth ended. Keep the APNs token for any independently paired
    /// machine, but do not leave account-only settings claiming registration.
    func handleAccountSignOut() {
        registerPending = false
        prefsSyncRetrier.cancel()
        guard SyncService.shared?.hasPairedHost != true else { return }
        relayStatus = nil
        relayRefreshError = nil
        setRegistrationState(.unsupported)
    }

    // MARK: - APNs token lifecycle (from ADEAppDelegate)

    func didRegisterForRemoteNotifications(deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        apnsTokenHex = hex
        updateDiagnostics { diag in
            diag.tokenSuffix = String(hex.suffix(8))
            diag.apsEnvironment = Self.apsEnvironment
            diag.lastError = nil
        }
        Task { await registerDevice() }
    }

    func didFailToRegisterForRemoteNotifications(error: Error) {
        setRegistrationState(.failed, error: error.localizedDescription)
    }

    /// Called from `ADEAppDelegate` whenever a push is received / presented so
    /// the diagnostics panel can show a real "last push" timestamp.
    func notePushReceived() {
        updateDiagnostics { $0.lastPushReceivedAt = Date() }
    }

    /// Clear the app-icon badge. Called on every foreground transition so the
    /// badge (a count of runs awaiting attention, set by the brain's alerts)
    /// never lingers once the user is back in the app.
    func clearAppBadge() async {
        try? await UNUserNotificationCenter.current().setBadgeCount(0)
    }

    // MARK: - Live Activity push-to-start token (from LiveActivityService)

    /// Records the ActivityKit push-to-start token. Re-registers with the brain
    /// when it changes so the relay can start activities remotely.
    func updateLiveActivityPushToStartToken(_ hex: String?) {
        let normalized = hex?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard normalized != liveActivityPushToStartTokenHex else { return }
        liveActivityPushToStartTokenHex = normalized?.isEmpty == true ? nil : normalized
        if liveActivityPushToStartTokenHex != nil {
            liveActivityTokenClearPending = false
        }
        updateDiagnostics { diag in
            diag.liveActivityPushToStartTokenSuffix = liveActivityPushToStartTokenHex.map { String($0.suffix(8)) }
            diag.liveActivityRegisteredTokenSuffix = nil
        }
        // ActivityKit authorization and normal notification authorization are
        // independent. A signed-in or paired installation must register a
        // push-to-start token even when alert permission is denied and no
        // regular APNs token exists.
        if pushRegistrationRequiredAfterLiveActivityTokenChange(
            hasApnsToken: apnsTokenHex != nil,
            hasSignedInAccount: AccountService.shared.isSignedIn,
            hasPairedHost: SyncService.shared?.hasPairedHost == true
        ) {
            Task { await registerDevice() }
        }
    }

    func updateLiveActivitiesAuthorization(_ enabled: Bool) {
        liveActivitiesAuthorized = enabled
        if enabled {
            didRequestAuthorizationOffTokenClear = false
            return
        }
        guard !didRequestAuthorizationOffTokenClear else { return }
        didRequestAuthorizationOffTokenClear = true
        liveActivityPushToStartTokenHex = nil
        liveActivityTokenClearPending = true
        updateDiagnostics { diag in
            diag.liveActivityPushToStartTokenSuffix = nil
            diag.liveActivityRegisteredTokenSuffix = nil
        }
        Task { await registerDevice() }
    }

    // MARK: - Registration command

    private func registerDevice() async {
        // Coalesce instead of dropping: a push-to-start / APNs token that arrives
        // while a registration is in flight would otherwise never reach the relay
        // until the next foreground, silently breaking remote Live Activity starts.
        if registerInFlight {
            registerPending = true
            return
        }
        registerInFlight = true
        defer { registerInFlight = false }

        repeat {
            registerPending = false
            let mutation = pushToStartTokenRegistrationMutation(
                token: liveActivityPushToStartTokenHex,
                clearPending: liveActivityTokenClearPending
            )
            let accountRouteRequired = AccountService.shared.isSignedIn
            let accountRegistered = await registerAccountAttentionDevice(
                clearPushToStartToken: mutation.clear
            )
            let latestMutation = pushToStartTokenRegistrationMutation(
                token: liveActivityPushToStartTokenHex,
                clearPending: liveActivityTokenClearPending
            )
            if latestMutation != mutation {
                registerPending = true
                continue
            }
            if accountRegistered {
                markLiveActivityTokenRegisteredIfPresent()
            }

            if let sync = SyncService.shared, sync.hasPairedHost {
                guard sync.canSendPushCommands else {
                    if accountRegistered {
                        setRegistrationState(.registered)
                        relayRefreshError = nil
                        updateDiagnostics { diag in
                            diag.lastRegisteredAt = Date()
                            diag.lastError = nil
                        }
                    } else {
                        setRegistrationWaitingForMachine()
                    }
                    continue
                }

                setRegistrationState(.registering)
                var args: [String: Any] = [
                    "deviceId": sync.deviceId,
                    "bundleId": Self.bundleId,
                    "apsEnvironment": Self.apsEnvironment,
                    "platform": "iOS",
                    "deviceName": UIDevice.current.name,
                    "prefs": prefs.commandPayload,
                ]
                if let apnsTokenHex { args["apnsToken"] = apnsTokenHex }
                if mutation.clear {
                    args["clearPushToStartToken"] = true
                } else if let token = mutation.token {
                    args["pushToStartToken"] = token
                }

                do {
                    _ = try await sync.sendPushCommand(action: "push.registerDevice", args: args)
                    completeLiveActivityTokenClearIfSatisfied(
                        clearRequested: mutation.clear,
                        accountSatisfied: !accountRouteRequired || accountRegistered,
                        machineSatisfied: true,
                        hadAnyRoute: true
                    )
                    markLiveActivityTokenRegisteredIfPresent()
                    setRegistrationState(.registered)
                    relayRefreshError = nil
                    updateDiagnostics { diag in
                        diag.lastRegisteredAt = Date()
                        diag.lastError = nil
                    }
                } catch {
                    if accountRegistered {
                        setRegistrationState(.registered)
                        relayRefreshError = nil
                        updateDiagnostics { diag in
                            diag.lastRegisteredAt = Date()
                            diag.lastError = nil
                        }
                    } else if let message = PushNotificationService.machineUnavailableMessage(
                        for: error,
                        fallback: PushNotificationService.machineSetupUnavailableMessage
                    ) {
                        setRegistrationWaitingForMachine(message: message)
                    } else {
                        relayRefreshError = nil
                        setRegistrationState(.failed, error: PushNotificationService.shortError(error))
                    }
                }
            } else {
                completeLiveActivityTokenClearIfSatisfied(
                    clearRequested: mutation.clear,
                    accountSatisfied: !accountRouteRequired || accountRegistered,
                    machineSatisfied: true,
                    hadAnyRoute: accountRouteRequired
                )
                setRegistrationState(accountRegistered ? .registered : .unsupported)
                relayRefreshError = nil
                if accountRegistered {
                    updateDiagnostics { diag in
                        diag.lastRegisteredAt = Date()
                        diag.lastError = nil
                    }
                }
            }
        } while registerPending
    }

    /// Signed-in devices register their APNs and push-to-start tokens directly
    /// with the account Attention relay. Machine-scoped registration remains
    /// below for mixed-version brains and per-machine Live Activity updates.
    private func registerAccountAttentionDevice(
        clearPushToStartToken: Bool? = nil
    ) async -> Bool {
        let shouldClear = clearPushToStartToken ?? liveActivityTokenClearPending
        return await AccountService.shared.registerAttentionDevice(
            deviceId: AccountService.shared.attentionDeviceId,
            apnsToken: apnsTokenHex,
            pushToStartToken: shouldClear ? nil : liveActivityPushToStartTokenHex,
            clearPushToStartToken: shouldClear,
            bundleId: Self.bundleId,
            apsEnvironment: Self.apsEnvironment,
            preferences: prefs.commandPayload
        )
    }

    // MARK: - Preferences

    /// Update prefs from the settings panel and push them to the brain. When
    /// the master `enabled` toggle flips we re-register so the relay knows the
    /// device's current state even if it was previously registered.
    func updatePrefs(_ transform: (inout PushPrefs) -> Void) {
        var next = prefs
        transform(&next)
        guard next != prefs else { return }
        prefs = next
        persistPrefs()
        startPreferencesSync()
    }

    func setMuted(_ muted: Bool, sessionId: String) {
        updatePrefs { prefs in
            var set = Set(prefs.mutedSessionIds)
            if muted { set.insert(sessionId) } else { set.remove(sessionId) }
            prefs.mutedSessionIds = set.sorted()
        }
    }

    private func startPreferencesSync() {
        prefsSyncRetrier.start { [weak self] in
            guard let self else { return true }
            return await self.syncPrefsOnce()
        }
    }

    private func syncPrefsOnce() async -> Bool {
        let accountRouteExpected = AccountService.shared.isSignedIn
        let accountDevicePreferences = prefs.accountDeviceOverride
        let machinePreferences = prefs.commandPayload
        let accountRegistered = await registerAccountAttentionDevice()
        guard !Task.isCancelled else { return true }
        if accountRegistered {
            markLiveActivityTokenRegisteredIfPresent()
        }
        let accountPreferencesSynced = accountRouteExpected
            ? await AccountService.shared.updateAttentionDevicePreferences(
                deviceId: AccountService.shared.attentionDeviceId,
                devicePreferences: accountDevicePreferences
            )
            : false
        guard !Task.isCancelled else { return true }
        let accountSynced = accountRouteExpected && accountPreferencesSynced
        let accountPreferencesFailed = accountRouteExpected
            && !accountPreferencesSynced
        guard let sync = SyncService.shared, sync.hasPairedHost else {
            if accountSynced {
                relayRefreshError = nil
            } else if accountPreferencesFailed {
                relayRefreshError = PushNotificationService.accountPrefsUnavailableMessage
                clearTransientDiagnosticsError()
            }
            return !accountRouteExpected || accountSynced
        }
        guard sync.canSendPushCommands else {
            if accountSynced {
                relayRefreshError = nil
                return true
            } else if accountPreferencesFailed {
                relayRefreshError = PushNotificationService.accountPrefsUnavailableMessage
                clearTransientDiagnosticsError()
            } else {
                relayRefreshError = PushNotificationService.machinePrefsUnavailableMessage
                clearTransientDiagnosticsError()
            }
            return false
        }
        let args: [String: Any] = [
            "deviceId": sync.deviceId,
            "prefs": machinePreferences,
        ]
        do {
            _ = try await sync.sendPushCommand(action: "push.setPrefs", args: args)
            guard !Task.isCancelled else { return true }
            if accountPreferencesFailed {
                relayRefreshError = PushNotificationService.accountPrefsUnavailableMessage
                clearTransientDiagnosticsError()
                return false
            } else {
                relayRefreshError = nil
                return true
            }
        } catch {
            guard !Task.isCancelled else { return true }
            if accountSynced {
                relayRefreshError = nil
                updateDiagnostics { $0.lastError = nil }
                return true
            } else if accountPreferencesFailed {
                relayRefreshError = PushNotificationService.accountPrefsUnavailableMessage
                clearTransientDiagnosticsError()
            } else if let message = PushNotificationService.machineUnavailableMessage(
                for: error,
                fallback: PushNotificationService.machinePrefsUnavailableMessage
            ) {
                relayRefreshError = message
                clearTransientDiagnosticsError()
            } else {
                relayRefreshError = nil
                updateDiagnostics { $0.lastError = PushNotificationService.shortError(error) }
            }
            return false
        }
    }

    // MARK: - Status (settings panel refresh affordance)

    /// Round-trips `push.getStatus`. A successful response proves the relay is
    /// reachable and its APNs key is configured — used in place of a real test
    /// push (which needs brain support the app can't drive alone).
    func refreshStatus() async {
        guard let sync = SyncService.shared, sync.hasPairedHost else {
            relayStatus = nil
            relayRefreshError = nil
            return
        }
        guard sync.canSendPushCommands else {
            relayRefreshError = PushNotificationService.machineRefreshUnavailableMessage
            clearTransientDiagnosticsError()
            return
        }
        await retryRegistrationIfWaitingForMachine()
        isRefreshingStatus = true
        defer { isRefreshingStatus = false }
        do {
            let raw = try await sync.sendPushCommand(
                action: "push.getStatus",
                args: ["deviceId": sync.deviceId]
            )
            relayStatus = PushRelayStatus(raw)
            relayRefreshError = nil
        } catch {
            if let message = PushNotificationService.machineUnavailableMessage(
                for: error,
                fallback: PushNotificationService.machineRefreshUnavailableMessage
            ) {
                relayRefreshError = message
                clearTransientDiagnosticsError()
            } else {
                relayRefreshError = nil
                updateDiagnostics { $0.lastError = PushNotificationService.shortError(error) }
            }
        }
    }

    private func retryRegistrationIfWaitingForMachine() async {
        guard registrationState == .waitingForMachine else { return }
        if apnsTokenHex != nil {
            await registerDevice()
        } else {
            await enableIfPaired()
        }
    }

    // MARK: - Unregister (forget machine / unpair)

    /// Best-effort unregister from the forgotten machine. When the user remains
    /// signed in, preserve the direct account relay registration and aggregate
    /// Live Activity so work on their other machines stays visible.
    func handleUnpair() {
        let deviceId = SyncService.shared?.deviceId
        let preserveAccountAttention = AccountService.shared.isSignedIn
        Task {
            if let sync = SyncService.shared, let deviceId {
                _ = try? await sync.sendPushCommand(
                    action: "push.unregisterDevice",
                    args: ["deviceId": deviceId]
                )
            }
            if preserveAccountAttention {
                await LiveActivityService.shared.endMachineScopedActivities(immediate: true)
                if apnsTokenHex != nil
                    || liveActivityPushToStartTokenHex != nil
                    || liveActivityTokenClearPending {
                    await registerDevice()
                } else {
                    await enableIfPaired()
                }
            } else {
                await LiveActivityService.shared.endAll(immediate: true)
            }
        }
        relayStatus = nil
        relayRefreshError = nil
        if preserveAccountAttention {
            setRegistrationState(apnsTokenHex == nil ? .awaitingToken : .registering)
        } else {
            apnsTokenHex = nil
            liveActivityPushToStartTokenHex = nil
            liveActivityTokenClearPending = false
            didRequestAuthorizationOffTokenClear = false
            setRegistrationState(.unsupported)
            updateDiagnostics { diag in
                diag.tokenSuffix = nil
                diag.liveActivityPushToStartTokenSuffix = nil
                diag.lastRegisteredAt = nil
            }
        }
    }

    // MARK: - State plumbing

    private func setRegistrationState(_ state: PushRegistrationState, error: String? = nil) {
        registrationState = state
        if error != nil {
            relayRefreshError = nil
        }
        updateDiagnostics { diag in
            diag.registrationStateRaw = state.rawValue
            if let error { diag.lastError = error }
        }
    }

    private func setRegistrationWaitingForMachine(message: String? = nil) {
        let resolvedMessage = message ?? PushNotificationService.machineSetupUnavailableMessage
        registrationState = .waitingForMachine
        relayRefreshError = resolvedMessage
        updateDiagnostics { diag in
            diag.registrationStateRaw = PushRegistrationState.waitingForMachine.rawValue
            diag.lastError = nil
        }
    }

    private func clearTransientDiagnosticsError() {
        updateDiagnostics { diag in
            if PushNotificationService.isLiveConnectionRequiredMessage(diag.lastError) {
                diag.lastError = nil
            }
        }
    }

    private func updateDiagnostics(_ transform: (inout PushDiagnostics) -> Void) {
        var next = diagnostics
        transform(&next)
        guard next != diagnostics else { return }
        diagnostics = next
        persistDiagnostics()
    }

    private func markLiveActivityTokenRegisteredIfPresent() {
        guard let token = liveActivityPushToStartTokenHex else { return }
        updateDiagnostics { diagnostics in
            diagnostics.liveActivityRegisteredTokenSuffix = String(token.suffix(8))
        }
    }

    private func completeLiveActivityTokenClearIfSatisfied(
        clearRequested: Bool,
        accountSatisfied: Bool,
        machineSatisfied: Bool,
        hadAnyRoute: Bool
    ) {
        guard clearRequested,
              liveActivityTokenClearPending,
              liveActivityPushToStartTokenHex == nil,
              hadAnyRoute,
              accountSatisfied,
              machineSatisfied else {
            return
        }
        liveActivityTokenClearPending = false
    }

    private func persistPrefs() {
        if let data = try? JSONEncoder().encode(prefs) {
            defaults.set(data, forKey: prefsKey)
            defaults.synchronize()
            WidgetCenter.shared.reloadAllTimelines()
        }
    }

    private func persistDiagnostics() {
        if let data = try? JSONEncoder().encode(diagnostics) {
            defaults.set(data, forKey: diagnosticsKey)
        }
    }

    private static func loadPrefs(from defaults: UserDefaults, key: String) -> PushPrefs {
        guard let data = defaults.data(forKey: key),
              let decoded = try? JSONDecoder().decode(PushPrefs.self, from: data) else {
            return PushPrefs()
        }
        return decoded
    }

    private static func loadDiagnostics(from defaults: UserDefaults, key: String) -> PushDiagnostics {
        guard let data = defaults.data(forKey: key),
              let decoded = try? JSONDecoder().decode(PushDiagnostics.self, from: data) else {
            return PushDiagnostics()
        }
        return decoded
    }

    private static func shortError(_ error: Error) -> String {
        let message = (error as NSError).localizedDescription
        return message.isEmpty ? "\(error)" : message
    }

    nonisolated private static let liveConnectionRequiredMessage = "This action requires a live connection to the machine."
    nonisolated private static let machineSetupUnavailableMessage = "Connect to the machine to finish push setup."
    nonisolated private static let machinePrefsUnavailableMessage = "Connect to the machine to sync push settings."
    nonisolated private static let machineRefreshUnavailableMessage = "Connect to the machine to refresh push delivery."
    nonisolated private static let accountPrefsUnavailableMessage = "ADE couldn’t sync these settings to your account. It will retry shortly."

    nonisolated private static func machineUnavailableMessage(for error: Error, fallback: String) -> String? {
        if isSyncRequestTimeoutError(error) || isSyncHostUnavailableError(error) {
            return "The machine did not respond. ADE will retry when it reconnects."
        }
        let nsError = error as NSError
        let message = nsError.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        if nsError.domain == "ADE" && nsError.code == 15 && message == liveConnectionRequiredMessage {
            return fallback
        }
        if isLiveConnectionRequiredMessage(message) {
            return fallback
        }
        return nil
    }

    nonisolated private static func isLiveConnectionRequiredMessage(_ message: String?) -> Bool {
        let normalized = message?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return normalized == liveConnectionRequiredMessage
            || normalized.localizedCaseInsensitiveContains("requires a live connection")
    }

    nonisolated static var apsEnvironment: String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }

    nonisolated static var bundleId: String {
        Bundle.main.bundleIdentifier ?? "com.ade.ios"
    }
}

// MARK: - Registration state

enum PushRegistrationState: String, Sendable {
    /// Never asked.
    case notDetermined
    /// Not applicable — neither a signed-in account nor a paired machine.
    case unsupported
    /// User declined the system prompt.
    case permissionDenied
    /// Authorized, waiting for the APNs token callback.
    case awaitingToken
    /// Sending the registration to the brain.
    case registering
    /// Authorized locally, waiting for the legacy machine command path.
    case waitingForMachine
    /// Registered with the brain / relay.
    case registered
    /// Registration or token acquisition failed.
    case failed

    var isRegistered: Bool { self == .registered }
}

// MARK: - Preferences model

struct PushPrefs: Codable, Equatable {
    var enabled = true
    var liveActivitiesEnabled = true
    var hideDetails = false
    var mutedSessionIds: [String] = []
    var quietHoursEnabled = false
    var quietHoursStart = "22:00"
    var quietHoursEnd = "08:00"
    var quietHoursTimezone = TimeZone.current.identifier

    /// Wire shape for `push.registerDevice` / `push.setPrefs`. `quietHours` is
    /// `NSNull` (JSON null) when disabled so the brain clears any prior window.
    var commandPayload: [String: Any] {
        var payload: [String: Any] = [
            "enabled": enabled,
            "liveActivitiesEnabled": liveActivitiesEnabled,
            "hideDetails": hideDetails,
            "mutedSessionIds": mutedSessionIds,
        ]
        if quietHoursEnabled {
            payload["quietHours"] = [
                "start": quietHoursStart,
                "end": quietHoursEnd,
                "timezone": quietHoursTimezone,
            ]
        } else {
            payload["quietHours"] = NSNull()
        }
        return payload
    }

    var accountDeviceOverride: [String: Any] {
        [
            "notificationsEnabled": enabled,
            "liveActivitiesEnabled": liveActivitiesEnabled,
            "hideDetails": hideDetails,
            "quietHours": [
                "enabled": quietHoursEnabled,
                "startMinute": Self.minute(of: quietHoursStart) ?? 22 * 60,
                "endMinute": Self.minute(of: quietHoursEnd) ?? 8 * 60,
                "timeZone": quietHoursTimezone,
            ],
            "mutedSessionIds": mutedSessionIds,
        ]
    }

    private static func minute(of clock: String) -> Int? {
        let components = clock.split(separator: ":", omittingEmptySubsequences: false)
        guard components.count == 2,
              let hour = Int(components[0]),
              let minute = Int(components[1]),
              (0..<24).contains(hour),
              (0..<60).contains(minute) else {
            return nil
        }
        return hour * 60 + minute
    }

    private enum CodingKeys: String, CodingKey {
        case enabled
        case liveActivitiesEnabled
        case hideDetails
        case mutedSessionIds
        case quietHoursEnabled
        case quietHoursStart
        case quietHoursEnd
        case quietHoursTimezone
    }

    init() {}

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try container.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        liveActivitiesEnabled = try container.decodeIfPresent(Bool.self, forKey: .liveActivitiesEnabled) ?? true
        hideDetails = try container.decodeIfPresent(Bool.self, forKey: .hideDetails) ?? false
        mutedSessionIds = try container.decodeIfPresent([String].self, forKey: .mutedSessionIds) ?? []
        quietHoursEnabled = try container.decodeIfPresent(Bool.self, forKey: .quietHoursEnabled) ?? false
        quietHoursStart = try container.decodeIfPresent(String.self, forKey: .quietHoursStart) ?? "22:00"
        quietHoursEnd = try container.decodeIfPresent(String.self, forKey: .quietHoursEnd) ?? "08:00"
        quietHoursTimezone = try container.decodeIfPresent(String.self, forKey: .quietHoursTimezone)
            ?? TimeZone.current.identifier
    }
}

// MARK: - Diagnostics model (persisted in the App Group)

struct PushDiagnostics: Codable, Equatable {
    var registrationStateRaw = PushRegistrationState.notDetermined.rawValue
    var tokenSuffix: String?
    var apsEnvironment = PushNotificationService.apsEnvironment
    var lastRegisteredAt: Date?
    var lastPushReceivedAt: Date?
    var lastError: String?
    var liveActivityPushToStartTokenSuffix: String?
    var liveActivityRegisteredTokenSuffix: String?
}

// MARK: - Relay status (push.getStatus result)

struct PushRelayStatus: Equatable {
    var publisherEnabled: Bool
    var relayUrl: String?
    var relayApnsConfigured: Bool
    var deviceRegistered: Bool
    var registeredDeviceCount: Int
    var lastPublishAt: Date?
    var lastPublishError: String?
    var lastRelayContactAt: Date?

    init(_ raw: Any?) {
        let dict = (raw as? [String: Any]) ?? [:]
        self.publisherEnabled = (dict["publisherEnabled"] as? Bool) ?? false
        self.relayUrl = (dict["relayUrl"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        self.relayApnsConfigured = (dict["relayApnsConfigured"] as? Bool) ?? false
        self.deviceRegistered = (dict["deviceRegistered"] as? Bool) ?? false
        self.registeredDeviceCount = (dict["registeredDeviceCount"] as? NSNumber)?.intValue ?? 0
        self.lastPublishError = (dict["lastPublishError"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        self.lastPublishAt = PushRelayStatus.date(from: dict["lastPublishAt"])
        self.lastRelayContactAt = PushRelayStatus.date(from: dict["lastRelayContactAt"])
    }

    /// Accepts unix seconds (Int/Double) or an ISO-8601 string.
    private static func date(from value: Any?) -> Date? {
        if let seconds = value as? NSNumber {
            return Date(timeIntervalSince1970: seconds.doubleValue)
        }
        if let string = value as? String, !string.isEmpty {
            return ISO8601DateFormatter().date(from: string)
        }
        return nil
    }
}
