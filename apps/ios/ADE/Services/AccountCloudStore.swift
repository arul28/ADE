import Foundation
import OSLog
import UIKit

private let accountCloudLog = Logger(subsystem: "com.ade.ios", category: "cloud")

// ADE Cloud as the account server holds it, for a phone with no computer of
// its own awake. ADE Cloud is one machine to the person; underneath, each
// cloud lane has its own computer. Every call here names that lane's own
// computer (its machine key or instance id), never "the cloud" in general.
//
// Reading never wakes a computer: the account, the lanes without a computer,
// the saved chats and their transcripts come from the server. Doing wakes:
// a send to an asleep chat goes to the server's queue, which wakes the
// computer and delivers the message once it is up. The phone may close in
// between; the server keeps the message.
//
// Reads ride the existing triggers (the account's machine list loading, the
// app coming to the front) with `SyncService.cloudServerReadFloor`. The only
// loop is `followQueue`, which a chat runs while it is open, the app is in
// front and one of its messages still waits.

@MainActor
final class AccountCloudStore: ObservableObject {
  static let shared = AccountCloudStore()

  /// A send to an asleep cloud chat, as the server answered it.
  enum SendOutcome: Equatable {
    /// The server holds it and wakes the computer (`waking`, `awake`), or
    /// makes a new computer that continues the chat (`launching`).
    case queued(CloudChatQueuedMessage, wakeState: String)
    /// An older server has no queue: wake, then send as before.
    case routeMissing
    /// The server said no; the sentence says why. Nothing was kept.
    case refused(String)
    case failed(String)
  }

  /// `GET /cloud/access` with the fields newer servers add.
  struct Access: Decodable, Equatable {
    let enabled: Bool
    let readOnly: Bool
    let reason: String?

    private enum CodingKeys: String, CodingKey { case enabled, readOnly, reason }

    init(enabled: Bool, readOnly: Bool, reason: String?) {
      self.enabled = enabled
      self.readOnly = readOnly
      self.reason = reason
    }

    init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      enabled = c.lenient(Bool.self, forKey: .enabled) ?? false
      readOnly = c.lenient(Bool.self, forKey: .readOnly) ?? false
      reason = c.lenient(String.self, forKey: .reason).flatMap { nonEmptyTrimmed($0) }
    }
  }

  @Published private(set) var access: Access?
  @Published private(set) var account: CloudPhoneAccount?
  @Published private(set) var lanesWithoutComputer: [CloudLaneWithoutComputer] = []
  /// The last read of `lanesWithoutComputer` failed: an empty list then
  /// means "unknown", never "none".
  @Published private(set) var lanesWithoutComputerUnread = false
  /// Held messages by chat (`chatKey`), oldest first.
  @Published private(set) var queued: [String: [CloudChatQueuedMessage]] = [:]
  /// The size picked for the computer that replaces a deleted one, by the
  /// deleted computer's machine key (lowercased; its chats share the one new
  /// computer), until a send carries it. None: ADE's size.
  @Published private(set) var newComputerSizes: [String: String] = [:]
  /// "Keep it" went through for these computers this run.
  @Published private(set) var keptInstanceIds: Set<String> = []
  /// Failed held messages the person put back or dismissed. They stay on
  /// the server until it prunes them, so the phone keeps the ids, per
  /// account, newest last, at most `hiddenMessagesLimit`.
  @Published private(set) var hiddenMessageIds: Set<String> = []
  private var hiddenMessageOrder: [String] = []
  /// The account `hiddenMessageIds` belongs to.
  private var hiddenMessagesUserId: String?
  private static let hiddenMessagesLimit = 200
  /// Held messages the phone saw leave the queue for the chat (open, then
  /// `delivered`), with when. The chat keeps drawing each as the person's
  /// own message until its transcript shows the real one, so the message
  /// never blinks out between the server's word and the chat's. A chat that
  /// never shows it (the message continued on a new computer's chat) stops
  /// after `deliveredAwaitingThreadLimit`.
  @Published private(set) var deliveredAwaitingThread: [String: Date] = [:]
  /// Held messages the chat's transcript shows: the thread never draws them again.
  @Published private(set) var retiredFromThread: Set<String> = []
  /// Transcript user messages (by row id) a held message was matched to by
  /// text, with that held message: one transcript message answers for one
  /// held message, ever, not once per read.
  private(set) var textMatchedTranscriptRows: [String: String] = [:]
  private static let deliveredAwaitingThreadLimit: TimeInterval = 120

  /// Bumped on an account change: an answer to the last account's read lands nowhere.
  private var accountGeneration = 0
  /// The last read of the kept lanes (`refreshLanesWithoutComputer`, or the account read).
  private var lanesReadAt: Date?
  /// Bumped by each kept-lane read as it starts (and by an account change).
  private var lanesReadSeq: UInt64 = 0
  /// A saved chat's paging, by thread key. No entry: never read this run.
  private var transcriptPaging: [String: TranscriptPaging] = [:]
  /// The lowest durable `sequence` in each saved part read this run, by
  /// part seq, by thread key: maps the engine's oldest row back to its part.
  private var transcriptPartFirstSequence: [String: [Int: Int]] = [:]
  /// Saved chats read this run, by thread key: one read per open.
  private var transcriptReads: [String: Task<Void, Never>] = [:]

  /// Where a saved chat's scroll-back stands.
  private struct TranscriptPaging {
    enum Cursor: Equatable {
      /// The next older part starts before this sequence.
      case before(Int)
      /// Paged to the oldest part: nothing older to read.
      case top
    }
    /// The newest read's `nextBefore` (nil: the newest part was all of it).
    var newestNextBefore: Int?
    var olderBefore: Cursor
  }

  static func chatKey(machineKey: String, chatId: String) -> String {
    "\(machineKey.lowercased())|\(chatId)"
  }

  // MARK: Reads

  /// Reads the account's ADE Cloud state: access, the account (hours, plan,
  /// the idle cleanup's warnings) and the lanes without a computer. Called
  /// with the account server read (`readCloudServer`); never on a timer.
  /// A read that fails keeps the last answer.
  func refresh(client: CloudServerClient, owner: AccountPairingAuthorization) async {
    let generation = accountGeneration
    async let accessRead = readAccess(client)
    async let accountRead = readAccount(client)
    lanesReadSeq &+= 1
    let lanesSeq = lanesReadSeq
    async let lanesRead = readLanesWithoutComputer(client)
    let (nextAccess, nextAccount, nextLanes) = await (accessRead, accountRead, lanesRead)
    guard generation == accountGeneration, AccountService.shared.isPairingCommitAuthorized(owner) else { return }
    if let nextAccess, nextAccess != access { access = nextAccess }
    if let nextAccount, nextAccount != account { account = nextAccount }
    applyLanesRead(nextLanes, seq: lanesSeq)
  }

  private func readAccess(_ client: CloudServerClient) async -> Access? {
    do {
      let data = try await client.send("GET", "cloud/access")
      return try JSONDecoder().decode(Access.self, from: data)
    } catch {
      accountCloudLog.notice("cloud_store read=access failed error=\(CrashReporting.redactedErrorDescription(error), privacy: .public)")
      return nil
    }
  }

  private func readAccount(_ client: CloudServerClient) async -> CloudPhoneAccount? {
    do {
      return try await client.account()
    } catch {
      accountCloudLog.notice("cloud_store read=account failed error=\(CrashReporting.redactedErrorDescription(error), privacy: .public)")
      return nil
    }
  }

  private func readLanesWithoutComputer(_ client: CloudServerClient) async -> [CloudLaneWithoutComputer]? {
    do {
      return try await client.lanesWithoutComputer()
    } catch CloudServerClient.Failure.noAccess {
      // An older server, or no ADE Cloud: nothing to add, and nothing to drop.
      return lanesWithoutComputer
    } catch {
      accountCloudLog.notice("cloud_store read=lanes_without_computer failed error=\(CrashReporting.redactedErrorDescription(error), privacy: .public)")
      return nil
    }
  }

  /// Reads the lanes ADE kept without a computer now (a page that shows them
  /// opens or is pulled, or a new computer for one of them is up), at most
  /// every 15 s unless forced. A failed read keeps the last list.
  func refreshLanesWithoutComputer(using sync: SyncService, force: Bool = false) async {
    if !force, let at = lanesReadAt, Date().timeIntervalSince(at) < 15 { return }
    lanesReadAt = Date()
    let generation = accountGeneration
    // An account change while the client was fetched: this read is not that account's.
    guard let client = await sync.cloudServerClient(), generation == accountGeneration else { return }
    lanesReadSeq &+= 1
    let seq = lanesReadSeq
    let next = await readLanesWithoutComputer(client)
    guard generation == accountGeneration else { return }
    applyLanesRead(next, seq: seq)
  }

  /// A read of the kept lanes, unless a later read already started: an
  /// older answer never replaces a newer one. A failed read keeps the list,
  /// marks it unread, and doesn't count toward the 15 s wait.
  private func applyLanesRead(_ next: [CloudLaneWithoutComputer]?, seq: UInt64) {
    guard seq == lanesReadSeq else { return }
    guard let next else {
      lanesReadAt = nil
      if !lanesWithoutComputerUnread { lanesWithoutComputerUnread = true }
      return
    }
    lanesReadAt = Date()
    if lanesWithoutComputerUnread { lanesWithoutComputerUnread = false }
    if next != lanesWithoutComputer { lanesWithoutComputer = next }
  }

  /// Delete for a lane kept without a computer: the lane's record and its
  /// saved work first, then its saved chats on every computer they were filed
  /// under. The server refuses the first while a computer holds the lane
  /// (another device started it again), so chats a new computer carries on
  /// are never erased. Its branch stays on GitHub. Nil when it worked, else
  /// the sentence to show.
  func forgetLaneWithoutComputer(_ lane: CloudLaneWithoutComputer, using sync: SyncService) async -> String? {
    let generation = accountGeneration
    guard let client = await sync.cloudServerClient() else { return "Sign in to ADE, then try again." }
    var machineKeys = Set(sync.cloudSavedChats.filter { $0.laneId == lane.laneId }.map { $0.machineKey.lowercased() })
    if let former = lane.formerMachineKey.flatMap({ nonEmptyTrimmed($0) }) { machineKeys.insert(former.lowercased()) }
    do {
      try await client.forgetLaneWithoutComputer(laneId: lane.laneId)
    } catch CloudServerClient.Failure.noAccess {
      // Already gone (another device deleted it): its chats go below.
    } catch {
      accountCloudLog.notice("cloud_store forget_lane failed error=\(CrashReporting.redactedErrorDescription(error), privacy: .public)")
      return cloudServerFailureMessage(error)
    }
    if generation == accountGeneration {
      // A read that started before the delete must not bring the lane back.
      lanesReadSeq &+= 1
      lanesReadAt = nil
      lanesWithoutComputer.removeAll { $0.laneId == lane.laneId }
      // The server deleted the lane's chats on every computer with it.
      sync.noteCloudLaneDeleted(lane.laneId)
    }
    do {
      for machineKey in machineKeys.sorted() {
        do {
          try await client.deleteSavedChats(machineKey: machineKey, laneId: lane.laneId)
        } catch CloudServerClient.Failure.noAccess {
          // Nothing saved under that computer.
        }
      }
    } catch {
      accountCloudLog.notice("cloud_store forget_lane chats failed error=\(CrashReporting.redactedErrorDescription(error), privacy: .public)")
      return "The lane is gone, but its saved chats weren't deleted. Delete them in Work."
    }
    guard generation == accountGeneration else { return nil }
    accountCloudLog.notice("cloud_store forget_lane=done")
    return nil
  }

  /// Why ADE Cloud can't do anything for this account now (blocked, out of
  /// hours), in a sentence. Reading still works. Nil when it can.
  var doingRefusal: String? {
    if let access, access.readOnly || !access.enabled {
      return access.reason ?? "ADE Cloud is read-only for this account. Your lanes and chats stay readable."
    }
    if account?.outOfHours == true {
      return "This account has no ADE Cloud hours left this period. Your lanes and chats stay readable."
    }
    return nil
  }

  /// The idle cleanup's warning for one computer, unless the person kept it.
  func deletingSoon(instanceId: String?) -> CloudPhoneAccount.IdleCleanup? {
    guard let instanceId, !keptInstanceIds.contains(instanceId) else { return nil }
    return account?.dueForDeletion.first { $0.instanceId == instanceId }
  }

  // MARK: Doing

  /// "Keep it" for a computer the idle cleanup warned about. Nil when it
  /// worked, else the sentence to show.
  func keep(instanceId: String, using sync: SyncService) async -> String? {
    guard let client = await sync.cloudServerClient() else { return "Sign in to ADE to keep this computer." }
    do {
      try await client.keep(instanceId: instanceId)
      keptInstanceIds.insert(instanceId)
      accountCloudLog.notice("cloud_store keep=done")
      return nil
    } catch {
      return cloudServerFailureMessage(error)
    }
  }

  /// "Update & restart" for an ADE Cloud computer whose ADE is too old to
  /// keep working on (`ClientUpdateGate.swift`). Nil when the update started,
  /// else the sentence to show.
  func updateComputer(instanceId: String, using sync: SyncService) async -> String? {
    guard let client = await sync.cloudServerClient() else { return "Sign in to ADE to update this computer." }
    do {
      try await client.update(instanceId: instanceId)
      accountCloudLog.notice("cloud_store update=started")
      return nil
    } catch {
      return cloudServerFailureMessage(error)
    }
  }

  /// Hands a message for an existing cloud chat to the server's queue. The
  /// server wakes the chat's own computer (or makes a new one for a lane
  /// whose computer was deleted) and delivers the message once, keyed on
  /// `messageId` (the composer's send id).
  func queueSend(machineKey: String, chatId: String, messageId: String, text: String, files: [CloudQueuedFile] = [], using sync: SyncService) async -> SendOutcome {
    let generation = accountGeneration
    guard let client = await sync.cloudServerClient() else { return .failed("Sign in to ADE to send this message.") }
    let key = Self.chatKey(machineKey: machineKey, chatId: chatId)
    // Files go up first, to a draft launch the message then names; the
    // computer fetches them when it wakes.
    var attachments: [[String: Any]] = []
    if !files.isEmpty {
      if files.count > CloudQueuedFile.maxCount { return .failed("Send at most \(CloudQueuedFile.maxCount) files at once.") }
      // Every size is checked before the first upload: a refused batch leaves nothing behind.
      if let big = files.first(where: { $0.data.count > CloudQueuedFile.maxBytes }) { return .failed("\(big.name) is over 25 MB.") }
      let launchId = UUID().uuidString.lowercased()
      for (index, file) in files.enumerated() {
        // Signed out or another account meanwhile: send nothing more for it.
        guard generation == accountGeneration else { return .failed("The account changed. Send the message again.") }
        let fileId = "f\(index)-\(launchId.prefix(8))"
        do {
          let size = try await client.uploadLaunchFile(launchId: launchId, fileId: fileId, data: file.data, contentType: file.contentType)
          attachments.append(["fileId": fileId, "name": String(file.name.prefix(200)), "contentType": file.contentType, "sizeBytes": size, "launchId": launchId])
        } catch {
          return .failed("ADE couldn't send \(file.name). \(cloudServerFailureMessage(error))")
        }
      }
    }
    guard generation == accountGeneration else { return .failed("The account changed. Send the message again.") }
    let sizeId = newComputerSizes[machineKey.lowercased()]
    do {
      let result = try await client.queueMessage(machineKey: machineKey, chatId: chatId, messageId: messageId, text: text, attachments: attachments, sizeId: sizeId)
      guard generation == accountGeneration else { return .failed("The account changed. Send the message again.") }
      upsert(result.message, key: key)
      // A size picked while the send was out stays for the next send.
      if let sizeId, newComputerSizes[machineKey.lowercased()] == sizeId { newComputerSizes[machineKey.lowercased()] = nil }
      accountCloudLog.notice("cloud_store queue=sent wake=\(result.wake?.state ?? "none", privacy: .public)")
      return .queued(result.message, wakeState: result.wake?.state ?? "waking")
    } catch CloudServerClient.Failure.noAccess {
      return .routeMissing
    } catch CloudServerClient.Failure.refused(let code, let message) {
      // An older computer the server can't update on wake: today's path.
      if code == "update_needed" { return .routeMissing }
      return .refused(message)
    } catch {
      return .failed(cloudServerFailureMessage(error))
    }
  }

  /// Picks (or, with nil, unpicks) the size of the computer that replaces this deleted one.
  func pickNewComputerSize(machineKey: String, sizeId: String?) {
    newComputerSizes[machineKey.lowercased()] = sizeId
  }

  /// Cancels a message that still waits. Nil when it worked.
  func cancelQueued(machineKey: String, chatId: String, messageId: String, using sync: SyncService) async -> String? {
    guard let client = await sync.cloudServerClient() else { return "Sign in to ADE to cancel this message." }
    do {
      try await client.cancelQueuedMessage(machineKey: machineKey, chatId: chatId, messageId: messageId)
      let key = Self.chatKey(machineKey: machineKey, chatId: chatId)
      queued[key]?.removeAll { $0.messageId == messageId }
      return nil
    } catch {
      return cloudServerFailureMessage(error)
    }
  }

  /// The held messages the server moves on its own (not waiting for a sign-in).
  func movingMessageCount(machineKey: String, chatId: String) -> Int {
    (queued[Self.chatKey(machineKey: machineKey, chatId: chatId)] ?? []).filter(\.isMoving).count
  }

  /// Follows one chat's held messages while the chat is open and the app is
  /// in front: every 3 s, slowing to 10 s while nothing changes, until no
  /// message moves on its own. A message that waits for a sign-in moves only
  /// after the person signs in, and the sign-in step reads the list again.
  /// The view's task cancels it when the chat closes.
  /// `onDelivered` runs when a message left the queue (the computer is up),
  /// in its own task: the list this read publishes changes the view's task
  /// id, which cancels this follow, and the connect must still finish.
  func followQueue(machineKey: String, chatId: String, using sync: SyncService, onDelivered: @escaping @MainActor () async -> Void) async {
    let key = Self.chatKey(machineKey: machineKey, chatId: chatId)
    var delay: UInt64 = 3
    // Read once at open: another device may have queued a message.
    await reconcile(machineKey: machineKey, chatId: chatId, using: sync)
    while !Task.isCancelled {
      guard (queued[key] ?? []).contains(where: \.isMoving) else { return }
      try? await Task.sleep(nanoseconds: delay * 1_000_000_000)
      if Task.isCancelled { return }
      guard UIApplication.shared.applicationState == .active else { delay = 10; continue }
      let openBefore = Set((queued[key] ?? []).filter(\.isOpen).map(\.messageId))
      await reconcile(machineKey: machineKey, chatId: chatId, using: sync)
      let openAfter = Set((queued[key] ?? []).filter(\.isOpen).map(\.messageId))
      if openAfter != openBefore {
        delay = 3
        if !openBefore.subtracting(openAfter).isEmpty {
          let generation = accountGeneration
          Task { @MainActor [weak self] in
            guard let self, generation == self.accountGeneration else { return }
            await onDelivered()
          }
        }
      } else {
        delay = min(delay + 2, 10)
      }
    }
  }

  /// Reads one chat's held messages from the server.
  func reconcile(machineKey: String, chatId: String, using sync: SyncService) async {
    let generation = accountGeneration
    guard let client = await sync.cloudServerClient() else { return }
    let messages: [CloudChatQueuedMessage]
    do {
      messages = try await client.queuedMessages(machineKey: machineKey, chatId: chatId)
    } catch CloudServerClient.Failure.noAccess {
      // An older server has no queue route: nothing to show.
      return
    } catch {
      // A failed read keeps the last list.
      accountCloudLog.notice("cloud_store read=queued_messages failed error=\(CrashReporting.redactedErrorDescription(error), privacy: .public)")
      return
    }
    guard generation == accountGeneration else { return }
    applyQueuedRead(messages, machineKey: machineKey, chatId: chatId)
  }

  /// One read of a chat's held messages. A message this phone saw open that
  /// the server now calls delivered stays in the chat's thread until the
  /// transcript shows it (`deliveredAwaitingThread`); one delivered before
  /// the phone looked is never drawn.
  func applyQueuedRead(_ messages: [CloudChatQueuedMessage], machineKey: String, chatId: String) {
    loadHiddenMessagesIfNeeded()
    let key = Self.chatKey(machineKey: machineKey, chatId: chatId)
    let next = messages.sorted { ($0.seq ?? 0) < ($1.seq ?? 0) }
    let wasOpen = Set((queued[key] ?? []).filter(\.isOpen).map(\.messageId))
    let now = Date()
    let expired = deliveredAwaitingThread.filter { now.timeIntervalSince($0.value) >= Self.deliveredAwaitingThreadLimit }
    for id in expired.keys { deliveredAwaitingThread[id] = nil }
    for message in next where message.state == "delivered"
      && wasOpen.contains(message.messageId)
      && !retiredFromThread.contains(message.messageId)
      && deliveredAwaitingThread[message.messageId] == nil {
      deliveredAwaitingThread[message.messageId] = now
      expireDeliveredAwaitingThread(message.messageId, at: now)
    }
    if queued[key] != next { queued[key] = next }
  }

  /// One wake-up when a delivered message's wait for the transcript runs
  /// out: the entry goes and the store republishes, so the thread stops
  /// drawing it (and its working line) on time, not on the next redraw.
  private func expireDeliveredAwaitingThread(_ messageId: String, at: Date) {
    let generation = accountGeneration
    Task { @MainActor [weak self] in
      try? await Task.sleep(nanoseconds: UInt64(Self.deliveredAwaitingThreadLimit * 1_000_000_000))
      guard let self, generation == self.accountGeneration,
            self.deliveredAwaitingThread[messageId] == at else { return }
      self.deliveredAwaitingThread[messageId] = nil
    }
  }

  /// The held messages a chat draws in its thread as the person's own
  /// messages, oldest first: the ones on their way (queued, sending,
  /// waiting for a sign-in), the failed ones the person did not put back
  /// or dismiss, and the ones delivered while the chat was open that its
  /// transcript does not show yet. Never one the transcript already showed.
  func threadMessages(machineKey: String, chatId: String) -> [CloudChatQueuedMessage] {
    let now = Date()
    return (queued[Self.chatKey(machineKey: machineKey, chatId: chatId)] ?? []).filter { message in
      guard !retiredFromThread.contains(message.messageId) else { return false }
      if message.isOpen { return true }
      switch message.state {
      case "failed":
        return !hiddenMessageIds.contains(message.messageId)
      case "delivered":
        guard let at = deliveredAwaitingThread[message.messageId] else { return false }
        return now.timeIntervalSince(at) < Self.deliveredAwaitingThreadLimit
      default:
        return false
      }
    }
  }

  /// The chat's transcript shows these held messages now (see
  /// `cloudHeldMessagesShown`): the thread stops drawing them, for good, and
  /// a transcript message matched by text answers for no other.
  func retireFromThread(_ shown: CloudHeldShown) {
    textMatchedTranscriptRows.merge(shown.textMatchedRows) { kept, _ in kept }
    let fresh = shown.messageIds.subtracting(retiredFromThread)
    guard !fresh.isEmpty else { return }
    retiredFromThread.formUnion(fresh)
    for id in fresh where deliveredAwaitingThread[id] != nil {
      deliveredAwaitingThread[id] = nil
    }
  }

  /// The held messages a chat shows: the open ones, and the failed ones
  /// the person did not put back or dismiss.
  func visibleMessages(machineKey: String, chatId: String) -> [CloudChatQueuedMessage] {
    (queued[Self.chatKey(machineKey: machineKey, chatId: chatId)] ?? []).filter { message in
      message.isOpen || (message.state == "failed" && !hiddenMessageIds.contains(message.messageId))
    }
  }

  /// Put back or Dismiss on a failed held message: the chat stops showing it.
  func hideFailedMessage(_ messageId: String) {
    loadHiddenMessagesIfNeeded()
    guard let userId = hiddenMessagesUserId, !hiddenMessageIds.contains(messageId) else { return }
    hiddenMessageOrder.append(messageId)
    if hiddenMessageOrder.count > Self.hiddenMessagesLimit {
      hiddenMessageOrder.removeFirst(hiddenMessageOrder.count - Self.hiddenMessagesLimit)
    }
    hiddenMessageIds = Set(hiddenMessageOrder)
    UserDefaults.standard.set(hiddenMessageOrder, forKey: Self.hiddenMessagesKey(userId))
  }

  private static func hiddenMessagesKey(_ userId: String) -> String {
    "ade.cloud.hiddenQueuedMessages.\(userId)"
  }

  /// Reads the signed-in account's hidden ids once per account.
  private func loadHiddenMessagesIfNeeded() {
    let userId = AccountService.shared.identity?.userId
    guard userId != hiddenMessagesUserId else { return }
    hiddenMessagesUserId = userId
    hiddenMessageOrder = userId.flatMap { UserDefaults.standard.stringArray(forKey: Self.hiddenMessagesKey($0)) } ?? []
    hiddenMessageIds = Set(hiddenMessageOrder)
  }

  private func upsert(_ message: CloudChatQueuedMessage, key: String) {
    var list = queued[key] ?? []
    if let index = list.firstIndex(where: { $0.messageId == message.messageId }) {
      list[index] = message
    } else {
      list.append(message)
    }
    queued[key] = list
  }

  // MARK: Saved transcripts

  /// Reads the newest part of a saved chat and hands it to the chat's thread
  /// engine as its snapshot. One part per page: a part can be megabytes.
  /// Decoded off the main actor. Older parts follow through `olderSavedPage`.
  func loadSavedTranscript(key: ChatThreadKey, accountMachineKey: String, using sync: SyncService) {
    let id = key.description
    guard transcriptReads[id] == nil else { return }
    let generation = accountGeneration
    transcriptReads[id] = Task { @MainActor [weak self, weak sync] in
      defer { self?.transcriptReads[id] = nil }
      guard let self, let sync, let client = await sync.cloudServerClient() else { return }
      let page: CloudChatTranscriptPage
      do {
        page = try await client.transcriptPage(machineKey: accountMachineKey, chatId: key.sessionId)
      } catch {
        accountCloudLog.notice("cloud_store read=transcript failed error=\(CrashReporting.redactedErrorDescription(error), privacy: .public)")
        return
      }
      let sessionId = key.sessionId
      let decoded = await Task.detached(priority: .userInitiated) {
        accountCloudDecodeParts(page.parts)
      }.value
      let events = decoded.events
      guard generation == self.accountGeneration, !Task.isCancelled else { return }
      self.transcriptPartFirstSequence[id, default: [:]].merge(decoded.firstSequenceByPart) { $1 }
      // A read again (the chat reopened, a delivered message) keeps the
      // older place the reader already paged to only while the newest part
      // still starts where it did: the engine keeps those older rows then.
      // When it starts elsewhere the engine drops them, so paging restarts
      // from this newest part (else the history between would be skipped).
      // A first read has no entry; one paged to the top keeps `.top`.
      // This cursor is only the fallback: `olderSavedPage` pages from the
      // engine's own oldest row when it names one.
      let newest = page.hasMore ? page.nextBefore : nil
      if self.transcriptPaging[id].map({ $0.newestNextBefore != newest }) ?? true {
        self.transcriptPaging[id] = TranscriptPaging(
          newestNextBefore: newest,
          olderBefore: newest.map(TranscriptPaging.Cursor.before) ?? .top
        )
      }
      sync.chatThreadRegistry.routeSnapshot(
        ChatThreadSnapshotInput(
          sessionId: sessionId,
          events: events,
          hasOlderHistory: page.hasMore,
          turnActive: false,
          sessionFound: true,
          // Saved lines carry their durable `sequence`: the engine asks for
          // older history by sequence, and `olderSavedPage` answers with the
          // next older part. Without this the engine had no cursor to ask
          // with, so scrolling up stopped at the newest part.
          hostSupportsChatLogV2: true
        ),
        key: key
      )
    }
  }

  /// The next older part of a saved chat, for the thread engine's scroll-back.
  /// It pages from the engine's own oldest row (`beforeSequence`): the part
  /// that row came from, so rows the engine's cache trimmed are read again
  /// and never skipped, and only rows older than it come back. The stored
  /// cursor is the fallback when the engine names no row, or one from a
  /// part this run never read. A chat paged to its first part reads nothing.
  func olderSavedPage(
    key: ChatThreadKey,
    accountMachineKey: String,
    request: ChatThreadOlderRequest,
    using sync: SyncService
  ) async throws -> ChatThreadOlderPageInput {
    let id = key.description
    let oldestHeld: Int? = if case .beforeSequence(let sequence) = request { sequence } else { nil }
    guard var before = savedPartBefore(id: id, oldestHeld: oldestHeld) else {
      return ChatThreadOlderPageInput(sessionId: key.sessionId, events: [], hasMore: false)
    }
    let generation = accountGeneration
    guard let client = await sync.cloudServerClient(), generation == accountGeneration else {
      return .failed(sessionId: key.sessionId, message: "Sign in to ADE to read earlier messages.")
    }
    while true {
      let page = try await client.transcriptPage(machineKey: accountMachineKey, chatId: key.sessionId, before: before)
      let decoded = await Task.detached(priority: .userInitiated) {
        accountCloudDecodeParts(page.parts)
      }.value
      // The account changed while the page was out: none of it is this account's.
      guard generation == accountGeneration else {
        return .failed(sessionId: key.sessionId, message: "The account changed. Open the chat again.")
      }
      transcriptPartFirstSequence[id, default: [:]].merge(decoded.firstSequenceByPart) { $1 }
      let next: TranscriptPaging.Cursor = page.hasMore ? page.nextBefore.map(TranscriptPaging.Cursor.before) ?? .top : .top
      transcriptPaging[id]?.olderBefore = next
      let events = oldestHeld.map { oldest in
        decoded.events.filter { $0.envelope.sequence.map { $0 < oldest } ?? true }
      } ?? decoded.events
      // A part the engine already holds all of (a stored cursor behind its
      // oldest row): read on to the first part with something older.
      guard events.isEmpty, case .before(let older) = next, older < before else {
        return ChatThreadOlderPageInput(sessionId: key.sessionId, events: events, hasMore: next != .top)
      }
      before = older
    }
  }

  /// The server `before` (a part seq, exclusive) for the next older page.
  /// Nil: nothing older to read.
  private func savedPartBefore(id: String, oldestHeld: Int?) -> Int? {
    if let oldestHeld, let firsts = transcriptPartFirstSequence[id],
       let part = firsts.filter({ $0.value <= oldestHeld }).max(by: { $0.key < $1.key }) {
      // The engine's oldest row is in `part`: from the part before it when
      // that row is the part's first, else `part` itself again.
      let before = part.value == oldestHeld ? part.key : part.key + 1
      return before > 1 ? before : nil
    }
    guard case .before(let before)? = transcriptPaging[id]?.olderBefore else { return nil }
    return before
  }

  // MARK: Account change

  func reset() {
    accountGeneration &+= 1
    access = nil
    account = nil
    lanesWithoutComputer = []
    lanesWithoutComputerUnread = false
    lanesReadSeq &+= 1
    lanesReadAt = nil
    queued = [:]
    newComputerSizes = [:]
    keptInstanceIds = []
    hiddenMessageIds = []
    hiddenMessageOrder = []
    hiddenMessagesUserId = nil
    deliveredAwaitingThread = [:]
    retiredFromThread = []
    textMatchedTranscriptRows = [:]
    transcriptPaging = [:]
    transcriptPartFirstSequence = [:]
    for task in transcriptReads.values { task.cancel() }
    transcriptReads = [:]
  }

  #if DEBUG
  /// Fixture screens only: an account state and held messages, with no account server.
  func seedPreview(access: Access?, account: CloudPhoneAccount?, queued: [String: [CloudChatQueuedMessage]] = [:]) {
    self.access = access
    self.account = account
    self.queued = queued
  }
  #endif
}

/// The chat events of saved parts (JSON lines, newest part first) in the
/// order they happened, and each part's lowest durable `sequence`. A line
/// that does not decode is left out alone.
func accountCloudDecodeParts(_ parts: [CloudChatTranscriptPage.Part]) -> (events: [ChatThreadLiveEvent], firstSequenceByPart: [Int: Int]) {
  var events: [ChatThreadLiveEvent] = []
  var firstSequenceByPart: [Int: Int] = [:]
  for part in parts.sorted(by: { $0.seq < $1.seq }) {
    for line in part.text.split(whereSeparator: \.isNewline) {
      guard let data = line.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data),
            let event = chatThreadDecodeLiveEvent(object) else { continue }
      events.append(event)
      if let sequence = event.envelope.sequence {
        firstSequenceByPart[part.seq] = min(firstSequenceByPart[part.seq] ?? sequence, sequence)
      }
    }
  }
  return (events, firstSequenceByPart)
}

/// The held messages a chat's transcript shows (`cloudHeldMessagesShown`),
/// and the transcript rows matched by text, row id to held message id.
struct CloudHeldShown: Equatable {
  var messageIds: Set<String> = []
  var textMatchedRows: [String: String] = [:]
}

/// The held messages a chat's transcript already shows, by message id: a
/// user message that carries the held message's send id, or, from a
/// computer whose ADE writes no send id, a user message with its text
/// written after the message was held. The text match is only for a
/// message the server is sending or has delivered: a still-queued one (or
/// one waiting for a sign-in) is not in the chat yet, whatever its text.
/// Each transcript message answers for one held message, ever:
/// `textMatchedRows` (the store's `textMatchedTranscriptRows`) are the rows
/// earlier reads already gave to a held message. Only the newest rows are
/// read: a delivered message lands at the end.
func cloudHeldMessagesShown(
  _ messages: [CloudChatQueuedMessage],
  in transcript: [WorkChatEnvelope],
  textMatchedRows: [String: String] = [:]
) -> CloudHeldShown {
  guard !messages.isEmpty else { return CloudHeldShown() }
  var sendIds = Set<String>()
  var unkeyed: [(rowId: String, text: String, at: Date?)] = []
  for envelope in transcript.suffix(400) {
    guard case .userMessage(let text, _, _, _, _, _) = envelope.event else { continue }
    if let sendId = envelope.userMessageClientSendId {
      sendIds.insert(sendId)
    } else {
      unkeyed.append((envelope.id, text.trimmingCharacters(in: .whitespacesAndNewlines), workParsedDate(envelope.timestamp)))
    }
  }
  var shown = CloudHeldShown()
  for message in messages {
    if sendIds.contains(message.messageId) {
      shown.messageIds.insert(message.messageId)
      continue
    }
    guard message.state == "sending" || message.state == "delivered",
          let text = nonEmptyTrimmed(message.text), let createdAt = message.createdAt else { continue }
    // Ten seconds of slack for the clocks of the phone's server and the
    // computer: the same words sent before the hold are another message.
    let heldAt = Date(timeIntervalSince1970: createdAt / 1000).addingTimeInterval(-10)
    if let index = unkeyed.firstIndex(where: { row in
      row.text == text
        && (row.at.map { $0 >= heldAt } ?? false)
        && (textMatchedRows[row.rowId].map { $0 == message.messageId } ?? true)
    }) {
      shown.textMatchedRows[unkeyed[index].rowId] = message.messageId
      unkeyed.remove(at: index)
      shown.messageIds.insert(message.messageId)
    }
  }
  return shown
}

/// A file sent with a message to a sleeping ADE Cloud chat.
struct CloudQueuedFile {
  static let maxCount = 10
  static let maxBytes = 25 * 1024 * 1024
  let name: String
  let contentType: String
  let data: Data
}

/// A message with files to a sleeping ADE Cloud chat whose computer runs an
/// older ADE with no message queue: the computer has been woken, and the
/// sender uploads the files over its live link.
struct CloudChatFilesNeedLiveLink: LocalizedError {
  var errorDescription: String? {
    "This chat's computer didn't wake in time to take the files. Try again in a moment."
  }
}
