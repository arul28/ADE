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
    kindColor: Color = PrGlassPalette.purple,
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

/// Vertical-rail PR stack. Each row carries a 4pt accent rail tinted by
/// state (green=open, amber=draft, danger=blocked, purple=base) with a soft
/// glow. Branch is mono, state is a tinted pill.
struct PrStackDiagramView: View {
  let nodes: [PrStackNode]

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      ForEach(nodes) { node in
        PrStackDiagramRow(node: node)
      }
    }
    .padding(.vertical, 6)
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

private struct PrStackDiagramRow: View {
  let node: PrStackNode

  private var stateColor: Color {
    switch node.state {
    case "open": return PrGlassPalette.success
    case "draft": return PrGlassPalette.warning
    case "blocked": return PrGlassPalette.danger
    case "base": return PrGlassPalette.purple
    default: return PrGlassPalette.blue
    }
  }

  private var stateLabel: String {
    switch node.state {
    case "open": return "open"
    case "draft": return "draft"
    case "blocked": return "blocked"
    case "base": return "base"
    default: return node.state
    }
  }

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      // 4pt accent rail tinted by state.
      RoundedRectangle(cornerRadius: 2.5, style: .continuous)
        .fill(
          LinearGradient(
            colors: [stateColor, stateColor.opacity(0.55)],
            startPoint: .top,
            endPoint: .bottom
          )
        )
        .frame(width: 4)
        .shadow(color: stateColor.opacity(0.55), radius: 7, x: 0, y: 0)

      VStack(alignment: .leading, spacing: 4) {
        HStack(spacing: 6) {
          Text(node.label)
            .font(.system(size: node.isRoot ? 14 : 13, weight: node.isRoot ? .bold : .semibold))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
          if let adeKind = node.adeKind, !adeKind.isEmpty {
            PrTagChip(label: adeKind, color: node.kindColor)
          }
          Spacer(minLength: 0)
          PrStackStatePill(state: stateLabel, color: stateColor)
        }
        Text(node.branch)
          .font(.system(size: 11, weight: .medium, design: .monospaced))
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
        if let sub = node.subMetric {
          Text(sub)
            .font(.system(size: 10.5, design: .monospaced))
            .foregroundStyle(stateColor.opacity(0.95))
            .lineLimit(1)
        }
      }
      .padding(.leading, CGFloat(node.indent) * 14)
    }
    .padding(.horizontal, 2)
    .padding(.vertical, 8)
  }
}

private struct PrStackStatePill: View {
  let state: String
  let color: Color

  var body: some View {
    Text(state.uppercased())
      .font(.system(size: 9, weight: .bold))
      .tracking(0.8)
      .foregroundStyle(color)
      .padding(.horizontal, 8)
      .padding(.vertical, 3)
      .background(
        Capsule(style: .continuous)
          .fill(color.opacity(0.16))
      )
      .overlay(
        Capsule(style: .continuous)
          .strokeBorder(color.opacity(0.45), lineWidth: 0.5)
      )
  }
}

#Preview("PrStackDiagramView") {
  PrStackDiagramView(nodes: [
    PrStackNode(id: "1", label: "main", branch: "origin/main", state: "base", subMetric: "HEAD", isRoot: true),
    PrStackNode(id: "2", label: "#309 · Schema migration v3", branch: "integration/schema-v3", state: "open", adeKind: "integration", kindColor: PrGlassPalette.warning, subMetric: "base · awaiting 1 child", indent: 0, isRoot: true),
    PrStackNode(id: "3", label: "#316 · Fix auth middleware ordering", branch: "lane/auth-fix", state: "open", adeKind: "worker", kindColor: PrGlassPalette.purple, subMetric: "12 ✓ · 1 approval · ready", indent: 1),
    PrStackNode(id: "4", label: "#315 · Add payments idempotency", branch: "lane/payments", state: "draft", adeKind: "lane", kindColor: PrGlassPalette.success, subMetric: "8 ✓ · draft", indent: 1),
    PrStackNode(id: "5", label: "#318 · Rename preferences", branch: "lane/rename-prefs", state: "blocked", adeKind: "mission", kindColor: PrGlassPalette.purpleBright, subMetric: "2 ✗ · blocked", indent: 1, isLast: true),
  ])
  .padding()
  .background(PrGlassPalette.ink)
}
