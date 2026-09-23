import SwiftUI
import UIKit

/// Full-screen view of the lane's private macOS screen.
///
/// Built like `AppleDeviceViewer` — black stage, Close and Reconnect on top, one
/// sentence underneath — with one difference: the Mac Desktop takes a finger
/// when the host advertises takeover, so the picture here is the same
/// `MacDesktopControlPicture` the tools sheet uses, Take control and Return
/// included.
///
/// It runs its own live subscription under its own id. The tools sheet pauses
/// its inline picture while this is up, and even if both were live, two ids
/// cannot unsubscribe each other on the host.
struct MacDesktopViewer: View {
  let laneId: String

  /// Poll cadence for the lease, recording and stream summary. Same as the
  /// tools sheet: this is a surface the user opened to watch.
  private static let refreshInterval: Duration = .seconds(3)

  @EnvironmentObject private var syncService: SyncService
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase

  /// Seeded with the caller's last snapshot so the ribbon and the picture's
  /// geometry are right on the first frame rather than after the first poll.
  @State private var desktop: WorkToolsMacDesktopState?
  @State private var session: MacDesktopLiveSession?
  @State private var controlling = false
  /// The Off card's Start is in flight. Opening this viewer never starts a
  /// display; only that button does.
  @State private var starting = false
  @State private var startError: String?

  init(laneId: String, initialState: WorkToolsMacDesktopState?) {
    self.laneId = laneId
    _desktop = State(initialValue: initialState)
  }

  var body: some View {
    ZStack {
      Color.black.ignoresSafeArea()

      VStack(spacing: 0) {
        controls
        Spacer(minLength: 0)
        stage
        Spacer(minLength: 0)
        footer
      }
    }
    .preferredColorScheme(.dark)
    .task(id: laneId) {
      await refresh()
      while !Task.isCancelled {
        try? await Task.sleep(for: Self.refreshInterval)
        guard !Task.isCancelled else { return }
        await refresh()
      }
    }
    .onAppear { updateLifecycle() }
    .onDisappear { stopSession() }
    .onChange(of: scenePhase) { _, _ in updateLifecycle() }
    .onChange(of: syncService.connectionState) { _, _ in updateLifecycle() }
    .onChange(of: isLiveCapable) { _, _ in updateLifecycle() }
  }

  // MARK: - Pieces

  private var controls: some View {
    HStack(spacing: 14) {
      controlButton(systemName: "xmark", label: "Close") {
        stopSession()
        dismiss()
      }
      Spacer(minLength: 0)
      if let session {
        MacDesktopViewerReconnectButton(session: session) { reconnect() }
      }
    }
    .padding(.horizontal, 18)
    .padding(.vertical, 12)
  }

  private func controlButton(systemName: String, label: String, action: @escaping () -> Void) -> some View {
    Button {
      ADEHaptics.light()
      action()
    } label: {
      macDesktopViewerControlLabel(systemName: systemName)
    }
    .buttonStyle(.plain)
    .accessibilityLabel(label)
  }

  @ViewBuilder
  private var stage: some View {
    if !syncService.supportsMacDesktopStream {
      stageMessage("Live video isn't available from this machine.")
    } else if desktop?.supported == false {
      stageMessage("This Mac can't host a desktop.")
    } else if let display = desktop?.display {
      if let session {
        ZStack {
          MacDesktopControlPicture(
            laneId: laneId,
            display: display,
            session: session,
            placeholder: nil,
            showsPictureStatus: false,
            onControlChange: { controlling = $0 }
          )
          MacDesktopViewerStatusOverlay(
            session: session,
            hostError: desktop?.stream?.lastError,
            onReconnect: { reconnect() }
          )
        }
        .padding(.horizontal, 12)
      } else if syncService.connectionState != .connected {
        stageMessage("Waiting for the connection to your Mac…")
      } else {
        ProgressView().tint(.white)
      }
    } else if desktop == nil {
      ProgressView().tint(.white)
    } else {
      offCard
    }
  }

  /// "Mac Desktop is off." and Start, like the Apple Off card. The poll brings
  /// the display in once the host has made it.
  private var offCard: some View {
    VStack(spacing: 12) {
      if starting {
        ProgressView().tint(.white)
      }
      stageMessage(macDesktopOffCardMessage(
        starting: starting,
        error: startError,
        canStart: syncService.supportsMacDesktopStart
      ))
      if !starting && syncService.supportsMacDesktopStart {
        Button {
          ADEHaptics.light()
          startDesktop()
        } label: {
          Text("Start")
            .font(.footnote.weight(.semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 18)
            .padding(.vertical, 9)
            .background(Color.white.opacity(0.16), in: Capsule())
        }
        .buttonStyle(.plain)
        .disabled(syncService.connectionState != .connected)
        .accessibilityHint("Starts this lane's Mac Desktop on your Mac")
      }
    }
  }

  private func stageMessage(_ text: String) -> some View {
    Text(text)
      .font(.footnote)
      .foregroundStyle(.white.opacity(0.85))
      .multilineTextAlignment(.center)
      .padding(.horizontal, 32)
  }

  private var footer: some View {
    VStack(spacing: 6) {
      Text(macDesktopViewerRibbon(
        controlling: controlling,
        lease: desktop?.lease,
        displayName: desktop?.display?.name
      ))
      .font(.caption)
      .foregroundStyle(.white.opacity(0.7))
      .lineLimit(2)
      .multilineTextAlignment(.center)
      if desktop?.recording?.running == true {
        Label("Recording", systemImage: "record.circle")
          .font(.caption2.weight(.semibold))
          .foregroundStyle(ADEColor.danger)
      }
    }
    .padding(.horizontal, 24)
    .padding(.bottom, 18)
    .frame(maxWidth: .infinity)
    .accessibilityElement(children: .combine)
  }

  // MARK: - Data

  private var isLiveCapable: Bool {
    syncService.supportsMacDesktopStream
      && desktop?.supported == true
      && desktop?.display != nil
  }

  /// Keeps the last good snapshot on a failed read, like the Apple viewer: a
  /// timeout must not blank the ribbon or tear down the picture.
  private func refresh() async {
    guard syncService.supportsWorkToolsState else { return }
    guard let next = try? await syncService.fetchWorkToolsLaneState(laneId: laneId) else { return }
    guard !Task.isCancelled else { return }
    desktop = next.macDesktop
    retryStoppedSessionIfNeeded()
  }

  private func startDesktop() {
    guard !starting else { return }
    starting = true
    startError = nil
    Task {
      do {
        try await syncService.macDesktopStart(laneId: laneId)
        await refresh()
      } catch {
        startError = (error as NSError).localizedDescription
      }
      starting = false
    }
  }

  // MARK: - Live stream lifecycle

  /// Same rule as the tools sheet: on screen, foreground, connected, and the
  /// lane has a display.
  private func updateLifecycle() {
    let shouldRun = isLiveCapable
      && scenePhase == .active
      && syncService.connectionState == .connected
    if shouldRun {
      startSessionIfNeeded()
    } else {
      stopSession()
    }
  }

  private func startSessionIfNeeded() {
    guard session == nil else { return }
    // Distinct from the sheet's id so the two can never unsubscribe each other.
    let next = MacDesktopLiveSession(
      laneId: laneId,
      subscriptionId: "ios-\(syncService.deviceId)-mac-desktop-viewer-\(laneId)",
      viewerLabel: MacDesktopLiveSession.defaultViewerLabel()
    )
    syncService.registerMacDesktopStream(
      subscriptionId: next.subscriptionId,
      onRecord: { [weak next] record in next?.consume(record) },
      onEnded: { [weak next] ended in next?.noteEnded(ended) }
    )
    session = next
    Task { await next.start(using: syncService) }
  }

  private func stopSession() {
    guard let current = session else { return }
    current.stop(using: syncService)
    session = nil
    controlling = false
  }

  /// Re-subscribes on the same session rather than tearing it down: a stop
  /// sends an unsubscribe that could land after the new subscribe under the
  /// same id and cancel it.
  private func reconnect() {
    guard isLiveCapable, syncService.connectionState == .connected else { return }
    guard let current = session else {
      startSessionIfNeeded()
      return
    }
    Task { await current.start(using: syncService) }
  }

  /// A `stopped` stream is the encoder pausing, not the subscription dying.
  /// Same as the sheet: the next poll re-subscribes while the lane still has a
  /// display, which is what restarts the encoder.
  private func retryStoppedSessionIfNeeded() {
    guard let current = session else { return }
    guard case .ended(let reason, _) = current.phase, reason == "stopped" else { return }
    guard isLiveCapable,
          scenePhase == .active,
          syncService.connectionState == .connected
    else { return }
    Task { await current.start(using: syncService) }
  }
}

private func macDesktopViewerControlLabel(systemName: String) -> some View {
  Image(systemName: systemName)
    .font(.system(size: 15, weight: .semibold))
    .foregroundStyle(.white)
    .frame(width: 44, height: 44)
    .background(Color.white.opacity(0.12), in: Circle())
}

/// The top-right Reconnect, shown only when the overlay offers one. Its own
/// view so it observes the session's phase.
private struct MacDesktopViewerReconnectButton: View {
  @ObservedObject var session: MacDesktopLiveSession
  let onReconnect: () -> Void

  var body: some View {
    if macDesktopViewerOverlay(phase: session.phase, hasFrame: session.hasFrame, hostError: nil)?.offersReconnect == true {
      Button {
        ADEHaptics.light()
        onReconnect()
      } label: {
        macDesktopViewerControlLabel(systemName: "arrow.clockwise")
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Reconnect")
    }
  }
}

/// The status card over the picture: connecting, stopped, or failed.
private struct MacDesktopViewerStatusOverlay: View {
  @ObservedObject var session: MacDesktopLiveSession
  let hostError: String?
  let onReconnect: () -> Void

  var body: some View {
    if let overlay = macDesktopViewerOverlay(phase: session.phase, hasFrame: session.hasFrame, hostError: hostError) {
      VStack(spacing: 12) {
        if overlay.busy {
          ProgressView().tint(.white)
        }
        Text(overlay.message)
          .font(.footnote)
          .foregroundStyle(.white.opacity(0.85))
          .multilineTextAlignment(.center)
          .padding(.horizontal, 32)
        if overlay.offersReconnect {
          Button {
            ADEHaptics.light()
            onReconnect()
          } label: {
            Text("Reconnect")
              .font(.footnote.weight(.semibold))
              .foregroundStyle(.white)
              .padding(.horizontal, 18)
              .padding(.vertical, 9)
              .background(Color.white.opacity(0.16), in: Capsule())
          }
          .buttonStyle(.plain)
        }
      }
      .padding(.vertical, 18)
      .background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
      .padding(.horizontal, 24)
    }
  }
}

// MARK: - Pure helpers

/// The Off card's one line: the start in flight, why the last one failed, or
/// that the display is off.
func macDesktopOffCardMessage(starting: Bool, error: String?, canStart: Bool) -> String {
  if starting { return "Starting Mac Desktop…" }
  if let error = error?.trimmingCharacters(in: .whitespacesAndNewlines), !error.isEmpty {
    return error
  }
  return canStart ? "Mac Desktop is off." : "Mac Desktop is off. Start it in ADE on your Mac."
}

/// What the viewer's status card says, or nil while the picture is live.
struct MacDesktopViewerOverlay: Equatable {
  var message: String
  var busy: Bool
  var offersReconnect: Bool
}

/// The status card for a session phase. The host's own capture error wins over
/// a generic "stopped", because the Mac knows why its encoder quit.
func macDesktopViewerOverlay(
  phase: MacDesktopLiveSession.Phase,
  hasFrame: Bool,
  hostError: String?
) -> MacDesktopViewerOverlay? {
  let hostMessage = hostError.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
  switch phase {
  case .live:
    return nil
  case .idle:
    // Nothing is subscribed yet (or any more). With no picture there is
    // nothing to look at, so offer the way back.
    return hasFrame ? nil : MacDesktopViewerOverlay(message: "Not connected.", busy: false, offersReconnect: true)
  case .connecting:
    return MacDesktopViewerOverlay(
      message: hasFrame ? "Reconnecting…" : "Connecting to the Mac…",
      busy: true,
      offersReconnect: false
    )
  case .waitingForKeyframe:
    return MacDesktopViewerOverlay(message: "Starting the picture…", busy: true, offersReconnect: false)
  case .ended(let reason, let message):
    let fallback = reason == "display_destroyed" ? "This lane's desktop closed." : "The stream stopped."
    let text = hostMessage ?? message.flatMap { $0.isEmpty ? nil : $0 } ?? fallback
    return MacDesktopViewerOverlay(message: text, busy: false, offersReconnect: true)
  case .failed(let message):
    return MacDesktopViewerOverlay(message: message, busy: false, offersReconnect: true)
  }
}

/// "Watching · <who drives> · <display>" — the sentence that tells a viewer
/// whether the screen is theirs, an agent's, or someone else's right now.
///
/// This phone's own control wins over the snapshot, which lags the take by up
/// to one poll. A lease held by a user that is not this picture is someone
/// else — the desktop, or another phone.
func macDesktopViewerRibbon(
  controlling: Bool,
  lease: WorkToolsMacDesktopLease?,
  displayName: String?
) -> String {
  var parts = ["Watching"]
  if controlling {
    parts.append("you have control")
  } else if let lease {
    switch lease.holder {
    case "agent": parts.append("agent driving")
    case "user": parts.append("someone else has control")
    default: break
    }
  }
  if let name = displayName?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
    parts.append(name)
  }
  return parts.joined(separator: " · ")
}
