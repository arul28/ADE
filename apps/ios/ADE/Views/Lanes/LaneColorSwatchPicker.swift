import SwiftUI

struct LaneColorSwatchPicker: View {
  let selectedHex: String?
  let usedColors: Set<String>
  let onSelect: (String?) -> Void

  private let columns: [GridItem] = Array(repeating: GridItem(.flexible(), spacing: 10), count: 6)

  var body: some View {
    LazyVGrid(columns: columns, alignment: .leading, spacing: 10) {
      ForEach(LaneColorPalette.entries) { entry in
        let isSelected = selectedHex?.lowercased() == entry.hex.lowercased()
        let isTaken = !isSelected && usedColors.contains(entry.hex.lowercased())
        Button {
          onSelect(entry.hex)
        } label: {
          ZStack {
            Circle()
              .fill(entry.color)
              .frame(width: 30, height: 30)
              .opacity(isTaken ? 0.25 : 1)
              .overlay(
                Circle()
                  .stroke(Color.white.opacity(0.18), lineWidth: 1)
              )
            if isSelected {
              Circle()
                .stroke(ADEColor.textPrimary, lineWidth: 2)
                .frame(width: 36, height: 36)
            }
          }
        }
        .buttonStyle(.plain)
        .disabled(isTaken)
        .accessibilityLabel(entry.name + (isTaken ? " — in use" : ""))
        .accessibilityAddTraits(isSelected ? [.isSelected, .isButton] : [.isButton])
      }
      Button {
        onSelect(nil)
      } label: {
        ZStack {
          Circle()
            .fill(Color.clear)
            .frame(width: 30, height: 30)
            .overlay(
              Circle()
                .strokeBorder(Color.white.opacity(0.35), style: StrokeStyle(lineWidth: 1, dash: [3]))
            )
          Image(systemName: "xmark")
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(ADEColor.textSecondary)
          if selectedHex == nil {
            Circle()
              .stroke(ADEColor.textPrimary, lineWidth: 2)
              .frame(width: 36, height: 36)
          }
        }
      }
      .buttonStyle(.plain)
      .accessibilityLabel("No color")
    }
  }
}
