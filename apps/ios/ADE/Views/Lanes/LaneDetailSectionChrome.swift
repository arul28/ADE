import SwiftUI

// MARK: - Wrapping chip flow

/// Lightweight flow layout: lays subviews left-to-right and wraps onto a new
/// line when the next subview would overflow the available width. Used for the
/// lane-detail header chip row and the git action buttons so they wrap instead
/// of horizontally scrolling.
struct LaneChipFlowLayout: Layout {
  var spacing: CGFloat = 6
  var lineSpacing: CGFloat = 6

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Void) -> CGSize {
    let maxWidth = proposal.width ?? .infinity
    let rows = computeRows(maxWidth: maxWidth, subviews: subviews)
    let height = rows.reduce(0) { $0 + $1.height } + CGFloat(max(0, rows.count - 1)) * lineSpacing
    let width = proposal.width ?? rows.map(\.width).max() ?? 0
    return CGSize(width: width, height: height)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Void) {
    let rows = computeRows(maxWidth: bounds.width, subviews: subviews)
    var y = bounds.minY
    for row in rows {
      var x = bounds.minX
      for index in row.indices {
        let size = subviews[index].sizeThatFits(.unspecified)
        subviews[index].place(at: CGPoint(x: x, y: y), anchor: .topLeading, proposal: ProposedViewSize(size))
        x += size.width + spacing
      }
      y += row.height + lineSpacing
    }
  }

  private struct Row {
    var indices: [Int] = []
    var width: CGFloat = 0
    var height: CGFloat = 0
  }

  private func computeRows(maxWidth: CGFloat, subviews: Subviews) -> [Row] {
    var rows: [Row] = []
    var current = Row()
    for index in subviews.indices {
      let size = subviews[index].sizeThatFits(.unspecified)
      let projected = current.indices.isEmpty ? size.width : current.width + spacing + size.width
      if projected > maxWidth && !current.indices.isEmpty {
        rows.append(current)
        current = Row(indices: [index], width: size.width, height: size.height)
      } else {
        if !current.indices.isEmpty { current.width += spacing }
        current.indices.append(index)
        current.width += size.width
        current.height = max(current.height, size.height)
      }
    }
    if !current.indices.isEmpty { rows.append(current) }
    return rows
  }
}

// MARK: - Collapsible section disclosure state

/// Tracks expand/collapse for a lane-detail section. The auto rule: a section
/// with content opens expanded, an empty one opens collapsed. `syncAuto` re-runs
/// as data hydrates until the user manually toggles, after which their choice
/// sticks.
struct LaneSectionDisclosure {
  var expanded = false
  private var pinnedByUser = false

  mutating func syncAuto(hasContent: Bool) {
    guard !pinnedByUser else { return }
    expanded = hasContent
  }

  mutating func toggle() {
    expanded.toggle()
    pinnedByUser = true
  }
}
