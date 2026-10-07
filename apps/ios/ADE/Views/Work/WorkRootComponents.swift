import SwiftUI
import UIKit
import AVKit

// The session row card itself (`WorkSessionRow`, its leaf views and the preview-line
// helpers) lives in `WorkSessionRowCard.swift`; this file keeps the surrounding list chrome.

/// Expanded filter panel under the Work header, laid out like the desktop
/// panel: the one-of-many Group choice is a segmented control, and the filters
/// below the rule are rows of chips with a fixed label column. Search itself and
/// the chip that toggles this panel live in `WorkRootHeader`.
struct WorkFiltersSection: View {
  @Binding var searchText: String
  @Binding var selectedLaneId: String
  @Binding var selectedStatus: WorkSessionStatusFilter
  @Binding var organization: WorkSessionOrganization
  /// By-lane only: fold lanes with nothing waiting on you into a Working shelf.
  var foldBusyLanes: Binding<Bool>? = nil
  let filterOpen: Bool
  /// Status, lane and machine filters applied (`workActiveFilterCount`).
  let activeFilterCount: Int
  /// Serialized machine ids (`workSerializeMachineFilter`). Empty = all.
  var machineFilter: Binding<String> = .constant("")
  var machineOptions: [WorkMachineFilterOption] = []
  let lanes: [LaneSummary]
  let onClear: () -> Void

  private var selectedMachines: Set<String> { workParseMachineFilter(machineFilter.wrappedValue) }

  /// The choices plus any filtered machine that has since left, so a saved
  /// filter never hides rows without a chip to turn it off.
  private var visibleMachineOptions: [WorkMachineFilterOption] {
    let known = Set(machineOptions.map(\.id))
    let stale = selectedMachines.subtracting(known).sorted().map {
      WorkMachineFilterOption(id: $0, name: "Unavailable machine", isLive: false)
    }
    return machineOptions + stale
  }

  private var hasActiveFilters: Bool {
    activeFilterCount > 0
      || !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  private var selectedLaneName: String {
    guard selectedLaneId != "all" else { return "All lanes" }
    return lanes.first(where: { $0.id == selectedLaneId }).map(laneMenuTitle) ?? "All lanes"
  }

  /// Two machines' lanes can share a name ("main"), so a lane from another
  /// machine names it in the picker entry (never in a title).
  private func laneMenuTitle(_ lane: LaneSummary) -> String {
    guard let machine = workRemoteLaneMachineName(lane.id, options: machineOptions) else { return lane.name }
    return "\(lane.name) — \(machine)"
  }

  var body: some View {
    if filterOpen {
      panel
    } else if hasActiveFilters {
      HStack(spacing: 6) {
        Spacer(minLength: 0)
        clearButton
      }
    }
  }

  /// Desktop's panel (`WorkFilterPanel.tsx`): two short sections, a label on
  /// the left and one menu button on the right of every row. "View" never
  /// hides a chat; "Show only" does. Colour stays out of the panel.
  private var panel: some View {
    VStack(alignment: .leading, spacing: 16) {
      VStack(alignment: .leading, spacing: 8) {
        sectionLabel("View")
        filterRow("Group by") {
          menuButton(organization.title, active: false) {
            Picker("Group by", selection: $organization.animation(.snappy(duration: 0.18))) {
              ForEach(WorkSessionOrganization.allCases) { option in
                Text(option.title).tag(option)
              }
            }
          }
        }
        if organization == .byLane, let foldBusyLanes {
          filterRow("Focus") {
            checkRow("Fold busy lanes", checked: foldBusyLanes.wrappedValue) {
              withAnimation(.snappy(duration: 0.18)) { foldBusyLanes.wrappedValue.toggle() }
            }
            .accessibilityHint("Lanes with nothing waiting on you fold into a Working section until something needs you or finishes.")
          }
        }
      }

      VStack(alignment: .leading, spacing: 8) {
        HStack {
          sectionLabel("Show only")
          Spacer(minLength: 0)
          if activeFilterCount > 0 {
            Button("Reset") {
              withAnimation(.snappy(duration: 0.18)) { onClear() }
            }
            .font(.caption2)
            .foregroundStyle(ADEColor.textSecondary)
            .buttonStyle(.plain)
          }
        }
        filterRow("Status") {
          menuButton(selectedStatus == .all ? "Any" : selectedStatus.title, active: selectedStatus != .all) {
            Picker("Status", selection: $selectedStatus.animation(.snappy(duration: 0.18))) {
              ForEach(WorkSessionStatusFilter.allCases) { status in
                Text(status == .all ? "Any" : status.title).tag(status)
              }
            }
          }
        }
        if visibleMachineOptions.count > 1 {
          filterRow("Machine") {
            menuButton(machineSummary, active: !selectedMachines.isEmpty) {
              ForEach(visibleMachineOptions) { machine in
                Button {
                  withAnimation(.snappy(duration: 0.18)) { toggleMachine(machine.id) }
                } label: {
                  if selectedMachines.contains(machine.id) {
                    Label(machine.isLive ? machine.name : "\(machine.name) (offline)", systemImage: "checkmark")
                  } else {
                    Text(machine.isLive ? machine.name : "\(machine.name) (offline)")
                  }
                }
              }
              if !selectedMachines.isEmpty {
                Divider()
                Button("Show all") {
                  withAnimation(.snappy(duration: 0.18)) { machineFilter.wrappedValue = "" }
                }
              }
            }
          }
        }
        filterRow("Lane") {
          menuButton(selectedLaneName, active: selectedLaneId != "all") {
            Picker("Lane", selection: $selectedLaneId) {
              Text("All lanes").tag("all")
              ForEach(lanes) { lane in
                Text(laneMenuTitle(lane)).tag(lane.id)
              }
            }
          }
          .accessibilityLabel("Lane filter, \(selectedLaneName)")
        }
      }
    }
    .padding(14)
    .background(ADEColor.raisedBackground, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 16, style: .continuous)
        .stroke(ADEColor.glassBorder, lineWidth: 0.5)
    )
    .shadow(color: .black.opacity(0.14), radius: 20, y: 8)
  }

  private var machineSummary: String {
    let picked = visibleMachineOptions.filter { selectedMachines.contains($0.id) }
    if picked.isEmpty { return "Any" }
    if picked.count <= 2 { return picked.map(\.name).joined(separator: ", ") }
    return "\(picked.count) selected"
  }

  private func sectionLabel(_ text: String) -> some View {
    Text(text.uppercased())
      .font(.system(size: 10, weight: .semibold))
      .tracking(0.8)
      .foregroundStyle(ADEColor.textMuted)
  }

  /// One control shape for every setting: the value, then an up-down caret.
  /// An active filter's button wears a faint accent edge, like desktop.
  private func menuButton<Content: View>(
    _ value: String,
    active: Bool,
    @ViewBuilder content: () -> Content
  ) -> some View {
    Menu {
      content()
    } label: {
      HStack(spacing: 6) {
        Text(value)
          .font(.footnote)
          .foregroundStyle(value == "Any" ? ADEColor.textSecondary : ADEColor.textPrimary)
          .lineLimit(1)
          .truncationMode(.tail)
        Spacer(minLength: 0)
        Image(systemName: "chevron.up.chevron.down")
          .font(.system(size: 9, weight: .semibold))
          .foregroundStyle(ADEColor.textMuted)
      }
      .padding(.horizontal, 10)
      .frame(height: 32)
      .frame(maxWidth: .infinity)
      .adeKitPill(
        in: RoundedRectangle(cornerRadius: 8, style: .continuous),
        edge: active ? ADEColor.accent.opacity(0.4) : ADEKit.edge
      )
    }
  }

  /// A yes/no setting as a small checkbox row.
  private func checkRow(_ title: String, checked: Bool, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      HStack(spacing: 8) {
        RoundedRectangle(cornerRadius: 4, style: .continuous)
          .fill(checked ? ADEColor.accent : Color.clear)
          .overlay(
            RoundedRectangle(cornerRadius: 4, style: .continuous)
              .stroke(checked ? ADEColor.accent : ADEColor.textMuted.opacity(0.5), lineWidth: 1)
          )
          .overlay {
            if checked {
              Image(systemName: "checkmark")
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(.white)
            }
          }
          .frame(width: 16, height: 16)
        Text(title)
          .font(.footnote)
          .foregroundStyle(ADEColor.textPrimary)
        Spacer(minLength: 0)
      }
      .frame(minHeight: 32)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(checked ? .isSelected : [])
  }

  private var clearButton: some View {
    Button {
      withAnimation(.snappy(duration: 0.18)) {
        onClear()
      }
    } label: {
      HStack(spacing: 4) {
        Image(systemName: "xmark")
          .font(.system(size: 9, weight: .bold))
        Text(activeFilterCount > 0 ? "Clear \(activeFilterCount)" : "Clear")
      }
    }
    .font(.caption.weight(.semibold))
    .foregroundStyle(ADEColor.accent)
    .buttonStyle(.plain)
    .accessibilityLabel("Clear Work filters")
  }

  private func filterRow<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
    HStack(alignment: .center, spacing: 8) {
      Text(label)
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)
        .frame(width: 64, alignment: .leading)
      content()
        .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private func toggleMachine(_ id: String) {
    var ids = selectedMachines
    if ids.contains(id) { ids.remove(id) } else { ids.insert(id) }
    machineFilter.wrappedValue = workSerializeMachineFilter(ids)
  }

  /// The chip accents, mapped one-for-one onto the desktop board's column
  /// accents (`WorkKanbanBoard.tsx`): amber for Needs you — your move and
  /// nothing else, blue for Working — something is happening and nothing is
  /// asked, a plain foreground neutral for Waiting — true, but not actionable,
  /// and emerald for Done. Every value is an existing text or semantic token,
  /// so both appearances are already covered; no chip carries a literal colour.
  ///
  /// Archived moves off amber, which it used to share with Needs you: with the
  /// chips now reading as the board's columns, a second amber would claim
  /// attention for a shelf nobody is being asked to look at.
  private func statusFilterTint(_ status: WorkSessionStatusFilter) -> Color {
    switch status {
    case .needsYou: return ADEColor.warning
    case .working: return ADEColor.info
    case .waiting: return ADEColor.textMuted
    case .done: return ADEColor.success
    case .archived: return ADEColor.textSecondary
    case .all: return ADEColor.accent
    }
  }
}

private extension View {
  /// Fades the trailing edge of a sideways-scrolling chip row, so a cut-off
  /// chip reads as "more this way" instead of a clipped label.
  func workChipRowFade() -> some View {
    mask(
      LinearGradient(
        stops: [.init(color: .black, location: 0), .init(color: .black, location: 0.9), .init(color: .clear, location: 1)],
        startPoint: .leading,
        endPoint: .trailing
      )
    )
  }
}

/// Matches desktop `StickyGroupHeader`: chevron + semantic icon + label + count badge. Tap to
/// collapse or expand the section body in the parent list.
struct WorkSidebarSectionHeader: View {
  let group: WorkSessionGroup
  let collapsed: Bool
  let onToggle: () -> Void
  /// Primary open PR for this lane section (by-lane grouping only). Rendered
  /// once on the header, left of the session count, replacing the former
  /// per-row indicator. Nil for status/time sections.
  var pullRequest: LanePrTag? = nil
  /// Navigates to the header PR in the PRs tab. Defaults to a no-op so preview
  /// harnesses don't have to wire it.
  var onOpenPullRequest: (LanePrTag) -> Void = { _ in }
  var onRefreshOrphanedSessions: (() -> Void)? = nil
  /// Lane-scoped git state (dirty / ahead / behind). It used to be repeated on
  /// every session row of the lane, which said the same fact five times and made
  /// a row rebuild on every lane status poll. It is one lane's state, so it is
  /// stated once, here. Nil for status and time sections, which span lanes and
  /// therefore have no single true answer.
  var laneStatus: LaneStatus? = nil
  /// Lane record for the Work-tab divider long-press menu. Nil on status/time
  /// headers and orphaned sections.
  var lane: LaneSummary? = nil
  var laneMenu: WorkSessionLaneMenuActions? = nil
  /// The first Snoozed/Settled shelf draws one heavier rule above itself, so the
  /// quiet zone reads as its own region rather than one more lane. Same fence the
  /// desktop sidebar draws (`renderQuietZone` in `SessionListPane.tsx`).
  var startsQuietZone = false

  /// Collapsed and holding only settled work: render one thin muted row with the
  /// count folded in, instead of a full-weight header over nothing.
  private var isQuietRow: Bool { group.isQuiet && collapsed }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if startsQuietZone {
        Rectangle()
          .fill(ADEColor.textMuted.opacity(0.32))
          .frame(height: 1)
          .padding(.top, 14)
          .padding(.bottom, 6)
          .accessibilityHidden(true)
      }
      headerRow
    }
  }

  private var headerRow: some View {
    HStack(spacing: isQuietRow ? 6 : 8) {
      Button(action: onToggle) {
        HStack(spacing: isQuietRow ? 6 : 8) {
          Image(systemName: collapsed ? "chevron.right" : "chevron.down")
            .font(.system(size: isQuietRow ? 8 : 9, weight: .bold))
            .foregroundStyle(ADEColor.textMuted.opacity(isQuietRow ? 0.55 : 1))
            .frame(width: 10, alignment: .center)

          sectionIcon

          if group.isShelf, group.id != workWorkingSectionId {
            // Snoozed and Settled: desktop's quiet shelf label, grey caps.
            Text(group.label.uppercased())
              .font(.system(size: 10, weight: .semibold))
              .tracking(0.8)
              .foregroundStyle(ADEColor.textMuted)
              .lineLimit(1)
          } else if group.id == workWorkingSectionId {
            // Working keeps its colour on the label, then a hairline rule.
            Text(group.label)
              .font(.caption.weight(.medium))
              .foregroundStyle(ADEColor.info)
              .lineLimit(1)
            Rectangle()
              .fill(ADEColor.textMuted.opacity(0.12))
              .frame(height: 1)
              .frame(maxWidth: .infinity)
              .accessibilityHidden(true)
          } else {
            Text(group.isOrphaned ? "Orphaned sessions: \(group.label)" : group.label)
              .font(isQuietRow ? .caption2.weight(.medium) : .caption.weight(.semibold))
              .foregroundStyle(quietAwareLabelColor)
              .lineLimit(1)
            if let laneId = group.laneId, isWorkRemoteLaneId(laneId) {
              WorkRemoteLaneGlyph()
            }
          }

          // Beside the name, not in the trailing cluster: there it sat next to
          // the amber "uncommitted changes" dot and read as the same fact.
          if let laneFocus = group.laneStatus, group.laneId != nil, !isQuietRow {
            WorkLaneFocusDot(status: laneFocus)
          }

          Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
      .accessibilityLabel(accessibilityLabelText)

      if group.isOrphaned, let onRefreshOrphanedSessions {
        Button("Refresh", systemImage: "arrow.clockwise", action: onRefreshOrphanedSessions)
          .labelStyle(.iconOnly)
          .buttonStyle(.plain)
          .frame(minWidth: 44, minHeight: 44)
          .accessibilityHint("Refreshes lane and session records. Nothing is deleted.")
      }

      // Left of the PR indicator and deliberately quieter than both it and the
      // lane name: this is context, not a call to action. Dropped entirely on a
      // folded quiet row, where the section is one thin line and every glyph
      // competes with the count.
      if !isQuietRow, let laneStatus, laneGitStateIsNoteworthy(laneStatus) {
        laneGitStateChips(laneStatus)
      }

      if let pullRequest {
        Button {
          onOpenPullRequest(pullRequest)
        } label: {
          WorkLanePrIndicator(tag: pullRequest)
        }
        .buttonStyle(.plain)
        .frame(minWidth: 44, minHeight: 44)
        .accessibilityHint("Opens in the PRs tab")
      }

      if isQuietRow, group.isShelf {
        // A shelf names itself with its icon; the trailing slot says when the
        // first row comes back (Snoozed) and how many rows it holds.
        HStack(spacing: 6) {
          if let detail = group.shelfDetail {
            Text(detail)
              .font(.caption2)
              .lineLimit(1)
          }
          Text("\(group.displayCount)")
            .font(.caption2.monospacedDigit().weight(.medium))
        }
        .foregroundStyle(ADEColor.textMuted.opacity(0.75))
        .accessibilityHidden(true)
      } else if isQuietRow {
        // Hollow ring + count: the settled tier's own language, matching the
        // desktop sidebar's inline quiet counts. Only a settled-only LANE uses
        // it; the Snoozed shelf used to borrow it and read as settled.
        HStack(spacing: 3) {
          Circle()
            .strokeBorder(ADEColor.textMuted.opacity(0.45), lineWidth: 1)
            .frame(width: 6, height: 6)
          Text("\(group.displayCount)")
            .font(.caption2.monospacedDigit().weight(.medium))
        }
        .foregroundStyle(ADEColor.textMuted.opacity(0.6))
        .accessibilityHidden(true)
      } else {
        Text("\(group.displayCount)")
          .font(.caption2.monospacedDigit().weight(.semibold))
          .foregroundStyle(ADEColor.textMuted)
          .padding(.horizontal, 7)
          .padding(.vertical, 2)
          .background(ADEColor.surfaceBackground.opacity(0.65), in: Capsule())
          .accessibilityHidden(true)
      }
    }
    .padding(.horizontal, 4)
    .padding(.vertical, isQuietRow ? 3 : 8)
    .opacity(isQuietRow ? 0.72 : 1)
    .contextMenu {
      if let lane, let laneMenu, group.laneId != nil, !group.isOrphaned {
        WorkLaneContextMenuContent(lane: lane, actions: laneMenu)
      }
    }
  }

  /// Nothing to say when the worktree is clean and level with its base — an
  /// always-present "0 ahead, 0 behind" would be chrome, not information.
  private func laneGitStateIsNoteworthy(_ status: LaneStatus) -> Bool {
    status.dirty || status.ahead > 0 || status.behind > 0
  }

  @ViewBuilder
  private func laneGitStateChips(_ status: LaneStatus) -> some View {
    HStack(spacing: 5) {
      if status.dirty {
        Circle()
          .fill(ADEColor.warning.opacity(0.85))
          .frame(width: 5, height: 5)
      }
      if status.ahead > 0 {
        laneGitCountChip(symbol: "arrow.up", count: status.ahead)
      }
      if status.behind > 0 {
        laneGitCountChip(symbol: "arrow.down", count: status.behind)
      }
    }
    .foregroundStyle(ADEColor.textMuted)
    .fixedSize()
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(laneGitStateAccessibilityLabel(status))
  }

  private func laneGitCountChip(symbol: String, count: Int) -> some View {
    HStack(spacing: 1) {
      Image(systemName: symbol)
        .font(.system(size: 7, weight: .bold))
      Text("\(count)")
        .font(.caption2.monospacedDigit())
    }
  }

  private func laneGitStateAccessibilityLabel(_ status: LaneStatus) -> String {
    var parts: [String] = []
    if status.dirty { parts.append("uncommitted changes") }
    if status.ahead > 0 { parts.append("\(status.ahead) ahead") }
    if status.behind > 0 { parts.append("\(status.behind) behind") }
    return parts.joined(separator: ", ")
  }

  private var quietAwareLabelColor: Color {
    if isQuietRow { return ADEColor.textSecondary }
    if group.isOrphaned { return ADEColor.warning }
    return group.laneColor != nil ? group.tint : ADEColor.textPrimary
  }

  private var accessibilityLabelText: String {
    let count = group.displayCount
    let noun = "session\(count == 1 ? "" : "s")"
    let action = collapsed ? "expand" : "collapse"
    if group.id == workWorkingSectionId {
      return "Working, \(count) lane\(count == 1 ? "" : "s") with nothing waiting on you. Tap to \(action)."
    }
    if group.id == workSnoozedSectionId {
      let detail = group.shelfDetail.map { ", next \($0)" } ?? ""
      return "Snoozed, \(count) snoozed \(noun)\(detail). Tap to \(action)."
    }
    if isQuietRow {
      return "\(group.label), \(count) settled \(noun). Tap to \(action)."
    }
    if let laneFocus = group.laneStatus, group.laneId != nil {
      let label = group.isOrphaned ? "Orphaned sessions: \(group.label)" : group.label
      return "\(label), \(laneFocus.statusFilter.title), \(count) \(noun). Tap to \(action)."
    }
    let label = group.isOrphaned ? "Orphaned sessions: \(group.label)" : group.label
    return "\(label), \(count) \(noun). Tap to \(action)."
  }

  @ViewBuilder
  private var sectionIcon: some View {
    switch group.icon {
    case .statusDot:
      Circle()
        .fill(group.tint)
        .frame(width: 7, height: 7)
    case .laneBranch:
      WorkLaneLogoMark(color: group.tint, laneIcon: group.laneIcon, size: 11)
        .frame(width: 12, height: 12)
    case .warning:
      Image(systemName: "exclamationmark.triangle")
        .font(.caption)
        .foregroundStyle(ADEColor.warning)
        .frame(width: 12, height: 12)
    // The three shelves wear desktop's marks (`SessionListPane.tsx`): a
    // dashed circle for Working, a moon for Snoozed, a hollow ring for Settled.
    // Snoozed and Settled differ by shape, never by colour.
    case .working:
      Image(systemName: "circle.dashed")
        .font(.system(size: 11, weight: .bold))
        .foregroundStyle(ADEColor.info)
        .frame(width: 12, height: 12)
    case .snoozed:
      Image(systemName: "moon.fill")
        .font(.system(size: 9, weight: .semibold))
        .foregroundStyle(ADEColor.textMuted.opacity(0.7))
        .frame(width: 12, height: 12)
    case .settled:
      Circle()
        .strokeBorder(ADEColor.textMuted.opacity(0.7), lineWidth: 1)
        .frame(width: 8, height: 8)
        .frame(width: 12, height: 12)
    case .none:
      Color.clear.frame(width: 0, height: 0)
    }
  }
}

// `WorkFlatCountChip` and `WorkLiveCountPill` used to live here: an above-the-list
// "N waiting" chip and a tappable top-bar pill, both fed from one screen-wide
// needs-input count that `WorkRootSessionPresentation` no longer publishes at
// all. They are deleted, not moved. Amber means "your move"
// and nothing else, and spending it three times on one screen (pill, chip, row
// badge) is precisely what made the per-row badge stop registering. The pill's
// jump-to-attention is already covered by the bell → Activity drawer, which
// bands needs-you first with per-session navigation.

/// The lane half of a session row's long-press menu, mirroring desktop's
/// `Lane ▸` submenu (`laneContextMenuItems.tsx`).
///
/// Bundled instead of eight loose closures because every call site wires all of
/// them or none, and because the two availability flags have to travel with the
/// actions they gate. `colorAvailable` / `manageAvailable` are per-command
/// gates: a host that does not advertise `lanes.updateAppearance` must not show
/// a colour row that silently fails.
///
/// Desktop items with no phone analogue are deliberately absent, not forgotten:
/// Open in / Remove from Split, Close Other Tabs, Select All Lanes and Reveal in
/// Finder all describe a windowing model a phone does not have.
struct WorkSessionLaneMenuActions {
  var colorAvailable: Bool = false
  var manageAvailable: Bool = false
  var onStartChat: (LaneSummary) -> Void = { _ in }
  var onToggleWorkPin: (LaneSummary) -> Void = { _ in }
  var isWorkPinned: (LaneSummary) -> Bool = { _ in false }
  var onOpenInWeb: (LaneSummary) -> Void = { _ in }
  var onCopyLaneLink: (LaneSummary) -> Void = { _ in }
  var onCopyBranchLink: (LaneSummary) -> Void = { _ in }
  var onCopyLinearLink: (LaneSummary) -> Void = { _ in }
  var onCopyPath: (LaneSummary) -> Void = { _ in }
  var onSetColor: (LaneSummary, String?) -> Void = { _, _ in }
  var onManage: (LaneSummary) -> Void = { _ in }
}

/// Shared lane long-press contents for a session row's `Lane ▸` submenu and the
/// lane divider itself, so the two surfaces cannot drift.
struct WorkLaneContextMenuContent: View {
  let lane: LaneSummary
  let actions: WorkSessionLaneMenuActions

  var body: some View {
    Button {
      actions.onStartChat(lane)
    } label: {
      Label("Start chat in lane", systemImage: "plus.bubble")
    }
    Button {
      actions.onToggleWorkPin(lane)
    } label: {
      Label(
        actions.isWorkPinned(lane) ? "Unpin from Work sidebar" : "Pin to Work sidebar",
        systemImage: actions.isWorkPinned(lane) ? "pin.slash" : "pin"
      )
    }
    Button {
      actions.onOpenInWeb(lane)
    } label: {
      Label("Open in web", systemImage: "safari")
    }
    Menu {
      Button {
        actions.onCopyLaneLink(lane)
      } label: {
        Label("ADE lane link", systemImage: "link")
      }
      Button {
        actions.onCopyBranchLink(lane)
      } label: {
        Label("Branch link", systemImage: "arrow.triangle.branch")
      }
      if primaryLaneLinearIssue(for: lane)?.url != nil {
        Button {
          actions.onCopyLinearLink(lane)
        } label: {
          Label("Linear issue link", systemImage: "square.on.square")
        }
      }
      Button {
        actions.onCopyPath(lane)
      } label: {
        Label("Path", systemImage: "folder")
      }
    } label: {
      Label("Copy", systemImage: "doc.on.doc")
    }
    if actions.colorAvailable {
      Menu {
        ForEach(LaneColorPalette.entries) { entry in
          Button {
            actions.onSetColor(lane, entry.hex)
          } label: {
            Label(entry.name, systemImage: lane.color?.lowercased() == entry.hex.lowercased()
              ? "checkmark.circle.fill"
              : "circle.fill")
          }
        }
        Divider()
        Button {
          actions.onSetColor(lane, nil)
        } label: {
          Label("No color", systemImage: "circle.dashed")
        }
      } label: {
        Label("Color", systemImage: "paintpalette")
      }
    }
    if actions.manageAvailable {
      Button {
        actions.onManage(lane)
      } label: {
        Label("Manage lane", systemImage: "slider.horizontal.3")
      }
    }
  }
}

/// Single-row renderer for the session list that carries the swipe + context-menu action set.
/// Used inside the sidebar's grouped loop so the Work root screen can drive the section
/// organization directly (byLane / byStatus / byTime) without a nested Section wrapper.
struct WorkSessionListRow: View {
  let session: TerminalSessionSummary
  let lane: LaneSummary?
  var pullRequest: LanePrTag? = nil
  let chatSummary: AgentChatSessionSummary?
  let isArchived: Bool
  let transitionNamespace: Namespace.ID?
  var compact: Bool = false
  /// Compact nested-subagent drawer row: identicon/lineage on the leading edge,
  /// provider mark on the trailing edge — same right-side seat as a full card.
  var nestedSubagent: Bool = false
  /// True when no lane header sits above this row — the singleton form, where
  /// the row carries the lane identity itself.
  var showsLaneIdentity: Bool = true
  var isLaneDeleting = false
  @Binding var selectedSessionId: String?
  let isSelecting: Bool
  let isChecked: Bool
  let onLongPressSelect: (TerminalSessionSummary) -> Void
  let onToggleSelect: (TerminalSessionSummary) -> Void
  let onOpen: (TerminalSessionSummary) -> Void
  let onPin: (TerminalSessionSummary) -> Void
  let onRename: (TerminalSessionSummary) -> Void
  let onStopRuntime: (TerminalSessionSummary) -> Void
  let onDelete: (TerminalSessionSummary) -> Void
  let onCopyId: (TerminalSessionSummary) -> Void
  let onCopyDeepLink: (TerminalSessionSummary) -> Void
  let onGoToLane: (TerminalSessionSummary) -> Void
  /// Opens the row's linked PR (mapped or GitHub-by-branch) in the PRs tab.
  /// Defaults to a no-op so preview harnesses don't have to wire it.
  var onOpenPullRequest: (TerminalSessionSummary, LanePrTag) -> Void = { _, _ in }
  // ADE-125 session lifecycle. Defaults are no-ops (and the affordances are
  // hidden) so preview harnesses and older hosts don't have to wire them.
  /// The host advertises settle / unsettle / settle-override.
  var lifecycleAvailable: Bool = false
  /// The host advertises snooze / wake.
  var snoozeAvailable: Bool = false
  var onSettle: (TerminalSessionSummary) -> Void = { _ in }
  /// Settle a needs-you row AND clear its pending prompt. Separate from
  /// `onSettle` because the host rejects the dismiss flag on a row with nothing
  /// pending — the two are different commands, not one command with a toggle.
  var onDismissAndSettle: (TerminalSessionSummary) -> Void = { _ in }
  var onUnsettle: (TerminalSessionSummary) -> Void = { _ in }
  var onKeepActive: (TerminalSessionSummary) -> Void = { _ in }
  var onSnooze: (TerminalSessionSummary, WorkSnoozeDuration) -> Void = { _, _ in }
  var onWake: (TerminalSessionSummary) -> Void = { _ in }
  /// Demote a subagent chat to a peer so it stops reporting to its parent.
  var onDemoteToPeer: (TerminalSessionSummary) -> Void = { _ in }
  /// Promote a peer chat back to a subagent so it reports to its parent again.
  var onPromoteToSubagent: (TerminalSessionSummary) -> Void = { _ in }
  /// The host advertises `chat.setSpawnKind`. Older hosts have
  /// `chat.updateSession` but cannot apply spawn-kind writes.
  var spawnKindUpdateAvailable: Bool = false
  /// The host advertises `work.deleteSession` — the stop-then-delete path for a
  /// non-chat row. Older hosts never had it, so a phone talking to one hides the
  /// two destructive items rather than offering a control that always fails.
  var deleteSessionAvailable: Bool = false
  /// Deletes a CLI/shell session (running or stopped). Chats keep `onDelete`;
  /// the two go through different host commands and different confirmations.
  var onDeleteSession: (TerminalSessionSummary) -> Void = { _ in }
  /// Opens this session in the hosted web client. Purely local — it builds a URL
  /// and hands it to the system, so it needs no host command and no gate.
  var onOpenInWeb: (TerminalSessionSummary) -> Void = { _ in }
  /// Lane-scoped actions for the `Lane ▸` submenu. Nil (the default) renders no
  /// submenu at all, which is also what a row with no resolvable lane gets.
  var laneMenu: WorkSessionLaneMenuActions? = nil
  /// The host advertises `chat.regenerateSessionMetadata`.
  var generateNamesAvailable: Bool = false
  var onGenerateNames: (TerminalSessionSummary, [String]) -> Void = { _, _ in }

  /// Observed so the muted glyph and menu label re-render the moment a mute
  /// flips anywhere (this menu, the open chat's header menu, settings).
  @ObservedObject private var pushNotificationService = PushNotificationService.shared

  /// Mute only applies to chat sessions.
  private var isMuted: Bool {
    isChatSession(session)
      && pushNotificationService.prefs.mutedSessionIds.contains(session.id)
  }

  private var canonicalPhase: CanonicalSessionPhase {
    workCanonicalSessionState(session: session, summary: chatSummary).phase
  }

  private var isSnoozed: Bool {
    session.isSnoozed()
  }

  private var isChat: Bool { isChatSession(session) }

  /// Mid-flight. Desktop hides Settle for these (`sessionIsMidFlight` in
  /// `renderer/lib/terminalAttention.ts`): filing away a row the machine is
  /// still working in claims an outcome that has not happened yet, and the row
  /// is about to change state on its own anyway. iOS used to allow it, which
  /// let a user settle a session mid-turn.
  ///
  /// Desktop's version carries one extra clause this deliberately does not:
  /// there, live background work promotes a resting session back to `running`,
  /// and such a row must still be settleable because settle teardown is what
  /// stops that work. iOS has no background-work promotion — `liveness` is not
  /// part of this file's `CanonicalSessionState` and no session-level
  /// background count reaches the phone — so a background-only session already
  /// reads `ready`/`idle` here and Settle is already offered. The two agree on
  /// behaviour by different routes; if iOS ever gains the promotion, it must
  /// gain the `liveness == .turn` clause with it.
  private var isActivelyRunning: Bool {
    canonicalPhase == .starting || canonicalPhase == .running || canonicalPhase == .stale
  }

  /// Whether a needs-you ask can be DISMISSED as part of settling. A chat
  /// resolves its own prompts, and an escalated ask carries a record the host
  /// knows how to clear. A bare terminal prompt has neither, so settling it
  /// would hide a question the machine is still blocked on — which is why
  /// desktop explains the absence instead of quietly dropping the item.
  ///
  /// These are exactly desktop's three clauses (`SessionContextMenu.tsx:200-203`).
  /// Do NOT add `attentionSource == "provider_structured"` here: that clause
  /// belongs to the status slot, which uses it to keep a heuristic row
  /// *settleable*, and it is a different question from "can the host dismiss
  /// this prompt". The only shape it admits that these three do not is a
  /// non-chat row with no `attentionRequestedAt` — which `ptyService.ts`
  /// documents as a MISLABEL from regex-scanning a plain PTY stream (search
  /// "is a MISLABEL and known to be one"; cited by phrase rather than line
  /// because that file moves). For that row `dismissPendingInputBeforeSettle`
  /// has nothing to
  /// clear and throws, so offering "Dismiss & settle" could only ever produce
  /// an error toast and a rolled-back optimistic write. Falling through to the
  /// disabled "Resolve input to settle" row is the honest answer.
  private var canDismissNeedsYou: Bool {
    canonicalPhase != .needsYou
      || isChat
      || session.attentionRequestedAt != nil
  }

  private var canSettle: Bool {
    lifecycleAvailable
      && canonicalPhase != .settled
      && !isActivelyRunning
      && canDismissNeedsYou
  }

  /// The settle for a needs-you row also clears the pending prompt, and says so.
  /// The host REJECTS the dismiss flag on a row with nothing pending, so this is
  /// the only condition under which the dismissing variant may be sent.
  private var settleDismissesPendingInput: Bool {
    canonicalPhase == .needsYou
  }

  /// Needs-you with an ask nothing can dismiss. Desktop renders a DISABLED row
  /// here rather than nothing: an item that silently disappears reads as a bug,
  /// while "Resolve input to settle" states the precondition.
  private var settleBlockedOnInput: Bool {
    lifecycleAvailable && canonicalPhase == .needsYou && !canDismissNeedsYou
  }

  private var canUnsettle: Bool {
    lifecycleAvailable && canonicalPhase == .settled
  }

  /// "Keep active" only means something against a DECLARED settle — one an
  /// agent, user, operator or merge policy wrote into `settled_at`. A settle the
  /// UI merely derived has no column for the pin to hold down, so desktop
  /// restricts the item the same way (`SessionContextMenu.tsx:209`, `:250`).
  private var canKeepActive: Bool {
    lifecycleAvailable
      && session.settledAt != nil
      && session.resolvedSettleOverride != .active
      && canonicalPhase == .settled
  }

  private var canDemoteToPeer: Bool {
    workCanDemoteChatToPeer(
      isChat: isChat,
      spawnKind: chatSummary?.spawnKind,
      parentSessionId: chatSummary?.orchestrationParentSessionId,
      hostSupportsSpawnKindUpdate: spawnKindUpdateAvailable
    )
  }

  private var canPromoteToSubagent: Bool {
    workCanPromoteChatToSubagent(
      isChat: isChat,
      spawnKind: chatSummary?.spawnKind,
      parentSessionId: chatSummary?.orchestrationParentSessionId,
      hostSupportsSpawnKindUpdate: spawnKindUpdateAvailable
    )
  }

  private var snoozeOptions: [WorkSnoozeOption] {
    workSnoozeOptions()
  }

  var body: some View {
    let rowStatus = normalizedWorkChatSessionStatus(session: session, summary: chatSummary)
    Button {
      if isSelecting {
        onToggleSelect(session)
      } else {
        onOpen(session)
      }
    } label: {
      HStack(spacing: 8) {
        if isSelecting {
          Image(systemName: isChecked ? "checkmark.circle.fill" : "circle")
            .font(.system(size: 20, weight: .regular))
            .foregroundStyle(isChecked ? ADEColor.accent : ADEColor.textSecondary.opacity(0.6))
            .accessibilityLabel(isChecked ? "Selected" : "Not selected")
        }
        WorkSessionRow(
          session: session,
          lane: lane,
          pullRequest: pullRequest,
          chatSummary: chatSummary,
          status: rowStatus,
          isArchived: isArchived,
          isMuted: isMuted,
          transitionNamespace: transitionNamespace,
          isSelectedTransitionSource: selectedSessionId == session.id,
          compact: compact,
          nestedSubagent: nestedSubagent,
          showsLaneIdentity: showsLaneIdentity
        )
        .equatable()
      }
    }
    .buttonStyle(.plain)
    // No raw `LongPressGesture` here. A 0.45s press competed with the very same
    // long press that opens `.contextMenu`, so whichever recogniser won was a
    // coin toss and the menu felt broken. The menu's own "Select" item is the
    // single way into multi-select now.
    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
      if isStoppableRuntimeStatus(session, status: rowStatus) {
        Button("Stop runtime", role: .destructive) {
          onStopRuntime(session)
        }
        .tint(ADEColor.danger)
      } else if shouldShowDeleteAction {
        Button("Delete chat", role: .destructive) {
          onDelete(session)
        }
        .tint(ADEColor.danger)
      } else if canDeleteStoppedSession(status: rowStatus) {
        // A stopped CLI or shell row. Until `work.deleteSession` was wired there
        // was no way at all to delete one of these from a phone.
        Button("Delete session", role: .destructive) {
          onDeleteSession(session)
        }
        .tint(ADEColor.danger)
      }
      // The two lifecycle moves people make constantly get a swipe; everything
      // else lives in the long-press menu. iOS has no hover, so there is no
      // desktop-style always-visible moon button.
      if canSettle {
        Button {
          settle()
        } label: {
          Label(settleLabel, systemImage: "checkmark.circle")
        }
        .tint(ADEColor.accent)
      } else if canUnsettle {
        Button {
          onUnsettle(session)
        } label: {
          Label("Unsettle", systemImage: "arrow.uturn.backward.circle")
        }
        .tint(ADEColor.accent)
      }
      if snoozeAvailable {
        if isSnoozed {
          Button {
            onWake(session)
          } label: {
            Label("Wake", systemImage: "sun.max")
          }
          .tint(ADEColor.warning)
        } else {
          // The swipe is the fast path — one hour. Every other window is a
          // long-press away, so the swipe never opens a picker mid-gesture.
          Button {
            onSnooze(session, .oneHour)
          } label: {
            Label("Snooze 1h", systemImage: "moon.zzz")
          }
          .tint(ADEColor.info)
        }
      }
    }
    // Rows have no card, so the long-press lift needs a shape of its own.
    .contentShape(.contextMenuPreview, RoundedRectangle(cornerRadius: 12, style: .continuous))
    // Desktop's tree, in desktop's order (`SessionContextMenu.tsx`): identity
    // first, then lifecycle, then the places this session also appears, then —
    // fenced behind a divider and never before it — the deletes. Ordering is not
    // cosmetic here: a mis-tap right after the menu opens lands mid-list, which
    // is exactly where the deletes used to sit.
    .contextMenu {
      identityMenuSection
      lifecycleMenuSection(status: rowStatus)
      goToMenuSection
      destructiveMenuSection(status: rowStatus)
    }
    .overlay {
      if isLaneDeleting {
        HStack(spacing: 6) {
          ProgressView().controlSize(.small)
          Text("Updating lane…")
            .font(.caption.weight(.semibold))
        }
        .foregroundStyle(ADEColor.textSecondary)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(ADEColor.pageBackground.opacity(0.94), in: Capsule())
      }
    }
    .disabled(isLaneDeleting)
    .accessibilityHint(isLaneDeleting ? "This lane is being deleted" : "")
  }

  private var shouldShowDeleteAction: Bool {
    isChatSession(session)
  }

  /// Stop-then-delete for a live CLI/shell row: desktop's "Stop & delete".
  private func canStopAndDeleteSession(status: String) -> Bool {
    deleteSessionAvailable && isStoppableRuntimeStatus(session, status: status)
  }

  /// Plain delete for a CLI/shell row that is already stopped. `work.delete
  /// Session` handles both, but the labels differ because the consequences do.
  private func canDeleteStoppedSession(status: String) -> Bool {
    deleteSessionAvailable && !isChat && !isStoppableRuntimeStatus(session, status: status)
  }

  private var settleLabel: String {
    settleDismissesPendingInput ? "Dismiss & settle" : "Settle"
  }

  private func settle() {
    if settleDismissesPendingInput {
      onDismissAndSettle(session)
    } else {
      onSettle(session)
    }
  }

  // MARK: - Menu sections

  /// What this row is called and how it is filed. Unlabelled: it is the first
  /// block under the finger and needs no signpost.
  @ViewBuilder
  private var identityMenuSection: some View {
    Button {
      onLongPressSelect(session)
    } label: {
      Label("Select", systemImage: "checkmark.circle")
    }
    if !CursorCloudNaming.ownsName(session.cursorCloudAgentId)
      && !CursorCloudNaming.ownsName(chatSummary?.cursorCloudAgentId) {
      Button {
        onRename(session)
      } label: {
        Label("Rename", systemImage: "pencil")
      }
    }
    Button {
      onPin(session)
    } label: {
      Label(session.pinned ? "Unpin from front" : "Pin to front",
            systemImage: session.pinned ? "pin.slash" : "pin")
    }
    if isChat {
      Button {
        PushNotificationService.shared.setMuted(!isMuted, sessionId: session.id)
      } label: {
        Label(isMuted ? "Unmute notifications" : "Mute notifications",
              systemImage: isMuted ? "bell" : "bell.slash")
      }
    }
    generateNamesMenu
  }

  @ViewBuilder
  private var generateNamesMenu: some View {
    if isChat && generateNamesAvailable {
      let cloudOwned = CursorCloudNaming.ownsName(session.cursorCloudAgentId)
        || CursorCloudNaming.ownsName(chatSummary?.cursorCloudAgentId)
      Menu {
        if !cloudOwned {
          Button {
            onGenerateNames(session, ["title"])
          } label: {
            Label("Generate chat title", systemImage: "textformat")
          }
        }
        Button {
          onGenerateNames(session, ["laneName"])
        } label: {
          Label("Generate lane name", systemImage: "arrow.triangle.branch")
        }
        Button {
          onGenerateNames(session, ["statusLine"])
        } label: {
          Label("Generate status line", systemImage: "text.alignleft")
        }
        Button {
          onGenerateNames(
            session,
            cloudOwned ? ["laneName", "statusLine"] : ["title", "laneName", "statusLine"]
          )
        } label: {
          Label(cloudOwned ? "Generate lane & status" : "Generate all three", systemImage: "sparkles")
        }
      } label: {
        Label("Generate names", systemImage: "sparkles")
      }
    }
  }

  /// Everything that changes where the list files this row: stop (runtime),
  /// snooze/wake (visibility), settle/keep-active (state). Durations use a
  /// native nested `Menu`, never a popover — this is a long press on a phone.
  ///
  /// Keep it exhaustive. A row that reaches the end of this block with nothing
  /// rendered is a row the user cannot un-hide.
  @ViewBuilder
  private func lifecycleMenuSection(status: String) -> some View {
    let canStopRuntime = isStoppableRuntimeStatus(session, status: status)
    if canStopRuntime || lifecycleAvailable || snoozeAvailable || canDemoteToPeer || canPromoteToSubagent {
      Divider()
      // Stop runtime moved here from the identity block: it is a lifecycle
      // change, and it is NOT destructive — the session and its transcript
      // survive — so it must not sit next to the deletes.
      if canStopRuntime {
        Button {
          onStopRuntime(session)
        } label: {
          Label("Stop runtime", systemImage: "stop.fill")
        }
      }
      if snoozeAvailable {
        if isSnoozed {
          Button {
            onWake(session)
          } label: {
            Label("Wake now", systemImage: "sun.max")
          }
        } else {
          Menu {
            ForEach(snoozeOptions, id: \.duration.id) { option in
              Button {
                onSnooze(session, option.duration)
              } label: {
                Label(option.duration.label, systemImage: option.duration.symbol)
              }
            }
          } label: {
            Label("Snooze", systemImage: "moon.zzz")
          }
        }
      }
      if canSettle {
        Button {
          settle()
        } label: {
          Label(settleLabel, systemImage: "checkmark.circle")
        }
      } else if settleBlockedOnInput {
        // Disabled on purpose. Hiding Settle here would leave the user hunting
        // for an item that simply vanished; this states the precondition.
        Button {} label: {
          Label("Resolve input to settle", systemImage: "exclamationmark.bubble")
        }
        .disabled(true)
      }
      if canUnsettle {
        Button {
          onUnsettle(session)
        } label: {
          Label("Unsettle", systemImage: "arrow.uturn.backward.circle")
        }
      }
      if canKeepActive {
        Button {
          onKeepActive(session)
        } label: {
          Label("Keep active", systemImage: "pin.circle")
        }
      }
      if canDemoteToPeer {
        Button {
          onDemoteToPeer(session)
        } label: {
          Label("Demote to peer", systemImage: "arrow.down.forward.and.arrow.up.backward")
        }
      }
      if canPromoteToSubagent {
        Button {
          onPromoteToSubagent(session)
        } label: {
          Label("Promote to subagent", systemImage: "arrow.up.backward.and.arrow.down.forward")
        }
      }
    }
  }

  /// The other surfaces that show this same session, plus the clipboard rows and
  /// the lane submenu. Copy and Lane are nested because a phone context menu
  /// past roughly ten top-level rows stops being scannable.
  @ViewBuilder
  private var goToMenuSection: some View {
    Divider()
    Button {
      onGoToLane(session)
    } label: {
      Label("Go to lane", systemImage: "arrow.triangle.branch")
    }
    if let pullRequest {
      Button {
        onOpenPullRequest(session, pullRequest)
      } label: {
        Label("Open in PRs tab", systemImage: "arrow.triangle.pull")
      }
    }
    Button {
      onOpenInWeb(session)
    } label: {
      Label("Open in web", systemImage: "safari")
    }
    Menu {
      Button {
        onCopyId(session)
      } label: {
        Label("Session ID", systemImage: "number")
      }
      Button {
        onCopyDeepLink(session)
      } label: {
        Label("Session link", systemImage: "link")
      }
    } label: {
      Label("Copy", systemImage: "doc.on.doc")
    }
    laneMenuSection
  }

  /// `Lane ▸`. Rendered only when the row actually resolves a lane and the
  /// screen wired the actions — on iOS every row has a lane header or a lane
  /// chip, so this is the lane menu for the whole app, not just singleton rows.
  @ViewBuilder
  private var laneMenuSection: some View {
    if let lane, let laneMenu {
      Menu {
        WorkLaneContextMenuContent(lane: lane, actions: laneMenu)
      } label: {
        Label("Lane", systemImage: "arrow.triangle.branch")
      }
    }
  }

  /// Destructive, last, and behind a divider — the whole point of the reorder.
  @ViewBuilder
  private func destructiveMenuSection(status: String) -> some View {
    if canStopAndDeleteSession(status: status) || shouldShowDeleteAction || canDeleteStoppedSession(status: status) {
      Divider()
      if canStopAndDeleteSession(status: status) {
        Button(role: .destructive) {
          onDeleteSession(session)
        } label: {
          Label("Stop & delete", systemImage: "trash")
        }
      }
      if shouldShowDeleteAction {
        Button(role: .destructive) {
          onDelete(session)
        } label: {
          Label("Delete chat", systemImage: "trash")
        }
      }
      if canDeleteStoppedSession(status: status) {
        Button(role: .destructive) {
          onDeleteSession(session)
        } label: {
          Label("Delete session", systemImage: "trash")
        }
      }
    }
  }
}

/// An OPEN nested drawer: caret header + rows. Drawers default collapsed
/// (`workIsNestedDrawerCollapsed`); a collapsed one renders as a
/// `WorkNestedDrawerMarks` mark instead. Tapping the header collapses it.
struct WorkNestedSessionSection<Content: View>: View {
  let group: WorkSessionChildGroup
  let onCollapse: () -> Void
  let content: () -> Content

  init(
    group: WorkSessionChildGroup,
    onCollapse: @escaping () -> Void,
    @ViewBuilder content: @escaping () -> Content
  ) {
    self.group = group
    self.onCollapse = onCollapse
    self.content = content
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Button(action: onCollapse) {
        HStack(spacing: 5) {
          Image(systemName: "chevron.down")
            .font(.system(size: 8, weight: .bold))
            .foregroundStyle(ADEColor.textMuted)
            .frame(width: 9, alignment: .center)
          Image(systemName: group.systemImage)
            .font(.system(size: 9, weight: .medium))
            .foregroundStyle(ADEColor.textMuted)
          Text(group.label)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(ADEColor.textMuted)
            .textCase(.uppercase)
            .tracking(0.4)
          Spacer(minLength: 0)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel(group.label)
      .accessibilityHint("Collapses nested sessions")
      .accessibilityValue("Expanded")

      VStack(spacing: 3) {
        content()
      }
    }
    .padding(.leading, 14)
    .overlay(alignment: .leading) {
      Rectangle()
        .fill(ADEColor.glassBorder.opacity(0.75))
        .frame(width: 1)
        .padding(.leading, 3)
    }
  }
}

/// A parent's COLLAPSED drawers, as one thin line of marks under the card:
/// kind icon, count, and the one state worth seeing (`workNestedDrawerStatus`).
/// Tapping a mark opens that drawer. Mirrors desktop `renderCollapsedDrawerMark`.
struct WorkNestedDrawerMarks: View {
  let groups: [WorkSessionChildGroup]
  let onOpen: (WorkSessionChildGroup) -> Void

  var body: some View {
    HStack(spacing: 4) {
      ForEach(groups) { group in
        Button {
          onOpen(group)
        } label: {
          HStack(spacing: 4) {
            Image(systemName: group.systemImage)
              .font(.system(size: 9, weight: .medium))
            Text("\(group.children.count)")
              .font(.caption2.monospacedDigit())
            statusGlyph(group.status)
          }
          .foregroundStyle(ADEColor.textMuted)
          .padding(.horizontal, 6)
          .frame(minHeight: 32)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityLabel(group))
        .accessibilityHint("Expands nested sessions")
      }
      Spacer(minLength: 0)
    }
    .padding(.leading, 8)
  }

  @ViewBuilder
  private func statusGlyph(_ status: WorkNestedDrawerStatus) -> some View {
    switch status {
    case .failed:
      Image(systemName: "xmark")
        .font(.system(size: 8, weight: .bold))
        .foregroundStyle(ADEColor.danger)
    case .needsYou:
      Circle()
        .fill(ADEColor.warning)
        .frame(width: 6, height: 6)
    case .running:
      Image(systemName: "circle.dashed")
        .font(.system(size: 9, weight: .bold))
        .foregroundStyle(ADEColor.info)
    case .none:
      EmptyView()
    }
  }

  /// "Show N shells", plus the status word VoiceOver would otherwise lose.
  private func accessibilityLabel(_ group: WorkSessionChildGroup) -> String {
    let base = "Show \(group.label)"
    switch group.status {
    case .failed: return "\(base), Failed"
    case .needsYou: return "\(base), Needs you"
    case .running: return "\(base), Running"
    case .none: return base
    }
  }
}

/// Provider mark: renders the branded asset for known families inside a tinted
/// rounded-card container so each mark reads as a logo, not a raw glyph.
struct WorkProviderLogo: View {
  let provider: String?
  let fallbackSymbol: String
  let tint: Color
  let size: CGFloat

  init(provider: String?, fallbackSymbol: String = "terminal.fill", tint: Color = ADEColor.textSecondary, size: CGFloat = 28) {
    self.provider = provider
    self.fallbackSymbol = fallbackSymbol
    self.tint = tint
    self.size = size
  }

  private var containerTint: Color {
    providerTint(provider) == ADEColor.accent && provider == nil ? tint : providerTint(provider)
  }

  var body: some View {
    if let assetName = providerAssetName(provider) {
      let padded = size * 0.54
      Image(assetName)
        .resizable()
        .aspectRatio(contentMode: .fit)
        .frame(width: padded, height: padded)
        .frame(width: size, height: size)
        .background(
          containerTint.opacity(0.16),
          in: RoundedRectangle(cornerRadius: size * 0.3, style: .continuous)
        )
        .overlay(
          RoundedRectangle(cornerRadius: size * 0.3, style: .continuous)
            .stroke(containerTint.opacity(0.22), lineWidth: 0.5)
        )
    } else {
      Image(systemName: fallbackSymbol)
        .font(.system(size: size * 0.58, weight: .semibold))
        .foregroundStyle(tint)
        .frame(width: size, height: size)
        .background(tint.opacity(0.14), in: RoundedRectangle(cornerRadius: size * 0.3, style: .continuous))
        .overlay(
          RoundedRectangle(cornerRadius: size * 0.3, style: .continuous)
            .stroke(tint.opacity(0.18), lineWidth: 0.5)
        )
    }
  }
}

/// The mark for Custom — ADE's own saved agent-plus-model setups. A port of
/// `CustomToolMark.tsx`: a gear with a wrench inside it, drawn rather than
/// imported so it lands on the same baseline as the provider marks beside it.
/// Used by the Custom rail entry and by a preset whose picture (`upload` /
/// `generated`) lives only on its own machine.
struct WorkCustomToolMark: View {
  /// The desktop mark's violet, `#a78bfa`.
  static let defaultColor = Color(red: 0.655, green: 0.545, blue: 0.980)

  var size: CGFloat = 18
  var color: Color = WorkCustomToolMark.defaultColor

  var body: some View {
    Canvas { context, canvasSize in
      let scale = min(canvasSize.width, canvasSize.height) / 24
      func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
        CGPoint(x: x * scale, y: y * scale)
      }

      // Gear ring — eight teeth, with the centre cut out (even-odd).
      var gear = Path()
      let teeth: [(CGFloat, CGFloat)] = [
        (21.09, 10.04), (23.30, 10.48), (23.30, 13.52), (21.09, 13.96),
        (19.81, 17.04), (21.06, 18.92), (18.92, 21.06), (17.04, 19.81),
        (13.96, 21.09), (13.52, 23.30), (10.48, 23.30), (10.04, 21.09),
        (6.96, 19.81), (5.08, 21.06), (2.94, 18.92), (4.19, 17.04),
        (2.91, 13.96), (0.70, 13.52), (0.70, 10.48), (2.91, 10.04),
        (4.19, 6.96), (2.94, 5.08), (5.08, 2.94), (6.96, 4.19),
        (10.04, 2.91), (10.48, 0.70), (13.52, 0.70), (13.96, 2.91),
        (17.04, 4.19), (18.92, 2.94), (21.06, 5.08), (19.81, 6.96),
      ]
      gear.move(to: point(teeth[0].0, teeth[0].1))
      for tooth in teeth.dropFirst() {
        gear.addLine(to: point(tooth.0, tooth.1))
      }
      gear.closeSubpath()
      gear.addEllipse(in: CGRect(x: 5.6 * scale, y: 5.6 * scale, width: 12.8 * scale, height: 12.8 * scale))
      context.fill(gear, with: .color(color), style: FillStyle(eoFill: true))

      // Wrench head — the long arc under the slot, then down into the slot and
      // back, so the head is one outline instead of a disc minus a rectangle.
      let headRadius: CGFloat = 3.2
      let halfChord: CGFloat = 1.1
      let headCenterY = 6.8 + sqrt(headRadius * headRadius - halfChord * halfChord)
      let headCenter = point(12, headCenterY)
      var head = Path()
      head.addArc(
        center: headCenter,
        radius: headRadius * scale,
        startAngle: Angle(radians: atan2(6.8 - headCenterY, 10.9 - 12)),
        endAngle: Angle(radians: atan2(6.8 - headCenterY, 13.1 - 12)),
        clockwise: true
      )
      head.addLine(to: point(13.1, 9.5))
      head.addLine(to: point(10.9, 9.5))
      head.closeSubpath()
      context.fill(head, with: .color(color))

      // Wrench handle — from the head down into the gear ring.
      var handle = Path()
      handle.addRoundedRect(
        in: CGRect(x: 10.75 * scale, y: 11.6 * scale, width: 2.5 * scale, height: 9.2 * scale),
        cornerSize: CGSize(width: 1.1 * scale, height: 1.1 * scale)
      )
      context.fill(handle, with: .color(color))
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }
}

/// A preset's mark, mirroring `HarnessLogo.tsx`: a provider's brand mark, or
/// the Custom mark in the preset's own accent. An `upload`/`generated` picture
/// never leaves its machine, so a remote surface draws the Custom mark for it
/// rather than a wrong company's logo.
struct WorkHarnessPresetMark: View {
  let logo: SyncMachineInventoryPresetLogo?
  let accentColor: String?
  var size: CGFloat = 22

  private var resolvedAccent: Color? {
    LaneColorPalette.color(forHex: accentColor)
  }

  var body: some View {
    let providerId = logo?.providerId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    Group {
      if logo?.kind == "provider", !providerId.isEmpty {
        WorkProviderBareLogo(
          provider: providerId,
          fallbackSymbol: providerIcon(providerId),
          tint: providerTint(providerId),
          size: size
        )
      } else {
        WorkCustomToolMark(size: size, color: resolvedAccent ?? WorkCustomToolMark.defaultColor)
      }
    }
    .frame(width: size, height: size)
    .overlay {
      if let resolvedAccent {
        Circle().stroke(resolvedAccent, lineWidth: 1.5)
      }
    }
  }
}


/// Borderless provider mark — same asset as WorkProviderLogo but without the
/// surrounding tinted square. Used inside the provider-tinted session card so
/// the logo reads as part of the card itself, not a separate badge.
struct WorkProviderBareLogo: View {
  let provider: String?
  let fallbackSymbol: String
  let tint: Color
  let size: CGFloat

  var body: some View {
    if let assetName = providerAssetName(provider) {
      Image(assetName)
        .resizable()
        .aspectRatio(contentMode: .fit)
        .frame(width: size, height: size)
    } else {
      Image(systemName: fallbackSymbol)
        .font(.system(size: size * 0.7, weight: .semibold))
        .foregroundStyle(tint)
        .frame(width: size, height: size)
    }
  }
}

/// Minimal PR status indicator shown to the right of the lane name in the Work
/// session list, where space is tight: a state-colored dot, the PR number, and
/// a short state label ("Open" / "Draft" / "Closed" / "Merged"). Mirrors the
/// Lanes tab `LanePrTagChip`, trimmed to fit the dense metadata row.
struct WorkLanePrIndicator: View {
  let tag: LanePrTag

  var body: some View {
    let tint = lanePullRequestTint(tag.state)
    HStack(spacing: 3) {
      Circle()
        .fill(tint)
        .frame(width: 6, height: 6)
      Text(verbatim: "#\(tag.githubPrNumber)")
        .font(.caption2.monospacedDigit().weight(.semibold))
      Text(lanePrStateLabel(tag.state))
        .font(.caption2.weight(.medium))
    }
    .foregroundStyle(tint)
    .lineLimit(1)
    .fixedSize()
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Pull request #\(tag.githubPrNumber), \(lanePrStateLabel(tag.state))")
  }
}

struct WorkTag: View {
  let text: String
  let icon: String
  let tint: Color

  var body: some View {
    Label(text, systemImage: icon)
      .font(.caption2.weight(.medium))
      .foregroundStyle(tint)
      .lineLimit(1)
      .fixedSize(horizontal: true, vertical: false)
      .padding(.horizontal, 8)
      .padding(.vertical, 5)
      .background(tint.opacity(0.10), in: Capsule(style: .continuous))
  }
}

// MARK: - Work header

/// Everything the Work header can do, bundled so the header stays a value with
/// no reference to `SyncService` (and therefore no reason to re-render on its
/// publishes).
struct WorkRootHeaderActions {
  var onBackToHub: () -> Void = {}
  var onNewChat: () -> Void = {}
  var onCancelSelection: () -> Void = {}
  var onOpenActivity: () -> Void = {}
  var onOpenLinear: () -> Void = {}
  var onOpenCursorCloud: () -> Void = {}
  var onOpenSettings: () -> Void = {}
}

/// The Work tab's header, one row:
///
///     [project / back] Work [ search ……………… (filter) ] [new chat] [⋯]
///
/// The project control keeps the hub-back behaviour of `ADEHubBackButton`.
/// Linear, Cursor Cloud, Settings and the Activity drawer live in the overflow
/// menu, whose icon carries the unread dot the bell used to.
struct WorkRootHeader: View {
  let projectIconDataUrl: String?
  @Binding var searchText: String
  @Binding var filterOpen: Bool
  /// Lane + status filters applied (search excluded — the field shows it).
  let activeFilterCount: Int
  let isLive: Bool
  let showsLinear: Bool
  let showsCursorCloud: Bool
  /// Non-nil while multi-select is on; the row becomes "N selected · Cancel".
  let selectionCount: Int?
  let actions: WorkRootHeaderActions

  var body: some View {
    HStack(spacing: 8) {
      if let selectionCount {
        Text("\(selectionCount) selected")
          .font(.system(size: 22, weight: .heavy, design: .rounded))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
          .accessibilityAddTraits(.isHeader)
        Spacer(minLength: 8)
        Button("Cancel", action: actions.onCancelSelection)
          .font(.body.weight(.semibold))
          .foregroundStyle(ADEColor.accent)
          .frame(minHeight: 44)
          .accessibilityLabel("Cancel selection")
      } else {
        WorkHeaderProjectButton(iconDataUrl: projectIconDataUrl, action: actions.onBackToHub)
        Text("Work")
          .font(.system(size: 22, weight: .heavy, design: .rounded))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
          .fixedSize()
          .accessibilityAddTraits(.isHeader)
        WorkHeaderSearchField(
          searchText: $searchText,
          filterOpen: $filterOpen,
          activeFilterCount: activeFilterCount
        )
        Button(action: actions.onNewChat) {
          Image(systemName: "square.and.pencil")
            .font(.system(size: 18, weight: .medium))
            .foregroundStyle(isLive ? ADEColor.textPrimary : ADEColor.textMuted)
            .frame(width: 32, height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!isLive)
        .accessibilityLabel("New chat")
        .accessibilityHint(isLive ? "Opens a new chat" : "Reconnect to the machine to start a chat")
        WorkHeaderOverflowMenu(
          showsLinear: showsLinear,
          showsCursorCloud: showsCursorCloud,
          actions: actions
        )
      }
    }
    .padding(.horizontal, 16)
    .frame(minHeight: 56)
    .background {
      LinearGradient(
        colors: [
          ADEColor.pageBackground,
          ADEColor.pageBackground.opacity(0.98),
          ADEColor.pageBackground.opacity(0.88),
          ADEColor.pageBackground.opacity(0)
        ],
        startPoint: .top,
        endPoint: .bottom
      )
      .ignoresSafeArea(edges: .top)
      .allowsHitTesting(false)
    }
  }
}

/// Back-to-hub control: a small chevron and the project's icon, or the ADE mark
/// when the project has none. Same action as `ADEHubBackButton`, without the
/// capsule so it sits flat in the one-row header.
private struct WorkHeaderProjectButton: View {
  let iconDataUrl: String?
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 3) {
        Image(systemName: "chevron.left")
          .font(.system(size: 13, weight: .bold))
          .foregroundStyle(ADEColor.accent)
        if let icon = projectIconImage(from: iconDataUrl) {
          Image(uiImage: icon).projectIconStyle(size: 26, cornerRadius: 7)
        } else {
          Image("BrandMark")
            .resizable()
            .interpolation(.high)
            .aspectRatio(contentMode: .fit)
            .frame(width: 38, height: 26)
        }
      }
      .frame(minHeight: 44)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Back to all projects")
    .accessibilityHint("Returns to the project hub.")
  }
}

/// Search that takes the header's remaining width, with the filter control as a
/// chip inside its trailing edge. The chip turns accent while the panel is open
/// or a lane/status filter is applied, and shows how many are applied.
private struct WorkHeaderSearchField: View {
  @Binding var searchText: String
  @Binding var filterOpen: Bool
  let activeFilterCount: Int

  private var chipActive: Bool { filterOpen || activeFilterCount > 0 }

  var body: some View {
    HStack(spacing: 6) {
      Image(systemName: "magnifyingglass")
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(ADEColor.textMuted)
        .accessibilityHidden(true)
      TextField("Search", text: $searchText)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .font(.subheadline)
        .submitLabel(.search)
        .accessibilityLabel("Search sessions, lanes, output")
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
      Button {
        withAnimation(.snappy(duration: 0.2)) {
          filterOpen.toggle()
        }
      } label: {
        HStack(spacing: 3) {
          Image(systemName: "line.3.horizontal.decrease")
            .font(.system(size: 11, weight: .bold))
          if activeFilterCount > 0 {
            Text("\(activeFilterCount)")
              .font(.caption2.monospacedDigit().weight(.bold))
          }
        }
        .foregroundStyle(chipActive ? ADEColor.accent : ADEColor.textSecondary)
        .padding(.horizontal, 8)
        .frame(height: 24)
        .background(
          chipActive ? ADEColor.accent.opacity(0.14) : ADEColor.recessedBackground,
          in: Capsule(style: .continuous)
        )
        .frame(minWidth: 36, minHeight: 40)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Filters")
      .accessibilityValue(activeFilterCount > 0 ? "\(activeFilterCount) applied" : (filterOpen ? "Open" : "None"))
      .accessibilityHint(filterOpen ? "Hides the filter panel" : "Shows status, group and lane filters")
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

/// The "⋯" menu: Activity, Linear, Cursor Cloud, Settings. A plain icon with a
/// warning dot while the Activity drawer has unread needs-you items — the same
/// `unreadCount` the bell used — so moving the bell in here loses no signal.
///
/// The only observer in the header, and of `ActivityDrawerModel` alone.
private struct WorkHeaderOverflowMenu: View {
  @EnvironmentObject private var drawer: ActivityDrawerModel
  let showsLinear: Bool
  let showsCursorCloud: Bool
  let actions: WorkRootHeaderActions

  private var unread: Int { drawer.unreadCount }

  var body: some View {
    Menu {
      Button {
        ADEHaptics.light()
        actions.onOpenActivity()
      } label: {
        Label(
          unread > 0 ? "Activity · \(unread) need\(unread == 1 ? "s" : "") you" : "Activity",
          systemImage: unread > 0 ? "bell.badge" : "bell"
        )
      }
      if showsLinear {
        Button {
          ADEHaptics.light()
          actions.onOpenLinear()
        } label: {
          Label { Text("Linear") } icon: { Image("LinearLogo") }
        }
      }
      if showsCursorCloud {
        Button {
          ADEHaptics.light()
          actions.onOpenCursorCloud()
        } label: {
          Label { Text("Cursor Cloud") } icon: { Image("CursorCloudLogo") }
        }
      }
      Divider()
      Button(action: actions.onOpenSettings) {
        Label("Settings", systemImage: "gearshape")
      }
    } label: {
      Image(systemName: "ellipsis")
        .font(.system(size: 18, weight: .semibold))
        .foregroundStyle(ADEColor.textPrimary)
        .frame(width: 32, height: 44)
        .overlay(alignment: .topTrailing) {
          if unread > 0 {
            Circle()
              .fill(ADEColor.warning)
              .frame(width: 8, height: 8)
              .overlay(Circle().stroke(ADEColor.pageBackground, lineWidth: 1.5))
              .offset(x: -2, y: 10)
              .transition(.scale.combined(with: .opacity))
          }
        }
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .animation(.snappy(duration: 0.2), value: unread > 0)
    .accessibilityLabel(unread > 0 ? "More, \(unread) activity \(unread == 1 ? "item needs" : "items need") you" : "More")
    .accessibilityHint("Activity, Linear, Cursor Cloud and Settings")
  }
}

/// A lane's rolled-up status as one dot in the board column's accent — the same
/// accents as the status chips (`statusFilterTint`) and the desktop board.
/// Marks a lane that lives on another machine, after its name: two machines'
/// lanes can share a name, and the machine never goes in the title.
struct WorkRemoteLaneGlyph: View {
  var body: some View {
    Image(systemName: "desktopcomputer")
      .font(.system(size: 9, weight: .medium))
      .foregroundStyle(ADEColor.textMuted.opacity(0.8))
      .accessibilityLabel("On another machine")
  }
}

struct WorkLaneFocusDot: View {
  let status: WorkLaneFocusStatus

  var body: some View {
    ADEKitDot(color: color)
  }

  private var color: Color {
    switch status {
    case .needsYou: return ADEColor.warning
    case .working: return ADEColor.info
    case .waiting: return ADEColor.textMuted
    case .done: return ADEColor.success
    }
  }
}
