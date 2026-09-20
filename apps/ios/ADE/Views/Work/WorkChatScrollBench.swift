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

  /// A write site that decided not to write. Counting the refusals is how a
  /// "nothing happened when I asked" complaint gets separated from a jump.
  @MainActor
  static func writeSuppressed(reason: String, site: String, cause: String) {
    #if DEBUG
    guard enabled else { return }
    logger.log(
      "suppressed reason=\(reason, privacy: .public) site=\(site, privacy: .public) cause=\(cause, privacy: .public)"
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
    return options
  }
}

/// Reads an ADE chat transcript JSONL off disk into the same envelope type the
/// sync path produces, so the bench renders the real view over real data with
/// no brain, no pairing, and no network.
enum WorkChatScrollBenchLoader {
  static func load(path: String, limit: Int) -> [AgentChatEventEnvelope] {
    guard let data = FileManager.default.contents(atPath: path),
          let text = String(data: data, encoding: .utf8) else {
      return []
    }
    let decoder = JSONDecoder()
    var envelopes: [AgentChatEventEnvelope] = []
    envelopes.reserveCapacity(4096)
    var sequence = 0
    text.enumerateLines { line, _ in
      let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !trimmed.isEmpty, let lineData = trimmed.data(using: .utf8) else { return }
      // The first line is a `session_init` header with no `event` object; every
      // other line is an envelope. A row this decoder cannot read is skipped
      // rather than failing the load — a bench over 20k rows should not die on
      // one legacy frame.
      guard var envelope = try? decoder.decode(AgentChatEventEnvelope.self, from: lineData) else {
        return
      }
      sequence += 1
      if envelope.sequence == nil {
        envelope.sequence = sequence
      }
      envelopes.append(envelope)
    }
    guard limit > 0, envelopes.count > limit else { return envelopes }
    return Array(envelopes.suffix(limit))
  }
}

/// Renders the real `WorkChatSessionView` over a transcript file.
struct WorkChatScrollBenchScreen: View {
  let options: WorkChatScrollBenchOptions

  @State private var loaded: [AgentChatEventEnvelope] = []
  @State private var held: [AgentChatEventEnvelope] = []
  @State private var transcript: [WorkChatEnvelope] = []
  @State private var incrementalDelta: [WorkChatEnvelope] = []
  @State private var cardExpansion = WorkCardExpansionState(expandedIds: [])
  @State private var artifactContent: [String: WorkLoadedArtifactContent] = [:]
  @State private var fullscreenImage: WorkFullscreenImage?
  @State private var artifactDrawerPresented = false
  @State private var sending = false
  @State private var errorMessage: String?
  @State private var didLoad = false

  private var sessionId: String {
    loaded.first?.sessionId ?? "scroll-bench-session"
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
    if transcript.isEmpty {
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
    } else {
      chatView
    }
  }

  private var chatView: some View {
    WorkChatSessionView(
      session: WorkChatSessionRenderContext(benchTerminalSession(sessionId: sessionId)),
      chatSummaryContext: WorkChatSummaryRenderContext(benchChatSummary(sessionId: sessionId)),
      transcript: transcript,
      transcriptRenderSignature: workChatEnvelopeListRenderSignature(transcript),
      allowsIncrementalTranscriptUpdate: false,
      transcriptIncrementalDelta: $incrementalDelta,
      fallbackEntries: [],
      fallbackEntriesRenderSignature: workFallbackEntriesRenderSignature([]),
      artifacts: [],
      artifactsRenderSignature: workArtifactSummariesRenderSignature([]),
      optimisticPendingSteers: [],
      optimisticPendingSteersRenderSignature: workPendingSteersRenderSignature([]),
      localEchoMessages: [],
      localEchoMessagesRenderSignature: workLocalEchoMessagesRenderSignature([]),
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
      onLoadArtifact: { _ in },
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
      scheduledWorkSnapshotsRenderSignature: workScheduledWorkSnapshotsRenderSignature([])
    )
  }

  @MainActor
  private func loadTranscript() {
    guard let path = options.transcriptPath else {
      WorkChatScrollTrace.note("bench no transcript path")
      return
    }
    let started = ProcessInfo.processInfo.systemUptime
    var envelopes = WorkChatScrollBenchLoader.load(path: path, limit: options.limit)
    guard !envelopes.isEmpty else {
      WorkChatScrollTrace.note("bench loaded 0 envelopes from \(path)")
      return
    }
    if options.streamCount > 0, envelopes.count > options.streamCount {
      held = Array(envelopes.suffix(options.streamCount))
      envelopes = Array(envelopes.dropLast(options.streamCount))
    }
    loaded = envelopes
    transcript = makeWorkChatTranscript(from: envelopes)
    let elapsed = ProcessInfo.processInfo.systemUptime - started
    WorkChatScrollTrace.note(
      "bench loaded envelopes=\(envelopes.count) rows=\(transcript.count) held=\(held.count) loadMs=\(Int(elapsed * 1000))"
    )
    guard !held.isEmpty else { return }
    startStreaming()
  }

  @MainActor
  private func startStreaming() {
    let interval = max(16, options.streamIntervalMs)
    Task { @MainActor in
      // A short head start so the opening pin and hydration have settled before
      // the first appended event lands.
      try? await Task.sleep(for: .milliseconds(1500))
      WorkChatScrollTrace.note("bench stream start pending=\(held.count) intervalMs=\(interval)")
      while !held.isEmpty {
        let next = held.removeFirst()
        loaded.append(next)
        transcript = makeWorkChatTranscript(from: loaded)
        WorkChatScrollTrace.note("bench stream append rows=\(transcript.count)")
        try? await Task.sleep(for: .milliseconds(interval))
      }
      WorkChatScrollTrace.note("bench stream done")
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
