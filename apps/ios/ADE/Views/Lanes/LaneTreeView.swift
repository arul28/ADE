import SwiftUI

private enum LaneTreeMetrics {
  static let indent: CGFloat = 18
  static let elbowWidth: CGFloat = 14
  static let elbowHeight: CGFloat = 22
  static let rowSpacing: CGFloat = 8
  static let strokeColor = ADEColor.glassBorder
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

struct LaneTreeView: View {
  let snapshots: [LaneListSnapshot]
  let pinnedLaneIds: Set<String>
  let openLaneIds: [String]
  let allLaneSnapshots: [LaneListSnapshot]
  let transitionNamespace: Namespace.ID?
  let selectedLaneId: String?
  let onRefreshRoot: () async -> Void
  let onContextMenu: (LaneListSnapshot) -> AnyView
  let onTogglePin: (String) -> Void
  let onSelectLane: (String) -> Void

  private var depthByLane: [String: Int] {
    let visibleLaneIds = Set(snapshots.map { $0.lane.id })
    // Snapshots can overlap during sync reconciliation; coalesce instead of crashing.
    let laneById = Dictionary(allLaneSnapshots.map { ($0.lane.id, $0.lane) }, uniquingKeysWith: { _, new in new })

    var memo: [String: Int] = [:]

    func depthFor(_ laneId: String, visiting: Set<String> = []) -> Int {
      if let cached = memo[laneId] { return cached }
      if visiting.contains(laneId) { return 0 }
      guard visibleLaneIds.contains(laneId), let lane = laneById[laneId] else {
        memo[laneId] = 0
        return 0
      }
      if lane.laneType == "primary" {
        memo[laneId] = 0
        return 0
      }
      guard let parentId = lane.parentLaneId, parentId != laneId, visibleLaneIds.contains(parentId) else {
        memo[laneId] = 0
        return 0
      }
      var next = visiting
      next.insert(laneId)
      let depth = depthFor(parentId, visiting: next) + 1
      memo[laneId] = depth
      return depth
    }

    for snapshot in allLaneSnapshots {
      _ = depthFor(snapshot.lane.id)
    }
    return memo
  }

  var body: some View {
    let depths = depthByLane
    VStack(spacing: LaneTreeMetrics.rowSpacing) {
      ForEach(snapshots) { snapshot in
        LaneTreeRow(
          snapshot: snapshot,
          depth: depths[snapshot.lane.id] ?? 0,
          allLaneSnapshots: allLaneSnapshots,
          isPinned: pinnedLaneIds.contains(snapshot.lane.id),
          isOpen: openLaneIds.contains(snapshot.lane.id),
          transitionNamespace: transitionNamespace,
          isSelectedTransitionSource: selectedLaneId == snapshot.lane.id,
          onRefreshRoot: onRefreshRoot,
          onContextMenu: onContextMenu,
          onTogglePin: onTogglePin,
          onSelectLane: onSelectLane
        )
      }
    }
  }
}

struct LaneTreeRow: View {
  let snapshot: LaneListSnapshot
  let depth: Int
  let allLaneSnapshots: [LaneListSnapshot]
  let isPinned: Bool
  let isOpen: Bool
  let transitionNamespace: Namespace.ID?
  let isSelectedTransitionSource: Bool
  let onRefreshRoot: () async -> Void
  let onContextMenu: (LaneListSnapshot) -> AnyView
  let onTogglePin: (String) -> Void
  let onSelectLane: (String) -> Void

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
          .padding(.top, 18)
      }
      NavigationLink {
        LaneDetailScreen(
          laneId: snapshot.lane.id,
          initialSnapshot: snapshot,
          allLaneSnapshots: allLaneSnapshots,
          transitionNamespace: transitionNamespace,
          onRefreshRoot: onRefreshRoot
        )
      } label: {
        LaneStackCard(
          snapshot: snapshot,
          isPinned: isPinned,
          isOpen: isOpen,
          depth: depth,
          transitionNamespace: transitionNamespace,
          isSelectedTransitionSource: isSelectedTransitionSource
        )
        .equatable()
      }
      .simultaneousGesture(TapGesture().onEnded {
        onSelectLane(snapshot.lane.id)
      })
      .buttonStyle(ADEScaleButtonStyle())
      .contextMenu {
        onContextMenu(snapshot)
      } preview: {
        LanePeekPreview(snapshot: snapshot)
      }
      .swipeActions(edge: .leading, allowsFullSwipe: false) {
        Button {
          onTogglePin(snapshot.lane.id)
        } label: {
          Label(isPinned ? "Unpin" : "Pin", systemImage: isPinned ? "pin.slash.fill" : "pin.fill")
        }
        .tint(ADEColor.accent)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

struct LanePeekPreview: View {
  let snapshot: LaneListSnapshot

  var body: some View {
    let laneAccent = LaneColorPalette.color(forHex: snapshot.lane.color)
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        LaneStatusIndicator(bucket: snapshot.runtime.bucket, size: 9)
        if let laneAccent {
          Circle().fill(laneAccent).frame(width: 7, height: 7)
        }
        Text(snapshot.lane.name)
          .font(.headline)
          .foregroundStyle(laneAccent ?? ADEColor.textPrimary)
        Spacer(minLength: 0)
      }
      Text(snapshot.lane.branchRef)
        .font(.system(.caption, design: .monospaced))
        .foregroundStyle(ADEColor.textSecondary)
        .lineLimit(1)

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

      if snapshot.runtime.sessionCount > 0 {
        Label("\(snapshot.runtime.sessionCount) running session\(snapshot.runtime.sessionCount == 1 ? "" : "s")", systemImage: "waveform.path.ecg")
          .font(.caption)
          .foregroundStyle(ADEColor.success)
      }

      if let activity = laneActivitySummary(snapshot) {
        Text(activity)
          .font(.caption)
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(3)
      }
    }
    .padding(16)
    .frame(width: 280)
    .background(ADEColor.surfaceBackground)
  }
}
