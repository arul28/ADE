import SwiftUI

/// The five chips: All · Needs you · Working · Waiting · Done, on one quiet kit
/// track (`ADEKitCountSegments`). The Hub filters its project tree with it and
/// the Activity drawer filters its Sessions list, so both read the same four
/// states. The glyphs keep the column hues (meaning); counts and labels stay
/// neutral.
struct HubRosterFilterBar: View {
  let counts: [HubRosterFilter: Int]
  @Binding var selection: HubRosterFilter
  var accessibilityTitle = "Chat filters"
  var accessibilityHintText = "Shows matching chats from every project."

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
    .accessibilityLabel(accessibilityTitle)
    .accessibilityHint(accessibilityHintText)
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

extension HubRosterFilter {
  /// All gets the total; each column gets its own count.
  static func counts(from columns: [ActivityBoardColumn: Int]) -> [HubRosterFilter: Int] {
    Dictionary(uniqueKeysWithValues: allCases.map { filter in
      guard let column = filter.column else { return (filter, columns.values.reduce(0, +)) }
      return (filter, columns[column, default: 0])
    })
  }
}
