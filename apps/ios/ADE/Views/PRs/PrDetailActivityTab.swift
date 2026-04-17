import SwiftUI

struct PrActivityTab: View {
  let timeline: [PrTimelineEvent]
  let reviewThreads: [PrReviewThread]
  @Binding var commentInput: String
  let canAddComment: Bool
  let isLive: Bool
  let onSubmitComment: () -> Void
  let onReplyToThread: (String, String) -> Void
  let onSetThreadResolved: (String, Bool) -> Void

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
              PrTimelineRow(event: event)
            }
          }
        }
      }

      if !reviewThreads.isEmpty {
        PrDetailSectionCard("Review threads") {
          VStack(spacing: 12) {
            ForEach(reviewThreads) { thread in
              PrReviewThreadRow(
                thread: thread,
                isLive: isLive,
                onReply: { body in onReplyToThread(thread.id, body) },
                onSetResolved: { resolved in onSetThreadResolved(thread.id, resolved) }
              )
            }
          }
        }
      }

      PrDetailSectionCard("Add comment") {
        VStack(alignment: .leading, spacing: 10) {
          TextEditor(text: $commentInput)
            .frame(minHeight: 120)
            .adeInsetField(cornerRadius: 14, padding: 10)

          Button("Post comment") {
            onSubmitComment()
          }
          .buttonStyle(.glassProminent)
          .tint(ADEColor.accent)
          .disabled(!canAddComment || !isLive || commentInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

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

struct PrReviewThreadRow: View {
  let thread: PrReviewThread
  let isLive: Bool
  let onReply: (String) -> Void
  let onSetResolved: (Bool) -> Void
  @State private var replyBody = ""
  @State private var expanded = false

  private var location: String {
    if let path = thread.path, let line = thread.line ?? thread.originalLine {
      return "\(path):\(line)"
    }
    return thread.path ?? "Review thread"
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .top, spacing: 10) {
        Image(systemName: thread.isResolved ? "checkmark.circle.fill" : "text.bubble.fill")
          .foregroundStyle(thread.isResolved ? ADEColor.success : ADEColor.warning)
        VStack(alignment: .leading, spacing: 4) {
          Text(location)
            .font(.caption.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text(thread.isResolved ? "Resolved" : thread.isOutdated ? "Outdated" : "Needs response")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(ADEColor.textSecondary)
        }
        Spacer(minLength: 0)
        Button(expanded ? "Hide" : "Open") {
          withAnimation(.snappy) {
            expanded.toggle()
          }
        }
        .font(.caption.weight(.semibold))
      }

      if expanded {
        ForEach(thread.comments) { comment in
          VStack(alignment: .leading, spacing: 5) {
            Text(comment.author)
              .font(.caption.weight(.semibold))
              .foregroundStyle(ADEColor.textPrimary)
            if let body = comment.body {
              PrMarkdownRenderer(markdown: body)
            }
          }
          .adeInsetField(cornerRadius: 12, padding: 10)
        }

        TextEditor(text: $replyBody)
          .frame(minHeight: 90)
          .adeInsetField(cornerRadius: 12, padding: 10)

        HStack(spacing: 10) {
          Button("Reply") {
            onReply(replyBody)
            replyBody = ""
          }
          .buttonStyle(.glassProminent)
          .disabled(!isLive || replyBody.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

          Button(thread.isResolved ? "Reopen" : "Resolve") {
            onSetResolved(!thread.isResolved)
          }
          .buttonStyle(.glass)
          .disabled(!isLive)
        }
      }
    }
    .adeInsetField(cornerRadius: 14, padding: 12)
  }
}

struct PrTimelineRow: View {
  let event: PrTimelineEvent

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      Image(systemName: timelineSymbol(event.kind))
        .foregroundStyle(timelineTint(event.kind))
        .padding(.top, 2)

      VStack(alignment: .leading, spacing: 4) {
        HStack(spacing: 8) {
          Text(event.title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Spacer(minLength: 8)
          Text(prRelativeTime(event.timestamp))
            .font(.caption2)
            .foregroundStyle(ADEColor.textMuted)
        }

        if let author = event.author, !author.isEmpty {
          Text(author)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }

        if let body = event.body, !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
          PrMarkdownRenderer(markdown: body)
        }

        if let metadata = event.metadata, !metadata.isEmpty {
          Text(metadata)
            .font(.caption2)
            .foregroundStyle(ADEColor.textMuted)
        }
      }
    }
    .adeInsetField(cornerRadius: 14, padding: 12)
  }
}
