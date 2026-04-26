import SwiftUI

struct LaneActionsCard: View {
  let canRunLiveActions: Bool
  let disabledSubtitle: String?
  let onRebaseLane: () -> Void
  let onRebaseDescendants: () -> Void
  let onRebaseAndPush: () -> Void
  let onForcePush: () -> Void
  let onStash: () -> Void
  var laneId: String? = nil
  var branchRef: String? = nil
  var laneType: String? = nil
  var missionId: String? = nil
  var laneRole: String? = nil
  var onRefresh: (@MainActor () async -> Void)? = nil

  @State private var moreExpanded = false
  @State private var showBranchPicker = false

  var body: some View {
    ADEGlassSection(title: "Lane actions", subtitle: canRunLiveActions ? nil : disabledSubtitle) {
      VStack(alignment: .leading, spacing: 12) {
        if showsSwitchBranch {
          switchBranchButton
        }
        stashButton
        moreSection
      }
    }
    .sheet(isPresented: $showBranchPicker) {
      if let laneId, let branchRef, branchSwitchDisabledReason == nil {
        LaneBranchPickerSheet(
          laneId: laneId,
          branchRef: branchRef,
          onComplete: {
            if let onRefresh {
              await onRefresh()
            }
          }
        )
      }
    }
  }

  private var showsSwitchBranch: Bool {
    laneId != nil && branchRef != nil
  }

  private var branchSwitchDisabledReason: String? {
    if laneType == "attached" {
      return "Branch switching is disabled for attached lanes — manage this worktree with your own tools."
    }
    if missionId != nil, laneRole == "result" {
      return "Branch switching is disabled for mission result lanes to keep their output stable."
    }
    if missionId != nil, laneRole != "result" {
      return "Branch switching isn't available on mission worker lanes."
    }
    return nil
  }

  private var switchBranchButton: some View {
    let disabledReason = branchSwitchDisabledReason
    let isDisabled = !canRunLiveActions || disabledReason != nil
    return Button {
      guard disabledReason == nil else { return }
      showBranchPicker = true
    } label: {
      HStack(spacing: 10) {
        Image(systemName: disabledReason == nil ? "arrow.triangle.branch" : "lock")
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(disabledReason == nil ? ADEColor.tintLanes : ADEColor.textMuted)
          .frame(width: 24)
          .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 2) {
          Text("Switch branch")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          if let disabledReason {
            Text(disabledReason)
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
              .lineLimit(2)
          } else if let branchRef {
            Text(branchRef)
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
              .lineLimit(1)
              .truncationMode(.middle)
          } else {
            Text("Move this lane to another branch.")
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
          }
        }
        Spacer(minLength: 8)
        if disabledReason == nil {
          Image(systemName: "chevron.right")
            .font(.system(size: 10, weight: .bold))
            .foregroundStyle(ADEColor.textMuted)
        }
      }
      .padding(EdgeInsets(top: 11, leading: 12, bottom: 11, trailing: 12))
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(
        (disabledReason == nil ? ADEColor.tintLanes.opacity(0.10) : ADEColor.surfaceBackground.opacity(0.22)),
        in: RoundedRectangle(cornerRadius: 12, style: .continuous)
      )
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .stroke(
            disabledReason == nil ? ADEColor.tintLanes.opacity(0.22) : ADEColor.border.opacity(0.14),
            lineWidth: 0.5
          )
      )
    }
    .buttonStyle(.plain)
    .disabled(isDisabled)
    .opacity(isDisabled ? 0.6 : 1.0)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(branchRef.map { "Switch branch, currently \($0)" } ?? "Switch branch")
    .accessibilityHint(disabledReason ?? "Opens the branch picker for this lane.")
  }

  private var stashButton: some View {
    Button(action: onStash) {
      HStack(spacing: 10) {
        Image(systemName: "tray.and.arrow.down")
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(ADEColor.accent)
          .frame(width: 24)
        VStack(alignment: .leading, spacing: 2) {
          Text("Stash changes")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text("Move current work aside without discarding it.")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }
        Spacer(minLength: 8)
        Image(systemName: "chevron.right")
          .font(.system(size: 10, weight: .bold))
          .foregroundStyle(ADEColor.textMuted)
      }
      .padding(EdgeInsets(top: 11, leading: 12, bottom: 11, trailing: 12))
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(ADEColor.surfaceBackground.opacity(0.28), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .stroke(ADEColor.border.opacity(0.14), lineWidth: 0.5)
      )
    }
    .buttonStyle(.plain)
    .disabled(!canRunLiveActions)
    .opacity(canRunLiveActions ? 1.0 : 0.55)
  }

  @ViewBuilder
  private var moreSection: some View {
    Button {
      withAnimation(.smooth(duration: 0.22)) { moreExpanded.toggle() }
    } label: {
      HStack(spacing: 12) {
        Image(systemName: "exclamationmark.shield")
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(ADEColor.warning)
          .frame(width: 24)
        VStack(alignment: .leading, spacing: 2) {
          Text("Advanced git")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
            .minimumScaleFactor(0.9)
          Text("Review before rebasing or force pushing.")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }
        Spacer(minLength: 8)
        Image(systemName: "chevron.down")
          .font(.system(size: 10, weight: .bold))
          .foregroundStyle(ADEColor.textMuted)
          .rotationEffect(.degrees(moreExpanded ? 180 : 0))
      }
      .padding(EdgeInsets(top: 11, leading: 12, bottom: 11, trailing: 12))
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(ADEColor.warning.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .stroke(ADEColor.warning.opacity(0.18), lineWidth: 0.5)
      )
    }
    .buttonStyle(.plain)

    if moreExpanded {
      VStack(spacing: 0) {
        moreRow(title: "Rebase lane", symbol: "arrow.triangle.branch", tint: ADEColor.textPrimary, action: onRebaseLane)
        Divider().opacity(0.35)
        moreRow(title: "Rebase + descendants", symbol: "arrow.triangle.branch", tint: ADEColor.textPrimary, action: onRebaseDescendants)
        Divider().opacity(0.35)
        moreRow(title: "Rebase and push", symbol: "arrow.up.and.down.text.horizontal", tint: ADEColor.textPrimary, action: onRebaseAndPush)
        Divider().opacity(0.35)
        moreRow(title: "Force push (lease)", symbol: "arrow.up.forward.circle.fill", tint: ADEColor.warning, action: onForcePush)
      }
      .background(ADEColor.surfaceBackground.opacity(0.25), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .stroke(ADEColor.border.opacity(0.14), lineWidth: 0.5)
      )
      .transition(.opacity.combined(with: .move(edge: .top)))
    }
  }

  private func moreRow(title: String, symbol: String, tint: Color, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      HStack(spacing: 10) {
        Image(systemName: symbol)
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(tint)
          .frame(width: 20)
        Text(title)
          .font(.subheadline)
          .foregroundStyle(tint)
          .lineLimit(2)
        Spacer()
        Image(systemName: "chevron.right")
          .font(.system(size: 10, weight: .bold))
          .foregroundStyle(ADEColor.textMuted)
      }
      .padding(EdgeInsets(top: 11, leading: 12, bottom: 11, trailing: 12))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(!canRunLiveActions)
    .opacity(canRunLiveActions ? 1.0 : 0.55)
  }
}
