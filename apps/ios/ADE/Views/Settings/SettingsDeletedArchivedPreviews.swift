import SwiftUI

#if DEBUG
/// Fixtures for the Recently deleted and Archive previews: two machines, a
/// lane deleted with its chats, chats deleted on their own (one whose lane is
/// gone, one CLI), a freed lane, and an archive across both groups.
enum DeletedArchivedFixtures {
  /// Rows the real page shows in place of the live machines' while a Duo
  /// fixture runs.
  @MainActor static var installed: (machines: [ProjectCopyMachine], deleted: RecentlyDeletedStore, archive: ArchiveEverywhereStore)?

  static let machines = [
    ProjectCopyMachine(id: "", name: "Arul’s Mac Studio", projectId: nil, rootPath: nil),
    ProjectCopyMachine(id: "mbp", name: "MacBook Pro (97)", projectId: "mbp-p", rootPath: nil),
  ]

  static func iso(_ offset: TimeInterval) -> String {
    ISO8601DateFormatter().string(from: Date().addingTimeInterval(offset))
  }

  static func saved(
    _ id: String, _ name: String, branch: String?, uncommitted: Bool, kind: String = "deleted", ageHours: Double
  ) -> DeletedLaneSnapshot {
    DeletedLaneSnapshot(
      id: id, laneId: "lane-\(id)", laneName: name, branchName: branch,
      commit: "c0ffee", baseCommit: "decade", uncommitted: uncommitted, kind: kind,
      deletedAt: iso(-ageHours * 3600), expiresAt: iso(30 * 86_400 - ageHours * 3600)
    )
  }

  static func chat(
    _ id: String, _ title: String?, provider: String, model: String?, lane: String, laneId: String,
    laneExists: Bool, withLane: Bool = false, ageHours: Double, kind: String? = nil, toolType: String? = nil
  ) -> DeletedChat {
    DeletedChat(
      id: id, title: title, provider: provider, modelId: model, laneId: laneId, laneName: lane,
      laneExists: laneExists, withLane: withLane, lastActiveAt: iso(-ageHours * 3600 - 600),
      deletedAt: iso(-ageHours * 3600), kind: kind, toolType: toolType, resumable: kind == "cli" ? true : nil
    )
  }

  static var deletedReads: [String: RecentlyDeletedStore.Read] {
    [
      "": RecentlyDeletedStore.Read(value: .init(
        lanes: [
          saved("k1", "Thread Sharing Links", branch: "ade/thread-sharing-links-phase-2-worker", uncommitted: true, ageHours: 0.23),
          saved("k3", "docs refresh", branch: "ade/docs-refresh-91aa", uncommitted: true, kind: "freed", ageHours: 24 * 9),
        ],
        chats: [
          chat("c1", "Share links for threads", provider: "claude", model: "claude-opus-5-5", lane: "Thread Sharing Links", laneId: "lane-k1", laneExists: false, withLane: true, ageHours: 0.23),
          chat("c2", "Worker routes for /s/:id", provider: "codex", model: "gpt-6", lane: "Thread Sharing Links", laneId: "lane-k1", laneExists: false, withLane: true, ageHours: 0.23),
          chat("c3", "Fix the flaky sync test", provider: "claude", model: "claude-sonnet-5-5", lane: "Main checkout", laneId: "primary", laneExists: true, ageHours: 3),
          chat("c4", nil, provider: "cursor", model: nil, lane: "old spike", laneId: "lane-gone", laneExists: false, ageHours: 30),
          chat("c5", "Claude Code", provider: "claude", model: nil, lane: "Main checkout", laneId: "primary", laneExists: true, ageHours: 50, kind: "cli", toolType: "claude"),
        ]
      ), done: true),
      "mbp": RecentlyDeletedStore.Read(value: .init(
        lanes: [saved("k4", "phase 4 lanes", branch: "ade/mobile-multi-machine-phase-4", uncommitted: false, ageHours: 5)],
        chats: [chat("c6", "Tidy the lane list", provider: "opencode", model: nil, lane: "ios polish", laneId: "lane-ios", laneExists: true, ageHours: 26)]
      ), done: true),
    ]
  }

  static var archiveReads: [String: ArchiveEverywhereStore.Read] {
    [
      "": ArchiveEverywhereStore.Read(value: .init(
        items: [
          ArchivedItem(kind: "lane", id: "a1", title: "perf lane 3", laneId: "a1", laneName: "perf lane 3", laneColor: "#7c5cff", archivedAt: iso(-3 * 3600), sizeBytes: 412_000_000, worktreePresent: true, branchRef: "ade/perf-lane-3"),
          ArchivedItem(kind: "chat", id: "a2", title: "Review the onboarding copy", laneId: "primary", laneName: "Main checkout", archivedAt: iso(-26 * 3600), sizeBytes: 1_800_000, toolType: "claude-chat"),
          ArchivedItem(kind: "shell", id: "a3", title: "Codex", laneId: "primary", laneName: "Main checkout", archivedAt: iso(-4 * 86_400), toolType: "codex", toolLabel: "Codex"),
          ArchivedItem(kind: "lane", id: "a4", title: "icons spike", laneId: "a4", laneName: "icons spike", laneColor: "#22c55e", archivedAt: iso(-21 * 86_400), sizeBytes: 0, worktreePresent: false, branchRef: "ade/icons-spike"),
        ],
        staleAfterDays: 14
      ), done: true),
      "mbp": ArchiveEverywhereStore.Read(value: .init(
        items: [
          ArchivedItem(kind: "shell", id: "a5", title: "zsh", laneId: "lane-ios", laneName: "ios polish", archivedAt: iso(-30 * 86_400), toolType: "shell"),
          ArchivedItem(kind: "lane", id: "a6", title: "old router", laneId: "a6", laneName: "old router", laneColor: "#f59e0b", archivedAt: iso(-40 * 86_400), sizeBytes: 1_200_000_000, worktreePresent: true, branchRef: "ade/router-v1", freeUpDue: true),
        ],
        staleAfterDays: 14
      ), done: true),
    ]
  }

  @MainActor
  static func deletedStore(notice: Bool = false) -> RecentlyDeletedStore {
    let store = RecentlyDeletedStore(machines: machines, reads: deletedReads, frozen: true)
    if notice {
      store.notice = RecentlyDeletedNotice(
        tone: .success,
        title: "phase 4 lanes is back",
        message: "Its 2 chats are back too.",
        openLaneId: "lane-k4",
        openSessionId: "c7",
        openSessionLaneId: "lane-k4"
      )
    }
    return store
  }

  @MainActor
  static func archiveStore() -> ArchiveEverywhereStore {
    ArchiveEverywhereStore(machines: machines, reads: archiveReads, frozen: true)
  }
}

/// The page in the real Settings presentation (the sheet; the two-column
/// window held landscape on the Duo's inner display) over the Home fixture,
/// with fixture rows: `duo-settings-deleted`, `duo-settings-deleted-restored`,
/// `duo-settings-deleted-chat` (a chat whose lane is gone, open in its sheet)
/// and `duo-settings-archive`. `duo-lanes-deleted` is the Lanes tab's
/// Archived rows. `duo-work-deleted-link` is Work on its Archived filter,
/// whose "Recently deleted chats" link opens the page.
enum DeletedArchivedPreviews {
  @MainActor
  static func view(_ name: String) -> AnyView? {
    switch name {
    case "duo-settings-deleted": return AnyView(DuoSettingsDeletedFixture(tab: .recentlyDeleted))
    case "duo-settings-deleted-restored": return AnyView(DuoSettingsDeletedFixture(tab: .recentlyDeleted, restoredNotice: true))
    case "duo-settings-deleted-chat": return AnyView(DuoSettingsDeletedFixture(tab: .recentlyDeleted, opensChat: true))
    case "duo-settings-archive": return AnyView(DuoSettingsDeletedFixture(tab: .archive))
    case "duo-lanes-deleted": return AnyView(LanesRecentlyDeletedPreviewHost())
    case "duo-work-deleted-link": return AnyView(DuoWorkDeletedLinkFixture())
    default: return nil
    }
  }
}

private struct DuoSettingsDeletedFixture: View {
  let tab: DeletedArchivedTab
  var restoredNotice = false
  var opensChat = false

  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  private var syncService: SyncService { syncPublishes.service }
  @StateObject private var advisor = AppUpdateAdvisor()

  var body: some View {
    DuoPreviewRouter.view(named: "duo-home")
      .modifier(DuoWindowPresentations(syncService: syncService, appUpdateAdvisor: advisor))
      .environmentObject(syncService.attentionDrawer)
      .task {
        let deleted = DeletedArchivedFixtures.deletedStore(notice: restoredNotice)
        DeletedArchivedFixtures.installed = (DeletedArchivedFixtures.machines, deleted, DeletedArchivedFixtures.archiveStore())
        // After the first layout, so the root knows its posture.
        try? await Task.sleep(for: .milliseconds(400))
        await AccountService.shared.bootstrap()
        syncService.presentDeletedArchived(tab)
        guard opensChat else { return }
        try? await Task.sleep(for: .milliseconds(900))
        let orphan = deleted.entries.lazy.compactMap { entry -> DeletedChatEntry? in
          if case .chat(let chat) = entry, !chat.chat.laneExists { return chat }
          return nil
        }.first
        if let orphan { deleted.open(orphan) }
      }
  }
}
/// Work's fixture on the Archived filter under the app root's presentations,
/// so its "Recently deleted chats" link opens the real Settings page (on the
/// fixture rows) the way it does in the app.
private struct DuoWorkDeletedLinkFixture: View {
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  private var syncService: SyncService { syncPublishes.service }
  @StateObject private var advisor = AppUpdateAdvisor()
  @State private var seeded = false

  var body: some View {
    Group {
      if seeded {
        DuoPreviewRouter.view(named: "duo-work-empty")
          .modifier(DuoWindowPresentations(syncService: syncService, appUpdateAdvisor: advisor))
          .environmentObject(syncService.attentionDrawer)
      } else {
        Color.clear
      }
    }
    .onAppear {
      guard !seeded else { return }
      syncService.pinActiveProjectForPreview(projectId: WorkListPreviewData.projectId)
      let scope = WorkViewStateStore.scopeKey(
        projectId: syncService.activeProjectId,
        hostIdentity: syncService.activeProjectHostIdentity
      )
      var state = WorkViewStateStore.load(scope: scope)
      state.statusFilter = WorkSessionStatusFilter.archived.rawValue
      WorkViewStateStore.save(state, scope: scope)
      DeletedArchivedFixtures.installed = (
        DeletedArchivedFixtures.machines,
        DeletedArchivedFixtures.deletedStore(),
        DeletedArchivedFixtures.archiveStore()
      )
      seeded = true
    }
    .task { await AccountService.shared.bootstrap() }
  }
}
#endif
