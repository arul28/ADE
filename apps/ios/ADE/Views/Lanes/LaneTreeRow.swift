import SwiftUI

/// One lane as a row of the Lanes list: tapping opens it, long-press shows
/// its menu over a peek.
struct LaneTreeRow: View {
  let snapshot: LaneListSnapshot
  let pullRequest: LanePrTag?
  let isPinned: Bool
  let isOpen: Bool
  let transitionNamespace: Namespace.ID?
  let isSelectedTransitionSource: Bool
  let onContextMenu: (LaneListSnapshot) -> AnyView
  let onSelectLane: (String) -> Void
  /// Pushes the lane's detail through the list's navigation path.
  let onOpen: () -> Void
  var machine: LaneMachineChip? = nil
  /// Off where a section header already names the machine; repeating it
  /// squeezed the branch name.
  var showsMachineChip = true

  var body: some View {
    HStack(alignment: .top, spacing: 0) {
      if machine?.isLive == false {
        // The last roster of a machine the phone has no live link to: shown,
        // dimmed, no actions (the desktop's offline rule).
        card
      } else {
        Button {
          onSelectLane(snapshot.lane.id)
          onOpen()
        } label: {
          card
        }
        .buttonStyle(ADEKitRowButtonStyle())
        .contextMenu {
          onContextMenu(snapshot)
        } preview: {
          LanePeekPreview(snapshot: snapshot, pullRequest: pullRequest)
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var card: some View {
    LaneStackCard(
      snapshot: snapshot,
      isPinned: isPinned,
      isOpen: isOpen,
      pullRequest: pullRequest,
      transitionNamespace: transitionNamespace,
      isSelectedTransitionSource: isSelectedTransitionSource,
      machine: machine,
      showsMachineChip: showsMachineChip
    )
    .equatable()
  }
}

struct LanePeekPreview: View {
  let snapshot: LaneListSnapshot
  var pullRequest: LanePrTag? = nil

  var body: some View {
    let laneTint = laneSurfaceTint(forHex: snapshot.lane.color)
    let laneAccent = laneTint.text ?? ADEColor.textPrimary
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        WorkLaneLogoMark(color: laneAccent, laneIcon: snapshot.lane.icon, emoji: snapshot.lane.emoji, size: 12)
        Text(snapshot.lane.name)
          .font(.headline)
          .foregroundStyle(laneAccent)
        if let pullRequest {
          LanePrTagChip(tag: pullRequest)
        }
        Spacer(minLength: 0)
      }
      HStack(spacing: 5) {
        Image(systemName: "arrow.triangle.branch")
          .font(.system(size: 10, weight: .regular))
          .foregroundStyle(ADEColor.textMuted.opacity(0.7))
        Text(normalizedPrBranchName(snapshot.lane.branchRef))
          .font(.system(.caption2, design: .monospaced))
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(1)
      }

      Divider().opacity(0.2)

      HStack(spacing: 10) {
        if snapshot.lane.status.ahead > 0 {
          Label("\(snapshot.lane.status.ahead) ahead", systemImage: "arrow.up")
            .font(.caption)
            .foregroundStyle(ADEColor.success)
        }
        if snapshot.lane.status.behind > 0 {
          Label("\(snapshot.lane.status.behind) behind", systemImage: "arrow.down")
            .font(.caption)
            .foregroundStyle(ADEColor.warning)
        }
        if snapshot.lane.status.dirty {
          Label("dirty", systemImage: "circle.fill")
            .font(.caption)
            .foregroundStyle(ADEColor.warning)
        }
        Spacer(minLength: 0)
      }
    }
    .padding(16)
    .frame(width: 280)
    .background(ADEKit.surface)
  }
}
