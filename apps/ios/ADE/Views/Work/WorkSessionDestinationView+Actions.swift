import SwiftUI
import UIKit
import AVKit

func workFilteredQuestionAnswersForSubmit(
  _ answers: [String: AgentChatInputAnswerValue]
) -> [String: AgentChatInputAnswerValue] {
  answers.reduce(into: [:]) { acc, pair in
    switch pair.value {
    case .string(let raw):
      if !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        acc[pair.key] = .string(raw)
      }
    case .strings(let values):
      let filtered = values.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
      if !filtered.isEmpty { acc[pair.key] = .strings(filtered) }
    }
  }
}

extension WorkSessionDestinationView {
  @MainActor
  func sendMessage(
    _ text: String,
    attachments inputAttachments: [WorkChatInputAttachment] = [],
    deliveryMode: WorkActiveSendMode = .queue
  ) async -> Bool {
    let useSteer = shouldSteerActiveTurn
    guard !sending || useSteer else { return false }
    let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return false }
    guard canSendChatMessages else { return false }
    if workChatBlocksManualCompactSend(
      text: text,
      shouldSteer: useSteer,
      turnHintActive: liveTurnActiveHint == true
    ) {
      errorMessage = "Wait for this turn to finish before compacting."
      return false
    }

    // The echo goes up before the upload, not after it. Saving attachments is a
    // per-image round-trip to the host; waiting for it left the tap with no
    // visible result for seconds. Placeholder refs render the composer's own
    // downscaled image with an uploading state, then get swapped for the real
    // host paths before anything is sent.
    let pendingUploadRefs = WorkPendingUploadPreviewStore.shared.register(
      workChatInputReadyAttachments(inputAttachments)
    )
    // Desktop parity: the chosen active-turn mode rides the steer itself, so a
    // host that can honor it dispatches in one round-trip and the message never
    // enters the staged queue. Resolved before the send, not after it, so the
    // "turn is already active" resend below carries the same mode — that is
    // where a Send-now tap used to be silently downgraded to a staged message.
    let atomicDispatchMode = workChatAtomicSteerDispatchMode(
      deliveryMode: deliveryMode,
      dispatchModes: manualSteerDispatchModes
    )
    let willStage = sendWillQueueChatMessage || (useSteer && atomicDispatchMode == nil)
    let initialDeliveryState = willStage ? "queued" : "sending"
    let echo = WorkLocalEchoMessage(
      text: text,
      timestamp: workDateFormatter.string(from: Date()),
      deliveryState: initialDeliveryState,
      attachments: pendingUploadRefs.isEmpty ? nil : pendingUploadRefs
    )
    let echoId = echo.id
    localEchoMessages.append(echo)
    sending = true

    let attachmentRefs: [AgentChatFileRef]
    do {
      attachmentRefs = try await workChatSaveInputAttachments(
        inputAttachments,
        syncService: syncService,
        chatSessionId: sessionId
      )
    } catch {
      sending = false
      WorkPendingUploadPreviewStore.shared.release(pendingUploadRefs)
      localEchoMessages.removeAll { $0.id == echoId }
      ADEHaptics.error()
      errorMessage = error.localizedDescription
      return false
    }
    // Swap placeholders for host paths before the send: the echo's dedupe key
    // (text + attachment refs) has to match the transcript row that comes back,
    // or reconciliation would leave a duplicate bubble behind.
    updateLocalEchoAttachments(echoId: echoId, attachments: attachmentRefs.isEmpty ? nil : attachmentRefs)
    // Promote rather than release: the swap replaces the chip, and dropping the
    // in-memory image here would flash the generic placeholder while the fresh
    // chip fetched the copy we just uploaded.
    WorkPendingUploadPreviewStore.shared.promote(pendingUploadRefs, to: attachmentRefs)

    defer { sending = false }
    do {
      let delivery: SyncChatMessageDelivery
      if useSteer {
        do {
          delivery = try await syncService.steerChatSession(
            sessionId: sessionId,
            text: text,
            attachments: attachmentRefs.isEmpty ? nil : attachmentRefs,
            dispatchMode: atomicDispatchMode
          )
        } catch where workChatErrorIndicatesUnsupportedDispatchMode(error) {
          // An older host rejects a mode this client offers. On a normal chat,
          // omit the mode so the message stages instead of failing the send.
          // On the CTO surface queue is not offered: omitting the mode would
          // auto-route to interrupt, cancelling the running agent for a tap
          // that said Send during turn. Fail instead and keep the draft.
          if workChatShouldStageAfterUnsupportedDispatchMode(liveRedirectOnly: liveRedirectOnlySends) {
            updateLocalEchoDeliveryState(echoId: echoId, deliveryState: "queued")
            delivery = try await syncService.steerChatSession(
              sessionId: sessionId,
              text: text,
              attachments: attachmentRefs.isEmpty ? nil : attachmentRefs,
              dispatchMode: nil
            )
          } else {
            ADEHaptics.error()
            localEchoMessages.removeAll { $0.id == echoId }
            WorkPendingUploadPreviewStore.shared.release(pendingUploadRefs)
            errorMessage = "This computer’s ADE cannot send during the turn. Update it, or pick Interrupt & continue."
            return false
          }
        }
      } else {
        do {
          delivery = try await syncService.sendChatMessage(
            sessionId: sessionId,
            text: text,
            attachments: attachmentRefs.isEmpty ? nil : attachmentRefs
          )
        } catch where workChatErrorIndicatesActiveTurn(error) {
          if workChatIsManualCompactCommand(text) {
            ADEHaptics.error()
            localEchoMessages.removeAll { $0.id == echoId }
            WorkPendingUploadPreviewStore.shared.release(pendingUploadRefs)
            errorMessage = "Wait for this turn to finish before compacting."
            return false
          }
          // The row said idle but the runtime is busy. Resend as a steer — with
          // the mode attached, so an atomic send stays an atomic send and the
          // echo keeps its "sending" state instead of flashing "queued".
          if atomicDispatchMode == nil {
            updateLocalEchoDeliveryState(echoId: echoId, deliveryState: "queued")
          }
          delivery = try await syncService.steerChatSession(
            sessionId: sessionId,
            text: text,
            attachments: attachmentRefs.isEmpty ? nil : attachmentRefs,
            dispatchMode: atomicDispatchMode
          )
        }
      }
      switch delivery {
      case .queued(let steerId):
        // Two hosts land here. An old one predates `dispatchMode` on
        // `chat.steer` (it shipped later than `chat.dispatchSteer`, which is
        // what the capability gate checks). A current one staged the row on
        // purpose because the live run refused an inline steer. The two-step
        // promotion is right for the first and harmless for the second, but only
        // the host can say whether it landed — so read the result rather than
        // assuming a non-throwing call delivered.
        if let steerId, let atomicDispatchMode {
          do {
            let dispatched = try await syncService.dispatchChatSteer(
              sessionId: sessionId,
              steerId: steerId,
              mode: atomicDispatchMode
            )
            if !dispatched {
              // Still staged on the host. Keep the queued echo and the chip so
              // the message stays visible until the turn boundary sends it.
              updateLocalEchoDeliveryState(echoId: echoId, deliveryState: "queued")
              upsertOptimisticPendingSteer(
                id: steerId,
                text: text,
                timestamp: echo.timestamp,
                attachments: attachmentRefs.isEmpty ? nil : attachmentRefs
              )
              schedulePostSendReconciliation(reconcileLocalEchoes: false)
              // The send succeeded — the message is staged, not failed — so the
              // shared tail's cleanup has to run here too. Returning without it
              // leaves a stale error banner over a send that worked.
              openingDeliveryWarning = nil
              errorMessage = nil
              return true
            }
          } catch {
            // Staging already succeeded on the host. Keep the single queued
            // message and clear the composer instead of restoring a duplicate
            // draft when the requested immediate dispatch fails.
            ADEHaptics.error()
            updateLocalEchoDeliveryState(echoId: echoId, deliveryState: "queued")
            upsertOptimisticPendingSteer(
              id: steerId,
              text: text,
              timestamp: echo.timestamp,
              attachments: attachmentRefs.isEmpty ? nil : attachmentRefs
            )
            schedulePostSendReconciliation(reconcileLocalEchoes: false)
            errorMessage = "Couldn’t send immediately. The message is still queued."
            return true
          }
          updateLocalEchoDeliveryState(echoId: echoId, deliveryState: nil)
          schedulePostSendReconciliation()
          break
        }
        updateLocalEchoDeliveryState(echoId: echoId, deliveryState: "queued")
        if let steerId {
          upsertOptimisticPendingSteer(
            id: steerId,
            text: text,
            timestamp: echo.timestamp,
            attachments: attachmentRefs.isEmpty ? nil : attachmentRefs
          )
        }
      case .sent:
        updateLocalEchoDeliveryState(echoId: echoId, deliveryState: nil)
        schedulePostSendReconciliation()
      case .dropped:
        // The steer queue is full; the host dropped the message (and emitted its
        // own transcript notice). Pull the optimistic echo so it doesn't linger
        // as if delivered, and return false so the composer restores the text
        // for a resend — matching desktop.
        ADEHaptics.error()
        localEchoMessages.removeAll { $0.id == echoId }
        errorMessage = "Message not sent — the queue is full. Wait for the current turn to finish, then resend."
        return false
      }
      openingDeliveryWarning = nil
      errorMessage = nil
      return true
    } catch {
      ADEHaptics.error()
      localEchoMessages.removeAll { echo in
        echo.id == echoId
      }
      errorMessage = error.localizedDescription
      return false
    }
  }

  /// Runs the post-send refresh cascade (transcript → artifacts → summary →
  /// session) behind the composer instead of in front of it.
  ///
  /// The host has already accepted the message at this point; holding `sending`
  /// through four serial round-trips kept the spinner up and the composer gated
  /// for the whole cascade. Chained onto the previous post-send refresh so two
  /// quick sends can't interleave two transcript loads.
  @MainActor
  func schedulePostSendReconciliation(reconcileLocalEchoes: Bool = true) {
    let previous = postSendRefreshTask
    postSendRefreshTask = Task { @MainActor in
      await previous?.value
      guard !Task.isCancelled else { return }
      await refreshChatStateAfterAction(forceRemote: true)
      guard !Task.isCancelled else { return }
      if reconcileLocalEchoes {
        reconcileLocalEchoMessages()
      }
    }
  }

  @MainActor
  func interruptSession(mode: AgentChatStopMode = .stopAndClear) async {
    do {
      try await syncService.interruptChatSession(sessionId: sessionId, mode: mode)
      await refreshChatStateAfterAction(forceRemote: true)
      errorMessage = nil
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  func restoreCancelledQueue(recoveryId: String) async {
    do {
      let result = try await syncService.restoreCancelledChatQueue(
        sessionId: sessionId,
        recoveryId: recoveryId
      )
      guard result.restored else {
        errorMessage = "The cancelled queue can no longer be restored."
        return
      }
      ADEHaptics.success()
      await refreshChatStateAfterAction(forceRemote: true)
      errorMessage = nil
    } catch {
      ADEHaptics.error()
      errorMessage = "Couldn’t restore the cancelled queue. \(error.localizedDescription)"
    }
  }

  /// Don't continue (`enabled: false`) and Try again / Turn on (`enabled: true`)
  /// are the same host call — `chat.updateSession { autoContinueAtUsageLimit }`.
  /// Re-enabling clears a `paused` streak host-side and arms once more.
  @MainActor
  func setUsageLimitAutoContinue(_ enabled: Bool) async {
    do {
      // Only an opt-out has a pending row to cancel; re-enabling asks the host
      // to arm a fresh one, so cancelling here would race its own replacement.
      if !enabled,
         let schedule = WorkUsageLimitOptOut.pendingSchedule(composerChatSummary?.scheduledWork),
         syncService.canInvokeChatRemoteAction("chat.cancelScheduledWork", sessionId: sessionId) {
        _ = try? await syncService.cancelScheduledWork(sessionId: sessionId, scheduleId: schedule.id)
      }
      _ = try await syncService.updateChatSession(
        sessionId: sessionId,
        autoContinueAtUsageLimit: enabled
      )
      await refreshChatStateAfterAction(forceRemote: true)
      errorMessage = nil
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  /// Resume now — send the continue prompt immediately instead of waiting for
  /// the scheduled fire.
  ///
  /// Host support is not re-checked here. The sheet's only caller already nils
  /// the button out when the host predates `chat.resumeUsageLimitNow`, so an
  /// unsupported host has nothing to tap. Viewer devices and offline hosts fall
  /// through to `SyncService.resumeUsageLimitNow`, whose
  /// `requireInvokableRemoteAction` gate names the actual cause — telling a
  /// viewer to update the host would be a lie.
  @MainActor
  func resumeUsageLimitNow() async {
    do {
      let result = try await syncService.resumeUsageLimitNow(sessionId: sessionId)
      // A refusal answers normally with `ok: false` — the host declined to send
      // because there is nothing live to resume, or a resume is already in
      // flight. Nothing was sent, so this must not read as a success: show the
      // host's sentence verbatim (the desktop popover shows the same one) and
      // keep the failure haptic. Still refresh, because the refusal itself
      // means this client's view of the limit is stale.
      if let refusal = result.refusalMessage {
        ADEHaptics.error()
        await refreshChatStateAfterAction(forceRemote: true)
        errorMessage = refusal
        return
      }
      ADEHaptics.success()
      await refreshChatStateAfterAction(forceRemote: true)
      errorMessage = nil
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  /// Continue the interrupted task on another signed-in account. The original
  /// thread stays parked; the host starts a new chat.
  @MainActor
  func continueUsageLimitOnAlternate() async {
    do {
      let result = try await syncService.continueUsageLimitOnAlternate(sessionId: sessionId)
      if let refusal = result.refusalMessage {
        ADEHaptics.error()
        await refreshChatStateAfterAction(forceRemote: true)
        errorMessage = refusal
        return
      }
      ADEHaptics.success()
      await refreshChatStateAfterAction(forceRemote: true)
      errorMessage = nil
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  func stopChatTask(taskId: String) async {
    do {
      try await syncService.stopChatTask(sessionId: sessionId, taskId: taskId)
      await refreshChatStateAfterAction(forceRemote: true)
      errorMessage = nil
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  func recoverCodexTurn(sessionId targetSessionId: String, turnId: String, action: String) async throws -> String {
    let result = try await syncService.recoverCodexTurn(
      sessionId: targetSessionId,
      turnId: turnId,
      action: action
    )
    await refreshChatStateAfterAction(forceRemote: true)
    errorMessage = nil
    return workTurnRecoveryFeedback(status: result.status)
  }

  @MainActor
  func runUnprocessedMessage(_ message: WorkChatMessage) async throws {
    guard liveTurnActiveHint != true && !shouldSteerActiveTurn else {
      throw NSError(
        domain: "ADE",
        code: 28,
        userInfo: [NSLocalizedDescriptionKey: "A turn is already active. Wait for it to finish, then run this message."]
      )
    }
    guard !sending else {
      throw NSError(
        domain: "ADE",
        code: 27,
        userInfo: [NSLocalizedDescriptionKey: "Another message is already being sent."]
      )
    }
    let steerId = message.steerId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard !steerId.isEmpty else {
      throw NSError(
        domain: "ADE",
        code: 25,
        userInfo: [NSLocalizedDescriptionKey: "This message is missing its durable delivery identifier."]
      )
    }
    sending = true
    defer { sending = false }
    _ = try await syncService.resolveUnprocessedMessage(
      sessionId: sessionId,
      steerId: steerId,
      action: "run_next"
    )
    await refreshChatStateAfterAction(forceRemote: true)
    errorMessage = nil
  }

  @MainActor
  func editUnprocessedMessage(_ message: WorkChatMessage) async throws {
    let text = message.markdown.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else {
      throw NSError(
        domain: "ADE",
        code: 26,
        userInfo: [NSLocalizedDescriptionKey: "This message has no editable text."]
      )
    }
    composerDraftRestore = WorkChatComposerDraftRestore(
      text: text,
      replacesExistingDraft: true
    )
    errorMessage = nil
  }

  @MainActor
  func dismissUnprocessedMessage(_ message: WorkChatMessage) async throws {
    let steerId = message.steerId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard !steerId.isEmpty else {
      throw NSError(
        domain: "ADE",
        code: 25,
        userInfo: [NSLocalizedDescriptionKey: "This message is missing its durable delivery identifier."]
      )
    }
    _ = try await syncService.resolveUnprocessedMessage(
      sessionId: sessionId,
      steerId: steerId,
      action: "dismiss"
    )
    await refreshChatStateAfterAction(forceRemote: true)
    errorMessage = nil
  }

  @MainActor
  func approveRequest(itemId: String, decision: AgentChatApprovalDecision, responseText: String? = nil) async {
    do {
      let responseValue = responseText?.trimmingCharacters(in: .whitespacesAndNewlines)
      try await syncService.approveChatSession(
        sessionId: sessionId,
        itemId: itemId,
        decision: decision,
        responseText: responseValue?.isEmpty == true ? nil : responseValue
      )
      await refreshChatStateAfterAction(forceRemote: true)
      errorMessage = nil
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  func cancelSteer(_ steerId: String) async {
    do {
      try await syncService.cancelChatSteer(sessionId: sessionId, steerId: steerId)
      optimisticPendingSteers.removeAll { $0.id == steerId }
      await refreshChatStateAfterAction(forceRemote: true)
      errorMessage = nil
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  func editSteer(_ steerId: String, _ text: String) async {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    do {
      try await syncService.editChatSteer(sessionId: sessionId, steerId: steerId, text: trimmed)
      if let index = optimisticPendingSteers.firstIndex(where: { $0.id == steerId }) {
        optimisticPendingSteers[index] = WorkPendingSteerModel(
          id: steerId,
          text: trimmed,
          attachments: optimisticPendingSteers[index].attachments,
          turnId: optimisticPendingSteers[index].turnId,
          timestamp: workDateFormatter.string(from: Date())
        )
      }
      await refreshChatStateAfterAction(forceRemote: true)
      errorMessage = nil
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  func dispatchSteerInline(_ steerId: String) async {
    await dispatchSteer(steerId, mode: "inline")
  }

  @MainActor
  func dispatchSteerInterrupt(_ steerId: String) async {
    await dispatchSteer(steerId, mode: "interrupt")
  }

  /// Promote a staged row into the live turn.
  ///
  /// The chip is cleared only when the host reports it actually dispatched. Both
  /// modes can answer `dispatchedAt: null` without throwing — an inline steer the
  /// run refuses, or a promotion whose row already left the queue — and clearing
  /// the chip there makes the message vanish from view before it is sent.
  @MainActor
  private func dispatchSteer(_ steerId: String, mode: String) async {
    do {
      let dispatched = try await syncService.dispatchChatSteer(
        sessionId: sessionId,
        steerId: steerId,
        mode: mode
      )
      if dispatched { optimisticPendingSteers.removeAll { $0.id == steerId } }
      await refreshChatStateAfterAction(forceRemote: true)
      errorMessage = nil
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  func selectModel(_ modelId: String) async {
    do {
      _ = try await syncService.updateChatSession(sessionId: sessionId, modelId: modelId)
      await refreshChatStateAfterAction(forceRemote: true)
      errorMessage = nil
      // Persist as the app-wide "last used" model so the next New Chat opens on
      // it. The inline picker is cross-provider (a Claude chat can pick e.g. a
      // Codex model), so re-derive the provider from the picked model rather
      // than persisting the chat's old provider — otherwise restore would seed a
      // mismatched provider/model pair the New Chat init does not reconcile.
      // Keep the independent composer settings when the model changes provider.
      if let summary = chatSummary {
        let resolvedProvider = workComposerRuntimeProvider(forModelId: modelId, currentProvider: summary.provider)
        WorkComposerPreferences.save(
          provider: resolvedProvider,
          modelId: modelId,
          runtimeMode: workInitialRuntimeMode(summary),
          reasoningEffort: summary.reasoningEffort ?? "",
          codexFastMode: summary.effectiveFastMode
        )
      }
      ADEHaptics.light()
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  func takeOverSubagent() async {
    do {
      let updated = try await syncService.updateChatSession(sessionId: sessionId, spawnKind: "peer")
      applySpawnKindSessionUpdate(updated, spawnKind: updated.spawnKind ?? .peer)
      errorMessage = nil
      ADEHaptics.light()
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  func keepReportingSubagent() async {
    do {
      let updated = try await syncService.updateChatSession(
        sessionId: sessionId,
        subagentTakeoverPromptShown: true
      )
      applySpawnKindSessionUpdate(updated)
      errorMessage = nil
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  func applySpawnKindSessionUpdate(
    _ updated: AgentChatSession,
    spawnKind: AgentChatSpawnKind? = nil
  ) {
    let shownAtFallback = ISO8601DateFormatter().string(from: Date())
    guard let summary = workApplyingSpawnKindUpdate(
      current: chatSummary,
      fallback: lastKnownChatSummary ?? initialChatSummary,
      spawnKind: spawnKind ?? updated.spawnKind,
      subagentTakeoverPromptShownAt: updated.subagentTakeoverPromptShownAt,
      shownAtFallback: shownAtFallback
    ) else { return }
    chatSummary = summary
    lastKnownChatSummary = summary
    syncService.cacheChatSummary(summary)
  }

  @MainActor
  func selectReasoningEffort(_ effort: String) async {
    let trimmed = effort.trimmingCharacters(in: .whitespacesAndNewlines)
    do {
      _ = try await syncService.updateChatSession(sessionId: sessionId, reasoningEffort: trimmed)
      await refreshChatStateAfterAction(forceRemote: true)
      errorMessage = nil
      // Mirror into the app-wide "last used" selection so the next New Chat
      // restores it. Persisting from here (not only from selectModel) covers a
      // combined model+effort inline change, where selectModel ran first with the
      // prior effort and would otherwise leave the stored effort stale.
      if let summary = chatSummary {
        WorkComposerPreferences.save(
          provider: summary.provider,
          modelId: summary.modelId ?? summary.model,
          runtimeMode: workInitialRuntimeMode(summary),
          reasoningEffort: trimmed,
          codexFastMode: summary.effectiveFastMode
        )
      }
      ADEHaptics.light()
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  func selectCodexFastMode(_ enabled: Bool) async -> Bool {
    do {
      _ = try await syncService.updateChatSession(sessionId: sessionId, codexFastMode: enabled)
      await refreshChatStateAfterAction(forceRemote: true)
      errorMessage = nil
      // Mirror the fast-mode change into the app-wide "last used" selection (the
      // model / effort are unchanged by a fast-mode toggle) so a combined inline
      // change persists the final fast-mode value rather than selectModel's stale one.
      if let summary = chatSummary {
        WorkComposerPreferences.save(
          provider: summary.provider,
          modelId: summary.modelId ?? summary.model,
          runtimeMode: workInitialRuntimeMode(summary),
          reasoningEffort: summary.reasoningEffort ?? "",
          codexFastMode: enabled
        )
      }
      ADEHaptics.light()
      return true
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
      return false
    }
  }

  @MainActor
  func selectRuntimeMode(_ modeId: String) async -> Bool {
    guard let summary = chatSummary else { return false }
    let wire = workRuntimeWireFields(provider: summary.provider, mode: modeId)
    guard wire.permissionMode != nil
      || wire.interactionMode != nil
      || wire.claudePermissionMode != nil
      || wire.codexApprovalPolicy != nil
      || wire.codexSandbox != nil
      || wire.codexConfigSource != nil
      || wire.opencodePermissionMode != nil
      || wire.droidPermissionMode != nil
      || wire.cursorModeId != nil
    else { return false }

    do {
      _ = try await syncService.updateChatSession(
        sessionId: sessionId,
        permissionMode: wire.permissionMode,
        interactionMode: wire.interactionMode,
        claudePermissionMode: wire.claudePermissionMode,
        codexApprovalPolicy: wire.codexApprovalPolicy,
        codexSandbox: wire.codexSandbox,
        codexConfigSource: wire.codexConfigSource,
        opencodePermissionMode: wire.opencodePermissionMode,
        droidPermissionMode: wire.droidPermissionMode,
        cursorModeId: wire.cursorModeId
      )
      await refreshChatStateAfterAction(forceRemote: true)
      errorMessage = nil
      // Persist as the app-wide "last used" access mode so the next New Chat
      // opens on it (the model / sub-settings are unchanged by a mode change).
      WorkComposerPreferences.save(
        provider: summary.provider,
        modelId: summary.modelId ?? summary.model,
        runtimeMode: modeId,
        reasoningEffort: summary.reasoningEffort ?? "",
        codexFastMode: summary.effectiveFastMode
      )
      ADEHaptics.light()
      return true
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
      return false
    }
  }

  @MainActor
  func submitQuestionAnswers(
    itemId: String,
    answers: [String: AgentChatInputAnswerValue],
    responseText: String?
  ) async {
    do {
      let responseValue = responseText?.trimmingCharacters(in: .whitespacesAndNewlines)
      let filtered = workFilteredQuestionAnswersForSubmit(answers)
      try await syncService.respondToChatInput(
        sessionId: sessionId,
        itemId: itemId,
        decision: .accept,
        answers: filtered.isEmpty ? nil : filtered,
        responseText: (responseValue?.isEmpty ?? true) ? nil : responseValue
      )
      await refreshChatStateAfterAction(forceRemote: true)
      errorMessage = nil
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  func respondToQuestion(
    itemId: String,
    questionId: String,
    answer: AgentChatInputAnswerValue?,
    responseText: String?
  ) async {
    do {
      let responseValue = responseText?.trimmingCharacters(in: .whitespacesAndNewlines)
      let answers: [String: AgentChatInputAnswerValue]? = {
        guard let answer else { return nil }
        let filtered = workFilteredQuestionAnswersForSubmit([questionId: answer])
        return filtered.isEmpty ? nil : filtered
      }()
      try await syncService.respondToChatInput(
        sessionId: sessionId,
        itemId: itemId,
        decision: .accept,
        answers: answers,
        responseText: responseValue?.isEmpty == true ? nil : responseValue
      )
      await refreshChatStateAfterAction(forceRemote: true)
      errorMessage = nil
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  func declineQuestion(itemId: String) async {
    do {
      try await syncService.respondToChatInput(
        sessionId: sessionId,
        itemId: itemId,
        decision: .decline,
        answers: nil,
        responseText: nil
      )
      await refreshChatStateAfterAction(forceRemote: true)
      errorMessage = nil
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  /// Throw a dismissible question away. Distinct from `declineQuestion`
  /// because it is a different host command with a different refusal — a card
  /// the provider is still waiting on comes back as an error the user sees.
  @MainActor
  func dismissPendingQuestion(itemId: String) async {
    do {
      try await syncService.dismissChatPendingInput(sessionId: sessionId, itemId: itemId)
      await refreshChatStateAfterAction(forceRemote: true)
      errorMessage = nil
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  func respondToPermission(itemId: String, decision: AgentChatApprovalDecision) async {
    do {
      try await syncService.respondToChatInput(
        sessionId: sessionId,
        itemId: itemId,
        decision: decision,
        answers: nil,
        responseText: nil
      )
      await refreshChatStateAfterAction(forceRemote: true)
      errorMessage = nil
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  /// Loads one artifact's preview. A stored video larger than
  /// `workArtifactEagerVideoMaxBytes` is only sized on `.preview` (rows and
  /// cards show a play placeholder) and downloads on `.play`.
  @MainActor
  func loadArtifactContent(_ artifact: ComputerUseArtifactSummary, _ intent: WorkArtifactLoadIntent) async {
    switch artifactContent[artifact.id] {
    case .none: break
    case .videoOnDemand where intent == .play: break
    default: return
    }
    guard !artifactContentLoadsInFlight.contains(artifact.id) else { return }
    let scope = artifactLoadScope
    artifactContentLoadsInFlight.insert(artifact.id)
    defer {
      // A load that outlived its chat leaves the next chat's bookkeeping alone.
      if scope.isActive { artifactContentLoadsInFlight.remove(artifact.id) }
    }
    func publish(_ content: WorkLoadedArtifactContent) {
      guard scope.isActive else {
        workRemoveLoadedArtifactTempFile(content)
        return
      }
      setArtifactContent(content, for: artifact.id)
    }

    let cacheKey = "work-artifact::\(artifact.id)::\(artifact.uri)"
    let isVideo = workArtifactIsVideo(artifact)

    if !isVideo, let cachedImage = ADEImageCache.shared.cachedImage(for: cacheKey) {
      publish(.image(cachedImage))
      return
    }

    if let directURL = URL(string: artifact.uri), directURL.scheme?.hasPrefix("http") == true {
      if isVideo {
        publish(.remoteURL(directURL))
      } else if let image = try? await ADEImageCache.shared.loadRemoteImage(from: directURL, cacheKey: cacheKey) {
        publish(.image(image))
      } else {
        publish(.error("The machine returned an unreadable image preview."))
      }
      return
    }

    let videoURL = FileManager.default.temporaryDirectory
      .appendingPathComponent("ade-work-artifact-\(artifact.id)")
      .appendingPathExtension(fileExtension(for: artifact.mimeType, fallback: "mp4"))

    if isVideo {
      // Pulled in slices: a long recording is larger than the whole-file read
      // allows. A host on an older build does not know the slice read, so that
      // one case falls through to the whole-file read below, which the host
      // caps at 8 MiB.
      do {
        if intent == .preview {
          let size = try await syncService.artifactSize(artifactId: artifact.id, uri: artifact.uri)
          if !workArtifactVideoDownloads(sizeBytes: size, intent: intent) {
            publish(.videoOnDemand(sizeBytes: size))
            return
          }
        }
        try await syncService.downloadArtifact(
          artifactId: artifact.id,
          uri: artifact.uri,
          to: videoURL,
          shouldContinue: { scope.isActive }
        )
        publish(.video(videoURL))
        return
      } catch is CancellationError {
        // Scrolled away or left: leave it unloaded so the next appear retries.
        return
      } catch let error where error.localizedDescription.contains("Unsupported file action") {
        // Older host: use the whole-file read.
      } catch {
        publish(.error(artifactLoadErrorMessage(error)))
        return
      }
    }

    do {
      let blob = try await syncService.readArtifact(artifactId: artifact.id, uri: artifact.uri)
      let data: Data?
      if blob.isBinary {
        data = Data(base64Encoded: blob.content)
      } else {
        data = blob.content.data(using: .utf8)
      }

      guard let data else {
        publish(.error("The machine returned an artifact payload that could not be decoded."))
        return
      }

      if isVideo {
        try data.write(to: videoURL, options: .atomic)
        publish(.video(videoURL))
      } else if let image = UIImage(data: data) {
        ADEImageCache.shared.store(data, for: cacheKey)
        publish(.image(image))
      } else {
        publish(.text(blob.content))
      }
    } catch is CancellationError {
      return
    } catch {
      publish(.error(artifactLoadErrorMessage(error)))
    }
  }

  private func artifactLoadErrorMessage(_ error: Error) -> String {
    let raw = error.localizedDescription
    if raw.contains("must resolve within")
      || raw.contains("Remote artifact URLs are not supported")
      || raw.contains("file URL is invalid") {
      return "Preview isn't available on this device."
    }
    // Older hosts send only the message text for these.
    if raw.contains("too large to sync") {
      return "This recording is too large for the machine's ADE version. Update ADE there to play it."
    }
    let nsError = error as NSError
    if nsError.domain == "ADE", nsError.code == SyncService.fileRequestOfflineErrorCode {
      return "The machine that holds this proof is offline."
    }
    return "Preview unavailable."
  }

  @MainActor
  func openFileReference(_ path: String) async {
    guard !personalChat else {
      errorMessage = "Files are not attached to projectless chats."
      return
    }
    guard let session else { return }

    do {
      let workspaces = try await syncService.listWorkspaces()
      guard let workspace = workFilesWorkspace(for: session.laneId, in: workspaces) else {
        errorMessage = "This lane does not have a matching Files workspace on this phone yet. Refresh Files and try again."
        return
      }

      let relativePath = normalizeWorkFileReference(
        path,
        workspaceRoot: workspace.rootPath,
        requestedCwd: chatSummary?.requestedCwd
      )
      guard !relativePath.isEmpty else {
        errorMessage = "ADE could not resolve that file path into the current workspace."
        return
      }

      // Agents write a bare filename far more often than a full path, and the
      // purely textual normalisation above assumes any such name sits at the
      // workspace root. Ask the file index what it really is first.
      //
      // Only for a bare name. A reference that already carries a directory is
      // either found (same path back) or missing (opened anyway, just below),
      // so probing it would buy nothing and cost a sync round trip on the most
      // common tap of all — the full paths on tool-result file chips.
      let probe = workIndexNormalizedPath(relativePath).contains("/")
        ? WorkFileReferenceProbe.file(relativePath)
        : await probeWorkFileReference(workspaceId: workspace.id, path: relativePath)
      switch probe {
      case .file(let resolvedPath):
        syncService.requestedFilesNavigation = FilesNavigationRequest(
          workspaceId: workspace.id,
          laneId: session.laneId,
          relativePath: resolvedPath
        )
      case .directory(let resolvedPath):
        syncService.requestedFilesNavigation = FilesNavigationRequest(
          workspaceId: workspace.id,
          laneId: session.laneId,
          relativePath: resolvedPath,
          pathKind: .directory
        )
      case .ambiguous(let name):
        syncService.requestedFilesNavigation = FilesNavigationRequest(
          workspaceId: workspace.id,
          laneId: session.laneId,
          relativePath: nil,
          searchQuery: name
        )
      case .missing:
        // The index is stale by design — it skips ignored files and is only
        // refreshed by a watcher — so a reference that already carries a
        // directory is still worth opening; a real read error says more than a
        // guess. Only a bare name is a miss the index can speak to.
        if relativePath.contains("/") {
          syncService.requestedFilesNavigation = FilesNavigationRequest(
            workspaceId: workspace.id,
            laneId: session.laneId,
            relativePath: relativePath
          )
        } else {
          errorMessage = "There's no file named \(relativePath) in \(workspace.name)."
        }
      }
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  /// Asks the workspace file index what a chat-written reference points at.
  /// A failed probe must not swallow the tap, so it falls back to the path the
  /// agent reported and lets the file read report whatever it hits.
  private func probeWorkFileReference(
    workspaceId: String,
    path: String
  ) async -> WorkFileReferenceProbe {
    do {
      let items = try await syncService.quickOpen(
        workspaceId: workspaceId,
        query: path,
        limit: 60,
        includeIgnored: false
      )
      return resolveWorkFileReferenceProbe(path: path, indexedPaths: items.map(\.path))
    } catch {
      return .file(path)
    }
  }

  @MainActor
  func openPullRequestReference(_ number: Int) async {
    guard !personalChat else {
      errorMessage = "Pull requests are not attached to projectless chats."
      return
    }
    do {
      let pullRequests = try await syncService.fetchPullRequestListItems()
      let laneScoped = pullRequests.first { $0.githubPrNumber == number && $0.laneId == session?.laneId }
      let target = laneScoped ?? pullRequests.first { $0.githubPrNumber == number }

      guard let target else {
        errorMessage = "PR #\(number) is not cached on this phone yet. Refresh PRs and try again."
        return
      }

      syncService.requestedPrNavigation = PrNavigationRequest(prId: target.id)
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func openSessionLane() {
    guard let currentSession = session ?? initialSession else { return }
    let laneId = resolvedWorkNavigationLaneId(for: currentSession, lanes: lanes)
    syncService.requestedLaneNavigation = LaneNavigationRequest(laneId: laneId)
  }

  /// Routes a standalone spawned chat back to its parent through the same
  /// Work navigation request used by deeplinks and cross-surface opens.
  func openParentSession() {
    guard let parentId = composerChatSummary?.orchestrationParentSessionId?
      .trimmingCharacters(in: .whitespacesAndNewlines),
      !parentId.isEmpty
    else { return }
    syncService.requestedWorkSessionNavigation = WorkSessionNavigationRequest(
      sessionId: parentId,
      laneId: (session ?? initialSession)?.laneId
    )
  }

  @MainActor
  func presentSessionRename() {
    if CursorCloudNaming.ownsName(composerChatSummary?.cursorCloudAgentId)
      || CursorCloudNaming.ownsName(session?.cursorCloudAgentId)
      || CursorCloudNaming.ownsName(initialSession?.cursorCloudAgentId)
    {
      ADEHaptics.error()
      errorMessage = CursorCloudNaming.renameBlockedMessage
      return
    }
    sessionActionRenameText = (chatSummary?.title ?? session?.title ?? initialSession?.title ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    sessionActionRenamePresented = true
  }

  @MainActor
  func submitCurrentSessionRename(_ title: String) async {
    let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedTitle.isEmpty else {
      ADEHaptics.error()
      errorMessage = "Session title cannot be empty."
      return
    }
    if CursorCloudNaming.ownsName(composerChatSummary?.cursorCloudAgentId)
      || CursorCloudNaming.ownsName(session?.cursorCloudAgentId)
      || CursorCloudNaming.ownsName(initialSession?.cursorCloudAgentId)
    {
      ADEHaptics.error()
      errorMessage = CursorCloudNaming.renameBlockedMessage
      return
    }
    do {
      if personalChat {
        _ = try await syncService.updateChatSession(
          sessionId: sessionId,
          title: trimmedTitle,
          manuallyNamed: true
        )
      } else {
        try await syncService.updateSessionMeta(
          sessionId: sessionId,
          title: trimmedTitle,
          manuallyNamed: true
        )
        _ = try? await syncService.updateChatSession(
          sessionId: sessionId,
          title: trimmedTitle,
          manuallyNamed: true
        )
      }
      if var currentSession = session {
        currentSession.title = trimmedTitle
        currentSession.manuallyNamed = true
        session = currentSession
      }
      if var summary = chatSummary {
        summary.title = trimmedTitle
        chatSummary = summary
        syncService.cacheChatSummary(summary)
      }
      sessionActionRenameText = ""
      if personalChat {
        _ = try? await syncService.refreshPersonalChats(includeArchived: true)
      }
      await refreshChatStateAfterAction(forceRemote: false)
      errorMessage = nil
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  func deleteCurrentChatSession() async {
    do {
      try await syncService.deleteChatSession(sessionId: sessionId)
      if personalChat {
        syncService.removePersonalChatFromCache(sessionId: sessionId)
      }
      errorMessage = nil
      dismiss()
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  func copyCurrentSessionId() {
    UIPasteboard.general.string = sessionId
    sessionIdCopied = true
    Task { @MainActor in
      try? await Task.sleep(nanoseconds: 1_500_000_000)
      guard !Task.isCancelled else { return }
      sessionIdCopied = false
    }
  }

  @MainActor
  func copyCurrentSessionDeepLink() {
    let laneId = (session ?? initialSession).map {
      resolvedWorkNavigationLaneId(for: $0, lanes: lanes)
    }
    let lane = laneId.flatMap { id in lanes.first(where: { $0.id == id }) }
    UIPasteboard.general.string = workSessionDeepLink(
      sessionId: sessionId,
      laneId: laneId,
      envelope: LaneDeeplinkHelpers.envelope(lane: lane, pullRequest: laneOpenPr)
    )
    sessionDeepLinkCopied = true
    Task { @MainActor in
      try? await Task.sleep(nanoseconds: 1_500_000_000)
      guard !Task.isCancelled else { return }
      sessionDeepLinkCopied = false
    }
  }

  @MainActor
  func toggleCurrentSessionPinned() async {
    guard let current = session ?? initialSession else { return }
    let nextPinned = !current.pinned
    do {
      try await syncService.setSessionPinned(sessionId: sessionId, pinned: nextPinned)
      if var currentSession = session {
        currentSession.pinned = nextPinned
        session = currentSession
      }
      await refreshSessionRowFromLocalStore()
      errorMessage = nil
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  /// Resolve the lane's primary cached PR for the header overflow menu. Runs
  /// inside a `.task(id: headerMenuPrLookupKey)`, so SwiftUI cancels and
  /// replaces it whenever the lane or the PR projection changes. Re-resolves
  /// are stale-while-revalidate: the current PR is only cleared up front when
  /// the *lane* changed (so a slow lookup for a previous lane can never surface
  /// its PR on a new lane), never on same-lane projection refreshes — clearing
  /// there collapses the header menu's PR section to the "no PR" branch for a
  /// frame and rebuilds the open liquid-glass menu mid-interaction. Final
  /// assignments are equality-guarded for the same reason. No-ops entirely when
  /// this destination resolves no lane PR (`WorkChatLanePrPolicy`).
  ///
  /// Pass `ownershipToken` when the caller owns a `prDetailsRequestToken`
  /// generation: the lane check below cannot tell two overlapping SAME-lane
  /// resolves apart, so without it a superseded resolve can resume last and
  /// republish its older PR list — and then clear the user's newer pick,
  /// because that older list does not contain it.
  @MainActor
  func resolveLaneOpenPr(
    for laneId: String,
    forceGithubRefresh: Bool = false,
    clearBeforeLoad: Bool = true,
    ownershipToken: Int? = nil
  ) async {
    // Chats that own no lane PR (CTO) must not touch the PR projection at all:
    // their lane id is synthetic, so a lookup would resolve the project's
    // primary-lane PR and badge this chat with it. Bail before any network or
    // IPC work and leave the badge state empty.
    guard resolvesLanePr else {
      if lastResolvedPrLaneId != nil { lastResolvedPrLaneId = nil }
      if laneOpenPr != nil { laneOpenPr = nil }
      if lanePrSummary != nil { lanePrSummary = nil }
      if lanePrTag != nil { lanePrTag = nil }
      if !laneChatPrs.isEmpty { laneChatPrs = [] }
      if selectedChatPrId != nil { selectedChatPrId = nil }
      return
    }
    let trimmed = laneId.trimmingCharacters(in: .whitespacesAndNewlines)
    let laneChanged = trimmed != lastResolvedPrLaneId
    if clearBeforeLoad, laneChanged {
      laneOpenPr = nil
      lanePrSummary = nil
      lanePrTag = nil
      laneChatPrs = []
    }
    // A pick belongs to one lane. Carrying it across would show lane A's PR on
    // lane B for as long as the id happened to stay resolvable.
    if laneChanged, selectedChatPrId != nil { selectedChatPrId = nil }
    guard !trimmed.isEmpty else {
      lastResolvedPrLaneId = trimmed
      laneOpenPr = nil
      lanePrSummary = nil
      lanePrTag = nil
      laneChatPrs = []
      selectedChatPrId = nil
      return
    }

    let items = (try? await syncService.fetchPullRequestListItems(laneId: trimmed)) ?? []
    // Lane surfaces and chat surfaces need two different lists, exactly as on
    // the desktop. The BADGE stays lane-strict (`items`), but a chat can be
    // linked to a PR that lives on another lane, and `selectChatPrs` only sees
    // such a row if it is in the list it is handed — a lane-filtered list makes
    // its cross-lane arm dead code.
    let projectItems = (try? await syncService.fetchPullRequestListItems()) ?? items
    let remoteSummary: PrSummary?
    if hostReachable && syncService.supportsRemoteAction("prs.getForLane") {
      remoteSummary = try? await syncService.fetchPullRequestForLane(laneId: trimmed)
    } else {
      remoteSummary = nil
    }

    if hostReachable {
      await syncService.refreshLaneGithubPrItems(force: forceGithubRefresh)
    }

    let resolution = workChatResolveLanePr(
      lane: lanes.first(where: { $0.id == trimmed }),
      pullRequests: items,
      remoteSummary: remoteSummary,
      githubPrs: syncService.laneGithubPrItems
    )

    let stillCurrent = headerMenuLaneId.trimmingCharacters(in: .whitespacesAndNewlines) == trimmed
    // Every write below this line happens after the awaits above, which suspend
    // the main actor and let a newer refresh for the SAME lane run to
    // completion first. Cancellation and the lane check both pass for that
    // older task, so it needs its own claim to be told apart.
    let ownsWrites = ownershipToken == nil || ownershipToken == prDetailsRequestToken
    guard !Task.isCancelled, stillCurrent, ownsWrites else { return }
    lastResolvedPrLaneId = trimmed
    if lanePrSummary != resolution.summary { lanePrSummary = resolution.summary }
    if lanePrTag != resolution.tag { lanePrTag = resolution.tag }
    if laneOpenPr != resolution.mappedPr { laneOpenPr = resolution.mappedPr }

    // Every PR this chat is linked to, not just the one the badge shows.
    let chatPrs = workChatPullRequests(
      lane: lanes.first(where: { $0.id == trimmed }),
      pullRequests: projectItems,
      sessionId: sessionId
    )
    if laneChatPrs != chatPrs { laneChatPrs = chatPrs }
    // A pick that no longer exists (PR merged away, link removed) must fall
    // back to the primary rather than blanking the badge.
    if let picked = selectedChatPrId, !chatPrs.contains(where: { $0.id == picked }) {
      selectedChatPrId = nil
    }
  }

  /// The pull request every chat PR surface is currently showing: the user's
  /// pick from the switcher when they made one, otherwise whatever
  /// `resolveLaneOpenPr` chose. One accessor so the badge, the sheet, and the
  /// snapshot fetch can never disagree about which PR they are describing.
  var chatDisplayPr: PullRequestListItem? {
    if let selectedChatPrId,
       let picked = laneChatPrs.first(where: { $0.id == selectedChatPrId }) {
      return picked
    }
    return laneOpenPr
  }

  var chatDisplayPrTag: LanePrTag? {
    if let selectedChatPrId,
       let picked = laneChatPrs.first(where: { $0.id == selectedChatPrId }) {
      return workChatPrTag(from: picked)
    }
    return lanePrTag
  }

  /// The remote summary describes the lane's resolved PR only. Once the user
  /// switches rows it is about a DIFFERENT pull request, so it must not be
  /// allowed to caption the one on screen.
  var chatDisplayPrSummary: PrSummary? {
    selectedChatPrId == nil ? lanePrSummary : nil
  }

  @MainActor
  func selectChatPr(_ prId: String) {
    let trimmed = prId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, laneChatPrs.contains(where: { $0.id == trimmed }) else { return }
    guard selectedChatPrId != trimmed else { return }
    selectedChatPrId = trimmed
    // The snapshot on screen belongs to the previous row; drop it before the
    // refresh so no check count is ever read against the wrong PR.
    prDetailsSnapshot = nil
    prDetailsError = nil
    Task { await refreshChatPrDetails(force: true) }
  }

  /// Navigate to the resolved lane PR. No-op (rather than crash) if the PR was
  /// cleared between menu render and tap.
  func openLaneOpenPr() {
    guard let tag = chatDisplayPrTag else { return }
    prDetailsPresented = false
    if let prId = tag.prId ?? chatDisplayPr?.id, !prId.isEmpty {
      let laneId = (chatDisplayPr?.laneId ?? headerMenuLaneId).trimmingCharacters(in: .whitespacesAndNewlines)
      syncService.requestedPrNavigation = PrNavigationRequest(
        prId: prId,
        prNumber: tag.githubPrNumber,
        laneId: laneId.isEmpty ? nil : laneId
      )
    } else {
      syncService.requestedPrNavigation = PrNavigationRequest(prNumber: tag.githubPrNumber)
    }
  }

  func openLanePrOnGitHub() {
    guard !lanePrGitHubUrlString.isEmpty,
          let url = URL(string: lanePrGitHubUrlString) else { return }
    UIApplication.shared.open(url)
  }

  @MainActor
  func openPrCreationInPrsTab() {
    let laneId = headerMenuLaneId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !laneId.isEmpty else { return }
    prDetailsPresented = false
    createPrPresented = false
    syncService.requestedPrNavigation = PrNavigationRequest(createLaneId: laneId)
  }

  @MainActor
  func presentChatPrDetails() {
    prDetailsPresented = true
    Task { await refreshChatPrDetails(force: true) }
  }

  @MainActor
  func refreshChatPrDetails(force: Bool = false) async {
    guard force || !prDetailsRefreshing else { return }
    // `force` skips the in-flight guard on purpose, so B→C selection overlaps
    // two refreshes. Claim a generation and gate EVERY later state write on
    // still owning it: without this, B's error or B's `prDetailsRefreshing =
    // false` landed on top of C's still-loading state.
    prDetailsRequestToken += 1
    let token = prDetailsRequestToken
    prDetailsRefreshing = true
    prDetailsError = nil
    defer {
      if prDetailsRequestToken == token { prDetailsRefreshing = false }
    }

    await resolveLaneOpenPr(
      for: headerMenuLaneId,
      forceGithubRefresh: force,
      clearBeforeLoad: false,
      ownershipToken: token
    )
    guard prDetailsRequestToken == token else { return }

    guard let prId = chatDisplayPr?.id ?? chatDisplayPrSummary?.id else {
      prDetailsSnapshot = nil
      await loadPrCreateCapabilitiesIfNeeded()
      return
    }

    if hostReachable {
      do {
        try await syncService.refreshPullRequestSnapshots(prId: prId)
        let items = (try? await syncService.fetchPullRequestListItems(laneId: headerMenuLaneId)) ?? []
        // Same split as the initial load: the badge maps against the lane's own
        // rows, the chat list is selected from the project's.
        let projectItems = (try? await syncService.fetchPullRequestListItems()) ?? items
        let refreshedChatPrs = workChatPullRequests(
          lane: lanes.first(where: { $0.id == headerMenuLaneId }),
          pullRequests: projectItems,
          sessionId: sessionId
        )
        guard prDetailsRequestToken == token else { return }
        laneOpenPr = workChatMappedPullRequest(for: lanePrTag, in: items)
        if laneChatPrs != refreshedChatPrs { laneChatPrs = refreshedChatPrs }
      } catch {
        guard prDetailsRequestToken == token else { return }
        prDetailsError = SyncUserFacingError.message(for: error)
      }
    }

    do {
      let snapshot = try await syncService.fetchPullRequestSnapshot(prId: prId)
      // Switching PRs while this await is in flight used to publish the OLD
      // PR's details under the new PR's header: pick B, then C, and B's
      // snapshot lands last and wins. The id we fetched must still be the id
      // on screen. Same shape as the `stillCurrent` guard in
      // `resolveLaneOpenPr` above.
      guard prDetailsRequestToken == token,
            (chatDisplayPr?.id ?? chatDisplayPrSummary?.id) == prId else { return }
      prDetailsSnapshot = snapshot
    } catch {
      guard prDetailsRequestToken == token,
            (chatDisplayPr?.id ?? chatDisplayPrSummary?.id) == prId else { return }
      prDetailsSnapshot = nil
      prDetailsError = SyncUserFacingError.message(for: error)
    }
  }

  @MainActor
  func copyLanePrLink() {
    let urlString = lanePrGitHubUrlString
    guard !urlString.isEmpty else { return }
    UIPasteboard.general.string = urlString
    prLinkCopied = true
    Task {
      try? await Task.sleep(nanoseconds: 1_500_000_000)
      guard !Task.isCancelled else { return }
      prLinkCopied = false
    }
  }

  @MainActor
  func copySubmittedWorkPromptToPasteboard(_ text: String) {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    UIPasteboard.general.string = trimmed
  }

  func presentCreateLanePr() {
    if prDetailsPresented {
      createPrAfterDetailsDismiss = true
      prDetailsPresented = false
      return
    }
    createPrPresented = true
  }

  @MainActor
  func loadPrCreateCapabilitiesIfNeeded() async {
    guard hostReachable else {
      prCreateCapabilities = nil
      return
    }
    do {
      let snapshot = try await syncService.fetchPrMobileSnapshot()
      guard !Task.isCancelled else { return }
      if prCreateCapabilities != snapshot.createCapabilities {
        prCreateCapabilities = snapshot.createCapabilities
      }
    } catch {
      guard !Task.isCancelled else { return }
      prCreateCapabilities = nil
    }
  }

  @MainActor
  func handleChatCreateSinglePr(
    laneId: String,
    title: String,
    body: String,
    draft: Bool,
    baseBranch: String,
    labels: [String],
    reviewers: [String],
    strategy: String?
  ) async -> Bool {
    guard hostReachable else {
      errorMessage = "Connect to your desktop to create a pull request."
      return false
    }
    do {
      try await syncService.createPullRequest(
        laneId: laneId,
        title: title,
        body: body,
        draft: draft,
        baseBranch: baseBranch,
        labels: labels,
        reviewers: reviewers,
        strategy: strategy
      )
      createPrPresented = false
      try? await syncService.refreshPullRequestSnapshots()
      await syncService.refreshLaneGithubPrItems(force: true)
      await resolveLaneOpenPr(for: headerMenuLaneId, forceGithubRefresh: true)
      if prDetailsPresented {
        await refreshChatPrDetails(force: false)
      }
      await loadPrCreateCapabilitiesIfNeeded()
      return true
    } catch {
      errorMessage = error.localizedDescription
      return false
    }
  }
}

func workTurnRecoveryFeedback(status: String) -> String {
  switch status {
  case "waiting": return "Waiting for runtime output…"
  case "nudged": return "Status nudge sent."
  case "retrying": return "Retry started in this thread."
  case "resumed": return "Runtime restarted and the thread resumed."
  default: return "Recovery action sent."
  }
}

struct WorkChatPrResolution {
  var tag: LanePrTag?
  var mappedPr: PullRequestListItem?
  var summary: PrSummary?
}

func workChatResolveLanePr(
  lane: LaneSummary?,
  pullRequests: [PullRequestListItem],
  remoteSummary: PrSummary?,
  githubPrs: [GitHubPrListItem]
) -> WorkChatPrResolution {
  let tag: LanePrTag?
  if let remoteSummary {
    tag = workChatLanePrTag(from: remoteSummary)
  } else if let lane {
    tag = selectLaneTabPrTag(lane: lane, pullRequests: pullRequests, githubPrs: githubPrs)
  } else if let pr = pullRequests.sorted(by: lanePrTagPrecedes).first {
    tag = workChatLanePrTag(from: pr)
  } else {
    tag = nil
  }
  return WorkChatPrResolution(
    tag: tag,
    mappedPr: workChatMappedPullRequest(for: tag, in: pullRequests),
    summary: remoteSummary
  )
}

func workChatLanePrTag(from pr: PullRequestListItem) -> LanePrTag {
  LanePrTag(
    source: .ade,
    prId: pr.id,
    githubPrNumber: pr.githubPrNumber,
    githubUrl: pr.githubUrl,
    title: pr.title,
    state: pr.state,
    headBranch: pr.headBranch,
    updatedAt: pr.updatedAt,
    stack: pr.stack
  )
}

func workChatLanePrTag(from pr: PrSummary) -> LanePrTag {
  LanePrTag(
    source: .ade,
    prId: pr.id,
    githubPrNumber: pr.githubPrNumber,
    githubUrl: pr.githubUrl,
    title: pr.title,
    state: pr.state,
    headBranch: pr.headBranch,
    updatedAt: pr.updatedAt,
    stack: pr.stack
  )
}

func workChatMappedPullRequest(
  for tag: LanePrTag?,
  in pullRequests: [PullRequestListItem]
) -> PullRequestListItem? {
  guard let tag else { return nil }
  if let prId = tag.prId,
     let match = pullRequests.first(where: { $0.id == prId }) {
    return match
  }
  return pullRequests.first { pr in
    pr.githubPrNumber == tag.githubPrNumber || pr.githubUrl == tag.githubUrl
  }
}
