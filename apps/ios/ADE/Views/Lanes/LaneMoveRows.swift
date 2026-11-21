import SwiftUI

// The rows of the move sheet: a place to move to, a chat or CLI that moves
// (with how much history arrives, or where its move is), and a plain fact.

struct LaneMoveTargetRow: View {
  let target: LaneMoveTarget
  let restores: Bool
  let disabled: Bool
  let pick: () -> Void

  private var note: String? {
    if !target.ready { return target.reason ?? "Not on" }
    if !restores, target.hasRepository == false { return "Clones the project from GitHub first" }
    return nil
  }

  var body: some View {
    Button(action: pick) {
      HStack(spacing: 12) {
        Image(systemName: "desktopcomputer")
          .foregroundStyle(disabled ? ADEColor.textMuted : ADEColor.accent)
          .frame(width: 22)
        VStack(alignment: .leading, spacing: 2) {
          Text(target.name)
            .foregroundStyle(disabled ? ADEColor.textMuted : ADEColor.textPrimary)
          if let note {
            Text(note)
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
        Spacer(minLength: 8)
        if !disabled {
          Image(systemName: "chevron.right")
            .font(.footnote.weight(.semibold))
            .foregroundStyle(ADEColor.textMuted)
        }
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(disabled)
    .accessibilityLabel(note.map { "\(target.name), \($0)" } ?? target.name)
    .adeInspectable("Lanes.Move.Target")
  }
}

/// One chat, CLI or the lane's branch: its logo, its name, and either how
/// much of its history arrives (the review) or where its move is (the progress).
struct LaneMoveItemRow: View {
  let item: LaneMoveItem
  let state: LaneMoveRowState?

  var body: some View {
    // Large text: the history label goes under the name instead of beside it.
    ViewThatFits(in: .horizontal) {
      HStack(spacing: 12) {
        logo
        name
        Spacer(minLength: 8)
        trailing
      }
      HStack(alignment: .top, spacing: 12) {
        logo
        VStack(alignment: .leading, spacing: 4) {
          name
          trailing
        }
        Spacer(minLength: 0)
      }
    }
    .accessibilityElement(children: .combine)
  }

  @ViewBuilder
  private var logo: some View {
    if item.kind == .lane {
      Image(systemName: "arrow.triangle.branch")
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(ADEColor.textSecondary)
        .frame(width: 24, height: 24)
    } else {
      WorkProviderLogo(
        provider: item.provider.isEmpty ? nil : item.provider,
        fallbackSymbol: item.kind == .cli ? "terminal.fill" : "bubble.left.fill",
        size: 24
      )
    }
  }

  private var name: some View {
    HStack(spacing: 6) {
      Text(item.title)
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(2)
      if item.kind == .cli {
        Text("CLI")
          .font(.caption2.weight(.medium))
          .foregroundStyle(ADEColor.textMuted)
      }
    }
  }

  @ViewBuilder
  private var trailing: some View {
    if let state {
      LaneMoveStateMark(state: state)
    } else if item.kind != .lane {
      Text(item.history.label)
        .font(.caption)
        .foregroundStyle(item.history.reduced ? ADEColor.warning : ADEColor.textSecondary)
        .fixedSize()
    }
  }
}

struct LaneMoveStateMark: View {
  let state: LaneMoveRowState

  var body: some View {
    switch state {
    case .arrived:
      Image(systemName: "checkmark.circle.fill")
        .foregroundStyle(ADEColor.success)
        .accessibilityLabel("Arrived")
    case .failed:
      Image(systemName: "xmark.circle.fill")
        .foregroundStyle(ADEColor.danger)
        .accessibilityLabel("Did not arrive")
    case .moving:
      ProgressView()
        .controlSize(.small)
        .accessibilityLabel("Moving")
    case .waiting:
      Circle()
        .fill(ADEColor.textMuted.opacity(0.45))
        .frame(width: 7, height: 7)
        .frame(width: 18, height: 18)
        .accessibilityLabel("Waiting")
    }
  }
}

struct LaneMoveFactRow: View {
  let symbol: String
  let text: String
  /// A second line under the fact.
  var detail: String? = nil
  /// A warning's color; nil for a plain fact.
  var tone: Color? = nil

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 12) {
      Image(systemName: symbol)
        .font(.system(size: 14, weight: .medium))
        .foregroundStyle(tone ?? ADEColor.textSecondary)
        .frame(width: 22)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 2) {
        Text(text)
          .font(.subheadline)
          .foregroundStyle(tone ?? ADEColor.textPrimary)
          .fixedSize(horizontal: false, vertical: true)
        if let detail {
          Text(detail)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
    }
    .padding(.vertical, 2)
  }
}
