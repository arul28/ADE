import SwiftUI

/// Desktop-shaped target-branch picker for the Create PR wizard. Mirrors the
/// Work tab lane dropdown styling but lists branch targets (default base +
/// integration lanes).
struct PrTargetBranchPickerDropdown: View {
  let targets: [PrBranchTargetOption]
  @Binding var selectedBranch: String
  var emptySelectionTitle: String = "Select target..."

  @State private var menuPresented = false
  @State private var searchQuery = ""

  private var selectedTarget: PrBranchTargetOption? {
    targets.first(where: { $0.id == selectedBranch })
  }

  private var filteredTargets: [PrBranchTargetOption] {
    let trimmed = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !trimmed.isEmpty else { return targets }
    return targets.filter { target in
      target.label.lowercased().contains(trimmed) || target.subtitle.lowercased().contains(trimmed)
    }
  }

  var body: some View {
    Button {
      menuPresented = true
    } label: {
      triggerLabel
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Select target branch")
    .accessibilityValue(selectedTarget?.label ?? selectedBranch)
    .popover(isPresented: $menuPresented, attachmentAnchor: .rect(.bounds), arrowEdge: .bottom) {
      PrTargetBranchPickerMenu(
        targets: filteredTargets,
        allTargetsEmpty: targets.isEmpty,
        selectedBranch: selectedBranch,
        searchQuery: $searchQuery,
        onSelect: { branch in
          selectedBranch = branch
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
  }

  private var triggerLabel: some View {
    let title = selectedTarget?.label ?? (selectedBranch.isEmpty ? emptySelectionTitle : selectedBranch)
    let subtitle = selectedTarget?.subtitle

    return ZStack {
      Group {
        if let subtitle, !subtitle.isEmpty {
          VStack(spacing: 2) {
            triggerTitleRow(title)
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
          triggerTitleRow(title)
        }
      }
      .padding(.horizontal, 26)
      .frame(maxWidth: .infinity, alignment: .center)

      HStack(spacing: 0) {
        Spacer(minLength: 0)
        Image(systemName: "chevron.up.chevron.down")
          .font(.system(size: 10, weight: .bold))
          .foregroundStyle(ADEColor.textMuted.opacity(0.6))
          .padding(.trailing, 10)
      }
    }
    .padding(.leading, 12)
    .padding(.trailing, 4)
    .padding(.vertical, subtitle?.isEmpty == false ? 5 : 6)
    .background(Color.white.opacity(0.04), in: Capsule(style: .continuous))
    .overlay(
      Capsule(style: .continuous)
        .stroke(Color.white.opacity(0.08), lineWidth: 1)
    )
    .frame(maxWidth: .infinity)
  }

  private func triggerTitleRow(_ title: String) -> some View {
    HStack(spacing: 5) {
      Image(systemName: "arrow.triangle.branch")
        .font(.system(size: 10, weight: .semibold))
        .foregroundStyle(ADEColor.textSecondary)
      Text(title)
        .font(.system(size: 11, weight: .medium))
        .foregroundStyle(Color.white.opacity(0.85))
        .lineLimit(1)
    }
  }
}

struct PrBranchTargetOption: Identifiable, Equatable {
  let id: String
  let label: String
  let subtitle: String
}

private struct PrTargetBranchPickerMenu: View {
  let targets: [PrBranchTargetOption]
  let allTargetsEmpty: Bool
  let selectedBranch: String
  @Binding var searchQuery: String
  let onSelect: (String) -> Void

  @FocusState private var searchFocused: Bool

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 6) {
        Image(systemName: "magnifyingglass")
          .font(.system(size: 12, weight: .regular))
          .foregroundStyle(ADEColor.textMuted.opacity(0.5))
        TextField("Search branches...", text: $searchQuery)
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
          if targets.isEmpty {
            Text(allTargetsEmpty ? "No targets available" : "No branches found")
              .font(.system(size: 11))
              .foregroundStyle(ADEColor.textMuted)
              .frame(maxWidth: .infinity)
              .padding(.vertical, 12)
          } else {
            ForEach(targets) { target in
              targetRow(target)
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

  private func targetRow(_ target: PrBranchTargetOption) -> some View {
    let isSelected = target.id == selectedBranch

    return Button {
      onSelect(target.id)
    } label: {
      VStack(alignment: .leading, spacing: 3) {
        HStack(spacing: 6) {
          Image(systemName: "arrow.triangle.branch")
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(ADEColor.textSecondary)
          Text(target.label)
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
        if !target.subtitle.isEmpty {
          Text(target.subtitle)
            .font(.system(size: 10))
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
            .padding(.leading, 18)
        }
      }
      .padding(.horizontal, 8)
      .padding(.vertical, 5)
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
