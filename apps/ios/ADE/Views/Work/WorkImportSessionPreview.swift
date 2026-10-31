import Foundation
import SwiftUI

/// The session's conversation, as a plain read-only transcript filling the
/// space under the preview header (no box around it).
///
/// On a host with `work.getExternalSessionDetail` it is the conversation as
/// ADE chat events, rendered by the same builders and row views as a Work chat
/// (messages, tool calls, commands, file changes, reasoning), opening at the
/// newest message with "Load earlier" at the top. On an older host, while the
/// first page loads, or when the call fails, it is the list's sampled
/// messages. Every read goes to the machine that has the session (`source`).
struct WorkImportSessionPreview: View {
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  var syncService: SyncService { syncPublishes.service }

  let session: ExternalSessionSummary
  let source: WorkImportSource

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

  private var fallbackMessages: [ExternalSessionMessage] {
    let host = hostMessages.compactMap { message -> ExternalSessionMessage? in
      let text = message.text.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !text.isEmpty else { return nil }
      return ExternalSessionMessage(role: message.role, text: text, at: message.at)
    }
    return host.isEmpty ? session.conversationMessages : host
  }

  var body: some View {
    Group {
      if !entries.isEmpty {
        transcriptPreview
      } else if loading && fallbackMessages.isEmpty {
        ProgressView()
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else {
        WorkImportSampledMessagesPreview(session: session, messages: fallbackMessages)
      }
    }
    .task(id: "\(session.importIdentity)|\(source.machineKey ?? "-")") {
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
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
      }
      .defaultScrollAnchor(.bottom, for: .initialOffset)
      .id(session.importIdentity)
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
    case .toolGroup(let group) where !group.computerUseActions.isEmpty:
      WorkComputerUseRunView(actions: group.computerUseActions)
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
    guard syncService.workImportSupportsDetail(source) else { return }
    loading = true
    defer { loading = false }
    do {
      let detail = try await syncService.workImportSessionDetail(
        provider: session.provider,
        sessionId: session.id,
        source: source
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
      let detail = try await syncService.workImportSessionDetail(
        provider: session.provider,
        sessionId: session.id,
        before: cursor,
        source: source
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
/// fallback while (or if) the full conversation cannot be loaded. Plain
/// transcript lines, newest at the bottom.
private struct WorkImportSampledMessagesPreview: View {
  let session: ExternalSessionSummary
  let messages: [ExternalSessionMessage]

  var body: some View {
    if !messages.isEmpty {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 14) {
          ForEach(Array(messages.enumerated()), id: \.offset) { _, message in
            WorkImportConversationMessageRow(message: message, provider: session.provider)
          }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
      }
      .defaultScrollAnchor(.bottom, for: .initialOffset)
    } else if let preview = session.previewSnippet,
              !session.previewDuplicatesHeading {
      ScrollView {
        Text(preview)
          .font(.callout)
          .foregroundStyle(ADEColor.textSecondary)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(16)
      }
    } else {
      Text("No conversation was recoverable for this session.")
        .font(.footnote)
        .foregroundStyle(ADEColor.textMuted)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
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
        .font(.caption.weight(.semibold))
        .foregroundStyle(isUser ? ADEColor.textSecondary : ADEColor.providerChatAccent(for: provider))
      Text(message.text)
        .font(.callout)
        .foregroundStyle(ADEColor.textPrimary)
        .fixedSize(horizontal: false, vertical: true)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .combine)
  }
}
