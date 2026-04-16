import SwiftUI

struct PrActivityTab: View {
  let timeline: [PrTimelineEvent]
  @Binding var commentInput: String
  let canAddComment: Bool
  let isLive: Bool
  let onSubmitComment: () -> Void

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
