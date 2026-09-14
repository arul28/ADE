import SwiftUI

/// Four compact status cards. Default is All; tapping another card filters the
/// project tree without leaving Hub. Icons and hues come from the same Activity
/// table as the row glyphs, so Working stays blue dotted-circle, Needs you stays
/// amber filled-dot, Finished uses Done's check.
struct HubRosterFilterBar: View {
  let counts: [HubRosterFilter: Int]
  @Binding var selection: HubRosterFilter

  var body: some View {
    HStack(spacing: 8) {
      ForEach(HubRosterFilter.allCases) { filter in
        HubRosterFilterCard(
          filter: filter,
          count: counts[filter, default: 0],
          selected: selection == filter
        ) {
          guard selection != filter else { return }
          ADEHaptics.light()
          withAnimation(.spring(response: 0.32, dampingFraction: 0.86)) {
            selection = filter
          }
        }
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Chat filters")
    .sensoryFeedback(.selection, trigger: selection)
  }
}

private struct HubRosterFilterCard: View {
  let filter: HubRosterFilter
  let count: Int
  let selected: Bool
  let action: () -> Void

  private var tint: Color {
    filter.tone.map(activityToneColor) ?? ADEColor.accent
  }

  var body: some View {
    Button(action: action) {
      VStack(alignment: .leading, spacing: 6) {
        HStack(spacing: 4) {
          Image(systemName: filter.systemImage)
            .font(.system(size: 11, weight: .semibold))
          Spacer(minLength: 0)
          Text("\(count)")
            .font(.system(.subheadline, design: .rounded).weight(.semibold).monospacedDigit())
            .contentTransition(.numericText())
        }
        .foregroundStyle(selected ? tint : ADEColor.textSecondary)

        Text(filter.title)
          .font(.system(size: 11, weight: .semibold, design: .rounded))
          .foregroundStyle(selected ? ADEColor.textPrimary : ADEColor.textMuted)
          .lineLimit(1)
          .minimumScaleFactor(0.85)
      }
      .padding(.horizontal, 9)
      .padding(.vertical, 8)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(
        selected ? tint.opacity(0.16) : ADEColor.cardBackground.opacity(0.62),
        in: RoundedRectangle(cornerRadius: 12, style: .continuous)
      )
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .stroke(selected ? tint.opacity(0.45) : ADEColor.border.opacity(0.8), lineWidth: selected ? 1.2 : 1)
      )
    }
    .buttonStyle(HubRosterFilterCardButtonStyle())
    .accessibilityLabel("\(filter.accessibilityTitle), \(count)")
    .accessibilityAddTraits(selected ? .isSelected : [])
    .accessibilityHint("Shows matching chats from every project.")
  }
}

private struct HubRosterFilterCardButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .scaleEffect(configuration.isPressed ? 0.97 : 1)
      .animation(.spring(response: 0.22, dampingFraction: 0.78), value: configuration.isPressed)
  }
}

struct HubRosterFilterEmptyState: View {
  let filter: HubRosterFilter

  var body: some View {
    VStack(spacing: 8) {
      Image(systemName: filter.systemImage)
        .font(.system(size: 22, weight: .semibold))
        .foregroundStyle(
          filter.tone.map(activityToneColor) ?? ADEColor.textMuted
        )
      Text(filter.emptyTitle)
        .font(.system(.subheadline, design: .rounded).weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
      Text(filter.emptyMessage)
        .font(.system(.caption, design: .rounded))
        .foregroundStyle(ADEColor.textMuted)
        .multilineTextAlignment(.center)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 28)
    .padding(.horizontal, 16)
  }
}
