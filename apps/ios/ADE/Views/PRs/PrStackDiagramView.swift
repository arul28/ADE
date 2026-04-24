import SwiftUI

/// A single node in the stacked-PR diagram. Populate `isRoot` for the
/// integration/base row and `isLast` for the last child so the rail can clip
/// its end. `indent == 0` for root nodes and `1+` for nested children; the
/// diagram multiplies it by a fixed unit to compute horizontal insets.
struct PrStackNode: Identifiable, Equatable {
  let id: String
  let label: String
  let branch: String
  /// One of: `"open"`, `"draft"`, `"blocked"`, `"base"`.
  let state: String
  let adeKind: String?
  let kindColor: Color
  let subMetric: String?
  let indent: Int
  let isRoot: Bool
  let isLast: Bool

  init(
    id: String,
    label: String,
    branch: String,
    state: String,
    adeKind: String? = nil,
    kindColor: Color = ADEColor.tintPRs,
    subMetric: String? = nil,
    indent: Int = 0,
    isRoot: Bool = false,
    isLast: Bool = false
  ) {
    self.id = id
    self.label = label
    self.branch = branch
    self.state = state
    self.adeKind = adeKind
    self.kindColor = kindColor
    self.subMetric = subMetric
    self.indent = indent
    self.isRoot = isRoot
    self.isLast = isLast
  }
}

/// Vertical rail + node dots for a stacked PR group. The rail uses a
/// violet→amber→blue gradient matching the mock; child nodes indent 18pt
/// with a horizontal connector back to the rail.
struct PrStackDiagramView: View {
  let nodes: [PrStackNode]

  private let railX: CGFloat = 11
  private let nodeGapX: CGFloat = 18

  var body: some View {
    ZStack(alignment: .topLeading) {
      // Rail
      LinearGradient(
        gradient: Gradient(colors: [
          ADEColor.tintPRs.opacity(0.55),
          ADEColor.warning.opacity(0.55),
          ADEColor.accent.opacity(0.55),
        ]),
        startPoint: .top,
        endPoint: .bottom
      )
      .frame(width: 1.5)
      .padding(.leading, railX)
      .padding(.vertical, 6)

      VStack(alignment: .leading, spacing: 14) {
        ForEach(nodes) { node in
          PrStackDiagramRow(node: node, nodeGapX: nodeGapX, railX: railX)
        }
      }
    }
    .padding(.leading, 24)
    .padding(.vertical, 8)
    .padding(.trailing, 8)
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

private struct PrStackDiagramRow: View {
  let node: PrStackNode
  let nodeGapX: CGFloat
  let railX: CGFloat

  private var stateColor: Color {
    switch node.state {
    case "open": return ADEColor.success
    case "draft": return ADEColor.textSecondary
    case "blocked": return ADEColor.danger
    case "base": return ADEColor.textSecondary
    default: return ADEColor.textSecondary
    }
  }

  var body: some View {
    HStack(alignment: .top, spacing: 0) {
      ZStack(alignment: .topLeading) {
        // Horizontal connector for indented children.
        if node.indent > 0 {
          Rectangle()
            .fill(ADEColor.tintPRs.opacity(0.4))
            .frame(width: CGFloat(node.indent) * nodeGapX + 4, height: 1.5)
            .offset(x: -(CGFloat(node.indent) * nodeGapX) + 4, y: 8)
        }
        // Node dot (aligned to the rail).
        Circle()
          .fill(stateColor.opacity(0.25))
          .overlay(
            Circle().strokeBorder(stateColor, lineWidth: 1.5)
          )
          .frame(width: 14, height: 14)
          .shadow(color: stateColor.opacity(0.35), radius: 3)
          .offset(x: -13, y: 2)
      }
      .frame(width: CGFloat(node.indent) * nodeGapX + 1, alignment: .leading)

      VStack(alignment: .leading, spacing: 3) {
        HStack(spacing: 6) {
          Text(node.label)
            .font(.system(size: node.isRoot ? 14 : 13, weight: node.isRoot ? .bold : .semibold))
            .foregroundColor(ADEColor.textPrimary)
            .lineLimit(1)
          if let adeKind = node.adeKind, !adeKind.isEmpty {
            PrTagChip(label: adeKind, color: node.kindColor)
          }
          Spacer(minLength: 0)
        }
        PrMonoText(text: node.branch, color: ADEColor.textSecondary, size: 10.5)
          .lineLimit(1)
        if let sub = node.subMetric {
          PrMonoText(text: sub, color: stateColor, size: 10.5)
            .lineLimit(1)
        }
      }
    }
  }
}

#Preview("PrStackDiagramView") {
  PrStackDiagramView(nodes: [
    PrStackNode(id: "1", label: "main", branch: "origin/main", state: "base", subMetric: "HEAD", isRoot: true),
    PrStackNode(id: "2", label: "#309 · Schema migration v3", branch: "integration/schema-v3", state: "open", adeKind: "integration", kindColor: ADEColor.warning, subMetric: "base · awaiting 1 child", indent: 0, isRoot: true),
    PrStackNode(id: "3", label: "#316 · Fix auth middleware ordering", branch: "lane/auth-fix", state: "open", adeKind: "worker", kindColor: ADEColor.accent, subMetric: "12 ✓ · 1 approval · ready", indent: 1),
    PrStackNode(id: "4", label: "#315 · Add payments idempotency", branch: "lane/payments", state: "draft", adeKind: "lane", kindColor: ADEColor.success, subMetric: "8 ✓ · draft", indent: 1),
    PrStackNode(id: "5", label: "#318 · Rename preferences", branch: "lane/rename-prefs", state: "blocked", adeKind: "mission", kindColor: ADEColor.tintPRs, subMetric: "2 ✗ · blocked", indent: 1, isLast: true),
  ])
  .padding()
  .background(ADEColor.pageBackground)
}
