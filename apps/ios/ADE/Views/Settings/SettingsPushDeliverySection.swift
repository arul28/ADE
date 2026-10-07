import SwiftUI
import UIKit
import UserNotifications

/// Value snapshot of push-delivery state for the settings panel. Built by
/// `SettingsConnectionPresentationModel` from `PushNotificationService` +
/// `push.getStatus`, so the view stays a pure function of Equatable state.
struct SettingsPushDeliverySnapshot: Equatable {
    var registrationState: PushRegistrationState = .notDetermined
    var permissionStatus: UNAuthorizationStatus = .notDetermined
    var apnsEnvironment: String = PushNotificationService.apsEnvironment
    var tokenSuffix: String?
    var lastRegisteredAt: Date?
    var lastPushReceivedAt: Date?
    var lastError: String?
    var relayRefreshError: String?
    var canRefreshRelayStatus = false
    /// Whether this device has a current machine command path.
    var isPaired = false
    /// Signed-in accounts register directly with the account Attention relay,
    /// so push delivery does not require a currently paired Mac.
    var accountDeliveryAvailable = false

    var liveActivitiesAuthorized = true
    var liveActivityTokenPresent = false
    var liveActivityTokenRegistered = false

    // Relay status (push.getStatus). `nil` until the first successful refresh.
    var relayResolved = false
    var publisherEnabled = false
    var relayApnsConfigured = false
    var relayUrl: String?
    var deviceRegistered = false
    var registeredDeviceCount = 0
    var lastPublishAt: Date?
    var lastPublishError: String?
    var lastRelayContactAt: Date?

    var needsPermissionPrompt: Bool {
        permissionStatus == .notDetermined || permissionStatus == .denied
    }

    var canEnableNotifications: Bool {
        isPaired || accountDeliveryAvailable
    }
}

struct SettingsPushDeliverySection: View {
    enum Content: Equatable {
        case controls
        case diagnostics
    }

    let snapshot: SettingsPushDeliverySnapshot
    /// Observed for instant toggle / prefs feedback (the snapshot is throttled).
    @ObservedObject var pushService: PushNotificationService
    var content: Content = .controls

    var body: some View {
        Group {
            if content == .controls {
                controls
            } else {
                diagnosticsContent
            }
        }
        .task {
            await pushService.refreshNotificationSettings()
            await pushService.refreshStatus()
        }
    }

    // MARK: - Controls

    @ViewBuilder
    private var controls: some View {
        if let notice = permissionNotice {
            ADESettingsNotice(
                message: notice.message,
                tone: .warn,
                actionTitle: notice.actionTitle,
                action: notice.action
            )
        }

        ADESettingsSection("Push delivery", hint: "Alerts and Live Activities from your computers.") {
            ADESettingsRows {
                toggleRow("Notifications", hint: "Approvals, replies and failures", isOn: notificationsBinding)
                toggleRow("Live Activities", hint: "Agent runs on the Lock Screen", isOn: liveActivitiesBinding)
                toggleRow("Hide details", hint: "Private Lock Screen previews", isOn: hideDetailsBinding)
            }
        }

        ADESettingsSection("Quiet hours", hint: "Mute pushes on a schedule.") {
            ADESettingsRows {
                toggleRow("Quiet hours", hint: nil, isOn: quietHoursBinding)
                if pushService.prefs.quietHoursEnabled {
                    ADESettingsRow(title: "From") {
                        DatePicker("", selection: quietHoursDateBinding(\.quietHoursStart), displayedComponents: .hourAndMinute)
                            .labelsHidden()
                    }
                    ADESettingsRow(title: "To") {
                        DatePicker("", selection: quietHoursDateBinding(\.quietHoursEnd), displayedComponents: .hourAndMinute)
                            .labelsHidden()
                    }
                    ADESettingsValueRow(
                        title: "Time zone",
                        value: Self.shortTimezone(pushService.prefs.quietHoursTimezone),
                        mono: true
                    )
                }
            }
        }
    }

    private func toggleRow(_ title: String, hint: String?, isOn: Binding<Bool>) -> some View {
        ADESettingsRow(title: title, hint: hint) {
            Toggle("", isOn: isOn)
                .labelsHidden()
                .tint(ADEColor.accent)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(title)
    }

    /// What stands between this phone and its first push, with the fix.
    private var permissionNotice: (message: String, actionTitle: String?, action: (() -> Void)?)? {
        let permissionStatus = pushService.permissionStatus
        if !snapshot.canEnableNotifications {
            return ("Sign in or pair a computer to get notifications.", nil, nil)
        }
        if permissionStatus == .denied {
            return ("Notifications are off for ADE in iOS Settings.", "Open iOS Settings", {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            })
        }
        if permissionStatus == .notDetermined {
            return ("Notifications are not on yet.", "Enable notifications", {
                Task { await pushService.enableIfPaired() }
            })
        }
        return nil
    }

    // MARK: - Diagnostics

    @ViewBuilder
    private var diagnosticsContent: some View {
        ADESettingsSection("This device") {
            ADESettingsRows {
                ADESettingsValueRow(title: "Status", value: statusValue, tone: statusTone)
                if let tokenSuffix = snapshot.tokenSuffix {
                    ADESettingsValueRow(title: "APNs token", value: "…\(tokenSuffix) · \(snapshot.apnsEnvironment)", mono: true)
                }
                ADESettingsValueRow(title: "Live Activity", value: liveActivityDiagnosticValue)
                if let lastPush = snapshot.lastPushReceivedAt {
                    ADESettingsValueRow(title: "Last push", value: Self.relativeDescription(lastPush))
                } else if let registered = snapshot.lastRegisteredAt {
                    ADESettingsValueRow(title: "Registered", value: Self.relativeDescription(registered))
                }
            }
        }

        ADESettingsSection("Relay", trailing: {
            Button {
                Task { await pushService.refreshStatus() }
            } label: {
                if pushService.isRefreshingStatus {
                    ProgressView().controlSize(.mini)
                } else {
                    Text("Refresh")
                }
            }
            .buttonStyle(ADEKitButtonStyle())
            .disabled(pushService.isRefreshingStatus || !snapshot.canRefreshRelayStatus)
            .accessibilityLabel("Refresh status")
        }) {
            ADESettingsRows {
                if snapshot.relayResolved {
                    ADESettingsValueRow(title: "Relay", value: relayValue)
                    if snapshot.registeredDeviceCount > 0 {
                        ADESettingsValueRow(title: "Registered devices", value: "\(snapshot.registeredDeviceCount)", mono: true)
                    }
                    if let lastPublish = snapshot.lastPublishAt {
                        ADESettingsValueRow(title: "Last delivery", value: Self.relativeDescription(lastPublish))
                    }
                    if let publishError = snapshot.lastPublishError {
                        ADESettingsRow("Delivery error", hint: publishError)
                    }
                } else {
                    ADESettingsRow(
                        snapshot.canRefreshRelayStatus ? "Not checked yet" : "Connect a computer to check the relay"
                    )
                }
            }
        }

        if let inlineStatusMessage {
            ADESettingsNotice(
                message: inlineStatusMessage,
                tone: snapshot.relayRefreshError == nil ? .crit : .warn
            )
        }
    }

    // MARK: - Bindings

    private var notificationsBinding: Binding<Bool> {
        Binding(
            get: { pushService.prefs.enabled },
            set: { newValue in
                pushService.updatePrefs { $0.enabled = newValue }
                if newValue { Task { await pushService.enableIfPaired() } }
            }
        )
    }

    private var liveActivitiesBinding: Binding<Bool> {
        Binding(
            get: { pushService.prefs.liveActivitiesEnabled },
            set: { newValue in pushService.updatePrefs { $0.liveActivitiesEnabled = newValue } }
        )
    }

    private var hideDetailsBinding: Binding<Bool> {
        Binding(
            get: { pushService.prefs.hideDetails },
            set: { newValue in pushService.updatePrefs { $0.hideDetails = newValue } }
        )
    }

    private var quietHoursBinding: Binding<Bool> {
        Binding(
            get: { pushService.prefs.quietHoursEnabled },
            set: { newValue in pushService.updatePrefs { $0.quietHoursEnabled = newValue } }
        )
    }

    private func quietHoursDateBinding(_ keyPath: WritableKeyPath<PushPrefs, String>) -> Binding<Date> {
        Binding(
            get: { Self.date(fromHHmm: pushService.prefs[keyPath: keyPath]) },
            set: { newDate in
                let value = Self.hhmm(from: newDate)
                pushService.updatePrefs { prefs in
                    prefs[keyPath: keyPath] = value
                    prefs.quietHoursTimezone = TimeZone.current.identifier
                }
            }
        )
    }

    // MARK: - Derived display

    private var statusTone: ADEKitTone? {
        if snapshot.permissionStatus == .denied { return .warn }
        switch snapshot.registrationState {
        case .registered: return .ok
        case .failed, .permissionDenied: return .crit
        default: return nil
        }
    }

    private var statusValue: String {
        if snapshot.permissionStatus == .denied { return "Permission off" }
        switch snapshot.registrationState {
        case .registered: return "Registered"
        case .registering: return "Registering…"
        case .awaitingToken: return "Waiting for token"
        case .waitingForMachine: return "Waiting for machine"
        case .failed: return "Failed"
        case .permissionDenied: return "Permission off"
        case .unsupported:
            return snapshot.accountDeliveryAvailable
                ? "Not registered"
                : "Sign in or pair a machine"
        case .notDetermined: return "Not enabled"
        }
    }

    private var relayValue: String {
        guard snapshot.publisherEnabled else { return "Publisher off" }
        return snapshot.relayApnsConfigured ? "Reachable · APNs key configured" : "Reachable · APNs key missing"
    }

    private var liveActivityDiagnosticValue: String {
        guard pushService.prefs.liveActivitiesEnabled else { return "Disabled in ADE" }
        guard snapshot.liveActivitiesAuthorized else { return "Off in iOS Settings" }
        if snapshot.liveActivityTokenRegistered { return "Push-to-start registered" }
        if snapshot.liveActivityTokenPresent { return "Token ready · registration pending" }
        return "Waiting for push-to-start token"
    }

    private var inlineStatusMessage: String? {
        snapshot.relayRefreshError ?? snapshot.lastError
    }

    // MARK: - Formatting helpers

    private static func relativeDescription(_ date: Date) -> String {
        let age = abs(Date().timeIntervalSince(date))
        guard age >= 5 else { return "just now" }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: Date())
    }

    private static func shortTimezone(_ identifier: String) -> String {
        (TimeZone(identifier: identifier) ?? .current).abbreviation() ?? identifier
    }

    private static func date(fromHHmm value: String) -> Date {
        let parts = value.split(separator: ":").compactMap { Int($0) }
        var components = DateComponents()
        components.hour = parts.first ?? 0
        components.minute = parts.count > 1 ? parts[1] : 0
        return Calendar.current.date(from: components) ?? Date()
    }

    private static func hhmm(from date: Date) -> String {
        let components = Calendar.current.dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", components.hour ?? 0, components.minute ?? 0)
    }
}
