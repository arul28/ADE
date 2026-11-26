import SwiftUI

// The CTO surface's data on iOS: notes, open work, routines, the chats it
// started and what they produced. Every read and write goes to the CTO's home
// machine (see the CTO v2 calls in SyncService). A fixture store holds its own
// data and talks to nothing.

// MARK: - Rows

/// A chat the CTO started, as the profile lists it.
struct CtoChildRow: Identifiable, Hashable {
  enum Status: Hashable { case working, needsYou, idle }

  let id: String
  let laneId: String
  let title: String
  let laneName: String?
  let provider: String?
  let status: Status
  let startedAt: String

  var statusWord: String {
    switch status {
    case .working: return "Working"
    case .needsYou: return "Needs you"
    case .idle: return "Idle"
    }
  }

  var isOpen: Bool { status != .idle }
}

/// One thing the CTO's work produced: a PR its chats opened, or a lane they
/// worked in.
struct CtoLibraryItem: Identifiable, Hashable {
  enum Kind: String, Hashable, CaseIterable { case prs, lanes }

  let id: String
  let kind: Kind
  let title: String
  let detail: String
  let at: String
  /// PR state ("open", "draft", "merged", "closed"); nil for a lane.
  let prState: String?
  let prId: String?
  let prNumber: Int?
  let laneId: String
  /// The newest chat in that lane, which a lane row opens.
  let sessionId: String?
}

// MARK: - Routine words

func ctoRoutineTitle(_ item: AgentChatScheduledWorkItem) -> String {
  let title = item.title.trimmingCharacters(in: .whitespacesAndNewlines)
  if !title.isEmpty { return title }
  if let reason = item.reason?.trimmingCharacters(in: .whitespacesAndNewlines), !reason.isEmpty { return reason }
  return item.prompt.split(whereSeparator: \.isNewline).first.map(String.init) ?? "Routine"
}

func ctoRoutineIsPending(_ item: AgentChatScheduledWorkItem) -> Bool {
  item.status == "scheduled" || item.status == "paused"
}

/// The row's own switch. Absent on an older host: read it off the status.
func ctoRoutineRowPaused(_ item: AgentChatScheduledWorkItem) -> Bool {
  item.paused ?? (item.status == "paused")
}

private let ctoDayShort = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
private let ctoDayPlural = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"]

/// How often a cron repeats, without its clock time: "Weekdays", "Daily",
/// "Every 20 min". The clock time comes from `nextRunAt`, in the viewer's time.
func ctoCronCadence(_ cron: String) -> String {
  let fields = cron.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
  guard fields.count == 5 else { return "Repeats" }
  let minute = fields[0], hour = fields[1], dayOfMonth = fields[2], month = fields[3], dayOfWeek = fields[4]
  func stepValue(_ field: String) -> String? {
    guard field.hasPrefix("*/") else { return nil }
    let value = String(field.dropFirst(2))
    return Int(value) == nil ? nil : value
  }
  if hour == "*", let step = stepValue(minute) { return "Every \(step) min" }
  if hour == "*" && minute == "*" { return "Every minute" }
  if hour == "*" { return "Hourly" }
  if let step = stepValue(hour) { return "Every \(step) h" }
  if month != "*" { return "Yearly" }
  if dayOfMonth != "*" { return "Monthly" }
  if dayOfWeek == "*" { return "Daily" }
  var days = Set<Int>()
  for part in dayOfWeek.split(separator: ",") {
    let range = part.split(separator: "-").map { Int($0.trimmingCharacters(in: .whitespaces)) }
    guard let from = range.first ?? nil, from >= 0, from <= 7 else { return "Weekly" }
    let to = range.count > 1 ? (range[1] ?? from) : from
    guard to >= from, to <= 7 else { return "Weekly" }
    for day in from...to { days.insert(day % 7) }
  }
  let sorted = days.sorted()
  if sorted == [1, 2, 3, 4, 5] { return "Weekdays" }
  if sorted == [0, 6] { return "Weekends" }
  if sorted.count == 7 { return "Daily" }
  if sorted.count == 1 { return ctoDayPlural[sorted[0]] }
  return sorted.map { ctoDayShort[$0] }.joined(separator: ", ")
}

private func ctoClock(_ date: Date) -> String {
  date.formatted(date: .omitted, time: .shortened)
}

/// "3:40 PM" today, "Mon 9:00 AM" this week, "Nov 21" further out.
func ctoDescribeNext(_ iso: String?, now: Date) -> String? {
  guard let iso, let at = workParsedDate(iso) else { return nil }
  let minutes = Int((at.timeIntervalSince(now) / 60).rounded())
  if minutes <= 0 { return "now" }
  if minutes < 60 { return "in \(minutes) min" }
  let calendar = Calendar.current
  if calendar.isDate(at, inSameDayAs: now) { return ctoClock(at) }
  if at.timeIntervalSince(now) < 6 * 86_400 {
    return "\(ctoDayShort[calendar.component(.weekday, from: at) - 1]) \(ctoClock(at))"
  }
  return at.formatted(.dateTime.month(.abbreviated).day())
}

private func ctoDescribeAgo(_ iso: String?, now: Date) -> String? {
  guard let iso, let at = workParsedDate(iso) else { return nil }
  let minutes = Int((now.timeIntervalSince(at) / 60).rounded())
  if minutes < 1 { return "just now" }
  if minutes < 60 { return "\(minutes) min ago" }
  if minutes < 60 * 24 { return "\(Int((Double(minutes) / 60).rounded())) h ago" }
  return at.formatted(.dateTime.month(.abbreviated).day())
}

/// The one line under a routine's title: "Weekdays · next Mon 9:00 AM".
func ctoDescribeRoutineSchedule(_ item: AgentChatScheduledWorkItem, now: Date) -> String {
  if item.kind == "cron" || item.kind == "loop", let cron = item.cron?.trimmingCharacters(in: .whitespaces), !cron.isEmpty {
    let cadence = ctoCronCadence(cron)
    let next = ctoRoutineIsPending(item) ? ctoDescribeNext(item.nextRunAt, now: now) : nil
    return next.map { "\(cadence) · next \($0)" } ?? cadence
  }
  if item.status == "fired" || item.status == "completed" {
    return ctoDescribeAgo(item.lastRunAt, now: now).map { "Ran \($0)" } ?? "Ran"
  }
  if item.status == "cancelled" { return "Cancelled" }
  guard let next = ctoDescribeNext(item.nextRunAt, now: now) else { return "Scheduled" }
  if next == "now" { return "Now" }
  if next.hasPrefix("in ") { return "In " + String(next.dropFirst(3)) }
  return "Next \(next)"
}

/// "12 min ago", "3 h ago", "Nov 2".
func ctoRelativeDay(_ iso: String, now: Date = Date()) -> String {
  ctoDescribeAgo(iso, now: now) ?? ""
}

// MARK: - Store

@MainActor
final class CtoStore: ObservableObject {
  /// A file Settings › Memory edits whole: the two notes files, or the rules
  /// (`.ade/cto/RULES.md`).
  enum NotesScope: String { case project, user, rules }
  enum NotesSaveResult: Equatable { case saved, conflict, failed(String) }

  enum ArchiveFilter: String, CaseIterable, Identifiable {
    case all, note, fact, discovery, story
    var id: String { rawValue }
    var label: String {
      switch self {
      case .all: return "All"
      case .note: return "Notes"
      case .fact: return "Facts"
      case .discovery: return "Discoveries"
      case .story: return "Story"
      }
    }
    var kinds: [String] {
      switch self {
      case .all: return []
      case .fact: return ["fact", "decision"]
      default: return [rawValue]
      }
    }
  }

  @Published var memory: CtoMemory?
  @Published var memoryLoaded = false
  @Published var memoryError: String?
  /// Fixture only: the skills' whole SKILL.md, by name.
  private var fixtureSkillTexts: [String: String] = [:]
  /// The archive (desktop `CtoArchiveList`): what left the notes, facts, discoveries, story versions.
  @Published var archive: CtoArchivePage?
  @Published var archiveError: String?
  @Published var archiveQuery = ""
  @Published var archiveFilter: ArchiveFilter = .all
  @Published var archiveLoadingMore = false
  /// The filter and query `archive` answers: its cursor pages back only those.
  @Published private(set) var archivePageKey: String?
  var archiveRequestKey: String {
    "\(archiveFilter.rawValue)|\(archiveQuery.trimmingCharacters(in: .whitespacesAndNewlines))"
  }
  @Published var routines: [AgentChatScheduledWorkItem] = []
  @Published var routinesLoaded = false
  @Published var children: [CtoChildRow] = []
  @Published var library: [CtoLibraryItem] = []
  @Published var libraryLoaded = false
  /// The last thing that failed, in a few words.
  @Published var errorText: String?
  @Published var busyIds: Set<String> = []
  /// The CTO's identity (name, look, models, instructions).
  @Published var snapshot: CtoSnapshot?
  /// The live CTO chat: its model is the source of truth for "main model".
  @Published var ctoSession: AgentChatSessionSummary?
  /// Bumps on every successful settings write, for the quiet "Saved".
  @Published var savedTick = 0
  /// Chats the CTO started that need the person, oldest first
  /// (`cto.getNeeds`). Empty on an older brain.
  @Published var needs: [CtoNeed] = []
  /// The needs read failed and none has succeeded for this CTO yet: the card
  /// says it couldn't load, rather than showing nothing waiting.
  @Published var needsFailed = false

  let isFixture: Bool
  private var fixtureArchiveAll: CtoArchivePage?
  /// Drops an archive answer to an older query or filter.
  private var archiveGeneration = 0
  private(set) var sessionId: String?
  private(set) var homeMachineKey: String?
  private var needsTask: Task<Void, Never>?
  private var lastNeedsFetchAt: Date?
  private var needsLoaded = false
  /// Bumps when the CTO or its home changes: a read started before is dropped.
  private var needsGeneration = 0

  private var sync: SyncService? { isFixture ? nil : SyncService.shared }

  init() {
    isFixture = false
  }

  init(
    fixtureSnapshot: CtoSnapshot? = nil,
    fixtureMemory: CtoMemory?,
    fixtureSkillTexts: [String: String] = [:],
    fixtureArchive: CtoArchivePage? = nil,
    routines: [AgentChatScheduledWorkItem] = [],
    children: [CtoChildRow] = [],
    library: [CtoLibraryItem] = [],
    needs: [CtoNeed] = []
  ) {
    isFixture = true
    snapshot = fixtureSnapshot
    memory = fixtureMemory
    self.fixtureSkillTexts = fixtureSkillTexts
    fixtureArchiveAll = fixtureArchive
    archive = fixtureArchive
    memoryLoaded = true
    self.routines = routines
    routinesLoaded = true
    self.children = children
    self.library = library
    libraryLoaded = true
    self.needs = needs
    sessionId = "fixture-cto"
  }

  func bind(sessionId: String?, homeMachineKey: String?) {
    let changed = sessionId != self.sessionId || homeMachineKey != self.homeMachineKey
    self.sessionId = sessionId
    self.homeMachineKey = homeMachineKey
    // Another CTO or home: the old home's lines are not this one's.
    if changed, !isFixture {
      needsGeneration += 1
      needsTask = nil
      lastNeedsFetchAt = nil
      needsLoaded = false
      if !needs.isEmpty { needs = [] }
      if needsFailed { needsFailed = false }
      // The old home's archive too; the list reads the new one (its task id names the binding).
      archiveGeneration += 1
      archive = nil
      archiveError = nil
      archivePageKey = nil
    }
  }

  // MARK: Capabilities (an older host hides the control)

  /// CTO calls go to the CTO's home machine, so ask that machine (not the
  /// focused one) whether it runs them. Unknown while it is offline: hidden.
  private func homeSupports(_ action: String) -> Bool {
    isFixture || sync?.ctoHomeSupportsAction(action) == true
  }

  var canEditNotes: Bool { homeSupports("cto.updateNotes") }
  var canEditOpenWork: Bool { homeSupports("cto.updateOpenWork") }
  var canRefreshContext: Bool { homeSupports("cto.refreshContext") }
  /// Skills need all three calls; an older host lists none of them.
  var canEditSkills: Bool { homeSupports("cto.getSkill") && homeSupports("cto.writeSkill") }
  var canDeleteSkills: Bool { homeSupports("cto.deleteSkill") }
  var canReadArchive: Bool { homeSupports("cto.searchMemoryArchive") }
  var canRecallArchive: Bool { homeSupports("cto.recallArchivedNote") }

  private func supportsRoutineAction(_ action: String) -> Bool {
    if isFixture { return true }
    guard let sessionId, let sync else { return false }
    return sync.supportsChatRemoteAction(action, sessionId: sessionId)
  }

  var canListRoutines: Bool { supportsRoutineAction("chat.listScheduledWork") }
  var canPauseRoutines: Bool { supportsRoutineAction("chat.setScheduledWorkItemPaused") }
  var canRunRoutines: Bool { supportsRoutineAction("chat.runScheduledWorkNow") }
  var canCancelRoutines: Bool { supportsRoutineAction("chat.cancelScheduledWork") }

  var upcomingRoutines: [AgentChatScheduledWorkItem] {
    routines.filter(ctoRoutineIsPending).sorted { ($0.nextRunAt ?? "~") < ($1.nextRunAt ?? "~") }
  }

  var finishedRoutines: [AgentChatScheduledWorkItem] {
    routines.filter { !ctoRoutineIsPending($0) && $0.status != "cancelled" }
      .sorted { ($0.lastRunAt ?? $0.createdAt) > ($1.lastRunAt ?? $1.createdAt) }
  }

  // MARK: Reads

  func loadAll(includeFinishedRoutines: Bool = false) async {
    await loadMemory()
    await loadRoutines(includeTerminal: includeFinishedRoutines)
    await loadChildren()
  }

  /// False when the read failed (the old memory stays).
  @discardableResult
  func loadMemory() async -> Bool {
    guard let sync else { return false }
    defer { memoryLoaded = true }
    do {
      memory = try await sync.fetchCtoMemory()
      memoryError = nil
      return true
    } catch {
      memoryError = ctoShortError(error, fallback: "Couldn't read notes")
      return false
    }
  }

  func loadRoutines(includeTerminal: Bool = false) async {
    guard let sync, let sessionId else {
      routinesLoaded = true
      return
    }
    guard canListRoutines else {
      routinesLoaded = true
      return
    }
    do {
      let items = try await sync.listScheduledWork(sessionId: sessionId, includeTerminal: includeTerminal)
      routines = items.filter { $0.sessionId == sessionId }
    } catch {
      errorText = ctoShortError(error, fallback: "Couldn't read routines")
    }
    routinesLoaded = true
  }

  /// The chats the CTO started and what they produced, from the replicated
  /// Work data. Rows open on the CTO's home machine.
  func loadChildren() async {
    guard let sync else { return }
    let projection = await sync.fetchWorkListProjection()
    var sessions = projection.sessions
    var lanes = projection.lanes
    var pullRequests = projection.pullRequests
    // A home on another machine: its own roster, not this machine's copy, and
    // only the PRs it says are on its lanes. Not connected: keep what shows.
    let home: (projectId: String?, rootPath: String?, repo: WorkRemoteMachineRepo?)
    do { home = try sync.ctoCommandTarget() } catch { return }
    if let repo = home.repo {
      let merge = workMergeRemoteMachineRows(sessions: [], lanes: [], remote: [repo])
      sessions = merge.sessions
      lanes = merge.lanes
      let remoteRows = (try? await sync.fetchRemotePullRequestRows(repo: repo, timeoutNanoseconds: 8_000_000_000)) ?? []
      let onHomeLanes = Dictionary(
        remoteRows.compactMap { row -> (String, String)? in
          guard let laneId = row.laneId else { return nil }
          return ("\(row.repoOwner.lowercased())/\(row.repoName.lowercased())#\(row.githubPrNumber)", workRemoteLaneId(machineKey: repo.machineKey, laneId: laneId))
        },
        uniquingKeysWith: { first, _ in first }
      )
      pullRequests = projection.pullRequests.compactMap { pr in
        guard let laneId = onHomeLanes["\(pr.repoOwner.lowercased())/\(pr.repoName.lowercased())#\(pr.githubPrNumber)"] else { return nil }
        var onHome = pr
        onHome.laneId = laneId
        return onHome
      }
    }
    let ctoSessionId = sessionId
    let mine = sessions
      .filter { session in
        guard session.archivedAt == nil, session.id != ctoSessionId else { return false }
        return session.isCtoChild || (ctoSessionId != nil && session.orchestrationParentSessionId == ctoSessionId)
      }
      .sorted { $0.startedAt > $1.startedAt }
    children = mine.map { session in
      let state = session.runtimeState.lowercased()
      // A home's roster row says "waiting on you" in `status` while its
      // runtime reads running.
      let waiting = state == "waiting-input" || session.status.lowercased() == "awaiting-input"
      let status: CtoChildRow.Status = session.endedAt != nil ? .idle
        : waiting ? .needsYou
        : state == "running" ? .working
        : .idle
      let title = session.title.trimmingCharacters(in: .whitespacesAndNewlines)
      return CtoChildRow(
        id: session.id,
        laneId: session.laneId,
        title: title.isEmpty ? "Untitled chat" : title,
        laneName: session.laneName.isEmpty ? nil : session.laneName,
        provider: session.toolType,
        status: status,
        startedAt: session.startedAt
      )
    }
    let lanesById = Dictionary(lanes.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    let childLaneIds = Set(mine.map(\.laneId))
    var items: [CtoLibraryItem] = []
    for pr in pullRequests where childLaneIds.contains(pr.laneId) {
      let laneName = pr.laneName ?? lanesById[pr.laneId]?.name
      items.append(CtoLibraryItem(
        id: "pr:\(pr.id)",
        kind: .prs,
        title: pr.title.isEmpty ? "PR #\(pr.githubPrNumber)" : pr.title,
        detail: ["#\(pr.githubPrNumber)", laneName].compactMap { $0 }.joined(separator: " · "),
        at: pr.updatedAt,
        prState: pr.state.lowercased(),
        prId: pr.id,
        prNumber: pr.githubPrNumber,
        laneId: pr.laneId,
        sessionId: nil
      ))
    }
    var byLane: [String: [TerminalSessionSummary]] = [:]
    for session in mine {
      if lanesById[session.laneId]?.laneType == "primary" { continue }
      byLane[session.laneId, default: []].append(session)
    }
    for (laneId, sessions) in byLane {
      guard let newest = sessions.first else { continue }
      let lane = lanesById[laneId]
      let branch = lane?.branchRef.replacingOccurrences(of: "refs/heads/", with: "")
      let count = sessions.count
      items.append(CtoLibraryItem(
        id: "lane:\(laneId)",
        kind: .lanes,
        title: lane?.name ?? newest.laneName,
        detail: ["\(count) \(count == 1 ? "chat" : "chats")", branch].compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: " · "),
        at: newest.lastActivityAt ?? newest.startedAt,
        prState: nil,
        prId: nil,
        prNumber: nil,
        laneId: laneId,
        sessionId: newest.id
      ))
    }
    library = items.sorted { $0.at > $1.at }
    libraryLoaded = true
  }

  /// Reads what the CTO's children need from the person. Coalesced: one read
  /// at a time, and at most one every few seconds unless `force`. A failure
  /// keeps the last answer; an older brain clears it and shows no card.
  func loadNeeds(force: Bool = false) async {
    guard let sync else { return }
    // Asked of the CTO's home machine, which answers the read; unknown while
    // that machine is away, so the last answer stays.
    switch sync.ctoHomeSupportsAction("cto.getNeeds") {
    case .none: return
    case .some(false):
      if !needs.isEmpty { needs = [] }
      if needsFailed { needsFailed = false }
      return
    case .some(true): break
    }
    if let joined = needsTask {
      await joined.value
      // A forced read wants an answer from after its cause (a turn that just
      // ended); the read it joined may have started before that. A newer read
      // another caller started since is fresh enough.
      guard force else { return }
      if let newer = needsTask, newer != joined {
        await newer.value
        return
      }
    }
    if !force, let last = lastNeedsFetchAt, Date().timeIntervalSince(last) < 5 { return }
    lastNeedsFetchAt = Date()
    let generation = needsGeneration
    let task = Task { @MainActor [weak self] in
      guard let self else { return }
      let next = try? await sync.fetchCtoNeeds()
      // Started for another CTO or home: drop it.
      guard generation == self.needsGeneration else { return }
      guard let next else {
        // Known lines stay on a failed read; only a card that never loaded says so.
        if !self.needsLoaded, !self.needsFailed { self.needsFailed = true }
        return
      }
      self.needsLoaded = true
      if self.needsFailed { self.needsFailed = false }
      // Published only when the answer changed.
      if next.needs != self.needs { self.needs = next.needs }
    }
    needsTask = task
    await task.value
    if needsTask == task { needsTask = nil }
  }

  /// Opens the child chat a need is about, the way the profile's child rows
  /// do: on the CTO's home machine.
  func openNeed(_ need: CtoNeed) {
    guard let sync else { return }
    var laneId = need.laneId
    // A home on another machine lists its lanes under namespaced ids, which
    // is what the profile's child rows carry.
    if let raw = laneId, !isWorkRemoteLaneId(raw), let repo = try? sync.ctoCommandTarget().repo {
      laneId = workRemoteLaneId(machineKey: repo.machineKey, laneId: raw)
    }
    openChat(need.childSessionId, laneId: laneId)
  }

  // MARK: Routines

  func setPaused(_ item: AgentChatScheduledWorkItem, paused: Bool) async {
    // Flip at once; the reload confirms or reverts it.
    if let index = routines.firstIndex(where: { $0.id == item.id }) {
      routines[index].paused = paused
      if isFixture { routines[index].status = paused ? "paused" : "scheduled" }
    }
    guard let sync, let sessionId else { return }
    busyIds.insert(item.id)
    defer { busyIds.remove(item.id) }
    do {
      try await sync.setScheduledWorkItemPaused(sessionId: sessionId, scheduleId: item.id, paused: paused)
      ADEHaptics.light()
    } catch {
      errorText = paused ? "Couldn't turn it off" : "Couldn't turn it on"
      ADEHaptics.error()
    }
    await loadRoutines()
  }

  func runNow(_ item: AgentChatScheduledWorkItem) async {
    guard let sync, let sessionId else { ADEHaptics.light(); return }
    busyIds.insert(item.id)
    defer { busyIds.remove(item.id) }
    do {
      let result = try await sync.runScheduledWorkNow(sessionId: sessionId, scheduleId: item.id)
      if result.fired == false {
        errorText = result.reason.map { ctoClipWords($0, max: 40) } ?? "Didn't run"
      } else {
        ADEHaptics.light()
      }
    } catch {
      errorText = "Couldn't run it"
      ADEHaptics.error()
    }
    await loadRoutines()
  }

  func cancel(_ item: AgentChatScheduledWorkItem) async {
    guard let sync, let sessionId else {
      routines.removeAll { $0.id == item.id }
      return
    }
    busyIds.insert(item.id)
    defer { busyIds.remove(item.id) }
    do {
      _ = try await sync.cancelScheduledWork(sessionId: sessionId, scheduleId: item.id)
      ADEHaptics.light()
    } catch {
      errorText = "Couldn't cancel it"
      ADEHaptics.error()
    }
    await loadRoutines()
  }

  // MARK: Open work

  @discardableResult
  func addOpenWork(_ text: String) async -> Bool {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return false }
    if isFixture {
      var items = memory?.openWork ?? []
      items.insert(CtoOpenWorkItem(id: UUID().uuidString, text: trimmed, createdAt: nil, doneAt: nil, addedBy: "user"), at: 0)
      memory?.openWork = items
      return true
    }
    return await writeOpenWork(key: "__add__") { try await $0.updateCtoOpenWork(op: "add", text: trimmed) }
  }

  func toggleOpenWork(_ item: CtoOpenWorkItem) async {
    if isFixture {
      guard var items = memory?.openWork, let index = items.firstIndex(where: { $0.id == item.id }) else { return }
      items[index].doneAt = item.isDone ? nil : "2026-11-14T09:00:00Z"
      memory?.openWork = items
      return
    }
    await writeOpenWork(key: item.id) { try await $0.updateCtoOpenWork(op: item.isDone ? "reopen" : "complete", id: item.id) }
  }

  func removeOpenWork(_ item: CtoOpenWorkItem) async {
    if isFixture {
      memory?.openWork?.removeAll { $0.id == item.id }
      return
    }
    await writeOpenWork(key: item.id) { try await $0.updateCtoOpenWork(op: "remove", id: item.id) }
  }

  @discardableResult
  private func writeOpenWork(key: String, _ run: (SyncService) async throws -> CtoMemory) async -> Bool {
    guard let sync else { return false }
    busyIds.insert(key)
    defer { busyIds.remove(key) }
    do {
      memory = try await run(sync)
      ADEHaptics.light()
      return true
    } catch {
      errorText = "Couldn't update open work"
      ADEHaptics.error()
      return false
    }
  }

  // MARK: Archive

  /// Reads the archive for the current query and filter; `more` pages back.
  func loadArchive(more: Bool = false) async {
    let query = archiveQuery.trimmingCharacters(in: .whitespacesAndNewlines)
    let kinds = archiveFilter.kinds
    let key = archiveRequestKey
    if more && archivePageKey != key { return }
    if isFixture {
      let all = fixtureArchiveAll?.entries ?? []
      let words = query.lowercased().split(separator: " ").map(String.init)
      let entries = all.filter { entry in
        (kinds.isEmpty || kinds.contains(entry.kind))
          && words.allSatisfy { entry.text.lowercased().contains($0) }
      }
      archive = CtoArchivePage(available: true, mode: query.isEmpty ? "recent" : "keyword", entries: entries, counts: fixtureArchiveAll?.counts)
      archivePageKey = key
      return
    }
    guard let sync, canReadArchive else { return }
    let before = more ? archive?.nextBefore : nil
    if more && before == nil { return }
    if !more { archiveGeneration += 1 }
    let generation = archiveGeneration
    if more { archiveLoadingMore = true }
    defer { if more { archiveLoadingMore = false } }
    do {
      let page = try await sync.searchCtoMemoryArchive(query: query, kinds: kinds, before: before)
      guard generation == archiveGeneration else { return }
      if more, var current = archive {
        current.entries += page.entries
        current.nextBefore = page.nextBefore
        current.counts = page.counts ?? current.counts
        archive = current
      } else {
        archive = page
        archivePageKey = key
      }
      archiveError = nil
    } catch {
      guard generation == archiveGeneration else { return }
      archiveError = ctoShortError(error, fallback: "Couldn't read the archive")
    }
  }

  /// A story version in full (lists show a preview).
  func fullArchiveText(_ entry: CtoArchiveEntry) async -> String {
    guard entry.truncated == true, !isFixture, let sync else { return entry.text }
    let page = try? await sync.searchCtoMemoryArchive(id: entry.id)
    return page?.entries.first?.text ?? entry.text
  }

  /// Pins an archived entry as a note again; the notes and the list both re-read.
  func recallArchived(_ entry: CtoArchiveEntry) async {
    let key = "archive:\(entry.id)"
    if isFixture {
      fixtureArchiveAll?.entries.removeAll { $0.id == entry.id }
      memory?.memory += "\n- \(entry.text)"
      await loadArchive()
      return
    }
    guard let sync else { return }
    busyIds.insert(key)
    defer { busyIds.remove(key) }
    do {
      memory = try await sync.recallCtoArchivedNote(id: entry.id)
      ADEHaptics.light()
      await loadArchive()
    } catch {
      archiveError = ctoShortError(error, fallback: "Couldn't pin it")
      ADEHaptics.error()
    }
  }

  // MARK: Notes

  func saveNotes(_ scope: NotesScope, text: String, baseHash: String?) async -> NotesSaveResult {
    if isFixture {
      switch scope {
      case .project: memory?.memory = text
      case .user: memory?.userNotes = text
      case .rules: memory?.rules = text
      }
      return .saved
    }
    guard let sync else { return .failed("Not connected") }
    do {
      memory = try await sync.updateCtoNotes(scope: scope.rawValue, text: text, baseHash: baseHash)
      return .saved
    } catch {
      let message = (error as NSError).localizedDescription
      if message.contains(ctoNotesChangedError) { return .conflict }
      return .failed(ctoShortError(error, fallback: "Couldn't save"))
    }
  }

  // MARK: Skills

  /// The whole SKILL.md, or nil when it is gone. Throws on a failed read.
  func loadSkill(_ name: String) async throws -> CtoSkillFile? {
    if isFixture {
      guard let text = fixtureSkillTexts[name] else { return nil }
      let description = memory?.skills?.first { $0.name == name }?.description ?? ""
      return CtoSkillFile(name: name, description: description, text: text, hash: "fixture-\(text.hashValue)")
    }
    guard let sync else { return nil }
    return try await sync.fetchCtoSkill(name: name)
  }

  /// The skill exactly as the last save wrote it, by name (its committed hash).
  private(set) var writtenSkills: [String: CtoSkillFile] = [:]

  /// Writes a whole SKILL.md; `.conflict` when it changed since `baseHash`.
  func saveSkill(_ name: String, text: String, baseHash: String?) async -> NotesSaveResult {
    if isFixture {
      fixtureSkillTexts[name] = text
      if memory?.skills?.contains(where: { $0.name == name }) != true {
        memory?.skills = (memory?.skills ?? []) + [CtoSkillSummary(name: name, description: ctoSkillDescription(text) ?? "")]
      } else if let description = ctoSkillDescription(text), let index = memory?.skills?.firstIndex(where: { $0.name == name }) {
        memory?.skills?[index].description = description
      }
      return .saved
    }
    guard let sync else { return .failed("Not connected") }
    do {
      let written = try await sync.writeCtoSkill(name: name, text: text, baseHash: baseHash)
      memory = written.memory
      writtenSkills[name] = written.skill
      return .saved
    } catch {
      let message = (error as NSError).localizedDescription
      if message.contains(ctoNotesChangedError) { return .conflict }
      return .failed(ctoShortError(error, fallback: "Couldn't save"))
    }
  }

  @discardableResult
  func deleteSkill(_ name: String) async -> Bool {
    if isFixture {
      fixtureSkillTexts[name] = nil
      memory?.skills?.removeAll { $0.name == name }
      return true
    }
    guard let sync else { return false }
    busyIds.insert("skill:\(name)")
    defer { busyIds.remove("skill:\(name)") }
    do {
      memory = try await sync.deleteCtoSkill(name: name)
      ADEHaptics.light()
      return true
    } catch {
      errorText = ctoShortError(error, fallback: "Couldn't delete the skill")
      ADEHaptics.error()
      return false
    }
  }

  // MARK: Identity

  var identity: CtoIdentity? { snapshot?.identity }
  var look: CtoAvatarLook? { snapshot?.identity.avatar }
  var name: String {
    let value = snapshot?.identity.name.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return value.isEmpty ? "CTO" : value
  }

  /// Writes one identity change. The look and the name show at once; the
  /// host's answer replaces them.
  @discardableResult
  func updateIdentity(_ patch: CtoIdentityPatch) async -> Bool {
    if var identity = snapshot?.identity {
      if let avatar = patch.avatar { identity.avatar = avatar }
      if let name = patch.name { identity.name = name }
      if let personality = patch.personality { identity.personality = personality }
      if let fallbacks = patch.fallbackModels { identity.fallbackModels = fallbacks }
      if let instructions = patch.systemPromptExtension { identity.systemPromptExtension = instructions }
      if let preferences = patch.modelPreferences { identity.modelPreferences = preferences }
      snapshot?.identity = identity
    }
    guard let sync else {
      savedTick += 1
      return true
    }
    do {
      snapshot = try await sync.updateCtoIdentity(patch: patch)
      savedTick += 1
      return true
    } catch {
      errorText = ctoShortError(error, fallback: "Couldn't save")
      ADEHaptics.error()
      return false
    }
  }

  func reloadIdentity() async {
    guard let sync else { return }
    if let next = try? await sync.fetchCtoState() { snapshot = next }
  }

  // MARK: Context

  /// "Refreshed", or why not in a few words.
  func refreshContext() async -> String {
    guard let sync else { return "Refreshed" }
    do {
      let result = try await sync.refreshCtoContext()
      if result.refreshed { return "Refreshed" }
      return result.reason.map { ctoClipWords($0, max: 36) } ?? "After this turn"
    } catch {
      return ctoShortError(error, fallback: "Couldn't refresh")
    }
  }

  // MARK: Navigation (on the CTO's home machine)

  func openChat(_ sessionId: String, laneId: String?) {
    guard let sync else { return }
    sync.requestedWorkSessionNavigation = WorkSessionNavigationRequest(
      sessionId: sessionId,
      laneId: laneId,
      accountMachineKey: homeMachineKey,
      origin: .inApp
    )
  }

  func openPullRequest(_ item: CtoLibraryItem) {
    guard let sync, let prId = item.prId else { return }
    sync.requestedPrNavigation = PrNavigationRequest(
      prId: prId,
      prNumber: item.prNumber,
      laneId: item.laneId,
      accountMachineKey: homeMachineKey
    )
  }
}

/// An error in at most a short line: the host's words, clipped.
func ctoShortError(_ error: Error, fallback: String) -> String {
  let message = (error as? LocalizedError)?.errorDescription ?? (error as NSError).localizedDescription
  let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
  return trimmed.isEmpty ? fallback : ctoClipWords(trimmed, max: 48)
}

/// A new skill's starting SKILL.md (desktop `newSkillText`).
func ctoNewSkillText(_ name: String) -> String {
  "---\nname: \(name)\ndescription: When to use this skill, in one line\n---\n\n1. First step\n2. Check that it worked\n"
}

/// A typed skill name as the host stores it: lower case, runs of anything
/// else turned into single dashes, at most 48 characters (desktop `ctoSkillSlug`).
func ctoSkillSlug(_ raw: String) -> String {
  var slug = ""
  var pendingDash = false
  for scalar in raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased().unicodeScalars {
    if ("a"..."z").contains(scalar) || ("0"..."9").contains(scalar) {
      if pendingDash, !slug.isEmpty { slug.append("-") }
      pendingDash = false
      slug.unicodeScalars.append(scalar)
    } else {
      pendingDash = true
    }
  }
  var capped = String(slug.prefix(ctoSkillNameMaxChars))
  while capped.hasSuffix("-") { capped.removeLast() }
  return capped
}

/// The host's cap on a skill's folder name (`CTO_SKILL_NAME_MAX_CHARS`).
let ctoSkillNameMaxChars = 48

/// The `description:` line of a SKILL.md's frontmatter, if it has one.
func ctoSkillDescription(_ text: String) -> String? {
  let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
  guard lines.first?.trimmingCharacters(in: .whitespaces) == "---" else { return nil }
  for line in lines.dropFirst() {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    if trimmed == "---" { break }
    if trimmed.hasPrefix("description:") {
      let value = trimmed.dropFirst("description:".count).trimmingCharacters(in: .whitespaces)
      return value.isEmpty ? nil : value
    }
  }
  return nil
}
