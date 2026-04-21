import SwiftUI

/// Notifications Center — the single entry point for all push-related toggles.
///
/// State is persisted as a JSON-encoded `NotificationPreferences` blob in the
/// App Group `UserDefaults` suite (`ade.notifications.prefs`). The parent
/// settings list wires callbacks: the real sync-service writer (re-announces
/// prefs to the desktop host) and the "send test push" button are both owned
/// by `ios-app-wiring` and are passed in as closures so this view can be
/// unit-previewed without `SyncService` / network dependencies.
struct NotificationsCenterView: View {
  /// Invoked every time a user-visible toggle changes. Parent persists + pushes.
  var onPreferencesChanged: (NotificationPreferences) -> Void
  /// Invoked when the user taps "Send test push".
  var onSendTestPush: () -> Void

  @State private var prefs: NotificationPreferences = NotificationPreferences.load(
    from: ADESharedContainer.defaults
  )
  @State private var permissionGranted: Bool? = nil

  var body: some View {
    Form {
      if permissionGranted == false {
        Section {
          permissionBanner
        }
      }

      Section("Chat") {
        toggleRow(
          title: "Awaiting input",
          subtitle: "Agent paused for your reply",
          symbol: "hand.raised.fill",
          isOn: Binding(
            get: { prefs.chatAwaitingInput },
            set: { prefs.chatAwaitingInput = $0; commit() }
          ),
          hint: "Alert when a chat session asks you a question"
        )
        toggleRow(
          title: "Run failed",
          subtitle: "A turn ended with an error",
          symbol: "exclamationmark.triangle.fill",
          isOn: Binding(
            get: { prefs.chatFailed },
            set: { prefs.chatFailed = $0; commit() }
          ),
          hint: "Alert when a chat run fails"
        )
        toggleRow(
          title: "Turn completed",
          subtitle: "Quiet by default",
          symbol: "checkmark.seal",
          isOn: Binding(
            get: { prefs.chatTurnCompleted },
            set: { prefs.chatTurnCompleted = $0; commit() }
          ),
          hint: "Alert when any chat turn finishes"
        )
      }

      Section("CTO") {
        toggleRow(
          title: "Sub-agent started",
          subtitle: "Quiet by default",
          symbol: "play.circle",
          isOn: Binding(
            get: { prefs.ctoSubagentStarted },
            set: { prefs.ctoSubagentStarted = $0; commit() }
          ),
          hint: "Alert when the CTO spawns a new sub-agent"
        )
        toggleRow(
          title: "Sub-agent finished",
          subtitle: "Worker reported a result",
          symbol: "flag.checkered",
          isOn: Binding(
            get: { prefs.ctoSubagentFinished },
            set: { prefs.ctoSubagentFinished = $0; commit() }
          ),
          hint: "Alert when a CTO sub-agent finishes its work"
        )
        toggleRow(
          title: "Mission phase changes",
          subtitle: "Planning, testing, PR, etc.",
          symbol: "square.stack.3d.up",
          isOn: Binding(
            get: { prefs.ctoMissionPhase },
            set: { prefs.ctoMissionPhase = $0; commit() }
          ),
          hint: "Alert when a mission enters a new phase"
        )
      }

      Section("Pull requests") {
        toggleRow(
          title: "CI failing",
          subtitle: "A required check turned red",
          symbol: "xmark.octagon.fill",
          isOn: Binding(
            get: { prefs.prCiFailing },
            set: { prefs.prCiFailing = $0; commit() }
          ),
          hint: "Alert when CI fails on one of your PRs"
        )
        toggleRow(
          title: "Review requested",
          subtitle: "Someone asked you to review",
          symbol: "person.crop.circle.badge.questionmark",
          isOn: Binding(
            get: { prefs.prReviewRequested },
            set: { prefs.prReviewRequested = $0; commit() }
          ),
          hint: "Alert when a pull request review is requested from you"
        )
        toggleRow(
          title: "Changes requested",
          subtitle: "A reviewer left blocking feedback",
          symbol: "arrow.uturn.backward.circle",
          isOn: Binding(
            get: { prefs.prChangesRequested },
            set: { prefs.prChangesRequested = $0; commit() }
          ),
          hint: "Alert when a reviewer requests changes on your PR"
        )
        toggleRow(
          title: "Merge ready",
          subtitle: "Approvals and checks are green",
          symbol: "checkmark.circle.fill",
          isOn: Binding(
            get: { prefs.prMergeReady },
            set: { prefs.prMergeReady = $0; commit() }
          ),
          hint: "Alert when a pull request is ready to merge"
        )
      }

      Section("System") {
        toggleRow(
          title: "Provider outage",
          subtitle: "Claude, OpenAI, etc.",
          symbol: "bolt.slash.fill",
          isOn: Binding(
            get: { prefs.systemProviderOutage },
            set: { prefs.systemProviderOutage = $0; commit() }
          ),
          hint: "Alert when a model provider reports an outage"
        )
        toggleRow(
          title: "Auth or rate-limit",
          subtitle: "Session needs attention",
          symbol: "key.horizontal",
          isOn: Binding(
            get: { prefs.systemAuthRateLimit },
            set: { prefs.systemAuthRateLimit = $0; commit() }
          ),
          hint: "Alert when an agent hits rate limits or auth errors"
        )
        toggleRow(
          title: "Hook failure",
          subtitle: "Quiet by default",
          symbol: "link.badge.plus",
          isOn: Binding(
            get: { prefs.systemHookFailure },
            set: { prefs.systemHookFailure = $0; commit() }
          ),
          hint: "Alert when a hook script fails"
        )
      }

      Section("Quiet hours") {
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
          HStack {
            Image(systemName: "moon.fill")
              .foregroundStyle(ADEColor.purpleAccent)
            Text("Do-not-disturb window")
              .font(.body)
            Spacer()
            Text(quietHoursSummary)
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
          }
        }
        .accessibilityHint("Configure a daily window during which push alerts are suppressed")
      }

      Section("Per-session overrides") {
        NavigationLink {
          PerSessionOverrideView(
            overrides: Binding(
              get: { prefs.perSessionOverrides },
              set: { prefs.perSessionOverrides = $0; commit() }
            )
          )
        } label: {
          HStack {
            Image(systemName: "person.2.badge.gearshape")
              .foregroundStyle(ADEColor.purpleAccent)
            Text("Manage overrides")
              .font(.body)
            Spacer()
            Text(overridesSummary)
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
          }
        }
        .accessibilityHint("Mute specific sessions or restrict them to awaiting-input alerts only")
      }

      Section {
        Button {
          onSendTestPush()
        } label: {
          HStack {
            Image(systemName: "paperplane.fill")
              .foregroundStyle(ADEColor.purpleAccent)
            Text("Send test push")
              .font(.body.weight(.medium))
              .foregroundStyle(ADEColor.textPrimary)
            Spacer()
          }
        }
        .accessibilityHint("Ask the paired host to send a test notification to this device")
      } footer: {
        Text("Preferences are stored in the shared container and mirrored to your paired Mac.")
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
      }
    }
    .navigationTitle("Notifications")
    .navigationBarTitleDisplayMode(.inline)
    .onAppear {
      refreshPermissionStatus()
    }
  }

  // MARK: - Permission banner

  private var permissionBanner: some View {
    HStack(alignment: .top, spacing: 12) {
      Image(systemName: "bell.slash.fill")
        .font(.title3)
        .foregroundStyle(.orange)
      VStack(alignment: .leading, spacing: 4) {
        Text("Notifications are disabled")
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Text("Enable notifications in Settings to receive alerts from ADE.")
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
        Button("Open Settings") {
          if let url = URL(string: UIApplication.openSettingsURLString) {
            UIApplication.shared.open(url)
          }
        }
        .font(.caption.weight(.semibold))
        .buttonStyle(.borderless)
        .padding(.top, 2)
      }
    }
    .padding(.vertical, 4)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Notifications are disabled. Open Settings to enable them.")
  }

  private func refreshPermissionStatus() {
    // Best-effort: use UNUserNotificationCenter without importing it in tests.
    // The actual wiring is done by ios-app-wiring later; here we default to
    // `nil` which hides the banner until the wiring task hooks us up.
    permissionGranted = nil
  }

  // MARK: - Helpers

  private func commit() {
    prefs.save(to: ADESharedContainer.defaults)
    onPreferencesChanged(prefs)
  }

  @ViewBuilder
  private func toggleRow(
    title: String,
    subtitle: String?,
    symbol: String,
    isOn: Binding<Bool>,
    hint: String
  ) -> some View {
    Toggle(isOn: isOn) {
      HStack(spacing: 10) {
        Image(systemName: symbol)
          .font(.system(size: 16, weight: .semibold))
          .foregroundStyle(ADEColor.purpleAccent)
          .frame(width: 26, height: 26)
          .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
              .fill(ADEColor.purpleAccent.opacity(0.14))
          )
        VStack(alignment: .leading, spacing: 2) {
          Text(title)
            .font(.body)
            .foregroundStyle(ADEColor.textPrimary)
          if let subtitle {
            Text(subtitle)
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
          }
        }
      }
    }
    .tint(ADEColor.purpleAccent)
    .accessibilityHint(hint)
  }

  private var quietHoursSummary: String {
    guard let start = prefs.quietHoursStart, let end = prefs.quietHoursEnd else {
      return "Off"
    }
    let formatter = DateFormatter()
    formatter.dateFormat = "h:mm a"
    return "\(formatter.string(from: start)) – \(formatter.string(from: end))"
  }

  private var overridesSummary: String {
    let count = prefs.perSessionOverrides.values.filter { $0.muted || $0.awaitingInputOnly }.count
    if count == 0 { return "None" }
    return count == 1 ? "1 session" : "\(count) sessions"
  }
}
