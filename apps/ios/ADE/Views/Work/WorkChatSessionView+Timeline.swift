import SwiftUI
import UIKit
import AVKit

extension WorkChatSessionView {
  /// Id of the assistant message still receiving streaming deltas, or nil
  /// when no turn is active. Only the LAST message qualifies, and only while
  /// the session is actively streaming — that message's bubble parses its
  /// markdown through the bounded streaming parser; every completed message
  /// keeps the whole-text block cache path.
  var streamingAssistantMessageId: String? {
    guard shouldShowInterruptControl else { return nil }
    return timelineSnapshot.latestMessageAssistantId
  }

  @ViewBuilder
  func timelineRenderEntryView(
    for entry: WorkTimelineRenderEntry,
    proxy: ScrollViewProxy,
    streamingAssistantMessageId: String?,
    maxUserBubbleWidth: CGFloat?
  ) -> some View {
    switch entry.payload {
    case .entry(let timelineEntry):
      timelineEntryView(
        for: timelineEntry,
        proxy: proxy,
        streamingAssistantMessageId: streamingAssistantMessageId,
        maxUserBubbleWidth: maxUserBubbleWidth
      )
    case .assistantMarkdownBlock(let model):
      WorkAssistantMarkdownBlockRow(
        model: model,
        onCopyMessage: { copyAssistantMarkdown(messageId: model.messageId) }
      )
      .equatable()
    case .assistantMonospaced(let model):
      WorkAssistantMonospacedRow(
        model: model,
        onCopyMessage: { copyAssistantMarkdown(messageId: model.messageId) }
      )
      .equatable()
    case .assistantControls(let model):
      WorkAssistantMessageControlsView(
        controls: model,
        onCopyMessage: { copyAssistantMarkdown(messageId: model.messageId) },
        onShowMore: {
          expandAssistantMessage(
            messageId: model.messageId,
            nextLineBudget: model.nextLineBudget,
            proxy: proxy,
            restoreRowId: model.willRemainTruncatedAfterNextStep
              ? entry.id
              : entry.sourceEntryId,
          )
        },
        onOpenFullOutput: { openAssistantMessageFullOutput(messageId: model.messageId) }
      )
      .equatable()
    }
  }

  /// One "Show more" step, for both render paths.
  ///
  /// Expansion grows the message DOWNWARD from a head anchor, so the reader's
  /// current view is unchanged and the right thing to do with the scroll offset
  /// is to leave the row they tapped where it is. It used to re-pin the
  /// transcript to its bottom, which threw the reader to the end of the chat
  /// for asking to see more of a message in the middle of it.
  @MainActor
  func expandAssistantMessage(
    messageId: String,
    nextLineBudget: Int,
    proxy: ScrollViewProxy,
    restoreRowId: String
  ) {
    assistantLineBudgets[messageId] = nextLineBudget
    assistantHeadAnchorOverrides.insert(messageId)
    refreshTimelinePresentation()

    // The expansion changes a tail slice into a head slice. Keep the row the
    // reader acted on at the same viewport edge instead of allowing SwiftUI to
    // choose the newly-created first block and teleport to the beginning.
    DispatchQueue.main.async {
      var transaction = Transaction()
      transaction.disablesAnimations = true
      withTransaction(transaction) {
        proxy.scrollTo(restoreRowId, anchor: .bottom)
      }
    }
  }

  /// Second rung of the message-level ladder: the whole answer, on its own
  /// screen, instead of another bounded step through it.
  @MainActor
  func openAssistantMessageFullOutput(messageId: String) {
    guard let markdown = assistantMarkdown(messageId: messageId) else { return }
    outputViewer.present(
      WorkOutputViewerRequest(title: "Response", text: markdown, kind: .text)
    )
  }

  func copyAssistantMarkdown(messageId: String) {
    guard let markdown = assistantMarkdown(messageId: messageId) else { return }
    UIPasteboard.general.string = markdown
  }

  private func assistantMarkdown(messageId: String) -> String? {
    for entry in visibleTimeline.reversed() {
      if case .message(let message) = entry.payload,
         message.id == messageId {
        return message.markdown
      }
    }
    for entry in timelineSnapshot.timeline.reversed() {
      if case .message(let message) = entry.payload,
         message.id == messageId {
        return message.markdown
      }
    }
    return nil
  }

  @ViewBuilder
  func timelineEntryView(
    for entry: WorkTimelineEntry,
    proxy: ScrollViewProxy,
    streamingAssistantMessageId: String?,
    maxUserBubbleWidth: CGFloat?
  ) -> some View {
    switch entry.payload {
    case .message(let message):
      WorkChatMessageBubble(
        message: message,
        isStreaming: message.id == streamingAssistantMessageId,
        maxUserBubbleWidth: maxUserBubbleWidth,
        onRunUnprocessed: onRunUnprocessedMessage,
        onEditUnprocessed: onEditUnprocessedMessage,
        onDismissUnprocessed: onDismissUnprocessedMessage,
        onShowMore: message.role == "assistant"
          ? {
            expandAssistantMessage(
              messageId: message.id,
              nextLineBudget: workAssistantMessageShowMoreLineBudget(
                current: assistantLineBudgets[message.id] ?? assistantBudgetFloors[message.id]
              ),
              proxy: proxy,
              restoreRowId: entry.id
            )
          }
          : nil,
        // Only an explicit tap writes this map, so its presence *is* "already
        // expanded once".
        hasExpandedInPlace: assistantLineBudgets[message.id] != nil
      )
      .equatable()
    case .toolCard(let toolCard):
      timelineToolCard(toolCard, entryId: entry.id)
    case .eventCard(let card):
      timelineEventCard(card, entryId: entry.id)
    case .adeCard(let card):
      // `WorkAdeCardView` handles the reserved `open` action through navTarget;
      // host-specific action ids stay hidden until iOS has a dispatcher.
      //
      // The contributions and the service are for the `chat-card` socket: a
      // card a plugin emitted may host that plugin's panel, but only when the
      // plugin also DECLARED a card naming it. Passed by value per row — the
      // index is rebuilt once per plugin-row change, never per card.
      if card.isHiddenAfterDismiss {
        EmptyView()
      } else {
        WorkAdeCardView(
          card: card,
          // Live for its own turn, one line ("CI · PR #490  18✓ 3✕") after.
          isExpanded: cardIsExpanded(card.id, entryId: entry.id, keepsOpenWhileLive: true),
          onToggle: { toggleCard(card.id, entryId: entry.id, keepsOpenWhileLive: true) },
          onAction: card.variant == "claude_session_quota"
            ? { action in
              if action.id == "fork-local" {
                Task { await onForkChatInLane?() }
              }
            }
            : nil,
          sessionId: session.id,
          pluginContributions: pluginContributions,
          pluginSyncService: pluginSyncService
        )
        .equatable()
      }
    case .usageSummary(let summary):
      WorkTurnUsageSummaryBanner(
        summary: summary,
        provider: chatSummaryContext.provider,
        modelLabel: chatSummaryContext.modelLabel
      )
    case .commandCard(let commandCard):
      WorkCommandCardView(
        card: commandCard,
        isExpanded: cardIsExpanded(commandCard.id, entryId: entry.id),
        onToggle: { toggleCard(commandCard.id, entryId: entry.id) }
      )
      .equatable()
    case .fileChangeCard(let fileChangeCard):
      WorkFileChangeCardView(
        card: fileChangeCard,
        isExpanded: cardIsExpanded(fileChangeCard.id, entryId: entry.id),
        onToggle: { toggleCard(fileChangeCard.id, entryId: entry.id) }
      )
      .equatable()
    case .subagent(let row):
      WorkSubagentTimelineRowView(row: row, onOpen: onSelectSubagentRow)
    case .subagentStoppedGroup(let model):
      WorkSubagentStoppedGroupCardView(
        model: model,
        isExpanded: cardIsExpanded(model.id, entryId: entry.id),
        onToggle: { toggleCard(model.id, entryId: entry.id) },
        onOpen: onSelectSubagentRow
      )
    case .toolGroup(let group):
      timelineToolGroup(group, entryId: entry.id)
    case .changedFiles(let group):
      timelineChangedFiles(group, entryId: entry.id)
    case .artifact(let artifact):
      timelineArtifact(artifact, entryId: entry.id)
    case .turnSeparator(let separator):
      WorkTurnSeparatorView(separator: separator)
    case .turnEndMarker(let marker):
      let activity = turnToolActivity.completedByTurnId[marker.turnId]
      let isLatestTurnEnd = marker.turnId == timelineSnapshot.latestTurnEndTurnId
      WorkTurnEndMarkerView(
        marker: marker,
        toolCount: activity?.count ?? 0,
        onOpenActivity: activity.map { _ in
          { toolActivitySheet = .completed(marker.turnId) }
        },
        usageViewModel: isLatestTurnEnd
          ? contextUsageViewModelCache.value(
            sessionId: session.id,
            transcript: transcript,
            transcriptRenderSignature: transcriptRenderSignature,
            provider: chatSummaryContext.provider,
            fallbackContextWindow: chatSummaryContext.contextWindowFallback
          )
          : nil,
        modelLabel: chatSummaryContext.modelLabel
      )
    case .pendingQuestion(let question):
      // When offline, still render the card in a disabled (busy) state so the
      // transcript keeps its full context; the top-right gear icon already
      // communicates that the host is unreachable, so an extra "Reconnect to
      // respond" banner here would be redundant noise.
      WorkStructuredQuestionCard(
        question: question,
        busy: actionInFlight || !isLive,
        onSelectOption: { option, freeform in
          await runSessionAction { () async -> Bool in
            await onRespondToQuestion(
              question.id,
              question.questionId,
              .string(option.value),
              freeform
            )
            return errorMessage == nil
          }
        },
        onSubmitAll: { answers, freeform in
          await runSessionAction { () async -> Bool in
            await onSubmitQuestionAnswers(question.id, answers, freeform)
            return errorMessage == nil
          }
        },
        onDecline: {
          await runSessionAction { () async -> Bool in
            await onDeclineQuestion(question.id)
            return errorMessage == nil
          }
        },
        onFreeformFocusChange: { focused in
          guard focused else { return }
          // Wait for the keyboard to start animating in so the ScrollView's
          // safe-area inset is updated before we ask it to scroll the focused
          // card above the keyboard.
          Task { @MainActor in
            try? await Task.sleep(nanoseconds: 300_000_000)
            withAnimation(.easeInOut(duration: 0.25)) {
              proxy.scrollTo("pending-question-\(question.id)", anchor: .bottom)
            }
          }
        },
        fallbackProvider: chatSummaryContext.provider,
        maxCardHeight: workInlinePendingInputMaxHeight(
          transcriptViewportHeight: scrollViewportHeight
        )
      )
      .id("pending-question-\(question.id)")
    case .pendingPermission(let permission):
      WorkPermissionCard(
        permission: permission,
        busy: actionInFlight || !isLive,
        onDecision: { decision in
          await runSessionAction {
            await onRespondToPermission(permission.id, decision)
          }
        }
      )
    case .pendingPlanApproval:
      EmptyView()
    case .pendingModelSelection(let request):
      WorkModelSelectionPendingCard(
        request: request,
        busy: actionInFlight || !isLive,
        onConfirm: { selectionJSON in
          await runSessionAction {
            await onSubmitQuestionAnswers(
              request.id,
              ["selection": .string(selectionJSON)],
              nil
            )
          }
        },
        onCancel: {
          await runSessionAction {
            await onDeclineQuestion(request.id)
          }
        }
      )
    }
  }

  @ViewBuilder
  func timelineToolGroup(_ group: WorkToolGroupModel, entryId: String) -> some View {
    WorkToolCallsPanelView(
      group: group,
      isExpanded: cardIsExpanded(group.id, entryId: entryId),
      onToggle: { toggleCard(group.id, entryId: entryId) },
      expandedMemberIds: cardExpansion.expandedIds,
      onToggleMember: { memberId in toggleNestedCard(memberId) }
    )
  }

  @ViewBuilder
  func timelineChangedFiles(_ group: WorkChangedFilesGroupModel, entryId: String) -> some View {
    WorkChangedFilesPanelView(
      group: group,
      isExpanded: cardIsExpanded(group.id, entryId: entryId),
      onToggle: { toggleCard(group.id, entryId: entryId) },
      expandedFileIds: cardExpansion.expandedIds,
      onToggleFile: { fileId in toggleNestedCard(fileId) },
      onUndo: nil
    )
  }

  @ViewBuilder
  func timelineToolCard(_ toolCard: WorkToolCardModel, entryId: String) -> some View {
    WorkToolCardView(
      toolCard: toolCard,
      isExpanded: cardIsExpanded(toolCard.id, entryId: entryId),
      onToggle: { toggleCard(toolCard.id, entryId: entryId) },
      onOpenFile: { path in
        Task { await onOpenFile(path) }
      },
      onOpenPr: { prNumber in
        Task { await onOpenPr(prNumber) }
      }
    )
    .equatable()
  }

  @ViewBuilder
  func timelineEventCard(_ card: WorkEventCardModel, entryId: String) -> some View {
    if card.kind == "reasoning" {
      WorkReasoningCard(
        card: card,
        isLive: isReasoningLive(card),
        isExpanded: cardIsExpanded(card.id, entryId: entryId),
        onToggle: { toggleCard(card.id, entryId: entryId) }
      )
    } else if card.kind == "plan" {
      WorkProposedPlanCard(
        card: card,
        // A plan being written is the one thing the reader is watching, so it
        // stays open for its own turn and folds to `Plan · 4/7` after.
        isExpanded: cardIsExpanded(card.id, entryId: entryId, keepsOpenWhileLive: true),
        onToggle: { toggleCard(card.id, entryId: entryId, keepsOpenWhileLive: true) }
      )
    } else if card.kind == "question" {
      WorkResolvedQuestionCard(card: card, fallbackProvider: chatSummaryContext.provider)
    } else if card.kind == "planApproval" {
      WorkResolvedPlanCard(card: card, fallbackProvider: chatSummaryContext.provider)
    } else if card.kind == "approval" {
      WorkResolvedApprovalChip(card: card, fallbackProvider: chatSummaryContext.provider)
    } else if card.kind == "codexRecovery" {
      WorkCodexRecoveryCardView(
        card: card,
        sessionId: card.recoverySessionId ?? session.id,
        enabled: isLive,
        onRecover: onRecoverCodexTurn
      )
    } else if card.kind == "turnDiagnostics" {
      WorkTurnDiagnosticsDisclosureView(
        card: card,
        isExpanded: cardIsExpanded(card.id, entryId: entryId),
        onToggle: { toggleCard(card.id, entryId: entryId) }
      )
    } else {
      WorkEventCardView(
        card: card,
        onOpenFile: { path in Task { await onOpenFile(path) } },
        onOpenPr: { number in Task { await onOpenPr(number) } }
      )
      .equatable()
    }
  }

  /// Reasoning is "live" when the session is streaming AND this is the most
  /// recent reasoning entry in the transcript. Everything older collapses.
  func isReasoningLive(_ card: WorkEventCardModel) -> Bool {
    guard isStreamingTurn else { return false }
    let latestReasoningId = eventCards.last(where: { $0.kind == "reasoning" })?.id
    return card.id == latestReasoningId
  }

  @ViewBuilder
  func timelineArtifact(_ artifact: ComputerUseArtifactSummary, entryId: String) -> some View {
    WorkArtifactView(
      artifact: artifact,
      content: artifactContent[artifact.id],
      isExpanded: cardIsExpanded(artifact.id, entryId: entryId),
      onToggle: { toggleCard(artifact.id, entryId: entryId) },
      onAppear: { Task { await onLoadArtifact(artifact) } },
      onOpenImage: { image in
        fullscreenImage = WorkFullscreenImage(title: artifact.title, image: image)
      }
    )
  }
}

struct WorkTurnToolActivityIndex {
  let completedByTurnId: [String: WorkToolGroupModel]
  let active: WorkToolGroupModel?
}

enum WorkToolActivitySheetSelection: Identifiable, Equatable {
  case active
  case completed(String)

  var id: String {
    switch self {
    case .active:
      return "active"
    case .completed(let turnId):
      return "completed:\(turnId)"
    }
  }
}

func workTurnToolActivityIndex(from entries: [WorkTimelineEntry]) -> WorkTurnToolActivityIndex {
  var completed: [String: WorkToolGroupModel] = [:]
  var pendingMembers: [WorkToolGroupMember] = []
  var currentUserTurnId: String?

  func mergedGroup(id: String, members: [WorkToolGroupMember]) -> WorkToolGroupModel? {
    var seen = Set<String>()
    let unique = members.filter { seen.insert($0.id).inserted }
    guard !unique.isEmpty else { return nil }
    return WorkToolGroupModel(id: id, members: unique)
  }

  for entry in entries {
    switch entry.payload {
    case .message(let message) where message.role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "user":
      let turnId = message.turnId?.trimmingCharacters(in: .whitespacesAndNewlines)
      let normalizedTurnId = turnId.flatMap { $0.isEmpty ? nil : $0 }
      let steerId = message.steerId?.trimmingCharacters(in: .whitespacesAndNewlines)
      let isFollowUp = steerId?.isEmpty == false
      if normalizedTurnId != currentUserTurnId || (normalizedTurnId == nil && !isFollowUp) {
        pendingMembers.removeAll(keepingCapacity: true)
      }
      currentUserTurnId = normalizedTurnId
    case .toolGroup(let group):
      pendingMembers.append(contentsOf: group.members)
    case .turnEndMarker(let marker):
      if let group = mergedGroup(id: "turn-activity:\(marker.turnId)", members: pendingMembers) {
        completed[marker.turnId] = group
      }
      pendingMembers.removeAll(keepingCapacity: true)
      currentUserTurnId = nil
    case .turnSeparator:
      // Imported or interrupted transcripts can begin a new turn without a
      // terminal marker for the previous one. Do not attribute that earlier
      // provider's tools to the next turn's completion disclosure.
      pendingMembers.removeAll(keepingCapacity: true)
      currentUserTurnId = nil
    default:
      continue
    }
  }

  return WorkTurnToolActivityIndex(
    completedByTurnId: completed,
    active: mergedGroup(id: "turn-activity:active", members: pendingMembers)
  )
}

struct WorkAssistantMarkdownBlockRow: View, Equatable {
  let model: WorkAssistantMarkdownBlockRenderModel
  let onCopyMessage: () -> Void

  static func == (lhs: WorkAssistantMarkdownBlockRow, rhs: WorkAssistantMarkdownBlockRow) -> Bool {
    lhs.model == rhs.model
  }

  var body: some View {
    WorkMarkdownBlockView(
      block: model.block,
      isStreamingTail: model.isStreamingTail,
      codeSource: model.codeSource
    )
      .frame(maxWidth: .infinity, alignment: .leading)
      .contextMenu {
        Button(action: onCopyMessage) {
          Label("Copy message", systemImage: "doc.on.doc")
        }
      }
      .accessibilityElement(children: .contain)
      .adeInspectable(
        "Work.Chat.MessageBubble.Assistant.Block",
        metadata: [
          "messageId": model.messageId,
          "turnId": model.turnId ?? "",
          "itemId": model.itemId ?? "",
          "blockId": model.block.id
        ]
      )
  }
}

struct WorkAssistantMonospacedRow: View, Equatable {
  let model: WorkAssistantMonospacedRenderModel
  let onCopyMessage: () -> Void

  static func == (lhs: WorkAssistantMonospacedRow, rhs: WorkAssistantMonospacedRow) -> Bool {
    lhs.model == rhs.model
  }

  var body: some View {
    WorkAssistantMonospacedPreview(text: model.text)
      .accessibilityLabel(model.accessibilityLabel)
      .contextMenu {
        Button(action: onCopyMessage) {
          Label("Copy message", systemImage: "doc.on.doc")
        }
      }
      .adeInspectable(
        "Work.Chat.MessageBubble.Assistant.Monospace",
        metadata: [
          "messageId": model.messageId,
          "turnId": model.turnId ?? "",
          "itemId": model.itemId ?? ""
        ]
      )
  }
}

struct WorkAssistantMessageControlsView: View, Equatable {
  let controls: WorkAssistantMessageControlsModel
  let onCopyMessage: () -> Void
  let onShowMore: () -> Void
  let onOpenFullOutput: () -> Void

  static func == (lhs: WorkAssistantMessageControlsView, rhs: WorkAssistantMessageControlsView) -> Bool {
    lhs.controls == rhs.controls
  }

  private var affordance: WorkTruncatedOutputAffordance {
    workTruncatedOutputAffordance(
      isTruncated: controls.canShowMore,
      hasExpandedInPlace: controls.hasExpandedInPlace,
      isClipped: false
    )
  }

  var body: some View {
    HStack(spacing: 12) {
      Text(controls.summaryText)
        .font(.caption2.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)

      Spacer(minLength: 0)

      Button(action: onCopyMessage) {
        Label("Copy full", systemImage: "doc.on.doc")
          .labelStyle(.titleAndIcon)
          .font(.caption2.weight(.semibold))
          .frame(minHeight: 44)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .foregroundStyle(ADEColor.textSecondary)

      switch affordance {
      case .none:
        EmptyView()
      case .showMore:
        Button(action: onShowMore) {
          Label("Show more", systemImage: "chevron.down")
            .labelStyle(.titleAndIcon)
            .font(.caption2.weight(.semibold))
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(ADEColor.accent)
      case .openFullOutput:
        Button(action: onOpenFullOutput) {
          Label("Open full output", systemImage: "arrow.up.left.and.arrow.down.right")
            .labelStyle(.titleAndIcon)
            .font(.caption2.weight(.semibold))
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(ADEColor.accent)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Assistant response preview. \(controls.visibleLineCount) of \(controls.totalLineCount) lines shown.")
  }
}

// MARK: - Consolidated pending-input strip

extension WorkChatSessionView {
  /// Single consolidated pending-input strip pinned above the composer, matching
  /// the desktop approval card. Replaces the previous split of plan/approval
  /// composer strips plus inline question/permission/model-selection transcript
  /// cards: it renders the current (primary) request, shows a "Request 1 of N"
  /// header and an "Accept all" affordance once more than one request is queued,
  /// and advances to the next request as each is answered (via the optimistic
  /// removal path). Plan-approval keeps its existing compact strip body inside
  /// the switch; only its placement changes.
  /// Composer-anchored section wrapper. Type-erasing the optional pending strip
  /// at a property boundary keeps `composerInset` / `body` under the Swift
  /// type-inference budget (the inline `if let` version tipped `body` over).
  /// The optimistic-answer reconcile also lives here rather than on the giant
  /// `body` VStack — this section is always mounted (it renders empty content
  /// when no request is pending), so the `onChange` stays active while keeping
  /// `body`'s modifier chain small enough to type-check.
  var consolidatedPendingStripSection: some View {
    Group {
      if let primaryPendingInput {
        consolidatedPendingInputStrip(primaryPendingInput)
          .id("pending-strip-\(primaryPendingInput.id)")
      }
    }
    .onChange(of: canonicalPendingInputSignature) { _, _ in
      reconcileOptimisticallyAnsweredInputs()
    }
  }

  @ViewBuilder
  func consolidatedPendingInputStrip(_ item: WorkPendingInputItem) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      if pendingInputCollapsed {
        pendingInputCollapsedPill(item)
      } else {
        pendingInputQueueHeader
        consolidatedPendingInputBody(item)
      }
    }
    .animation(.smooth(duration: 0.22), value: pendingInputCollapsed)
  }

  /// "Request 1 of N" + optional "Accept all" + the minimize control. Previously
  /// this row only rendered for queued requests; it is now always present
  /// because it carries the minimize affordance, which every gate needs.
  @ViewBuilder
  private var pendingInputQueueHeader: some View {
    HStack(spacing: 8) {
      if pendingInputCount > 1 {
        Text("Request 1 of \(pendingInputCount)")
          .font(.caption2.weight(.semibold))
          .foregroundStyle(ADEColor.textMuted)
          .accessibilityLabel("Request 1 of \(pendingInputCount) pending.")
      }
      Spacer(minLength: 0)
      if canAcceptAllPendingInputs {
        Button {
          Task { await acceptAllPendingInputs() }
        } label: {
          Text("Accept all")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(ADEColor.accent)
        }
        .buttonStyle(.plain)
        .disabled(actionInFlight || !isLive)
        .accessibilityLabel("Accept all \(acceptAllSweepableInputs.count) pending approvals")
      }
      Button {
        pendingInputCollapsed = true
      } label: {
        Image(systemName: "chevron.down")
          .font(.caption2.weight(.bold))
          .foregroundStyle(ADEColor.textSecondary)
          .frame(width: 26, height: 22)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Minimize request")
      .accessibilityHint("Keeps the request open so you can scroll the conversation.")
    }
    .padding(.horizontal, 4)
    .frame(minHeight: 22)
  }

  /// Minimized state: a single tappable line that keeps the gate visible (and
  /// says what it is) while giving the transcript the screen back.
  @ViewBuilder
  private func pendingInputCollapsedPill(_ item: WorkPendingInputItem) -> some View {
    let provider = workPendingInputProvider(item) ?? chatSummaryContext.provider
    let accent = ADEColor.providerChatAccent(for: provider)
    let summary = workPendingInputCollapsedSummary(item)
    Button {
      pendingInputCollapsed = false
    } label: {
      HStack(spacing: 8) {
        WorkProviderBareLogo(
          provider: provider,
          fallbackSymbol: providerIcon(provider),
          tint: accent,
          size: 15
        )
        Text(summary)
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
          .truncationMode(.tail)
        Spacer(minLength: 4)
        if pendingInputCount > 1 {
          Text("\(pendingInputCount)")
            .font(.caption2.weight(.bold))
            .foregroundStyle(accent)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(accent.opacity(0.16), in: Capsule())
        }
        Image(systemName: "chevron.up")
          .font(.caption2.weight(.bold))
          .foregroundStyle(ADEColor.textSecondary)
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 9)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(ADEColor.surfaceBackground.opacity(0.7), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 14, style: .continuous)
          .stroke(accent.opacity(0.35), lineWidth: 1)
      )
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(summary). Minimized.")
    .accessibilityHint("Expand to answer.")
  }

  @ViewBuilder
  private func consolidatedPendingInputBody(_ item: WorkPendingInputItem) -> some View {
    // The question card budgets itself (its footer has to stay pinned outside
    // the scroll region); every other kind is capped by the shared wrapper.
    if case .question = item {
      pendingInputCard(item)
    } else {
      WorkPendingInputHeightBoundedCard(maxHeight: pendingInputMaxHeight) {
        pendingInputCard(item)
      }
    }
  }

  @ViewBuilder
  private func pendingInputCard(_ item: WorkPendingInputItem) -> some View {
    switch item {
    case .planApproval(let model):
      WorkPlanComposerStrip(
        plan: model,
        busy: actionInFlight || !isLive,
        fallbackProvider: chatSummaryContext.provider,
        onDecision: { decision, feedback in
          await dispatchPendingInputAnswer(itemId: model.id) {
            await onApproveRequest(model.id, decision, feedback)
          }
        }
      )
    case .approval(let model):
      WorkApprovalComposerStrip(
        approval: model,
        busy: actionInFlight || !isLive,
        fallbackProvider: chatSummaryContext.provider,
        onDecision: { decision in
          await dispatchPendingInputAnswer(itemId: model.id) {
            await onApproveRequest(model.id, decision, nil)
          }
        }
      )
    case .permission(let model):
      WorkPermissionCard(
        permission: model,
        busy: actionInFlight || !isLive,
        onDecision: { decision in
          await dispatchPendingInputAnswer(itemId: model.id) {
            await onRespondToPermission(model.id, decision)
          }
        }
      )
    case .question(let model):
      WorkStructuredQuestionCard(
        question: model,
        busy: actionInFlight || !isLive,
        onSelectOption: { option, freeform in
          await dispatchPendingInputAnswer(itemId: model.id) {
            await onRespondToQuestion(
              model.id,
              model.questionId,
              .string(option.value),
              freeform
            )
          }
        },
        onSubmitAll: { answers, freeform in
          await dispatchPendingInputAnswer(itemId: model.id) {
            await onSubmitQuestionAnswers(model.id, answers, freeform)
          }
        },
        onDecline: {
          await dispatchPendingInputAnswer(itemId: model.id) {
            await onDeclineQuestion(model.id)
          }
        },
        fallbackProvider: chatSummaryContext.provider,
        maxCardHeight: pendingInputMaxHeight
      )
    case .modelSelection(let model):
      WorkModelSelectionPendingCard(
        request: model,
        busy: actionInFlight || !isLive,
        onConfirm: { selectionJSON in
          await dispatchPendingInputAnswer(itemId: model.id) {
            await onSubmitQuestionAnswers(
              model.id,
              ["selection": .string(selectionJSON)],
              nil
            )
          }
        },
        onCancel: {
          await dispatchPendingInputAnswer(itemId: model.id) {
            await onDeclineQuestion(model.id)
          }
        }
      )
    }
  }
}
