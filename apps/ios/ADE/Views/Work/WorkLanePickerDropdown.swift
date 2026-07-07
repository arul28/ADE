import SwiftUI

/// Synthetic lane id for the draft-composer "Auto-create lane" row. Matches desktop
/// `AUTO_CREATE_LANE_OPTION_ID`.
let workAutoCreateLaneSentinelId = "__ade_auto_create_lane__"

/// Desktop-shaped lane picker for the new-chat welcome screen. Mirrors
/// `apps/desktop/src/renderer/components/terminals/LaneCombobox.tsx`: a pill
/// trigger showing lane name + branch, and a searchable dropdown with an
/// auto-create row plus color-coded lane rows.
struct WorkLanePickerDropdown: View {
  let lanes: [LaneSummary]
  @Binding var selectedLaneId: String
  var showsAutoCreateOption: Bool = true
  var emptySelectionTitle: String = "Select lane..."
  var laneSubtitle: ((LaneSummary) -> String?)? = nil
  var isLaneDisabled: ((LaneSummary) -> Bool)? = nil
  var onRefresh: (@MainActor () async -> Void)? = nil

  @State private var menuPresented = false
  @State private var searchQuery = ""

  private var isAutoCreateSelected: Bool {
    selectedLaneId == workAutoCreateLaneSentinelId
  }

  private var selectedLane: LaneSummary? {
    lanes.first(where: { $0.id == selectedLaneId })
  }

  private var triggerTitle: String {
    if isAutoCreateSelected { return "Auto-create lane" }
    return selectedLane?.name ?? emptySelectionTitle
  }

  private var triggerBranchLabel: String? {
    guard !isAutoCreateSelected, let lane = selectedLane else { return nil }
    let label = normalizedPrBranchName(lane.branchRef)
    return label.isEmpty ? nil : label
  }

  private var triggerLaneColor: Color? {
    guard !isAutoCreateSelected, let lane = selectedLane else { return nil }
    return LaneColorPalette.displayColor(forHex: lane.color, fallback: ADEColor.textSecondary)
  }

  private var filteredLanes: [LaneSummary] {
    let trimmed = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !trimmed.isEmpty else { return lanes }
    return lanes.filter { lane in
      lane.name.lowercased().contains(trimmed)
        || normalizedPrBranchName(lane.branchRef).lowercased().contains(trimmed)
    }
  }

  var body: some View {
    HStack(spacing: 8) {
      Button {
        menuPresented = true
      } label: {
        triggerLabel
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Select lane")
      .accessibilityValue(triggerTitle)
      .popover(isPresented: $menuPresented, attachmentAnchor: .rect(.bounds), arrowEdge: .bottom) {
        WorkLanePickerMenu(
          lanes: filteredLanes,
          allLanesEmpty: lanes.isEmpty,
          selectedLaneId: selectedLaneId,
          showsAutoCreateOption: showsAutoCreateOption,
          laneSubtitle: laneSubtitle,
          isLaneDisabled: isLaneDisabled,
          searchQuery: $searchQuery,
          onSelect: { laneId in
            selectedLaneId = laneId
            menuPresented = false
            searchQuery = ""
          }
        )
        .frame(width: 280)
        .presentationCompactAdaptation(.popover)
      }
      .onChange(of: menuPresented) { _, isOpen in
        if !isOpen { searchQuery = "" }
      }

      if let onRefresh {
        Button {
          Task { await onRefresh() }
        } label: {
          Image(systemName: "arrow.clockwise")
            .font(.caption.weight(.semibold))
            .foregroundStyle(ADEColor.accent)
            .frame(width: 34, height: 34)
            .background(ADEColor.surfaceBackground.opacity(0.55), in: Circle())
            .glassEffect()
            .overlay(Circle().stroke(ADEColor.accent.opacity(0.26), lineWidth: 0.6))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Refresh lanes")
        .accessibilityHint("Reloads the lane list from your paired desktop.")
      }
    }
  }

  private var triggerLabel: some View {
    let surface = laneTriggerSurface(for: selectedLane, isAutoCreate: isAutoCreateSelected)
    return ZStack {
      centeredTriggerContent
        .padding(.horizontal, 26)
      HStack(spacing: 0) {
        Spacer(minLength: 0)
        Image(systemName: "chevron.up.chevron.down")
          .font(.system(size: 10, weight: .bold))
          .foregroundStyle(ADEColor.textMuted.opacity(0.6))
          .padding(.trailing, 10)
      }
    }
    .padding(.leading, 14)
    .padding(.trailing, 4)
    .padding(.vertical, triggerBranchLabel == nil ? 10 : 9)
    .background(surface.background, in: Capsule(style: .continuous))
    .overlay(
      Capsule(style: .continuous)
        .stroke(surface.border, lineWidth: 1)
    )
    .frame(minWidth: 180, maxWidth: 320)
  }

  @ViewBuilder
  private var centeredTriggerContent: some View {
    if let branch = triggerBranchLabel {
      VStack(spacing: 2) {
        triggerTitleRow
        HStack(spacing: 4) {
          Image(systemName: "arrow.branch")
            .font(.system(size: 10, weight: .regular))
            .foregroundStyle(ADEColor.textMuted.opacity(0.55))
          Text(branch)
            .font(.system(size: 11))
            .foregroundStyle(ADEColor.textMuted.opacity(0.92))
            .lineLimit(1)
        }
      }
      .multilineTextAlignment(.center)
      .frame(maxWidth: .infinity, alignment: .center)
    } else {
      triggerTitleRow
        .frame(maxWidth: .infinity, alignment: .center)
    }
  }

  @ViewBuilder
  private var triggerTitleRow: some View {
    HStack(spacing: 6) {
      if let triggerLaneColor, !isAutoCreateSelected {
        WorkLaneLogoMark(color: triggerLaneColor, laneIcon: selectedLane?.icon, size: 13)
      } else if isAutoCreateSelected {
        Image(systemName: "sparkles")
          .font(.system(size: 13, weight: .bold))
          .foregroundStyle(ADEColor.accent)
      }
      Text(triggerTitle)
        .font(.system(size: 14, weight: .semibold))
        .foregroundStyle(Color.white.opacity(0.9))
        .lineLimit(1)
    }
  }

  private func laneTriggerSurface(for lane: LaneSummary?, isAutoCreate: Bool) -> (background: Color, border: Color) {
    if isAutoCreate {
      return (ADEColor.accent.opacity(0.06), ADEColor.accent.opacity(0.3))
    }
    guard let lane, let hex = lane.color?.trimmingCharacters(in: .whitespacesAndNewlines), !hex.isEmpty,
          let tint = LaneColorPalette.color(forHex: hex) else {
      return (Color.white.opacity(0.04), Color.white.opacity(0.08))
    }
    return (tint.opacity(0.12), tint.opacity(0.35))
  }
}

private struct WorkLanePickerMenu: View {
  let lanes: [LaneSummary]
  let allLanesEmpty: Bool
  let selectedLaneId: String
  var showsAutoCreateOption: Bool = true
  var laneSubtitle: ((LaneSummary) -> String?)? = nil
  var isLaneDisabled: ((LaneSummary) -> Bool)? = nil
  @Binding var searchQuery: String
  let onSelect: (String) -> Void

  @FocusState private var searchFocused: Bool

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 6) {
        Image(systemName: "magnifyingglass")
          .font(.system(size: 12, weight: .regular))
          .foregroundStyle(ADEColor.textMuted.opacity(0.5))
        TextField("Search lanes...", text: $searchQuery)
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

      if showsAutoCreateOption {
        Button {
          onSelect(workAutoCreateLaneSentinelId)
        } label: {
          HStack(spacing: 6) {
            WorkOrchestratorRainbowText(text: "Auto-create lane")
            if selectedLaneId == workAutoCreateLaneSentinelId {
              Image(systemName: "checkmark")
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(ADEColor.accent)
            }
          }
          .frame(maxWidth: .infinity)
          .padding(.vertical, 8)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
      }

      ScrollView {
        LazyVStack(spacing: 0) {
          if lanes.isEmpty {
            Text(allLanesEmpty ? "No lanes available" : "No lanes found")
              .font(.system(size: 11))
              .foregroundStyle(ADEColor.textMuted)
              .frame(maxWidth: .infinity)
              .padding(.vertical, 12)
          } else {
            ForEach(lanes) { lane in
              laneRow(lane)
            }
          }
        }
        .padding(4)
      }
      .frame(maxHeight: 260)
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

  private func laneRow(_ lane: LaneSummary) -> some View {
    let isSelected = lane.id == selectedLaneId
    let branch = normalizedPrBranchName(lane.branchRef)
    let laneColor = LaneColorPalette.displayColor(forHex: lane.color, fallback: ADEColor.textSecondary)
    let disabled = isLaneDisabled?(lane) ?? false
    let eligibilitySubtitle = laneSubtitle?(lane)

    return Button {
      guard !disabled else { return }
      onSelect(lane.id)
    } label: {
      VStack(alignment: .leading, spacing: 3) {
        HStack(spacing: 6) {
          WorkLaneLogoMark(color: laneColor, laneIcon: lane.icon, size: 12)
            .opacity(disabled ? 0.45 : 1)
          Text(lane.name)
            .font(.system(size: 11, weight: isSelected ? .medium : .regular))
            .foregroundStyle(disabled ? ADEColor.textMuted : ADEColor.textPrimary)
            .lineLimit(1)
            .frame(maxWidth: .infinity, alignment: .leading)
          if disabled {
            Image(systemName: "lock.fill")
              .font(.system(size: 10, weight: .semibold))
              .foregroundStyle(ADEColor.warning.opacity(0.85))
          } else if isSelected {
            Image(systemName: "checkmark")
              .font(.system(size: 12, weight: .bold))
              .foregroundStyle(ADEColor.accent)
          }
        }
        if !branch.isEmpty {
          HStack(spacing: 4) {
            Image(systemName: "arrow.branch")
              .font(.system(size: 10, weight: .regular))
              .foregroundStyle(ADEColor.textMuted.opacity(0.6))
            Text(branch)
              .font(.system(size: 10))
              .foregroundStyle(ADEColor.textMuted.opacity(0.92))
              .lineLimit(1)
          }
          .padding(.leading, 18)
        }
        if let eligibilitySubtitle, !eligibilitySubtitle.isEmpty {
          Text(eligibilitySubtitle)
            .font(.system(size: 10))
            .foregroundStyle(disabled ? ADEColor.warning.opacity(0.9) : ADEColor.textSecondary)
            .lineLimit(2)
            .padding(.leading, 18)
        }
      }
      .padding(.horizontal, 8)
      .padding(.vertical, branch.isEmpty && eligibilitySubtitle == nil ? 6 : 5)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(
        isSelected ? ADEColor.accent.opacity(0.12) : Color.clear,
        in: RoundedRectangle(cornerRadius: 6, style: .continuous)
      )
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(disabled)
  }
}

/// Desktop `ade-orchestrator-rainbow-text` gradient label for auto-create lane.
private struct WorkOrchestratorRainbowText: View {
  let text: String

  private static let colors: [Color] = [
    Color(red: 1.0, green: 0.37, blue: 0.37),
    Color(red: 1.0, green: 0.61, blue: 0.25),
    Color(red: 0.97, green: 0.82, blue: 0.36),
    Color(red: 0.35, green: 0.85, blue: 0.50),
    Color(red: 0.31, green: 0.58, blue: 1.0),
    Color(red: 0.65, green: 0.40, blue: 1.0),
  ]

  var body: some View {
    Text(text)
      .font(.system(size: 11, weight: .medium))
      .foregroundStyle(
        LinearGradient(colors: Self.colors, startPoint: .leading, endPoint: .trailing)
      )
  }
}
