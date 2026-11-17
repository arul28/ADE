import Foundation
import OSLog
import UIKit

private let machineUpdateLog = Logger(subsystem: "com.ade.ios", category: "MachineUpdates")

// "Update & restart" for the user's computers, from the phone. The phone's
// twin of the desktop's `machineUpdates.ts`: one store, so an update started
// from the Machines list reads the same on the machine's page and on General,
// and is not forgotten when a page closes.
//
// The computer does the work. The phone sends `machine.updateAndRestart`
// (the same run the desktop's button starts) over the link it already has to
// that machine: the focused machine's main connection, or the machine's
// roster connection. The phone only knows which build is newest on each track,
// read from the same release manifests the desktop reads.

let machineUpdateImpactRemoteAction = "machine.updateImpact"
let machineUpdateAndRestartRemoteAction = "machine.updateAndRestart"

// MARK: - What an update stops

/// What a restart of one machine's ADE stops, as that machine answers
/// `machine.updateImpact` (the desktop's `UpdateImpact`).
struct MachineUpdateImpact: Equatable {
  struct Chat: Equatable, Identifiable {
    let id: String
    let title: String
    let projectName: String
    /// False for a chat ADE cannot queue to continue (a personal chat).
    let resumable: Bool
    /// The chat waits for the user's answer, so it does not continue by itself.
    let awaitingUser: Bool
  }

  /// False when the machine did not answer, so the rest is unknown.
  var checked: Bool
  var chats: [Chat]
  var cliSessions: Int
  var terminals: Int
  var continueAfterRestart: Bool?
  var cliSessionsReopen: Bool

  static let unknown = MachineUpdateImpact(checked: false, chats: [], cliSessions: 0, terminals: 0, continueAfterRestart: nil, cliSessionsReopen: false)

  init(checked: Bool, chats: [Chat], cliSessions: Int, terminals: Int, continueAfterRestart: Bool?, cliSessionsReopen: Bool) {
    self.checked = checked
    self.chats = chats
    self.cliSessions = cliSessions
    self.terminals = terminals
    self.continueAfterRestart = continueAfterRestart
    self.cliSessionsReopen = cliSessionsReopen
  }

  init?(json: Any) {
    guard let record = json as? [String: Any], let rawChats = record["chats"] as? [Any] else { return nil }
    chats = rawChats.compactMap { raw in
      guard let chat = raw as? [String: Any], let id = nonEmptyTrimmed(chat["sessionId"] as? String) else { return nil }
      return Chat(
        id: id,
        title: nonEmptyTrimmed(chat["title"] as? String) ?? "Untitled chat",
        projectName: (chat["projectName"] as? String) ?? "",
        resumable: (chat["resumable"] as? Bool) != false,
        awaitingUser: (chat["continueHold"] as? String) == "awaiting_user"
      )
    }
    checked = true
    cliSessions = max(0, (record["cliSessions"] as? NSNumber)?.intValue ?? 0)
    terminals = max(0, (record["terminals"] as? NSNumber)?.intValue ?? 0)
    continueAfterRestart = record["continueAfterRestart"] as? Bool
    cliSessionsReopen = (record["cliSessionsReopen"] as? Bool) == true
  }

  private static func counted(_ count: Int, _ one: String, _ many: String) -> String {
    "\(count) \(count == 1 ? one : many)"
  }

  /// One line for what a restart stops ("2 agent chats running, 1 terminal open").
  var headline: String {
    guard checked else { return "Couldn’t check what’s running" }
    var openParts: [String] = []
    if cliSessions > 0 { openParts.append(Self.counted(cliSessions, "CLI session", "CLI sessions")) }
    if terminals > 0 { openParts.append(Self.counted(terminals, "terminal", "terminals")) }
    let running = chats.isEmpty ? nil : Self.counted(chats.count, "agent chat", "agent chats")
    let open = openParts.isEmpty ? nil : openParts.joined(separator: " and ")
    switch (running, open) {
    case (nil, nil): return "Nothing is running"
    case let (running?, open?): return "\(running) running, \(open) open"
    case let (running?, nil): return "\(running) \(chats.count == 1 ? "is" : "are") running"
    case let (nil, open?): return "\(open) \(cliSessions + terminals == 1 ? "is" : "are") open"
    }
  }

  var isBusy: Bool { !checked || !chats.isEmpty || cliSessions + terminals > 0 }

  /// The quiet line for what a restart ends for good, or what can't be known.
  var note: String? {
    guard checked else { return "Anything running there stops when ADE restarts." }
    guard cliSessions + terminals > 0 else { return nil }
    let cliReopen = cliSessions > 0 && cliSessionsReopen && continueAfterRestart != false
    // Name only what is open: CLI sessions, terminals, or both.
    let cliClose = cliSessions > 0 && !cliReopen
    let terminalsClose = terminals > 0
    let closeLine: String?
    switch (cliClose, terminalsClose) {
    case (true, true): closeLine = "CLI sessions and terminals close and don’t reopen."
    case (true, false): closeLine = "CLI sessions close and don’t reopen."
    case (false, true): closeLine = "Terminals close and don’t reopen."
    case (false, false): closeLine = nil
    }
    return [cliReopen ? "CLI sessions reopen after the update." : nil, closeLine].compactMap { $0 }.joined(separator: " ")
  }

  /// The machine's "Continue chats after restarts", when it said, or the
  /// usual outcome when chats are running and it is too old to say.
  var continueLine: String? {
    if let continueAfterRestart {
      return continueAfterRestart ? "Chats continue after the update" : "Chats stop — Continue chats after restarts is off"
    }
    return chats.contains(where: \.resumable) ? "Chats usually continue after the update" : nil
  }
}

// MARK: - One machine's update

/// A machine to update and the version it is sent: the newest the phone knows
/// on that machine's own track.
struct MachineUpdateTarget: Identifiable, Equatable {
  /// The fleet key (`machine:<device id>`).
  let id: String
  let name: String
  let symbol: String
  let version: String?
  let targetVersion: String
  var runsBeta: Bool { adeVersionIsBetaTrack(version) }
}

/// One step the machine reported ("check", "apply", "restart").
struct MachineUpdateStep: Equatable, Identifiable {
  let id: String
  let status: String
  let detail: String

  var label: String {
    switch id {
    case "check": return "Check"
    case "apply": return "Install"
    case "restart": return "Restart"
    default: return id.capitalized
    }
  }
}

/// What the last "Update & restart" left behind for one machine. The reply is
/// not the outcome: an update still in flight (`pendingVersion`) is done only
/// when the machine comes back reporting that version.
struct MachineUpdateAttempt: Equatable {
  var ok: Bool
  var message: String
  var pendingVersion: String?
  /// The machine's app is still downloading, which takes longer to land.
  var downloading: Bool
  var startedAt: Date
  var steps: [MachineUpdateStep] = []
  /// A Linux package the person installs by hand there.
  var manualDownloadURL: URL?

  /// An app swap plus the brain restart behind it; a download first takes longer.
  var grace: TimeInterval { downloading ? 35 * 60 : 5 * 60 }

  static func fromResult(_ raw: Any, name: String, now: Date) -> MachineUpdateAttempt {
    let record = raw as? [String: Any] ?? [:]
    let ok = (record["ok"] as? Bool) == true
    let message = nonEmptyTrimmed(record["message"] as? String) ?? (ok ? "\(name) updated — reconnecting…" : "The update didn’t start.")
    let updateApplied = record["updateApplied"] as? Bool
    let pendingVersion: String?
    if !ok {
      pendingVersion = nil
    } else if record.keys.contains("pendingVersion") {
      pendingVersion = nonEmptyTrimmed(record["pendingVersion"] as? String)
    } else {
      pendingVersion = updateApplied == true ? nonEmptyTrimmed(record["targetVersion"] as? String) : nil
    }
    let route = record["route"] as? String
    let steps = (record["steps"] as? [Any] ?? []).compactMap { raw -> MachineUpdateStep? in
      guard let step = raw as? [String: Any], let id = nonEmptyTrimmed(step["id"] as? String) else { return nil }
      return MachineUpdateStep(id: id, status: (step["status"] as? String) ?? "pending", detail: (step["detail"] as? String) ?? "")
    }
    let manualURL = (record["updateInstallMode"] as? String) == "manual_download"
      ? nonEmptyTrimmed(record["downloadUrl"] as? String).flatMap(URL.init(string:))
      : nil
    return MachineUpdateAttempt(
      ok: ok,
      message: message,
      pendingVersion: pendingVersion,
      downloading: ok && (route == "desktop_app" || route == "terminal") && updateApplied == false && pendingVersion != nil,
      startedAt: now,
      steps: steps,
      manualDownloadURL: manualURL
    )
  }

  static func failed(_ message: String, now: Date) -> MachineUpdateAttempt {
    MachineUpdateAttempt(ok: false, message: message, pendingVersion: nil, downloading: false, startedAt: now)
  }
}

/// Where an attempt is now, against the machine as the phone sees it.
struct MachineUpdateStatus: Equatable {
  let ok: Bool
  let message: String
  /// Sent and not back on the new version yet, inside the wait.
  let inFlight: Bool
}

func describeMachineUpdateAttempt(_ attempt: MachineUpdateAttempt, live: Bool, version: String?, now: Date) -> MachineUpdateStatus {
  guard let pending = attempt.pendingVersion else {
    return MachineUpdateStatus(ok: attempt.ok, message: attempt.message, inFlight: false)
  }
  if live, let version = nonEmptyTrimmed(version), compareAdeVersions(version, pending) >= 0 {
    return MachineUpdateStatus(ok: true, message: "Updated to \(version).", inFlight: false)
  }
  if now.timeIntervalSince(attempt.startedAt) < attempt.grace {
    return MachineUpdateStatus(ok: true, message: attempt.message, inFlight: true)
  }
  if live {
    return MachineUpdateStatus(
      ok: false,
      message: "Still on \(version ?? "an older version") — the update to \(pending) didn’t install on that machine. Tap Update to try again.",
      inFlight: false
    )
  }
  return MachineUpdateStatus(
    ok: false,
    message: "Not back yet after the update to \(pending). Check that ADE is running on that machine.",
    inFlight: false
  )
}

/// The question before an update: each machine and what it would stop.
struct MachineUpdateConfirmation: Identifiable {
  struct Row: Identifiable {
    let target: MachineUpdateTarget
    let impact: MachineUpdateImpact
    var id: String { target.id }
  }

  let id = UUID()
  /// The surface that asked, so only that one presents the sheet.
  let origin: String
  let rows: [Row]

  var title: String {
    if rows.count == 1, let row = rows.first { return "Update \(row.target.name) to \(row.target.targetVersion)?" }
    return "Update \(rows.count) machines?"
  }

  var confirmLabel: String { rows.count == 1 ? "Update & restart" : "Update all" }
}

// MARK: - Store

@MainActor
final class MachineUpdateStore: ObservableObject {
  static let shared = MachineUpdateStore()

  /// The newest published build on each track; nil until read.
  @Published private(set) var latestStable: String?
  @Published private(set) var latestBeta: String?
  /// Machines being asked what an update would stop, before the confirmation.
  @Published private(set) var checkingKeys: Set<String> = []
  /// Machines whose `machine.updateAndRestart` call is in flight.
  @Published private(set) var updatingKeys: Set<String> = []
  @Published private(set) var attempts: [String: MachineUpdateAttempt] = [:]
  @Published var confirmation: MachineUpdateConfirmation?
  /// Moves when an in-flight update's wait ends, so its row re-reads it.
  @Published private(set) var clock = Date()

  private weak var syncService: SyncService?
  private weak var fleet: MachineFleet?
  private var lastManifestRead: Date?
  private var manifestRead: Task<Void, Never>?
  private var clockTask: Task<Void, Never>?
  private let session: URLSession

  static let stableManifestURL = URL(string: "https://github.com/arul28/ADE/releases/latest/download/release-manifest.json")!
  static let betaManifestURL = URL(string: "https://github.com/arul28/ADE/releases/download/beta-feed/beta.json")!
  /// Settings opening again within this reuses the last read.
  private static let manifestReuseInterval: TimeInterval = 10 * 60
  /// Downloading and installing a build can take minutes (the desktop's
  /// `REMOTE_MACHINE_UPDATE_TIMEOUT_MS`).
  private static let updateTimeoutNanoseconds: UInt64 = 15 * 60 * 1_000_000_000
  private static let impactTimeoutNanoseconds: UInt64 = 5 * 1_000_000_000

  init(session: URLSession = .shared) {
    self.session = session
  }

  func bind(syncService: SyncService, fleet: MachineFleet) {
    self.syncService = syncService
    self.fleet = fleet
  }

  #if DEBUG
  /// Fixture screens (`-adePreviewScreen settings-machine-updates…`): fixed
  /// newest builds, every live machine askable, fixed answers for what a
  /// restart stops, and an update that never leaves the phone.
  struct Fixture {
    var latestStable: String
    var latestBeta: String
    var impacts: [String: MachineUpdateImpact]
  }

  private var fixture: Fixture?

  func useFixture(_ fixture: Fixture) {
    self.fixture = fixture
    latestStable = fixture.latestStable
    latestBeta = fixture.latestBeta
    lastManifestRead = Date()
  }
  #endif

  // MARK: Newest builds

  /// Reads both tracks' manifests unless a read finished in the last ten
  /// minutes. Called when a surface that shows updates opens, never on a timer.
  /// A failed read keeps what the track had.
  func refreshLatestBuilds(force: Bool = false) async {
    #if DEBUG
    if fixture != nil { return }
    #endif
    if let manifestRead {
      await manifestRead.value
      return
    }
    if !force, let lastManifestRead, Date().timeIntervalSince(lastManifestRead) < Self.manifestReuseInterval { return }
    let task = Task { @MainActor [weak self] in
      guard let self else { return }
      // The account server's answer first, the one every client shares; the
      // manifests themselves when signed out or the server can't answer.
      var stableVersion: String?
      var betaVersion: String?
      if let fromAccount = await self.readAccountLatestReleases() {
        stableVersion = fromAccount.stable
        betaVersion = fromAccount.beta
      }
      if stableVersion == nil || betaVersion == nil {
        async let stable = self.readManifestVersion(Self.stableManifestURL)
        async let beta = self.readManifestVersion(Self.betaManifestURL)
        let (manifestStable, manifestBeta) = await (stable, beta)
        stableVersion = stableVersion ?? manifestStable
        betaVersion = betaVersion ?? manifestBeta
      }
      // A track only takes a build of that track, as the desktop's reader does.
      if let stableVersion, !adeVersionIsBetaTrack(stableVersion) { self.latestStable = stableVersion }
      if let betaVersion, adeVersionIsBetaTrack(betaVersion) { self.latestBeta = betaVersion }
      // Only an answer is reused; a read that got nothing tries again next time.
      if stableVersion != nil || betaVersion != nil { self.lastManifestRead = Date() }
    }
    manifestRead = task
    await task.value
    manifestRead = nil
  }

  /// `GET /releases/latest` on the account server; nil when signed out or it fails.
  private func readAccountLatestReleases() async -> (stable: String?, beta: String?)? {
    guard let baseURL = AccountConfig.directoryBaseURL,
          let token = await AccountService.shared.sessionToken() else { return nil }
    var request = URLRequest(url: baseURL.appendingPathComponent("releases/latest"))
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.timeoutInterval = 10
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    do {
      let (data, response) = try await session.data(for: request)
      guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
            let record = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
      return (Self.validVersion(record["stable"] as? String), Self.validVersion(record["beta"] as? String))
    } catch {
      machineUpdateLog.notice("account latest releases read failed error=\(error.localizedDescription, privacy: .public)")
      return nil
    }
  }

  /// A release version as the manifests carry it, without a leading "v"; nil otherwise.
  private static func validVersion(_ raw: String?) -> String? {
    guard var version = nonEmptyTrimmed(raw) else { return nil }
    if version.first == "v" || version.first == "V" { version.removeFirst() }
    guard version.range(of: #"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$"#, options: .regularExpression) != nil else { return nil }
    return version
  }

  private func readManifestVersion(_ url: URL) async -> String? {
    var request = URLRequest(url: url)
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.timeoutInterval = 10
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    do {
      let (data, response) = try await session.data(for: request)
      guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
            let record = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            let version = Self.validVersion(record["version"] as? String) else { return nil }
      return version
    } catch {
      machineUpdateLog.notice("manifest read failed url=\(url.absoluteString, privacy: .public)")
      return nil
    }
  }

  /// The newest build on `version`'s own track when the machine is behind it.
  /// "Update" never moves a machine across tracks.
  func targetVersion(forMachineVersion version: String?) -> String? {
    let newest = adeVersionIsBetaTrack(version) ? latestBeta : latestStable
    guard let newest, adeVersionIsBehind(version, target: newest) else { return nil }
    return newest
  }

  // MARK: Which machines

  /// Whether this machine can be asked: live, and its ADE offers the action.
  func canAsk(machineKey: String) -> Bool {
    #if DEBUG
    if fixture != nil { return true }
    #endif
    guard let syncService else { return false }
    if machineKey == syncService.focusedMachineKey {
      return syncService.connectionState == .connected
        && syncService.supportsRemoteAction(machineUpdateAndRestartRemoteAction)
    }
    guard let connection = fleet?.connection(for: machineKey), fleet?.machine(for: machineKey)?.state == .live else { return false }
    return connection.supportsAction(machineUpdateAndRestartRemoteAction)
  }

  /// The machine as an update target, when it is behind on its track, the phone
  /// can ask it, and it is not an ADE Cloud computer (those update themselves).
  func target(for machine: SettingsMachine) -> MachineUpdateTarget? {
    guard let key = machine.machineKey, machine.isLive,
          syncService?.cloudMachineFleetKeys.contains(key) != true,
          let targetVersion = targetVersion(forMachineVersion: machine.appVersion),
          canAsk(machineKey: key) else { return nil }
    return MachineUpdateTarget(id: key, name: machine.title, symbol: machine.symbol, version: machine.appVersion, targetVersion: targetVersion)
  }

  /// Asked, confirming, updating, or not back yet on the version it was sent to.
  func isBusy(_ machine: SettingsMachine) -> Bool {
    guard let key = machine.machineKey else { return false }
    if checkingKeys.contains(key) || updatingKeys.contains(key) { return true }
    guard let attempt = attempts[key] else { return false }
    return describeMachineUpdateAttempt(attempt, live: machine.isLive, version: machine.appVersion, now: Date()).inFlight
  }

  /// The last attempt's line for this machine, read against what it reports now.
  func status(for machine: SettingsMachine) -> MachineUpdateStatus? {
    guard let key = machine.machineKey, let attempt = attempts[key] else { return nil }
    _ = clock
    return describeMachineUpdateAttempt(attempt, live: machine.isLive, version: machine.appVersion, now: Date())
  }

  func attempt(for machine: SettingsMachine) -> MachineUpdateAttempt? {
    machine.machineKey.flatMap { attempts[$0] }
  }

  func dismissAttempt(machineKey: String) {
    attempts[machineKey] = nil
  }

  // MARK: Ask, then update

  /// "Update" on a row, or "Update all": asks each machine what an update
  /// would stop, then presents the confirmation for `origin`.
  func request(_ targets: [MachineUpdateTarget], origin: String) {
    let idle = targets.filter { !checkingKeys.contains($0.id) && !updatingKeys.contains($0.id) }
    guard !idle.isEmpty else { return }
    checkingKeys.formUnion(idle.map(\.id))
    Task { @MainActor in
      // Every machine is asked at once; each answers within its own deadline.
      let impacts = await withTaskGroup(of: (String, MachineUpdateImpact).self) { group -> [String: MachineUpdateImpact] in
        for target in idle {
          let key = target.id
          group.addTask { @MainActor in
            let impact = await self.readImpact(machineKey: key)
            return (key, impact)
          }
        }
        var answers: [String: MachineUpdateImpact] = [:]
        for await (key, impact) in group { answers[key] = impact }
        return answers
      }
      let rows = idle.map { MachineUpdateConfirmation.Row(target: $0, impact: impacts[$0.id] ?? .unknown) }
      checkingKeys.subtract(idle.map(\.id))
      confirmation = MachineUpdateConfirmation(origin: origin, rows: rows)
    }
  }

  /// The person said yes: each machine is sent its own target version.
  func confirm(_ confirmation: MachineUpdateConfirmation) {
    if self.confirmation?.id == confirmation.id { self.confirmation = nil }
    for row in confirmation.rows where !updatingKeys.contains(row.target.id) {
      run(row.target)
    }
  }

  func cancel(_ confirmation: MachineUpdateConfirmation) {
    if self.confirmation?.id == confirmation.id { self.confirmation = nil }
  }

  private func run(_ target: MachineUpdateTarget) {
    #if DEBUG
    if fixture != nil {
      // The reply a machine sends as it restarts; nothing is sent.
      attempts[target.id] = MachineUpdateAttempt.fromResult(
        ["ok": true, "updateApplied": true, "targetVersion": target.targetVersion],
        name: target.name,
        now: Date()
      )
      return
    }
    #endif
    updatingKeys.insert(target.id)
    attempts[target.id] = nil
    Task { @MainActor in
      let attempt: MachineUpdateAttempt
      do {
        let raw = try await send(
          machineUpdateAndRestartRemoteAction,
          args: [
            "targetVersion": target.targetVersion,
            "requestedBy": ["machineName": UIDevice.current.name, "clientKind": "ios"],
          ],
          machineKey: target.id,
          timeoutNanoseconds: Self.updateTimeoutNanoseconds
        )
        attempt = MachineUpdateAttempt.fromResult(raw, name: target.name, now: Date())
      } catch let error where Self.lostAnswer(error) {
        // Sent, and the answer lost to the restart or the link: wait for the
        // machine to come back on the version it was sent.
        attempt = MachineUpdateAttempt(
          ok: true,
          message: "Lost touch with \(target.name) while it updated — checking when it’s back.",
          pendingVersion: target.targetVersion,
          downloading: false,
          startedAt: Date()
        )
      } catch {
        attempt = .failed(Self.sendFailureMessage(error, name: target.name), now: Date())
      }
      machineUpdateLog.info("update machine=\(target.id, privacy: .public) target=\(target.targetVersion, privacy: .public) ok=\(attempt.ok) pending=\(attempt.pendingVersion ?? "-", privacy: .public)")
      updatingKeys.remove(target.id)
      attempts[target.id] = attempt
      if attempt.ok { ADEHaptics.success() } else { ADEHaptics.error() }
      scheduleClock()
    }
  }

  /// The restart drops the link the reply would come back on. A reply lost
  /// that way is not a failure; the reconnect tells. An answered error, or a
  /// refusal before anything was sent, is.
  ///
  /// Refused before sending: 15 (the focused link is not live) and 41 (`send`
  /// found no live link). A closed link fails what it sent with 26 (focused)
  /// or 14 (a machine's own link, which `send` checked was live first). The
  /// update is runtime-scoped, so 26's "needs the lane's project" never applies.
  private static func lostAnswer(_ error: Error) -> Bool {
    if isRemoteCommandApplicationError(error) || isSyncHostUnavailableError(error) { return false }
    let nsError = error as NSError
    return !(nsError.domain == "ADE" && [15, 41].contains(nsError.code))
  }

  private static func sendFailureMessage(_ error: Error, name: String) -> String {
    let message = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
    return message.isEmpty ? "ADE could not ask \(name) to update." : message
  }

  private func readImpact(machineKey: String) async -> MachineUpdateImpact {
    #if DEBUG
    if let fixture { return fixture.impacts[machineKey] ?? .unknown }
    #endif
    guard canAsk(machineKey: machineKey) else { return .unknown }
    do {
      let raw = try await send(
        machineUpdateImpactRemoteAction,
        args: [:],
        machineKey: machineKey,
        timeoutNanoseconds: Self.impactTimeoutNanoseconds
      )
      return MachineUpdateImpact(json: raw) ?? .unknown
    } catch {
      machineUpdateLog.notice("update impact read failed machine=\(machineKey, privacy: .public) error=\(error.localizedDescription, privacy: .public)")
      return .unknown
    }
  }

  private func send(_ action: String, args: [String: Any], machineKey: String, timeoutNanoseconds: UInt64) async throws -> Any {
    guard let syncService else { throw Self.unreachable }
    if machineKey == syncService.focusedMachineKey {
      return try await syncService.sendCommand(
        action: action,
        args: args,
        // A slow update must not tear down the phone's main connection.
        disconnectOnTimeout: false,
        timeoutNanoseconds: timeoutNanoseconds
      )
    }
    // Live before sending, so a failure after this is the link closing under it.
    guard let connection = fleet?.connection(for: machineKey),
          fleet?.isLive(machineKey) == true else { throw Self.unreachable }
    return try await connection.sendCommand(
      action: action,
      args: args,
      projectId: nil,
      projectRootPath: nil,
      timeoutNanoseconds: timeoutNanoseconds
    )
  }

  private static let unreachable = NSError(
    domain: "ADE",
    code: 41,
    userInfo: [NSLocalizedDescriptionKey: "That machine isn’t connected right now."]
  )

  /// One wake-up at the earliest in-flight attempt's deadline, so its row
  /// stops reading "reconnecting…" once the wait is over.
  private func scheduleClock() {
    clockTask?.cancel()
    let now = Date()
    let deadlines = attempts.values
      .filter { $0.pendingVersion != nil }
      .map { $0.startedAt.addingTimeInterval($0.grace) }
      .filter { $0 > now }
    guard let next = deadlines.min() else { return }
    clockTask = Task { @MainActor [weak self] in
      let seconds = max(0, next.timeIntervalSinceNow) + 0.25
      try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
      guard !Task.isCancelled, let self else { return }
      self.clock = Date()
      self.scheduleClock()
    }
  }
}
