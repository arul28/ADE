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

/// The Linear pane's root screen: the issue list laid out the way the person's
/// Linear display settings say (grouped by status by default, sub-issues nested
/// under their parent), searchable and filterable. Rows push the issue detail;
/// a "Launch" from there pushes the launch screen.
struct LinearIssueListScreen: View {
  @ObservedObject var store: LinearPaneStore
  var onClose: () -> Void = {}
  /// False inside the Work tools pane, whose own close button is the way out.
  var showsClose = true
  var onAttachIssue: ((NormalizedLinearIssue) -> Void)? = nil
  /// Pushes an issue's detail. The row's VoiceOver default action uses it,
  /// since the link behind the row is hidden from accessibility.
  var onOpenIssue: ((NormalizedLinearIssue) -> Void)? = nil

  private enum Mode {
    case browse
    case attach
  }

  private var mode: Mode { onAttachIssue == nil ? .browse : .attach }

  /// User overrides for group collapse state. Completed and canceled status
  /// groups collapse by default; every other group opens until toggled.
  @State private var groupCollapseOverrides: [String: Bool] = [:]
  @Environment(\.linearIssueSelection) private var selection

  private enum ListContent { case skeletons, failure, empty, issues }

  private var contentMode: ListContent {
    if !store.issues.isEmpty { return .issues }
    switch store.phase {
    case .idle, .loading: return .skeletons
    case .failed: return .failure
    case .loaded: return .empty
    }
  }

  /// Rows run edge to edge vertically so the sub-issue guides join up.
  private static let rowInsets = EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 14)

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
        if store.groupedIssues.isEmpty && !store.hasNextPage {
          everythingHiddenState
        } else {
          issueSections
          hiddenGroupsFooter
          loadMoreFooter
        }
      }
    }
    .listStyle(.plain)
    .listSectionSpacing(.compact)
    .environment(\.defaultMinListRowHeight, 0)
    .scrollContentBackground(.hidden)
    .background(ADEColor.pageBackground.ignoresSafeArea())
    .safeAreaInset(edge: .top, spacing: 0) {
      // The Duo's Linear window carries these in its views rail and the
      // filter menu instead of a chip row over the list.
      if selection.select == nil {
        LinearFilterChipsBar(store: store)
      }
    }
    .searchable(text: $store.query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search issues")
    .refreshable { await store.reload() }
    .onChange(of: store.query) { _, _ in store.scheduleReload() }
    .onChange(of: store.assignedToMe) { _, _ in store.scheduleReload() }
    .onChange(of: store.statePreset) { _, _ in store.scheduleReload() }
    .onChange(of: store.projectId) { _, _ in store.scheduleReload() }
    .onChange(of: store.priority) { _, _ in store.scheduleReload() }
    .navigationTitle(mode == .browse ? store.workspaceTitle : "Attach issue")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar { linearToolbar }
  }

  // Extracted from `body` to keep the SwiftUI type-checker under its budget
  // (the List + searchable + onChange chain + toolbar together tip it over).
  @ToolbarContentBuilder
  private var linearToolbar: some ToolbarContent {
    if showsClose {
      ToolbarItem(placement: .topBarLeading) {
        Button { onClose() } label: {
          Image(systemName: "xmark").font(.system(size: 13, weight: .semibold))
        }
        .accessibilityLabel("Close Linear")
      }
    }
    ToolbarItem(placement: .topBarTrailing) {
      NavigationLink(value: LinearRoute.connection) {
        Image(systemName: "gearshape")
      }
      .accessibilityLabel("Linear connection settings")
    }
    ToolbarItem(placement: .topBarTrailing) {
      LinearFiltersMenu(store: store, includesState: selection.select != nil)
    }
    ToolbarItem(placement: .topBarTrailing) {
      LinearDisplayMenu(store: store)
    }
  }

  // MARK: Sections

  @ViewBuilder
  private var issueSections: some View {
    ForEach(store.groupedIssues) { group in
      if group.isUngrouped {
        Section {
          groupRows(group)
        }
      } else {
        let collapsed = isCollapsed(group)
        Section {
          if !collapsed {
            groupRows(group)
          }
        } header: {
          Button {
            withAnimation(.snappy(duration: 0.2)) {
              groupCollapseOverrides[group.id] = !collapsed
            }
          } label: {
            LinearGroupHeader(
              title: group.title,
              icon: headerIcon(for: group),
              count: group.issues.count,
              collapsed: collapsed
            )
          }
          .buttonStyle(.plain)
          .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 2, trailing: 14))
        }
      }
    }
  }

  private func isCollapsed(_ group: LinearIssueGroup) -> Bool {
    if let override = groupCollapseOverrides[group.id] { return override }
    guard store.displayPreferences.grouping == .workflowState else { return false }
    return linearGroupCollapsedByDefault(stateType: group.stateType)
  }

  /// Project groups take the project's color from the catalog.
  private func headerIcon(for group: LinearIssueGroup) -> LinearGroupIcon {
    if case .project = group.icon, let project = store.projects.first(where: { $0.id == group.id }) {
      return .project(color: project.color)
    }
    return group.icon
  }

  @ViewBuilder
  private func groupRows(_ group: LinearIssueGroup) -> some View {
    ForEach(group.rows) { row in
      rowView(row)
        .listRowInsets(Self.rowInsets)
        .listRowSeparator(.hidden)
    }
  }

  @ViewBuilder
  private func rowView(_ row: LinearIssueListRow) -> some View {
    switch row.kind {
    case .context(let ref):
      LinearContextIssueRow(ref: ref, row: row)
        .listRowBackground(Color.clear)
    case .issue(let issue):
      issueRow(issue, row: row)
    }
  }

  @ViewBuilder
  private func issueRow(_ issue: NormalizedLinearIssue, row: LinearIssueListRow) -> some View {
    let hasLane = store.attachedIssueIds.contains(issue.id)
    let preferences = store.displayPreferences
    switch mode {
    case .attach:
      Button {
        onAttachIssue?(issue)
      } label: {
        LinearIssueRow(issue: issue, hasLane: hasLane, row: row, preferences: preferences, interactive: false)
      }
      .buttonStyle(.plain)
      .listRowBackground(Color.clear)
    case .browse:
      if let select = selection.select {
        // The Duo's Linear window shows the issue beside the list.
        Button {
          select(issue)
        } label: {
          LinearIssueRow(issue: issue, hasLane: hasLane, row: row, preferences: preferences, interactive: false)
        }
        .buttonStyle(.plain)
        .listRowBackground(
          selection.selectedIssueId == issue.id ? LinearBrand.surface : Color.clear
        )
      } else {
        // The link sits behind the row so the row draws no chevron (as in
        // Linear) while the PR chip stays its own button.
        ZStack {
          NavigationLink(value: LinearRoute.issue(issue)) { EmptyView() }
            .opacity(0)
            .accessibilityHidden(true)
          LinearIssueRow(
            issue: issue,
            hasLane: hasLane,
            row: row,
            preferences: preferences,
            interactive: true,
            onOpen: openAction(for: issue)
          )
        }
        .listRowBackground(Color.clear)
        .accessibilityAddTraits(.isButton)
      }
    }
  }

  private func openAction(for issue: NormalizedLinearIssue) -> (() -> Void)? {
    guard let onOpenIssue else { return nil }
    return { onOpenIssue(issue) }
  }

  // MARK: Footers and states

  @ViewBuilder
  private var hiddenGroupsFooter: some View {
    if store.hiddenGroupCount > 0 {
      HStack(spacing: 8) {
        Text(store.hiddenGroupCount == 1
          ? "1 group is hidden by your Linear display settings."
          : "\(store.hiddenGroupCount) groups are hidden by your Linear display settings.")
          .font(.caption)
          .foregroundStyle(ADEColor.textMuted)
          .frame(maxWidth: .infinity, alignment: .leading)
        Button("Show all") { store.showAllGroups() }
          .font(.caption.weight(.semibold))
          .buttonStyle(.borderless)
          .tint(LinearBrand.primaryBright)
      }
      .padding(.vertical, 12)
      .listRowBackground(Color.clear)
      .listRowSeparator(.hidden)
    }
  }

  @ViewBuilder
  private var loadMoreFooter: some View {
    if store.hasNextPage {
      // Pages on its own only while paging works and the list is under the
      // cap; after a failed page, a page with nothing new, or 2,000 issues it
      // waits for a tap.
      if store.loadMoreStalled || store.issues.count >= 2000 {
        HStack {
          Spacer()
          if store.loadingMore {
            ProgressView()
              .controlSize(.small)
              .tint(LinearBrand.primaryBright)
          } else {
            Button("Load more") { Task { await store.loadMore() } }
              .font(.caption.weight(.semibold))
              .buttonStyle(.borderless)
              .tint(LinearBrand.primaryBright)
          }
          Spacer()
        }
        .padding(.vertical, 12)
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
      } else {
        HStack {
          Spacer()
          ProgressView()
            .controlSize(.small)
            .tint(LinearBrand.primaryBright)
          Spacer()
        }
        .padding(.vertical, 12)
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
        // A new row per loaded page, so the footer pages again when it is
        // still on screen (every loaded row hidden).
        .id("load-more-\(store.issues.count)")
        .onAppear { Task { await store.loadMore() } }
      }
    }
  }

  @ViewBuilder
  private var skeletons: some View {
    ForEach(0..<6, id: \.self) { _ in
      ADECardSkeleton(rows: 2)
        .padding(.vertical, 4)
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
    }
  }

  @ViewBuilder
  private var emptyState: some View {
    ADEEmptyStateView(
      symbol: "tray",
      title: store.hasNoFilters ? "No issues yet" : "No issues",
      message: emptyMessage
    )
    .listRowBackground(Color.clear)
    .listRowSeparator(.hidden)
    .padding(.top, 24)
  }

  private var emptyMessage: String {
    if store.hasNoFilters { return "This Linear workspace has no issues." }
    if store.assignedToMe {
      return "Nothing assigned to you matches these filters. Turn off \u{201C}Assigned to me\u{201D} to widen the search."
    }
    return "No Linear issues match these filters."
  }

  /// Issues loaded, but the display settings hide all of them.
  @ViewBuilder
  private var everythingHiddenState: some View {
    let completedOnly = store.hiddenCompletedCount > 0 && store.hiddenGroupCount == 0
    ADEEmptyStateView(
      symbol: "eye.slash",
      title: "Nothing to show",
      message: completedOnly
        ? "Every matching issue is completed. Turn on \u{201C}Show completed issues\u{201D} in Display to see them."
        : "Your Linear display settings hide every group here. Show all groups to see them."
    ) {
      if completedOnly {
        Button("Show completed issues") {
          store.updateDisplay(LinearDisplayPreferencesPatch(showCompletedIssues: true))
        }
        .buttonStyle(.bordered)
        .tint(LinearBrand.primaryBright)
      } else if store.hiddenGroupCount > 0 {
        Button("Show all groups") { store.showAllGroups() }
          .buttonStyle(.bordered)
          .tint(LinearBrand.primaryBright)
      }
    }
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

/// One issue as Linear lists it: state icon and title, then a quiet line of
/// priority, identifier, sub-issue ring, PR chip, label and date, and the
/// assignee (and delegated agent) on the right. Sub-issues sit indented under
/// their parent with a thin guide.
struct LinearIssueRow: View {
  let issue: NormalizedLinearIssue
  let hasLane: Bool
  var row: LinearIssueListRow? = nil
  var preferences: LinearDisplayPreferences = .linearDefault
  /// False when the whole row is a button (attach, the Duo's window): the PR
  /// chip then reads as a label.
  var interactive = true
  /// Opens the issue: the row's VoiceOver default action when the row is not
  /// itself a button (the list's hidden link does the tapping).
  var onOpen: (() -> Void)? = nil

  @ScaledMetric(relativeTo: .subheadline) private var titleLine: CGFloat = 20
  @ScaledMetric(relativeTo: .subheadline) private var iconSize: CGFloat = 15
  @ScaledMetric(relativeTo: .subheadline) private var indent: CGFloat = 20
  @ScaledMetric(relativeTo: .caption) private var priorityIconSize: CGFloat = 12
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  @Environment(\.openURL) private var openURL

  private static let verticalPadding: CGFloat = 9

  private var depth: Int { row?.depth ?? 0 }
  private var fields: LinearIssueDisplayFields { preferences.fields }

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      LinearStateIcon(stateType: issue.stateType, size: iconSize)
        .frame(height: titleLine)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 4) {
        Text(issue.title)
          .font(.subheadline.weight(.medium))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(dynamicTypeSize.isAccessibilitySize ? 4 : 2)
          .multilineTextAlignment(.leading)
          .frame(maxWidth: .infinity, alignment: .leading)
        ViewThatFits(in: .horizontal) {
          metaLine(detail: 3)
          metaLine(detail: 2)
          metaLine(detail: 1)
          metaLine(detail: 0)
        }
      }
      // Grouped by assignee, the header names them; a delegated agent still shows.
      let groupedByAssignee = preferences.grouping == .assignee
      if fields.assignee != false, !groupedByAssignee || issue.delegateName?.isEmpty == false {
        LinearAssigneeStack(issue: issue, showsAssignee: !groupedByAssignee)
          .frame(minHeight: titleLine)
      }
    }
    .padding(.leading, linearTreeIndent(depth: depth, indent: indent))
    .padding(.vertical, Self.verticalPadding)
    .background(alignment: .topLeading) {
      if let row, row.depth > 0 || row.hasChildRows {
        LinearTreeGuides(
          row: row,
          indent: indent,
          iconSize: iconSize,
          elbowY: Self.verticalPadding + titleLine / 2
        )
      }
    }
    .contentShape(Rectangle())
    .accessibilityElement(children: .combine)
    .accessibilityLabel(accessibilityText)
    .accessibilityActions {
      // The PR chip is folded into the row for VoiceOver; offer it here.
      if interactive {
        ForEach(Array(LinearPrChip.visible(issue.pullRequests).enumerated()), id: \.offset) { _, pr in
          if let url = pr.url.flatMap(URL.init(string:)) {
            Button(pr.number.map { "Open pull request \($0)" } ?? "Open pull request") { openURL(url) }
          }
        }
      }
    }
    .modifier(LinearRowOpenAction(onOpen: onOpen))
  }

  /// The metadata line at a level of detail; `ViewThatFits` drops to the
  /// next level when the row is too narrow (small phones, large text).
  @ViewBuilder
  private func metaLine(detail: Int) -> some View {
    HStack(spacing: 7) {
      // A top-level row grouped by priority sits under its priority's header.
      if fields.priority != false, preferences.grouping != .priority || depth > 0,
         (issue.priority ?? 0) != 0 || detail >= 2 {
        LinearPriorityIcon(priority: issue.priority, size: priorityIconSize)
          .accessibilityHidden(true)
      }
      if fields.id != false {
        Text(issue.identifier)
          .font(.caption.weight(.medium).monospacedDigit())
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(1)
          .layoutPriority(1)
      }
      if detail >= 2, let parent = row?.parentHint {
        HStack(spacing: 2) {
          Image(systemName: "arrow.turn.down.right")
          Text(parent.identifier)
        }
        .font(.caption2.weight(.medium))
        .foregroundStyle(ADEColor.textMuted)
        .lineLimit(1)
      }
      if hasLane {
        Image(systemName: "square.stack.3d.up.fill")
          .font(.caption2.weight(.semibold))
          .foregroundStyle(LinearBrand.primaryBright)
      }
      if let progress = row?.progress {
        LinearProgressRing(progress: progress)
      }
      if detail >= 1, fields.pullRequests != false, !LinearPrChip.visible(issue.pullRequests).isEmpty {
        LinearPrChip(pullRequests: issue.pullRequests ?? [], interactive: interactive)
      }
      if detail >= 2, fields.labels != false {
        LinearLabelSummary(issue: issue)
      }
      if detail >= 3, fields.project == true, preferences.grouping != .project, let project = issue.projectName {
        Label(project, systemImage: "cube")
          .labelStyle(.titleAndIcon)
          .font(.caption2)
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(1)
      }
      if detail >= 2, fields.dueDate != false, let due = linearDueDate(issue.dueDate) {
        LinearDueDateChip(date: due, closed: linearIsClosedState(issue.stateType))
      }
      if detail >= 3, let date = rowDate {
        Text(linearShortDate(date))
          .font(.caption2.monospacedDigit())
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(1)
      }
    }
    .fixedSize(horizontal: detail > 0, vertical: false)
  }

  /// Created date unless the display settings turned it off for updated.
  private var rowDate: Date? {
    if fields.createdAt != false { return issueISODate(issue.createdAt) }
    if fields.updatedAt == true { return issueISODate(issue.updatedAt) }
    return nil
  }

  private var accessibilityText: String {
    var parts: [String] = []
    if depth > 0 { parts.append("Sub-issue") }
    parts.append(issue.identifier)
    parts.append(issue.title)
    parts.append(issue.stateName ?? issue.stateType?.capitalized ?? "")
    if let priority = linearPriorityLabel(issue.priority) { parts.append("\(priority) priority") }
    if let parent = row?.parentHint { parts.append("Sub-issue of \(parent.identifier)") }
    if let progress = row?.progress { parts.append(linearProgressAccessibilityLabel(progress)) }
    let prs = LinearPrChip.visible(issue.pullRequests)
    if !prs.isEmpty { parts.append(linearPrAccessibilityLabel(prs)) }
    if hasLane { parts.append("Has lane") }
    return parts.filter { !$0.isEmpty }.joined(separator: ", ")
  }
}

/// Gives a row VoiceOver's default action (open the issue) only when it has
/// one, so a row used as a button's label keeps the button's own action.
private struct LinearRowOpenAction: ViewModifier {
  let onOpen: (() -> Void)?

  @ViewBuilder
  func body(content: Content) -> some View {
    if let onOpen {
      content.accessibilityAction(.default, onOpen)
    } else {
      content
    }
  }
}

/// A sub-issue Linear lists under a loaded parent that this list did not load
/// (filtered out or not fetched yet): muted, not tappable.
struct LinearContextIssueRow: View {
  let ref: NormalizedLinearIssueChild
  let row: LinearIssueListRow

  @ScaledMetric(relativeTo: .subheadline) private var titleLine: CGFloat = 20
  @ScaledMetric(relativeTo: .subheadline) private var iconSize: CGFloat = 15
  @ScaledMetric(relativeTo: .subheadline) private var indent: CGFloat = 20

  private static let verticalPadding: CGFloat = 7

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      LinearStateIcon(stateType: ref.stateType, size: iconSize)
        .frame(height: titleLine)
        .opacity(0.6)
      HStack(spacing: 7) {
        Text(ref.identifier)
          .font(.caption.weight(.medium).monospacedDigit())
          .foregroundStyle(ADEColor.textMuted)
        Text(ref.title)
          .font(.subheadline)
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(1)
      }
      .frame(minHeight: titleLine)
      Spacer(minLength: 0)
    }
    .padding(.leading, linearTreeIndent(depth: row.depth, indent: indent))
    .padding(.vertical, Self.verticalPadding)
    .background(alignment: .topLeading) {
      LinearTreeGuides(
        row: row,
        indent: indent,
        iconSize: iconSize,
        elbowY: Self.verticalPadding + titleLine / 2
      )
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Sub-issue \(ref.identifier), \(ref.title), \(ref.stateName ?? ""), not in this list")
  }
}

/// Indentation stops growing past four levels so deep trees stay readable.
private let linearMaxVisualDepth = 4

func linearTreeIndent(depth: Int, indent: CGFloat) -> CGFloat {
  CGFloat(min(depth, linearMaxVisualDepth)) * indent
}

/// The thin tree lines beside nested rows: a vertical guide per open ancestor,
/// an elbow into this row's state icon, and a stem down from a parent's icon.
struct LinearTreeGuides: View {
  let row: LinearIssueListRow
  let indent: CGFloat
  let iconSize: CGFloat
  let elbowY: CGFloat

  var body: some View {
    let depth = min(row.depth, linearMaxVisualDepth)
    Canvas { context, size in
      let color = ADEColor.textMuted.opacity(0.35)
      let width: CGFloat = 1
      var path = Path()
      func guideX(_ level: Int) -> CGFloat { CGFloat(level) * indent + iconSize / 2 }
      // Ancestors whose sub-issue lists go on past this row.
      for level in 0..<max(0, depth - 1) where level < row.guides.count && row.guides[level] {
        path.move(to: CGPoint(x: guideX(level), y: 0))
        path.addLine(to: CGPoint(x: guideX(level), y: size.height))
      }
      if depth > 0 {
        let x = guideX(depth - 1)
        path.move(to: CGPoint(x: x, y: 0))
        path.addLine(to: CGPoint(x: x, y: row.isLastSibling ? elbowY : size.height))
        path.move(to: CGPoint(x: x, y: elbowY))
        path.addLine(to: CGPoint(x: CGFloat(depth) * indent - 3, y: elbowY))
      }
      if row.hasChildRows {
        let x = guideX(depth)
        path.move(to: CGPoint(x: x, y: elbowY + iconSize / 2 + 2))
        path.addLine(to: CGPoint(x: x, y: size.height))
      }
      context.stroke(path, with: .color(color), lineWidth: width)
    }
    .frame(width: CGFloat(depth) * indent + iconSize)
    .frame(maxHeight: .infinity)
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }
}

struct LinearDueDateChip: View {
  let date: Date
  let closed: Bool

  private var overdue: Bool {
    !closed && date < Calendar.current.startOfDay(for: Date())
  }

  var body: some View {
    Label(linearShortDate(date), systemImage: "calendar")
      .labelStyle(.titleAndIcon)
      .font(.caption2.weight(.medium).monospacedDigit())
      .foregroundStyle(overdue ? ADEColor.danger : ADEColor.textSecondary)
      .lineLimit(1)
      .accessibilityLabel(overdue ? "Overdue, due \(linearShortDate(date))" : "Due \(linearShortDate(date))")
  }
}

private let linearShortDateFormatter: DateFormatter = {
  let formatter = DateFormatter()
  formatter.setLocalizedDateFormatFromTemplate("MMMd")
  return formatter
}()

private let linearShortDateWithYearFormatter: DateFormatter = {
  let formatter = DateFormatter()
  formatter.setLocalizedDateFormatFromTemplate("MMMdyyyy")
  return formatter
}()

/// `Nov 26`, or `Nov 26, 2025` outside this year (Linear's list dates).
func linearShortDate(_ date: Date) -> String {
  let calendar = Calendar.current
  if calendar.component(.year, from: date) == calendar.component(.year, from: Date()) {
    return linearShortDateFormatter.string(from: date)
  }
  return linearShortDateWithYearFormatter.string(from: date)
}

// MARK: - Group header

struct LinearGroupHeader: View {
  let title: String
  let icon: LinearGroupIcon
  let count: Int
  var collapsed: Bool = false

  var body: some View {
    HStack(spacing: 8) {
      Image(systemName: "chevron.right")
        .font(.caption2.weight(.bold))
        .foregroundStyle(ADEColor.textMuted)
        .rotationEffect(.degrees(collapsed ? 0 : 90))
      LinearGroupIconView(icon: icon)
      Text(title)
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)
      Text(verbatim: "\(count)")
        .font(.caption.weight(.medium).monospacedDigit())
        .foregroundStyle(ADEColor.textMuted)
      Spacer(minLength: 0)
    }
    .textCase(nil)
    .padding(.vertical, 4)
    .contentShape(Rectangle())
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(title), \(count == 1 ? "1 issue" : "\(count) issues")")
    .accessibilityValue(collapsed ? "Collapsed" : "Expanded")
    .accessibilityHint(collapsed ? "Shows the issues in this group" : "Hides the issues in this group")
    .accessibilityAddTraits(.isHeader)
  }
}

struct LinearGroupIconView: View {
  let icon: LinearGroupIcon
  @ScaledMetric(relativeTo: .subheadline) private var size: CGFloat = 14

  var body: some View {
    Group {
      switch icon {
      case .state(let type):
        LinearStateIcon(stateType: type, size: size)
      case .priority(let value):
        LinearPriorityIcon(priority: value, size: size)
      case .person(let name, let avatarUrl):
        if let name {
          LinearAvatar(name: name, avatarUrl: avatarUrl, size: size + 2)
        } else {
          Image(systemName: "person.crop.circle.dashed")
            .foregroundStyle(ADEColor.textMuted)
        }
      case .project(let color):
        Image(systemName: "cube.fill")
          .foregroundStyle(linearHexColor(color) ?? ADEColor.textMuted)
      case .label(let color):
        Circle()
          .fill(linearHexColor(color) ?? ADEColor.textMuted)
          .frame(width: size * 0.6, height: size * 0.6)
      case .cycle:
        Image(systemName: "arrow.triangle.2.circlepath")
          .foregroundStyle(ADEColor.textMuted)
      case .milestone:
        Image(systemName: "diamond")
          .foregroundStyle(ADEColor.textMuted)
      case .team:
        Image(systemName: "person.2")
          .foregroundStyle(ADEColor.textMuted)
      case .none:
        EmptyView()
      }
    }
    .font(.system(size: size * 0.85, weight: .semibold))
    .frame(width: size + 2, height: size + 2)
    .accessibilityHidden(true)
  }
}
