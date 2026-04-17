import SwiftUI

struct LaneActionsCard: View {
  let canRunLiveActions: Bool
  let canPush: Bool
  let isPublish: Bool
  let onPullMerge: () -> Void
  let onPullRebase: () -> Void
  let onPush: () -> Void
  let onSync: () -> Void
  let onFetch: () -> Void
  let onRebaseLane: () -> Void
  let onRebaseDescendants: () -> Void
  let onRebaseAndPush: () -> Void
  let onForcePush: () -> Void
  let onStash: () -> Void

  @State private var moreExpanded = false

  var body: some View {
    ADEGlassSection(title: "Actions", subtitle: canRunLiveActions ? nil : "Reconnect to run git actions.") {
      VStack(alignment: .leading, spacing: 12) {
        primaryRow
        secondaryRow
        moreSection
      }
    }
  }

  private var primaryRow: some View {
    HStack(spacing: 10) {
      Menu {
        Button {
          onPullMerge()
        } label: {
          Label("Pull (merge)", systemImage: "arrow.down.to.line")
        }
        Button {
          onPullRebase()
        } label: {
          Label("Pull (rebase)", systemImage: "arrow.triangle.2.circlepath")
        }
      } label: {
        actionTile(title: "Pull", symbol: "arrow.down.to.line", tint: ADEColor.textSecondary)
      }
      .disabled(!canRunLiveActions)

      Button(action: onPush) {
        actionTile(
          title: isPublish ? "Publish" : "Push",
          symbol: isPublish ? "arrow.up.circle.fill" : "arrow.up.to.line",
          tint: canPush ? ADEColor.accent : ADEColor.textMuted
        )
      }
      .buttonStyle(.plain)
      .disabled(!canRunLiveActions || !canPush)

      Button(action: onSync) {
        actionTile(title: "Sync", symbol: "arrow.triangle.2.circlepath", tint: ADEColor.textSecondary)
      }
      .buttonStyle(.plain)
      .disabled(!canRunLiveActions)
    }
  }

  private var secondaryRow: some View {
    HStack(spacing: 10) {
      Button(action: onFetch) {
        actionTile(title: "Fetch", symbol: "arrow.down.circle", tint: ADEColor.textSecondary, compact: true)
      }
      .buttonStyle(.plain)
      .disabled(!canRunLiveActions)
      Spacer(minLength: 0)
    }
  }

  @ViewBuilder
  private var moreSection: some View {
    Button {
      withAnimation(.smooth(duration: 0.22)) { moreExpanded.toggle() }
    } label: {
      HStack(spacing: 6) {
        Text(moreExpanded ? "Less" : "More")
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textSecondary)
        Image(systemName: "chevron.down")
          .font(.system(size: 9, weight: .bold))
          .foregroundStyle(ADEColor.textMuted)
          .rotationEffect(.degrees(moreExpanded ? 180 : 0))
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 6)
      .background(ADEColor.surfaceBackground.opacity(0.35), in: Capsule())
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
        Divider().opacity(0.35)
        moreRow(title: "Stash changes", symbol: "tray.and.arrow.down", tint: ADEColor.textPrimary, action: onStash)
      }
      .background(ADEColor.surfaceBackground.opacity(0.25), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .stroke(ADEColor.border.opacity(0.14), lineWidth: 0.5)
      )
      .transition(.opacity.combined(with: .move(edge: .top)))
    }
  }

  private func actionTile(title: String, symbol: String, tint: Color, compact: Bool = false) -> some View {
    VStack(spacing: 4) {
      Image(systemName: symbol)
        .font(.system(size: 16, weight: .semibold))
        .symbolRenderingMode(.hierarchical)
      Text(title)
        .font(.caption2.weight(.semibold))
    }
    .foregroundStyle(tint)
    .frame(maxWidth: .infinity)
    .frame(height: compact ? 44 : 58)
    .background(ADEColor.surfaceBackground.opacity(0.35), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .stroke(ADEColor.border.opacity(0.14), lineWidth: 0.5)
    )
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
