import SwiftUI

struct LaneStashesScreen: View {
  let laneName: String
  let stashes: [GitStashSummary]
  let canRunLiveActions: Bool
  let onCreateStash: (String) async -> Bool
  let onApply: (String) async -> Void
  let onPop: (String) async -> Void
  let onDrop: (String) async -> Void
  let onClearAll: () async -> Void

  @State private var stashMessage = ""

  var body: some View {
    ScrollView {
      VStack(spacing: 14) {
        composerCard
        if stashes.count > 1 {
          ADEGlassHoldActionButton(title: "Clear all stashes", symbol: "trash", tint: ADEColor.danger) {
            Task { await onClearAll() }
          }
          .disabled(!canRunLiveActions)
          .frame(maxWidth: .infinity, alignment: .center)
        }
        if stashes.isEmpty {
          emptyState
        } else {
          ADEGlassSection(title: "Stashes", subtitle: "\(stashes.count) stash\(stashes.count == 1 ? "" : "es")") {
            VStack(alignment: .leading, spacing: 12) {
              ForEach(Array(stashes.enumerated()), id: \.element.id) { index, stash in
                stashRow(stash: stash)
                if index < stashes.count - 1 {
                  Divider().opacity(0.35)
                }
              }
            }
          }
        }
      }
      .padding(EdgeInsets(top: 14, leading: 16, bottom: 14, trailing: 16))
    }
    .background(ADEColor.surfaceBackground.ignoresSafeArea())
    .navigationTitle("\(laneName) stashes")
    .navigationBarTitleDisplayMode(.inline)
  }

  private var composerCard: some View {
    ADEGlassSection(title: "New stash", subtitle: "Move unsaved changes aside without losing them.") {
      VStack(spacing: 10) {
        TextField("Optional message", text: $stashMessage)
          .textFieldStyle(.plain)
          .frame(maxWidth: .infinity, alignment: .leading)
          .adeInsetField(cornerRadius: 10, padding: 10)
          .disabled(!canRunLiveActions)
        Button {
          let msg = stashMessage
          Task {
            if await onCreateStash(msg) {
              stashMessage = ""
            }
          }
        } label: {
          HStack(spacing: 6) {
            Image(systemName: "tray.and.arrow.down")
              .font(.system(size: 13, weight: .semibold))
            Text("Stash")
              .font(.subheadline.weight(.semibold))
          }
          .frame(maxWidth: .infinity)
          .padding(.vertical, 11)
        }
        .buttonStyle(.glassProminent)
        .tint(ADEColor.accent)
        .disabled(!canRunLiveActions)
      }
    }
  }

  private var emptyState: some View {
    ADEEmptyStateView(
      symbol: "tray",
      title: "No stashes",
      message: "Stashes you create will appear here."
    )
  }

  private func stashRow(stash: GitStashSummary) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text(stash.subject)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Spacer()
        if let createdAt = stash.createdAt {
          Text(relativeTimestamp(createdAt))
            .font(.caption2)
            .foregroundStyle(ADEColor.textMuted)
        }
      }
      HStack(spacing: 10) {
        LaneActionButton(title: "Apply", symbol: "tray.and.arrow.up") {
          Task { await onApply(stash.ref) }
        }
        .disabled(!canRunLiveActions)
        LaneActionButton(title: "Pop", symbol: "arrow.up.right.square") {
          Task { await onPop(stash.ref) }
        }
        .disabled(!canRunLiveActions)
        LaneActionButton(title: "Drop", symbol: "trash", tint: ADEColor.danger) {
          Task { await onDrop(stash.ref) }
        }
        .disabled(!canRunLiveActions)
      }
    }
  }
}
