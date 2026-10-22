import SwiftUI

/// Fixed metrics for the wide Work layout. Kept in one place so the sessions
/// column, the rail and the tools pane agree on how much room each takes.
enum DuoWorkMetrics {
  /// The sessions column on a flat or laptop-open display.
  static let listWidth: CGFloat = 300
  /// What the sessions column shrinks to while a tool is open: one dot per chat.
  static let railWidth: CGFloat = 56
  /// The band the fold gets. Content stops here; nothing interactive lives on it.
  static let hingeGutter: CGFloat = 14
  /// A thread narrower than this cannot hold a transcript and a composer.
  static let minChatWidth: CGFloat = 340
}

/// One chat in the minimized sessions rail: enough to recognise it (status hue,
/// selection) without the list itself, which is unmounted while a tool is open.
struct DuoWorkRailItem: Identifiable, Equatable {
  let id: String
  let title: String
  /// The row's canonical status hue, the same one its Work row wears.
  let tint: Color
  let isSelected: Bool
  let isBusy: Bool
}

/// The minimized sessions column. Tapping a dot selects that chat; the button
/// at the top brings the whole list back as an overlay.
struct DuoWorkSessionsRail: View {
  let items: [DuoWorkRailItem]
  let onSelect: (String) -> Void
  let onExpand: () -> Void

  var body: some View {
    VStack(spacing: 4) {
      Button(action: onExpand) {
        WorkChatGlassCircleLabel(systemName: "sidebar.left", size: 36, glyphSize: 14)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Show chats")
      .accessibilityIdentifier("Duo.Work.Rail.Expand")
      .padding(.top, 8)

      ScrollView(.vertical, showsIndicators: false) {
        VStack(spacing: 6) {
          ForEach(items) { item in
            dot(item)
          }
        }
        .padding(.vertical, 8)
      }
      .scrollBounceBehavior(.basedOnSize)

      Spacer(minLength: 0)
    }
    .frame(maxHeight: .infinity)
    .background(ADEColor.surfaceBackground)
    .overlay(alignment: .trailing) {
      Rectangle()
        .fill(ADEColor.glassBorder)
        .frame(width: 0.5)
        .accessibilityHidden(true)
    }
    .accessibilityIdentifier("Duo.Work.SessionsRail")
  }

  private func dot(_ item: DuoWorkRailItem) -> some View {
    Button {
      ADEHaptics.light()
      onSelect(item.id)
    } label: {
      Circle()
        .fill(item.tint.opacity(item.isBusy ? 1 : 0.55))
        .frame(width: item.isBusy ? 15 : 12, height: item.isBusy ? 15 : 12)
        .frame(width: 34, height: 34)
        .background(
          item.isSelected ? ADEColor.glassBackground : Color.clear,
          in: Circle()
        )
        .overlay {
          if item.isSelected {
            Circle()
              .strokeBorder(ADEColor.textPrimary.opacity(0.75), lineWidth: 1.5)
              .frame(width: 26, height: 26)
          }
        }
    }
    .buttonStyle(.plain)
    .accessibilityLabel(item.title)
    .accessibilityAddTraits(item.isSelected ? .isSelected : [])
  }
}

/// What the right column says before a chat is picked.
struct DuoWorkEmptyDetail: View {
  var body: some View {
    ADEEmptyStateView(
      symbol: "bubble.left.and.bubble.right",
      title: "Choose a chat",
      message: "Pick a chat on the left. Its thread opens here, and its tools open beside it."
    )
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .adeScreenBackground()
    .accessibilityIdentifier("Duo.Work.EmptyDetail")
  }
}

extension WorkRootListScreen {
  /// The chats the rail stands for: the list's own display order, one dot each,
  /// wearing the tone the row behind it already wears.
  var duoRailItems: [DuoWorkRailItem] {
    let now = Date()
    var items: [DuoWorkRailItem] = []
    for session in mergedSessions where isChatSession(session) {
      let presentation = workSessionRowPresentation(
        session: session,
        summary: chatSummaries[session.id],
        now: now
      )
      items.append(DuoWorkRailItem(
        id: session.id,
        title: session.title,
        tint: activityToneColor(presentation.tone),
        isSelected: duoSelectedRoute?.sessionId == session.id,
        isBusy: presentation.phase == .running
          || presentation.phase == .starting
          || presentation.phase == .needsYou
      ))
      if items.count >= 12 { break }
    }
    return items
  }

  /// Selecting in the column replaces the thread in place instead of pushing:
  /// the list stays where the user left it, and Back on the chat header clears
  /// the column rather than popping a stack.
  func duoSelectSession(_ session: TerminalSessionSummary) {
    guard !workIsPendingChatCreationSession(session) else { return }
    if let previous = duoSelectedRoute?.sessionId, previous != session.id {
      WorkSeenStore.stamp([previous])
    }
    duoRailExpanded = false
    if duoPane.isOpen { duoPane.close() }
    // Keeps the route the phone layout will push if the display folds, and the
    // matched-geometry transition's source id.
    selectedSessionTransitionId = session.id
    clearWokeMarkerOnVisit(session)
    ChatOpenCloseTiming.openTapped(sessionId: session.id)
    // A row from another machine opens through that machine, exactly as the
    // pushed route does.
    let remoteChat: WorkChatCrossProjectContext? = isWorkRemoteLaneId(session.laneId)
      ? syncService.remoteMachineChat(sessionId: session.id).map { remote in
        WorkChatCrossProjectContext(
          projectId: remote.projectId,
          projectRootPath: remote.rootPath.isEmpty ? nil : remote.rootPath,
          displayName: "",
          machineKey: remote.machineKey
        )
      }
      : nil
    duoSelectedRoute = WorkSessionRoute(sessionId: session.id, remoteChat: remoteChat)
    if remoteChat == nil {
      syncService.persistOpenWorkSessionRoute(sessionId: session.id)
    }
    scheduleSessionPresentationRebuild()
  }

  func duoSelectRailItem(_ sessionId: String) {
    guard let session = mergedSessions.first(where: { $0.id == sessionId }) else { return }
    duoRailExpanded = false
    duoSelectSession(session)
  }

  /// Back on the chat header, and the app's "nothing open" state: the thread is
  /// gone, the list is back, and the chat is stamped as seen.
  func duoClearSelection() {
    if let sessionId = duoSelectedRoute?.sessionId {
      WorkSeenStore.stamp([sessionId])
    }
    duoRailExpanded = false
    if duoPane.isOpen { duoPane.close() }
    duoSelectedRoute = nil
    selectedSessionTransitionId = nil
    syncService.clearOpenWorkSessionRoute()
    scheduleSessionPresentationRebuild()
  }
}

#if DEBUG
/// What a `duo-*` fixture asks the wide Work layout to show. Only the fixture
/// host writes it; nothing in the product reads these outside `#if DEBUG`.
@MainActor
enum DuoWorkPreviewState {
  static var sessionId: String?
  static var tab: DuoToolTab?
  static var pr: DuoWorkPrPreview?
  /// Chats whose preview tab has already been opened, so closing the pane
  /// during a screenshot session does not immediately re-open it.
  static var openedSessions: Set<String> = []
}

struct DuoWorkPrPreview {
  var tag: LanePrTag
  var pr: PullRequestListItem
}

/// Fixture screens for this area, routed by `DuoPreviewRouter`:
///
///     xcrun simctl launch <udid> com.ade.ios -adePreviewScreen duo-work
///     xcrun simctl launch <udid> com.ade.ios -adePreviewScreen duo-work-tools
///     xcrun simctl launch <udid> com.ade.ios -adePreviewScreen duo-work-pr
enum DuoWorkPreviews {
  @MainActor
  static func view(_ name: String) -> AnyView? {
    switch name {
    case "duo-work":
      return AnyView(DuoWorkPreviewHost(preset: .chat))
    case "duo-work-tools":
      return AnyView(DuoWorkPreviewHost(preset: .tools))
    case "duo-work-pr":
      return AnyView(DuoWorkPreviewHost(preset: .pr))
    default:
      return nil
    }
  }
}

private enum DuoWorkPreviewPreset {
  case chat
  case tools
  case pr
}

/// Mounts the real Work root over the Work list fixtures, so the screenshot is
/// the real wide layout: the real sessions column, the real chat destination and
/// the real tools pane.
private struct DuoWorkPreviewHost: View {
  @EnvironmentObject private var syncService: SyncService
  let preset: DuoWorkPreviewPreset
  @State private var seeded = false

  var body: some View {
    Group {
      if seeded {
        WorkRootScreen(isTabActive: true)
      } else {
        Color.clear
      }
    }
    .onAppear(perform: seed)
  }

  private func seed() {
    guard !seeded else { return }
    syncService.setActiveProjectForTesting(projectId: WorkListPreviewData.projectId, rootPath: nil)
    WorkRootPreviewFixture.active = WorkListPreviewData.fixture()
    WorkSeenStore.stamp(WorkListPreviewData.seenSessionIds)
    DuoWorkPreviewState.sessionId = WorkListPreviewData.parentChatId
    switch preset {
    case .chat:
      DuoWorkPreviewState.tab = nil
    case .tools:
      DuoWorkPreviewState.tab = .simulator
    case .pr:
      DuoWorkPreviewState.tab = .pr
      DuoWorkPreviewState.pr = DuoWorkPreviewFixtures.chatPr
    }
    seeded = true
  }
}

@MainActor
private enum DuoWorkPreviewFixtures {
  private static func iso(minutesAgo: Int) -> String {
    ISO8601DateFormatter().string(from: Date().addingTimeInterval(-Double(minutesAgo) * 60))
  }

  /// The hub lane's fixture PR, shaped the way the chat's own resolver hands
  /// one to `WorkChatPrDetailsSheet`.
  static let chatPr = DuoWorkPrPreview(
    tag: LanePrTag(
      source: .ade,
      prId: "wl-pr-hub",
      githubPrNumber: 1304,
      githubUrl: "https://github.com/arul/ade/pull/1304",
      title: "Work tab header in one row",
      state: "open",
      headBranch: "ade/mobile-work-hub",
      updatedAt: iso(minutesAgo: 10)
    ),
    pr: PullRequestListItem(
      id: "wl-pr-hub",
      laneId: WorkListPreviewData.hub.id,
      laneName: WorkListPreviewData.hub.name,
      projectId: WorkListPreviewData.projectId,
      repoOwner: "arul",
      repoName: "ade",
      githubPrNumber: 1304,
      githubUrl: "https://github.com/arul/ade/pull/1304",
      title: "Work tab header in one row",
      state: "open",
      baseBranch: "main",
      headBranch: "ade/mobile-work-hub",
      checksStatus: "pending",
      reviewStatus: "none",
      additions: 212,
      deletions: 64,
      lastSyncedAt: nil,
      createdAt: iso(minutesAgo: 60 * 24),
      updatedAt: iso(minutesAgo: 10),
      adeKind: "single",
      linkedGroupId: nil,
      linkedGroupType: nil,
      linkedGroupName: nil,
      linkedGroupPosition: nil,
      linkedGroupCount: 0,
      workflowDisplayState: nil,
      cleanupState: nil
    )
  )
}
#endif
