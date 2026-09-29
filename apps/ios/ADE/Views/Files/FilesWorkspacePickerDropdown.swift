import SwiftUI

/// Desktop-shaped workspace picker for the Files tab. Mirrors the Work tab lane
/// dropdown styling without the auto-create lane row.
struct FilesWorkspacePickerDropdown: View {
  let workspaces: [FilesWorkspace]
  let lanes: [LaneSummary]
  @Binding var selectedWorkspaceId: String

  @State private var menuPresented = false
  @State private var searchQuery = ""

  private var selectedWorkspace: FilesWorkspace? {
    workspaces.first(where: { $0.id == selectedWorkspaceId })
  }

  private var filteredWorkspaces: [FilesWorkspace] {
    let trimmed = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !trimmed.isEmpty else { return workspaces }
    return workspaces.filter { workspace in
      workspace.name.lowercased().contains(trimmed)
        || filesWorkspaceSubtitle(workspace).lowercased().contains(trimmed)
        || workspace.rootPath.lowercased().contains(trimmed)
    }
  }

  var body: some View {
    Button {
      menuPresented = true
    } label: {
      triggerLabel
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Select workspace")
    .accessibilityValue(selectedWorkspace?.name ?? "No workspace selected")
    // A sheet, not a popover: a popover is squeezed into whatever space is
    // left and cut the list to a few tiny rows.
    .sheet(isPresented: $menuPresented) {
      FilesWorkspacePickerSheet(
        workspaces: filteredWorkspaces,
        allWorkspacesEmpty: workspaces.isEmpty,
        lanes: lanes,
        selectedWorkspaceId: selectedWorkspaceId,
        searchQuery: $searchQuery,
        onSelect: { workspaceId in
          selectedWorkspaceId = workspaceId
          menuPresented = false
          searchQuery = ""
        }
      )
      .presentationDetents([.medium, .large])
      .presentationDragIndicator(.visible)
    }
    .onChange(of: menuPresented) { _, isOpen in
      if !isOpen { searchQuery = "" }
    }
  }

  private var triggerLabel: some View {
    let workspace = selectedWorkspace
    let lane = workspace.flatMap { filesWorkspaceLaneSummary($0, lanes: lanes) }
    let surface = filesWorkspaceTriggerSurface(workspace: workspace, lane: lane)
    let isCompact = workspace != nil

    return ZStack {
      centeredTriggerContent(workspace: workspace, lane: lane)
        .padding(.horizontal, 28)
      HStack(spacing: 0) {
        Spacer(minLength: 0)
        Image(systemName: "chevron.up.chevron.down")
          .font(.system(size: 10, weight: .bold))
          .foregroundStyle(ADEColor.textMuted.opacity(0.6))
      }
    }
    .padding(.horizontal, isCompact ? 12 : 14)
    .padding(.vertical, isCompact ? 5 : 6)
    .background(surface.background, in: Capsule(style: .continuous))
    .overlay(
      Capsule(style: .continuous)
        .stroke(surface.border, lineWidth: 1)
    )
    .frame(maxWidth: .infinity)
  }

  @ViewBuilder
  private func centeredTriggerContent(workspace: FilesWorkspace?, lane: LaneSummary?) -> some View {
    let title = workspace?.name ?? "Select workspace..."
    let subtitle = workspace.map(filesWorkspaceSubtitle) ?? ""

    if !subtitle.isEmpty {
      VStack(spacing: 2) {
        HStack(spacing: 5) {
          if let lane {
            WorkLaneLogoMark(
              color: LaneColorPalette.displayColor(forHex: lane.color, fallback: ADEColor.textSecondary),
              laneIcon: lane.icon,
              size: 11
            )
          } else if workspace?.kind.lowercased() == "primary" {
            Image(systemName: "house.fill")
              .font(.system(size: 10, weight: .bold))
              .foregroundStyle(ADEColor.accent)
          }
          Text(title)
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
        }
        HStack(spacing: 4) {
          Image(systemName: "arrow.branch")
            .font(.system(size: 9, weight: .regular))
            .foregroundStyle(ADEColor.textMuted.opacity(0.55))
          Text(subtitle)
            .font(.system(size: 11.5))
            .foregroundStyle(ADEColor.textMuted.opacity(0.92))
            .lineLimit(1)
        }
      }
      .multilineTextAlignment(.center)
    } else {
      HStack(spacing: 5) {
        Text(title)
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
      }
    }
  }
}

func filesWorkspaceSubtitle(_ workspace: FilesWorkspace) -> String {
  let base = filesWorkspaceBranchLabel(workspace)
  guard let machine = workspace.machineName else { return base }
  return "\(base) · \(machine)"
}

private func filesWorkspaceBranchLabel(_ workspace: FilesWorkspace) -> String {
  if let branchRef = workspace.branchRef?.trimmingCharacters(in: .whitespacesAndNewlines), !branchRef.isEmpty {
    return normalizedPrBranchName(branchRef)
  }
  if workspace.kind.lowercased() == "primary" {
    return "primary"
  }
  let leaf = (workspace.rootPath as NSString).lastPathComponent
  return leaf.isEmpty ? workspace.kind : leaf
}

func filesWorkspaceLaneSummary(_ workspace: FilesWorkspace, lanes: [LaneSummary]) -> LaneSummary? {
  guard let laneId = workspace.laneId else { return nil }
  return lanes.first(where: { $0.id == laneId })
}

private func filesWorkspaceTriggerSurface(workspace: FilesWorkspace?, lane: LaneSummary?) -> (background: Color, border: Color) {
  if let lane, let hex = lane.color?.trimmingCharacters(in: .whitespacesAndNewlines), !hex.isEmpty,
     let tint = LaneColorPalette.color(forHex: hex) {
    return (tint.opacity(0.12), tint.opacity(0.35))
  }
  if workspace?.kind.lowercased() == "primary" {
    return (ADEColor.accent.opacity(0.08), ADEColor.accent.opacity(0.28))
  }
  return (Color.white.opacity(0.04), Color.white.opacity(0.08))
}

/// The workspace list as a sheet on the flat base: searchable, grouped by
/// machine (this machine first), rows at normal size.
private struct FilesWorkspacePickerSheet: View {
  let workspaces: [FilesWorkspace]
  let allWorkspacesEmpty: Bool
  let lanes: [LaneSummary]
  let selectedWorkspaceId: String
  @Binding var searchQuery: String
  let onSelect: (String) -> Void

  /// Workspaces grouped by machine: this machine first, then each other
  /// machine by name. Keyed by machine key, so two machines with one name stay
  /// apart.
  private var groups: [(id: String, title: String, items: [FilesWorkspace])] {
    var local: [FilesWorkspace] = []
    var remote: [String: (name: String, items: [FilesWorkspace])] = [:]
    for workspace in workspaces {
      guard let key = workParseRemoteLaneId(workspace.id)?.machineKey else {
        local.append(workspace)
        continue
      }
      remote[key, default: (workspace.machineName ?? "Other machine", [])].items.append(workspace)
    }
    var result: [(id: String, title: String, items: [FilesWorkspace])] = []
    if !local.isEmpty {
      result.append(("local", remote.isEmpty ? "Workspaces" : "This machine", local))
    }
    for (key, entry) in remote.sorted(by: { $0.value.name.localizedCaseInsensitiveCompare($1.value.name) == .orderedAscending }) {
      result.append((key, entry.name, entry.items))
    }
    return result
  }

  var body: some View {
    NavigationStack {
      List {
        if workspaces.isEmpty {
          Text(allWorkspacesEmpty ? "No workspaces available" : "No workspaces found")
            .font(.footnote)
            .foregroundStyle(ADEColor.textSecondary)
            .adeFlatRow()
        }
        ForEach(groups, id: \.id) { group in
          Section {
            ForEach(group.items) { workspace in
              row(workspace)
            }
          } header: {
            ADEFlatSectionHeader(group.title, detail: "\(group.items.count)")
          }
        }
      }
      .adeFlatList()
      .searchable(text: $searchQuery, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search workspaces")
      .navigationTitle("Workspace")
      .navigationBarTitleDisplayMode(.inline)
    }
  }

  private func row(_ workspace: FilesWorkspace) -> some View {
    let isSelected = workspace.id == selectedWorkspaceId
    // The section header names the machine.
    let subtitle = filesWorkspaceBranchLabel(workspace)
    let lane = filesWorkspaceLaneSummary(workspace, lanes: lanes)
    return Button {
      onSelect(workspace.id)
    } label: {
      HStack(spacing: 12) {
        if let lane {
          WorkLaneLogoMark(
            color: LaneColorPalette.displayColor(forHex: lane.color, fallback: ADEColor.textSecondary),
            laneIcon: lane.icon,
            size: 14
          )
          .frame(width: 22)
        } else {
          Image(systemName: workspace.kind.lowercased() == "primary" ? "house.fill" : "folder")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(ADEColor.accent)
            .frame(width: 22)
        }
        VStack(alignment: .leading, spacing: 2) {
          Text(workspace.name)
            .font(.body.weight(isSelected ? .semibold : .regular))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
          if !subtitle.isEmpty {
            Text(subtitle)
              .font(.adeMono(11.5))
              .foregroundStyle(ADEColor.textMuted)
              .lineLimit(1)
              .truncationMode(.middle)
          }
        }
        Spacer(minLength: 8)
        if isSelected {
          Image(systemName: "checkmark")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(ADEColor.accent)
        }
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .adeFlatRow()
  }
}

#if DEBUG
/// `-adePreviewScreen files-picker`: the workspace sheet with lanes on two machines.
struct FilesWorkspacePickerPreviewHost: View {
  @State private var query = ""
  private static let workspaces: [FilesWorkspace] = [
    FilesWorkspace(id: "s-main", kind: "primary", laneId: "s-main", name: "Primary", branchRef: "main", rootPath: "/Users/a/ADE", isReadOnlyByDefault: false),
    FilesWorkspace(id: "s-sync", kind: "worktree", laneId: "s-sync", name: "fix sync loop", branchRef: "ade/fix-sync-loop-2f81", rootPath: "/Users/a/ADE/.ade/worktrees/fix", isReadOnlyByDefault: false),
    FilesWorkspace(id: workRemoteLaneId(machineKey: "mbp", laneId: "m-main"), kind: "primary", laneId: nil, name: "Primary", branchRef: "main", rootPath: "/Users/b/ADE", isReadOnlyByDefault: false, machineName: "MacBook Pro (97)"),
    FilesWorkspace(id: workRemoteLaneId(machineKey: "mbp", laneId: "m-p4"), kind: "worktree", laneId: nil, name: "phase 4 lanes", branchRef: "ade/mobile-multi-machine-phase-4", rootPath: "/Users/b/ADE/.ade/worktrees/p4", isReadOnlyByDefault: false, machineName: "MacBook Pro (97)"),
  ]

  var body: some View {
    Color.clear.sheet(isPresented: .constant(true)) {
      FilesWorkspacePickerSheet(
        workspaces: Self.workspaces,
        allWorkspacesEmpty: false,
        lanes: [],
        selectedWorkspaceId: "s-sync",
        searchQuery: $query,
        onSelect: { _ in }
      )
      .presentationDetents([.large])
    }
  }
}
#endif
