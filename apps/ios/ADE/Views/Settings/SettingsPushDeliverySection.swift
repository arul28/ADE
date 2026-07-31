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
        VStack(alignment: .leading, spacing: 10) {
            if content == .controls {
                SettingsSectionHeader(
                    label: "PUSH DELIVERY",
                    hint: "Remote notifications and Live Activities"
                )

                enableNotificationsControl

                VStack(spacing: 8) {
                    PushToggleRow(
                        symbol: "bell.badge",
                        title: "Notifications",
                        subtitle: "Approvals, replies, and failures",
                        isOn: notificationsBinding
                    )
                    PushToggleRow(
                        symbol: "square.stack.3d.up",
                        title: "Live Activities",
                        subtitle: "Agent runs on the Lock Screen",
                        isOn: liveActivitiesBinding
                    )
                    PushToggleRow(
                        symbol: "eye.slash",
                        title: "Hide details",
                        subtitle: "Use private Lock Screen previews",
                        isOn: hideDetailsBinding
                    )
                    PushToggleRow(
                        symbol: "moon",
                        title: "Quiet hours",
                        subtitle: pushService.prefs.quietHoursEnabled
                            ? "\(pushService.prefs.quietHoursStart)–\(pushService.prefs.quietHoursEnd) · \(Self.shortTimezone(pushService.prefs.quietHoursTimezone))"
                            : "Mute pushes on a schedule",
                        isOn: quietHoursBinding
                    )

                    if pushService.prefs.quietHoursEnabled {
                        quietHoursPickers
                    }
                }
            } else {
                SettingsSectionHeader(label: "DELIVERY DIAGNOSTICS")
                diagnosticsContent
            }
        }
        .task {
            await pushService.refreshNotificationSettings()
            await pushService.refreshStatus()
        }
    }

    // MARK: - Enable notifications affordance

    @ViewBuilder
    private var enableNotificationsControl: some View {
        let permissionStatus = pushService.permissionStatus
        if !snapshot.canEnableNotifications {
            VStack(alignment: .leading, spacing: 6) {
                enableNotificationsButton(label: "Enable notifications", enabled: false, action: {})
                Text("Sign in or pair a Mac to enable notifications")
                    .font(.caption)
                    .foregroundStyle(ADEColor.textMuted)
                    .padding(.horizontal, 4)
            }
        } else if permissionStatus == .notDetermined || permissionStatus == .denied {
            enableNotificationsButton(
                label: permissionStatus == .denied ? "Turn on in iOS Settings" : "Enable notifications",
                enabled: true
            ) {
                if permissionStatus == .denied {
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                } else {
                    Task { await pushService.enableIfPaired() }
                }
            }
        }
    }

    private func enableNotificationsButton(
        label: String,
        enabled: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: "bell.badge.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(ADEColor.purpleAccent)
                Text(label)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(ADEColor.textPrimary)
                Spacer(minLength: 8)
                if enabled {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(ADEColor.purpleAccent.opacity(0.55))
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(ADEColor.purpleAccent.opacity(0.10))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(ADEColor.purpleAccent.opacity(0.28), lineWidth: 0.75)
            )
        }
        .buttonStyle(ADEScaleButtonStyle())
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.5)
    }

    // MARK: - Diagnostics (collapsed by default)

    @ViewBuilder
    private var diagnosticsContent: some View {
        VStack(spacing: 10) {
            VStack(spacing: 10) {
                SettingsDetailRow(
                    symbol: statusSymbol,
                    label: "Status",
                    value: statusValue
                )

                if let tokenSuffix = snapshot.tokenSuffix {
                    SettingsDetailRow(
                        symbol: "key.horizontal",
                        label: "APNs token",
                        value: "…\(tokenSuffix) · \(snapshot.apnsEnvironment)"
                    )
                }

                SettingsDetailRow(
                    symbol: liveActivityDiagnosticSymbol,
                    label: "Live Activity",
                    value: liveActivityDiagnosticValue
                )

                if let lastPush = snapshot.lastPushReceivedAt {
                    SettingsDetailRow(
                        symbol: "tray.and.arrow.down",
                        label: "Last push",
                        value: Self.relativeDescription(lastPush)
                    )
                } else if let registered = snapshot.lastRegisteredAt {
                    SettingsDetailRow(
                        symbol: "clock.arrow.circlepath",
                        label: "Registered",
                        value: Self.relativeDescription(registered)
                    )
                }

                if snapshot.relayResolved {
                    SettingsDetailRow(
                        symbol: "antenna.radiowaves.left.and.right",
                        label: "Relay",
                        value: relayValue
                    )
                    if snapshot.registeredDeviceCount > 0 {
                        SettingsDetailRow(
                            symbol: "iphone.gen3",
                            label: "Registered devices",
                            value: "\(snapshot.registeredDeviceCount)"
                        )
                    }
                    if let lastPublish = snapshot.lastPublishAt {
                        SettingsDetailRow(
                            symbol: "paperplane",
                            label: "Last delivery",
                            value: Self.relativeDescription(lastPublish)
                        )
                    }
                    if let publishError = snapshot.lastPublishError {
                        SettingsDetailRow(
                            symbol: "exclamationmark.triangle",
                            label: "Delivery error",
                            value: publishError
                        )
                    }
                }
            }

            refreshButton

            if let inlineStatusMessage {
                Text(inlineStatusMessage)
                    .font(.caption)
                    .foregroundStyle(inlineStatusTint)
                    .padding(.horizontal, 4)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    // MARK: - Quiet hours pickers

    @ViewBuilder
    private var quietHoursPickers: some View {
        VStack(spacing: 8) {
            HStack {
                Text("From")
                    .font(.subheadline)
                    .foregroundStyle(ADEColor.textSecondary)
                Spacer()
                DatePicker(
                    "",
                    selection: quietHoursDateBinding(\.quietHoursStart),
                    displayedComponents: .hourAndMinute
                )
                .labelsHidden()
            }
            HStack {
                Text("To")
                    .font(.subheadline)
                    .foregroundStyle(ADEColor.textSecondary)
                Spacer()
                DatePicker(
                    "",
                    selection: quietHoursDateBinding(\.quietHoursEnd),
                    displayedComponents: .hourAndMinute
                )
                .labelsHidden()
            }
            HStack {
                Text("Time zone")
                    .font(.subheadline)
                    .foregroundStyle(ADEColor.textSecondary)
                Spacer()
                Text(Self.shortTimezone(pushService.prefs.quietHoursTimezone))
                    .font(.caption.monospaced())
                    .foregroundStyle(ADEColor.textSecondary)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(ADEColor.surfaceBackground.opacity(0.06))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(ADEColor.border.opacity(0.14), lineWidth: 0.6)
        )
    }

    // MARK: - Refresh

    @ViewBuilder
    private var refreshButton: some View {
        Button {
            Task { await pushService.refreshStatus() }
        } label: {
            HStack(spacing: 8) {
                if pushService.isRefreshingStatus {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 13, weight: .semibold))
                }
                Text(refreshButtonLabel)
                    .font(.subheadline.weight(.medium))
            }
            .foregroundStyle(snapshot.canRefreshRelayStatus ? ADEColor.purpleAccent : ADEColor.textSecondary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill((snapshot.canRefreshRelayStatus ? ADEColor.purpleAccent : ADEColor.textSecondary).opacity(0.08))
            )
        }
        .buttonStyle(ADEScaleButtonStyle())
        .disabled(pushService.isRefreshingStatus || !snapshot.canRefreshRelayStatus)
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

    private var statusSymbol: String {
        if snapshot.permissionStatus == .denied { return "bell.slash" }
        switch snapshot.registrationState {
        case .registered: return "bell.badge.fill"
        case .waitingForMachine: return "wifi.exclamationmark"
        case .registering, .awaitingToken: return "arrow.triangle.2.circlepath"
        case .failed: return "exclamationmark.triangle.fill"
        case .permissionDenied: return "bell.slash"
        case .unsupported, .notDetermined: return "bell"
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

    private var liveActivityDiagnosticSymbol: String {
        if !pushService.prefs.liveActivitiesEnabled { return "slash.circle" }
        if !snapshot.liveActivitiesAuthorized { return "slash.circle" }
        if snapshot.liveActivityTokenRegistered { return "dot.radiowaves.up.forward" }
        if snapshot.liveActivityTokenPresent { return "arrow.triangle.2.circlepath" }
        return "hourglass"
    }

    private var liveActivityDiagnosticValue: String {
        guard pushService.prefs.liveActivitiesEnabled else { return "Disabled in ADE" }
        guard snapshot.liveActivitiesAuthorized else { return "Off in iOS Settings" }
        if snapshot.liveActivityTokenRegistered { return "Push-to-start registered" }
        if snapshot.liveActivityTokenPresent { return "Token ready · registration pending" }
        return "Waiting for push-to-start token"
    }

    private var refreshButtonLabel: String {
        if pushService.isRefreshingStatus { return "Checking relay…" }
        return snapshot.canRefreshRelayStatus ? "Refresh status" : "Connect a Mac to refresh"
    }

    private var inlineStatusMessage: String? {
        snapshot.relayRefreshError ?? snapshot.lastError
    }

    private var inlineStatusTint: Color {
        snapshot.relayRefreshError == nil ? ADESharedTheme.statusFailed : ADEColor.warning
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

// MARK: - Toggle row

private struct PushToggleRow: View {
    let symbol: String
    let title: String
    let subtitle: String
    @Binding var isOn: Bool

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: symbol)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(ADEColor.purpleAccent)
                .frame(width: 28, height: 28)
                .background(
                    RoundedRectangle(cornerRadius: 9, style: .continuous)
                        .fill(ADEColor.purpleAccent.opacity(0.14))
                )

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(ADEColor.textPrimary)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(ADEColor.textSecondary)
                    .lineLimit(1)
            }

            Spacer(minLength: 8)

            Toggle("", isOn: $isOn)
                .labelsHidden()
                .tint(ADEColor.purpleAccent)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(ADEColor.surfaceBackground.opacity(0.06))
        )
        .glassEffect(in: .rect(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(ADEColor.border.opacity(0.14), lineWidth: 0.6)
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel(title)
        .accessibilityValue(isOn ? "On" : "Off")
    }
}
