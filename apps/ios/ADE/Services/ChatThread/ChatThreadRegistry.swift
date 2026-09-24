import Foundation
import UIKit

/// What the registry needs from the sync layer. `SyncService` conforms; tests
/// use a fake. Subscription ownership stays in `SyncService`.
@MainActor
protocol ChatThreadTransport: AnyObject {
  /// Ask for a full `chat_subscribe` snapshot (no resume point).
  func chatThreadRequestSnapshot(_ key: ChatThreadKey, reason: String)
  /// Fetch one older page, decoded off the main actor.
  func chatThreadFetchOlderPage(
    _ key: ChatThreadKey,
    request: ChatThreadOlderRequest
  ) async throws -> ChatThreadOlderPageInput
}

/// Owns every warm `ChatThreadEngine` (LRU of 8 plus every chat with a live
/// turn, plus whatever a view has attached) and routes decoded chat frames to
/// them. Never touches `@Published` state.
@MainActor
final class ChatThreadRegistry {
  static let warmLimit = 8

  weak var transport: ChatThreadTransport?
  let store: ChatLogStore?

  private var models: [ChatThreadKey: ChatThreadModel] = [:]
  private var touchedAt: [ChatThreadKey: UInt64] = [:]
  private var touchClock: UInt64 = 0
  private var attachCounts: [ChatThreadKey: Int] = [:]
  private var liveTurnKeys: Set<ChatThreadKey> = []
  private var resumePoints: [ChatThreadKey: ChatThreadResumePoint] = [:]
  private var liveBatches: [ChatThreadKey: [ChatThreadLiveEvent]] = [:]
  private var liveFlushScheduled = false
  /// One ordered ingest queue per engine, so a snapshot and the live events
  /// that follow it reach the engine in socket order.
  private var ingestQueues: [ChatThreadKey: AsyncStream<ChatThreadIngest>.Continuation] = [:]
  private var memoryWarningObserver: NSObjectProtocol?

  init(store: ChatLogStore?, transport: ChatThreadTransport? = nil) {
    self.store = store
    self.transport = transport
    memoryWarningObserver = NotificationCenter.default.addObserver(
      forName: UIApplication.didReceiveMemoryWarningNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated {
        self?.evictForMemoryWarning()
      }
    }
  }

  deinit {
    if let memoryWarningObserver {
      NotificationCenter.default.removeObserver(memoryWarningObserver)
    }
  }

  // MARK: - Models

  /// The model for a chat, creating its engine and starting the disk load at
  /// `.userInitiated` when it is not warm yet.
  func model(for key: ChatThreadKey) -> ChatThreadModel {
    touch(key)
    if let existing = models[key] { return existing }
    let model = makeModel(key: key)
    Task(priority: .userInitiated) { [engine = model.engine] in
      await engine.loadCache()
    }
    trimToWarmLimit()
    return model
  }

  func existingModel(for key: ChatThreadKey) -> ChatThreadModel? {
    models[key]
  }

  func hasEngine(for key: ChatThreadKey) -> Bool {
    models[key] != nil
  }

  var warmKeys: [ChatThreadKey] {
    Array(models.keys)
  }

  /// A view is showing this chat: never evict it while attached.
  func attach(_ key: ChatThreadKey) -> ChatThreadModel {
    attachCounts[key, default: 0] += 1
    return model(for: key)
  }

  func detach(_ key: ChatThreadKey) {
    guard let count = attachCounts[key] else { return }
    if count <= 1 {
      attachCounts.removeValue(forKey: key)
    } else {
      attachCounts[key] = count - 1
    }
    trimToWarmLimit()
  }

  /// List prefetch: load from disk and fold at low priority.
  func warm(_ keys: [ChatThreadKey], priority: TaskPriority = .utility) {
    for key in keys where models[key] == nil {
      let model = makeModel(key: key)
      touch(key)
      Task(priority: priority) { [engine = model.engine] in
        await engine.loadCache()
      }
    }
    trimToWarmLimit()
  }

  /// Keep the attached chats and every live turn; drop the rest.
  func evictForMemoryWarning() {
    for key in Array(models.keys) where !isProtected(key) {
      evict(key)
    }
  }

  func resumePoint(for key: ChatThreadKey) -> ChatThreadResumePoint? {
    resumePoints[key]
  }

  // MARK: - Routing (called by SyncService frame handlers)

  func routeSnapshot(_ input: ChatThreadSnapshotInput, key: ChatThreadKey) {
    guard models[key] != nil else { return }
    // Anything batched before the ack belongs before it.
    flushLiveBatch(for: key)
    enqueue(.snapshot(input), key: key)
  }

  /// Live events are batched per run-loop turn, then handed over in one ingest.
  func routeLive(_ event: ChatThreadLiveEvent, key: ChatThreadKey) {
    guard models[key] != nil else { return }
    if (attachCounts[key] ?? 0) > 0 {
      ChatThreadSignposts.noteLiveIngest(sessionId: key.sessionId)
    }
    liveBatches[key, default: []].append(event)
    guard !liveFlushScheduled else { return }
    liveFlushScheduled = true
    DispatchQueue.main.async { [weak self] in
      MainActor.assumeIsolated {
        self?.flushLiveBatches()
      }
    }
  }

  func routeOlderPage(_ page: ChatThreadOlderPageInput, key: ChatThreadKey) {
    enqueue(.olderPage(page), key: key)
  }

  func invalidate(_ key: ChatThreadKey, reason: String) {
    guard models[key] != nil else { return }
    resumePoints.removeValue(forKey: key)
    liveBatches.removeValue(forKey: key)
    enqueue(.invalidate(reason: reason), key: key)
  }

  func markSnapshotStalled(_ key: ChatThreadKey, message: String?) {
    guard let engine = models[key]?.engine else { return }
    Task { await engine.markLoadFailed(message) }
  }

  /// Roster rows carry the host's `historyGeneration`: a warm chat whose
  /// cached generation differs is invalidated and re-snapshotted without a
  /// request per chat.
  func applyRosterFreshness(
    machineKey: String,
    generationBySessionId: [String: Int]
  ) {
    guard !generationBySessionId.isEmpty else { return }
    for key in models.keys where key.machineKey == machineKey {
      guard let hostGeneration = generationBySessionId[key.sessionId],
            let cachedGeneration = resumePoints[key]?.generation,
            cachedGeneration != hostGeneration
      else { continue }
      invalidate(key, reason: "roster generation \(cachedGeneration) -> \(hostGeneration)")
      transport?.chatThreadRequestSnapshot(key, reason: "generation changed")
    }
  }

  /// Forget/unpair: drop every warm chat of that machine and its disk cache.
  func purgeMachine(_ machineKey: String) {
    for key in Array(models.keys) where key.machineKey == machineKey {
      evict(key)
    }
    guard let store else { return }
    Task { await store.purgeMachine(machineKey) }
  }

  /// Sign-out / account switch.
  func purgeAll() {
    for key in Array(models.keys) { evict(key) }
    guard let store else { return }
    Task { await store.purgeAll() }
  }

  // MARK: - Older history

  func loadOlder(_ key: ChatThreadKey) async -> WorkChatOlderHistoryLoadResult {
    guard let model = models[key] else { return .failed }
    let engine = model.engine
    let before = model.frame?.presentation.timelineCount ?? 0
    // Disk first: it costs no network.
    if await engine.loadOlderFromDisk() > 0 {
      guard let frame = await engine.flush() else { return .failed }
      model.receive(frame)
      return .loaded(
        hasMoreHistory: frame.hasOlderHistory,
        addedTimelineEntries: frame.presentation.timelineCount > before
      )
    }
    guard let request = await engine.beginOlderHostRequest() else {
      let frame = await engine.flush()
      return .loaded(hasMoreHistory: frame?.hasOlderHistory ?? false, addedTimelineEntries: false)
    }
    await fetchOlderPage(key: key, engine: engine, request: request)
    guard let frame = await engine.flush() else { return .failed }
    model.receive(frame)
    if case .failed = frame.olderHistoryState { return .failed }
    return .loaded(
      hasMoreHistory: frame.hasOlderHistory,
      addedTimelineEntries: frame.presentation.timelineCount > before
    )
  }

  func retry(_ key: ChatThreadKey) {
    transport?.chatThreadRequestSnapshot(key, reason: "retry")
  }

  // MARK: - Engine signals

  func frameApplied(_ frame: ChatThreadFrame, key: ChatThreadKey) {
    if let resumePoint = frame.resumePoint {
      resumePoints[key] = resumePoint
    } else {
      resumePoints.removeValue(forKey: key)
    }
    if frame.isStreamingTurn || frame.transcriptIndicatesActiveTurn {
      liveTurnKeys.insert(key)
    } else if liveTurnKeys.remove(key) != nil {
      trimToWarmLimit()
    }
  }

  private func handle(_ signal: ChatThreadEngineSignal, key: ChatThreadKey) {
    switch signal {
    case .frame(let frame):
      guard let model = models[key] else { return }
      // Resume points must be current even before the coalescer applies the
      // frame, so a reconnect right now resumes from the right place.
      if let resumePoint = frame.resumePoint { resumePoints[key] = resumePoint }
      model.receive(frame)
    case .needsSnapshot(let reason):
      resumePoints.removeValue(forKey: key)
      transport?.chatThreadRequestSnapshot(key, reason: reason)
    case .needsBoundaryPage:
      guard let engine = models[key]?.engine else { return }
      Task { @MainActor [weak self] in
        guard let self else { return }
        guard let request = await engine.beginOlderHostRequest() else {
          // Nothing to page from: release the held frame.
          await engine.ingest(.olderPage(.failed(sessionId: key.sessionId, message: "No earlier history.")))
          return
        }
        await self.fetchOlderPage(key: key, engine: engine, request: request)
      }
    }
  }

  private func fetchOlderPage(
    key: ChatThreadKey,
    engine: ChatThreadEngine,
    request: ChatThreadOlderRequest
  ) async {
    guard let transport else {
      await engine.ingest(.olderPage(.failed(sessionId: key.sessionId, message: "Not connected.")))
      return
    }
    do {
      let page = try await transport.chatThreadFetchOlderPage(key, request: request)
      await engine.ingest(.olderPage(page))
    } catch {
      await engine.ingest(.olderPage(.failed(
        sessionId: key.sessionId,
        message: SyncUserFacingError.message(for: error)
      )))
    }
  }

  // MARK: - Internals

  private func makeModel(key: ChatThreadKey) -> ChatThreadModel {
    let engine = ChatThreadEngine(key: key, store: store) { [weak self] signal in
      Task { @MainActor in
        self?.handle(signal, key: key)
      }
    }
    let model = ChatThreadModel(key: key, engine: engine, registry: self)
    models[key] = model
    let (stream, continuation) = AsyncStream.makeStream(of: ChatThreadIngest.self)
    ingestQueues[key] = continuation
    Task(priority: .userInitiated) {
      for await input in stream {
        await engine.ingest(input)
      }
    }
    return model
  }

  private func enqueue(_ input: ChatThreadIngest, key: ChatThreadKey) {
    ingestQueues[key]?.yield(input)
  }

  private func flushLiveBatches() {
    liveFlushScheduled = false
    for key in Array(liveBatches.keys) {
      flushLiveBatch(for: key)
    }
  }

  private func flushLiveBatch(for key: ChatThreadKey) {
    guard let batch = liveBatches.removeValue(forKey: key), !batch.isEmpty else { return }
    enqueue(.live(batch), key: key)
  }

  private func touch(_ key: ChatThreadKey) {
    touchClock &+= 1
    touchedAt[key] = touchClock
  }

  private func isProtected(_ key: ChatThreadKey) -> Bool {
    (attachCounts[key] ?? 0) > 0 || liveTurnKeys.contains(key)
  }

  private func trimToWarmLimit() {
    let evictable = models.keys
      .filter { !isProtected($0) }
      .sorted { (touchedAt[$0] ?? 0) < (touchedAt[$1] ?? 0) }
    var overflow = models.count - Self.warmLimit
    for key in evictable where overflow > 0 {
      evict(key)
      overflow -= 1
    }
  }

  private func evict(_ key: ChatThreadKey) {
    ingestQueues.removeValue(forKey: key)?.finish()
    models.removeValue(forKey: key)
    touchedAt.removeValue(forKey: key)
    resumePoints.removeValue(forKey: key)
    liveBatches.removeValue(forKey: key)
    liveTurnKeys.remove(key)
  }
}
