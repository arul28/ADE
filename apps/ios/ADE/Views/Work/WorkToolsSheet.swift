import SwiftUI
import UIKit

/// Read-only view of the Work tools pane running on the user's Mac.
///
/// Five cards, in the order a user actually asks about them: what the desktop
/// has open right now (with the last frame it captured), the two screens the
/// phone can watch — the lane's Apple device (view only) and, when this Mac can
/// host one, the lane's own private screen — then what the browser has in it
/// and what App Control is driving. The browser is a `WebContentsView` in ADE
/// Desktop and App Control is a CDP socket to a local process; neither can be
/// reached from a phone, so those cards stay read-only. The Apple card offers
/// only a view-only `Watch` button. Mac Desktop is the exception: when the host
/// advertises takeover, the picture takes a finger, inline or full screen.
///
/// Refresh is a poll, not a subscription. The brain has no generic named-event
/// channel to the phone — its push surface is cr-sqlite changesets and this
/// state is deliberately not table-backed (see `workToolsStateService`) — so
/// the sheet polls while it is open and stops the moment it closes.
struct WorkToolsSheet: View {
  let laneId: String

  /// Poll cadence while the sheet is visible. Slow enough to be free on a
  /// cellular link, fast enough that switching tools on the Mac reads as live.
  private static let refreshInterval: Duration = .seconds(3)

  @EnvironmentObject private var syncService: SyncService
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase

  @State private var state: WorkToolsLaneState?
  @State private var loaded = false
  @State private var frame: UIImage?
  @State private var loadedFramePath: String?
  /// The observation path the host has already refused to turn into bytes. See
  /// `loadFrameIfNeeded`: only a definitive answer lands here, never a
  /// transport failure.
  @State private var unreadableFramePath: String?
  /// The Mac Desktop card's own still image, separate from the active-tool
  /// frame above. While a live session is up it is the placeholder behind the
  /// stream and is fetched exactly once; it is only polled on hosts without
  /// the stream feature.
  @State private var macDesktopFrame: UIImage?
  @State private var loadedMacDesktopFramePath: String?
  /// The one live subscription for this lane. Non-nil only while the sheet is
  /// on screen, active, connected, and the host can stream the lane's display.
  @State private var liveSession: MacDesktopLiveSession?
  @State private var isFetchingMacDesktopFrame = false
  /// While the full-screen viewer is up it owns the picture and the poll, so
  /// the inline session stops rather than streaming the same screen twice.
  @State private var macDesktopViewerPresented = false
  /// The Off row's Start is in flight. Opening the sheet never starts a
  /// display; only that button does.
  @State private var macDesktopStarting = false
  @State private var macDesktopStartError: String?

  #if DEBUG
  /// Fixture seam for previews and simulator screenshots. When set, `refresh`
  /// installs this instead of asking the sync socket, so the sheet renders its
  /// populated state with no desktop, no pairing, and no network.
  var previewState: WorkToolsLaneState?
  var previewFrame: UIImage?
  #endif

  var body: some View {
    NavigationStack {
      Group {
        if !loaded {
          loadingState
        } else if state == nil {
          noDesktopState
        } else {
          content
        }
      }
      .adeScreenBackground()
      .navigationTitle("Tools")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done") { dismiss() }
        }
      }
    }
    .task(id: laneId) { await refresh() }
    .task(id: laneId) {
      // The poll lives beside the initial load rather than inside it so a slow
      // first response cannot delay the cadence, and cancellation on dismiss
      // stops both.
      while !Task.isCancelled {
        try? await Task.sleep(for: Self.refreshInterval)
        guard !Task.isCancelled else { return }
        // The viewer polls the same read itself while it is up.
        guard !macDesktopViewerPresented else { continue }
        await refresh()
      }
    }
    .onAppear { updateLiveLifecycle() }
    .onDisappear { stopLiveSession() }
    .onChange(of: scenePhase) { _, _ in updateLiveLifecycle() }
    .onChange(of: syncService.connectionState) { _, _ in updateLiveLifecycle() }
    .onChange(of: isLiveCapable) { _, _ in updateLiveLifecycle() }
    .onChange(of: macDesktopViewerPresented) { _, presented in
      updateLiveLifecycle()
      // Catch up on whatever changed while the viewer was up.
      if !presented { Task { await refresh() } }
    }
    .fullScreenCover(isPresented: $macDesktopViewerPresented) {
      MacDesktopViewer(laneId: laneId, initialState: state?.macDesktop)
    }
  }

  private var content: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        activeToolCard
        // Above the browser because it is live: the browser and App Control
        // cards describe what the Mac has open, this one can be watched. Gated on the host advertising `apple.status` so an older
        // Mac shows the sheet it always showed rather than a new card that
        // only ever says "update".
        if syncService.supportsAppleDeviceStatus {
          AppleDeviceCard(laneId: laneId)
        }
        // The other screen the phone can watch, so it sits with the Apple one.
        macDesktopCard
        browserCard
        appControlCard
        Text(syncService.supportsMacDesktopControl
          ? "Browser and App Control stay on the desktop."
          : "Control from the desktop")
          .font(.caption)
          .foregroundStyle(ADEColor.textMuted)
          .frame(maxWidth: .infinity, alignment: .center)
          .padding(.top, 2)
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 16)
    }
    .refreshable { await refresh() }
  }

  // MARK: - Cards

  @ViewBuilder
  private var activeToolCard: some View {
    let toolLabel = workToolsDisplayName(state?.activeTool)
    ADEGlassSection(
      title: toolLabel.map { "\($0) is open" } ?? "No tool is open",
      subtitle: latestObservation?.caption
    ) {
      // The desktop's tab strip, mirrored read-only: the active tool is filled,
      // the rest are outlined. Shown only when there is more than one tab —
      // with a single tab the section title already names it.
      if openTools.count > 1 {
        // Six capsules at `.caption` overflow a 320 pt phone; without this the
        // strip truncates every name to an unreadable stub. Indicator hidden so
        // a strip that happens to fit still looks like the desktop's.
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 6) {
            ForEach(openTools, id: \.self) { tool in
              let isActive = tool == state?.activeTool
              Text(workToolsDisplayName(tool) ?? tool)
                .font(.caption.weight(isActive ? .semibold : .regular))
                .foregroundStyle(isActive ? ADEColor.textPrimary : ADEColor.textSecondary)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(
                  Capsule().fill(isActive ? ADEColor.textPrimary.opacity(0.12) : Color.clear)
                )
                .overlay(
                  Capsule().stroke(ADEColor.textMuted.opacity(isActive ? 0 : 0.35), lineWidth: 1)
                )
                .accessibilityLabel(
                  isActive
                    ? "\(workToolsDisplayName(tool) ?? tool), open and showing"
                    : "\(workToolsDisplayName(tool) ?? tool), open"
                )
                .accessibilityHint(workToolsAccessibilityHint(tool) ?? "")
            }
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.bottom, 4)
      }
      switch frameState {
      case .image:
        if let frame {
          Image(uiImage: frame)
            .resizable()
            .scaledToFit()
            .frame(maxWidth: .infinity)
            .background(Color.black.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .accessibilityLabel(latestObservation?.caption ?? "Latest captured frame")
        }
      case .loading:
        HStack(spacing: 10) {
          ProgressView()
          Text("Loading the last frame…")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      case .unavailable(let message):
        Text(message)
          .font(.footnote)
          .foregroundStyle(ADEColor.textSecondary)
          .frame(maxWidth: .infinity, alignment: .leading)
      case .empty:
        Text("Nothing has been captured in this lane yet.")
          .font(.footnote)
          .foregroundStyle(ADEColor.textSecondary)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
  }

  @ViewBuilder
  private var browserCard: some View {
    ADEGlassSection(title: "Browser", subtitle: browserSubtitle) {
      // Leads the card, above the handoff bar and the tabs: "an agent is on this
      // right now" changes how everything under it reads. One line, no count —
      // which chat it is is the desktop's business, and the phone cannot open
      // it from here anyway.
      if isAgentUsingBrowser {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          Image(systemName: "globe")
            .font(.caption2)
            .foregroundStyle(ADEColor.accent)
          Text("Agent is using the browser")
            .font(.footnote)
            .foregroundStyle(ADEColor.textSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.bottom, 8)
        .accessibilityLabel("An agent is using the browser right now")
      }
      if let reason = handoffReason {
        // The lane is not stuck, it is waiting on a person. One line, worded
        // exactly like the desktop's handoff bar (`BrowserHandoffBar`) — the
        // phone is describing that bar, so it must not invent a second
        // sentence for the same state. Read-only here: the sign-in has to
        // happen in the desktop browser.
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          Image(systemName: "hand.raised.fill")
            .font(.caption2)
            .foregroundStyle(ADEColor.warning)
          Text("Agent needs you to sign in · “\(reason)”")
            .font(.footnote)
            .foregroundStyle(ADEColor.textSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.bottom, 8)
      }
      if let tabs = state?.browser?.tabs, !tabs.isEmpty {
        VStack(alignment: .leading, spacing: 10) {
          ForEach(tabs) { tab in
            WorkToolsTabRow(tab: tab)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      } else {
        Text(state?.browser == nil ? browserUnavailableMessage : "No tabs are open in this lane.")
          .font(.footnote)
          .foregroundStyle(ADEColor.textSecondary)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
  }

  @ViewBuilder
  private var appControlCard: some View {
    ADEGlassSection(title: "App Control") {
      if let appControl = state?.appControl {
        VStack(alignment: .leading, spacing: 3) {
          Text(appControl.appName)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
          Text("\(appControl.status) · \(appControl.driver)")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      } else {
        Text("No app is attached in this lane.")
          .font(.footnote)
          .foregroundStyle(ADEColor.textSecondary)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
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
  private var macDesktopCard: some View {
    if let macDesktop = state?.macDesktop, macDesktop.supported {
      ADEGlassSection(title: "Mac Desktop", subtitle: macDesktopSubtitle(macDesktop)) {
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
                "Window \(Self.strandedWindowLabel(stranded, in: macDesktop.windows ?? [])) "
                  + "\(Self.notParkedPhrase(stranded.reason)). It is still on your main screen.",
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

  /// "Mac Desktop is off." and Start, like the Apple Off card. The poll brings
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
        .accessibilityHint("Starts this lane's Mac Desktop on your Mac")
      }
    }
  }

  private func startMacDesktop() {
    guard !macDesktopStarting else { return }
    macDesktopStarting = true
    macDesktopStartError = nil
    Task {
      do {
        try await syncService.macDesktopStart(laneId: laneId)
        await refresh()
      } catch {
        macDesktopStartError = (error as NSError).localizedDescription
      }
      macDesktopStarting = false
    }
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
    .accessibilityLabel("Watch this lane's Mac Desktop")
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

  /// The host's own last capture error, verbatim, as on the Apple card.
  @ViewBuilder
  private func macDesktopErrorLine(_ message: String?) -> some View {
    if let message, !message.isEmpty {
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

  private var loadingState: some View {
    VStack(spacing: 12) {
      ProgressView()
      Text("Reading your Mac…")
        .font(.footnote)
        .foregroundStyle(ADEColor.textSecondary)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private var noDesktopState: some View {
    VStack(spacing: 12) {
      Image(systemName: "desktopcomputer")
        .font(.title3.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
      Text("Tools run on the desktop. Open ADE on your Mac to see them here.")
        .font(.footnote)
        .foregroundStyle(ADEColor.textSecondary)
        .multilineTextAlignment(.center)
        .padding(.horizontal, 28)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  // MARK: - Data

  /// The desktop's tab strip. A desktop older than the strip publishes none, so
  /// its one active tool stands in for the one tab that build had.
  private var openTools: [String] {
    guard let state else { return [] }
    if let published = state.openTools { return published }
    return state.activeTool.map { [$0] } ?? []
  }

  /// The first open login handoff in this lane, if any.
  private var handoffReason: String? {
    state?.browser?.tabs.compactMap(\.handoffReason).first
  }

  /// Whether any chat in this lane is driving the browser right now. Nil from an
  /// older desktop and empty both read as "nobody".
  private var isAgentUsingBrowser: Bool {
    !(state?.agentBrowserPresence ?? []).isEmpty
  }

  private var browserUnavailableMessage: String {
    workToolsBrowserUnavailableMessage(state?.browserUnavailable)
  }

  private var browserSubtitle: String? {
    guard let tabs = state?.browser?.tabs, !tabs.isEmpty else { return nil }
    return tabs.count == 1 ? "1 tab" : "\(tabs.count) tabs"
  }

  /// The frame to show above the fold: the pane the desktop has open wins, and
  /// otherwise whichever tool captured something.
  private var latestObservation: WorkToolsObservation? {
    guard let state else { return nil }
    let macDesktop = state.macDesktop?.lastObservation.map {
      WorkToolsObservation(path: $0.screenshotPath, caption: $0.caption)
    }
    if state.activeTool == "mac-desktop" {
      return macDesktop ?? state.browser?.latestObservation ?? state.appControl?.latestObservation
    }
    if state.activeTool == "app-control" {
      return state.appControl?.latestObservation ?? state.browser?.latestObservation ?? macDesktop
    }
    return state.browser?.latestObservation ?? state.appControl?.latestObservation ?? macDesktop
  }

  /// What the frame slot renders. Split out of the view so the one case that
  /// cannot be reached from a preview or a screenshot — a host that advertises
  /// `workTools.getLaneState` but not `workTools.readObservationPreview` — is
  /// covered by a test rather than by hoping.
  private var frameState: WorkToolsFrameState {
    let observationPath = latestObservation?.path
    return workToolsFrameState(
      observationPath: observationPath,
      loadedFramePath: frame == nil ? nil : loadedFramePath,
      unreadableFramePath: unreadableFramePath,
      supportsObservationPreview: syncService.supportsWorkToolsObservationPreview
    )
  }

  /// The window's own title when the lane still knows it, else its id — the
  /// same choice the desktop panel makes, so one screen does not name a window
  /// the other cannot.
  static func strandedWindowLabel(
    _ stranded: WorkToolsMacDesktopNotParked,
    in windows: [WorkToolsMacDesktopWindow]
  ) -> String {
    let title = windows.first { $0.id == stranded.windowId }?.title?
      .trimmingCharacters(in: .whitespacesAndNewlines)
    if let title, !title.isEmpty { return title }
    return String(stranded.windowId)
  }

  /// The human half of a driver reason code. Mirrors
  /// `macDesktopNotParkedPhrase` in `shared/types/macDesktop.ts`; the host only
  /// sends codes worth showing, so there is no retry case to hide here — it is
  /// still mapped, because an older host may send one.
  static func notParkedPhrase(_ reason: String) -> String {
    let code = reason.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if code == "not_ready" || code == "window_not_ready" { return "is still opening" }
    if code == "escaped" || code == "window_escaped" || code == "gave_up" {
      return "keeps leaving the lane screen"
    }
    if code.contains("permission") || code.contains("accessibility") || code.contains("not_trusted") {
      return "needs Accessibility permission"
    }
    return reason
  }

  private func refresh() async {
    #if DEBUG
    if let previewState {
      state = previewState
      frame = previewFrame
      loadedFramePath = previewFrame == nil ? nil : latestObservation?.path
      loaded = true
      return
    }
    #endif
    // Same gate the lane tool chips use. The sheet is only reachable from a
    // chip that has already checked this, but a reconnect to an older brain can
    // drop the action while the sheet is open — and a 3s timer must not keep
    // putting an unknown command on the wire.
    guard syncService.supportsWorkToolsState else {
      loaded = true
      return
    }
    let next = try? await syncService.fetchWorkToolsLaneState(laneId: laneId)
    guard !Task.isCancelled else { return }
    state = next
    loaded = true
    // `stopped` ends the subscription but leaves the session mounted; the
    // next poll is where "the display is running again" is noticed.
    retryStoppedLiveSessionIfNeeded()
    await loadFrameIfNeeded()
    // While a live session is mounted the card's still is not polled: the
    // picture arrives on the socket and the one-shot placeholder loaded at
    // session start is all the fallback that is ever needed.
    await loadMacDesktopFrameIfNeeded(allowFetch: !isLiveMacDesktopMounted)
  }

  private func loadFrameIfNeeded() async {
    guard let path = latestObservation?.path else {
      frame = nil
      loadedFramePath = nil
      unreadableFramePath = nil
      return
    }
    guard loadedFramePath != path else { return }
    // The live view owns the mac-desktop observation while it is mounted. If
    // the top card is showing that tool, reuse the placeholder already loaded
    // for the card instead of starting the 3s still poll the stream replaced.
    if isLiveMacDesktopMounted, path == macDesktopObservationPath {
      if loadedMacDesktopFramePath == path, let macDesktopFrame {
        frame = macDesktopFrame
        loadedFramePath = path
        unreadableFramePath = nil
      }
      return
    }
    // A host that advertises the state read but not the preview read cannot
    // send bytes at all. Nothing is put on the wire, and `frameState` says so
    // instead of spinning under a frame that is never coming.
    guard syncService.supportsWorkToolsObservationPreview else { return }
    // The host already answered "no bytes" for this exact path. That verdict is
    // about the file, not the link, so re-asking every 3s would spin forever.
    guard unreadableFramePath != path else { return }
    let cacheKey = "work-tools-observation::\(path)"
    if let cached = ADEImageCache.shared.cachedImage(for: cacheKey) {
      frame = cached
      loadedFramePath = path
      unreadableFramePath = nil
      return
    }
    let preview: WorkToolsObservationPreview?
    do {
      preview = try await syncService.readWorkToolsObservationPreview(path: path)
    } catch {
      // Transient: a timeout or a dropped socket. Deliberately NOT recorded as
      // unreadable — the spinner stays and the next poll asks again.
      return
    }
    guard !Task.isCancelled else { return }
    guard
      let preview,
      let data = Self.decodeDataUrl(preview.dataUrl),
      let image = UIImage(data: data)
    else {
      // The host answered and had nothing to give: the file is gone, over the
      // size cap, or not an image type it serves. A retry cannot change that.
      unreadableFramePath = path
      return
    }
    ADEImageCache.shared.store(data, for: cacheKey)
    frame = image
    loadedFramePath = path
    unreadableFramePath = nil
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
      let data = Self.decodeDataUrl(preview.dataUrl),
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
      && state?.macDesktop?.supported == true
      && state?.macDesktop?.display != nil
  }

  /// Whether a live session object is mounted right now. Its lifetime is the
  /// subscription's.
  private var isLiveMacDesktopMounted: Bool {
    liveSession != nil
  }

  private var macDesktopObservationPath: String? {
    state?.macDesktop?.lastObservation?.screenshotPath
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
    let session = MacDesktopLiveSession(
      laneId: laneId,
      subscriptionId: "ios-\(syncService.deviceId)-mac-desktop-\(laneId)",
      viewerLabel: MacDesktopLiveSession.defaultViewerLabel()
    )
    syncService.registerMacDesktopStream(
      subscriptionId: session.subscriptionId,
      onRecord: { [weak session] record in session?.consume(record) },
      onEnded: { [weak session] ended in session?.noteEnded(ended) }
    )
    liveSession = session
    // One still for the wait, never a poll.
    Task { await loadMacDesktopFrameIfNeeded(allowFetch: true) }
    Task { await session.start(using: syncService) }
  }

  private func stopLiveSession() {
    guard let session = liveSession else { return }
    session.stop(using: syncService)
    liveSession = nil
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

  /// Ceiling on a decoded observation frame. These are desktop-resolution PNG
  /// screenshots, so a real one lands well under this; 8 MiB clears even a
  /// Retina full-screen capture while bounding what a malformed or oversized
  /// payload can make the phone allocate. This decode runs on every poll while
  /// the sheet is open, so an unbounded one is a repeatable allocation.
  private static let observationPreviewMaxBytes = 8 * 1024 * 1024

  /// Splits a `data:<mime>;base64,<payload>` URL. The host only ever sends this
  /// shape, but a malformed one must produce no image rather than a crash — and
  /// the size is checked before the bytes are allocated.
  static func decodeDataUrl(_ dataUrl: String) -> Data? {
    guard dataUrl.hasPrefix("data:"), let commaIndex = dataUrl.firstIndex(of: ",") else { return nil }
    let payload = String(dataUrl[dataUrl.index(after: commaIndex)...])
    return WorkChatAttachmentImagePreview.base64DecodedImageData(
      payload,
      maxBytes: observationPreviewMaxBytes
    )
  }
}

private struct WorkToolsTabRow: View {
  let tab: WorkToolsBrowserTab

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      HStack(spacing: 6) {
        Text(displayTitle)
          .font(.subheadline.weight(.medium))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
        if tab.active {
          ADEGlassStatusBadge(text: "Active", tint: ADEColor.accent)
        }
        if tab.recording {
          ADEGlassStatusBadge(text: "Recording", tint: ADEColor.danger)
        }
        Spacer(minLength: 0)
      }
      if let url = tab.url, !url.isEmpty {
        Text(url)
          .font(.caption)
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(1)
          .truncationMode(.middle)
      }
      if tab.ownerChatSessionId?.isEmpty == false {
        Text("Claimed by a chat in this lane")
          .font(.caption2)
          .foregroundStyle(ADEColor.textMuted)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .combine)
  }

  private var displayTitle: String {
    if let title = tab.title, !title.isEmpty { return title }
    return "Untitled tab"
  }
}

/// What the "open tool" card should draw where the last captured frame goes.
///
/// A separate type because one of its cases is otherwise unreachable in the
/// app: a brain can advertise `workTools.getLaneState` without
/// `workTools.readObservationPreview` (the two are feature-detected apart, see
/// `SyncService.supportsWorkToolsObservationPreview`), and in that state the
/// lane state still names an observation the phone can never fetch. Deciding
/// this inside the view meant "frame is nil but an observation exists" fell to
/// the loading branch, so that host showed a spinner that could not finish.
enum WorkToolsFrameState: Equatable {
  case image
  case loading
  /// There is a frame on the Mac and no way to get it. Carries the sentence.
  case unavailable(String)
  case empty
}

/// The host cannot send bytes at all — it is missing the preview command.
/// Worded like the sheet's other absences: what is true, not what to do, since
/// the fix is to update ADE on the Mac and this sheet cannot say that usefully
/// about a version it is only inferring.
let workToolsFramesUnsupportedMessage = "Frames aren't available from this machine."

/// The host answered about this specific frame and had nothing to give.
let workToolsFrameUnreadableMessage = "Couldn't load the last frame."

/// Pure resolution of the four inputs the card has.
///
/// `loadedFramePath` is the path the currently held image was decoded from —
/// pass nil when there is no image, so a stale path can never claim a frame the
/// view does not have. `unreadableFramePath` is only ever set from a definitive
/// answer, never from a transport failure, so a timeout keeps the spinner and
/// retries rather than declaring the frame gone.
func workToolsFrameState(
  observationPath: String?,
  loadedFramePath: String?,
  unreadableFramePath: String?,
  supportsObservationPreview: Bool
) -> WorkToolsFrameState {
  guard let observationPath else { return .empty }
  if loadedFramePath == observationPath { return .image }
  guard supportsObservationPreview else { return .unavailable(workToolsFramesUnsupportedMessage) }
  if unreadableFramePath == observationPath { return .unavailable(workToolsFrameUnreadableMessage) }
  return .loading
}

/// Why there is no browser to show. The desktop distinguishes five cases
/// (`WorkToolsUnavailableReason`) and only one of them is "open ADE on your
/// Mac" — telling a user to open an app that is already open, because the read
/// failed, sends them chasing the wrong thing. An unknown or absent reason
/// falls back to the common case rather than inventing a diagnosis.
///
/// Keep these sentences byte-identical to `workToolsUnavailableMessage` in
/// `apps/desktop/src/shared/types/workTools.ts`: this switch cannot import it,
/// so a reason worded there and not here silently reads as the default. It is a
/// free function rather than a view-private computed property so the parity
/// test can hold the two wordings against each other.
func workToolsBrowserUnavailableMessage(_ reason: String?) -> String {
  switch reason {
  case "unsupported":
    return "The browser isn't available on this machine."
  case "error":
    return "Couldn't read the browser's state."
  case "desktop_not_attached_for_project":
    // Distinct from the default on purpose: ADE Desktop *is* running, it just
    // doesn't have this project open, so "open ADE on your Mac" would send the
    // user to look at an app that is already in front of them.
    return "ADE Desktop doesn't have this project open. Open it on your Mac to see its tabs."
  case "browser_pane_not_opened":
    // Narrower still: the project IS open on the desktop, only the Browser pane
    // is unused, so the instruction is one click — not "open the project",
    // which would be a lie about something already in front of them.
    return "Open the Browser tool on the desktop to see tabs here."
  default:
    return "The browser runs in ADE Desktop. Open ADE on your Mac to see its tabs."
  }
}

/// Who has the lane's screen, in the sheet's one line.
///
/// Worded identically to the desktop's takeover strip so the two surfaces
/// cannot describe one lease two ways. An unknown holder from a newer host
/// falls back to the neutral sentence rather than guessing which side it is.
func macDesktopLeaseLine(_ lease: WorkToolsMacDesktopLease?) -> String {
  guard let lease else { return "Nobody has taken control." }
  let label = lease.holderLabel.flatMap { $0.isEmpty ? nil : " · \($0)" } ?? ""
  switch lease.holder {
  case "user": return "You have control\(label)"
  case "agent": return "Agent driving\(label)"
  default: return "Nobody has taken control."
  }
}
