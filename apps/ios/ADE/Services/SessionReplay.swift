import Foundation
import PostHog
import SwiftUI

/// PostHog mobile session replay. App target only: keep PostHog out of
/// `ADE/Shared`, `ADEWidgets` and `ADEClip`.
///
/// The SDK is linked for replay and nothing else. Every event it would send
/// besides `$snapshot` (lifecycle, screens, `$identify`, flag calls,
/// exceptions) is dropped in `beforeSend`; product events still go through
/// `ProductAnalytics`' own Capture API client. Recordings are screenshots with
/// every text, text input, image and system-sandboxed view masked, and the
/// surfaces that draw their own pixels (terminals, device streams, videos,
/// web scenes) are masked whole with `adeReplayMasked()`.
///
/// Recording follows analytics: no configuration or `DO_NOT_TRACK=1` means
/// no replay. Developer builds stay silent unless `ADE_POSTHOG_REPLAY_DEV=1`.
/// Who is recorded is the project's call: recording is linked to the
/// `session-replay-real-users` flag, false for ADE team accounts. The SDK is
/// set up with replay off and recording starts only after a fresh `/flags`
/// answer for the distinct id the product events use says true: the SDK's
/// own start reads its disk cache, which can belong to an earlier identity,
/// and would record an opening window before PostHog answered.
enum SessionReplay {
  /// The project's linked flag. Bootstrapped false so a cached `true` from
  /// another identity is never read.
  static let linkedFlagKey = "session-replay-real-users"
  /// Long enough to stay off the cold-start path.
  static let startDelay: Duration = .seconds(3)

  private static let lock = NSLock()
  private static var didSetup = false
  private static var didSchedule = false

  /// Sets replay up once, `startDelay` after launch. Call after the account
  /// has been reconciled, so the first `/flags` request names the right person.
  @MainActor
  static func scheduleStart() {
    let shouldSchedule = lock.withLock { () -> Bool in
      guard !didSchedule else { return false }
      didSchedule = true
      return true
    }
    guard shouldSchedule else { return }
    Task { @MainActor in
      try? await Task.sleep(for: startDelay)
      await start()
    }
  }

  /// Points the SDK at the distinct id `ProductAnalytics` uses now (after a
  /// sign-in, sign-out or account switch). Recording stops at once and
  /// resumes only if PostHog's answer for the new id allows it.
  @MainActor
  static func syncIdentity() {
    guard lock.withLock({ didSetup }) else { return }
    let sdk = PostHogSDK.shared
    guard let distinctId = ProductAnalytics.shared.currentDistinctId() else {
      sdk.stopSessionRecording()
      return
    }
    guard sdk.getDistinctId() != distinctId else { return }
    sdk.stopSessionRecording()
    // An identified SDK keeps its id through `identify`; reset first.
    sdk.reset()
    sdk.identify(distinctId)
    startIfFlagAllows()
  }

  /// Asks PostHog for this distinct id's flags, then records only on a true
  /// linked flag. A failed request leaves the bootstrapped `false`.
  @MainActor
  private static func startIfFlagAllows() {
    let sdk = PostHogSDK.shared
    let requestedFor = sdk.getDistinctId()
    sdk.reloadFeatureFlags {
      DispatchQueue.main.async {
        // An answer for an identity that has since changed decides nothing.
        guard sdk.getDistinctId() == requestedFor,
              ProductAnalytics.shared.currentDistinctId() == requestedFor else { return }
        if sdk.isFeatureEnabled(linkedFlagKey, sendFeatureFlagEvent: false) {
          sdk.startSessionRecording(resumeCurrent: true)
        } else {
          sdk.stopSessionRecording()
        }
      }
    }
  }

  /// The replay session id while recording, for `$exception` to link to.
  static func currentSessionId() -> String? {
    guard lock.withLock({ didSetup }), PostHogSDK.shared.isSessionReplayActive() else { return nil }
    return PostHogSDK.shared.getSessionId()
  }

  @MainActor
  private static func start() async {
    guard !lock.withLock({ didSetup }) else { return }
    guard isAllowedForThisBuild(),
          let configuration = ProductAnalytics.shared.replayConfiguration(),
          let distinctId = ProductAnalytics.shared.currentDistinctId() else {
      return
    }

    let config = PostHogConfig(projectToken: configuration.projectToken, host: configuration.host.absoluteString)
    // Same person as the product events and the flag evaluation.
    config.bootstrap = PostHogBootstrapConfig(
      distinctId: distinctId,
      isIdentifiedId: true,
      featureFlags: [linkedFlagKey: false],
      featureFlagPayloads: nil
    )
    // Nothing but replay.
    config.captureApplicationLifecycleEvents = false
    config.captureScreenViews = false
    config.capturePushNotificationSubscriptions = false
    config.capturePushNotificationOpened = false
    config.sendFeatureFlagEvent = false
    config.surveys = false
    config.rageClickConfig.enabled = false
    config.errorTrackingConfig.autoCapture = false
    config.setDefaultPersonProperties = false
    config.disableGeoIp = true
    // `.identifiedOnly` only so `identify` can move the SDK to the account
    // hash; its `$identify` is dropped below and snapshots carry
    // `$process_person_profile: false`.
    config.personProfiles = .identifiedOnly
    // Flags are fetched for the linked recording condition only.
    config.preloadFeatureFlags = true

    // Off at setup: `startIfFlagAllows` starts it once PostHog has answered.
    config.sessionReplay = false
    let replay = config.sessionReplayConfig
    // SwiftUI is recorded only as screenshots; every text, input, image and
    // system view is painted over before a frame leaves the device.
    replay.screenshotMode = true
    replay.maskAllTextInputs = true
    replay.maskAllImages = true
    replay.maskAllSandboxedViews = true
    replay.captureNetworkTelemetry = false
    replay.captureLogs = false

    config.setBeforeSend { event in
      guard event.event == "$snapshot" else { return nil }
      event.properties["$process_person_profile"] = false
      event.properties["$geoip_disable"] = true
      return event
    }

    #if DEBUG
    config.debug = ProductAnalytics.isTruthyFlag(ProcessInfo.processInfo.environment["ADE_POSTHOG_REPLAY_DEBUG"])
    #endif

    // `setup` opens the SDK's disk storage and starts its queues, which froze
    // the main thread for seconds on a cold device. The SDK supports setup off
    // the main thread (it hops to main itself for the UIKit reads), so only
    // the wait happens here. Nothing touches the SDK before `didSetup`.
    await Task.detached(priority: .utility) {
      PostHogSDK.shared.setup(config)
    }.value
    lock.withLock { didSetup = true }
    // A bootstrap is ignored for an install the SDK already identified as
    // someone else, and the account can change while setup runs; this moves
    // it to the id the product events use now (and then asks for flags).
    if PostHogSDK.shared.getDistinctId() != ProductAnalytics.shared.currentDistinctId() {
      syncIdentity()
    } else {
      startIfFlagAllows()
    }
  }

  /// Shipped builds record; a developer run from Xcode or a simulator only
  /// with `ADE_POSTHOG_REPLAY_DEV=1`, like Sentry's `ADE_SENTRY_DEV`.
  private static func isAllowedForThisBuild() -> Bool {
    #if DEBUG
    let isDevelopmentRun = true
    #elseif targetEnvironment(simulator)
    let isDevelopmentRun = true
    #else
    let isDevelopmentRun = false
    #endif
    guard isDevelopmentRun else { return true }
    return ProductAnalytics.isTruthyFlag(ProcessInfo.processInfo.environment["ADE_POSTHOG_REPLAY_DEV"])
  }
}

extension View {
  /// Paints this view over in session replay. For surfaces that draw their
  /// own pixels, where replay's text and image masking cannot see the content:
  /// terminals, device and desktop streams, video, web scenes.
  func adeReplayMasked() -> some View {
    postHogMask()
  }
}
