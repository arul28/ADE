#if DEBUG
import SwiftUI

/// `-adePreviewScreen lanes-machines`: the Lanes list across two machines
/// (top bar button, machine filter chips, lane rows with chips, a machine
/// that is not live), from fixtures, with no pairing.
struct LanesAcrossMachinesPreviewHost: View {
  @State private var filter: LaneMachineFilter = .all

  private static func lane(
    _ id: String,
    _ name: String,
    type: String = "worktree",
    branch: String,
    color: String?,
    parent: String? = nil,
    depth: Int = 0,
    children: Int = 0,
    status: LaneStatus = LaneStatus(dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false)
  ) -> LaneSummary {
    LaneSummary(
      id: id,
      name: name,
      description: nil,
      laneType: type,
      baseRef: "main",
      branchRef: branch,
      worktreePath: "/tmp/\(id)",
      attachedRootPath: nil,
      parentLaneId: parent,
      childCount: children,
      stackDepth: depth,
      parentStatus: nil,
      isEditProtected: false,
      status: status,
      color: color,
      icon: nil,
      tags: [],
      folder: nil,
      createdAt: "2026-09-28T12:00:00Z",
      archivedAt: nil,
      devicesOpen: nil
    )
  }

  private static func snapshot(_ lane: LaneSummary, running: Int = 0, awaiting: Int = 0) -> LaneListSnapshot {
    LaneListSnapshot(
      lane: lane,
      runtime: LaneRuntimeSummary(
        bucket: running > 0 ? "running" : "none",
        runningCount: running,
        awaitingInputCount: awaiting,
        endedCount: 0,
        sessionCount: running + awaiting
      )
    )
  }

  private let studio: [LaneListSnapshot] = [
    snapshot(lane("s-main", "Primary", type: "primary", branch: "main", color: "#3B82F6", children: 2), running: 1),
    snapshot(lane("s-sync", "fix sync loop", branch: "ade/fix-sync-loop-2f81", color: "#A855F7", parent: "s-main", depth: 1,
                  status: LaneStatus(dirty: true, ahead: 3, behind: 1, remoteBehind: 0, rebaseInProgress: false)), awaiting: 1),
    snapshot(lane("s-docs", "docs refresh", branch: "ade/docs-refresh-91aa", color: "#22C55E", parent: "s-main", depth: 1)),
  ]

  private var macbook: [LaneListSnapshot] {
    [
      Self.snapshot(Self.lane(workRemoteLaneId(machineKey: "mbp", laneId: "m-main"), "Primary", type: "primary", branch: "main", color: "#3B82F6")),
      Self.snapshot(Self.lane(workRemoteLaneId(machineKey: "mbp", laneId: "m-p4"), "phase 4 lanes", branch: "ade/mobile-multi-machine-phase-4", color: "#F97316",
                              status: LaneStatus(dirty: false, ahead: 2, behind: 0, remoteBehind: 0, rebaseInProgress: false)), running: 2),
    ]
  }

  private var windows: [LaneListSnapshot] {
    [Self.snapshot(Self.lane(workRemoteLaneId(machineKey: "pc", laneId: "w-drain"), "windows drain", branch: "ade/windows-drain", color: "#EF4444"))]
  }

  private var chips: LaneMachineChips {
    LaneMachineChips(
      focused: LaneMachineChip(name: "Arul’s Mac Studio", isLive: true),
      byMachineKey: [
        "mbp": LaneMachineChip(name: "MacBook Pro (97)", isLive: true),
        "pc": LaneMachineChip(name: "arul", isLive: false),
      ]
    )
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: 14) {
          ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 7) {
              LaneMachineFilterChip(title: "All", symbol: "square.stack.3d.up", liveDot: nil, selected: filter == .all) { filter = .all }
              LaneMachineFilterChip(title: "Arul’s Mac Studio", symbol: "desktopcomputer", liveDot: true, selected: filter == .focused) { filter = .focused }
              LaneMachineFilterChip(title: "MacBook Pro (97)", symbol: "laptopcomputer", liveDot: true, selected: filter == .machine("mbp")) { filter = .machine("mbp") }
              LaneMachineFilterChip(title: "arul", symbol: "desktopcomputer", liveDot: false, selected: filter == .machine("pc")) { filter = .machine("pc") }
            }
            .padding(.horizontal, 2)
          }
          .scrollClipDisabled()
          VStack(spacing: 10) {
            Text("LANES")
              .font(.caption.weight(.semibold))
              .tracking(0.6)
              .foregroundStyle(ADEColor.textMuted)
              .frame(maxWidth: .infinity, alignment: .leading)
            ForEach([studio, macbook, windows], id: \.first?.id) { group in
              LaneTreeView(
                snapshots: group,
                pinnedLaneIds: [],
                openLaneIds: ["s-sync"],
                allLaneSnapshots: group,
                lanePrTagsByLaneId: [:],
                transitionNamespace: nil,
                selectedLaneId: nil,
                onRefreshRoot: {},
                onContextMenu: { _ in AnyView(EmptyView()) },
                onTogglePin: { _ in },
                onSelectLane: { _ in },
                machineChips: chips
              )
            }
          }
        }
        .padding(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
      }
      .adeScreenBackground()
      .toolbar(.hidden, for: .navigationBar)
      .safeAreaInset(edge: .top, spacing: 0) {
        ADERootTopBar(title: "Lanes", showsGlobalControls: false) {
          LaneAddButton(enabled: true) {}
        }
      }
    }
  }
}

/// `-adePreviewScreen settings-machines`: Settings with the Connected and
/// Available machine sections, from fixtures. `settings-machine-page` opens the
/// MacBook's machine page.
struct SettingsMachinesPreviewHost: View {
  var showsPage = false

  static let machines: [SettingsMachine] = [
    SettingsMachine(
      id: "studio", name: "Arul’s Mac Studio · ADE", symbol: "desktopcomputer", machineKey: "machine:studio",
      account: nil, link: .primary(live: true, connecting: false), online: true, isAsleep: false, lastSeenAt: nil,
      hiddenIdentity: "studio", detail: "Local network · plugged in",
      projects: [
        RemoteRosterProject(projectId: "ade", displayName: "ADE", booted: true, runningCount: 2, attentionCount: 0, lanes: [], chats: []),
      ]
    ),
    SettingsMachine(
      id: "mbp", name: "MacBook Pro (97) · ADE", symbol: "laptopcomputer", machineKey: "machine:mbp",
      account: nil, link: .connected(.live, gaveUp: false), online: true, isAsleep: false, lastSeenAt: nil,
      hiddenIdentity: "mbp", detail: "Local network · 11% battery",
      projects: [
        RemoteRosterProject(projectId: "ade", displayName: "ADE", booted: true, runningCount: 1, attentionCount: 0, lanes: [], chats: []),
        RemoteRosterProject(projectId: "versic", displayName: "Versic", booted: true, runningCount: 0, attentionCount: 0, lanes: [], chats: []),
      ]
    ),
    SettingsMachine(
      id: "alpha", name: "arul · ADE Alpha", symbol: "desktopcomputer", machineKey: "machine:alpha",
      account: nil, link: .connected(.offline(message: nil), gaveUp: true), online: false, isAsleep: false,
      lastSeenAt: Date().addingTimeInterval(-6 * 3600), hiddenIdentity: "alpha", detail: nil, projects: []
    ),
    SettingsMachine(
      id: "macpoop", name: "Macpoop · ADE Alpha", symbol: "laptopcomputer", machineKey: nil,
      account: nil, link: .available, online: true, isAsleep: false, lastSeenAt: nil,
      hiddenIdentity: "macpoop", detail: "82% battery", projects: []
    ),
    SettingsMachine(
      id: "windows", name: "windows · ADE", symbol: "desktopcomputer", machineKey: nil,
      account: nil, link: .available, online: false, isAsleep: false,
      lastSeenAt: Date().addingTimeInterval(-19 * 3600), hiddenIdentity: "windows", detail: nil, projects: []
    ),
  ]

  var body: some View {
    NavigationStack {
      if showsPage {
        SettingsMachinePageContent(machine: Self.machines[1], actions: SettingsMachinePageActions(rename: {}, removeFromAccount: {}))
          .navigationTitle("")
          .navigationBarTitleDisplayMode(.inline)
      } else {
        let sections = settingsMachineSections(Self.machines)
        List {
          Section {
            HStack(spacing: 12) {
              Circle().fill(ADEColor.purpleAccent.opacity(0.3)).frame(width: 44, height: 44)
                .overlay(Text("AS").font(.system(size: 16, weight: .bold, design: .rounded)).foregroundStyle(ADEColor.purpleAccent))
              VStack(alignment: .leading, spacing: 2) {
                Text("Arul Sharma").font(.body.weight(.semibold))
                Text("arulsharma90@gmail.com").font(.caption).foregroundStyle(ADEColor.textSecondary)
              }
              Spacer()
              Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(ADEColor.textMuted)
            }
            .adeFlatRow()
          }
          Section {
            ForEach(sections.connected) { SettingsMachineRow(machine: $0).adeFlatRow() }
          } header: {
            ADEFlatSectionHeader("Connected", detail: "2 of 4 live") {
              Image(systemName: "plus").font(.system(size: 13, weight: .semibold)).foregroundStyle(ADEColor.accent)
            }
          }
          Section {
            ForEach(sections.available) { SettingsMachineRow(machine: $0).adeFlatRow() }
          } header: {
            ADEFlatSectionHeader("Available")
          }
          Section {
            Label("Appearance", systemImage: "circle.lefthalf.filled").adeFlatRow()
            Label("Notifications", systemImage: "bell.badge").adeFlatRow()
            Label("Usage", systemImage: "chart.line.uptrend.xyaxis").adeFlatRow()
          } header: {
            ADEFlatSectionHeader("App")
          }
        }
        .adeFlatList()
        .navigationTitle("Settings")
      }
    }
  }
}
#endif
