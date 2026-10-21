import SwiftUI

private enum LaneTreeMetrics {
  static let indent: CGFloat = 20
  static let elbowWidth: CGFloat = 14
  static let elbowHeight: CGFloat = 22
  static let strokeColor = ADEKit.rule
  static let strokeWidth: CGFloat = 1
}

private struct LaneTreeElbowShape: Shape {
  func path(in rect: CGRect) -> Path {
    var path = Path()
    let midX = rect.minX + 2
    let midY = rect.midY
    path.move(to: CGPoint(x: midX, y: rect.minY))
    path.addLine(to: CGPoint(x: midX, y: midY))
    path.addLine(to: CGPoint(x: rect.maxX, y: midY))
    return path
  }
}

/// One lane as a row of the Lanes list: indented under its parent with an
/// elbow, tapping opens it, long-press shows its menu over a peek.
struct LaneTreeRow: View {
  let snapshot: LaneListSnapshot
  let depth: Int
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
  /// A child sits indented under its parent's row, which names the machine;
  /// repeating it squeezed the branch name.
  var showsMachineChip = true

  private var isChild: Bool { snapshot.lane.laneType != "primary" && depth > 0 }

  var body: some View {
    HStack(alignment: .top, spacing: 0) {
      if depth > 0 {
        ForEach(0..<depth, id: \.self) { _ in
          Color.clear.frame(width: LaneTreeMetrics.indent)
        }
      }
      if isChild {
        LaneTreeElbowShape()
          .stroke(LaneTreeMetrics.strokeColor, lineWidth: LaneTreeMetrics.strokeWidth)
          .frame(width: LaneTreeMetrics.elbowWidth, height: LaneTreeMetrics.elbowHeight)
          .padding(.top, 12)
          .padding(.leading, ADEKit.inset)
      }
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
      depth: depth,
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
