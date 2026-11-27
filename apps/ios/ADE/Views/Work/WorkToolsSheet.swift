import SwiftUI
import UIKit

/// View of one Work tool running on the user's Mac: the browser, App Control,
/// or the lane's Mac Desktop. Each lane tool chip opens its own tool; the Apple
/// device has its own full-screen viewer and no sheet.
///
/// Watching only, with these exceptions: a browser tab can be closed (its ×,
/// with a few seconds to undo before the close is sent), a lane's dev server can
/// be opened in a background desktop tab and watched here, a watched tab takes
/// a finger after Take control, and Mac Desktop takes a finger when the host
/// allows takeover.
///
/// The browser is a `WebContentsView` in ADE Desktop and App Control is a CDP
/// socket to a local process; neither can be driven from a phone. App Control
/// can be watched: its sheet shows the app's live frames when the host serves
/// `appControl.streamSubscribe`. Mac Desktop is the exception: when the host
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
  /// Shown inside a split column rather than as a sheet: the pane owns closing,
  /// so the nav bar's Done would be a dead control.
  var embedded = false

  /// Poll cadence while the sheet is visible. Slow enough to be free on a
  /// cellular link, fast enough that switching tools on the Mac reads as live.
  private static let refreshInterval: Duration = .seconds(3)

  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  private var syncService: SyncService { syncPublishes.service }
  @Environment(\.dismiss) private var dismiss
  /// The Duo's outer display, upright: its trailing column is the edge rail.
  @State private var displayHasEdgeRail = false

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
  /// The App Control viewer owns the live picture while it is up.
  @State private var appControlViewerPresented = false
  /// Tabs whose × was tapped and whose close has not been sent yet: each one
  /// waits `closeUndoWindow` so Undo can take it back. Keyed by tab id.
  @State private var pendingTabCloses: [String: Task<Void, Never>] = [:]
  /// Tabs this sheet closed. Hidden at once, before the next poll confirms it.
  @State private var closedTabIds: Set<String> = []
  @State private var tabCloseError: String?

  @Environment(\.scenePhase) private var scenePhase
  /// The tab the person tapped to watch. Nil follows the agent, then the
  /// active tab; see `liveTabId`.
  @State private var watchedTabId: String?
  /// Newest live picture of `liveFrameTabId`, from `workTools.readBrowserTabFrame`.
  /// Nil until the first frame arrives and again once frames stop for
  /// `liveFrameStaleAfter`, which brings the last-observation card back.
  @State private var liveFrame: UIImage?
  @State private var liveFrameTabId: String?
  @State private var liveFrameInfo: WorkToolsBrowserTabFrame?
  /// "Take control" is on: taps, drags and typing go to the tab.
  @State private var browserInControl = false
  /// Lay the watched page out at the phone's size (the default) or show the
  /// desktop's own layout. Kept across launches.
  @AppStorage("ade.workTools.browserPhoneSize") private var browserPhoneSize = true
  /// The width of the sheet's content column and the height of its visible
  /// area, in points: what the live picture is sized from.
  @State private var contentWidth: CGFloat = 0
  @State private var visibleHeight: CGFloat = 0
  @Environment(\.displayScale) private var displayScale
  /// The lane's dev servers, from `workTools.listDevServers`, refreshed with the state.
  @State private var devServers: [WorkToolsDevServer] = []
  /// The last fresh read of the dev servers failed.
  @State private var devServersLoadFailed = false
  /// The desktop answered a phone-size read without saying whether it laid
  /// the page out (it predates phone size), so the switch would do nothing.
  @State private var desktopIgnoresPhoneSize = false
  /// Goes up on each lane switch, so work started for the old lane can tell.
  @State private var laneGeneration = 0

  /// Live frame cadence. One request is in flight at a time, so a slow link
  /// simply gets fewer frames.
  private static let liveFrameInterval: Duration = .milliseconds(300)
  /// After a failed read, wait this long before asking again.
  private static let liveFrameRetryDelay: Duration = .seconds(1)
  /// No frame for this long and the card falls back to the last observation.
  private static let liveFrameStaleAfter: TimeInterval = 5
  /// Width asked of the desktop. Enough for a phone screen at 3x on a card,
  /// small enough to keep each frame a modest JPEG.
  private static let liveFrameMaxWidth = 1_000

  /// How long a closed tab can be taken back before the close is sent.
  private static let closeUndoWindow: Duration = .seconds(5)

  #if DEBUG
  /// Fixture seam for previews and simulator screenshots. When set, `refresh`
  /// installs this instead of asking the sync socket, so the sheet renders its
  /// populated state with no desktop, no pairing, and no network.
  var previewState: WorkToolsLaneState?
  var previewFrame: UIImage?
  /// Shows the tab rows' × with no host to send the close to.
  var previewAllowsTabClose = false
  /// Opens with this tab's close already waiting on Undo.
  var previewPendingCloseTabId: String?
  /// Shows `previewFrame` as the live picture, with Take control.
  var previewLiveBrowser = false
  #endif

  /// The host serves live frames of a browser tab.
  private var supportsLiveBrowser: Bool {
    #if DEBUG
    if previewLiveBrowser { return true }
    #endif
    return syncService.supportsWorkToolsBrowserTabFrame(laneId: laneId)
  }

  /// A DEBUG fixture that draws the browser cards with no host behind them.
  private var previewBrowserFixtures: Bool {
    #if DEBUG
    return previewLiveBrowser || previewAllowsTabClose
    #else
    return false
    #endif
  }

  /// The host lists the lane's dev servers to the phone.
  private var supportsDevServers: Bool {
    previewBrowserFixtures || syncService.supportsWorkToolsDevServers(laneId: laneId)
  }

  /// The host lets this phone open a dev server in the desktop browser.
  private var canOpenDevServers: Bool {
    previewBrowserFixtures || syncService.canOpenWorkToolsBrowserTab(laneId: laneId)
  }

  /// The host lets this phone click and type into a browser tab.
  private var canControlBrowser: Bool {
    #if DEBUG
    if previewLiveBrowser { return true }
    #endif
    return syncService.supportsWorkToolsBrowserTabInput(laneId: laneId)
  }

  /// The fixture holds Undo longer so a slow driven capture can still see it.
  private var undoWindow: Duration {
    #if DEBUG
    if previewAllowsTabClose { return .seconds(previewPendingCloseTabId == nil ? 30 : 600) }
    #endif
    return Self.closeUndoWindow
  }

  private var canCloseTabs: Bool {
    #if DEBUG
    if previewAllowsTabClose { return true }
    #endif
    return syncService.canCloseWorkToolsBrowserTab(laneId: laneId)
  }

  var body: some View {
    chrome
    .task(id: laneId) { await refresh(.fresh) }
    .task(id: laneId) {
      // The poll lives beside the initial load rather than inside it so a slow
      // first response cannot delay the cadence, and cancellation on dismiss
      // stops both.
      while !Task.isCancelled {
        try? await Task.sleep(for: Self.refreshInterval)
        guard !Task.isCancelled else { return }
        // The viewer polls the same read itself while it is up.
        guard !macDesktopViewerPresented, !appControlViewerPresented else { continue }
        await refresh()
      }
    }
    .onChange(of: macDesktopViewerPresented) { _, presented in
      // Catch up on whatever changed while the viewer was up.
      if !presented { Task { await refresh() } }
    }
    .onChange(of: appControlViewerPresented) { _, presented in
      if !presented { Task { await refresh() } }
    }
    // Live frames only while the browser sheet is on screen and the app is in
    // front: leaving either changes the key, which cancels the poll.
    .task(id: livePollKey) { await pollLiveFrames() }
    .onChange(of: liveTabId) { _, _ in browserInControl = false }
    .onDisappear { sendPendingTabClosesNow(laneId: laneId) }
    .onChange(of: laneId) { previousLaneId, _ in
      // Closes waiting on the old lane go out for that lane; its hidden rows
      // must not hide a tab in the new one.
      sendPendingTabClosesNow(laneId: previousLaneId)
      closedTabIds = []
      // Another lane can be on another machine, with its own desktop.
      desktopIgnoresPhoneSize = false
      laneGeneration += 1
    }
    #if DEBUG
    .onChange(of: loaded) { _, isLoaded in
      guard isLoaded, let id = previewPendingCloseTabId,
        let tab = state?.browser?.tabs.first(where: { $0.id == id })
      else { return }
      scheduleTabClose(tab)
    }
    #endif
    .alert(
      "Couldn't close the tab",
      isPresented: Binding(get: { tabCloseError != nil }, set: { if !$0 { tabCloseError = nil } }),
      actions: { Button("OK", role: .cancel) { tabCloseError = nil } },
      message: { Text(tabCloseError ?? "") }
    )
  }

  /// The sheet's own stack and Done; embedded (the Duo's tools pane) it has
  /// neither, since a nested stack would take over the chat's title and rail.
  @ViewBuilder
  private var chrome: some View {
    if embedded {
      stateContent
    } else {
      NavigationStack {
        stateContent
          // On the Duo's outer display the bar's trailing items are the edge
          // rail: close there as an ×, like the other screens, and leave the
          // top to the content (each card already names the tool).
          .navigationTitle(displayHasEdgeRail ? "" : (tool == .macDesktop && state?.macDesktop?.linuxDesktop != nil ? "Linux" : (tool == .macDesktop && state?.macDesktop?.windowsDesktop != nil ? "Windows" : tool.title)))
          .navigationBarTitleDisplayMode(.inline)
          .toolbar {
            if displayHasEdgeRail {
              ToolbarItem(placement: .topBarTrailing) {
                Button { dismiss() } label: {
                  Image(systemName: "xmark")
                }
                .accessibilityLabel("Close \(tool.title)")
              }
            } else {
              ToolbarItem(placement: .cancellationAction) {
                Button("Done") { dismiss() }
              }
            }
          }
          .onGeometryChange(for: Bool.self) { proxy in
            workDisplayHasEdgeRail(proxy)
          } action: { hasRail in
            if displayHasEdgeRail != hasRail { displayHasEdgeRail = hasRail }
          }
      }
    }
  }

  private var stateContent: some View {
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
  }

  private var content: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        switch tool {
        case .browser:
          browserCard
          if supportsDevServers {
            devServersCard
          }
          if let liveFrame, liveFrameTabId == liveTabId, let tabId = liveTabId {
            WorkToolsBrowserLiveCard(
              image: liveFrame,
              title: liveFrameInfo?.title ?? visibleTabs.first { $0.id == tabId }?.title,
              url: liveFrameInfo?.url ?? visibleTabs.first { $0.id == tabId }?.url,
              isLoading: liveFrameInfo?.isLoading == true,
              canControl: canControlBrowser,
              inControl: $browserInControl,
              send: { event in sendBrowserInput(event, tabId: tabId) },
              phoneSize: desktopIgnoresPhoneSize ? nil : $browserPhoneSize,
              sizeNote: browserPhoneSize ? liveFrameInfo?.viewportNote : nil
            )
          } else {
            lastFrameCard
          }
        case .appControl:
          AppControlCard(
            laneId: laneId,
            appControl: state?.appControl,
            refreshTick: macDesktopRefreshTick,
            viewerPresented: $appControlViewerPresented
          )
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
          Text(footerHint)
            .font(.caption)
            .foregroundStyle(ADEColor.textMuted)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.top, 2)
        }
      }
      // The column the cards fill, before the page margin: the live picture
      // is this wide less the card's own inset.
      .onGeometryChange(for: CGFloat.self) { proxy in
        proxy.size.width
      } action: { width in
        if abs(contentWidth - width) >= 1 { contentWidth = width }
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 16)
    }
    .onGeometryChange(for: CGFloat.self) { proxy in
      proxy.size.height
    } action: { height in
      if abs(visibleHeight - height) >= 1 { visibleHeight = height }
    }
    .refreshable { await refresh(.fresh) }
  }

  // MARK: - Dev servers

  /// The lane's dev servers, each with Open: the page opens in a background tab
  /// of the desktop browser on the lane's machine, and the live picture below
  /// switches to it.
  private var devServersCard: some View {
    let laneId = laneId
    let tabs = visibleTabs
    let isFixture = previewBrowserFixtures
    let generation = laneGeneration
    return WorkToolsDevServersCard(
      servers: devServers,
      tabs: tabs,
      loadFailed: devServersLoadFailed,
      canOpen: canOpenDevServers,
      open: { server in
        // The DEBUG fixtures have no host: Open watches the fixture's tab.
        if isFixture {
          return WorkToolsOpenedBrowserTab(tabId: tabs.first { workToolsLoopbackPort($0.url) == server.port }?.id)
        }
        return try await syncService.openWorkToolsBrowserTab(laneId: laneId, url: server.url)
      },
      watch: { tabId in
        // An Open that answers after a lane switch is about the old lane.
        guard generation == laneGeneration else { return }
        watchedTabId = tabId
        await refresh()
      }
    )
    .id(laneId)
  }

  /// The picture the live frame is laid out for, in points: the card's width,
  /// and most of the visible height. Nil when the person picked desktop size
  /// or the sheet has not been measured yet.
  private var browserViewport: WorkToolsBrowserViewport? {
    guard browserPhoneSize, contentWidth > 0 else { return nil }
    let width = (contentWidth - ADEKit.inset * 2).rounded(.down)
    guard width >= 240 else { return nil }
    let tall = visibleHeight > 0 ? visibleHeight * 0.72 : width * 1.8
    let height = min(max(tall, width * 1.2), width * 2.4).rounded(.down)
    // At most 2x: the desktop renders the page at this scale for a frame
    // capped near 1,000 px wide, so a phone's 3x only costs it memory.
    return WorkToolsBrowserViewport(width: Int(width), height: Int(height), deviceScaleFactor: min(Double(displayScale), 2))
  }

  // MARK: - Cards

  /// The last frame this tool captured, when it has one. The Mac Desktop sheet
  /// has its own picture in `MacDesktopCard`.
  @ViewBuilder
  private var lastFrameCard: some View {
    if latestObservation != nil {
      ADEKitCard(title: "Last frame", hint: latestObservation?.caption) {
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
    ADEKitCard(title: "Browser", hint: browserSubtitle) {
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
      if !visibleTabs.isEmpty {
        let canClose = canCloseTabs
        let canWatch = supportsLiveBrowser && visibleTabs.count > 1
        let watching = supportsLiveBrowser ? liveTabId : nil
        VStack(alignment: .leading, spacing: 10) {
          ForEach(visibleTabs) { tab in
            WorkToolsTabRow(
              tab: tab,
              isClosing: pendingTabCloses[tab.id] != nil,
              isWatched: watching == tab.id,
              onSelect: canWatch ? { watchTab(tab.id) } : nil,
              onClose: canClose ? { scheduleTabClose(tab) } : nil,
              onUndo: { undoTabClose(tab.id) }
            )
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

  /// The lane's tabs, less the ones this sheet just closed.
  private var visibleTabs: [WorkToolsBrowserTab] {
    (state?.browser?.tabs ?? []).filter { !closedTabIds.contains($0.id) }
  }

  // MARK: - Live tab

  /// The tab the live picture shows: the one the person tapped, else the tab
  /// an agent is driving right now, else the active tab, else the first.
  private var liveTabId: String? {
    let tabs = visibleTabs
    guard !tabs.isEmpty else { return nil }
    if let watchedTabId, tabs.contains(where: { $0.id == watchedTabId }) { return watchedTabId }
    if let agentTab = (state?.agentBrowserPresence ?? []).compactMap(\.tabId)
      .first(where: { id in tabs.contains { $0.id == id } }) {
      return agentTab
    }
    return tabs.first(where: \.active)?.id ?? tabs.first?.id
  }

  /// Identity of the live poll. Nil — no poll — when this is not the browser,
  /// the host cannot serve frames, the app is not in front, or there is no tab.
  private var livePollKey: String? {
    guard tool == .browser, scenePhase == .active, supportsLiveBrowser, let liveTabId else { return nil }
    return "\(laneId)|\(liveTabId)"
  }

  private var footerHint: String {
    guard tool == .browser else { return "Control from the desktop" }
    if liveFrame != nil, canControlBrowser { return "Take control to tap, scroll and type in the page." }
    return canCloseTabs ? "Close tabs here. Browse from the desktop." : "Control from the desktop"
  }

  private func watchTab(_ tabId: String) {
    guard watchedTabId != tabId || liveTabId != tabId else { return }
    ADEHaptics.light()
    watchedTabId = tabId
  }

  /// Polls `workTools.readBrowserTabFrame` for the watched tab until the task is
  /// cancelled (sheet gone, app in the background, another tab picked). Each
  /// read renews the desktop's short watch, so stopping needs no message.
  private func pollLiveFrames() async {
    guard livePollKey != nil, let tabId = liveTabId else { return }
    if liveFrameTabId != tabId {
      liveFrame = nil
      liveFrameInfo = nil
      liveFrameTabId = nil
    }
    #if DEBUG
    if previewLiveBrowser {
      liveFrame = previewFrame
      liveFrameTabId = previewFrame == nil ? nil : tabId
      return
    }
    #endif
    let laneId = laneId
    let syncService = syncService
    // The desktop starts capturing on the first read, so the first poll or two
    // answer with no frame; the grace period counts from here.
    var lastFrameAt = Date()
    while !Task.isCancelled {
      let started = ContinuousClock.now
      var delay = Self.liveFrameInterval
      do {
        // Read each time: the toggle and a rotation change it mid-watch.
        let askedViewport = browserViewport
        let answer = try await syncService.readWorkToolsBrowserTabFrame(
          tabId: tabId,
          laneId: laneId,
          maxWidth: Self.liveFrameMaxWidth,
          viewport: askedViewport
        )
        guard !Task.isCancelled else { return }
        var image: UIImage?
        if let dataUrl = answer?.frame?.dataUrl {
          image = await Task.detached(priority: .userInitiated) { workToolsDecodeLiveFrame(dataUrl) }.value
          guard !Task.isCancelled else { return }
        }
        if let image {
          liveFrame = image
          liveFrameTabId = tabId
          liveFrameInfo = answer
          lastFrameAt = Date()
          // A desktop that knows phone size always says whether it applied it.
          // Judged by what this read asked: the switch may have moved since.
          if askedViewport != nil, answer?.viewportApplied == nil { desktopIgnoresPhoneSize = true }
        } else {
          if let answer { liveFrameInfo = answer }
          if Date().timeIntervalSince(lastFrameAt) > Self.liveFrameStaleAfter { dropLiveFrame() }
        }
      } catch {
        guard !Task.isCancelled else { return }
        if Date().timeIntervalSince(lastFrameAt) > Self.liveFrameStaleAfter { dropLiveFrame() }
        delay = Self.liveFrameRetryDelay
      }
      let wait = delay - (ContinuousClock.now - started)
      if wait > .zero { try? await Task.sleep(for: wait) }
    }
  }

  /// Frames stopped: back to the last observation, and out of control.
  private func dropLiveFrame() {
    guard liveFrame != nil else { return }
    liveFrame = nil
    liveFrameTabId = nil
    browserInControl = false
  }

  /// Sends one tap, scroll or keystroke. Fire and forget: the next frame shows
  /// whether it landed, and a failure here has nothing useful to say.
  private func sendBrowserInput(_ event: WorkToolsBrowserTabInputEvent, tabId: String) {
    #if DEBUG
    if previewLiveBrowser { return }
    #endif
    let laneId = laneId
    let syncService = syncService
    Task { @MainActor in
      _ = try? await syncService.sendWorkToolsBrowserTabInput(tabId: tabId, laneId: laneId, event: event)
    }
  }

  // MARK: - Closing a tab

  /// The × was tapped: the row turns into "Closing… Undo" and the close goes
  /// out once the undo window passes. No confirmation dialog: the window is
  /// the safety, the way Mail's undo-send is.
  private func scheduleTabClose(_ tab: WorkToolsBrowserTab) {
    guard pendingTabCloses[tab.id] == nil else { return }
    ADEHaptics.light()
    let tabId = tab.id
    let laneId = laneId
    pendingTabCloses[tabId] = Task { @MainActor in
      try? await Task.sleep(for: undoWindow)
      guard !Task.isCancelled else { return }
      pendingTabCloses[tabId] = nil
      await sendTabClose(tabId, laneId: laneId)
    }
  }

  private func undoTabClose(_ tabId: String) {
    guard let pending = pendingTabCloses.removeValue(forKey: tabId) else { return }
    pending.cancel()
    ADEHaptics.light()
  }

  private func sendTabClose(_ tabId: String, laneId: String) async {
    closedTabIds.insert(tabId)
    #if DEBUG
    if previewAllowsTabClose { return }
    #endif
    do {
      try await syncService.closeWorkToolsBrowserTab(laneId: laneId, tabId: tabId)
      if laneId == self.laneId { await refresh() }
    } catch {
      guard laneId == self.laneId else { return }
      // The tab is still open on the desktop: show it again, and say why.
      closedTabIds.remove(tabId)
      tabCloseError = error.localizedDescription
    }
  }

  /// The sheet is going away (or moving to another lane) with closes still
  /// waiting for `laneId`: the user asked for
  /// them and did not undo, so they go out now rather than being dropped.
  /// Nothing is left on screen to report a failure on; the tab simply stays
  /// open on the desktop and in the list next time.
  private func sendPendingTabClosesNow(laneId: String) {
    let tabIds = Array(pendingTabCloses.keys)
    guard !tabIds.isEmpty else { return }
    for task in pendingTabCloses.values { task.cancel() }
    pendingTabCloses = [:]
    let syncService = syncService
    Task { @MainActor in
      for tabId in tabIds {
        try? await syncService.closeWorkToolsBrowserTab(laneId: laneId, tabId: tabId)
      }
    }
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
    let tabs = visibleTabs
    guard !tabs.isEmpty else { return nil }
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
      supportsObservationPreview: syncService.supportsWorkToolsObservationPreview(laneId: laneId)
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

  /// Where `refresh` takes the dev-server list from.
  private enum DevServerRead {
    /// The list the lane state carries: no scan on the host (the 3 s poll).
    case carried
    /// A fresh read, which also finds a server started outside ADE's
    /// terminals (opening the sheet, pull to refresh).
    case fresh
  }

  private func refresh(_ devServerRead: DevServerRead = .carried) async {
    #if DEBUG
    if let previewState {
      state = previewState
      if previewBrowserFixtures {
        devServers = [
          WorkToolsDevServer(port: 5173, url: "http://localhost:5173/"),
          WorkToolsDevServer(port: 4180, url: "http://localhost:4180/"),
        ]
      }
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
    guard syncService.supportsWorkToolsState(laneId: laneId) else {
      loaded = true
      return
    }
    let next = try? await syncService.fetchWorkToolsLaneState(laneId: laneId)
    guard !Task.isCancelled else { return }
    state = next
    loaded = true
    if tool == .browser, syncService.supportsWorkToolsDevServers(laneId: laneId) {
      // The poll takes the list the lane state carries (no scan on the host);
      // opening the sheet and pulling to refresh ask for a fresh one, which
      // also finds a server started outside ADE's terminals.
      switch devServerRead {
      case .carried:
        if let known = next?.devServers {
          devServers = known
          devServersLoadFailed = false
        }
      case .fresh:
        do {
          let servers = try await syncService.listWorkToolsDevServers(laneId: laneId)
          guard !Task.isCancelled else { return }
          devServers = servers
          devServersLoadFailed = false
        } catch {
          // Keeps the last list rather than blanking it; the card says the
          // read failed only when it has nothing to show.
          devServersLoadFailed = true
        }
      }
    }
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
    guard syncService.supportsWorkToolsObservationPreview(laneId: laneId) else { return }
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
      preview = try await syncService.readWorkToolsObservationPreview(path: path, laneId: laneId)
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
