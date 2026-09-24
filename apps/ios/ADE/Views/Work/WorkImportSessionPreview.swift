import Foundation
import SwiftUI

/// The session's conversation, disclosed under the detail header.
///
/// On a host with `work.getExternalSessionDetail` it is the conversation as
/// ADE chat events, rendered by the same builders and row views as a Work chat
/// (messages, tool calls, commands, file changes, reasoning), in a bounded
/// scroller that opens at the newest message with "Load earlier" at the top.
/// On an older host, while the first page loads, or when the call fails, it is
/// the list's sampled messages, as before.
struct WorkImportSessionPreview: View {
  @EnvironmentObject var syncService: SyncService

  let session: ExternalSessionSummary

  @State private var expanded = true
  @State private var events: [AgentChatEventEnvelope] = []
  @State private var entries: [WorkTimelineEntry] = []
  /// The host's text tail, for a host that answered without events.
  @State private var hostMessages: [ExternalSessionMessage] = []
  @State private var hasOlder = false
  @State private var olderCursor: String?
  @State private var loading = false
  @State private var loadingOlder = false
  @State private var olderError: String?
  @State private var expandedCardIds: Set<String> = []

  private static let bottomAnchorId = "work-import-preview-bottom"
  private static let transcriptHeight: CGFloat = 380

  private var fallbackMessages: [ExternalSessionMessage] {
    let host = hostMessages.compactMap { message -> ExternalSessionMessage? in
      let text = message.text.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !text.isEmpty else { return nil }
      return ExternalSessionMessage(role: message.role, text: text, at: message.at)
    }
    return host.isEmpty ? session.conversationMessages : host
  }

  private var disclosureTitle: String {
    if !entries.isEmpty { return "Conversation" }
    let count = fallbackMessages.count
    guard count > 0 else { return "Preview" }
    return "Last \(count) \(count == 1 ? "message" : "messages")"
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Button {
        withAnimation(.easeInOut(duration: 0.18)) {
          expanded.toggle()
        }
      } label: {
        HStack(spacing: 4) {
          Image(systemName: "chevron.right")
            .font(.system(size: 10, weight: .bold))
            .rotationEffect(.degrees(expanded ? 90 : 0))
          Text(disclosureTitle)
            .font(.caption.weight(.semibold))
          if loading {
            ProgressView()
              .controlSize(.mini)
              .padding(.leading, 2)
          }
        }
        .foregroundStyle(ADEColor.textMuted)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityValue(expanded ? "Expanded" : "Collapsed")

      if expanded {
        if !entries.isEmpty {
          transcriptPreview
        } else {
          WorkImportSampledMessagesPreview(session: session, messages: fallbackMessages)
        }
      }
    }
    .task(id: session.importIdentity) {
      await loadNewest()
    }
  }

  private var transcriptPreview: some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 10) {
          if hasOlder {
            loadEarlierControl(proxy: proxy)
          }
          ForEach(entries) { entry in
            entryView(entry)
              .id(entry.id)
          }
          Color.clear
            .frame(height: 1)
            .id(Self.bottomAnchorId)
        }
        .padding(10)
      }
      .defaultScrollAnchor(.bottom, for: .initialOffset)
      .id(session.importIdentity)
      .frame(height: Self.transcriptHeight)
      .background(ADEColor.textPrimary.opacity(0.025), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
      .overlay {
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .stroke(ADEColor.glassBorder.opacity(0.55), lineWidth: 0.6)
      }
      .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
      .environment(\.workChatProvider, session.provider)
      .onAppear {
        proxy.scrollTo(Self.bottomAnchorId, anchor: .bottom)
      }
    }
  }

  @ViewBuilder
  private func loadEarlierControl(proxy: ScrollViewProxy) -> some View {
    VStack(spacing: 4) {
      Button {
        let anchorId = entries.first?.id
        Task {
          await loadOlder()
          // Keep the row the reader was looking at in place instead of jumping
          // to the top of the page that just arrived.
          if let anchorId, entries.contains(where: { $0.id == anchorId }) {
            proxy.scrollTo(anchorId, anchor: .top)
          }
        }
      } label: {
        HStack(spacing: 6) {
          if loadingOlder {
            ProgressView()
              .controlSize(.mini)
          }
          Text(loadingOlder ? "Loading earlier…" : "Load earlier")
            .font(.caption.weight(.semibold))
        }
        .foregroundStyle(ADEColor.accent)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(ADEColor.accent.opacity(0.1), in: Capsule())
      }
      .buttonStyle(.plain)
      .disabled(loadingOlder)

      if let olderError {
        Text(olderError)
          .font(.caption2)
          .foregroundStyle(ADEColor.danger)
      }
    }
    .frame(maxWidth: .infinity)
    .padding(.bottom, 4)
  }

  @ViewBuilder
  private func entryView(_ entry: WorkTimelineEntry) -> some View {
    switch entry.payload {
    case .message(let message):
      WorkChatMessageBubble(
        message: message,
        maxUserBubbleWidth: 260,
        onOpenFullOutput: {}
      )
      .equatable()
    case .toolCard(let card):
      WorkToolCardView(
        toolCard: card,
        isExpanded: expandedCardIds.contains(card.id),
        onToggle: { toggleCard(card.id) },
        onOpenFile: { _ in },
        onOpenPr: { _ in }
      )
      .equatable()
    case .commandCard(let card):
      WorkCommandCardView(
        card: card,
        isExpanded: expandedCardIds.contains(card.id),
        onToggle: { toggleCard(card.id) }
      )
      .equatable()
    case .fileChangeCard(let card):
      WorkFileChangeCardView(
        card: card,
        isExpanded: expandedCardIds.contains(card.id),
        onToggle: { toggleCard(card.id) }
      )
      .equatable()
    case .toolGroup(let group):
      WorkToolCallsPanelView(
        group: group,
        isExpanded: expandedCardIds.contains(group.id),
        onToggle: { toggleCard(group.id) },
        expandedMemberIds: expandedCardIds,
        onToggleMember: { memberId in toggleCard(memberId) }
      )
    case .changedFiles(let group):
      WorkChangedFilesPanelView(
        group: group,
        isExpanded: expandedCardIds.contains(group.id),
        onToggle: { toggleCard(group.id) },
        expandedFileIds: expandedCardIds,
        onToggleFile: { fileId in toggleCard(fileId) },
        onUndo: nil
      )
    case .subagent(let row):
      WorkSubagentTimelineRowView(row: row)
    case .eventCard(let card):
      if card.kind == "reasoning" {
        WorkReasoningCard(
          card: card,
          isLive: false,
          isExpanded: expandedCardIds.contains(card.id),
          onToggle: { toggleCard(card.id) }
        )
      } else if card.kind == "plan" {
        WorkProposedPlanCard(
          card: card,
          isExpanded: expandedCardIds.contains(card.id),
          onToggle: { toggleCard(card.id) }
        )
      } else {
        EmptyView()
      }
    default:
      // Live-session rows (pending inputs, turn footers, usage, artifacts,
      // ADE cards) have nothing to say about a session that is not running.
      EmptyView()
    }
  }

  private func toggleCard(_ id: String) {
    if expandedCardIds.contains(id) {
      expandedCardIds.remove(id)
    } else {
      expandedCardIds.insert(id)
    }
  }

  /// The newest page. The detail view is reused across sessions, so every
  /// load starts from a clean slate.
  private func loadNewest() async {
    events = []
    entries = []
    hostMessages = []
    hasOlder = false
    olderCursor = nil
    olderError = nil
    loadingOlder = false
    expandedCardIds = []
    guard syncService.supportsExternalSessionDetail else { return }
    loading = true
    defer { loading = false }
    do {
      let detail = try await syncService.getExternalSessionDetail(
        provider: session.provider,
        sessionId: session.id
      )
      guard !Task.isCancelled else { return }
      events = detail.events
      hostMessages = detail.messages
      olderCursor = detail.olderCursor
      hasOlder = detail.hasOlder && detail.olderCursor != nil
      rebuildEntries()
    } catch {
      // The sampled messages stay on screen: a failed detail call costs the
      // full conversation, never the preview.
    }
  }

  private func loadOlder() async {
    guard let cursor = olderCursor, !loadingOlder else { return }
    loadingOlder = true
    olderError = nil
    defer { loadingOlder = false }
    do {
      let detail = try await syncService.getExternalSessionDetail(
        provider: session.provider,
        sessionId: session.id,
        before: cursor
      )
      guard !Task.isCancelled else { return }
      let known = Set(events.map(\.id))
      events = detail.events.filter { !known.contains($0.id) } + events
      olderCursor = detail.olderCursor
      hasOlder = detail.hasOlder && detail.olderCursor != nil
      rebuildEntries()
    } catch {
      olderError = "Couldn't load earlier messages."
    }
  }

  /// Same pipeline as a Work chat transcript: envelopes to `WorkChatEnvelope`,
  /// then the timeline snapshot (tool-call folding included), then the
  /// mobile presentation filter.
  private func rebuildEntries() {
    let transcript = makeWorkChatTranscript(from: events)
    let snapshot = buildWorkChatTimelineSnapshot(
      transcript: transcript,
      fallbackEntries: [],
      artifacts: [],
      localEchoMessages: []
    )
    entries = workPresentedTimelineEntries(snapshot.timeline, provider: session.provider)
  }
}

/// The list's sampled messages: the whole preview on an older host, and the
/// fallback while (or if) the full conversation cannot be loaded.
private struct WorkImportSampledMessagesPreview: View {
  let session: ExternalSessionSummary
  let messages: [ExternalSessionMessage]

  var body: some View {
    if !messages.isEmpty {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 0) {
          ForEach(Array(messages.enumerated()), id: \.offset) { index, message in
            WorkImportConversationMessageRow(message: message, provider: session.provider)
            if index < messages.count - 1 {
              Divider()
                .overlay(ADEColor.glassBorder.opacity(0.45))
            }
          }
        }
      }
      .frame(
        height: min(
          260,
          max(92, CGFloat(messages.count) * 72)
        )
      )
      .background(ADEColor.textPrimary.opacity(0.025), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
      .overlay {
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .stroke(ADEColor.glassBorder.opacity(0.55), lineWidth: 0.6)
      }
    } else if let preview = session.previewSnippet,
              !session.previewDuplicatesHeading {
      Text(preview)
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(ADEColor.textPrimary.opacity(0.025), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay {
          RoundedRectangle(cornerRadius: 10, style: .continuous)
            .stroke(ADEColor.glassBorder.opacity(0.55), lineWidth: 0.6)
        }
    } else {
      Text("No conversational preview was recoverable for this session.")
        .font(.caption)
        .foregroundStyle(ADEColor.textMuted)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
  }
}

private struct WorkImportConversationMessageRow: View {
  let message: ExternalSessionMessage
  let provider: String

  private var isUser: Bool {
    message.role == "user"
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(isUser ? "You" : workExternalSessionProviderName(provider))
        .font(.caption2.weight(.bold))
        .foregroundStyle(isUser ? ADEColor.purpleAccent : ADEColor.providerChatAccent(for: provider))
      Text(message.text)
        .font(.caption)
        .foregroundStyle(isUser ? ADEColor.textPrimary : ADEColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.horizontal, 10)
    .padding(.vertical, 8)
    .background(isUser ? ADEColor.purpleAccent.opacity(0.025) : Color.clear)
    .accessibilityElement(children: .combine)
  }
}
