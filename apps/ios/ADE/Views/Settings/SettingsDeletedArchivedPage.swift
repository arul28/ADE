import SwiftUI

enum DeletedArchivedTab: Hashable {
  case recentlyDeleted, archive
}

/// The tab and filter Settings › Deleted & Archived opens on, such as Work's
/// "Recently deleted chats" link (`SyncService.presentDeletedArchived`).
struct DeletedArchivedRequest: Equatable {
  var tab: DeletedArchivedTab
  var filter: DeletedKindFilter = .all
}

/// Settings › Deleted & Archived, the desktop's page of the same name for the
/// open project: Recently deleted (lanes and chats you deleted) and the
/// Archive (lanes, chats and shells you archived), each from every live
/// computer with the project, merged into one list. A computer that is not
/// live (an asleep ADE Cloud computer, one reconnecting) is left out, so
/// opening the page never wakes one. Every action goes to the row's machine.
/// Free up space and Disk space stay on the desktop.
struct SettingsDeletedArchivedPage: View {
  let syncService: SyncService
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  @EnvironmentObject private var machineFleet: MachineFleet

  @State private var tab: DeletedArchivedTab
  @State private var deletedQuery = ""
  @State private var archiveQuery = ""
  @State private var deletedFilter: DeletedKindFilter
  @State private var archiveFilter: ArchiveKindFilter = .all
  @State private var deletedStore: RecentlyDeletedStore
  @State private var archiveStore: ArchiveEverywhereStore
  @State private var refreshToken = 0
  /// A preview's machines, in place of the live ones.
  private let fixtureMachines: [ProjectCopyMachine]?

  init(syncService: SyncService) {
    self.syncService = syncService
    // The first frame shows the asked tab; `takeRequest` then clears it.
    let request = syncService.deletedArchivedRequest
    _tab = State(initialValue: request?.tab ?? .recentlyDeleted)
    _deletedFilter = State(initialValue: request?.filter ?? .all)
    var deleted = RecentlyDeletedStore()
    var archive = ArchiveEverywhereStore()
    var fixtureMachines: [ProjectCopyMachine]?
    #if DEBUG
    if let fixture = DeletedArchivedFixtures.installed {
      deleted = fixture.deleted
      archive = fixture.archive
      fixtureMachines = fixture.machines
    }
    #endif
    _deletedStore = State(initialValue: deleted)
    _archiveStore = State(initialValue: archive)
    self.fixtureMachines = fixtureMachines
  }

  private var machines: [ProjectCopyMachine] {
    fixtureMachines ?? ProjectCopyMachine.everyLiveCopy(sync: syncService)
  }

  var body: some View {
    List {
      Section {
        if let subtitle = SettingsRoute.deletedArchived.subtitle {
          ADESettingsPageIntro(text: subtitle)
            .padding(.bottom, 4)
            .modifier(DeletedArchivedTopRow())
        }
        ADEKitSegmented(selection: $tab, options: [
          (value: DeletedArchivedTab.recentlyDeleted, title: "Recently deleted"),
          (value: DeletedArchivedTab.archive, title: "Archive"),
        ])
        .modifier(DeletedArchivedTopRow())
        searchField
          .modifier(DeletedArchivedTopRow())
      }
      switch tab {
      case .recentlyDeleted:
        RecentlyDeletedSections(
          store: deletedStore,
          syncService: syncService,
          machines: machines,
          style: .settings,
          query: deletedQuery,
          filter: deletedFilter,
          reloadToken: "\(refreshToken)"
        )
      case .archive:
        ArchiveEverywhereSections(
          store: archiveStore,
          syncService: syncService,
          machines: machines,
          query: archiveQuery,
          filter: archiveFilter,
          reloadToken: "\(refreshToken)"
        )
      }
    }
    .adeSettingsList()
    .adeSettingsPageTitle(SettingsRoute.deletedArchived.title)
    .refreshable { refreshToken += 1 }
    .recentlyDeletedPresentations(deletedStore, syncService: syncService)
    .adeToast($archiveStore.toast)
    .onAppear { takeRequest() }
    // A link while the page already shows.
    .onChange(of: syncService.deletedArchivedRequest) { _, _ in takeRequest() }
  }

  /// Opens the tab and filter a link asked for, once.
  private func takeRequest() {
    guard let request = syncService.deletedArchivedRequest else { return }
    tab = request.tab
    deletedFilter = request.filter
    syncService.deletedArchivedRequest = nil
  }

  @ViewBuilder
  private var searchField: some View {
    switch tab {
    case .recentlyDeleted:
      LaneHeaderSearchField(searchText: $deletedQuery, prompt: "Search deleted lanes and chats", filterLabel: "Show") {
        Picker("Show", selection: $deletedFilter) {
          ForEach(DeletedKindFilter.allCases) { filter in
            Text(filter.title).tag(filter)
          }
        }
        .pickerStyle(.inline)
      } filterActive: {
        deletedFilter != .all
      }
    case .archive:
      LaneHeaderSearchField(searchText: $archiveQuery, prompt: "Search the archive", filterLabel: "Show") {
        Picker("Show", selection: $archiveFilter) {
          ForEach(ArchiveKindFilter.allCases) { filter in
            Text(filter.title).tag(filter)
          }
        }
        .pickerStyle(.inline)
      } filterActive: {
        archiveFilter != .all
      }
    }
  }
}

/// The page's intro, tabs and search: on the page, not in a panel.
private struct DeletedArchivedTopRow: ViewModifier {
  func body(content: Content) -> some View {
    content
      .listRowBackground(Color.clear)
      .listRowInsets(EdgeInsets(top: 4, leading: 2, bottom: 4, trailing: 2))
      .listRowSeparator(.hidden)
  }
}
