import SwiftUI
import UIKit
import AVKit

extension WorkChatSessionView {
  @MainActor
  func prepareScrollStateForCurrentSessionIfNeeded(reason: String) {
    guard scrollStateSessionId != session.id else { return }
    resetScrollStateForCurrentSession(reason: reason)
  }

  @MainActor
  func resetScrollStateForCurrentSession(reason: String) {
    scrollStateSessionId = session.id
    isNearBottom = true
    unreadBelowCount = 0
    lastTimelineTailId = nil
    olderHistoryLoadTask?.cancel()
    olderHistoryLoadTask = nil
    olderHistoryLoadInFlight = false
    olderHistoryLoadError = nil
    olderHistoryTriggerArmed = true
    olderHistoryAutomaticContinuationPending = false
    transcriptScroller.resetForNewSession()
  }

  /// True while this timeline row belongs to the turn that is streaming right
  /// now. Every other row — including everything in a freshly opened chat — is
  /// history, and history renders collapsed.
  func isLiveTurnEntry(_ entryId: String) -> Bool {
    isStreamingTurn && timelineSnapshot.liveTurnEntryIds.contains(entryId)
  }

  /// `keepsOpenWhileLive` is the card's own behavior during its turn: plans and
  /// `ade_card`s render in full while they are being written, everything else
  /// opens only on a tap.
  func cardIsExpanded(_ id: String, entryId: String, keepsOpenWhileLive: Bool = false) -> Bool {
    cardExpansion.isExpanded(
      id: id,
      defaultsOpen: keepsOpenWhileLive && isLiveTurnEntry(entryId)
    )
  }

  @MainActor
  func toggleCard(_ id: String, entryId: String, keepsOpenWhileLive: Bool = false) {
    cardExpansion.toggle(
      id: id,
      defaultsOpen: keepsOpenWhileLive && isLiveTurnEntry(entryId)
    )
  }

  /// Nested rows (a file inside the changed-files panel, a call inside a tool
  /// cluster) share the central set so they survive recycling and get swept at
  /// turn end with their parent. They never auto-open.
  @MainActor
  func toggleNestedCard(_ id: String) {
    cardExpansion.toggle(id: id, defaultsOpen: false)
  }

  @MainActor
  func requestEarlierTimelineEntries(automatically: Bool = false) {
    guard !olderHistoryLoadInFlight else { return }
    olderHistoryAutomaticContinuationPending = false
    olderHistoryLoadError = nil
    let revealedBufferedEntries = hiddenTimelineCount > 0
    if hiddenTimelineCount > 0 {
      // The paging window is an engine overlay: the next frame carries the
      // revealed rows, and they land above the viewport where the collection
      // view's anchor keeps the reader's row still.
      let nextVisibleCount = (frame?.visibleTimelineCount ?? workTimelinePageSize) + workTimelinePageSize
      thread.updateOverlays { $0.visibleTimelineCount = nextVisibleCount }
    }
    // Once the locally-buffered timeline is nearly exhausted, pull the next
    // older transcript page from the host so scroll-back continues through
    // the full history instead of stopping at the initial tail fetch.
    if canRequestOlderTranscriptHistory,
       hiddenTimelineCount <= workTimelinePageSize * 2,
       let onLoadOlderTranscript {
      olderHistoryLoadInFlight = true
      let requestedSessionId = session.id
      olderHistoryLoadTask = Task {
        let result = await onLoadOlderTranscript()
        guard !Task.isCancelled, session.id == requestedSessionId else { return }
        olderHistoryLoadTask = nil
        olderHistoryLoadInFlight = false
        if !result.succeeded {
          olderHistoryAutomaticContinuationPending = automatically
          olderHistoryLoadError = "The connected machine did not return this history page. Your cursor was preserved."
          return
        }
        guard automatically,
              hiddenTimelineCount > 0 || result.hasMoreHistory
        else { return }
        olderHistoryAutomaticContinuationPending = true
        if !revealedBufferedEntries,
           !result.addedTimelineEntries,
           let geometry = transcriptScroller.currentGeometry {
          continueAutomaticOlderHistoryIfNeeded(
            distanceFromBottom: geometry.distanceFromBottom,
            contentFitsViewport: geometry.contentFitsViewport
          )
        }
      }
    } else if automatically, hiddenTimelineCount > 0 {
      olderHistoryAutomaticContinuationPending = true
    }
  }

  @MainActor
  func continueAutomaticOlderHistoryIfNeeded(
    distanceFromBottom: CGFloat,
    contentFitsViewport: Bool
  ) {
    guard olderHistoryAutomaticContinuationPending,
          !olderHistoryLoadInFlight,
          olderHistoryLoadError == nil || hiddenTimelineCount > 0
    else { return }
    guard workChatShouldContinueAutomaticOlderHistory(
      distanceFromBottom: distanceFromBottom,
      contentFitsViewport: contentFitsViewport,
      loading: olderHistoryLoadInFlight,
      hasError: olderHistoryLoadError != nil,
      hasBufferedEntries: hiddenTimelineCount > 0,
      hasHostHistory: canRequestOlderTranscriptHistory
    ) else {
      olderHistoryAutomaticContinuationPending = false
      return
    }
    olderHistoryAutomaticContinuationPending = false
    olderHistoryTriggerArmed = false
    requestEarlierTimelineEntries(automatically: true)
  }

  @MainActor
  @discardableResult
  func runSessionAction<T>(_ action: @escaping @MainActor () async -> T) async -> T {
    actionInFlight = true
    defer { actionInFlight = false }
    return await action()
  }

  // MARK: - Consolidated pending-input answering

  /// Optimistically hide a pending input the moment its decision is dispatched
  /// (so the consolidated strip advances to the next request without waiting for
  /// the host), run the action, then reconcile: if the command errored, roll the
  /// hide back so the card re-shows. Successful resolutions are cleared later by
  /// `reconcileOptimisticallyAnsweredInputs` once the item leaves the derived
  /// queue.
  ///
  /// Returns whether THIS answer succeeded so callers (the accept-all sweep) can
  /// gate follow-up work on the real per-action result instead of the shared
  /// `errorMessage` binding.
  @MainActor
  @discardableResult
  func dispatchPendingInputAnswer(
    itemId: String,
    _ op: @escaping @MainActor () async -> Void
  ) async -> Bool {
    thread.updateOverlays { _ = $0.optimisticallyAnsweredInputIds.insert(itemId) }
    // Capture this action's outcome the instant its handler returns. Every
    // answer handler (`approveRequest`, `respondToPermission`,
    // `submitQuestionAnswers`, `respondToQuestion`, `declineQuestion`) writes
    // `errorMessage` as its final synchronous step — nil on success, a message
    // on failure — and there is no suspension point between that write and this
    // read, so the value reflects THIS command rather than an unrelated
    // concurrent action. Both the rollback below and the sweep gate key off the
    // captured local result, never a later read of the shared binding.
    let succeeded = await runSessionAction { () async -> Bool in
      await op()
      return errorMessage == nil
    }
    if !succeeded {
      thread.updateOverlays { _ = $0.optimisticallyAnsweredInputIds.remove(itemId) }
    }
    return succeeded
  }

  /// Drop optimistically-answered ids that are no longer in the canonical queue
  /// (confirmed resolved by the host). Keeps the set from masking a future
  /// request that reuses an id and bounds its growth. Invoked whenever the
  /// canonical pending queue changes.
  @MainActor
  func reconcileOptimisticallyAnsweredInputs() {
    guard !thread.overlays.optimisticallyAnsweredInputIds.isEmpty else { return }
    let canonical = Set(canonicalPendingInputs.map(\.itemId))
    thread.updateOverlays { $0.optimisticallyAnsweredInputIds.formIntersection(canonical) }
  }

  /// "Accept all": flip session auto-approve for the current approval/permission
  /// gate (`acceptForSession`), then accept every remaining approval/permission
  /// request SEQUENTIALLY (never parallel). Question / plan-approval /
  /// model-selection kinds are never swept. Stale itemIds no-op on the host, so
  /// re-sends after `acceptForSession` auto-resolves the rest are safe.
  @MainActor
  func acceptAllPendingInputs() async {
    guard let primary = primaryPendingInput else { return }
    // Snapshot the sweep set before mutating optimistic-hide state.
    let sweepable = acceptAllSweepableInputs
    guard sweepable.contains(where: { $0.itemId == primary.itemId }) else { return }

    // 1. Current item first with acceptForSession. If the session-scoped grant
    //    fails, stop: do NOT fire `.accept` for the rest. The remaining items
    //    stay pending and the primary's optimistic mark was already rolled back
    //    by `dispatchPendingInputAnswer`.
    guard await sendPendingInputDecision(primary, decision: .acceptForSession) else { return }

    // 2. Remaining approval/permission items, one await at a time.
    for item in sweepable where item.itemId != primary.itemId {
      guard !thread.overlays.optimisticallyAnsweredInputIds.contains(item.itemId) else { continue }
      await sendPendingInputDecision(item, decision: .accept)
    }
  }

  /// Route a single approval/permission decision through the optimistic path,
  /// returning whether the decision was dispatched successfully. No-ops (and
  /// reports failure) for kinds that must not be auto-answered.
  @MainActor
  @discardableResult
  private func sendPendingInputDecision(
    _ item: WorkPendingInputItem,
    decision: AgentChatApprovalDecision
  ) async -> Bool {
    switch item {
    case .approval(let model):
      return await dispatchPendingInputAnswer(itemId: model.id) {
        await onApproveRequest(model.id, decision, nil)
      }
    case .permission(let model):
      return await dispatchPendingInputAnswer(itemId: model.id) {
        await onRespondToPermission(model.id, decision)
      }
    case .question, .planApproval, .modelSelection:
      return false
    }
  }
}
