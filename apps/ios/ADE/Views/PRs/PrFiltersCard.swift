import SwiftUI

struct PrFiltersCard: View {
  @Binding var stateFilter: PrListStateFilter
  let visibleCount: Int
  let totalCount: Int
  let isLive: Bool
  let onRefresh: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        VStack(alignment: .leading, spacing: 4) {
          Text("PR list")
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
          Text("\(visibleCount) of \(totalCount) pull requests visible")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }

        Spacer(minLength: 12)

        if !isLive {
          ADEStatusPill(text: "CACHED", tint: ADEColor.warning)
        }

        Button(action: onRefresh) {
          Image(systemName: "arrow.clockwise")
            .font(.body.weight(.semibold))
        }
        .buttonStyle(.glass)
        .tint(ADEColor.accent)
      }

      HStack(spacing: 12) {
        Label("State", systemImage: "line.3.horizontal.decrease.circle")
          .font(.caption.weight(.medium))
          .foregroundStyle(ADEColor.textSecondary)
        Picker("State", selection: $stateFilter) {
          ForEach(PrListStateFilter.allCases) { filter in
            Text(filter.title).tag(filter)
          }
        }
        .pickerStyle(.menu)
        Spacer(minLength: 0)
      }
      .adeInsetField(cornerRadius: 14, padding: 12)
    }
    .adeGlassCard(cornerRadius: 18)
  }
}

struct PrSignalChip: View {
  let icon: String
  let text: String
  let tint: Color

  var body: some View {
    HStack(spacing: 6) {
      Image(systemName: icon)
        .font(.caption2.weight(.bold))
      Text(text)
        .font(.caption2.weight(.semibold))
    }
    .foregroundStyle(tint)
  }
}
