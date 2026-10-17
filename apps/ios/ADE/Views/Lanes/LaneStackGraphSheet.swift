import SwiftUI

struct LaneStackGraphSheet: View {
  @Environment(\.dismiss) private var dismiss

  let snapshots: [LaneListSnapshot]
  let selectedLaneId: String

  private var orderedSnapshots: [LaneListSnapshot] {
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

    let primaryBranch = primaryId.flatMap { id in snapshots.first(where: { $0.lane.id == id }) }.map { [$0] + visit(parentId: $0.lane.id) } ?? []
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

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: 14) {
          LaneFormSection(title: "Stack graph") {
            LaneChoiceList(items: orderedSnapshots) { snapshot in
                HStack(alignment: .top, spacing: 12) {
                  HStack(spacing: 0) {
                    if snapshot.lane.stackDepth > 0 {
                      Rectangle()
                        .fill(ADEKit.rule)
                        .frame(width: CGFloat(snapshot.lane.stackDepth) * 12, height: 1)
                        .padding(.top, 10)
                    }
                    Circle()
                      .fill(LaneColorPalette.displayColor(forHex: snapshot.lane.color, fallback: ADEColor.textMuted))
                      .frame(width: 8, height: 8)
                      .padding(.top, 6)
                  }
                  VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 8) {
                      Text(snapshot.lane.name)
                        .font(.subheadline.weight(snapshot.lane.id == selectedLaneId ? .semibold : .regular))
                        .foregroundStyle(ADEColor.textPrimary)
                        .lineLimit(1)
                      if snapshot.lane.id == selectedLaneId {
                        Image(systemName: "checkmark")
                          .font(.system(size: 12, weight: .semibold))
                          .foregroundStyle(ADEColor.accent)
                          .accessibilityLabel("Current")
                      }
                    }
                    Text(normalizedPrBranchName(snapshot.lane.branchRef))
                      .font(.adeMono(11))
                      .foregroundStyle(ADEColor.textMuted)
                  }
                  Spacer()
                }
                .padding(.vertical, 8)
            }
          }
        }
        .padding(16)
      }
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("Stack graph")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }
        }
      }
    }
  }
}
