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
  /// Held messages by chat (`chatKey`), oldest first.
  @Published private(set) var queued: [String: [CloudChatQueuedMessage]] = [:]
  /// "Keep it" went through for these computers this run.
  @Published private(set) var keptInstanceIds: Set<String> = []

  /// Bumped on an account change: an answer to the last account's read lands nowhere.
  private var accountGeneration = 0
  /// Where the next older page of a saved chat starts (`nextBefore`), by thread key.
  private var transcriptCursors: [String: Int] = [:]
  /// Saved chats read this run, by thread key: one read per open.
  private var transcriptReads: [String: Task<Void, Never>] = [:]

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
    async let accessRead: Access? = try? decodeAccess(client)
    async let accountRead = readAccount(client)
    async let lanesRead = readLanesWithoutComputer(client)
    let (nextAccess, nextAccount, nextLanes) = await (accessRead, accountRead, lanesRead)
    guard generation == accountGeneration, AccountService.shared.isPairingCommitAuthorized(owner) else { return }
    if let nextAccess, nextAccess != access { access = nextAccess }
    if let nextAccount, nextAccount != account { account = nextAccount }
    if let nextLanes, nextLanes != lanesWithoutComputer { lanesWithoutComputer = nextLanes }
  }

  private func decodeAccess(_ client: CloudServerClient) async throws -> Access {
    let data = try await client.send("GET", "cloud/access")
    return try JSONDecoder().decode(Access.self, from: data)
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
      return nil
    } catch {
      accountCloudLog.notice("cloud_store read=lanes_without_computer failed error=\(CrashReporting.redactedErrorDescription(error), privacy: .public)")
      return nil
    }
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

  /// Hands a message for an existing cloud chat to the server's queue. The
  /// server wakes the chat's own computer (or makes a new one for a lane
  /// whose computer was deleted) and delivers the message once, keyed on
  /// `messageId` (the composer's send id).
  func queueSend(machineKey: String, chatId: String, messageId: String, text: String, using sync: SyncService) async -> SendOutcome {
    let generation = accountGeneration
    guard let client = await sync.cloudServerClient() else { return .failed("Sign in to ADE to send this message.") }
    let key = Self.chatKey(machineKey: machineKey, chatId: chatId)
    do {
      let result = try await client.queueMessage(machineKey: machineKey, chatId: chatId, messageId: messageId, text: text)
      guard generation == accountGeneration else { return .failed("The account changed. Send the message again.") }
      upsert(result.message, key: key)
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

  func openMessages(machineKey: String, chatId: String) -> [CloudChatQueuedMessage] {
    (queued[Self.chatKey(machineKey: machineKey, chatId: chatId)] ?? []).filter(\.isOpen)
  }

  /// Follows one chat's held messages while the chat is open and the app is
  /// in front: every 3 s, slowing to 10 s while nothing changes, until no
  /// message waits. The view's task cancels it when the chat closes.
  /// `onDelivered` runs when a message left the queue (the computer is up).
  func followQueue(machineKey: String, chatId: String, using sync: SyncService, onDelivered: @escaping @MainActor () async -> Void) async {
    let key = Self.chatKey(machineKey: machineKey, chatId: chatId)
    var delay: UInt64 = 3
    // Read once at open: another device may have queued a message.
    await reconcile(machineKey: machineKey, chatId: chatId, using: sync)
    while !Task.isCancelled {
      guard (queued[key] ?? []).contains(where: \.isOpen) else { return }
      try? await Task.sleep(nanoseconds: delay * 1_000_000_000)
      if Task.isCancelled { return }
      guard UIApplication.shared.applicationState == .active else { delay = 10; continue }
      let openBefore = Set((queued[key] ?? []).filter(\.isOpen).map(\.messageId))
      await reconcile(machineKey: machineKey, chatId: chatId, using: sync)
      let openAfter = Set((queued[key] ?? []).filter(\.isOpen).map(\.messageId))
      if openAfter != openBefore {
        delay = 3
        if !openBefore.subtracting(openAfter).isEmpty { await onDelivered() }
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
    } catch {
      // An older server has no queue route; a failed read keeps the last list.
      return
    }
    guard generation == accountGeneration else { return }
    let key = Self.chatKey(machineKey: machineKey, chatId: chatId)
    let next = messages.sorted { ($0.seq ?? 0) < ($1.seq ?? 0) }
    if queued[key] != next { queued[key] = next }
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
      let events = await Task.detached(priority: .userInitiated) {
        accountCloudDecodeParts(page.parts)
      }.value
      guard generation == self.accountGeneration, !Task.isCancelled else { return }
      self.transcriptCursors[id] = page.hasMore ? page.nextBefore : nil
      sync.chatThreadRegistry.routeSnapshot(
        ChatThreadSnapshotInput(
          sessionId: sessionId,
          events: events,
          hasOlderHistory: page.hasMore,
          turnActive: false,
          sessionFound: true
        ),
        key: key
      )
    }
  }

  /// The next older part of a saved chat, for the thread engine's scroll-back.
  func olderSavedPage(key: ChatThreadKey, accountMachineKey: String, using sync: SyncService) async throws -> ChatThreadOlderPageInput {
    guard let before = transcriptCursors[key.description] else {
      return ChatThreadOlderPageInput(sessionId: key.sessionId, events: [], hasMore: false)
    }
    guard let client = await sync.cloudServerClient() else {
      return .failed(sessionId: key.sessionId, message: "Sign in to ADE to read earlier messages.")
    }
    let page = try await client.transcriptPage(machineKey: accountMachineKey, chatId: key.sessionId, before: before)
    let events = await Task.detached(priority: .userInitiated) {
      accountCloudDecodeParts(page.parts)
    }.value
    transcriptCursors[key.description] = page.hasMore ? page.nextBefore : nil
    return ChatThreadOlderPageInput(sessionId: key.sessionId, events: events, hasMore: page.hasMore)
  }

  // MARK: Account change

  func reset() {
    accountGeneration &+= 1
    access = nil
    account = nil
    lanesWithoutComputer = []
    queued = [:]
    keptInstanceIds = []
    transcriptCursors = [:]
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
/// order they happened. A line that does not decode is left out alone.
func accountCloudDecodeParts(_ parts: [CloudChatTranscriptPage.Part]) -> [ChatThreadLiveEvent] {
  var events: [ChatThreadLiveEvent] = []
  for part in parts.sorted(by: { $0.seq < $1.seq }) {
    for line in part.text.split(whereSeparator: \.isNewline) {
      guard let data = line.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data),
            let event = chatThreadDecodeLiveEvent(object) else { continue }
      events.append(event)
    }
  }
  return events
}
