import Foundation
import CoreGraphics
import OSLog

// Types shared by the mobile thread engine (see
// `.ade/plans/mobile-thread-engine.md` and `-contract.md`).
//
// Everything that crosses the actor boundary is a value type. Several carry
// view-model values (`WorkChatTimelineSnapshot`, `WorkPendingInputItem`, …)
// that the Work tab declares without `Sendable`; those containers are marked
// `@unchecked Sendable` because they are immutable snapshots handed off whole
// and never mutated after they leave the engine.

let chatThreadSignposter = OSSignposter(subsystem: "com.ade.ios", category: "thread")
let chatThreadLog = Logger(subsystem: "com.ade.ios", category: "thread")

// MARK: - Keys

enum ChatThreadScope: Hashable, Sendable {
  case project(String)
  case personal
  case crossProject(projectId: String, rootPath: String)

  /// Inverse of `storageKey`, for keys read back from `ChatLogStore`.
  init?(storageKey: String) {
    if storageKey == "personal" {
      self = .personal
    } else if storageKey.hasPrefix("project:") {
      self = .project(String(storageKey.dropFirst("project:".count)))
    } else if storageKey.hasPrefix("cross:") {
      let rest = storageKey.dropFirst("cross:".count)
      guard let separator = rest.firstIndex(of: "|") else { return nil }
      self = .crossProject(
        projectId: String(rest[..<separator]),
        rootPath: String(rest[rest.index(after: separator)...])
      )
    } else {
      return nil
    }
  }

  /// `ChatLogKey.scopeKey`.
  var storageKey: String {
    switch self {
    case .project(let id):
      return "project:\(id)"
    case .personal:
      return "personal"
    case .crossProject(let projectId, let rootPath):
      return "cross:\(projectId)|\(rootPath)"
    }
  }
}

struct ChatThreadKey: Hashable, Sendable, CustomStringConvertible {
  /// `SyncService` profile storage key of the host ("machine:<identity>").
  let machineKey: String
  let sessionId: String
  let scope: ChatThreadScope

  var logKey: ChatLogKey {
    ChatLogKey(machineKey: machineKey, sessionId: sessionId, scopeKey: scope.storageKey)
  }

  var description: String { "\(machineKey)|\(scope.storageKey)|\(sessionId)" }
}

// MARK: - Ingest

/// One decoded wire envelope plus the exact bytes it was decoded from, so the
/// engine can persist it without re-encoding.
struct ChatThreadLiveEvent: @unchecked Sendable {
  let envelope: AgentChatEventEnvelope
  let raw: Data
  /// Transport `seq` (resumable-stream watermark), not the durable `sequence`.
  let seq: Int?
  /// Folded replay rows cover `[sequenceStart, envelope.sequence]`.
  var sequenceStart: Int? = nil
  /// `session_meta_updated` with `historyInvalidated: true`.
  var historyInvalidated: Bool = false

  init(
    envelope: AgentChatEventEnvelope,
    raw: Data,
    seq: Int? = nil,
    sequenceStart: Int? = nil,
    historyInvalidated: Bool = false
  ) {
    self.envelope = envelope
    self.raw = raw
    self.seq = seq
    self.sequenceStart = sequenceStart
    self.historyInvalidated = historyInvalidated
  }
}

/// A `chat_subscribe` ack, decoded off the main actor.
struct ChatThreadSnapshotInput: @unchecked Sendable {
  var sessionId: String
  var events: [ChatThreadLiveEvent]
  /// Approval requests re-admitted from before the window (`pinnedEvents`).
  var pinnedEvents: [ChatThreadLiveEvent] = []
  var resumed: Bool = false
  /// `"sequence"` when the host served a durable `sinceSequence` resume.
  var resumeKind: String? = nil
  /// The host could not serve everything after `sinceSequence`; cached rows
  /// below the snapshot must be dropped.
  var gap: Bool = false
  var historyGeneration: Int? = nil
  var hasOlderHistory: Bool? = nil
  var tailStartOffset: Int? = nil
  var cursorKind: String? = nil
  var turnActive: Bool? = nil
  var truncated: Bool = false
  var sessionFound: Bool? = nil
  var capturedAt: String? = nil
  /// Whether the host advertised `chatLogV2` on this connection.
  var hostSupportsChatLogV2: Bool = false
}

/// One older-history page (`chat_history` / `getChatEventHistoryPage`), or a
/// failed attempt at one.
struct ChatThreadOlderPageInput: @unchecked Sendable {
  var sessionId: String
  var events: [ChatThreadLiveEvent]
  var hasMore: Bool
  /// Byte cursor for the next page on hosts without `chatLogV2`.
  var startOffset: Int? = nil
  var historyGeneration: Int? = nil
  var sessionFound: Bool = true
  var unavailable: Bool = false
  /// Non-nil when the request itself failed.
  var failureMessage: String? = nil

  static func failed(sessionId: String, message: String) -> ChatThreadOlderPageInput {
    ChatThreadOlderPageInput(sessionId: sessionId, events: [], hasMore: true, failureMessage: message)
  }
}

enum ChatThreadIngest: @unchecked Sendable {
  case cached(meta: ChatLogSessionMeta?, events: [ChatLogStoredEvent])
  case snapshot(ChatThreadSnapshotInput)
  case live([ChatThreadLiveEvent])
  case olderPage(ChatThreadOlderPageInput)
  case invalidate(reason: String)
}

/// Where the next older page comes from.
enum ChatThreadOlderRequest: Equatable, Sendable {
  /// `chatLogV2` host: `chat_history { beforeSequence }`.
  case beforeSequence(Int)
  /// Older host: `chat_history { beforeOffset }` byte cursor.
  case beforeOffset(Int)
}

/// What `sinceSequence`/`generation` to put on a `chat_subscribe`.
struct ChatThreadResumePoint: Equatable, Sendable {
  var sinceSequence: Int
  var generation: Int?
}

// MARK: - Overlays

/// Summary fields the fold reads. Everything else about the session summary
/// stays in the view.
struct ChatThreadSummaryContext: Equatable, @unchecked Sendable {
  var provider: String = ""
  /// Provider family derived from the session row's tool type, used when the
  /// summary has no provider yet.
  var providerFallback: String? = nil
  var model: String = ""
  var modelId: String? = nil
  /// `usageLimitResume.turnId`; part of the timeline fold.
  var usageLimitTurnId: String? = nil
  var hasUsageLimitResume: Bool = false
  /// Host pending-input count (summary first, session row fallback).
  var pendingInputItemId: String? = nil
  /// Goal from the summary; the transcript's own goal events override it.
  var claudeGoal: AgentChatClaudeGoal? = nil
  var orchestrationParentSessionId: String? = nil
  /// Summary/row idle and end timestamps, for "row ended after transcript".
  var rowEndedAtCandidates: [String] = []
  /// Host reachable and the chat is live (not read-only).
  var isLive: Bool = true

  var effectiveProvider: String? {
    let trimmed = provider.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? providerFallback : trimmed
  }
}

struct ChatThreadOverlays: Equatable, @unchecked Sendable {
  var localEchoMessages: [WorkLocalEchoMessage] = []
  var optimisticPendingSteers: [WorkPendingSteerModel] = []
  var optimisticallyAnsweredInputIds: Set<String> = []
  var artifacts: [ComputerUseArtifactSummary] = []
  var cardExpansionSignature: Int = 0
  /// Finished turns the reader unfolded (`turn-fold:<turnId>` expansions).
  /// Unlike other card expansion this changes which rows exist, so it
  /// rebuilds the presentation.
  var expandedTurnIds: Set<String> = []
  var summary = ChatThreadSummaryContext()
  var turnActiveHint: Bool? = nil
  var sessionStatus: String? = nil
  /// Paging window. The engine grows it itself on an older-history prepend and
  /// reports the value it used on every frame.
  var visibleTimelineCount: Int = workTimelinePageSize
  var viewportWidth: CGFloat = 0
}

// MARK: - Frame

enum ChatThreadOlderHistoryState: Equatable, Sendable {
  case idle
  case loading
  case failed(String)
  case exhausted
}

enum ChatThreadFrameOrigin: Equatable, Sendable {
  case none
  case disk
  case host
  case mixed
}

struct ChatThreadFrame: @unchecked Sendable {
  /// Monotonic per engine.
  let revision: Int
  let snapshot: WorkChatTimelineSnapshot
  let presentation: WorkTimelinePresentation
  let turnToolActivity: WorkTurnToolActivityIndex
  /// Render-entry id -> `workChatTranscriptRowRevision`, for the visible rows.
  let rowRevisions: [String: Int]
  /// Visible render-entry ids whose revision changed since the last frame
  /// (includes rows that are new).
  let changedRowIds: Set<String>
  /// Canonical pending inputs reconciled with the host's pending item id.
  let canonicalPendingInputs: [WorkPendingInputItem]
  /// Canonical minus optimistically answered.
  let pendingInputs: [WorkPendingInputItem]
  /// Canonical plus optimistic, deduped.
  let pendingSteers: [WorkPendingSteerModel]
  let isStreamingTurn: Bool
  let streamingAssistantMessageId: String?
  let activityPresentation: WorkActivityIndicator.Presentation?
  let claudeGoal: AgentChatClaudeGoal?
  /// Id of the newest reasoning card; live only while `isStreamingTurn`.
  let latestReasoningCardId: String?
  let isReasoningLive: Bool
  let transcriptIndicatesActiveTurn: Bool
  let hostTurnActiveHint: Bool?
  let hasOlderHistory: Bool
  let olderHistoryState: ChatThreadOlderHistoryState
  let loadState: WorkChatTranscriptLoadState
  let cacheOrigin: ChatThreadFrameOrigin
  let sessionDeleted: Bool
  /// The engine's paging window for this frame (grows on prepend).
  let visibleTimelineCount: Int
  /// Timeline rows added above the previous first row by this frame.
  let prependedTimelineCount: Int
  /// History was replaced wholesale (generation change, invalidation): the
  /// view should drop its scroll anchor and pin to the bottom.
  let didResetHistory: Bool
  /// Apply immediately instead of waiting for the next display frame.
  let isUrgent: Bool
  let resumePoint: ChatThreadResumePoint?
  let cardExpansionSignature: Int
  let viewportWidth: CGFloat
  /// Kept for existing consumers (steer reconcile, subagents). Read-only.
  let transcript: [WorkChatEnvelope]
}

// MARK: - Decoding (off the main actor)

/// Decode one wire envelope dictionary (a `chat_event` payload, or one row of a
/// snapshot/page) exactly once, keeping its bytes. Free function so it can run
/// in `Task.detached` with nothing crossing an actor boundary.
func chatThreadDecodeLiveEvent(_ payload: Any) -> ChatThreadLiveEvent? {
  guard let data = try? adeJSONData(withJSONObject: payload),
        let envelope = try? JSONDecoder().decode(AgentChatEventEnvelope.self, from: data)
  else { return nil }
  let dict = payload as? [String: Any]
  let event = dict?["event"] as? [String: Any]
  let sequenceStart = (dict?["sequenceStart"] as? NSNumber)?.intValue
    ?? (event?["sequenceStart"] as? NSNumber)?.intValue
  let historyInvalidated = (event?["type"] as? String) == "session_meta_updated"
    && (event?["historyInvalidated"] as? Bool) == true
  return ChatThreadLiveEvent(
    envelope: envelope,
    raw: data,
    seq: (dict?["seq"] as? NSNumber)?.intValue,
    sequenceStart: sequenceStart,
    historyInvalidated: historyInvalidated
  )
}

/// Decode a `chat_subscribe` ack for the thread engine. Rows that fail to
/// decode are dropped one at a time (same contract as `ADELossyArray`).
func chatThreadDecodeSnapshot(_ payload: Any, hostSupportsChatLogV2: Bool) -> ChatThreadSnapshotInput? {
  guard let dict = payload as? [String: Any],
        let sessionId = dict["sessionId"] as? String
  else { return nil }
  let events = ((dict["events"] as? [Any]) ?? []).compactMap(chatThreadDecodeLiveEvent)
  let pinned = ((dict["pinnedEvents"] as? [Any]) ?? []).compactMap(chatThreadDecodeLiveEvent)
  return ChatThreadSnapshotInput(
    sessionId: sessionId,
    events: events,
    pinnedEvents: pinned,
    resumed: (dict["resumed"] as? Bool) == true,
    resumeKind: dict["resumeKind"] as? String,
    gap: (dict["gap"] as? Bool) == true,
    historyGeneration: (dict["historyGeneration"] as? NSNumber)?.intValue,
    hasOlderHistory: dict["hasOlderHistory"] as? Bool,
    tailStartOffset: (dict["tailStartOffset"] as? NSNumber)?.intValue,
    cursorKind: dict["cursorKind"] as? String,
    turnActive: dict["turnActive"] as? Bool,
    truncated: (dict["truncated"] as? Bool) == true,
    sessionFound: dict["sessionFound"] as? Bool,
    capturedAt: dict["capturedAt"] as? String,
    hostSupportsChatLogV2: hostSupportsChatLogV2
  )
}

/// Decode a `chat_history` / `getChatEventHistoryPage` reply for the engine.
/// Byte offsets (`envelopeStartOffsets`) are stamped only when every row
/// decoded, mirroring `AgentChatEventHistoryPage.stampingEnvelopeOffsets`.
func chatThreadDecodeOlderPage(_ payload: Any, requestedSessionId: String) -> ChatThreadOlderPageInput? {
  guard let dict = payload as? [String: Any] else { return nil }
  let rawEvents = (dict["events"] as? [Any]) ?? []
  var events = rawEvents.compactMap(chatThreadDecodeLiveEvent)
  if let offsets = dict["envelopeStartOffsets"] as? [NSNumber],
     offsets.count == events.count,
     events.count == rawEvents.count {
    events = zip(events, offsets).map { event, offset in
      var envelope = event.envelope
      let value = offset.intValue
      envelope.sourceOffset = value >= 0 ? value : nil
      return ChatThreadLiveEvent(
        envelope: envelope,
        raw: event.raw,
        seq: event.seq,
        sequenceStart: event.sequenceStart,
        historyInvalidated: event.historyInvalidated
      )
    }
  }
  return ChatThreadOlderPageInput(
    sessionId: (dict["sessionId"] as? String) ?? requestedSessionId,
    events: events,
    hasMore: (dict["hasMore"] as? Bool) == true,
    startOffset: (dict["startOffset"] as? NSNumber)?.intValue,
    historyGeneration: (dict["historyGeneration"] as? NSNumber)?.intValue,
    sessionFound: (dict["sessionFound"] as? Bool) ?? true,
    unavailable: (dict["unavailable"] as? Bool) == true
  )
}

/// `chat_subscribe` resume fields. With `chatLogV2` the durable
/// `sinceSequence`/`generation` pair survives a brain restart; without it the
/// transport `sinceSeq` is the only resume point.
func chatThreadSubscribeResumeFields(
  hostSupportsChatLogV2: Bool,
  includeResume: Bool,
  resumePoint: ChatThreadResumePoint?,
  legacySinceSeq: Int?
) -> [String: Any] {
  var fields: [String: Any] = [:]
  if hostSupportsChatLogV2 {
    fields["chatLogV2"] = true
    if includeResume, let resumePoint {
      fields["sinceSequence"] = resumePoint.sinceSequence
      if let generation = resumePoint.generation {
        fields["generation"] = generation
      }
    }
  }
  if includeResume, let legacySinceSeq {
    fields["sinceSeq"] = legacySinceSeq
  }
  return fields
}

// MARK: - Measurement (I9)

/// `thread.open.firstPaint` (chat opened → first apply with timeline rows)
/// and `thread.delta.onScreen` (live event handed to the engine → the
/// collection view applying the rows it produced). Both are signpost
/// intervals on the `thread` category, so Instruments and the scroll bench
/// read them the same way.
@MainActor
enum ChatThreadSignposts {
  private static var openIntervals: [String: OSSignpostIntervalState] = [:]
  private static var deltaIntervals: [String: OSSignpostIntervalState] = [:]
  private static var openStartedAt: [String: TimeInterval] = [:]
  private static var deltaStartedAt: [String: TimeInterval] = [:]

  /// Most recent measurements, for the scroll bench's log line.
  private(set) static var lastOpenFirstPaintMs: Double?
  private(set) static var lastDeltaOnScreenMs: Double?

  static func beginOpen(sessionId: String) {
    guard openIntervals[sessionId] == nil else { return }
    openIntervals[sessionId] = chatThreadSignposter.beginInterval(
      "thread.open.firstPaint",
      id: chatThreadSignposter.makeSignpostID()
    )
    openStartedAt[sessionId] = ProcessInfo.processInfo.systemUptime
  }

  /// A live event for this chat reached the registry. Only the first event
  /// since the last apply opens an interval, so the measurement is the
  /// oldest pending delta's latency.
  static func noteLiveIngest(sessionId: String) {
    guard deltaIntervals[sessionId] == nil else { return }
    deltaIntervals[sessionId] = chatThreadSignposter.beginInterval(
      "thread.delta.onScreen",
      id: chatThreadSignposter.makeSignpostID()
    )
    deltaStartedAt[sessionId] = ProcessInfo.processInfo.systemUptime
  }

  static func noteRowsOnScreen(sessionId: String, hasTimelineRows: Bool) {
    let now = ProcessInfo.processInfo.systemUptime
    if let state = deltaIntervals.removeValue(forKey: sessionId) {
      chatThreadSignposter.endInterval("thread.delta.onScreen", state)
      if let started = deltaStartedAt.removeValue(forKey: sessionId) {
        lastDeltaOnScreenMs = (now - started) * 1000
        WorkChatScrollTrace.note("thread.delta.onScreen ms=\(Int(((now - started) * 1000).rounded()))")
      }
    }
    guard hasTimelineRows, let state = openIntervals.removeValue(forKey: sessionId) else { return }
    chatThreadSignposter.endInterval("thread.open.firstPaint", state)
    if let started = openStartedAt.removeValue(forKey: sessionId) {
      lastOpenFirstPaintMs = (now - started) * 1000
      WorkChatScrollTrace.note("thread.open.firstPaint ms=\(Int(((now - started) * 1000).rounded()))")
    }
  }

  /// The chat closed before anything painted: drop the open interval.
  static func cancelOpen(sessionId: String) {
    if let state = openIntervals.removeValue(forKey: sessionId) {
      chatThreadSignposter.endInterval("thread.open.firstPaint", state)
    }
    openStartedAt.removeValue(forKey: sessionId)
    if let state = deltaIntervals.removeValue(forKey: sessionId) {
      chatThreadSignposter.endInterval("thread.delta.onScreen", state)
    }
    deltaStartedAt.removeValue(forKey: sessionId)
  }
}
