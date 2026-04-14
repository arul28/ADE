import SwiftUI

struct LaneCommitBar: View {
  @Binding var commitMessage: String
  @Binding var amendCommit: Bool
  let hasStaged: Bool
  let hasDirty: Bool
  let canPush: Bool
  let isPublish: Bool
  let canRunLiveActions: Bool
  let onCommit: () -> Void
  let onPush: () -> Void
  let onGenerateMessage: () -> Void
  let onFetch: () -> Void
  let onPullMerge: () -> Void
  let onPullRebase: () -> Void
  let onForcePush: () -> Void
  let onStash: () -> Void
  let onRebaseLane: () -> Void
  let onRebaseDescendants: () -> Void
  let onRebaseAndPush: () -> Void

  @FocusState private var messageFieldFocused: Bool

  var body: some View {
    VStack(spacing: 10) {
      HStack(spacing: 8) {
        commitField
        commitButton
        pushButton
        overflowMenu
      }

      HStack(spacing: 10) {
        Toggle(isOn: $amendCommit) {
          Label("Amend", systemImage: "arrow.counterclockwise")
            .font(.caption2.weight(.medium))
        }
        .toggleStyle(.button)
        .buttonStyle(.plain)
        .foregroundStyle(amendCommit ? ADEColor.accent : ADEColor.textMuted)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(
          amendCommit ? ADEColor.accent.opacity(0.12) : Color.clear,
          in: Capsule()
        )
        .glassEffect(in: .capsule)

        Spacer()

        if hasStaged {
          Text("\(stagedLabel) staged")
            .font(.caption2.weight(.medium))
            .foregroundStyle(ADEColor.success)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(ADEColor.success.opacity(0.1), in: Capsule())
        }
      }
    }
    .padding(.horizontal, 16)
    .padding(.top, 10)
    .padding(.bottom, 10)
    .background(.ultraThinMaterial)
    .glassEffect()
    .overlay(alignment: .top) {
      Rectangle()
        .fill(ADEColor.border.opacity(0.15))
        .frame(height: 0.5)
    }
  }

  private var stagedLabel: String {
    hasStaged ? "Ready" : "None"
  }

  private var commitField: some View {
    HStack(spacing: 6) {
      TextField("Commit message…", text: $commitMessage, axis: .vertical)
        .textFieldStyle(.plain)
        .font(.subheadline)
        .lineLimit(1...3)
        .focused($messageFieldFocused)

      if commitMessage.isEmpty && hasStaged {
        Button(action: onGenerateMessage) {
          Image(systemName: "sparkles")
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(ADEColor.accent)
            .frame(width: 28, height: 28)
            .background(ADEColor.accent.opacity(0.1), in: Circle())
        }
        .buttonStyle(.plain)
        .disabled(!canRunLiveActions)
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 9)
    .background(ADEColor.recessedBackground.opacity(0.55), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .glassEffect(in: .rect(cornerRadius: 12))
    .overlay(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .stroke(ADEColor.border.opacity(0.18), lineWidth: 0.5)
    )
  }

  private var commitButton: some View {
    Button(action: onCommit) {
      Text(amendCommit ? "Amend" : "Commit")
        .font(.subheadline.weight(.semibold))
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
    }
    .buttonStyle(.borderedProminent)
    .tint(ADEColor.accent)
    .disabled(!hasStaged || commitMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !canRunLiveActions)
  }

  private var pushButton: some View {
    Button(action: onPush) {
      Image(systemName: isPublish ? "arrow.up.circle.fill" : "arrow.up.circle")
        .font(.system(size: 18, weight: .semibold))
        .foregroundStyle(canPush && canRunLiveActions ? ADEColor.accent : ADEColor.textMuted)
        .frame(width: 36, height: 36)
        .background(ADEColor.surfaceBackground.opacity(0.08), in: Circle())
        .glassEffect(in: .circle)
    }
    .buttonStyle(.plain)
    .disabled(!canPush || !canRunLiveActions)
    .accessibilityLabel(isPublish ? "Publish branch" : "Push commits")
  }

  private var overflowMenu: some View {
    Menu {
      Section("Sync") {
        Button { onFetch() } label: { Label("Fetch", systemImage: "arrow.down.circle") }
        Button { onPullMerge() } label: { Label("Pull (merge)", systemImage: "arrow.down.to.line") }
        Button { onPullRebase() } label: { Label("Pull (rebase)", systemImage: "arrow.triangle.2.circlepath") }
        Button(role: .destructive) { onForcePush() } label: { Label("Force push", systemImage: "arrow.up.circle.fill") }
      }
      Section("Rebase") {
        Button { onRebaseLane() } label: { Label("Rebase lane", systemImage: "arrow.triangle.branch") }
        Button { onRebaseDescendants() } label: { Label("Rebase + descendants", systemImage: "arrow.triangle.branch") }
        Button { onRebaseAndPush() } label: { Label("Rebase and push", systemImage: "arrow.up.circle") }
      }
      Section {
        Button { onStash() } label: { Label("Stash changes", systemImage: "tray.and.arrow.down") }
      }
    } label: {
      Image(systemName: "ellipsis.circle.fill")
        .symbolRenderingMode(.hierarchical)
        .font(.system(size: 18, weight: .semibold))
        .foregroundStyle(ADEColor.textSecondary)
        .frame(width: 36, height: 36)
        .background(ADEColor.surfaceBackground.opacity(0.08), in: Circle())
        .glassEffect(in: .circle)
    }
    .disabled(!canRunLiveActions)
  }
}
