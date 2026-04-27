import SwiftUI

/// One-stop "Advanced" page for a lane: settings, branch switching, stash,
/// and the destructive git escape hatches (rebase, force push). Each row
/// gets a description so the user knows what it does before they tap it.
struct LaneAdvancedScreen: View {
  let snapshot: LaneListSnapshot
  let canRunLiveActions: Bool
  let disabledSubtitle: String?
  let laneId: String
  let branchRef: String?
  let laneType: String?
  let missionId: String?
  let laneRole: String?
  let onOpenManageSheet: () -> Void
  let onSwitchBranch: () -> Void
  let onStash: () -> Void
  let onRebaseLane: () -> Void
  let onRebaseDescendants: () -> Void
  let onRebaseAndPush: () -> Void
  let onForcePush: () -> Void

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        if !canRunLiveActions, let disabledSubtitle {
          HStack(spacing: 10) {
            Image(systemName: "wifi.exclamationmark")
              .foregroundStyle(ADEColor.warning)
            Text(disabledSubtitle)
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
            Spacer(minLength: 0)
          }
          .adeGlassCard(cornerRadius: 12, padding: 12)
        }

        groupCard(header: "Lane settings") {
          advancedRow(
            symbol: "gearshape.fill",
            tint: ADEColor.textPrimary,
            title: "Manage lane",
            description: "Rename, archive, or change parent. Settings that don't run git on their own.",
            action: onOpenManageSheet
          )
        }

        groupCard(header: "Branch & working copy") {
          advancedRow(
            symbol: branchSwitchDisabledReason == nil ? "arrow.triangle.branch" : "lock",
            tint: branchSwitchDisabledReason == nil ? ADEColor.tintLanes : ADEColor.textMuted,
            title: "Switch branch",
            description: branchSwitchDisabledReason
              ?? (branchRef.map { "Currently on \($0). Move this lane to another branch." }
                  ?? "Move this lane to another branch."),
            disabled: !canRunLiveActions || branchSwitchDisabledReason != nil,
            action: onSwitchBranch
          )
          divider
          advancedRow(
            symbol: "tray.and.arrow.down",
            tint: ADEColor.accent,
            title: "Stash changes",
            description: "Move all uncommitted work aside as a stash. You can pop it back later.",
            disabled: !canRunLiveActions,
            action: onStash
          )
        }

        groupCard(header: "Advanced git", warning: true) {
          advancedRow(
            symbol: "arrow.triangle.branch",
            tint: ADEColor.textPrimary,
            title: "Rebase lane",
            description: "Replay this lane's commits on top of the latest base branch.",
            disabled: !canRunLiveActions,
            action: onRebaseLane
          )
          divider
          advancedRow(
            symbol: "arrow.triangle.branch",
            tint: ADEColor.textPrimary,
            title: "Rebase + descendants",
            description: "Rebase this lane and every child stacked on top of it.",
            disabled: !canRunLiveActions,
            action: onRebaseDescendants
          )
          divider
          advancedRow(
            symbol: "arrow.up.and.down.text.horizontal",
            tint: ADEColor.textPrimary,
            title: "Rebase and push",
            description: "Rebase, then push (force-with-lease if required) so the remote matches.",
            disabled: !canRunLiveActions,
            action: onRebaseAndPush
          )
          divider
          advancedRow(
            symbol: "arrow.up.forward.circle.fill",
            tint: ADEColor.warning,
            title: "Force push (with lease)",
            description: "Overwrite the remote branch. Safe-with-lease, but still rewrites history.",
            disabled: !canRunLiveActions,
            destructive: true,
            action: onForcePush
          )
        }
      }
      .padding(EdgeInsets(top: 14, leading: 16, bottom: 28, trailing: 16))
    }
    .adeScreenBackground()
    .adeNavigationGlass()
    .navigationTitle("Advanced")
    .navigationBarTitleDisplayMode(.inline)
  }

  // MARK: - Components

  @ViewBuilder
  private func groupCard<Content: View>(
    header: String,
    warning: Bool = false,
    @ViewBuilder content: () -> Content
  ) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(header.uppercased())
        .font(.caption.weight(.semibold))
        .tracking(0.6)
        .foregroundStyle(warning ? ADEColor.warning : ADEColor.textMuted)
      VStack(spacing: 0) {
        content()
      }
      .background(
        ADEColor.surfaceBackground.opacity(0.35),
        in: RoundedRectangle(cornerRadius: 14, style: .continuous)
      )
      .overlay(
        RoundedRectangle(cornerRadius: 14, style: .continuous)
          .stroke(
            (warning ? ADEColor.warning.opacity(0.18) : ADEColor.border.opacity(0.18)),
            lineWidth: 0.5
          )
      )
    }
  }

  private var divider: some View {
    Rectangle()
      .fill(ADEColor.border.opacity(0.18))
      .frame(height: 0.5)
      .padding(.leading, 44)
  }

  @ViewBuilder
  private func advancedRow(
    symbol: String,
    tint: Color,
    title: String,
    description: String,
    disabled: Bool = false,
    destructive: Bool = false,
    action: @escaping () -> Void
  ) -> some View {
    Button(action: action) {
      HStack(alignment: .top, spacing: 12) {
        Image(systemName: symbol)
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(tint)
          .frame(width: 24, height: 24, alignment: .center)
          .padding(.top, 2)
        VStack(alignment: .leading, spacing: 4) {
          Text(title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(destructive ? ADEColor.warning : ADEColor.textPrimary)
          Text(description)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        Spacer(minLength: 8)
        Image(systemName: "chevron.right")
          .font(.system(size: 10, weight: .bold))
          .foregroundStyle(ADEColor.textMuted)
          .padding(.top, 4)
      }
      .padding(EdgeInsets(top: 12, leading: 12, bottom: 12, trailing: 12))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(disabled)
    .opacity(disabled ? 0.55 : 1.0)
  }

  private var branchSwitchDisabledReason: String? {
    if laneType == "attached" {
      return "Branch switching is disabled for attached lanes."
    }
    if missionId != nil, laneRole == "result" {
      return "Branch switching is disabled for mission result lanes."
    }
    if missionId != nil, let role = laneRole, role != "result" {
      return "Branch switching isn't available on mission worker lanes."
    }
    return nil
  }
}
