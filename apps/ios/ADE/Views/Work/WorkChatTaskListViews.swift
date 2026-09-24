import SwiftUI

struct WorkChatTaskListItemRow: View {
  let item: WorkChatTaskItem

  private var statusIcon: String {
    if item.skipped { return "minus.circle" }
    switch item.status {
    case .pending: return "circle"
    case .running: return "arrow.trianglehead.2.clockwise.rotate.90.circle"
    case .done: return "checkmark.circle.fill"
    case .failed: return "xmark.circle.fill"
    }
  }

  private var tint: Color {
    if item.skipped { return ADEColor.textMuted }
    switch item.status {
    case .pending: return ADEColor.textMuted
    case .running: return ADEColor.accent
    case .done: return ADEColor.success
    case .failed: return ADEColor.danger
    }
  }

  var body: some View {
    HStack(alignment: .top, spacing: 8) {
      Image(systemName: statusIcon)
        .font(.caption.weight(.semibold))
        .foregroundStyle(tint)
        .frame(width: 16)
        .padding(.top, 1)
      VStack(alignment: .leading, spacing: 2) {
        Text(item.activeLabel ?? item.label)
          .font(.caption)
          .foregroundStyle(item.status == .done || item.skipped ? ADEColor.textMuted : ADEColor.textPrimary)
          .lineLimit(2)
        if item.skipped {
          Text("Skipped")
            .font(.caption2)
            .foregroundStyle(ADEColor.textMuted)
        }
      }
      Spacer(minLength: 0)
      if let priority = item.priority?.capitalized {
        Text(priority)
          .font(.caption2)
          .foregroundStyle(ADEColor.textMuted)
      }
    }
    .frame(minHeight: 32, alignment: .leading)
  }
}

struct WorkTaskListCard: View {
  let card: WorkEventCardModel
  let isExpanded: Bool
  let onToggle: () -> Void

  private var model: WorkChatTaskListSnapshot? { card.taskList }
  private var activeItem: WorkChatTaskItem? {
    model?.items.first(where: { $0.status == .running })
      ?? model?.items.first(where: { $0.status == .pending })
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Button(action: onToggle) {
        HStack(spacing: 9) {
          Image(systemName: "checklist")
            .font(.caption.weight(.semibold))
            .foregroundStyle(ADEColor.accent)
          VStack(alignment: .leading, spacing: 2) {
            Text("\(card.title) · \(model?.completedCount ?? 0)/\(model?.items.count ?? 0)")
              .font(.caption.weight(.semibold))
              .foregroundStyle(ADEColor.textPrimary)
              .lineLimit(1)
            if let activeItem {
              Text(activeItem.activeLabel ?? activeItem.label)
                .font(.caption2)
                .foregroundStyle(ADEColor.textMuted)
                .lineLimit(1)
            } else {
              Text("All done")
                .font(.caption2)
                .foregroundStyle(ADEColor.textMuted)
            }
          }
          Spacer(minLength: 0)
          Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
            .font(.caption2.weight(.bold))
            .foregroundStyle(ADEColor.textMuted)
        }
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("\(card.title), \(model?.completedCount ?? 0) of \(model?.items.count ?? 0) tasks completed")
      if isExpanded, let model {
        VStack(alignment: .leading, spacing: 4) {
          ForEach(model.items) { item in
            WorkChatTaskListItemRow(item: item)
          }
        }
        .padding(.leading, 3)
        .padding(.bottom, 9)
      }
    }
    .padding(.horizontal, 10)
    .background(ADEColor.cardBackground.opacity(0.3), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(ADEColor.glassBorder.opacity(0.7), lineWidth: 0.7))
  }
}

