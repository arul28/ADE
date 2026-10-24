import SwiftUI

// MARK: - Lanes

extension LanesTabView {
  /// The Lanes tab on the Duo's inner display (and an iPad): the lane list
  /// beside ONE detail column for the selected lane (a header over Overview |
  /// Git). Book-folded the list is the left page and the detail the right;
  /// held portrait the list folds behind the detail's sidebar toggle.
  @ViewBuilder
  var duoLanesSplitBody: some View {
    DuoSplitScaffold(
      preferredListWidth: 320,
      minimumDetailWidth: 420,
      adaptive: true,
      selection: duoSelectedLaneId
    ) { _ in
      duoLanesListColumn
    } detail: {
      duoLaneDetailColumn
    }
    .adeScreenBackground()
  }

  /// The project the tab belongs to, for the header's ‹ logo.
  private var duoProjectIconDataUrl: String? {
    syncService.projects.first { $0.id == syncService.activeProjectId }?.iconDataUrl
  }

  /// The lane list in its own stack, the split's left column.
  var duoLanesListColumn: some View {
    NavigationStack {
      lanesListContent
        // The column ends at the seam: the trailing inset iOS reports here is
        // the edge bar's, not this column's.
        .duoLeadingColumnContent()
    }
  }

  /// The lane list on every display (the split's left column, the phone's
  /// root): notices, the open-lanes tray and the rows, under Work's two-row
  /// header: ‹ project logo and "Lanes", then search (with the filter inside
  /// it), Add lane and ⋯ (Activity, Settings).
  var lanesListContent: some View {
    List {
      Section {
        laneNoticeRows
        if showsLaneLoadingSkeletons {
          ForEach(0..<5, id: \.self) { _ in
            LaneRowSkeleton()
              .adeFlatRow(insets: laneRowInsets)
          }
        }
        if !openLaneSnapshots.isEmpty {
          openLanesTray
            .adeFlatRow(insets: EdgeInsets(top: 4, leading: 16, bottom: 10, trailing: 16), separator: .hidden)
        }
      }
      laneListSections
    }
    .adeFlatList()
    .listSectionSpacing(.compact)
    .contentMargins(.bottom, 24, for: .scrollContent)
    .environment(\.defaultMinListRowHeight, 0)
    .adeScrollDiagnosticsSurface(.lanes, key: duoLayout.isWide ? "lanes-split" : "lanes")
    .refreshable { await refreshFromPullGesture() }
    .safeAreaInset(edge: .top, spacing: 0) { duoLanesSearchRow }
    .adeScreenBackground()
    .navigationTitle("")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .topBarLeading) {
        HStack(spacing: 6) {
          WorkHeaderProjectButton(iconDataUrl: duoProjectIconDataUrl) { syncService.showProjectHub() }
          Text("Lanes")
            .font(.system(size: 22, weight: .heavy, design: .rounded))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
            .fixedSize()
            .accessibilityAddTraits(.isHeader)
        }
        .padding(.horizontal, 4)
      }
      .sharedBackgroundVisibility(.hidden)
    }
  }

  /// The column's second header row, Work's: search with the filter inside
  /// it, then Add lane and ⋯.
  private var duoLanesSearchRow: some View {
    HStack(spacing: 8) {
      LaneHeaderSearchField(searchText: $searchText) {
        duoLaneFilterMenuContent
      } filterActive: {
        quickFilter != .active || machineFilter != .all
      }
      Button {
        if canRunLiveActions {
          addLaneSheetPresented = true
        } else {
          handleBlockedLiveAction()
        }
      } label: {
        Image(systemName: "plus")
          .font(.system(size: 18, weight: .medium))
          .foregroundStyle(canRunLiveActions ? ADEColor.textPrimary : ADEColor.textMuted)
          .frame(width: 32, height: 44)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Add lane")
      WorkHeaderOverflowMenu(
        showsLinear: false,
        showsCursorCloud: false,
        actions: WorkRootHeaderActions(
          onOpenActivity: { syncService.attentionDrawerPresented = true },
          onOpenSettings: { syncService.settingsPresented = true }
        )
      )
    }
    .padding(.horizontal, 16)
    .padding(.bottom, 6)
    .background(ADEColor.pageBackground.opacity(0.94))
  }

  /// What the search field's filter chip offers: the lane filter with counts,
  /// and which machines' lanes show.
  @ViewBuilder
  private var duoLaneFilterMenuContent: some View {
    Picker("Show", selection: $quickFilter) {
      ForEach(LaneQuickFilter.allCases) { filter in
        let count = laneListPresentation.quickFilterCounts[filter] ?? 0
        Text("\(filter.title) (\(count))").tag(filter)
      }
    }
    .pickerStyle(.inline)
    if !remoteLanes.machines.isEmpty {
      Section("Machines") {
        duoLaneMachineButtons
      }
    }
  }

  /// Which machines' lanes the list shows.
  @ViewBuilder
  private var duoLaneMachineButtons: some View {
      Button {
        machineFilter = .all
      } label: {
        if machineFilter == .all {
          Label("All machines", systemImage: "checkmark")
        } else {
          Text("All machines")
        }
      }
      Button {
        machineFilter = .focused
      } label: {
        if machineFilter == .focused {
          Label(focusedMachineName, systemImage: "checkmark")
        } else {
          Text(focusedMachineName)
        }
      }
      ForEach(remoteLanes.machines) { machine in
        Button {
          machineFilter = .machine(machine.machineKey)
        } label: {
          if machineFilter == .machine(machine.machineKey) {
            Label(machine.name, systemImage: "checkmark")
          } else {
            Text(machine.isLive ? machine.name : "\(machine.name) (offline)")
          }
        }
      }
  }

  @ViewBuilder
  var duoLaneDetailColumn: some View {
    if let laneId = duoSelectedLaneId, duoLaneIsAvailable(laneId) {
      // A fresh screen per lane: the detail's own state (diffs, commit field,
      // disclosures) belongs to one lane, never the previous one. Its own
      // stack, so held landscape its toolbar is the edge bar.
      NavigationStack {
        laneDestination(LaneRoute(laneId: laneId), showsBackButton: false)
          // Activity and Settings live in the list column's ⋯ inside a
          // project, never on the rail: the rail's bottom is the five tabs.
          .toolbar { DuoAppTabsToolbar(includesUtilities: !duoLayout.hasEdgeBar) }
      }
      .id(laneId)
    } else {
      DuoSplitPlaceholder(
        symbol: "square.stack.3d.up",
        title: "Select a lane",
        message: "Pick a lane to see its overview, changes, commits and git actions.",
        includesUtilities: !duoLayout.hasEdgeBar
      )
    }
  }

  /// A selected lane can be this machine's or another machine's row.
  func duoLaneIsAvailable(_ laneId: String) -> Bool {
    laneSnapshots.contains { $0.lane.id == laneId }
      || remoteLanes.machines.contains { machine in
        machine.snapshots.contains { $0.lane.id == laneId }
      }
  }
}

/// Lanes' search field, Work's shape: the field takes the row's width and the
/// filter is a chip inside its trailing edge (a menu), accent while a filter
/// other than the default is on.
struct LaneHeaderSearchField<MenuContent: View>: View {
  @Binding var searchText: String
  /// The field's placeholder and the filter chip's name (the PRs tab reuses it).
  var prompt = "Search lanes"
  var filterLabel = "Lane filters"
  @ViewBuilder var menuContent: () -> MenuContent
  var filterActive: () -> Bool

  var body: some View {
    let active = filterActive()
    HStack(spacing: 6) {
      Image(systemName: "magnifyingglass")
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(ADEColor.textMuted)
        .accessibilityHidden(true)
      TextField(prompt, text: $searchText)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .font(.subheadline)
        .submitLabel(.search)
      if !searchText.isEmpty {
        Button {
          searchText = ""
        } label: {
          Image(systemName: "xmark.circle.fill")
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(ADEColor.textMuted)
            .frame(width: 24, height: 36)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Clear search")
      }
      Menu {
        menuContent()
      } label: {
        Image(systemName: "line.3.horizontal.decrease")
          .font(.system(size: 11, weight: .bold))
          .foregroundStyle(active ? ADEColor.accent : ADEColor.textSecondary)
          .padding(.horizontal, 8)
          .frame(height: 24)
          .background(
            active ? ADEColor.accent.opacity(0.14) : ADEColor.recessedBackground,
            in: Capsule(style: .continuous)
          )
          .frame(minWidth: 36, minHeight: 40)
          .contentShape(Rectangle())
      }
      .accessibilityLabel(filterLabel)
      .accessibilityValue(active ? "On" : "None")
    }
    .padding(.leading, 10)
    .padding(.trailing, 4)
    .frame(minHeight: 40)
    .frame(maxWidth: .infinity)
    .background(ADEColor.composerBackground, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .stroke(ADEColor.glassBorder, lineWidth: 0.5)
    )
  }
}
