import SwiftUI
import UIKit

/// The Mac Desktop card in the Work tools sheet.
///
/// The still, the live subscription, and Start live here. The sheet owns the
/// lane poll and passes the latest `macDesktop` snapshot in.
struct MacDesktopCard: View {
  let laneId: String
  let macDesktop: WorkToolsMacDesktopState?
  /// Bumped after each tools poll so a stopped stream retries and the still
  /// reloads on the same cadence the sheet used to call directly.
  let refreshTick: Int
  let refreshLane: () async -> Void

  @Binding var macDesktopViewerPresented: Bool
  @Binding var macDesktopFrame: UIImage?
  @Binding var loadedMacDesktopFramePath: String?
  @Binding var isLiveMacDesktopMounted: Bool

  @EnvironmentObject private var syncService: SyncService
  @Environment(\.scenePhase) private var scenePhase

  @State private var liveSession: MacDesktopLiveSession?
  @State private var isFetchingMacDesktopFrame = false
  @State private var macDesktopStarting = false
  @State private var macDesktopStartError: String?

  var body: some View {
    card
      .onAppear { updateLiveLifecycle() }
      .onDisappear { stopLiveSession() }
      .onChange(of: scenePhase) { _, _ in updateLiveLifecycle() }
      .onChange(of: syncService.connectionState) { _, _ in updateLiveLifecycle() }
      .onChange(of: isLiveCapable) { _, _ in updateLiveLifecycle() }
      .onChange(of: macDesktopViewerPresented) { _, _ in updateLiveLifecycle() }
      .onChange(of: refreshTick) { _, _ in
        retryStoppedLiveSessionIfNeeded()
        Task { await loadMacDesktopFrameIfNeeded(allowFetch: !isLiveMacDesktopMounted) }
      }
      .fullScreenCover(isPresented: $macDesktopViewerPresented) {
        MacDesktopViewer(laneId: laneId, initialState: macDesktop)
      }
  }

  /// The lane's private macOS screen.
  ///
  /// Absent entirely unless the host both has the feature and can host a
  /// display, because a card that only ever says "not available here" is worse
  /// than no card on every phone whose Mac will never grow one.
  ///
  /// Shaped like `AppleDeviceCard` — chips, stage, error line, who is driving,
  /// Watch — but the stage is the live picture itself, and takeover, when the
  /// host advertises it, still lives on that picture. Watch opens the same
  /// picture full screen in `MacDesktopViewer`.
  @ViewBuilder
  private var card: some View {
    if let macDesktop = macDesktop, macDesktop.supported {
      ADEGlassSection(title: "macOS", subtitle: macDesktopSubtitle(macDesktop)) {
        if let display = macDesktop.display {
          VStack(alignment: .leading, spacing: 10) {
            macDesktopChips(macDesktop, display: display)
            macDesktopStage(macDesktop)
            macDesktopErrorLine(macDesktop.stream?.lastError)
            macDesktopLeaseRibbon(macDesktop.lease)
            let windows = macDesktop.windows ?? []
            if windows.isEmpty {
              Text("No windows are parked on this desktop.")
                .font(.caption)
                .foregroundStyle(ADEColor.textMuted)
            } else {
              VStack(alignment: .leading, spacing: 6) {
                ForEach(windows) { window in
                  VStack(alignment: .leading, spacing: 1) {
                    Text(window.appName)
                      .font(.subheadline.weight(.medium))
                      .foregroundStyle(ADEColor.textPrimary)
                      .lineLimit(1)
                    if let title = window.title, !title.isEmpty {
                      Text(title)
                        .font(.caption)
                        .foregroundStyle(ADEColor.textMuted)
                        .lineLimit(1)
                    }
                  }
                  .frame(maxWidth: .infinity, alignment: .leading)
                }
              }
            }
            // A window that would not park is still on the human's own Mac,
            // which is the one thing this pane cannot show a picture of — so it
            // says it. Newest only, matching the desktop panel's single line.
            if let stranded = (macDesktop.notParked ?? []).first {
              Label(
                "Window \(WorkToolsSheet.strandedWindowLabel(stranded, in: macDesktop.windows ?? [])) "
                  + "\(WorkToolsSheet.notParkedPhrase(stranded.reason)). It is still on your main screen.",
                systemImage: "exclamationmark.triangle"
              )
              .font(.caption)
              .foregroundStyle(ADEColor.warning)
              .frame(maxWidth: .infinity, alignment: .leading)
            }
            macDesktopWatchButton
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        } else {
          macDesktopOffRow
        }
      }
    }
  }

  /// "The macOS desktop is off." and Start, like the Apple Off card. The poll brings
  /// the display in once the host has made it.
  private var macDesktopOffRow: some View {
    let canStart = syncService.supportsMacDesktopStart
    return HStack(spacing: 10) {
      if macDesktopStarting {
        ProgressView()
      }
      Text(macDesktopOffCardMessage(starting: macDesktopStarting, error: macDesktopStartError, canStart: canStart))
        .font(.footnote)
        .foregroundStyle(ADEColor.textSecondary)
        .frame(maxWidth: .infinity, alignment: .leading)
      if canStart && !macDesktopStarting {
        Button {
          ADEHaptics.light()
          startMacDesktop()
        } label: {
          Label("Start", systemImage: "play.fill")
            .font(.footnote.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .frame(minHeight: 44)
            .background(Capsule().fill(ADEColor.textPrimary.opacity(0.1)))
        }
        .buttonStyle(.plain)
        .disabled(syncService.connectionState != .connected)
        .accessibilityHint("Starts this lane's macOS desktop on your Mac")
      }
    }
  }

  private func startMacDesktop() {
    macDesktopStartDisplay(
      using: syncService,
      laneId: laneId,
      starting: $macDesktopStarting,
      errorText: $macDesktopStartError,
      refresh: { await refreshLane() }
    )
  }

  /// "2560 × 1440 · 2.0 Mb/s · 30 fps", the Apple card's "runtime · bitrate ·
  /// fps" with the display's size standing in for the runtime. The rate only
  /// shows while frames are flowing.
  private func macDesktopSubtitle(_ macDesktop: WorkToolsMacDesktopState) -> String? {
    guard let display = macDesktop.display else { return nil }
    var parts = ["\(display.width) × \(display.height)"]
    if let stream = macDesktop.stream, stream.running {
      if let bitrate = stream.bitrateKbps, bitrate > 0 {
        parts.append(appleStreamBitrateLabel(kbps: bitrate))
      }
      if let fps = stream.fps, fps > 0 {
        parts.append("\(Int(fps.rounded())) fps")
      }
    }
    return parts.joined(separator: " · ")
  }

  private func macDesktopChips(_ macDesktop: WorkToolsMacDesktopState, display: WorkToolsMacDesktopDisplay) -> some View {
    HStack(spacing: 6) {
      macDesktopChip(text: display.name, systemImage: "desktopcomputer")
      let windowCount = macDesktop.windows?.count ?? 0
      if windowCount > 0 {
        macDesktopChip(text: windowCount == 1 ? "1 window" : "\(windowCount) windows", systemImage: "macwindow")
      }
      if macDesktop.recording?.running == true {
        // Its own badge rather than a chip, as on the Apple card: a recording
        // in progress is the one fact here that can surprise someone.
        ADEGlassStatusBadge(text: "Recording", tint: ADEColor.danger)
      }
      Spacer(minLength: 0)
    }
  }

  private func macDesktopChip(text: String, systemImage: String) -> some View {
    Label(text, systemImage: systemImage)
      .font(.caption)
      .foregroundStyle(ADEColor.textSecondary)
      .lineLimit(1)
      .padding(.horizontal, 8)
      .padding(.vertical, 4)
      .background(Capsule().fill(ADEColor.textPrimary.opacity(0.08)))
      .overlay(Capsule().stroke(ADEColor.textMuted.opacity(0.25), lineWidth: 1))
  }

  /// The card's picture slot.
  ///
  /// With the stream feature the live layer owns the picture and the latest
  /// still sits behind it until the first keyframe decodes. Without it the
  /// still is the picture, exactly as the rest of the read-only sheet works.
  /// While the full-screen viewer is up the inline picture is unmounted — which
  /// also hands back any control it held — and a placeholder stands in.
  @ViewBuilder
  private func macDesktopStage(_ macDesktop: WorkToolsMacDesktopState) -> some View {
    let isLive = syncService.supportsMacDesktopStream && liveSession != nil
    if !macDesktopViewerPresented,
       let display = macDesktop.display,
       isLive || macDesktopFrame != nil {
      MacDesktopControlPicture(
        laneId: laneId,
        display: display,
        session: isLive ? liveSession : nil,
        placeholder: macDesktopFrame
      )
      .overlay(alignment: .topTrailing) {
        macDesktopLiveCapsule(macDesktop.stream)
          .padding(8)
          .allowsHitTesting(false)
      }
    } else if !macDesktopViewerPresented, isFetchingMacDesktopFrame {
      HStack(spacing: 10) {
        ProgressView()
        Text("Loading the last frame…")
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    } else {
      macDesktopStagePlaceholder(macDesktop.stream)
    }
  }

  /// Same stage the Apple card draws when it has no picture: a dark slot that
  /// opens the viewer when the host can stream.
  private func macDesktopStagePlaceholder(_ stream: WorkToolsMacDesktopStream?) -> some View {
    let canWatch = syncService.supportsMacDesktopStream
    let caption: String
    if macDesktopViewerPresented {
      caption = "Watching full screen"
    } else if canWatch {
      caption = stream?.running == true ? "Tap to watch" : "Tap to start watching"
    } else {
      caption = "No picture yet"
    }
    return Button {
      ADEHaptics.light()
      macDesktopViewerPresented = true
    } label: {
      ZStack {
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .fill(Color.black.opacity(0.35))
        VStack(spacing: 6) {
          Image(systemName: "desktopcomputer")
            .font(.title3)
            .foregroundStyle(ADEColor.textMuted)
          Text(caption)
            .font(.caption2)
            .foregroundStyle(ADEColor.textMuted)
        }
        VStack {
          HStack {
            Spacer(minLength: 0)
            macDesktopLiveCapsule(stream)
          }
          Spacer(minLength: 0)
        }
        .padding(8)
      }
      .frame(height: 140)
      .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
      .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
    .buttonStyle(.plain)
    .disabled(!canWatch)
    .accessibilityLabel("Watch this lane's macOS desktop")
    .accessibilityHint("Opens the lane's screen full screen")
  }

  /// "Live" while frames flow at full rate, "Idle" at the low-power rate, and
  /// nothing when the encoder is stopped. White on dark, as on the Apple stage,
  /// so it reads over any picture.
  @ViewBuilder
  private func macDesktopLiveCapsule(_ stream: WorkToolsMacDesktopStream?) -> some View {
    if let stream, stream.running {
      Label(stream.idle ? "Idle" : "Live", systemImage: stream.idle ? "pause.circle" : "dot.radiowaves.left.and.right")
        .font(.caption2.weight(.semibold))
        .foregroundStyle(.white)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(.black.opacity(0.55), in: Capsule())
    }
  }

  /// The host's own last capture error, with any machine code stripped.
  @ViewBuilder
  private func macDesktopErrorLine(_ message: String?) -> some View {
    if let message = macDesktopVisibleMessage(message) {
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Image(systemName: "exclamationmark.triangle")
          .font(.caption2)
          .foregroundStyle(ADEColor.warning)
        Text(message)
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(3)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  /// Who has the screen, in the desktop's own words. The icon takes the accent
  /// while an agent drives, matching the chat chip.
  private func macDesktopLeaseRibbon(_ lease: WorkToolsMacDesktopLease?) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 6) {
      Image(systemName: "cursorarrow.rays")
        .font(.caption2)
        .foregroundStyle(lease?.holder == "agent" ? ADEColor.accent : ADEColor.textMuted)
      Text(macDesktopLeaseLine(lease))
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)
        .lineLimit(1)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  @ViewBuilder
  private var macDesktopWatchButton: some View {
    if syncService.supportsMacDesktopStream {
      Button {
        ADEHaptics.light()
        macDesktopViewerPresented = true
      } label: {
        Label("Watch", systemImage: "play.fill")
          .font(.footnote.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .padding(.horizontal, 14)
          .padding(.vertical, 8)
          .frame(minHeight: 44)
          .background(Capsule().fill(ADEColor.textPrimary.opacity(0.1)))
      }
      .buttonStyle(.plain)
      .accessibilityHint("Opens the lane's screen full screen")
    }
  }


  /// One still for the Mac Desktop card and the live view's placeholder.
  ///
  /// `allowFetch` is false while a live session owns the picture, which is how
  /// the card avoids becoming a 3s still-image poll under the stream. The
  /// loaded-path guard and the image cache mean even allowed calls fetch at
  /// most once per observation.
  private func loadMacDesktopFrameIfNeeded(allowFetch: Bool) async {
    guard let path = macDesktopObservationPath else {
      macDesktopFrame = nil
      loadedMacDesktopFramePath = nil
      return
    }
    guard loadedMacDesktopFramePath != path else { return }
    let cacheKey = "work-tools-mac-desktop-observation::\(path)"
    if let cached = ADEImageCache.shared.cachedImage(for: cacheKey) {
      macDesktopFrame = cached
      loadedMacDesktopFramePath = path
      return
    }
    guard allowFetch, syncService.supportsWorkToolsObservationPreview else { return }
    guard !isFetchingMacDesktopFrame else { return }
    isFetchingMacDesktopFrame = true
    defer { isFetchingMacDesktopFrame = false }
    let preview: WorkToolsObservationPreview?
    do {
      preview = try await syncService.readWorkToolsObservationPreview(path: path)
    } catch {
      // Transient; the next allowed call retries. Never recorded as a verdict.
      return
    }
    guard !Task.isCancelled else { return }
    guard
      let preview,
      let data = WorkToolsSheet.decodeDataUrl(preview.dataUrl),
      let image = UIImage(data: data)
    else {
      // The host answered and had nothing to give. A retry cannot change that.
      loadedMacDesktopFramePath = path
      macDesktopFrame = nil
      return
    }
    ADEImageCache.shared.store(data, for: cacheKey)
    macDesktopFrame = image
    loadedMacDesktopFramePath = path
  }

  // MARK: - Live stream lifecycle

  /// True when the host can stream and this lane has a display to stream. The
  /// feature-absent host and the lane with no desktop both keep the still.
  private var isLiveCapable: Bool {
    syncService.supportsMacDesktopStream
      && macDesktop?.supported == true
      && macDesktop?.display != nil
  }

  private var macDesktopObservationPath: String? {
    macDesktop?.lastObservation?.screenshotPath
  }

  /// The one decision point for the subscription: the card is on screen, the
  /// app is in the foreground, the socket is up, and the lane has a display.
  private func updateLiveLifecycle() {
    let shouldRun = isLiveCapable
      && !macDesktopViewerPresented
      && scenePhase == .active
      && syncService.connectionState == .connected
    if shouldRun {
      startLiveSessionIfNeeded()
    } else {
      stopLiveSession()
    }
  }

  private func startLiveSessionIfNeeded() {
    guard liveSession == nil else { return }
    // Stable per lane, per app instance, and per device: rebuilding the view
    // cannot stack a second subscription onto the host for the same display,
    // and two phones watching one lane cannot steal each other's subscription.
    let session = mountMacDesktopLiveSession(
      laneId: laneId,
      subscriptionId: "ios-\(syncService.deviceId)-mac-desktop-\(laneId)",
      using: syncService
    )
    liveSession = session
    isLiveMacDesktopMounted = true
    // One still for the wait, never a poll.
    Task { await loadMacDesktopFrameIfNeeded(allowFetch: true) }
    Task { await session.start(using: syncService) }
  }

  private func stopLiveSession() {
    guard let session = liveSession else { return }
    session.stop(using: syncService)
    liveSession = nil
    isLiveMacDesktopMounted = false
  }

  /// A `stopped` stream is the encoder pausing — no viewers left, or an
  /// explicit stop — not the subscription dying. The session stays mounted on
  /// "The stream stopped."; when the lane's display later reports running
  /// again (the desktop restarted the encoder), re-attach instead of waiting
  /// for the sheet to be reopened.
  private func retryStoppedLiveSessionIfNeeded() {
    guard let session = liveSession else { return }
    guard case .ended(let reason, _) = session.phase, reason == "stopped" else { return }
    guard isLiveCapable,
          !macDesktopViewerPresented,
          scenePhase == .active,
          syncService.connectionState == .connected
    else { return }
    Task { await session.start(using: syncService) }
  }

}
