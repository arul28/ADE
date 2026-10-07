import SwiftUI

/// The hub's status counts: All / Working / Needs you / Finished on one quiet
/// kit track (`ADEKitCountSegments`). Default is All; tapping another filters
/// the project tree without leaving Hub. The glyphs keep the Activity table's
/// hues (meaning); counts and labels stay neutral.
struct HubRosterFilterBar: View {
  let counts: [HubRosterFilter: Int]
  @Binding var selection: HubRosterFilter

  var body: some View {
    ADEKitCountSegments(
      options: HubRosterFilter.allCases.map { filter in
        let count = counts[filter, default: 0]
        return ADEKitCountOption(
          value: filter,
          symbol: filter.systemImage,
          // A state with nothing in it keeps a neutral glyph.
          tint: count > 0 ? filter.tone.map(activityToneColor) : nil,
          count: count,
          title: filter.title,
          accessibilityLabel: "\(filter.accessibilityTitle), \(count)"
        )
      },
      selection: selection
    ) { filter in
      guard selection != filter else { return }
      ADEHaptics.light()
      withAnimation(.snappy(duration: 0.2)) {
        selection = filter
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Chat filters")
    .accessibilityHint("Shows matching chats from every project.")
    .sensoryFeedback(.selection, trigger: selection)
  }
}

struct HubRosterFilterEmptyState: View {
  let filter: HubRosterFilter

  var body: some View {
    VStack(spacing: 8) {
      Image(systemName: filter.systemImage)
        .font(.system(size: 20, weight: .regular))
        .foregroundStyle(
          filter.tone.map(activityToneColor) ?? ADEColor.textMuted
        )
      Text(filter.emptyTitle)
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(ADEColor.textPrimary)
      Text(filter.emptyMessage)
        .font(.system(size: 12.5))
        .foregroundStyle(ADEColor.textSecondary)
        .multilineTextAlignment(.center)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 28)
    .padding(.horizontal, 16)
  }
}
