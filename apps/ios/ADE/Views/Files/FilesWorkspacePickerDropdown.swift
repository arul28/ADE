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
    .popover(isPresented: $menuPresented, attachmentAnchor: .rect(.bounds), arrowEdge: .bottom) {
      FilesWorkspacePickerMenu(
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
      .frame(width: 300)
      .presentationCompactAdaptation(.popover)
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
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(Color.white.opacity(0.85))
            .lineLimit(1)
        }
        HStack(spacing: 4) {
          Image(systemName: "arrow.branch")
            .font(.system(size: 9, weight: .regular))
            .foregroundStyle(ADEColor.textMuted.opacity(0.55))
          Text(subtitle)
            .font(.system(size: 10))
            .foregroundStyle(ADEColor.textMuted.opacity(0.92))
            .lineLimit(1)
        }
      }
      .multilineTextAlignment(.center)
    } else {
      HStack(spacing: 5) {
        Text(title)
          .font(.system(size: 11, weight: .medium))
          .foregroundStyle(Color.white.opacity(0.7))
          .lineLimit(1)
      }
    }
  }
}

private struct FilesWorkspacePickerMenu: View {
  let workspaces: [FilesWorkspace]
  let allWorkspacesEmpty: Bool
  let lanes: [LaneSummary]
  let selectedWorkspaceId: String
  @Binding var searchQuery: String
  let onSelect: (String) -> Void

  @FocusState private var searchFocused: Bool

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 6) {
        Image(systemName: "magnifyingglass")
          .font(.system(size: 12, weight: .regular))
          .foregroundStyle(ADEColor.textMuted.opacity(0.5))
        TextField("Search workspaces...", text: $searchQuery)
          .textFieldStyle(.plain)
          .font(.system(size: 11))
          .foregroundStyle(ADEColor.textPrimary)
          .focused($searchFocused)
          .submitLabel(.done)
      }
      .padding(.horizontal, 10)
      .frame(height: 32)
      .overlay(alignment: .bottom) {
        Rectangle()
          .fill(ADEColor.border.opacity(0.35))
          .frame(height: 0.5)
      }

      ScrollView {
        LazyVStack(spacing: 0) {
          if workspaces.isEmpty {
            Text(allWorkspacesEmpty ? "No workspaces available" : "No workspaces found")
              .font(.system(size: 11))
              .foregroundStyle(ADEColor.textMuted)
              .frame(maxWidth: .infinity)
              .padding(.vertical, 12)
          } else {
            ForEach(workspaces) { workspace in
              workspaceRow(workspace)
            }
          }
        }
        .padding(4)
      }
      .frame(maxHeight: 280)
    }
    .background(ADEColor.cardBackground.opacity(0.96))
    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .stroke(ADEColor.glassBorder, lineWidth: 0.8)
    )
    .shadow(color: Color.black.opacity(0.45), radius: 16, y: 8)
    .onAppear {
      searchFocused = true
    }
  }

  private func workspaceRow(_ workspace: FilesWorkspace) -> some View {
    let isSelected = workspace.id == selectedWorkspaceId
    let subtitle = filesWorkspaceSubtitle(workspace)
    let lane = filesWorkspaceLaneSummary(workspace, lanes: lanes)
    let laneColor = lane.map { LaneColorPalette.displayColor(forHex: $0.color, fallback: ADEColor.textSecondary) }

    return Button {
      onSelect(workspace.id)
    } label: {
      VStack(alignment: .leading, spacing: subtitle.isEmpty ? 0 : 3) {
        HStack(spacing: 6) {
          if let laneColor {
            WorkLaneLogoMark(color: laneColor, laneIcon: lane?.icon, size: 12)
          } else if workspace.kind.lowercased() == "primary" {
            Image(systemName: "house.fill")
              .font(.system(size: 11, weight: .bold))
              .foregroundStyle(ADEColor.accent)
          }
          Text(workspace.name)
            .font(.system(size: 11, weight: isSelected ? .medium : .regular))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
            .frame(maxWidth: .infinity, alignment: .leading)
          if isSelected {
            Image(systemName: "checkmark")
              .font(.system(size: 12, weight: .bold))
              .foregroundStyle(ADEColor.accent)
          }
        }
        if !subtitle.isEmpty {
          HStack(spacing: 4) {
            Image(systemName: "arrow.branch")
              .font(.system(size: 10, weight: .regular))
              .foregroundStyle(ADEColor.textMuted.opacity(0.6))
            Text(subtitle)
              .font(.system(size: 10))
              .foregroundStyle(ADEColor.textMuted.opacity(0.92))
              .lineLimit(1)
          }
          .padding(.leading, laneColor == nil && workspace.kind.lowercased() != "primary" ? 0 : 18)
        }
      }
      .padding(.horizontal, 8)
      .padding(.vertical, subtitle.isEmpty ? 6 : 5)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(
        isSelected ? ADEColor.accent.opacity(0.12) : Color.clear,
        in: RoundedRectangle(cornerRadius: 6, style: .continuous)
      )
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }
}

func filesWorkspaceSubtitle(_ workspace: FilesWorkspace) -> String {
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
