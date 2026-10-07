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
    self.subMetric = subMetric
    self.indent = indent
    self.isRoot = isRoot
    self.isLast = isLast
  }
}

/// Vertical-rail PR stack. Each row carries a thin rail in the PR's GitHub
/// state colour (open green, draft neutral, blocked red, base neutral). Branch
/// is mono, state is a tinted tag.
struct PrStackDiagramView: View {
  let nodes: [PrStackNode]

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      ForEach(nodes) { node in
        PrStackDiagramRow(node: node)
      }
    }
    .padding(.vertical, 4)
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

private struct PrStackDiagramRow: View {
  let node: PrStackNode

  private var stateColor: Color {
    switch node.state {
    case "open": return prStateColor("open")
    case "blocked": return prStateColor("closed")
    default: return ADEColor.textMuted
    }
  }

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      RoundedRectangle(cornerRadius: 1.5, style: .continuous)
        .fill(stateColor)
        .frame(width: 3)

      VStack(alignment: .leading, spacing: 4) {
        HStack(spacing: 6) {
          Text(node.label)
            .font(.system(size: 13, weight: node.isRoot ? .semibold : .medium))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
          if let adeKind = node.adeKind, !adeKind.isEmpty {
            ADEKitTag(text: adeKind)
          }
          Spacer(minLength: 0)
          Text(node.state.uppercased())
            .font(.system(size: 9.5, weight: .semibold, design: .monospaced))
            .tracking(0.5)
            .foregroundStyle(stateColor)
            .padding(.horizontal, 6)
            .frame(height: 18)
            .background(stateColor.opacity(0.14), in: RoundedRectangle(cornerRadius: 4, style: .continuous))
        }
        Text(node.branch)
          .font(.adeMono(11))
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
        if let sub = node.subMetric {
          Text(sub)
            .font(.adeMono(10.5))
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
        }
      }
      .padding(.leading, CGFloat(node.indent) * 14)
    }
    .padding(.horizontal, ADEKit.inset)
    .padding(.vertical, 8)
  }
}

#Preview("PrStackDiagramView") {
  PrStackDiagramView(nodes: [
    PrStackNode(id: "1", label: "main", branch: "origin/main", state: "base", subMetric: "HEAD", isRoot: true),
    PrStackNode(id: "2", label: "#309 · Schema migration v3", branch: "integration/schema-v3", state: "open", adeKind: "integration", subMetric: "base · awaiting 1 child", indent: 0, isRoot: true),
    PrStackNode(id: "3", label: "#316 · Fix auth middleware ordering", branch: "lane/auth-fix", state: "open", adeKind: "worker", subMetric: "12 ✓ · 1 approval · ready", indent: 1),
    PrStackNode(id: "4", label: "#315 · Add payments idempotency", branch: "lane/payments", state: "draft", adeKind: "lane", subMetric: "8 ✓ · draft", indent: 1),
    PrStackNode(id: "5", label: "#318 · Rename preferences", branch: "lane/rename-prefs", state: "blocked", adeKind: "lane", subMetric: "2 ✗ · blocked", indent: 1, isLast: true),
  ])
  .adeKitCard(padding: nil)
  .padding()
  .background(ADEColor.pageBackground)
}
