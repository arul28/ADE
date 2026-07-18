import SwiftUI

/// Navigation targets inside the Linear pane's stack.
enum LinearRoute: Hashable {
  case issue(NormalizedLinearIssue)
  /// Push the launch config. `laneOnly` = "Link to new lane" (create a lane
  /// attached to the issue, no agent); otherwise = "Launch in new lane" (chat/CLI).
  case launch(issue: NormalizedLinearIssue, laneOnly: Bool)
  /// Push the Linear connection management screen (connect / reconnect /
  /// disconnect), reached from the pane's gear button.
  case connection
}

/// The Linear pane's root screen: a grouped-by-state, searchable, filterable
/// issue browser. Rows push the issue detail; a "Launch" from there pushes the
/// launch screen.
struct LinearIssueListScreen: View {
  @ObservedObject var store: LinearPaneStore
  var onClose: () -> Void = {}

  /// User overrides for group collapse state. Completed groups collapse by
  /// default, while all other groups open until the user toggles them.
  @State private var groupCollapseOverrides: [String: Bool] = [:]

  private enum ListContent { case skeletons, failure, empty, issues }

  private var contentMode: ListContent {
    if !store.issues.isEmpty { return .issues }
    switch store.phase {
    case .idle, .loading: return .skeletons
    case .failed: return .failure
    case .loaded: return .empty
    }
  }

  var body: some View {
    List {
      switch contentMode {
      case .skeletons:
        skeletons
      case .failure:
        failureCard
      case .empty:
        emptyState
      case .issues:
        issueSections
        loadMoreFooter
      }
    }
    .listStyle(.plain)
    .scrollContentBackground(.hidden)
    .safeAreaInset(edge: .top, spacing: 0) { LinearFilterChipsBar(store: store) }
    .searchable(text: $store.query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search issues")
    .refreshable { await store.reload() }
    .onChange(of: store.query) { _, _ in store.scheduleReload() }
    .onChange(of: store.assignedToMe) { _, _ in store.scheduleReload() }
    .onChange(of: store.statePreset) { _, _ in store.scheduleReload() }
    .onChange(of: store.projectId) { _, _ in store.scheduleReload() }
    .onChange(of: store.priority) { _, _ in store.scheduleReload() }
    .navigationTitle(store.workspaceTitle)
    .navigationBarTitleDisplayMode(.inline)
    .toolbar { linearToolbar }
  }

  // Extracted from `body` to keep the SwiftUI type-checker under its budget
  // (the List + searchable + onChange chain + toolbar together tip it over).
  @ToolbarContentBuilder
  private var linearToolbar: some ToolbarContent {
    ToolbarItem(placement: .topBarLeading) {
      Button { onClose() } label: {
        Image(systemName: "xmark").font(.system(size: 13, weight: .semibold))
      }
      .accessibilityLabel("Close Linear")
    }
    ToolbarItem(placement: .topBarTrailing) {
      NavigationLink(value: LinearRoute.connection) {
        Image(systemName: "gearshape")
      }
      .accessibilityLabel("Linear connection settings")
    }
    ToolbarItem(placement: .topBarTrailing) {
      LinearFiltersMenu(store: store)
    }
  }

  @ViewBuilder
  private var issueSections: some View {
    ForEach(store.groupedIssues) { group in
      let collapsed = groupCollapseOverrides[group.id] ?? linearGroupCollapsedByDefault(stateType: group.stateType)
      Section {
        if !collapsed {
          ForEach(group.issues) { issue in
            NavigationLink(value: LinearRoute.issue(issue)) {
              LinearIssueRow(issue: issue, hasLane: store.attachedIssueIds.contains(issue.id))
            }
            .listRowBackground(Color.clear)
          }
        }
      } header: {
        Button {
          withAnimation(.snappy(duration: 0.2)) {
            groupCollapseOverrides[group.id] = !collapsed
          }
        } label: {
          LinearGroupHeader(title: group.title, stateType: group.stateType, count: group.issues.count, collapsed: collapsed)
        }
        .buttonStyle(.plain)
      }
    }
  }

  @ViewBuilder
  private var loadMoreFooter: some View {
    if store.hasNextPage {
      HStack {
        Spacer()
        ProgressView()
          .controlSize(.small)
          .tint(LinearBrand.primaryBright)
        Spacer()
      }
      .listRowBackground(Color.clear)
      .listRowSeparator(.hidden)
      .onAppear { Task { await store.loadMore() } }
    }
  }

  @ViewBuilder
  private var skeletons: some View {
    ForEach(0..<6, id: \.self) { _ in
      ADECardSkeleton(rows: 2)
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
    }
  }

  @ViewBuilder
  private var emptyState: some View {
    ADEEmptyStateView(
      symbol: "tray",
      title: "No issues",
      message: store.assignedToMe
        ? "Nothing assigned to you matches these filters. Turn off \u{201C}Assigned to me\u{201D} to widen the search."
        : "No Linear issues match these filters."
    )
    .listRowBackground(Color.clear)
    .listRowSeparator(.hidden)
    .padding(.top, 24)
  }

  @ViewBuilder
  private var failureCard: some View {
    ADENoticeCard(
      title: "Couldn\u{2019}t load Linear",
      message: store.errorMessage ?? "The machine didn\u{2019}t answer. Pull to retry.",
      icon: "exclamationmark.triangle.fill",
      tint: ADEColor.warning,
      actionTitle: "Retry",
      action: { Task { await store.reload() } }
    )
    .listRowBackground(Color.clear)
    .listRowSeparator(.hidden)
    .padding(.top, 24)
  }
}

// MARK: - Row

struct LinearIssueRow: View {
  let issue: NormalizedLinearIssue
  let hasLane: Bool

  var body: some View {
    HStack(spacing: 11) {
      LinearStateIcon(stateType: issue.stateType, size: 16)
      VStack(alignment: .leading, spacing: 3) {
        HStack(spacing: 6) {
          Text(issue.identifier)
            .font(.caption.weight(.semibold))
            .foregroundStyle(ADEColor.textSecondary)
          if hasLane {
            Label("has lane", systemImage: "square.stack.3d.up.fill")
              .labelStyle(.titleAndIcon)
              .font(.system(size: 9, weight: .semibold))
              .foregroundStyle(LinearBrand.primaryBright)
              .padding(.horizontal, 6)
              .padding(.vertical, 2)
              .background(LinearBrand.surface, in: Capsule())
          }
        }
        Text(issue.title)
          .font(.subheadline)
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(2)
      }
      Spacer(minLength: 8)
      LinearPriorityIcon(priority: issue.priority, size: 14)
    }
    .padding(.vertical, 3)
    .contentShape(Rectangle())
  }
}

// MARK: - Group header

struct LinearGroupHeader: View {
  let title: String
  let stateType: String
  let count: Int
  var collapsed: Bool = false

  var body: some View {
    HStack(spacing: 7) {
      Image(systemName: "chevron.right")
        .font(.system(size: 10, weight: .bold))
        .foregroundStyle(ADEColor.textMuted)
        .rotationEffect(.degrees(collapsed ? 0 : 90))
      LinearStateIcon(stateType: stateType, size: 12)
      Text(title)
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEColor.textSecondary)
      Text("\(count)")
        .font(.caption2.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
      Spacer()
    }
    .textCase(nil)
    .padding(.vertical, 2)
    .contentShape(Rectangle())
  }
}

// MARK: - Filter chips bar (assigned-to-me + state preset)

struct LinearFilterChipsBar: View {
  @ObservedObject var store: LinearPaneStore

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        LinearToggleChip(
          title: "Assigned to me",
          systemImage: "person.fill",
          isOn: store.assignedToMe
        ) { store.assignedToMe.toggle() }

        Divider().frame(height: 18).overlay(ADEColor.border)

        ForEach(LinearPaneStore.StatePreset.allCases) { preset in
          LinearToggleChip(
            title: preset.title,
            systemImage: nil,
            isOn: store.statePreset == preset
          ) { store.statePreset = preset }
        }
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 8)
    }
    .background(ADEColor.pageBackground.opacity(0.92))
  }
}

struct LinearToggleChip: View {
  let title: String
  let systemImage: String?
  let isOn: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 5) {
        if let systemImage {
          Image(systemName: systemImage).font(.system(size: 10, weight: .semibold))
        }
        Text(title).font(.caption.weight(.semibold))
      }
      .foregroundStyle(isOn ? LinearBrand.primaryBright : ADEColor.textSecondary)
      .padding(.horizontal, 11)
      .padding(.vertical, 6)
      .background(isOn ? LinearBrand.surface : ADEColor.surfaceBackground.opacity(0.6), in: Capsule())
      .overlay(Capsule().stroke(isOn ? LinearBrand.border : ADEColor.glassBorder, lineWidth: 1))
    }
    .buttonStyle(.plain)
  }
}

// MARK: - Filters menu (project + priority)

struct LinearFiltersMenu: View {
  @ObservedObject var store: LinearPaneStore

  var body: some View {
    Menu {
      Menu("Project") {
        Button {
          store.projectId = nil
        } label: {
          Label("All projects", systemImage: store.projectId == nil ? "checkmark" : "")
        }
        ForEach(store.projects) { project in
          Button {
            store.projectId = project.id
          } label: {
            Label(project.name, systemImage: store.projectId == project.id ? "checkmark" : "")
          }
        }
      }
      Menu("Priority") {
        priorityButton("Any", nil)
        priorityButton("Urgent", 1)
        priorityButton("High", 2)
        priorityButton("Medium", 3)
        priorityButton("Low", 4)
        priorityButton("No priority", 0)
      }
    } label: {
      Image(systemName: "line.3.horizontal.decrease.circle")
        .foregroundStyle(hasActiveFilter ? LinearBrand.primaryBright : ADEColor.textSecondary)
    }
  }

  private var hasActiveFilter: Bool {
    store.projectId != nil || store.priority != nil
  }

  @ViewBuilder
  private func priorityButton(_ title: String, _ value: Int?) -> some View {
    Button {
      store.priority = value
    } label: {
      Label(title, systemImage: store.priority == value ? "checkmark" : "")
    }
  }
}
