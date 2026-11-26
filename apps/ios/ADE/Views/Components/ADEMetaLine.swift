import SwiftUI

/// A row's meta items, joined by "·". A line breaks only between items, so
/// "Deleted 13m ago" never splits across two lines (the desktop's
/// `MetaLine`). An item wider than the row still wraps inside itself.
struct ADEMetaLine: View {
  let parts: [String]

  var body: some View {
    ADEMetaFlowLayout {
      ForEach(Array(parts.enumerated()), id: \.offset) { index, part in
        // A no-break space keeps the "·" on its item's last line.
        Text(index < parts.count - 1 ? "\(part)\u{00A0}·" : part)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(parts.joined(separator: ", "))
  }
}

/// Places items left to right and starts a new line when the next one does
/// not fit. An item wider than the row wraps and gets the whole line. Lines
/// sit flush, like the lines of one wrapped text.
///
/// `LaneChipFlowLayout` and `CloudFlowRow` stay separate: their chips sit on
/// spaced lines, never wrap inside themselves, and take the whole width they
/// are offered.
private struct ADEMetaFlowLayout: Layout {
  /// About one space of the caption font, after each "·".
  var spacing: CGFloat = 4

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Void) -> CGSize {
    let lines = lines(maxWidth: proposal.width ?? .infinity, subviews: subviews)
    let width = lines.map(\.width).max() ?? 0
    return CGSize(width: proposal.width.map { min($0, width) } ?? width, height: lines.reduce(0) { $0 + $1.height })
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Void) {
    var y = bounds.minY
    for line in lines(maxWidth: bounds.width, subviews: subviews) {
      var x = bounds.minX
      for item in line.items {
        subviews[item.index].place(at: CGPoint(x: x, y: y), anchor: .topLeading, proposal: ProposedViewSize(item.size))
        x += item.size.width + spacing
      }
      y += line.height
    }
  }

  private struct Line {
    var items: [(index: Int, size: CGSize)] = []
    var width: CGFloat = 0
    var height: CGFloat = 0
  }

  private func lines(maxWidth: CGFloat, subviews: Subviews) -> [Line] {
    var lines: [Line] = []
    var current = Line()
    for index in subviews.indices {
      let size = subviews[index].sizeThatFits(.unspecified)
      if size.width > maxWidth {
        if !current.items.isEmpty { lines.append(current) }
        let wrapped = subviews[index].sizeThatFits(ProposedViewSize(width: maxWidth, height: nil))
        lines.append(Line(items: [(index, wrapped)], width: wrapped.width, height: wrapped.height))
        current = Line()
        continue
      }
      let projected = current.items.isEmpty ? size.width : current.width + spacing + size.width
      if projected > maxWidth && !current.items.isEmpty {
        lines.append(current)
        current = Line(items: [(index, size)], width: size.width, height: size.height)
      } else {
        current.items.append((index, size))
        current.width = projected
        current.height = max(current.height, size.height)
      }
    }
    if !current.items.isEmpty { lines.append(current) }
    return lines
  }
}
