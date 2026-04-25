import SwiftUI

struct WorkSelectionActionBar: View {
  let selectedCount: Int
  let runningCount: Int
  let deletableCount: Int
  let archivableCount: Int
  let restorableCount: Int
  let busy: Bool
  let onClose: () -> Void
  let onArchive: () -> Void
  let onRestore: () -> Void
  let onDelete: () -> Void
  let onExport: () -> Void

  var body: some View {
    HStack(spacing: 8) {
      Text("\(selectedCount) selected")
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)
        .frame(maxWidth: .infinity, alignment: .leading)

      if runningCount > 0 {
        actionButton(
          systemImage: "stop.circle",
          label: "Close \(runningCount)",
          tint: ADEColor.warning,
          action: onClose
        )
      }
      if archivableCount > 0 {
        actionButton(
          systemImage: "archivebox",
          label: "Archive \(archivableCount)",
          tint: ADEColor.textSecondary,
          action: onArchive
        )
      }
      if restorableCount > 0 {
        actionButton(
          systemImage: "arrow.uturn.backward",
          label: "Restore \(restorableCount)",
          tint: ADEColor.textSecondary,
          action: onRestore
        )
      }
      if selectedCount > 0 {
        actionButton(
          systemImage: "square.and.arrow.up",
          label: "Export",
          tint: ADEColor.textSecondary,
          action: onExport
        )
      }
      if deletableCount > 0 {
        actionButton(
          systemImage: "trash",
          label: "Delete \(deletableCount)",
          tint: ADEColor.danger,
          action: onDelete
        )
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 18, style: .continuous)
        .strokeBorder(ADEColor.border.opacity(0.35), lineWidth: 0.5)
    )
    .padding(.horizontal, 12)
    .padding(.bottom, 8)
    .disabled(busy)
    .opacity(busy ? 0.55 : 1.0)
  }

  private func actionButton(systemImage: String, label: String, tint: Color, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      HStack(spacing: 4) {
        Image(systemName: systemImage)
          .font(.system(size: 11, weight: .semibold))
        Text(label)
          .font(.system(size: 11, weight: .semibold))
          .lineLimit(1)
      }
      .foregroundStyle(tint)
      .padding(.horizontal, 8)
      .padding(.vertical, 6)
      .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .strokeBorder(tint.opacity(0.32), lineWidth: 0.5)
      )
    }
    .buttonStyle(.plain)
    .accessibilityLabel(label)
  }
}
