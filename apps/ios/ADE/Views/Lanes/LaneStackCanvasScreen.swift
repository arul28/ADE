import SwiftUI

struct LaneStackCanvasScreen: View {
  @Environment(\.dismiss) private var dismiss

  let snapshots: [LaneListSnapshot]
  let selectedLaneId: String?
  let onSelectLane: (LaneSummary) -> Void

  @State private var zoom: CGFloat = 1.0
  @GestureState private var gestureZoom: CGFloat = 1.0

  private let minZoom: CGFloat = 0.5
  private let maxZoom: CGFloat = 2.5

  private let indentStep: CGFloat = 32
  private let rowSpacing: CGFloat = 14
  private let nodeWidth: CGFloat = 240
  private let nodeMinHeight: CGFloat = 64
  private let canvasPadding: CGFloat = 32

  var body: some View {
    NavigationStack {
      Group {
        if snapshots.isEmpty {
          ScrollView {
            ADEEmptyStateView(
              symbol: "square.stack.3d.up.slash",
              title: "No lanes",
              message: "Create lanes to see the stack canvas."
            )
            .padding(20)
          }
        } else {
          canvas
        }
      }
      .adeScreenBackground()
      .background(canvasBackground)
      .adeNavigationGlass()
      .navigationTitle("Stack Canvas")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done") { dismiss() }
        }
        ToolbarItemGroup(placement: .topBarTrailing) {
          if !snapshots.isEmpty {
            zoomControls
          }
        }
      }
    }
  }

  // MARK: - Canvas surface

  private var canvasBackground: some View {
    RadialGradient(
      colors: [
        ADEColor.accent.opacity(0.06),
        ADEColor.pageBackground.opacity(0.0),
      ],
      center: .center,
      startRadius: 40,
      endRadius: 520
    )
    .ignoresSafeArea()
  }

  private var canvas: some View {
    let layout = computeLayout()
    let effectiveZoom = clampedZoom(zoom * gestureZoom)
    return ScrollView([.horizontal, .vertical]) {
      ZStack(alignment: .topLeading) {
        connectors(layout: layout)
        ForEach(layout.nodes) { node in
          nodeView(node: node)
            .frame(width: nodeWidth)
            .position(x: node.frame.midX, y: node.frame.midY)
        }
      }
      .frame(width: layout.size.width, height: layout.size.height, alignment: .topLeading)
      .padding(canvasPadding)
      .scaleEffect(effectiveZoom, anchor: .topLeading)
      .frame(
        width: (layout.size.width + canvasPadding * 2) * effectiveZoom,
        height: (layout.size.height + canvasPadding * 2) * effectiveZoom,
        alignment: .topLeading
      )
      .animation(.spring(response: 0.32, dampingFraction: 0.84), value: zoom)
    }
    .gesture(
      MagnificationGesture()
        .updating($gestureZoom) { value, state, _ in
          state = value
        }
        .onEnded { value in
          zoom = clampedZoom(zoom * value)
        }
    )
  }

  // MARK: - Zoom controls

  private var zoomControls: some View {
    HStack(spacing: 6) {
      LaneActionButton(title: "", symbol: "minus", tint: ADEColor.textSecondary) {
        zoom = clampedZoom(zoom - 0.2)
      }
      .accessibilityLabel("Zoom out")

      Button {
        zoom = 1.0
      } label: {
        Text(zoomPercentLabel)
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textSecondary)
          .padding(EdgeInsets(top: 7, leading: 10, bottom: 7, trailing: 10))
          .background(ADEColor.surfaceBackground.opacity(0.55), in: Capsule())
          .glassEffect()
          .overlay(
            Capsule()
              .stroke(ADEColor.border.opacity(0.16), lineWidth: 0.5)
          )
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Reset zoom")

      LaneActionButton(title: "", symbol: "plus", tint: ADEColor.textSecondary) {
        zoom = clampedZoom(zoom + 0.2)
      }
      .accessibilityLabel("Zoom in")
    }
  }

  private var zoomPercentLabel: String {
    let pct = Int((clampedZoom(zoom) * 100).rounded())
    return "\(pct)%"
  }

  private func clampedZoom(_ value: CGFloat) -> CGFloat {
    min(max(value, minZoom), maxZoom)
  }

  // MARK: - Node rendering

  private func nodeView(node: LaneCanvasNode) -> some View {
    let snapshot = node.snapshot
    let isCurrent = selectedLaneId == snapshot.lane.id
    let lane = snapshot.lane
    return Button {
      onSelectLane(lane)
      dismiss()
    } label: {
      VStack(alignment: .leading, spacing: 6) {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          Text(lane.name)
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
            .truncationMode(.tail)
          Spacer(minLength: 4)
          if isCurrent {
            LaneMicroChip(icon: "checkmark.circle.fill", text: "Current", tint: ADEColor.accent)
          }
        }
        Text(lane.branchRef)
          .font(.system(.caption, design: .monospaced))
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(1)
          .truncationMode(.middle)
        let chips = statusChips(for: lane)
        if !chips.isEmpty {
          HStack(spacing: 4) {
            ForEach(chips) { chip in
              LaneMicroChip(icon: chip.icon, text: chip.text, tint: chip.tint)
            }
          }
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .frame(minHeight: nodeMinHeight, alignment: .topLeading)
      .adeGlassCard(cornerRadius: 14, padding: 12)
      .overlay(
        RoundedRectangle(cornerRadius: 14, style: .continuous)
          .stroke(isCurrent ? ADEColor.accent.opacity(0.55) : Color.clear, lineWidth: 1)
      )
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(lane.name), \(lane.branchRef)\(isCurrent ? ", current lane" : "")")
  }

  private func statusChips(for lane: LaneSummary) -> [LaneStatusChipModel] {
    var chips: [LaneStatusChipModel] = []
    if lane.status.ahead > 0 {
      chips.append(LaneStatusChipModel(id: "ahead", icon: "arrow.up", text: "\(lane.status.ahead)", tint: ADEColor.success))
    }
    if lane.status.behind > 0 {
      chips.append(LaneStatusChipModel(id: "behind", icon: "arrow.down", text: "\(lane.status.behind)", tint: ADEColor.warning))
    }
    if lane.status.dirty {
      chips.append(LaneStatusChipModel(id: "dirty", icon: "circle.fill", text: "dirty", tint: ADEColor.warning))
    }
    return chips
  }

  // MARK: - Connectors

  private func connectors(layout: LaneCanvasLayout) -> some View {
    let nodeMap = Dictionary(uniqueKeysWithValues: layout.nodes.map { ($0.snapshot.lane.id, $0) })
    return ForEach(layout.nodes) { node in
      if let parentId = node.snapshot.lane.parentLaneId, let parent = nodeMap[parentId] {
        ConnectorPath(parentFrame: parent.frame, childFrame: node.frame)
          .stroke(ADEColor.glassBorder, lineWidth: 1)
      }
    }
  }

  // MARK: - Layout computation

  private func computeLayout() -> LaneCanvasLayout {
    let ordered = orderedSnapshots()
    var nodes: [LaneCanvasNode] = []
    var maxWidth: CGFloat = 0
    var y: CGFloat = 0

    let depths = depthMap(for: ordered)
    for snapshot in ordered {
      let depth = depths[snapshot.lane.id] ?? 0
      let x = CGFloat(depth) * indentStep
      let frame = CGRect(x: x, y: y, width: nodeWidth, height: nodeMinHeight)
      nodes.append(LaneCanvasNode(snapshot: snapshot, depth: depth, frame: frame))
      maxWidth = max(maxWidth, x + nodeWidth)
      y += nodeMinHeight + rowSpacing
    }

    let height = max(nodeMinHeight, y - rowSpacing)
    return LaneCanvasLayout(nodes: nodes, size: CGSize(width: maxWidth, height: height))
  }

  private func depthMap(for snapshots: [LaneListSnapshot]) -> [String: Int] {
    let visible = Set(snapshots.map(\.lane.id))
    let laneById = Dictionary(uniqueKeysWithValues: snapshots.map { ($0.lane.id, $0.lane) })
    var memo: [String: Int] = [:]

    func depth(_ id: String, visiting: Set<String> = []) -> Int {
      if let cached = memo[id] { return cached }
      if visiting.contains(id) { return 0 }
      guard visible.contains(id), let lane = laneById[id] else {
        memo[id] = 0
        return 0
      }
      if lane.laneType == "primary" {
        memo[id] = 0
        return 0
      }
      guard let parentId = lane.parentLaneId, parentId != id, visible.contains(parentId) else {
        memo[id] = 0
        return 0
      }
      var next = visiting
      next.insert(id)
      let value = depth(parentId, visiting: next) + 1
      memo[id] = value
      return value
    }

    for snapshot in snapshots {
      _ = depth(snapshot.lane.id)
    }
    return memo
  }

  private func orderedSnapshots() -> [LaneListSnapshot] {
    let childrenByParent = Dictionary(grouping: snapshots) { snapshot in
      snapshot.lane.parentLaneId ?? "__root__"
    }
    let primaryId = snapshots.first(where: { $0.lane.laneType == "primary" })?.lane.id

    func visit(parentId: String?) -> [LaneListSnapshot] {
      let key = parentId ?? "__root__"
      let children = (childrenByParent[key] ?? []).sorted { lhs, rhs in
        lhs.lane.createdAt < rhs.lane.createdAt
      }
      return children.flatMap { child in
        [child] + visit(parentId: child.lane.id)
      }
    }

    let primaryBranch = primaryId
      .flatMap { id in snapshots.first(where: { $0.lane.id == id }) }
      .map { [$0] + visit(parentId: $0.lane.id) } ?? []
    let seen = Set(primaryBranch.map(\.lane.id))
    let remaining = snapshots.filter { !seen.contains($0.lane.id) }
    let remainingIds = Set(remaining.map(\.lane.id))
    let roots = remaining
      .filter { snapshot in
        guard let parentLaneId = snapshot.lane.parentLaneId else { return true }
        return !remainingIds.contains(parentLaneId)
      }
      .sorted { $0.lane.createdAt < $1.lane.createdAt }
    let groupedRemaining = roots.flatMap { root in
      [root] + visit(parentId: root.lane.id).filter { remainingIds.contains($0.lane.id) }
    }
    return primaryBranch + groupedRemaining
  }
}

// MARK: - Layout types

private struct LaneCanvasLayout {
  let nodes: [LaneCanvasNode]
  let size: CGSize
}

private struct LaneCanvasNode: Identifiable {
  let snapshot: LaneListSnapshot
  let depth: Int
  let frame: CGRect

  var id: String { snapshot.lane.id }
}

private struct LaneStatusChipModel: Identifiable {
  let id: String
  let icon: String
  let text: String?
  let tint: Color
}

private struct ConnectorPath: Shape {
  let parentFrame: CGRect
  let childFrame: CGRect

  func path(in _: CGRect) -> Path {
    var path = Path()
    let startX = parentFrame.minX + 16
    let startY = parentFrame.maxY
    let elbowY = childFrame.midY
    let endX = childFrame.minX
    path.move(to: CGPoint(x: startX, y: startY))
    path.addLine(to: CGPoint(x: startX, y: elbowY))
    path.addLine(to: CGPoint(x: endX, y: elbowY))
    return path
  }
}
