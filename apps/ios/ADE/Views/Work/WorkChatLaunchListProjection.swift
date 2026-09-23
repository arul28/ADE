import Foundation

// Non-view projection of chat launches into the Work list and the Hub roster.
// Pure functions over snapshots, covered by `ChatLaunchTests`.

// MARK: - List projection

/// A Work row for a launch whose session row has not replicated yet.
func workChatLaunchOptimisticSession(_ entry: ChatLaunchEntry) -> TerminalSessionSummary {
  let snapshot = entry.snapshot
  let failed = snapshot.phase == .failed
  let activity = snapshot.updatedAt.isEmpty ? snapshot.startedAt : snapshot.updatedAt
  var session = TerminalSessionSummary(
    id: snapshot.chatSessionId,
    laneId: snapshot.laneId,
    laneName: snapshot.laneName.isEmpty ? snapshot.laneId : snapshot.laneName,
    ptyId: nil,
    tracked: true,
    pinned: false,
    manuallyNamed: nil,
    goal: nil,
    toolType: toolTypeForProvider(entry.resolvedProvider),
    title: workChatLaunchRowTitle(snapshot),
    status: "running",
    startedAt: activity,
    endedAt: nil,
    exitCode: nil,
    transcriptPath: "",
    headShaStart: nil,
    headShaEnd: nil,
    lastOutputPreview: nil,
    summary: nil,
    runtimeState: "running",
    resumeCommand: nil,
    resumeMetadata: nil,
    chatIdleSinceAt: nil
  )
  session.statusNote = chatLaunchStatusLine(snapshot)
  session.launchRail = chatLaunchRailSegments(snapshot.stages)
  if failed {
    session.lastTurnFailedAt = activity
  }
  return session
}

/// Row title before the host names the chat: its title, else the prompt's first line.
func workChatLaunchRowTitle(_ snapshot: ChatLaunchSnapshot) -> String {
  let title = snapshot.title.trimmingCharacters(in: .whitespacesAndNewlines)
  if !title.isEmpty { return title }
  let firstLine = snapshot.prompt.bubbleText
    .split(whereSeparator: \.isNewline)
    .first
    .map(String.init)?
    .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  guard !firstLine.isEmpty else { return "New chat" }
  return firstLine.count > 72 ? String(firstLine.prefix(72)) + "…" : firstLine
}

/// Folds pending launches into the Work list's sessions and lanes. A launch
/// with no session row yet gets a synthesized row under its lane (the lane may
/// not have replicated either); once the real row exists it wins, and only its
/// preview line borrows the launch's status line while the launch is pending.
func workOverlayChatLaunches(
  sessions: [TerminalSessionSummary],
  lanes: [LaneSummary],
  launches: [ChatLaunchEntry]
) -> (sessions: [TerminalSessionSummary], lanes: [LaneSummary]) {
  let pending = launches.filter { $0.snapshot.kind == .chat && isChatLaunchPending($0.snapshot) }
  guard !pending.isEmpty else { return (sessions, lanes) }
  var nextSessions = sessions
  var nextLanes = lanes
  var indexById = Dictionary(nextSessions.enumerated().map { ($0.element.id, $0.offset) }, uniquingKeysWith: { first, _ in first })
  var laneIds = Set(nextLanes.map(\.id))
  for entry in pending {
    let snapshot = entry.snapshot
    let sessionId = snapshot.chatSessionId
    if let index = indexById[sessionId] {
      nextSessions[index].statusNote = chatLaunchStatusLine(snapshot)
      nextSessions[index].launchRail = chatLaunchRailSegments(snapshot.stages)
      if snapshot.phase == .failed {
        nextSessions[index].lastTurnFailedAt = snapshot.updatedAt.isEmpty ? snapshot.startedAt : snapshot.updatedAt
      }
    } else {
      indexById[sessionId] = nextSessions.count
      nextSessions.append(workChatLaunchOptimisticSession(entry))
    }
    if !snapshot.laneId.isEmpty, laneIds.insert(snapshot.laneId).inserted {
      nextLanes.append(workChatLaunchRosterLane(snapshot).asLaneSummary())
    }
  }
  return (nextSessions, nextLanes)
}

func workChatLaunchRosterLane(_ snapshot: ChatLaunchSnapshot) -> RemoteRosterLane {
  RemoteRosterLane(
    id: snapshot.laneId,
    name: snapshot.laneName.isEmpty ? "New lane" : snapshot.laneName,
    color: nil,
    icon: nil,
    laneType: "worktree",
    branchRef: snapshot.branchRef
  )
}

/// Hub counterpart of `workOverlayChatLaunches`, over a project's roster.
func hubRosterOverlayingChatLaunches(
  _ roster: RemoteRosterProject?,
  project: MobileProjectSummary,
  launches: [ChatLaunchEntry]
) -> RemoteRosterProject? {
  let pending = launches.filter { $0.snapshot.kind == .chat && isChatLaunchPending($0.snapshot) }
  guard !pending.isEmpty else { return roster }
  var next = roster ?? RemoteRosterProject(
    projectId: project.id,
    rootPath: project.rootPath,
    displayName: project.displayName,
    iconDataUrl: nil,
    lastOpenedAt: project.lastOpenedAt,
    booted: false,
    runningCount: 0,
    attentionCount: 0,
    lanes: [],
    chats: []
  )
  var laneIds = Set(next.lanes.map(\.id))
  for entry in pending {
    let snapshot = entry.snapshot
    let sessionId = snapshot.chatSessionId
    let failed = snapshot.phase == .failed
    let activity = snapshot.updatedAt.isEmpty ? snapshot.startedAt : snapshot.updatedAt
    if let index = next.chats.firstIndex(where: { $0.id == sessionId }) {
      next.chats[index].preview = chatLaunchStatusLine(snapshot)
      next.chats[index].launchRail = chatLaunchRailSegments(snapshot.stages)
      next.chats[index].status = failed ? .failed : .running
    } else {
      let provider = entry.resolvedProvider
      next.chats.insert(
        RemoteRosterChat(
          id: sessionId,
          laneId: snapshot.laneId,
          chatSessionId: nil,
          title: workChatLaunchRowTitle(snapshot),
          provider: provider,
          model: snapshot.modelId,
          toolType: toolTypeForProvider(provider),
          status: failed ? .failed : .running,
          awaitingInput: false,
          pinned: false,
          archived: false,
          lastActivityAt: activity,
          preview: chatLaunchStatusLine(snapshot),
          launchRail: chatLaunchRailSegments(snapshot.stages)
        ),
        at: 0
      )
    }
    if !snapshot.laneId.isEmpty, laneIds.insert(snapshot.laneId).inserted {
      next.lanes.append(workChatLaunchRosterLane(snapshot))
    }
  }
  next.runningCount = next.chats.filter(\.countsTowardRunning).count
  return next
}
