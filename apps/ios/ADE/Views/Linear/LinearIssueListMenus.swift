import SwiftUI

// The Linear list's chip row, Filters menu and Display menu, with the
// titles they show for each display choice.

// MARK: - Filter chips bar (assigned-to-me + state preset)

struct LinearFilterChipsBar: View {
  @ObservedObject var store: LinearPaneStore

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
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
      if let notice = store.displaySaveNotice {
        Label(notice, systemImage: "info.circle")
          .font(.caption2)
          .foregroundStyle(ADEColor.textMuted)
          .padding(.horizontal, 16)
          .padding(.bottom, 6)
          .accessibilityLabel("Display change \(notice.lowercased())")
      }
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
      .background(isOn ? LinearBrand.surface : ADEKit.track, in: Capsule())
      .overlay(Capsule().stroke(isOn ? LinearBrand.border : Color.clear, lineWidth: 1))
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(isOn ? .isSelected : [])
  }
}

// MARK: - Filters menu (project + priority)

struct LinearFiltersMenu: View {
  @ObservedObject var store: LinearPaneStore
  /// The state presets, for a layout with no chip row to hold them.
  var includesState = false

  var body: some View {
    Menu {
      if includesState {
        Picker("State", selection: $store.statePreset) {
          ForEach(LinearPaneStore.StatePreset.allCases) { preset in
            Text(preset.title).tag(preset)
          }
        }
        .pickerStyle(.inline)
      }
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
    .accessibilityLabel("Filters")
  }

  private var hasActiveFilter: Bool {
    store.projectId != nil || store.priority != nil
      || (includesState && store.statePreset != .all)
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

// MARK: - Display menu (Linear's own display settings)

/// Linear's Display options: grouping, ordering, sub-issues and completed
/// issues. A change applies at once and is written back to Linear, so the
/// website and ADE show the same list.
struct LinearDisplayMenu: View {
  @ObservedObject var store: LinearPaneStore

  private var preferences: LinearDisplayPreferences { store.displayPreferences }

  var body: some View {
    Menu {
      // Each choice is a submenu whose label carries the current value as
      // its subtitle; the inline picker inside draws the checkmarks.
      Menu {
        Picker("Grouping", selection: groupingBinding) {
          ForEach(LinearIssueGrouping.allCases, id: \.self) { grouping in
            Text(linearGroupingTitle(grouping)).tag(grouping)
          }
        }
        .pickerStyle(.inline)
      } label: {
        menuLabel("Grouping", value: linearGroupingTitle(preferences.grouping), systemImage: "rectangle.grid.1x2")
      }

      Menu {
        Picker("Ordering", selection: orderingBinding) {
          ForEach(LinearIssueOrdering.allCases, id: \.self) { ordering in
            Text(linearOrderingTitle(ordering)).tag(ordering)
          }
        }
        .pickerStyle(.inline)
      } label: {
        menuLabel("Ordering", value: linearOrderingTitle(preferences.ordering), systemImage: "arrow.up.arrow.down")
      }

      if let titles = linearDirectionTitles(preferences.ordering) {
        Menu {
          Picker("Direction", selection: directionBinding) {
            Text(titles.ascending).tag("asc")
            Text(titles.descending).tag("desc")
          }
          .pickerStyle(.inline)
        } label: {
          menuLabel(
            "Direction",
            value: preferences.orderingDirection.lowercased() == "desc" ? titles.descending : titles.ascending,
            systemImage: "arrow.up.and.down.text.horizontal"
          )
        }
      }

      Menu {
        Picker("Sub-issues", selection: nestingBinding) {
          ForEach([LinearIssueNesting.showAll, .showMatching, LinearIssueNesting.none], id: \.self) { nesting in
            Text(linearNestingTitle(nesting)).tag(nesting)
          }
        }
        .pickerStyle(.inline)
      } label: {
        menuLabel("Sub-issues", value: linearNestingTitle(preferences.nesting), systemImage: "list.bullet.indent")
      }

      Toggle(isOn: completedBinding) {
        Label("Show completed issues", systemImage: "checkmark.circle")
      }

      // Groups Linear's display settings hide, with a way to show them.
      if store.hiddenGroupCount > 0 {
        Button {
          store.showAllGroups()
        } label: {
          Label("Show all groups", systemImage: "eye")
          Text(store.hiddenGroupCount == 1 ? "1 group hidden" : "\(store.hiddenGroupCount) groups hidden")
        }
      }

      Section {
        Text(sourceLine)
      }
    } label: {
      Image(systemName: "slider.horizontal.3")
        .foregroundStyle(ADEColor.textSecondary)
    }
    .accessibilityLabel("Display options")
  }

  /// A submenu row with its current choice underneath, as iOS menus show it.
  /// (A menu row reads a Label then a Text as its title and subtitle.)
  @ViewBuilder
  private func menuLabel(_ title: String, value: String, systemImage: String) -> some View {
    Label(title, systemImage: systemImage)
    Text(value)
  }

  private var sourceLine: String {
    if let notice = store.displaySaveNotice { return notice }
    switch preferences.source {
    case "linear-view", "linear-user": return "From your Linear display settings"
    case "ade": return "Saved in ADE for this project"
    default: return "Linear\u{2019}s default display"
    }
  }

  private var groupingBinding: Binding<LinearIssueGrouping> {
    Binding(
      get: { store.displayPreferences.grouping },
      set: { store.updateDisplay(LinearDisplayPreferencesPatch(grouping: $0)) }
    )
  }

  private var orderingBinding: Binding<LinearIssueOrdering> {
    Binding(
      get: { store.displayPreferences.ordering },
      set: { ordering in
        store.updateDisplay(LinearDisplayPreferencesPatch(
          ordering: ordering,
          orderingDirection: linearNaturalDirection(for: ordering)
        ))
      }
    )
  }

  private var directionBinding: Binding<String> {
    Binding(
      get: { store.displayPreferences.orderingDirection.lowercased() == "desc" ? "desc" : "asc" },
      set: { store.updateDisplay(LinearDisplayPreferencesPatch(orderingDirection: $0)) }
    )
  }

  private var nestingBinding: Binding<LinearIssueNesting> {
    Binding(
      get: { store.displayPreferences.nesting },
      set: { store.updateDisplay(LinearDisplayPreferencesPatch(nesting: $0)) }
    )
  }

  private var completedBinding: Binding<Bool> {
    Binding(
      get: { store.displayPreferences.showCompletedIssues },
      set: { store.updateDisplay(LinearDisplayPreferencesPatch(showCompletedIssues: $0)) }
    )
  }
}

func linearGroupingTitle(_ grouping: LinearIssueGrouping) -> String {
  switch grouping {
  case .workflowState: return "Status"
  case .assignee: return "Assignee"
  case .project: return "Project"
  case .priority: return "Priority"
  case .cycle: return "Cycle"
  case .label: return "Label"
  case .projectMilestone: return "Milestone"
  case .team: return "Team"
  case .none: return "No grouping"
  }
}

func linearOrderingTitle(_ ordering: LinearIssueOrdering) -> String {
  switch ordering {
  case .manual: return "Manual"
  case .priority: return "Priority"
  case .updatedAt: return "Last updated"
  case .createdAt: return "Created"
  case .dueDate: return "Due date"
  case .estimate: return "Estimate"
  case .title: return "Title"
  }
}

func linearNestingTitle(_ nesting: LinearIssueNesting) -> String {
  switch nesting {
  case .showAll: return "Nested, all sub-issues"
  case .showMatching: return "Nested, matching only"
  case .none: return "Flat list"
  }
}

/// The two direction choices for an ordering that has a direction.
func linearDirectionTitles(_ ordering: LinearIssueOrdering) -> (ascending: String, descending: String)? {
  switch ordering {
  case .manual, .priority: return nil
  case .updatedAt, .createdAt: return ("Oldest first", "Newest first")
  case .dueDate: return ("Soonest first", "Latest first")
  case .estimate: return ("Smallest first", "Largest first")
  case .title: return ("A to Z", "Z to A")
  }
}
