import SwiftUI
import UIKit

/// Read-only view of one Work tool running on the user's Mac: the browser, App
/// Control, or the lane's Mac Desktop. Each lane tool chip opens its own tool;
/// the Apple device has its own full-screen viewer and no sheet.
///
/// The browser is a `WebContentsView` in ADE Desktop and App Control is a CDP
/// socket to a local process; neither can be reached from a phone, so those
/// sheets stay read-only. Mac Desktop is the exception: when the host
/// advertises takeover, the picture takes a finger, inline or full screen.
///
/// Refresh is a poll, not a subscription. The brain has no generic named-event
/// channel to the phone — its push surface is cr-sqlite changesets and this
/// state is deliberately not table-backed (see `workToolsStateService`) — so
/// the sheet polls while it is open and stops the moment it closes.
struct WorkToolsSheet: View {
  /// The one tool the sheet shows.
  enum Tool: Equatable {
    case browser
    case appControl
    case macDesktop

    var title: String {
      switch self {
      case .browser: return "Browser"
      case .appControl: return "App Control"
      case .macDesktop: return "macOS"
      }
    }
  }

  let laneId: String
  let tool: Tool

  /// Poll cadence while the sheet is visible. Slow enough to be free on a
  /// cellular link, fast enough that switching tools on the Mac reads as live.
  private static let refreshInterval: Duration = .seconds(3)

  @EnvironmentObject private var syncService: SyncService
  @Environment(\.dismiss) private var dismiss

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
  /// While the full-screen viewer is up it owns the picture and the poll, so
  /// the inline session stops rather than streaming the same screen twice.
  @State private var macDesktopViewerPresented = false
  /// True while the card holds a live subscription. The active-tool frame
  /// reuses the card's still instead of polling the same path.
  @State private var isLiveMacDesktopMounted = false
  /// Bumped after each tools poll. The card retries a stopped stream and
  /// reloads its still on that tick.
  @State private var macDesktopRefreshTick = 0

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
      .navigationTitle(tool.title)
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
    .onChange(of: macDesktopViewerPresented) { _, presented in
      // Catch up on whatever changed while the viewer was up.
      if !presented { Task { await refresh() } }
    }
  }

  private var content: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        switch tool {
        case .browser:
          browserCard
          lastFrameCard
        case .appControl:
          appControlCard
          lastFrameCard
        case .macDesktop:
          MacDesktopCard(
            laneId: laneId,
            macDesktop: state?.macDesktop,
            refreshTick: macDesktopRefreshTick,
            refreshLane: { await refresh() },
            macDesktopViewerPresented: $macDesktopViewerPresented,
            macDesktopFrame: $macDesktopFrame,
            loadedMacDesktopFramePath: $loadedMacDesktopFramePath,
            isLiveMacDesktopMounted: $isLiveMacDesktopMounted
          )
        }
        if tool != .macDesktop {
          Text("Control from the desktop")
            .font(.caption)
            .foregroundStyle(ADEColor.textMuted)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.top, 2)
        }
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 16)
    }
    .refreshable { await refresh() }
  }

  // MARK: - Cards

  /// The last frame this tool captured, when it has one. The Mac Desktop sheet
  /// has its own picture in `MacDesktopCard`.
  @ViewBuilder
  private var lastFrameCard: some View {
    if latestObservation != nil {
      ADEGlassSection(title: "Last frame", subtitle: latestObservation?.caption) {
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
          EmptyView()
        }
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

  /// The last frame of the sheet's tool. The Mac Desktop sheet draws its own.
  private var latestObservation: WorkToolsObservation? {
    switch tool {
    case .browser: return state?.browser?.latestObservation
    case .appControl: return state?.appControl?.latestObservation
    case .macDesktop: return nil
    }
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
    // Never the raw code: a user cannot act on "window_not_movable".
    return "couldn't move to the lane screen"
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
    await loadFrameIfNeeded()
    // The card retries a stopped stream and reloads its still on this tick.
    // While a live session is mounted that still is not polled: the picture
    // arrives on the socket and the one-shot placeholder loaded at session
    // start is all the fallback that is ever needed.
    macDesktopRefreshTick += 1
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
    if isLiveMacDesktopMounted, path == state?.macDesktop?.lastObservation?.screenshotPath {
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
