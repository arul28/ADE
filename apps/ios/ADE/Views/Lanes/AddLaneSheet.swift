import SwiftUI

struct AddLaneSheet: View {
  @Environment(\.dismiss) private var dismiss

  let primaryLane: LaneSummary?
  let lanes: [LaneSummary]
  let onLaneCreated: @MainActor (String) async -> Void

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: 12) {
          LaneCreateOptionLink(
            symbol: "plus.square.on.square",
            symbolTint: ADEColor.accent,
            title: "New lane",
            subtitle: "Start from the primary branch"
          ) {
            LaneCreateSheet(
              primaryLane: primaryLane,
              lanes: lanes,
              initialMode: .primary,
              showsModePicker: false,
              onComplete: handleCreate
            )
          }

          LaneCreateOptionLink(
            symbol: "arrow.triangle.branch",
            symbolTint: ADEColor.accent,
            title: "From existing branch",
            subtitle: "Import an existing git branch"
          ) {
            LaneCreateSheet(
              primaryLane: primaryLane,
              lanes: lanes,
              initialMode: .importBranch,
              showsModePicker: false,
              onComplete: handleCreate
            )
          }

          LaneCreateOptionLink(
            symbol: "square.stack.3d.up",
            symbolTint: ADEColor.purpleAccent,
            title: "Child lane",
            subtitle: "Stack on top of another lane"
          ) {
            LaneCreateSheet(
              primaryLane: primaryLane,
              lanes: lanes,
              initialMode: .child,
              showsModePicker: false,
              onComplete: handleCreate
            )
          }

          LaneCreateOptionLink(
            symbol: "cross.case",
            symbolTint: ADEColor.warning,
            title: "Rescue unstaged",
            subtitle: "Move dirty changes into a new lane"
          ) {
            LaneCreateSheet(
              primaryLane: primaryLane,
              lanes: lanes,
              initialMode: .rescueUnstaged,
              showsModePicker: false,
              onComplete: handleCreate
            )
          }

          LaneCreateOptionLink(
            symbol: "link",
            symbolTint: ADEColor.textSecondary,
            title: "Attach worktree",
            subtitle: "Register an existing worktree as a lane"
          ) {
            AddLaneAttachRoute(onComplete: handleCreate)
          }

          LaneCreateOptionLink(
            symbol: "square.stack.3d.down.right",
            symbolTint: ADEColor.tintLanes,
            title: "Attach multiple worktrees",
            subtitle: "Discover existing worktrees and attach them in bulk"
          ) {
            AddLaneMultiAttachRoute(onComplete: handleCreate)
          }
        }
        .padding(16)
      }
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("Add lane")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
      }
    }
  }

  @MainActor
  private func handleCreate(_ laneId: String) async {
    ADEHaptics.success()
    await onLaneCreated(laneId)
  }
}

private struct LaneCreateOptionLink<Destination: View>: View {
  let symbol: String
  let symbolTint: Color
  let title: String
  let subtitle: String
  @ViewBuilder let destination: () -> Destination

  var body: some View {
    NavigationLink {
      destination()
    } label: {
      HStack(alignment: .center, spacing: 14) {
        Image(systemName: symbol)
          .font(.system(size: 18, weight: .semibold))
          .foregroundStyle(symbolTint)
          .frame(width: 44, height: 44)
          .background(symbolTint.opacity(0.14), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
          .glassEffect(in: .rect(cornerRadius: 12))

        VStack(alignment: .leading, spacing: 3) {
          Text(title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text(subtitle)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(2)
        }

        Spacer(minLength: 0)

        Image(systemName: "chevron.right")
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textMuted)
      }
      .padding(14)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(ADEColor.surfaceBackground.opacity(0.08), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
      .glassEffect(in: .rect(cornerRadius: 16))
      .overlay(
        RoundedRectangle(cornerRadius: 16, style: .continuous)
          .stroke(ADEColor.border.opacity(0.18), lineWidth: 0.75)
      )
    }
    .buttonStyle(ADEScaleButtonStyle())
    .accessibilityLabel("\(title). \(subtitle)")
  }
}

private struct AddLaneAttachRoute: View {
  let onComplete: @MainActor (String) async -> Void

  var body: some View {
    LaneAttachSheet(onComplete: onComplete, wrapsInNavigationStack: false)
  }
}

private struct AddLaneMultiAttachRoute: View {
  let onComplete: @MainActor (String) async -> Void

  var body: some View {
    LaneMultiAttachSheet(onComplete: onComplete, wrapsInNavigationStack: false)
  }
}
