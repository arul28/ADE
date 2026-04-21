import SwiftUI
import UserNotifications

/// Notifications Center — the single entry point for all push-related toggles.
///
/// Persists state as a JSON-encoded `NotificationPreferences` blob in the
/// App Group `UserDefaults` (`ade.notifications.prefs`). The parent settings
/// list wires the sync-service writer and the "send test push" action as
/// closures so this view stays preview-able without `SyncService` / network
/// dependencies.
struct NotificationsCenterView: View {
  var onPreferencesChanged: (NotificationPreferences) -> Void
  var onSendTestPush: () -> Void

  @State private var prefs: NotificationPreferences
  @State private var authStatus: UNAuthorizationStatus = .notDetermined
  @State private var hasDeviceToken: Bool = false
  @State private var isRequestingAuthorization: Bool = false

  init(
    initialPreferences: NotificationPreferences = NotificationPreferences(),
    onPreferencesChanged: @escaping (NotificationPreferences) -> Void,
    onSendTestPush: @escaping () -> Void
  ) {
    self.onPreferencesChanged = onPreferencesChanged
    self.onSendTestPush = onSendTestPush
    _prefs = State(initialValue: initialPreferences)
  }

  var body: some View {
    ScrollView {
      VStack(spacing: 0) {
        statusBanner
          .padding(.horizontal, 16)
          .padding(.top, 8)
          .padding(.bottom, 14)

        section(title: "Chat") {
          settingsRow(
            title: "Awaiting input",
            subtitle: "time-sensitive · bypasses focus",
            toggle: binding(\.chatAwaitingInput)
          )
          rowSeparator()
          settingsRow(
            title: "Failed",
            subtitle: "agent stopped on error",
            toggle: binding(\.chatFailed)
          )
          rowSeparator()
          settingsRow(
            title: "Turn completed",
            subtitle: "agent finished its turn",
            toggle: binding(\.chatTurnCompleted)
          )
        }

        section(title: "CTO & sub-agents") {
          settingsRow(
            title: "Sub-agent started",
            subtitle: nil,
            toggle: binding(\.ctoSubagentStarted)
          )
          rowSeparator()
          settingsRow(
            title: "Sub-agent finished",
            subtitle: nil,
            toggle: binding(\.ctoSubagentFinished)
          )
          rowSeparator()
          settingsRow(
            title: "Mission phase change",
            subtitle: nil,
            toggle: binding(\.ctoMissionPhase)
          )
        }

        section(title: "Pull requests") {
          settingsRow(
            title: "CI failing",
            subtitle: "required check turned red",
            toggle: binding(\.prCiFailing)
          )
          rowSeparator()
          settingsRow(
            title: "Review requested",
            subtitle: "someone asked you to review",
            toggle: binding(\.prReviewRequested)
          )
          rowSeparator()
          settingsRow(
            title: "Changes requested",
            subtitle: "reviewer left blocking feedback",
            toggle: binding(\.prChangesRequested)
          )
          rowSeparator()
          settingsRow(
            title: "Merge ready",
            subtitle: "approvals and checks are green",
            toggle: binding(\.prMergeReady)
          )
        }

        section(title: "System & health") {
          settingsRow(
            title: "Provider outage",
            subtitle: "Claude, OpenAI, etc.",
            toggle: binding(\.systemProviderOutage)
          )
          rowSeparator()
          settingsRow(
            title: "Auth / rate limit",
            subtitle: "session needs attention",
            toggle: binding(\.systemAuthRateLimit)
          )
          rowSeparator()
          settingsRow(
            title: "Hook failure",
            subtitle: "quiet by default",
            toggle: binding(\.systemHookFailure)
          )
        }

        section(title: "Quiet hours") {
          quietHoursRow
          rowSeparator()
          perSessionOverridesRow
        }

        VStack(alignment: .leading, spacing: 8) {
          sendTestPushButton
          if !canSendTestPush {
            Text("Enable notifications and register this device before sending a test push.")
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
              .frame(maxWidth: .infinity, alignment: .leading)
              .padding(.horizontal, 2)
          }
        }
          .padding(.horizontal, 16)
          .padding(.top, 20)
          .padding(.bottom, 24)

        Text("Preferences are stored in the shared container and mirrored to your paired Mac.")
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal, 20)
          .padding(.bottom, 40)
      }
    }
    .background(ADEColor.pageBackground.ignoresSafeArea())
    .navigationTitle("Notifications")
    .navigationBarTitleDisplayMode(.inline)
    .task {
      await refreshPreferencesAfterFirstPaint()
      await refreshAuthorizationStatus()
    }
  }

  // MARK: - Banner

  @ViewBuilder
  private var statusBanner: some View {
    switch authStatus {
    case .authorized, .ephemeral:
      ADEBanner(
        tint: ADEColor.success,
        dotTint: ADEColor.success,
        title: "Push notifications are enabled",
        subtitle: hasDeviceToken ? "device registered · APNs prod" : "awaiting device registration",
        trailing: hasDeviceToken ? nil : .init(label: "Register", action: registerDeviceForRemoteNotifications)
      )
    case .provisional:
      ADEBanner(
        tint: ADESharedTheme.warningAmber,
        dotTint: ADESharedTheme.warningAmber,
        title: "Push is provisional",
        subtitle: "tap to enable full banners",
        trailing: .init(label: "Enable", action: openSystemSettings)
      )
    case .denied:
      ADEBanner(
        tint: ADEColor.danger,
        dotTint: ADEColor.danger,
        title: "Push notifications are off",
        subtitle: "re-enable in iOS Settings",
        trailing: .init(label: "Open iOS Settings", action: openSystemSettings)
      )
    case .notDetermined:
      ADEBanner(
        tint: ADESharedTheme.warningAmber,
        dotTint: ADESharedTheme.warningAmber,
        title: "Push notifications are not enabled yet",
        subtitle: "allow notifications to receive agent updates",
        trailing: .init(
          label: isRequestingAuthorization ? "Requesting..." : "Enable",
          action: requestAuthorizationIfNeeded
        ),
        trailingDisabled: isRequestingAuthorization
      )
    @unknown default:
      EmptyView()
    }
  }

  // MARK: - Sections

  @ViewBuilder
  private func section<Content: View>(
    title: String,
    @ViewBuilder content: () -> Content
  ) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      Text(title.uppercased())
        .font(.system(size: 13, design: .monospaced))
        .kerning(0)
        .foregroundStyle(Color(red: 0x8E / 255.0, green: 0x8E / 255.0, blue: 0x93 / 255.0))
        .padding(EdgeInsets(top: 20, leading: 20, bottom: 7, trailing: 20))
        .accessibilityAddTraits(.isHeader)

      groupContainer {
        content()
      }
    }
  }

  @ViewBuilder
  private func groupContainer<Content: View>(
    @ViewBuilder content: () -> Content
  ) -> some View {
    VStack(spacing: 0) { content() }
      .padding(.horizontal, 0)
      .background(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .fill(Color(red: 28.0 / 255.0, green: 25.0 / 255.0, blue: 42.0 / 255.0).opacity(0.75))
          .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
              .fill(.ultraThinMaterial)
          )
      )
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .strokeBorder(Color.white.opacity(0.05), lineWidth: 0.5)
      )
      .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
      .padding(.horizontal, 16)
  }

  // MARK: - Rows

  @ViewBuilder
  private func settingsRow(
    title: String,
    subtitle: String?,
    toggle: Binding<Bool>
  ) -> some View {
    HStack(alignment: .center, spacing: 14) {
      VStack(alignment: .leading, spacing: 1) {
        Text(title)
          .font(.system(size: 16, weight: .regular))
          .kerning(-0.2)
          .foregroundStyle(ADEColor.textPrimary)
        if let subtitle {
          Text(subtitle)
            .font(.system(size: 12.5, design: .monospaced))
            .foregroundStyle(Color(red: 0x8E / 255.0, green: 0x8E / 255.0, blue: 0x93 / 255.0))
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      Spacer(minLength: 12)
      Toggle("", isOn: toggle)
        .labelsHidden()
        .tint(ADEColor.success)
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 11)
    .frame(minHeight: 44)
    .contentShape(Rectangle())
    .accessibilityElement(children: .combine)
  }

  @ViewBuilder
  private func rowSeparator() -> some View {
    Rectangle()
      .fill(Color(red: 0x54 / 255.0, green: 0x54 / 255.0, blue: 0x58 / 255.0).opacity(0.4))
      .frame(height: 0.33)
      .padding(.leading, 16)
  }

  private var quietHoursRow: some View {
    NavigationLink {
      QuietHoursEditorView(
        start: Binding(
          get: { prefs.quietHoursStart },
          set: { prefs.quietHoursStart = $0; commit() }
        ),
        end: Binding(
          get: { prefs.quietHoursEnd },
          set: { prefs.quietHoursEnd = $0; commit() }
        )
      )
    } label: {
      HStack(alignment: .center, spacing: 14) {
        VStack(alignment: .leading, spacing: 1) {
          Text("Do not disturb")
            .font(.system(size: 16, weight: .regular))
            .kerning(-0.2)
            .foregroundStyle(ADEColor.textPrimary)
          Text(quietHoursSubtitle)
            .font(.system(size: 12.5, design: .monospaced))
            .foregroundStyle(Color(red: 0x8E / 255.0, green: 0x8E / 255.0, blue: 0x93 / 255.0))
        }
        Spacer(minLength: 12)
        Image(systemName: "chevron.right")
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(ADEColor.purpleAccent)
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 11)
      .frame(minHeight: 44)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityHint("Configure a daily window during which push alerts are suppressed")
  }

  private var perSessionOverridesRow: some View {
    NavigationLink {
      PerSessionOverrideView(
        overrides: Binding(
          get: { prefs.perSessionOverrides },
          set: { prefs.perSessionOverrides = $0; commit() }
        )
      )
    } label: {
      HStack(alignment: .center, spacing: 14) {
        VStack(alignment: .leading, spacing: 1) {
          Text("Per-agent overrides")
            .font(.system(size: 16, weight: .regular))
            .kerning(-0.2)
            .foregroundStyle(ADEColor.textPrimary)
          Text(overridesSubtitle)
            .font(.system(size: 12.5, design: .monospaced))
            .foregroundStyle(Color(red: 0x8E / 255.0, green: 0x8E / 255.0, blue: 0x93 / 255.0))
        }
        Spacer(minLength: 12)
        Image(systemName: "chevron.right")
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(ADEColor.purpleAccent)
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 11)
      .frame(minHeight: 44)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityHint("Mute specific agents or restrict them to awaiting-input alerts only")
  }

  // MARK: - Send test push

  private var sendTestPushButton: some View {
    Button(action: onSendTestPush) {
      Text("Send test push")
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(ADEColor.purpleAccent)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 13)
        .background(
          RoundedRectangle(cornerRadius: 12, style: .continuous)
            .fill(ADEColor.purpleAccent.opacity(0.15))
        )
    }
    .buttonStyle(.plain)
    .disabled(!canSendTestPush)
    .opacity(canSendTestPush ? 1 : 0.45)
    .accessibilityHint(
      canSendTestPush
        ? "Ask the paired host to send a test notification to this device"
        : "Enable notifications and register this device first"
    )
  }

  // MARK: - Helpers

  private func binding(_ keyPath: WritableKeyPath<NotificationPreferences, Bool>) -> Binding<Bool> {
    Binding(
      get: { prefs[keyPath: keyPath] },
      set: { newValue in
        prefs[keyPath: keyPath] = newValue
        commit()
      }
    )
  }

  private func refreshPreferencesAfterFirstPaint() async {
    await Task.yield()
    let loaded = NotificationPreferences.load(from: ADESharedContainer.defaults)
    guard loaded != prefs else { return }
    prefs = loaded
  }

  private func refreshAuthorizationStatus() async {
    let settings = await UNUserNotificationCenter.current().notificationSettings()
    await MainActor.run {
      authStatus = settings.authorizationStatus
      hasDeviceToken = UIApplication.shared.isRegisteredForRemoteNotifications
    }
  }

  private func requestAuthorizationIfNeeded() {
    guard !isRequestingAuthorization else { return }
    isRequestingAuthorization = true
    Task {
      _ = try? await UNUserNotificationCenter.current().requestAuthorization(
        options: [.alert, .badge, .sound]
      )
      await MainActor.run {
        UIApplication.shared.registerForRemoteNotifications()
      }
      await refreshAuthorizationStatus()
      await MainActor.run {
        isRequestingAuthorization = false
      }
    }
  }

  private func registerDeviceForRemoteNotifications() {
    UIApplication.shared.registerForRemoteNotifications()
    Task { await refreshAuthorizationStatus() }
  }

  private func openSystemSettings() {
    if let url = URL(string: UIApplication.openSettingsURLString) {
      UIApplication.shared.open(url)
    }
  }

  private func commit() {
    prefs.save(to: ADESharedContainer.defaults)
    onPreferencesChanged(prefs)
  }

  private var quietHoursSubtitle: String {
    guard let start = prefs.quietHoursStart, let end = prefs.quietHoursEnd else {
      return "off"
    }
    let startStr = start.formatted(date: .omitted, time: .shortened)
    let endStr = end.formatted(date: .omitted, time: .shortened)
    return "\(startStr) \u{2192} \(endStr)"
  }

  private var overridesSubtitle: String {
    let count = prefs.perSessionOverrides.values.filter { $0.muted || $0.awaitingInputOnly }.count
    if count == 0 { return "none" }
    return "\(count) active"
  }

  private var canSendTestPush: Bool {
    switch authStatus {
    case .authorized, .provisional, .ephemeral:
      return hasDeviceToken
    default:
      return false
    }
  }
}

// MARK: - Banner primitive

private struct ADEBanner: View {
  struct Trailing {
    let label: String
    let action: () -> Void
  }

  let tint: Color
  let dotTint: Color
  let title: String
  let subtitle: String
  let trailing: Trailing?
  let trailingDisabled: Bool

  init(
    tint: Color,
    dotTint: Color,
    title: String,
    subtitle: String,
    trailing: Trailing?,
    trailingDisabled: Bool = false
  ) {
    self.tint = tint
    self.dotTint = dotTint
    self.title = title
    self.subtitle = subtitle
    self.trailing = trailing
    self.trailingDisabled = trailingDisabled
  }

  var body: some View {
    HStack(alignment: .center, spacing: 10) {
      Circle()
        .fill(dotTint)
        .frame(width: 8, height: 8)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 2) {
        Text(title)
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Text(subtitle)
          .font(.system(size: 12, design: .monospaced))
          .foregroundStyle(Color(red: 0x8E / 255.0, green: 0x8E / 255.0, blue: 0x93 / 255.0))
          .fixedSize(horizontal: false, vertical: true)
      }
      Spacer(minLength: 10)
      if let trailing {
        Button(action: trailing.action) {
          Text(trailing.label)
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(tint)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(
              RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(tint.opacity(0.18))
            )
        }
        .buttonStyle(.plain)
        .disabled(trailingDisabled)
        .opacity(trailingDisabled ? 0.55 : 1)
      }
    }
    .padding(12)
    .background(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .fill(tint.opacity(0.12))
    )
    .overlay(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .strokeBorder(tint.opacity(0.25), lineWidth: 0.5)
    )
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(title). \(subtitle).")
  }
}
