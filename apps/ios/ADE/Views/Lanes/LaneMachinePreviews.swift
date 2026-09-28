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

/// `-adePreviewScreen settings-machines`: the connected-machines card and the
/// MACHINES rows, from fixtures.
struct SettingsMachinesPreviewHost: View {
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        VStack(alignment: .leading, spacing: 14) {
          HStack(spacing: 12) {
            Circle().fill(ADEColor.purpleAccent).frame(width: 14, height: 14)
            VStack(alignment: .leading, spacing: 4) {
              Text("Connected").font(.system(.body, design: .rounded).weight(.semibold))
              Text("2 machines").font(.caption).foregroundStyle(ADEColor.textSecondary)
            }
            Spacer()
          }
          SettingsConnectedMachineList(
            focusedName: "MacBook Pro (97)",
            focusedDetail: "via LAN",
            liveMachines: [
              MachineFleet.Machine(
                machineKey: "studio",
                name: "Arul’s Mac Studio",
                state: .live,
                projects: [],
                rosterRevision: 1,
                lastUpdateAt: nil,
                isPinned: false
              ),
            ]
          )
        }
        .padding(18)
        MachineRowView(
          deviceSymbol: "laptopcomputer",
          title: "MacBook Pro (97) · ADE",
          routeHint: "76% battery",
          online: true,
          isAuthenticatedCurrent: true,
          statusPill: .connected,
          affordance: .connected
        )
        MachineRowView(
          deviceSymbol: "desktopcomputer",
          title: "Arul’s Mac Studio · ADE",
          routeHint: "Live · plugged in",
          online: true,
          isAuthenticatedCurrent: true,
          statusPill: .connected,
          affordance: .connected
        )
        MachineRowView(
          deviceSymbol: "desktopcomputer",
          title: "arul · ADE",
          routeHint: "Connecting…",
          online: false,
          affordance: .connect
        )
      }
      .padding(16)
    }
    .adeScreenBackground()
  }
}
#endif
