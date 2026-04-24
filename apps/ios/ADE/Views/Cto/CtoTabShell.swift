import SwiftUI

enum CtoTab: String, CaseIterable, Identifiable {
  case team
  case workflows
  case settings

  var id: String { rawValue }

  var label: String {
    switch self {
    case .team: return "Team"
    case .workflows: return "Workflows"
    case .settings: return "Settings"
    }
  }
}

/// Compact segmented picker used at the top of every CTO tab.
struct CtoTabShell: View {
  @Binding var active: CtoTab

  var body: some View {
    segmented
      .padding(.horizontal, 12)
      .padding(.top, 0)
      .padding(.bottom, 6)
  }

  private var segmented: some View {
    HStack(spacing: 2) {
      ForEach(CtoTab.allCases) { tab in
        Button {
          if active != tab {
            withAnimation(.snappy(duration: 0.2)) { active = tab }
          }
        } label: {
          Text(tab.label)
            .font(.caption.weight(.semibold))
            .foregroundStyle(active == tab ? ADEColor.ctoAccent : ADEColor.textMuted)
            .frame(maxWidth: .infinity, minHeight: 44)
            .padding(.horizontal, 4)
            .background(
              RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(active == tab ? ADEColor.ctoAccent.opacity(0.14) : Color.clear)
            )
            .overlay(
              RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(active == tab ? ADEColor.ctoAccent.opacity(0.28) : Color.clear, lineWidth: 0.5)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(tab.label)
        .accessibilityAddTraits(active == tab ? [.isSelected] : [])
      }
    }
    .padding(3)
    .background(ADEColor.recessedBackground.opacity(0.55), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 11, style: .continuous)
        .stroke(ADEColor.glassBorder, lineWidth: 0.5)
    )
  }
}
