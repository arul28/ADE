import SwiftUI

struct LaneCommitSheet: View {
  @Binding var commitMessage: String
  @Binding var amendCommit: Bool
  let stagedCount: Int
  let unstagedCount: Int
  let canRunLiveActions: Bool
  let stagedFiles: [FileChange]
  let unstagedFiles: [FileChange]
  /// Returns the suggested commit message, or throws. The sheet owns the
  /// loading + setup-hint state so the desktop's specific "AI commit messages
  /// are off" error can be detected and surfaced inline.
  let onGenerateMessage: () async throws -> String
  let onCommit: () -> Void
  let onDismiss: () -> Void
  let onStageFile: (FileChange) -> Void
  let onUnstageFile: (FileChange) -> Void
  let onDiscardFile: (FileChange) -> Void
  let onRestoreStaged: (FileChange) -> Void
  let onStageAll: () -> Void
  let onUnstageAll: () -> Void
  let onDiscardAllUnstaged: () -> Void
  let onRestoreAllStaged: () -> Void
  let onOpenDiff: (FileChange, _ staged: Bool) -> Void
  let onOpenFiles: (FileChange) -> Void

  @FocusState private var messageFieldFocused: Bool
  @Environment(\.dismiss) private var dismissEnv
  @State private var isGenerating = false
  /// When set, the desktop reported AI commit messages as not configured;
  /// we lock the Suggest button for the remainder of this sheet session
  /// and show the user how to enable it.
  @State private var aiSetupHint: String?
  @State private var aiTransientError: String?

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          if !unstagedFiles.isEmpty || !stagedFiles.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
              sectionHeader(title: "Files", subtitle: filesSubtitle)
              if !unstagedFiles.isEmpty {
                unstagedSection
              }
              if !stagedFiles.isEmpty {
                stagedSection
              }
            }
          }

          VStack(alignment: .leading, spacing: 10) {
            sectionHeader(title: "Commit message", subtitle: nil, trailing: { suggestButton })
            messageField
            if let aiSetupHint {
              setupHintCard(aiSetupHint)
            } else if let aiTransientError {
              transientErrorCard(aiTransientError)
            }
          }

          amendRow
          commitActionSection
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 24)
      }
      .background(ADEColor.surfaceBackground.ignoresSafeArea())
      .navigationTitle(amendCommit ? "Amend commit" : "Review & commit")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Close") {
            onDismiss()
            dismissEnv()
          }
        }
      }
    }
  }

  // MARK: - Layout helpers

  private var filesSubtitle: String? {
    let parts: [String] = [
      stagedCount > 0 ? "\(stagedCount) staged" : nil,
      unstagedCount > 0 ? "\(unstagedCount) unstaged" : nil
    ].compactMap { $0 }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
  }

  @ViewBuilder
  private func sectionHeader<Trailing: View>(
    title: String,
    subtitle: String?,
    @ViewBuilder trailing: () -> Trailing = { EmptyView() }
  ) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      VStack(alignment: .leading, spacing: 2) {
        Text(title.uppercased())
          .font(.caption.weight(.semibold))
          .tracking(0.6)
          .foregroundStyle(ADEColor.textMuted)
        if let subtitle {
          Text(subtitle)
            .font(.caption2)
            .foregroundStyle(ADEColor.textSecondary)
        }
      }
      Spacer(minLength: 8)
      trailing()
    }
  }

  // MARK: - Suggest button

  @ViewBuilder
  private var suggestButton: some View {
    let disabled = !canRunLiveActions || aiSetupHint != nil || isGenerating
    Button(action: triggerSuggest) {
      HStack(spacing: 5) {
        if isGenerating {
          ProgressView()
            .controlSize(.mini)
            .tint(ADEColor.accent)
        } else {
          Image(systemName: "sparkles")
            .font(.system(size: 11, weight: .semibold))
        }
        Text(suggestButtonLabel)
          .font(.caption.weight(.semibold))
      }
      .foregroundStyle(aiSetupHint == nil ? ADEColor.accent : ADEColor.textMuted)
      .padding(EdgeInsets(top: 6, leading: 10, bottom: 6, trailing: 10))
      .background(
        (aiSetupHint == nil ? ADEColor.accent : ADEColor.textMuted).opacity(0.12),
        in: Capsule()
      )
    }
    .buttonStyle(.plain)
    .disabled(disabled)
    .opacity(disabled ? 0.6 : 1)
    .accessibilityLabel(isGenerating ? "Generating commit message" : "Suggest commit message")
  }

  private var suggestButtonLabel: String {
    if isGenerating { return "Generating…" }
    if aiSetupHint != nil { return "Setup needed" }
    return "Suggest"
  }

  private func triggerSuggest() {
    guard !isGenerating, aiSetupHint == nil, canRunLiveActions else { return }
    Task { @MainActor in
      isGenerating = true
      aiTransientError = nil
      defer { isGenerating = false }
      do {
        let suggestion = try await onGenerateMessage()
        commitMessage = suggestion
        messageFieldFocused = true
      } catch {
        let text = error.localizedDescription
        if isAiSetupError(text) {
          aiSetupHint = aiSetupHintFor(text)
        } else {
          aiTransientError = text
        }
      }
    }
  }

  private func isAiSetupError(_ text: String) -> Bool {
    let lower = text.lowercased()
    return lower.contains("ai commit messages are off")
      || lower.contains("commit messages model")
      || lower.contains("choose a commit messages")
      || lower.contains("not currently available")
  }

  private func aiSetupHintFor(_ text: String) -> String {
    if text.lowercased().contains("are off") {
      return "AI commit messages are turned off on the desktop. Open desktop Settings → AI → Commit Messages to enable it."
    }
    return "Pick a Commit Messages model on the desktop in Settings → AI → Commit Messages."
  }

  @ViewBuilder
  private func setupHintCard(_ message: String) -> some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: "wand.and.stars")
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(ADEColor.warning)
        .padding(.top, 2)
      VStack(alignment: .leading, spacing: 4) {
        Text("Suggest needs setup")
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Text(message)
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      Spacer(minLength: 8)
    }
    .padding(EdgeInsets(top: 10, leading: 12, bottom: 10, trailing: 12))
    .background(ADEColor.warning.opacity(0.10), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .stroke(ADEColor.warning.opacity(0.25), lineWidth: 0.5)
    )
  }

  @ViewBuilder
  private func transientErrorCard(_ message: String) -> some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: "exclamationmark.triangle.fill")
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(ADEColor.danger)
        .padding(.top, 2)
      Text(message)
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 8)
    }
    .padding(EdgeInsets(top: 10, leading: 12, bottom: 10, trailing: 12))
    .background(ADEColor.danger.opacity(0.08), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .stroke(ADEColor.danger.opacity(0.22), lineWidth: 0.5)
    )
  }

  // MARK: - File sections

  @ViewBuilder
  private var unstagedSection: some View {
    LaneFileTreeSection(
      title: "Unstaged files",
      subtitle: "\(unstagedFiles.count) file\(unstagedFiles.count == 1 ? "" : "s")",
      changes: unstagedFiles,
      allowsLiveActions: canRunLiveActions,
      allowsDiffInspection: true,
      bulkActionTitle: unstagedFiles.count > 1 ? "Stage all" : nil,
      bulkActionSymbol: "plus.circle.fill",
      bulkActionTint: ADEColor.accent,
      primaryActionTitle: "Stage",
      primaryActionSymbol: "plus.circle.fill",
      primaryActionTint: ADEColor.accent,
      secondaryActionTitle: "Discard",
      secondaryActionSymbol: "trash",
      secondaryActionTint: ADEColor.danger,
      extraBulkActions: [
        LaneFileTreeBulkAction(
          title: "Discard unstaged",
          symbol: "trash",
          tint: ADEColor.danger,
          isDestructive: true
        ) { onDiscardAllUnstaged() }
      ],
      onBulkAction: onStageAll,
      onDiff: { file in onOpenDiff(file, false) },
      onPrimaryAction: onStageFile,
      onSecondaryAction: onDiscardFile,
      onOpenFiles: onOpenFiles
    )
  }

  @ViewBuilder
  private var stagedSection: some View {
    LaneFileTreeSection(
      title: "Staged files",
      subtitle: "\(stagedFiles.count) file\(stagedFiles.count == 1 ? "" : "s")",
      changes: stagedFiles,
      allowsLiveActions: canRunLiveActions,
      allowsDiffInspection: true,
      bulkActionTitle: stagedFiles.count > 1 ? "Unstage all" : nil,
      bulkActionSymbol: "minus.circle",
      bulkActionTint: ADEColor.warning,
      primaryActionTitle: "Unstage",
      primaryActionSymbol: "minus.circle",
      primaryActionTint: ADEColor.warning,
      secondaryActionTitle: "Discard",
      secondaryActionSymbol: "trash",
      secondaryActionTint: ADEColor.danger,
      extraBulkActions: [
        LaneFileTreeBulkAction(
          title: "Discard staged",
          symbol: "trash",
          tint: ADEColor.danger,
          isDestructive: true
        ) { onRestoreAllStaged() }
      ],
      onBulkAction: onUnstageAll,
      onDiff: { file in onOpenDiff(file, true) },
      onPrimaryAction: onUnstageFile,
      onSecondaryAction: onRestoreStaged,
      onOpenFiles: onOpenFiles
    )
  }

  // MARK: - Message + amend + commit

  private var messageField: some View {
    TextField(
      amendCommit ? "Update the previous commit message" : "Describe what this change does",
      text: $commitMessage,
      axis: .vertical
    )
    .textFieldStyle(.plain)
    .font(.subheadline)
    .lineLimit(4...10)
    .focused($messageFieldFocused)
    .frame(minHeight: 130, alignment: .topLeading)
    .adeInsetField(cornerRadius: 12, padding: 12)
  }

  private var amendRow: some View {
    Toggle(isOn: $amendCommit) {
      VStack(alignment: .leading, spacing: 2) {
        Text("Amend last commit")
          .font(.subheadline.weight(.medium))
          .foregroundStyle(ADEColor.textPrimary)
        Text("Replace the previous commit with these changes.")
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
      }
    }
    .tint(ADEColor.accent)
    .adeGlassCard(cornerRadius: 12, padding: 12)
  }

  private var commitActionSection: some View {
    VStack(alignment: .leading, spacing: 8) {
      Button(action: onCommit) {
        HStack(spacing: 6) {
          Image(systemName: amendCommit ? "arrow.counterclockwise" : "checkmark.circle.fill")
            .font(.system(size: 14, weight: .semibold))
          Text(commitButtonLabel)
            .font(.subheadline.weight(.semibold))
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 14)
      }
      .buttonStyle(.glassProminent)
      .tint(ADEColor.accent)
      .disabled(!canCommit)
      Text(commitActionHint)
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)
    }
    .adeGlassCard(cornerRadius: 12, padding: 12)
  }

  private var trimmedMessage: String {
    commitMessage.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private var canCommit: Bool {
    guard canRunLiveActions else { return false }
    if amendCommit {
      return !trimmedMessage.isEmpty
    }
    return stagedCount > 0 && !trimmedMessage.isEmpty
  }

  private var commitButtonLabel: String {
    if amendCommit { return "Amend commit" }
    if stagedCount == 0 { return "Stage files first" }
    if trimmedMessage.isEmpty { return "Write a message" }
    return "Commit \(stagedCount) file\(stagedCount == 1 ? "" : "s")"
  }

  private var commitActionHint: String {
    if !canRunLiveActions { return "Reconnect to commit changes." }
    if amendCommit { return "This replaces the last commit on this lane." }
    if stagedCount == 0 { return "Stage files before committing." }
    if trimmedMessage.isEmpty { return "Write a commit message before continuing." }
    return "Creates a commit from the staged files."
  }
}
