import SwiftUI

struct LaneActionsCard: View {
  let canRunLiveActions: Bool
  let disabledSubtitle: String?
  let onRebaseLane: () -> Void
  let onRebaseDescendants: () -> Void
  let onRebaseAndPush: () -> Void
  let onForcePush: () -> Void
  let onStash: () -> Void

  @State private var moreExpanded = false

  var body: some View {
    ADEGlassSection(title: "Lane actions", subtitle: canRunLiveActions ? nil : disabledSubtitle) {
      VStack(alignment: .leading, spacing: 12) {
        stashButton
        moreSection
      }
    }
  }

  private var stashButton: some View {
    Button(action: onStash) {
      HStack(spacing: 10) {
        Image(systemName: "tray.and.arrow.down")
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(ADEColor.accent)
          .frame(width: 24)
        VStack(alignment: .leading, spacing: 2) {
          Text("Stash changes")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text("Move current work aside without discarding it.")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }
        Spacer(minLength: 8)
        Image(systemName: "chevron.right")
          .font(.system(size: 10, weight: .bold))
          .foregroundStyle(ADEColor.textMuted)
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 11)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(ADEColor.surfaceBackground.opacity(0.28), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .stroke(ADEColor.border.opacity(0.14), lineWidth: 0.5)
      )
    }
    .buttonStyle(.plain)
    .disabled(!canRunLiveActions)
  }

  @ViewBuilder
  private var moreSection: some View {
    Button {
      withAnimation(.smooth(duration: 0.22)) { moreExpanded.toggle() }
    } label: {
      HStack(spacing: 10) {
        Image(systemName: "exclamationmark.shield")
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(ADEColor.warning)
          .frame(width: 24)
        VStack(alignment: .leading, spacing: 2) {
          Text("Advanced git")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text("Review before rebasing or force pushing.")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }
        Spacer(minLength: 8)
        Image(systemName: "chevron.down")
          .font(.system(size: 10, weight: .bold))
          .foregroundStyle(ADEColor.textMuted)
          .rotationEffect(.degrees(moreExpanded ? 180 : 0))
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 11)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(ADEColor.warning.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .stroke(ADEColor.warning.opacity(0.18), lineWidth: 0.5)
      )
    }
    .buttonStyle(.plain)

    if moreExpanded {
      VStack(spacing: 0) {
        moreRow(title: "Rebase lane", symbol: "arrow.triangle.branch", tint: ADEColor.textPrimary, action: onRebaseLane)
        Divider().opacity(0.35)
        moreRow(title: "Rebase + descendants", symbol: "arrow.triangle.branch", tint: ADEColor.textPrimary, action: onRebaseDescendants)
        Divider().opacity(0.35)
        moreRow(title: "Rebase and push", symbol: "arrow.up.and.down.text.horizontal", tint: ADEColor.textPrimary, action: onRebaseAndPush)
        Divider().opacity(0.35)
        moreRow(title: "Force push (lease)", symbol: "arrow.up.forward.circle.fill", tint: ADEColor.warning, action: onForcePush)
      }
      .background(ADEColor.surfaceBackground.opacity(0.25), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .stroke(ADEColor.border.opacity(0.14), lineWidth: 0.5)
      )
      .transition(.opacity.combined(with: .move(edge: .top)))
    }
  }

  private func moreRow(title: String, symbol: String, tint: Color, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      HStack(spacing: 10) {
        Image(systemName: symbol)
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(tint)
          .frame(width: 20)
        Text(title)
          .font(.subheadline)
          .foregroundStyle(tint)
          .lineLimit(2)
        Spacer()
        Image(systemName: "chevron.right")
          .font(.system(size: 10, weight: .bold))
          .foregroundStyle(ADEColor.textMuted)
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 11)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(!canRunLiveActions)
  }
}
