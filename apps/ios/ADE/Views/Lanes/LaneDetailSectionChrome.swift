import SwiftUI

extension LaneDetailScreen {
  @ViewBuilder
  func sectionHeader(title: String, symbol: String, subtitle: String? = nil, badge: String? = nil) -> some View {
    HStack(spacing: 8) {
      Image(systemName: symbol)
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(ADEColor.textSecondary)
      Text(title)
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
      if let badge {
        Text(badge)
          .font(.caption2.weight(.bold))
          .foregroundStyle(ADEColor.textMuted)
          .padding(.horizontal, 6)
          .padding(.vertical, 2)
          .background(ADEColor.surfaceBackground.opacity(0.5), in: Capsule())
      }
      Spacer()
      if let subtitle {
        Text(subtitle)
          .font(.caption2)
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(1)
      }
    }
  }
}

struct GlassDisclosureStyle: DisclosureGroupStyle {
  func makeBody(configuration: Configuration) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      Button {
        withAnimation(.smooth(duration: 0.25)) {
          configuration.isExpanded.toggle()
        }
      } label: {
        HStack {
          configuration.label
          Image(systemName: "chevron.right")
            .font(.caption2.weight(.bold))
            .foregroundStyle(ADEColor.textMuted)
            .rotationEffect(.degrees(configuration.isExpanded ? 90 : 0))
        }
      }
      .buttonStyle(.plain)

      if configuration.isExpanded {
        configuration.content
      }
    }
    .adeGlassCard(cornerRadius: 14, padding: 14)
  }
}
