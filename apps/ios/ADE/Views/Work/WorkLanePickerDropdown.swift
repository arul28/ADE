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
  /// Fires with the presentation state of the lane sheet. Callers that own a
  /// composer use it to park and restore keyboard focus around the sheet.
  /// Declared last with a default so existing call sites compile unchanged.
  var onMenuPresentationChange: ((Bool) -> Void)? = nil
  /// Floating glass bubble (new-chat page): one line — lane mark, name,
  /// branch, chevron — sized to its content instead of a wide slab.
  var floatingGlass: Bool = false

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
        if floatingGlass {
          floatingTriggerLabel
        } else {
          triggerLabel
        }
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Select lane")
      .accessibilityValue(triggerTitle)
      // A sheet, not a popover: UIKit compresses a popover into whatever space
      // the keyboard and a grown composer leave behind, which clipped the lane
      // list to a few rows. A sheet owns its own space and resizes for the
      // keyboard instead.
      .sheet(isPresented: $menuPresented, onDismiss: {
        // The closed edge fires here, not from `onChange`: `menuPresented`
        // flips when the dismissal *starts*, so restoring composer focus from
        // there races the sheet still animating away and the keyboard loses.
        // `onDismiss` runs once the sheet is actually gone.
        searchQuery = ""
        onMenuPresentationChange?(false)
      }) {
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
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
      }
      .onChange(of: menuPresented) { _, isOpen in
        // Only the open edge; the closed edge is reported from `onDismiss`.
        guard isOpen else { return }
        onMenuPresentationChange?(true)
      }

      if let onRefresh {
        Button {
          Task { await onRefresh() }
        } label: {
          Image(systemName: "arrow.clockwise")
            .font(.caption.weight(.semibold))
            .foregroundStyle(ADEColor.textSecondary)
            .frame(width: 34, height: 34)
            .background(ADEKit.surface, in: Circle())
            .overlay(Circle().strokeBorder(ADEKit.edge, lineWidth: 0.75))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Refresh lanes")
        .accessibilityHint("Reloads the lane list from your paired desktop.")
      }
    }
  }

  private var triggerLabel: some View {
    ZStack {
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
    .adeKitPill()
    .frame(minWidth: 180, maxWidth: 320)
  }

  private var floatingTriggerLabel: some View {
    // The branch only when it fits whole enough to read; otherwise the lane
    // name alone rather than a two-letter stub of the branch.
    ViewThatFits(in: .horizontal) {
      floatingTriggerContent(showsBranch: true)
      floatingTriggerContent(showsBranch: false)
    }
    .padding(.horizontal, 12)
    .frame(height: 34)
    // Solid kit surface, as the Hub composer's destination control: the lane's
    // colour stays on its mark.
    .adeKitPill()
    .frame(maxWidth: 300)
    .fixedSize(horizontal: false, vertical: true)
    .contentShape(Capsule(style: .continuous))
  }

  private func floatingTriggerContent(showsBranch: Bool) -> some View {
    HStack(spacing: 6) {
      if isAutoCreateSelected {
        Image(systemName: "sparkles")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(ADEColor.textSecondary)
      } else if let triggerLaneColor {
        WorkLaneLogoMark(color: triggerLaneColor, laneIcon: selectedLane?.icon, size: 11)
      }
      Text(triggerTitle)
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)
        .layoutPriority(1)
      if showsBranch, let branch = triggerBranchLabel {
        Text(branch)
          .font(.adeMono(11))
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(1)
          .fixedSize()
      }
      Image(systemName: "chevron.up.chevron.down")
        .font(.system(size: 9, weight: .semibold))
        .foregroundStyle(ADEColor.textMuted)
    }
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
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(ADEColor.textSecondary)
      }
      Text(triggerTitle)
        .font(.system(size: 14, weight: .semibold))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)
    }
  }

}

/// Sheet body for the lane picker. Sized to fill its presentation container —
/// no fixed width or list height — so the keyboard can only shrink the scroll
/// area, never clip it away.
struct WorkLanePickerMenu: View {
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
    VStack(spacing: 12) {
      HStack(spacing: 8) {
        Image(systemName: "magnifyingglass")
          .font(.system(size: 14, weight: .regular))
          .foregroundStyle(ADEColor.textMuted)
        TextField("Search lanes", text: $searchQuery)
          .textFieldStyle(.plain)
          .font(.system(size: 15))
          .foregroundStyle(ADEColor.textPrimary)
          .focused($searchFocused)
          .submitLabel(.done)
          .autocorrectionDisabled()
          .textInputAutocapitalization(.never)
      }
      .padding(.horizontal, 12)
      .frame(height: 38)
      .background(ADEKit.track, in: RoundedRectangle(cornerRadius: 10, style: .continuous))

      ScrollView {
        VStack(spacing: 0) {
          ADESettingsRows {
            if showsAutoCreateOption {
              autoCreateRow
            }
            if lanes.isEmpty {
              Text(allLanesEmpty ? "No lanes available" : "No lanes found")
                .font(.system(size: 14))
                .foregroundStyle(ADEColor.textMuted)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 18)
            } else {
              ForEach(lanes) { lane in
                laneRow(lane)
              }
            }
          }
        }
        .padding(.bottom, 12)
      }
      .scrollDismissesKeyboard(.interactively)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    .padding(.horizontal, 16)
    .padding(.top, 18)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    .background(ADEColor.pageBackground.ignoresSafeArea())
    .onAppear {
      searchFocused = true
    }
  }

  private var autoCreateRow: some View {
    let isSelected = selectedLaneId == workAutoCreateLaneSentinelId
    return Button {
      onSelect(workAutoCreateLaneSentinelId)
    } label: {
      HStack(spacing: 10) {
        Image(systemName: "sparkles")
          .font(.system(size: 13, weight: .medium))
          .foregroundStyle(ADEColor.textSecondary)
          .frame(width: 18)
        Text("Auto-create lane")
          .font(.system(size: 15, weight: isSelected ? .semibold : .regular))
          .foregroundStyle(ADEColor.textPrimary)
        Spacer(minLength: 8)
        if isSelected {
          Image(systemName: "checkmark")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(ADEColor.accent)
        }
      }
      .padding(.horizontal, ADEKit.inset)
      .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
    }
    .buttonStyle(ADEKitRowButtonStyle())
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
      HStack(alignment: .top, spacing: 10) {
        WorkLaneLogoMark(color: laneColor, laneIcon: lane.icon, size: 14)
          .frame(width: 18)
          .padding(.top, 2)
          .opacity(disabled ? 0.45 : 1)
        VStack(alignment: .leading, spacing: 2) {
          Text(lane.name)
            .font(.system(size: 15, weight: isSelected ? .semibold : .regular))
            .foregroundStyle(disabled ? ADEColor.textMuted : ADEColor.textPrimary)
            .lineLimit(1)
          if !branch.isEmpty {
            Text(branch)
              .font(.adeMono(11.5))
              .foregroundStyle(ADEColor.textMuted)
              .lineLimit(1)
              .truncationMode(.middle)
          }
          if let eligibilitySubtitle, !eligibilitySubtitle.isEmpty {
            Text(eligibilitySubtitle)
              .font(.system(size: 12.5))
              .foregroundStyle(disabled ? ADEColor.warning : ADEColor.textSecondary)
              .lineLimit(2)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        if disabled {
          Image(systemName: "lock.fill")
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(ADEColor.warning)
            .padding(.top, 3)
        } else if isSelected {
          Image(systemName: "checkmark")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(ADEColor.accent)
            .padding(.top, 3)
        }
      }
      .padding(.horizontal, ADEKit.inset)
      .padding(.vertical, 11)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .buttonStyle(ADEKitRowButtonStyle(dimsWhenDisabled: false))
    .disabled(disabled)
  }
}

