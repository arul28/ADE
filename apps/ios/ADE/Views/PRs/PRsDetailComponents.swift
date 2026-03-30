import SwiftUI
import UIKit

struct PrFilesTab: View {
  let snapshot: PullRequestSnapshot?

  private var files: [PrFile] {
    snapshot?.files ?? []
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      PrDetailSectionCard("Changed files") {
        Text("\(files.count) files · +\(files.reduce(0) { $0 + $1.additions }) · -\(files.reduce(0) { $0 + $1.deletions })")
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
      }

      if files.isEmpty {
        ADEEmptyStateView(
          symbol: "doc.text.magnifyingglass",
          title: "No changed files",
          message: "The host has not synced any file diff data for this PR yet."
        )
      } else {
        VStack(spacing: 12) {
          ForEach(files) { file in
            PrFileDiffCard(file: file)
          }
        }
      }
    }
  }
}

struct PrChecksTab: View {
  let pr: PullRequestListItem
  let checks: [PrCheck]
  let actionRuns: [PrActionRun]
  let canRerunChecks: Bool
  let isLive: Bool
  let onRerun: () -> Void

  private var summary: (passing: Int, failing: Int, pending: Int, skipped: Int) {
    checks.reduce(into: (0, 0, 0, 0)) { result, check in
      switch check.status {
      case "completed":
        switch check.conclusion {
        case "success": result.passing += 1
        case "failure": result.failing += 1
        default: result.skipped += 1
        }
      default:
        result.pending += 1
      }
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      PrDetailSectionCard("Checks summary") {
        VStack(alignment: .leading, spacing: 10) {
          Text("Passing \(summary.passing) · Failing \(summary.failing) · Pending \(summary.pending) · Skipped \(summary.skipped)")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)

          ProgressView(value: Double(summary.passing), total: Double(max(checks.count, 1)))
            .tint(summary.failing > 0 ? ADEColor.warning : ADEColor.success)

          HStack(spacing: 10) {
            Button("Re-run failed checks") {
              onRerun()
            }
            .buttonStyle(.glass)
            .disabled(!canRerunChecks || !isLive || checks.isEmpty)

            Button("Open PR checks on GitHub") {
              guard let url = URL(string: pr.githubUrl) else { return }
              UIApplication.shared.open(url)
            }
            .buttonStyle(.glass)
          }
        }
      }

      if checks.isEmpty {
        ADEEmptyStateView(
          symbol: "checklist",
          title: "No CI checks",
          message: "No check runs were synced for this PR yet."
        )
      } else {
        VStack(spacing: 12) {
          ForEach(checks) { check in
            PrCheckRow(check: check)
          }
        }
      }

      if !actionRuns.isEmpty {
        PrDetailSectionCard("GitHub Actions runs") {
          VStack(spacing: 12) {
            ForEach(actionRuns) { run in
              PrActionRunCard(run: run)
            }
          }
        }
      }
    }
  }
}

struct PrActivityTab: View {
  let timeline: [PrTimelineEvent]
  @Binding var commentInput: String
  let composerTitle: String
  let composerActionTitle: String
  let canAddComment: Bool
  let canUpdateComment: Bool
  let canDeleteComment: Bool
  let isLive: Bool
  let onCancelComposer: (() -> Void)?
  let onSubmitComment: () -> Void
  let onReplyComment: (PrTimelineEvent) -> Void
  let onEditComment: (PrTimelineEvent) -> Void
  let onDeleteComment: (PrTimelineEvent) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      if timeline.isEmpty {
        ADEEmptyStateView(
          symbol: "bubble.left.and.bubble.right",
          title: "No activity yet",
          message: "Comments, reviews, and state changes will appear here once the host syncs them."
        )
      } else {
        PrDetailSectionCard("Timeline") {
          VStack(spacing: 12) {
            ForEach(timeline) { event in
              PrTimelineRow(
                event: event,
                canReplyToComment: canAddComment,
                canUpdateComment: canUpdateComment,
                canDeleteComment: canDeleteComment,
                onReplyComment: onReplyComment,
                onEditComment: onEditComment,
                onDeleteComment: onDeleteComment
              )
            }
          }
        }
      }

      PrDetailSectionCard(composerTitle) {
        VStack(alignment: .leading, spacing: 10) {
          TextEditor(text: $commentInput)
            .frame(minHeight: 120)
            .adeInsetField(cornerRadius: 14, padding: 10)

          HStack(spacing: 10) {
            Button(composerActionTitle) {
              onSubmitComment()
            }
            .buttonStyle(.glassProminent)
            .tint(ADEColor.accent)
            .disabled(!canAddComment || !isLive || commentInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

            if let onCancelComposer {
              Button("Cancel") {
                onCancelComposer()
              }
              .buttonStyle(.glass)
            }
          }

          if !canAddComment {
            Text("Posting comments requires a host that exposes PR comment actions to mobile.")
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
          }
        }
      }
    }
  }
}

struct PrDetailSectionCard<Content: View>: View {
  let title: String
  let content: Content

  init(_ title: String, @ViewBuilder content: () -> Content) {
    self.title = title
    self.content = content()
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(title)
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
      content
    }
    .adeGlassCard(cornerRadius: 18)
  }
}

struct PrChipWrap: View {
  let values: [String]
  let tint: Color

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        ForEach(values, id: \.self) { value in
          ADEStatusPill(text: value.uppercased(), tint: tint)
        }
      }
    }
  }
}

private struct PrFileDiffCard: View {
  let file: PrFile
  @State private var expanded = true

  var body: some View {
    DisclosureGroup(isExpanded: $expanded) {
      VStack(alignment: .leading, spacing: 10) {
        if let previousFilename = file.previousFilename, !previousFilename.isEmpty {
          Text("Renamed from \(previousFilename)")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }

        if let patch = file.patch, !patch.isEmpty {
          PrUnifiedDiffView(file: file, patch: patch)
        } else {
          Text("No patch was synced for this file.")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }
      }
      .padding(.top, 8)
    } label: {
      VStack(alignment: .leading, spacing: 8) {
        HStack(alignment: .top, spacing: 10) {
          ADEStatusPill(text: fileStatusLabel(file.status), tint: fileStatusTint(file.status))
          VStack(alignment: .leading, spacing: 4) {
            Text(file.filename)
              .font(.system(.body, design: .monospaced))
              .foregroundStyle(ADEColor.textPrimary)
              .lineLimit(2)
            Text("+\(file.additions) -\(file.deletions)")
              .font(.system(.caption2, design: .monospaced))
              .foregroundStyle(ADEColor.textSecondary)
          }
          Spacer(minLength: 0)
        }
      }
    }
    .adeGlassCard(cornerRadius: 18)
  }
}

private struct PrUnifiedDiffView: View {
  let file: PrFile
  let patch: String

  private var language: FilesLanguage {
    FilesLanguage.detect(languageId: nil, filePath: file.filename)
  }

  private var lines: [PrDiffDisplayLine] {
    parsePullRequestPatch(patch)
  }

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      VStack(alignment: .leading, spacing: 2) {
        ForEach(lines) { line in
          HStack(alignment: .top, spacing: 8) {
            Text(line.oldLineNumber.map(String.init) ?? "")
              .frame(width: 34, alignment: .trailing)
              .foregroundStyle(ADEColor.textMuted)
            Text(line.newLineNumber.map(String.init) ?? "")
              .frame(width: 34, alignment: .trailing)
              .foregroundStyle(ADEColor.textMuted)

            if line.kind == .hunk || line.kind == .note {
              Text(line.text)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(line.kind == .hunk ? ADEColor.accent : ADEColor.textSecondary)
            } else {
              HStack(spacing: 0) {
                Text(verbatim: line.prefix)
                  .font(.system(.caption, design: .monospaced).weight(.semibold))
                  .foregroundStyle(diffPrefixTint(line.kind))
                Text(SyntaxHighlighter.highlightedAttributedString(line.text.isEmpty ? " " : line.text, as: language))
                  .font(.system(.caption, design: .monospaced))
              }
            }
            Spacer(minLength: 0)
          }
          .padding(.horizontal, 8)
          .padding(.vertical, 4)
          .background(diffBackground(line.kind), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
      }
    }
    .adeInsetField(cornerRadius: 14, padding: 10)
  }

  private func diffBackground(_ kind: PrDiffDisplayLineKind) -> Color {
    switch kind {
    case .added:
      return ADEColor.success.opacity(0.12)
    case .removed:
      return ADEColor.danger.opacity(0.12)
    case .hunk:
      return ADEColor.accent.opacity(0.08)
    case .context, .note:
      return Color.clear
    }
  }

  private func diffPrefixTint(_ kind: PrDiffDisplayLineKind) -> Color {
    switch kind {
    case .added:
      return ADEColor.success
    case .removed:
      return ADEColor.danger
    case .hunk:
      return ADEColor.accent
    case .context, .note:
      return ADEColor.textSecondary
    }
  }
}

private struct PrCheckRow: View {
  let check: PrCheck

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .top, spacing: 10) {
        Image(systemName: checkSymbol(check))
          .foregroundStyle(prChecksTint(check.status == "completed" ? (check.conclusion == "success" ? "passing" : check.conclusion == "failure" ? "failing" : "none") : "pending"))
          .padding(.top, 2)

        VStack(alignment: .leading, spacing: 4) {
          Text(check.name)
            .foregroundStyle(ADEColor.textPrimary)
          Text(prCheckStatusLabel(check))
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)

          if let duration = prDurationText(startedAt: check.startedAt, completedAt: check.completedAt) {
            Text(duration)
              .font(.caption2)
              .foregroundStyle(ADEColor.textMuted)
          }

          if let detailsUrl = check.detailsUrl, !detailsUrl.isEmpty {
            Link(destination: URL(string: detailsUrl) ?? URL(string: "https://github.com")!) {
              Text(detailsUrl)
                .font(.caption2)
                .lineLimit(1)
            }
          }
        }
      }
    }
    .adeGlassCard(cornerRadius: 18)
  }
}

private struct PrTimelineRow: View {
  let event: PrTimelineEvent
  let canReplyToComment: Bool
  let canUpdateComment: Bool
  let canDeleteComment: Bool
  let onReplyComment: (PrTimelineEvent) -> Void
  let onEditComment: (PrTimelineEvent) -> Void
  let onDeleteComment: (PrTimelineEvent) -> Void

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      PrTimelineAvatarView(
        avatarUrl: event.avatarUrl,
        fallbackText: event.author ?? event.title,
        tint: timelineTint(event.kind)
      )

      VStack(alignment: .leading, spacing: 4) {
        HStack(alignment: .top, spacing: 8) {
          HStack(spacing: 6) {
            Image(systemName: timelineSymbol(event.kind))
              .foregroundStyle(timelineTint(event.kind))
            Text(event.title)
              .font(.subheadline.weight(.semibold))
              .foregroundStyle(ADEColor.textPrimary)
          }
          Spacer(minLength: 8)
          Text(prRelativeTime(event.timestamp))
            .font(.caption2)
            .foregroundStyle(ADEColor.textMuted)
        }

        HStack(spacing: 8) {
          if let author = event.author, !author.isEmpty {
            Text(author)
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
          }

          ADEStatusPill(text: event.badgeText.uppercased(), tint: timelineTint(event.kind))
        }

        if let body = event.body, !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
          PrMarkdownRenderer(markdown: body)
        }

        if let metadata = event.metadata, !metadata.isEmpty {
          Text(metadata)
            .font(.caption2)
            .foregroundStyle(ADEColor.textMuted)
        }

        if event.canReply || event.canEdit || event.canDelete || event.commentUrl != nil {
          HStack(spacing: 10) {
            if canReplyToComment, event.canReply {
              Button("Reply") {
                onReplyComment(event)
              }
              .buttonStyle(.glass)
              .accessibilityLabel("Reply to \(event.author ?? "comment")")
            }

            if canUpdateComment, event.canEdit {
              Button("Edit") {
                onEditComment(event)
              }
              .buttonStyle(.glass)
              .accessibilityLabel("Edit comment by \(event.author ?? "author")")
            }

            if canDeleteComment, event.canDelete {
              Button("Delete", role: .destructive) {
                onDeleteComment(event)
              }
              .buttonStyle(.glass)
              .accessibilityLabel("Delete comment by \(event.author ?? "author")")
            }

            if let urlString = event.commentUrl, let url = URL(string: urlString), !urlString.isEmpty {
              Link(destination: url) {
                Text("Open on GitHub")
              }
              .buttonStyle(.glass)
            }
          }
          .padding(.top, 4)
        }
      }
    }
    .adeInsetField(cornerRadius: 14, padding: 12)
  }
}

private struct PrTimelineAvatarView: View {
  let avatarUrl: String?
  let fallbackText: String
  let tint: Color

  private var url: URL? {
    guard let avatarUrl, !avatarUrl.isEmpty else { return nil }
    return URL(string: avatarUrl)
  }

  var body: some View {
    Group {
      if let url {
        AsyncImage(url: url) { phase in
          switch phase {
          case .success(let image):
            image
              .resizable()
              .scaledToFill()
          default:
            fallback
          }
        }
      } else {
        fallback
      }
    }
    .frame(width: 34, height: 34)
    .clipShape(Circle())
    .overlay(Circle().stroke(tint.opacity(0.25), lineWidth: 1))
  }

  private var fallback: some View {
    ZStack {
      Circle()
        .fill(ADEColor.surfaceBackground.opacity(0.85))
      Text(String(fallbackText.prefix(2)).uppercased())
        .font(.caption.weight(.bold))
        .foregroundStyle(ADEColor.textSecondary)
    }
  }
}

private struct PrActionRunCard: View {
  let run: PrActionRun
  @State private var expanded = false

  var body: some View {
    DisclosureGroup(isExpanded: $expanded) {
      VStack(alignment: .leading, spacing: 10) {
        ForEach(run.jobs) { job in
          VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
              Image(systemName: actionSymbol(status: job.status, conclusion: job.conclusion))
                .foregroundStyle(actionTint(status: job.status, conclusion: job.conclusion))
              Text(job.name)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(ADEColor.textPrimary)
            }

            if !job.steps.isEmpty {
              VStack(alignment: .leading, spacing: 6) {
                ForEach(job.steps) { step in
                  HStack(spacing: 8) {
                    Text("\(step.number).")
                      .font(.system(.caption, design: .monospaced))
                      .foregroundStyle(ADEColor.textMuted)
                    Text(step.name)
                      .font(.caption)
                      .foregroundStyle(ADEColor.textSecondary)
                    Spacer(minLength: 8)
                    Text((step.conclusion ?? step.status).uppercased())
                      .font(.caption2.weight(.semibold))
                      .foregroundStyle(actionTint(status: step.status, conclusion: step.conclusion))
                  }
                }
              }
              .padding(.leading, 22)
            }
          }
          .padding(12)
          .background(ADEColor.surfaceBackground.opacity(0.45), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
      }
      .padding(.top, 8)
    } label: {
      VStack(alignment: .leading, spacing: 8) {
        HStack(alignment: .top, spacing: 10) {
          Image(systemName: actionSymbol(status: run.status, conclusion: run.conclusion))
            .foregroundStyle(actionTint(status: run.status, conclusion: run.conclusion))
          VStack(alignment: .leading, spacing: 4) {
            Text(run.name)
              .foregroundStyle(ADEColor.textPrimary)
            Text((run.conclusion ?? run.status).uppercased())
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
          }
          Spacer(minLength: 8)
          ADEStatusPill(text: "GITHUB ACTIONS", tint: ADEColor.accent)
        }

        if let url = URL(string: run.htmlUrl), !run.htmlUrl.isEmpty {
          Link(destination: url) {
            Text(run.htmlUrl)
              .font(.caption2)
              .lineLimit(1)
          }
        }
      }
    }
    .adeGlassCard(cornerRadius: 18)
  }

  private func actionSymbol(status: String, conclusion: String?) -> String {
    switch (status, conclusion) {
    case ("completed", "success"):
      return "checkmark.circle.fill"
    case ("completed", "failure"), ("completed", "timed_out"):
      return "xmark.octagon.fill"
    case ("queued", _), ("in_progress", _), ("waiting", _):
      return "clock.fill"
    default:
      return "minus.circle.fill"
    }
  }

  private func actionTint(status: String, conclusion: String?) -> Color {
    switch (status, conclusion) {
    case ("completed", "success"):
      return ADEColor.success
    case ("completed", "failure"), ("completed", "timed_out"):
      return ADEColor.danger
    case ("queued", _), ("in_progress", _), ("waiting", _):
      return ADEColor.warning
    default:
      return ADEColor.textSecondary
    }
  }
}

struct PrLaneCleanupBanner: View {
  let laneName: String?
  let onArchive: () -> Void
  let onDeleteBranch: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 10) {
        Image(systemName: "trash.circle.fill")
          .foregroundStyle(ADEColor.warning)
        VStack(alignment: .leading, spacing: 4) {
          Text("Lane cleanup")
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
          Text("\(laneName ?? "This lane") merged successfully. Clean it up now to archive it or delete its branch.")
            .font(.subheadline)
            .foregroundStyle(ADEColor.textSecondary)
        }
      }

      HStack(spacing: 10) {
        Button("Archive lane") {
          onArchive()
        }
        .buttonStyle(.glass)

        Button("Delete branch") {
          onDeleteBranch()
        }
        .buttonStyle(.glassProminent)
        .tint(ADEColor.warning)
      }
    }
    .adeGlassCard(cornerRadius: 18)
  }
}

struct PrMarkdownRenderer: View {
  let markdown: String

  private var attributed: AttributedString? {
    try? AttributedString(
      markdown: markdown,
      options: AttributedString.MarkdownParsingOptions(
        interpretedSyntax: .full,
        failurePolicy: .returnPartiallyParsedIfPossible
      )
    )
  }

  var body: some View {
    Group {
      if let attributed {
        Text(attributed)
          .foregroundStyle(ADEColor.textPrimary)
          .frame(maxWidth: .infinity, alignment: .leading)
          .textSelection(.enabled)
      } else {
        Text(markdown)
          .foregroundStyle(ADEColor.textPrimary)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
  }
}
