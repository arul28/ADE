import SwiftUI

extension WorkSessionDestinationView {
  @MainActor
  func selectChatLinkedPr(_ prId: String) {
    guard let selected = chatLinkedPrs.first(where: { $0.id == prId }) else { return }
    selectedChatPrId = selected.id
    laneOpenPr = selected
    lanePrTag = workChatLanePrTag(from: selected)
    Task { await refreshChatPrDetails(force: true) }
  }

  @MainActor
  func withChatPrLinkBusy(_ work: () async throws -> Void) async {
    guard !chatPrLinkBusy else { return }
    chatPrLinkBusy = true
    defer { chatPrLinkBusy = false }
    do {
      try await work()
      await resolveLaneOpenPr(for: headerMenuLaneId, forceGithubRefresh: false, clearBeforeLoad: false)
      await refreshChatPrDetails(force: false)
    } catch {
      prDetailsError = SyncUserFacingError.message(for: error)
    }
  }

  @MainActor
  func linkChatPr(prId: String, allowCrossLane: Bool) async {
    await withChatPrLinkBusy {
      try await syncService.linkPullRequestChatSession(
        prId: prId,
        sessionId: sessionId,
        allowCrossLane: allowCrossLane
      )
    }
  }

  @MainActor
  func unlinkCurrentChatPr() async {
    guard let prId = laneOpenPr?.id else { return }
    await withChatPrLinkBusy {
      try await syncService.unlinkPullRequestChatSession(prId: prId, sessionId: sessionId)
      selectedChatPrId = nil
    }
  }

  @MainActor
  func linkChatStackOffer() async {
    guard let offer = visibleChatStackOffer else { return }
    await withChatPrLinkBusy {
      try await syncService.linkPullRequestChatStack(
        sessionId: sessionId,
        stackNumber: offer.stackNumber,
        prId: laneOpenPr?.id,
        siblingPrIds: offer.siblings.map(\.id)
      )
      dismissedStackOfferKey = "\(sessionId):\(offer.stackNumber)"
    }
  }
}
