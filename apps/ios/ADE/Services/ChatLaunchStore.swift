import Foundation

/// One launch as this device holds it: the host snapshot plus the local facts
/// the host does not echo back (which project it lives in, which provider this
/// device picked, whether the host has seen it at all).
struct ChatLaunchEntry: Equatable {
  var snapshot: ChatLaunchSnapshot
  var projectId: String?
  var projectRootPath: String?
  /// Provider this device launched with. Nil for launches another device started.
  var provider: String?
  /// True once the host has returned or pushed a snapshot for this launch.
  /// A launch that never reached the host is retried with `chat.startLaunch`
  /// (idempotent by launch id) and deleted locally.
  var hostAccepted: Bool

  var launchId: String { snapshot.launchId }
  var sessionId: String { snapshot.chatSessionId }

  /// Provider family for row glyphs and bubble tint.
  var resolvedProvider: String {
    let local = provider?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return local.isEmpty ? chatLaunchInferredProvider(modelId: snapshot.modelId) : local
  }
}

/// A launch this device started, kept in memory so Retry can replay it before
/// the host has ever seen it. `chat.startLaunch` is idempotent by launch id.
struct ChatLaunchLocalRequest {
  let request: ChatLaunchRequest
  let createArgs: [String: Any]
  let resolveAttachments: @MainActor () async throws -> [AgentChatFileRef]
  var resolvedAttachments: [AgentChatFileRef]?
}

/// What only this device knows about one launch, beside its snapshot. All
/// empty for a launch another device started.
struct ChatLaunchLocalState {
  /// Retry state for a launch this device started; dropped once the launch is
  /// terminal or removed.
  var request: ChatLaunchLocalRequest?
  /// `chat.startLaunch` is on the wire right now.
  var startInFlight = false
  /// The project the in-flight `chat.startLaunch` targets. Held until the
  /// start settles: deleting the launch mid-start drops its entry (the only
  /// other record of its project), and the compensating `chat.cancelLaunch`
  /// must reach the project that got the lane — not whichever is active now.
  var startScope: ChatLaunchProjectScope?
  /// Deleted locally while its start was still on the wire.
  var cancelledWhileStarting = false
  /// Messages typed before the host accepted the launch; sent in order once it does.
  var deferredMessages: [ChatLaunchQueuedMessage] = []
  /// Messages on the wire to `chat.queueLaunchMessage`, not yet answered.
  var inFlightMessages: [ChatLaunchQueuedMessage] = []
  /// The one send loop for this launch is running; every message goes through
  /// it so a newly typed message can never overtake an earlier one.
  var flushing = false

  /// Every message typed on this device that the host has not echoed yet, in
  /// the order it was typed. Shown on the launch until the host's own copy
  /// replaces it, so a host snapshot never makes a typed message vanish.
  var unacknowledgedMessages: [ChatLaunchQueuedMessage] {
    inFlightMessages + deferredMessages
  }

  var isEmpty: Bool {
    request == nil && !startInFlight && startScope == nil && !cancelledWhileStarting
      && deferredMessages.isEmpty && inFlightMessages.isEmpty
  }
}

/// Queued messages this device typed but could not hand to the host, whole
/// (text, display text, attachments). The pending chat screen takes the
/// text-only ones back into its composer draft and shows the error; ones that
/// carry attachments (the composer there is text-only) stay here as failed
/// bubbles with Retry until the user resends or discards them. A failed send
/// is never silent and never loses an attachment.
struct ChatLaunchSendFailure: Equatable {
  var messages: [ChatLaunchQueuedMessage]
  var message: String

  var texts: [String] { messages.map(\.text) }
}

/// A failed send the pending composer can take back as text alone.
func chatLaunchSendFailureRestoresToComposer(_ message: ChatLaunchQueuedMessage) -> Bool {
  message.attachments?.isEmpty ?? true
}

/// Ids of queued messages created on this device; the host never uses them.
let chatLaunchLocalMessageIdPrefix = "local-"

/// The held snapshot with this device's unacknowledged messages laid over the
/// host's queue. Local copies from an earlier overlay are stripped first, so
/// re-overlaying is idempotent and an acknowledged message drops out.
func chatLaunchOverlayUnacknowledged(
  _ snapshot: ChatLaunchSnapshot,
  _ unacknowledged: [ChatLaunchQueuedMessage]
) -> ChatLaunchSnapshot {
  var out = snapshot
  out.queuedMessages.removeAll { $0.id.hasPrefix(chatLaunchLocalMessageIdPrefix) }
  out.queuedMessages.append(contentsOf: unacknowledged)
  return out
}

/// The phone's copy of every chat launch it knows about, keyed by launch id.
///
/// Its own `ObservableObject` (owned by `SyncService`) so a transcript cell
/// showing the lane-setup card re-renders on launch progress only — not on
/// every terminal byte `SyncService` publishes. `SyncService` mirrors changes
/// into its `chatLaunchRevision` for the list surfaces that already observe it.
@MainActor
final class ChatLaunchStore: ObservableObject {
  @Published private(set) var entries: [String: ChatLaunchEntry] = [:]
  /// Monotonic local revision; bumped on every effective change.
  @Published private(set) var revision = 0

  /// Sends that failed, by launch id, until the pending chat screen takes them.
  @Published private(set) var sendFailures: [String: ChatLaunchSendFailure] = [:]
  /// True once the active project's launches were listed on this connection
  /// (or there is nothing to list). Until then a chat route cannot tell "no
  /// launch" from "launch not loaded yet".
  @Published private(set) var activeProjectHydrated = false

  var onChange: (() -> Void)?

  /// Per-launch local state, by launch id. Not published: no view reads it.
  private(set) var localStates: [String: ChatLaunchLocalState] = [:]

  func entry(launchId: String) -> ChatLaunchEntry? {
    entries[launchId]
  }

  /// The launch whose chat runs under `sessionId`. For a chat launch the
  /// session id is the launch id, so the direct lookup is the common case.
  func entry(sessionId: String) -> ChatLaunchEntry? {
    if let direct = entries[sessionId], direct.snapshot.kind == .chat { return direct }
    return entries.values.first { $0.snapshot.kind == .chat && $0.sessionId == sessionId }
  }

  func snapshot(launchId: String) -> ChatLaunchSnapshot? {
    entries[launchId]?.snapshot
  }

  /// Launches that belong to a project, matched by id then by root path.
  /// Entries with no recorded project (older hosts, pushed without scope)
  /// count as the active project's, which is where they arrived.
  func entries(
    projectId: String?,
    projectRootPath: String?,
    isActiveProject: Bool
  ) -> [ChatLaunchEntry] {
    let wantedId = chatLaunchNormalizedScope(projectId)
    let wantedRoot = syncNormalizedProjectRootScope(projectRootPath)
    return entries.values
      .filter { entry in
        let entryId = chatLaunchNormalizedScope(entry.projectId)
        let entryRoot = syncNormalizedProjectRootScope(entry.projectRootPath)
        if entryId == nil && entryRoot == nil { return isActiveProject }
        if let entryId, let wantedId, entryId == wantedId { return true }
        if let entryRoot, let wantedRoot, entryRoot == wantedRoot { return true }
        return false
      }
      .sorted { $0.snapshot.startedAt > $1.snapshot.startedAt }
  }

  /// Insert the snapshot shown the instant the user hits send.
  func insertOptimistic(
    _ snapshot: ChatLaunchSnapshot,
    projectId: String?,
    projectRootPath: String?,
    provider: String?
  ) {
    var next = entries
    next[snapshot.launchId] = ChatLaunchEntry(
      snapshot: overlaid(mergeChatLaunchSnapshot(entries[snapshot.launchId]?.snapshot, snapshot)),
      projectId: projectId,
      projectRootPath: projectRootPath,
      provider: provider,
      hostAccepted: entries[snapshot.launchId]?.hostAccepted ?? false
    )
    commit(next)
  }

  /// Apply a host snapshot. Older sequences are dropped. Returns whether the
  /// held snapshot changed.
  ///
  /// The project recorded first wins, except when the host names the scope
  /// itself (`scopeFromHost`, a pushed event carrying `projectId` /
  /// `projectRootPath`): the host knows which project a launch lives in, so
  /// its scope replaces a guess such as "the active project".
  @discardableResult
  func apply(
    _ snapshot: ChatLaunchSnapshot,
    projectId: String? = nil,
    projectRootPath: String? = nil,
    scopeFromHost: Bool = false
  ) -> Bool {
    let existing = entries[snapshot.launchId]
    let merged = overlaid(mergeChatLaunchSnapshot(existing?.snapshot, snapshot))
    let incomingId = chatLaunchNormalizedScope(projectId)
    let incomingRoot = syncNormalizedProjectRootScope(projectRootPath)
    let hostNamesScope = scopeFromHost && (incomingId != nil || incomingRoot != nil)
    let nextEntry = ChatLaunchEntry(
      snapshot: merged,
      projectId: hostNamesScope ? incomingId : (existing?.projectId ?? incomingId),
      projectRootPath: hostNamesScope ? incomingRoot : (existing?.projectRootPath ?? incomingRoot),
      provider: existing?.provider,
      hostAccepted: true
    )
    guard nextEntry != existing else { return false }
    var next = entries
    next[snapshot.launchId] = nextEntry
    commit(next)
    return true
  }

  func remove(launchId: String) {
    guard entries[launchId] != nil else { return }
    var next = entries
    next.removeValue(forKey: launchId)
    commit(next)
  }

  /// Local edit of the held snapshot (a failure that never reached the host,
  /// an optimistic queued message). Does not touch the sequence, so the host's
  /// next snapshot still supersedes it.
  func update(launchId: String, _ mutate: (inout ChatLaunchSnapshot) -> Void) {
    guard var entry = entries[launchId] else { return }
    let before = entry
    mutate(&entry.snapshot)
    entry.snapshot = overlaid(entry.snapshot)
    guard entry != before else { return }
    var next = entries
    next[launchId] = entry
    commit(next)
  }

  /// `chat.listLaunches` result for one project: host snapshots replace what
  /// is held for that project, and launches the host no longer knows are
  /// dropped — except ones that never reached the host (still in flight or
  /// failed locally), which only this device can resolve.
  func replaceProject(
    projectId: String?,
    projectRootPath: String?,
    with snapshots: [ChatLaunchSnapshot]
  ) {
    let wantedId = chatLaunchNormalizedScope(projectId)
    let wantedRoot = syncNormalizedProjectRootScope(projectRootPath)
    var next = entries
    let incomingIds = Set(snapshots.map(\.launchId))
    for (launchId, entry) in entries where entry.hostAccepted && !incomingIds.contains(launchId) {
      let entryId = chatLaunchNormalizedScope(entry.projectId)
      let entryRoot = syncNormalizedProjectRootScope(entry.projectRootPath)
      let sameProject = (entryId == nil && entryRoot == nil)
        || (entryId != nil && entryId == wantedId)
        || (entryRoot != nil && entryRoot == wantedRoot)
      if sameProject {
        next.removeValue(forKey: launchId)
      }
    }
    for snapshot in snapshots {
      let existing = next[snapshot.launchId]
      next[snapshot.launchId] = ChatLaunchEntry(
        snapshot: overlaid(mergeChatLaunchSnapshot(existing?.snapshot, snapshot)),
        projectId: existing?.projectId ?? wantedId,
        projectRootPath: existing?.projectRootPath ?? wantedRoot,
        provider: existing?.provider,
        hostAccepted: true
      )
    }
    commit(next)
  }

  func removeAll() {
    localStates = [:]
    sendFailures = [:]
    commit([:])
  }

  func setActiveProjectHydrated(_ hydrated: Bool) {
    guard activeProjectHydrated != hydrated else { return }
    activeProjectHydrated = hydrated
    // Chat-route gates observe `SyncService`, which mirrors store changes.
    onChange?()
  }

  // MARK: Send failures

  /// Record messages that could not be handed to the host. Appends to any
  /// failure not yet taken, so nothing typed is lost. A message with neither
  /// text nor attachments has nothing to restore.
  func recordSendFailure(launchId: String, messages: [ChatLaunchQueuedMessage], message: String) {
    let messages = messages.filter { queued in
      !queued.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        || !(queued.attachments?.isEmpty ?? true)
    }
    guard !messages.isEmpty else { return }
    var failure = sendFailures[launchId] ?? ChatLaunchSendFailure(messages: [], message: message)
    failure.messages.append(contentsOf: messages.map { queued in
      var failed = queued
      // "Retrying" is the host's own delivery loop; this one waits on the user.
      failed.deliveryError = nil
      return failed
    })
    failure.message = message
    sendFailures[launchId] = failure
  }

  /// Hand the composer-restorable part of a recorded failure (text-only
  /// messages) to the screen that restores it and clear that part. Messages
  /// carrying attachments stay recorded until `takeFailedSend`. Nil when
  /// there is nothing for the composer.
  func takeSendFailure(launchId: String) -> ChatLaunchSendFailure? {
    guard let failure = sendFailures[launchId] else { return nil }
    let restorable = failure.messages.filter(chatLaunchSendFailureRestoresToComposer)
    guard !restorable.isEmpty else { return nil }
    let kept = failure.messages.filter { !chatLaunchSendFailureRestoresToComposer($0) }
    if kept.isEmpty {
      sendFailures.removeValue(forKey: launchId)
    } else {
      sendFailures[launchId] = ChatLaunchSendFailure(messages: kept, message: failure.message)
    }
    return ChatLaunchSendFailure(messages: restorable, message: failure.message)
  }

  /// Take one failed message off the record, to resend or discard it.
  @discardableResult
  func takeFailedSend(launchId: String, messageId: String) -> ChatLaunchQueuedMessage? {
    guard var failure = sendFailures[launchId],
          let index = failure.messages.firstIndex(where: { $0.id == messageId })
    else { return nil }
    let taken = failure.messages.remove(at: index)
    sendFailures[launchId] = failure.messages.isEmpty ? nil : failure
    return taken
  }

  // MARK: Local state

  func localState(launchId: String) -> ChatLaunchLocalState {
    localStates[launchId] ?? ChatLaunchLocalState()
  }

  /// Edit one launch's local state; an entry left empty is dropped. The held
  /// snapshot is re-overlaid, so a message added to or acknowledged out of
  /// the local queues shows or disappears at once.
  func updateLocal(launchId: String, _ mutate: (inout ChatLaunchLocalState) -> Void) {
    var state = localState(launchId: launchId)
    let before = state.unacknowledgedMessages
    mutate(&state)
    localStates[launchId] = state.isEmpty ? nil : state
    guard state.unacknowledgedMessages != before, var entry = entries[launchId] else { return }
    entry.snapshot = overlaid(entry.snapshot)
    var next = entries
    next[launchId] = entry
    commit(next)
  }

  /// The launch no longer needs replaying (terminal, removed, or deleted).
  /// Deferred messages go too unless `keepMessages` (a completed launch still
  /// takes queued messages). In-flight bookkeeping is left to its owner.
  func forgetLocalRequest(launchId: String, keepMessages: Bool = false) {
    updateLocal(launchId: launchId) { state in
      state.request = nil
      if !keepMessages {
        state.deferredMessages = []
      }
    }
  }

  private func overlaid(_ snapshot: ChatLaunchSnapshot) -> ChatLaunchSnapshot {
    chatLaunchOverlayUnacknowledged(
      snapshot,
      localStates[snapshot.launchId]?.unacknowledgedMessages ?? []
    )
  }

  private func commit(_ next: [String: ChatLaunchEntry]) {
    guard next != entries else { return }
    entries = next
    revision &+= 1
    onChange?()
  }
}
