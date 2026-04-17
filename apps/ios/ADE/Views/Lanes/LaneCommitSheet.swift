import SwiftUI

struct LaneCommitSheet: View {
  @Binding var commitMessage: String
  @Binding var amendCommit: Bool
  let stagedCount: Int
  let unstagedCount: Int
  let canRunLiveActions: Bool
  let onGenerateMessage: () -> Void
  let onCommit: () -> Void
  let onDismiss: () -> Void

  @FocusState private var messageFieldFocused: Bool
  @Environment(\.dismiss) private var dismissEnv

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          statusRow
          messageField
          amendRow
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
      }
      .background(ADEColor.surfaceBackground.ignoresSafeArea())
      .navigationTitle(amendCommit ? "Amend commit" : "Commit changes")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Close") {
            onDismiss()
            dismissEnv()
          }
        }
      }
      .safeAreaInset(edge: .bottom) {
        commitButtonBar
      }
      .onAppear { messageFieldFocused = true }
    }
  }

  private var statusRow: some View {
    HStack(spacing: 8) {
      if stagedCount > 0 {
        LaneMicroChip(icon: "checkmark.circle", text: "\(stagedCount) staged", tint: ADEColor.success)
      }
      if unstagedCount > 0 {
        LaneMicroChip(icon: "doc.badge.plus", text: "\(unstagedCount) unstaged", tint: ADEColor.warning)
      }
      if stagedCount == 0 && unstagedCount == 0 {
        LaneMicroChip(icon: "checkmark.seal", text: "Nothing to commit", tint: ADEColor.textMuted)
      }
      Spacer(minLength: 0)
    }
  }

  private var messageField: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text("Message")
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textSecondary)
        Spacer()
        Button(action: onGenerateMessage) {
          HStack(spacing: 4) {
            Image(systemName: "sparkles")
              .font(.system(size: 11, weight: .semibold))
            Text("Suggest")
              .font(.caption.weight(.semibold))
          }
          .foregroundStyle(ADEColor.accent)
          .padding(.horizontal, 10)
          .padding(.vertical, 5)
          .background(ADEColor.accent.opacity(0.12), in: Capsule())
        }
        .buttonStyle(.plain)
        .disabled(!canRunLiveActions)
      }

      TextField(
        amendCommit ? "Update the previous commit message" : "Describe what this change does",
        text: $commitMessage,
        axis: .vertical
      )
      .textFieldStyle(.plain)
      .font(.subheadline)
      .lineLimit(4...10)
      .focused($messageFieldFocused)
      .padding(12)
      .frame(minHeight: 140, alignment: .topLeading)
      .background(ADEColor.recessedBackground.opacity(0.55), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .stroke(ADEColor.border.opacity(0.18), lineWidth: 0.5)
      )
    }
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
    .padding(12)
    .background(ADEColor.surfaceBackground.opacity(0.35), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
  }

  private var commitButtonBar: some View {
    VStack(spacing: 0) {
      Divider().opacity(0.4)
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
      .buttonStyle(.borderedProminent)
      .tint(ADEColor.accent)
      .disabled(!canCommit)
      .padding(.horizontal, 16)
      .padding(.vertical, 12)
    }
    .background(.ultraThinMaterial)
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
}
