import Foundation
import OSLog
import SwiftUI

// MARK: - Harness
//
// Scroll benchmark harness for the Work chat transcript. DEBUG-only on both
// sides: the fixture screen is compiled out of release, and every trace call
// below has an empty release body.
//
// Build (one xcodebuild at a time — take the shared lock in the same command):
//
//   until mkdir "$TMPDIR/ade-xcodebuild.lock" 2>/dev/null; do sleep 15; done; \
//     xcodebuild -project apps/ios/ADE.xcodeproj -scheme ADE \
//       -destination 'platform=iOS Simulator,id=<UDID>' \
//       -derivedDataPath "$TMPDIR/dd-scroll-bench" build; \
//     rc=$?; rmdir "$TMPDIR/ade-xcodebuild.lock"; exit $rc
//
// Install + seed the transcript into the app container:
//
//   xcrun simctl install <UDID> "$TMPDIR/dd-scroll-bench/Build/Products/Debug-iphonesimulator/ADE.app"
//   DATA=$(xcrun simctl get_app_container <UDID> com.ade.ios data)
//   cp thread.jsonl "$DATA/Documents/bench.jsonl"
//
// Run (static tail, 3000 newest events, tracing on):
//
//   xcrun simctl launch <UDID> com.ade.ios \
//     -adePreviewScreen chat-scroll \
//     -adeBenchTranscript "$DATA/Documents/bench.jsonl" \
//     -adeBenchLimit 3000 -adeScrollTrace 1
//
// Run (live turn: hold back the newest 120 events and append one every 120ms):
//
//   ... -adeBenchStream 120 -adeBenchStreamIntervalMs 120
//
// Logs (subsystem is `com.ade.ios.scrollbench`):
//
//   xcrun simctl spawn <UDID> log stream --style compact \
//     --predicate 'subsystem == "com.ade.ios.scrollbench"' > "$TMPDIR/scroll-<case>.log"
//
// Video:
//
//   xcrun simctl io <UDID> recordVideo --codec h264 "$TMPDIR/scroll-<case>.mp4"

/// Records every programmatic scroll write and every scroll/content-size frame
/// so a recorded case can be reduced to "who moved the reader, how far".
///
/// All bodies are `#if DEBUG`; in release each entry point is a no-op that the
/// optimizer removes, so the product call sites stay unconditional.
enum WorkChatScrollTrace {
  #if DEBUG
  static let logger = Logger(subsystem: "com.ade.ios.scrollbench", category: "scroll")
  static let signposter = OSSignposter(
    subsystem: "com.ade.ios.scrollbench",
    category: "scroll"
  )

  /// Opt-in so a normal DEBUG build of the app does not log per scroll frame.
  nonisolated(unsafe) static let enabled = ProcessInfo.processInfo.arguments
    .contains("-adeScrollTrace")

  @MainActor private static var lastSampleOffset: CGFloat = .nan
  @MainActor private static var writeSerial: Int = 0
  #endif

  /// A programmatic scroll write is about to be issued.
  ///
  /// `target` is the write's own description (`y=1234`, `edge=bottom`,
  /// `id=chat-end`), `offsetBefore` the live `contentOffset.y` at the moment of
  /// the call. The settled offset is recovered from the `sample` lines that
  /// follow, because SwiftUI applies the write on a later layout pass.
  @MainActor
  static func write(
    reason: String,
    target: String,
    site: String,
    offsetBefore: CGFloat,
    contentHeight: CGFloat,
    containerHeight: CGFloat,
    scrollableHeight: CGFloat,
    following: Bool,
    userDrivenPhase: Bool
  ) {
    #if DEBUG
    guard enabled else { return }
    writeSerial += 1
    let serial = writeSerial
    signposter.emitEvent("scrollWrite", "\(reason, privacy: .public)")
    logger.log(
      """
      write#\(serial, privacy: .public) reason=\(reason, privacy: .public) \
      target=\(target, privacy: .public) site=\(site, privacy: .public) \
      offsetBefore=\(offsetBefore, privacy: .public) \
      content=\(contentHeight, privacy: .public) \
      container=\(containerHeight, privacy: .public) \
      scrollable=\(scrollableHeight, privacy: .public) \
      following=\(following, privacy: .public) \
      userPhase=\(userDrivenPhase, privacy: .public)
      """
    )
    #endif
  }

  /// One per scroll geometry frame. The offset delta between consecutive
  /// samples is the ground truth for "the reader moved"; a large delta with no
  /// `write` line in front of it is SwiftUI's own re-measurement.
  @MainActor
  static func sample(
    offsetY: CGFloat,
    contentHeight: CGFloat,
    containerHeight: CGFloat,
    scrollableHeight: CGFloat,
    distanceFromBottom: CGFloat,
    userDrivenPhase: Bool,
    following: Bool
  ) {
    #if DEBUG
    guard enabled else { return }
    let delta = lastSampleOffset.isNaN ? 0 : offsetY - lastSampleOffset
    lastSampleOffset = offsetY
    logger.log(
      """
      sample off=\(offsetY, privacy: .public) d=\(delta, privacy: .public) \
      content=\(contentHeight, privacy: .public) \
      container=\(containerHeight, privacy: .public) \
      scrollable=\(scrollableHeight, privacy: .public) \
      fromBottom=\(distanceFromBottom, privacy: .public) \
      userPhase=\(userDrivenPhase, privacy: .public) \
      following=\(following, privacy: .public)
      """
    )
    #endif
  }

  /// Content size / window change, which is the other thing that can move what
  /// the reader sees without anybody issuing a scroll write.
  @MainActor
  static func contentSize(
    previousContent: CGFloat,
    nextContent: CGFloat,
    previousContainer: CGFloat,
    nextContainer: CGFloat,
    offsetY: CGFloat,
    following: Bool
  ) {
    #if DEBUG
    guard enabled else { return }
    logger.log(
      """
      content prevContent=\(previousContent, privacy: .public) \
      nextContent=\(nextContent, privacy: .public) \
      dContent=\(nextContent - previousContent, privacy: .public) \
      prevContainer=\(previousContainer, privacy: .public) \
      nextContainer=\(nextContainer, privacy: .public) \
      dContainer=\(nextContainer - previousContainer, privacy: .public) \
      off=\(offsetY, privacy: .public) following=\(following, privacy: .public)
      """
    )
    #endif
  }

  /// Follow-latch transitions, so a jump can be attributed to the state machine
  /// flipping rather than to the write that the flip authorized.
  @MainActor
  static func follow(_ following: Bool, reason: String) {
    #if DEBUG
    guard enabled else { return }
    logger.log("follow=\(following, privacy: .public) reason=\(reason, privacy: .public)")
    #endif
  }

  @MainActor
  static func phase(userDriven: Bool, raw: String) {
    #if DEBUG
    guard enabled else { return }
    logger.log("phase user=\(userDriven, privacy: .public) raw=\(raw, privacy: .public)")
    #endif
  }

  /// Position of the topmost visible row inside the viewport.
  ///
  /// Two consecutive lines naming the SAME row are a direct reading of how far
  /// the reader's content moved, which `contentOffset` no longer is: UIKit
  /// adjusts the offset precisely so that a self-sizing row above the viewport
  /// does not move what is on screen.
  @MainActor
  static func viewport(
    rowId: String,
    offsetInViewport: CGFloat,
    userDriven: Bool,
    following: Bool
  ) {
    #if DEBUG
    guard enabled else { return }
    logger.log(
      """
      viewport row=\(rowId, privacy: .public) y=\(offsetInViewport, privacy: .public) \
      user=\(userDriven, privacy: .public) following=\(following, privacy: .public)
      """
    )
    #endif
  }

  @MainActor
  static func note(_ message: String) {
    #if DEBUG
    guard enabled else { return }
    logger.log("note \(message, privacy: .public)")
    #endif
  }
}

#if DEBUG

/// Launch-argument configuration for the scroll bench.
struct WorkChatScrollBenchOptions {
  var transcriptPath: String?
  /// Keep only the newest N envelopes. 0 = the whole file.
  var limit: Int = 0
  /// Hold back the newest N envelopes and append them on a timer, imitating a
  /// live turn arriving while the reader is in the transcript.
  var streamCount: Int = 0
  var streamIntervalMs: Int = 120
  /// Show the chat-info and PR badge chips over the composer.
  var chips: Bool = false
  /// Render the composer the way the CTO session does (`compactComposer`).
  var compactComposer: Bool = false

  static func fromLaunchArguments(_ arguments: [String] = ProcessInfo.processInfo.arguments)
    -> WorkChatScrollBenchOptions
  {
    func value(_ flag: String) -> String? {
      guard let index = arguments.firstIndex(of: flag),
            arguments.index(after: index) < arguments.endIndex else { return nil }
      return arguments[arguments.index(after: index)]
    }
    var options = WorkChatScrollBenchOptions()
    options.transcriptPath = value("-adeBenchTranscript")
    options.limit = value("-adeBenchLimit").flatMap(Int.init) ?? 0
    options.streamCount = value("-adeBenchStream").flatMap(Int.init) ?? 0
    options.streamIntervalMs = value("-adeBenchStreamIntervalMs").flatMap(Int.init) ?? 120
    options.chips = value("-adeBenchChips") == "1"
    options.compactComposer = arguments.contains("-adeBenchCompactComposer")
    return options
  }
}

/// Reads an ADE chat transcript JSONL off disk into the same decoded wire
/// events the sync path hands the thread engine (envelope + raw bytes), so the
/// bench renders the real view through the real engine with no brain, no
/// pairing, and no network.
enum WorkChatScrollBenchLoader {
  static func load(path: String, limit: Int) -> [ChatThreadLiveEvent] {
    guard let data = FileManager.default.contents(atPath: path),
          let text = String(data: data, encoding: .utf8) else {
      return []
    }
    var events: [ChatThreadLiveEvent] = []
    events.reserveCapacity(4096)
    var sequence = 0
    text.enumerateLines { line, _ in
      let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !trimmed.isEmpty,
            let lineData = trimmed.data(using: .utf8),
            var object = (try? JSONSerialization.jsonObject(with: lineData)) as? [String: Any]
      else { return }
      // The first line is a `session_init` header with no `event` object; every
      // other line is an envelope. A row this decoder cannot read is skipped
      // rather than failing the load — a bench over 20k rows should not die on
      // one legacy frame.
      guard object["event"] != nil else { return }
      sequence += 1
      if object["sequence"] == nil {
        object["sequence"] = sequence
      }
      guard let event = chatThreadDecodeLiveEvent(object) else { return }
      events.append(event)
    }
    guard limit > 0, events.count > limit else { return events }
    return Array(events.suffix(limit))
  }
}

/// Renders the real `WorkChatSessionView` over a transcript file, fed through a
/// store-less thread engine: the opening load is one `chat_subscribe`-shaped
/// snapshot, and the held-back tail arrives as live events on a timer. Emits
/// `thread.open.firstPaint` and `thread.delta.onScreen` (signposts, and `note`
/// lines under `-adeScrollTrace`), plus a summary line when streaming ends.
struct WorkChatScrollBenchScreen: View {
  let options: WorkChatScrollBenchOptions

  @State private var registry = ChatThreadRegistry(store: nil)
  @State private var thread: ChatThreadModel?
  @State private var sessionId = "scroll-bench-session"
  @State private var held: [ChatThreadLiveEvent] = []
  @State private var cardExpansion = WorkCardExpansionState(expandedIds: [])
  @State private var artifactContent: [String: WorkLoadedArtifactContent] = [:]
  @State private var fullscreenImage: WorkFullscreenImage?
  @State private var artifactDrawerPresented = false
  @State private var sending = false
  @State private var errorMessage: String?
  @State private var didLoad = false

  private var key: ChatThreadKey {
    ChatThreadKey(machineKey: "bench", sessionId: sessionId, scope: .project("bench"))
  }

  var body: some View {
    NavigationStack {
      content
    }
    .task {
      guard !didLoad else { return }
      didLoad = true
      loadTranscript()
    }
  }

  @ViewBuilder
  private var content: some View {
    if let thread {
      chatView(thread)
    } else {
      VStack(spacing: 12) {
        Text("Scroll bench")
          .font(.headline)
        Text(options.transcriptPath ?? "no -adeBenchTranscript argument")
          .font(.footnote)
          .multilineTextAlignment(.center)
        Text("Loaded 0 envelopes")
          .font(.footnote)
      }
      .padding()
    }
  }

  private func chatView(_ thread: ChatThreadModel) -> some View {
    var view = WorkChatSessionView(
      session: WorkChatSessionRenderContext(benchTerminalSession(sessionId: sessionId)),
      chatSummaryContext: WorkChatSummaryRenderContext(benchChatSummary(sessionId: sessionId)),
      thread: thread,
      artifacts: [],
      cardExpansionSnapshot: cardExpansion,
      cardExpansionRenderSignature: workCardExpansionRenderSignature(cardExpansion),
      artifactContentRenderSignature: workLoadedArtifactContentRenderSignature([:]),
      artifactDrawerPresentedSnapshot: artifactDrawerPresented,
      sendingSnapshot: sending,
      errorMessageSnapshot: errorMessage,
      cardExpansion: $cardExpansion,
      artifactContent: $artifactContent,
      fullscreenImage: $fullscreenImage,
      artifactDrawerPresented: $artifactDrawerPresented,
      artifactRefreshInFlight: false,
      artifactRefreshError: nil,
      sending: $sending,
      errorMessage: $errorMessage,
      isLive: true,
      hostUnreachable: false,
      canComposeMessages: true,
      canSendMessages: true,
      sendWillQueue: false,
      sendWillQueueIsReconnect: false,
      activeSendModesAvailable: true,
      queueAwareStopAvailable: true,
      transportHealth: .connected,
      composerDraftRestore: nil,
      transitionNamespace: nil,
      onOpenLane: {},
      onSend: { _, _, _ in true },
      onInterrupt: { _ in },
      onRestoreCancelledQueue: nil,
      onApproveRequest: { _, _, _ in },
      onRespondToQuestion: { _, _, _, _ in },
      onSubmitQuestionAnswers: { _, _, _ in },
      onDeclineQuestion: { _ in },
      onRespondToPermission: { _, _ in },
      onRetryLoad: {},
      onOpenFile: { _ in },
      onOpenPr: { _ in },
      onLoadArtifact: { _, _ in },
      onRefreshArtifacts: {},
      onCancelSteer: { _ in },
      onEditSteer: { _, _ in },
      onDispatchSteerInline: nil,
      onDispatchSteerInterrupt: nil,
      onSelectModel: { _ in },
      onSelectRuntimeMode: { _ in true },
      onSelectEffort: { _ in },
      onSelectCodexFastMode: { _ in true },
      lanesRenderSignature: workLaneListRenderSignature([]),
      subagentSnapshotsRenderSignature: workSubagentSnapshotsRenderSignature([]),
      scheduledWorkSnapshots: benchScheduledWork,
      scheduledWorkSnapshotsRenderSignature: workScheduledWorkSnapshotsRenderSignature(benchScheduledWork),
      onOpenChatInfo: options.chips ? {} : nil,
      prBadge: options.chips ? benchPrBadge : nil,
      onOpenPrDetails: options.chips ? {} : nil
    )
    // `-adeBenchCompactComposer`: the CTO's composer configuration.
    view.compactComposer = options.compactComposer
    // The real thread header, so the bench measures the transcript under the
    // same top chrome the app draws.
    return view.workSessionNavigationChrome(
      mode: .pushedDetail,
      title: "Scroll bench",
      subtitle: workChatHeaderSubtitle(machineName: "MacBook Pro")
    ) {
      Menu {
        Button("Chat Info") {}
        Button("Proof") {}
      } label: {
        WorkChatGlassCircleLabel(systemName: "ellipsis", glyphSize: 17)
      }
      .buttonStyle(.plain)
    }
  }

  private var benchScheduledWork: [WorkScheduledWorkSnapshot] {
    guard options.chips else { return [] }
    let now = ISO8601DateFormatter().string(from: Date())
    return (0..<3).map { index in
      WorkScheduledWorkSnapshot(
        id: "bench-bg-\(index)", kind: "background_task", status: "running", origin: nil,
        title: "Background task \(index + 1)", summary: nil, prompt: "npm test", reason: nil,
        cron: nil, nextRunAt: nil, lastRunAt: nil, firedAt: nil, late: nil, recurring: nil,
        durable: nil, cancellable: true, sourceToolUseId: nil, sourceTaskId: nil, turnId: nil,
        error: nil, createdAt: now, updatedAt: now
      )
    }
  }

  private var benchPrBadge: WorkChatPrBadgeModel {
    WorkChatPrBadgeModel(
      label: "#1300",
      title: "Measure every turn for the ADE router",
      state: "open",
      checksStatus: "passing",
      checksReason: nil,
      reviewStatus: nil,
      updatedAt: ISO8601DateFormatter().string(from: Date()),
      stack: nil
    )
  }

  @MainActor
  private func loadTranscript() {
    guard let path = options.transcriptPath else {
      WorkChatScrollTrace.note("bench no transcript path")
      return
    }
    let started = ProcessInfo.processInfo.systemUptime
    var events = WorkChatScrollBenchLoader.load(path: path, limit: options.limit)
    guard !events.isEmpty else {
      WorkChatScrollTrace.note("bench loaded 0 envelopes")
      return
    }
    if options.streamCount > 0, events.count > options.streamCount {
      held = Array(events.suffix(options.streamCount))
      events = Array(events.dropLast(options.streamCount))
    }
    sessionId = events.first?.envelope.sessionId ?? sessionId
    let key = self.key
    ChatThreadSignposts.beginOpen(sessionId: key.sessionId)
    let model = registry.attach(key)
    thread = model
    registry.routeSnapshot(
      ChatThreadSnapshotInput(
        sessionId: key.sessionId,
        events: events,
        hasOlderHistory: false,
        turnActive: !held.isEmpty,
        hostSupportsChatLogV2: true
      ),
      key: key
    )
    let elapsed = ProcessInfo.processInfo.systemUptime - started
    WorkChatScrollTrace.note(
      "bench loaded envelopes=\(events.count) held=\(held.count) loadMs=\(Int(elapsed * 1000))"
    )
    guard !held.isEmpty else { return }
    startStreaming()
  }

  @MainActor
  private func startStreaming() {
    let interval = max(16, options.streamIntervalMs)
    let key = self.key
    Task { @MainActor in
      // A short head start so the opening pin and hydration have settled before
      // the first appended event lands.
      try? await Task.sleep(for: .milliseconds(1500))
      WorkChatScrollTrace.note("bench stream start pending=\(held.count) intervalMs=\(interval)")
      var deltaSamples: [Double] = []
      while !held.isEmpty {
        let next = held.removeFirst()
        registry.routeLive(next, key: key)
        try? await Task.sleep(for: .milliseconds(interval))
        if let sample = ChatThreadSignposts.lastDeltaOnScreenMs {
          deltaSamples.append(sample)
        }
      }
      let sorted = deltaSamples.sorted()
      let p50 = sorted.isEmpty ? 0 : sorted[sorted.count / 2]
      let p95 = sorted.isEmpty ? 0 : sorted[min(sorted.count - 1, Int(Double(sorted.count) * 0.95))]
      WorkChatScrollTrace.note(
        "bench stream done firstPaintMs=\(Int((ChatThreadSignposts.lastOpenFirstPaintMs ?? -1).rounded())) deltaOnScreenP50Ms=\(Int(p50.rounded())) deltaOnScreenP95Ms=\(Int(p95.rounded()))"
      )
    }
  }
}

/// Session-row fixture. Duplicated rather than shared with `WorkPreviewData`
/// (which is `private`) so the bench owns its own file and does not collide
/// with edits to the preview fixtures.
@MainActor
func benchChatSummary(sessionId: String) -> AgentChatSessionSummary {
  let now = ISO8601DateFormatter().string(from: Date())
  return AgentChatSessionSummary(
    sessionId: sessionId,
    laneId: "scroll-bench-lane",
    provider: "claude",
    model: "claude-opus-5",
    modelId: "anthropic/claude-opus-5",
    sessionProfile: nil,
    title: "Scroll bench",
    goal: "Reproduce transcript scroll jumps",
    reasoningEffort: nil,
    codexFastMode: nil,
    fastMode: nil,
    executionMode: nil,
    permissionMode: "edit",
    interactionMode: "default",
    claudePermissionMode: "default",
    codexApprovalPolicy: nil,
    codexSandbox: nil,
    codexConfigSource: nil,
    opencodePermissionMode: nil,
    droidPermissionMode: nil,
    cursorModeSnapshot: nil,
    cursorModeId: nil,
    cursorConfigValues: nil,
    identityKey: nil,
    surface: "mobile",
    automationId: nil,
    automationRunId: nil,
    capabilityMode: nil,
    computerUse: nil,
    completion: nil,
    status: "active",
    idleSinceAt: nil,
    startedAt: now,
    endedAt: nil,
    lastActivityAt: now,
    lastOutputPreview: nil,
    summary: "Scroll bench transcript",
    awaitingInput: false,
    threadId: nil,
    requestedCwd: "/tmp"
  )
}

@MainActor
func benchTerminalSession(sessionId: String) -> TerminalSessionSummary {
  let now = ISO8601DateFormatter().string(from: Date())
  return TerminalSessionSummary(
    id: sessionId,
    laneId: "scroll-bench-lane",
    laneName: "scroll-bench",
    ptyId: nil,
    tracked: true,
    pinned: false,
    manuallyNamed: true,
    goal: "Reproduce transcript scroll jumps",
    toolType: "claude-chat",
    title: "Scroll bench",
    status: "running",
    startedAt: now,
    endedAt: nil,
    exitCode: nil,
    transcriptPath: ".ade/transcripts/chat/\(sessionId).jsonl",
    headShaStart: nil,
    headShaEnd: nil,
    lastOutputPreview: nil,
    summary: "Scroll bench transcript",
    runtimeState: "active",
    resumeCommand: nil,
    resumeMetadata: nil,
    chatIdleSinceAt: nil
  )
}

#endif
