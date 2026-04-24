import SwiftUI

/// Minimal `@`-mention picker. The desktop composer surfaces file paths, lanes, and recent
/// context as autocomplete targets; the iOS v1 keeps scope tight and offers lanes only, so users
/// can reference a lane by name without typing it. Tapping a row returns `@{lane-name}` to the
/// composer via `onInsert` and dismisses.
struct WorkMentionsPickerSheet: View {
  let lanes: [LaneSummary]
  let onInsert: (String) -> Void

  @Environment(\.dismiss) private var dismiss
  @State private var query: String = ""

  private var filteredLanes: [LaneSummary] {
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if trimmed.isEmpty { return lanes }
    return lanes.filter { $0.name.lowercased().contains(trimmed) }
  }

  var body: some View {
    NavigationStack {
      List {
        Section("Lanes") {
          if filteredLanes.isEmpty {
            Text(lanes.isEmpty ? "No lanes available." : "No lanes match \"\(query)\".")
              .font(.footnote)
              .foregroundStyle(ADEColor.textMuted)
          } else {
            ForEach(filteredLanes) { lane in
              Button {
                onInsert("@\(lane.name)")
              } label: {
                HStack(spacing: 10) {
                  Image(systemName: "arrow.triangle.branch")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(ADEColor.accent)
                  Text(lane.name)
                    .foregroundStyle(ADEColor.textPrimary)
                  Spacer()
                  if lane.status.dirty {
                    Circle().fill(ADEColor.warning).frame(width: 6, height: 6)
                  }
                }
              }
              .buttonStyle(.plain)
            }
          }
        }
      }
      .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search lanes")
      .navigationTitle("Mention")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button("Cancel") { dismiss() }
        }
      }
    }
    .presentationDetents([.medium, .large])
  }
}
