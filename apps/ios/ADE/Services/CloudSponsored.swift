import AppTrackingTransparency
import Foundation
import OSLog
import UIKit

let cloudSponsoredLog = Logger(subsystem: "com.ade.ios", category: "cloud-sponsored")

// Sponsored cards in ADE Cloud chats (Gravity, `apps/account-directory/src/cloud/gravity.ts`).
//
// Account-wide, like the plan: the account server decides everything (its
// switch, the Free plan, the country, the person's answer, and that a chat's
// computer is one of the account's ADE Cloud computers). The phone reads the
// answer from `GET /cloud/account` (`CloudPhoneAccount.sponsored`), asks for a
// card at the right moment, and shows what comes back. Every call here takes
// the account token and no machine pin: none of them runs on a computer.
//
// The desktop's version is `apps/desktop/src/renderer/components/chat/sponsored/`.
// Nothing here rewards a view or a click.

// MARK: - Wire shapes (`CloudSponsored*` in contract.ts)

/// Whether the account's ADE Cloud chats show sponsored cards (`CloudSponsoredState`).
struct CloudSponsoredState: Decodable, Equatable {
  /// Cards may show in this account's ADE Cloud chats now, once `consent` is granted.
  let ads: Bool
  /// `granted`, `declined`, or nil when the one-time question was never answered.
  let consent: String?
  /// Gravity's test ads: nothing is paid or counted.
  let test: Bool

  static let granted = "granted"
  static let declined = "declined"

  init(ads: Bool, consent: String?, test: Bool) {
    self.ads = ads
    self.consent = consent
    self.test = test
  }

  private enum CodingKeys: String, CodingKey { case ads, consent, test }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    ads = c.lenient(Bool.self, forKey: .ads) ?? false
    let raw = c.lenient(String.self, forKey: .consent)
    consent = raw == Self.granted || raw == Self.declined ? raw : nil
    test = c.lenient(Bool.self, forKey: .test) ?? false
  }

  var granted: Bool { consent == Self.granted }
}

/// One card (`CloudSponsoredAd`). A card whose click link isn't Gravity's
/// never shows (`CloudSponsoredAdAnswer.shownAd`).
struct CloudSponsoredAd: Decodable, Equatable {
  let id: String
  let brand: String
  let title: String
  let text: String
  let cta: String?
  /// Gravity's tracked link (a redirect to the advertiser): the only link a card opens.
  let clickUrl: String
  /// Requested once, when at least half of the card is on screen.
  let impUrl: String?
  let test: Bool

  init(id: String, brand: String, title: String, text: String, cta: String?, clickUrl: String, impUrl: String?, test: Bool) {
    self.id = id
    self.brand = brand
    self.title = title
    self.text = text
    self.cta = cta
    self.clickUrl = clickUrl
    self.impUrl = impUrl
    self.test = test
  }

  private enum CodingKeys: String, CodingKey { case id, brand, title, text, cta, clickUrl, impUrl, test }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    brand = try c.decode(String.self, forKey: .brand)
    title = try c.decode(String.self, forKey: .title)
    text = c.lenient(String.self, forKey: .text) ?? ""
    cta = c.lenient(String.self, forKey: .cta).flatMap { nonEmptyTrimmed($0) }
    clickUrl = try c.decode(String.self, forKey: .clickUrl)
    impUrl = c.lenient(String.self, forKey: .impUrl)
    test = c.lenient(Bool.self, forKey: .test) ?? false
  }
}

/// `POST /cloud/sponsored/ad`'s answer: a card, or why none (still a 200).
struct CloudSponsoredAdAnswer: Decodable, Equatable {
  let ad: CloudSponsoredAd?
  /// `off`, `plan`, `country`, `consent`, `not_cloud`, `limit`, `no_fill`, `unavailable`.
  let reason: String?

  static let unavailable = CloudSponsoredAdAnswer(ad: nil, reason: "unavailable")

  init(ad: CloudSponsoredAd?, reason: String?) {
    self.ad = ad
    self.reason = reason
  }

  private enum CodingKeys: String, CodingKey { case ad, reason }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    ad = c.lenient(CloudSponsoredAd.self, forKey: .ad)
    reason = c.lenient(String.self, forKey: .reason)
  }

  /// The card to show: only one whose click link is Gravity's own.
  var shownAd: CloudSponsoredAd? {
    guard let ad, cloudGravityURL(ad.clickUrl) != nil else { return nil }
    return ad
  }
}

/// The screen the card would show on, as Gravity wants it (`CloudSponsoredDevice`).
struct CloudSponsoredDevice: Encodable, Equatable {
  let type: String
  let os: String
  let osVersion: String?
  let ua: String?
  /// The App Tracking Transparency answer. The server sends Gravity the
  /// account's hashed email only when it is "authorized".
  let tracking: String?

  /// This iPhone or iPad. The user agent is the app's own plain one.
  @MainActor static var current: CloudSponsoredDevice {
    let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
    return CloudSponsoredDevice(
      type: UIDevice.current.userInterfaceIdiom == .pad ? "tablet" : "mobile",
      os: "ios",
      osVersion: UIDevice.current.systemVersion,
      ua: "ADE-iOS/\(version ?? "0")",
      tracking: CloudSponsoredTracking.status
    )
  }
}

/// Apple's App Tracking Transparency for sponsored cards. The prompt shows
/// once, right before the first card is asked for in an ADE Cloud chat (the
/// person already said yes to sponsored cards). Whatever the answer, the card
/// is still asked for: without "authorized" the server leaves the hashed
/// email out of what Gravity gets.
enum CloudSponsoredTracking {
  @MainActor static var status: String { name(ATTrackingManager.trackingAuthorizationStatus) }

  /// Shows Apple's prompt when it has never been answered and the app is in
  /// front (the system ignores it otherwise); returns the answer as sent.
  @MainActor static func askOnce() async -> String {
    let current = ATTrackingManager.trackingAuthorizationStatus
    guard current == .notDetermined, UIApplication.shared.applicationState == .active else { return name(current) }
    return name(await ATTrackingManager.requestTrackingAuthorization())
  }

  private static func name(_ status: ATTrackingManager.AuthorizationStatus) -> String {
    switch status {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "not_determined"
    @unknown default: return "not_determined"
    }
  }
}

/// One message as an ad request sends it: the latest request and reply only.
struct CloudSponsoredMessage: Encodable, Equatable {
  let role: String
  let content: String
}

/// Gravity reads at most this much of each message (`CLOUD_SPONSORED_MESSAGE_MAX_CHARS`).
let cloudSponsoredMessageMaxChars = 4_000

/// Gravity's own hosts (`isGravityUrl`): a card's view and click links must be
/// on one of them, so a card can't send anyone, or this app's request,
/// anywhere else. The URL, or nil.
func cloudGravityURL(_ value: String?) -> URL? {
  guard let value, let url = URL(string: value), url.scheme?.lowercased() == "https",
        let host = url.host?.lowercased() else { return nil }
  let ok = ["trygravity.ai", "trygravity.com"].contains { host == $0 || host.hasSuffix(".\($0)") }
  return ok ? url : nil
}

// MARK: - The account server's routes (account token, no pin)

extension CloudServerClient {
  private struct ConsentBody: Encodable { let consent: String }
  private struct SeenBody: Encodable { let instanceId: String; let device: CloudSponsoredDevice }
  private struct AdBody: Encodable {
    let instanceId: String
    let chatId: String
    let turnId: String
    let messages: [CloudSponsoredMessage]
    let device: CloudSponsoredDevice
  }

  /// `PUT /cloud/sponsored/consent`: the account's answer, on every device at
  /// once. Answers the account's sponsored state as it is now.
  func setSponsoredConsent(_ consent: String) async throws -> CloudSponsoredState {
    let body = try JSONEncoder().encode(ConsentBody(consent: consent))
    return try decode(CloudSponsoredState.self, from: try await send("PUT", "cloud/sponsored/consent", body: body))
  }

  /// `POST /cloud/sponsored/seen`: a person has a chat or terminal of this ADE
  /// Cloud computer on screen. The server keeps it only for an account that said yes.
  func sponsoredSeen(instanceId: String, device: CloudSponsoredDevice) async throws {
    let body = try JSONEncoder().encode(SeenBody(instanceId: instanceId, device: device))
    _ = try await send("POST", "cloud/sponsored/seen", body: body)
  }

  /// `POST /cloud/sponsored/ad`: one card under a finished reply. Asking again
  /// for the same turn answers the same card.
  func sponsoredAd(instanceId: String, chatId: String, turn: CloudSponsoredTurn, device: CloudSponsoredDevice) async throws -> CloudSponsoredAdAnswer {
    let body = try JSONEncoder().encode(AdBody(instanceId: instanceId, chatId: chatId, turnId: turn.turnId, messages: turn.messages, device: device))
    return try decode(CloudSponsoredAdAnswer.self, from: try await send("POST", "cloud/sponsored/ad", body: body))
  }
}

/// Saves the account's answer and shows it everywhere at once: the state
/// the server answered, or the sentence to show when it didn't save.
@MainActor
func cloudSaveSponsoredConsent(_ consent: String) async -> Result<CloudSponsoredState, CloudSponsoredSaveFailure> {
  guard let client = await SyncMenuSafePublisher.shared.service.cloudServerClient() else {
    return .failure(CloudSponsoredSaveFailure(message: "Sign in to ADE, then try again."))
  }
  // The answer belongs to the account that gave it: one signed in since doesn't take it.
  let generation = AccountCloudStore.shared.generation
  do {
    let state = try await client.setSponsoredConsent(consent)
    // A no deletes the account's viewer rows on the server.
    if !state.granted { CloudSponsoredStore.shared.forgetSeen() }
    AccountCloudStore.shared.noteSponsored(state, generation: generation)
    return .success(state)
  } catch {
    cloudSponsoredLog.notice("sponsored consent save failed error=\(CrashReporting.redactedErrorDescription(error), privacy: .public)")
    return .failure(CloudSponsoredSaveFailure(message: "ADE couldn't save that. Try again."))
  }
}

struct CloudSponsoredSaveFailure: Error {
  let message: String
}

// MARK: - The turn a card goes under (`sponsoredTurn.ts`)

/// A card is asked for only under a reply this recent: an old chat opened later gets none.
let cloudSponsoredTurnFreshSeconds: TimeInterval = 24 * 60 * 60

/// The chat's last turn when it finished well and nothing came after it.
struct CloudSponsoredTurn: Equatable {
  let turnId: String
  let finishedAt: Date?
  /// The person's request and the agent's reply, the only text an ad request sends.
  let messages: [CloudSponsoredMessage]

  func isFresh(now: Date = Date()) -> Bool {
    guard let finishedAt else { return false }
    return now.timeIntervalSince(finishedAt) < cloudSponsoredTurnFreshSeconds
  }
}

/// The variant of the card an agent's `cloud.recommend` posts (`SPONSORED_PICK_CARD_VARIANT`).
let cloudSponsoredPickVariant = "sponsored_pick"

/// The chat's last turn when it finished well (`done`, `completed`) and
/// nothing came after it: its id, when it ended, and its request and reply.
/// Nil while a turn runs, after a failed or stopped turn, when the person
/// already wrote again, or when the reply carries a Sponsored pick (one
/// Gravity card is enough). Mirrors `lastFinishedTurn`.
func cloudSponsoredLastFinishedTurn(_ events: [WorkChatEnvelope]) -> CloudSponsoredTurn? {
  var doneIndex: Int?
  var doneTurnId = ""
  scan: for index in events.indices.reversed() {
    switch events[index].event {
    case .userMessage:
      return nil
    case .done(let status, _, _, let turnId, _, _, _):
      guard status == "completed" else { return nil }
      doneIndex = index
      doneTurnId = turnId
      break scan
    default:
      continue
    }
  }
  guard let doneIndex, !doneTurnId.isEmpty else { return nil }
  var reply: [String] = []
  var request = ""
  var index = doneIndex - 1
  back: while index >= 0 {
    switch events[index].event {
    case .userMessage(let text, _, _, _, _, _):
      request = text
      break back
    case .assistantText(let text, let turnId, _):
      let own = turnId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      if own.isEmpty || own == doneTurnId { reply.append(text) }
    case .adeCard(let card):
      if card.variant == cloudSponsoredPickVariant { return nil }
    default:
      break
    }
    index -= 1
  }
  let answer = cloudSponsoredTail(reply.reversed().joined())
  let asked = cloudSponsoredTail(request)
  guard !answer.isEmpty, !asked.isEmpty else { return nil }
  return CloudSponsoredTurn(
    turnId: doneTurnId,
    finishedAt: workActivityTimestamp(events[doneIndex].timestamp),
    messages: [CloudSponsoredMessage(role: "user", content: asked), CloudSponsoredMessage(role: "assistant", content: answer)]
  )
}

/// The end of a message within the server's limit, counted as it counts
/// (UTF-16 units, like the desktop's string length), never splitting a character.
private func cloudSponsoredTail(_ text: String) -> String {
  let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
  guard trimmed.utf16.count > cloudSponsoredMessageMaxChars else { return trimmed }
  var units = 0
  var start = trimmed.endIndex
  while start > trimmed.startIndex {
    let previous = trimmed.index(before: start)
    let width = trimmed[previous...].prefix(1).utf16.count
    if units + width > cloudSponsoredMessageMaxChars { break }
    units += width
    start = previous
  }
  return String(trimmed[start...])
}

// MARK: - This app run's sponsored state

/// What this app run knows about sponsored cards: one ask per chat turn, the
/// ads it answered, the cards the person hid, the one place on screen, and
/// when each computer was last said to be watched. Nothing here is the
/// truth about the account; that is `CloudPhoneAccount.sponsored`.
@MainActor
final class CloudSponsoredStore: ObservableObject {
  static let shared = CloudSponsoredStore()

  /// The app is in front (`UIApplication` active): nothing is asked or counted otherwise.
  @Published private(set) var appActive: Bool
  /// The chat whose card is on screen now: at most one in the whole app
  /// (Gravity's rule, and ours). Nil: no sponsored card shows.
  @Published private(set) var holder: String?
  /// Cards answered this run, by `chatId:turnId`.
  @Published private(set) var ads: [String: CloudSponsoredAd] = [:]
  /// Turns whose card the person hid this run.
  @Published private(set) var hiddenTurns: Set<String> = []
  /// Sponsored picks (`sponsored_pick` cards, by card id) folded with Not now this run.
  @Published private(set) var foldedPicks: Set<String> = []

  private static let answerLimit = 50
  private static let seenEvery: TimeInterval = 4 * 60
  private var answers: [String: Task<CloudSponsoredAdAnswer, Never>] = [:]
  private var answerOrder: [String] = []
  private var retriedNotCloud: Set<String> = []
  private var viewedAds: Set<String> = []
  private var lastSeenAt: [String: Date] = [:]
  /// The tracking answer each computer's viewer row last got: a changed
  /// answer (tracking turned off in Settings) is said at once, not after the interval.
  private var lastSeenTracking: [String: String] = [:]
  /// The seen request in flight per computer: the next one waits for it, so
  /// an older answer can never land after a newer one.
  private var seenInFlight: [String: Task<Void, Never>] = [:]
  /// Account changes this run: an ask that spans one publishes nothing.
  private var resetCount = 0
  private var observers: [NSObjectProtocol] = []
  /// No cookies, no cache, no redirects: a view link is one plain GET to
  /// Gravity's own host, and a redirect elsewhere is never followed.
  private lazy var viewSession: URLSession = {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 10
    return URLSession(configuration: configuration, delegate: CloudSponsoredNoRedirects(), delegateQueue: nil)
  }()

  private init() {
    appActive = UIApplication.shared.applicationState == .active
    let center = NotificationCenter.default
    observers = [
      center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
        MainActor.assumeIsolated { CloudSponsoredStore.shared.setAppActive(true) }
      },
      center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { _ in
        MainActor.assumeIsolated { CloudSponsoredStore.shared.setAppActive(false) }
      },
    ]
  }

  private func setAppActive(_ active: Bool) {
    if appActive != active { appActive = active }
  }

  static func turnKey(chatId: String, turnId: String) -> String { "\(chatId):\(turnId)" }

  /// Asks the account server once per turn per run; a second ask answers the first's.
  func askAd(turnKey: String, ask: @escaping @MainActor () async -> CloudSponsoredAdAnswer) async -> CloudSponsoredAdAnswer {
    let task: Task<CloudSponsoredAdAnswer, Never>
    if let known = answers[turnKey] {
      task = known
    } else {
      task = Task { @MainActor in await ask() }
      answers[turnKey] = task
      answerOrder.append(turnKey)
      if answerOrder.count > Self.answerLimit {
        let oldest = answerOrder.removeFirst()
        answers[oldest] = nil
      }
    }
    let resets = resetCount
    let answer = await task.value
    // Another account signed in while this ask ran: its card is not theirs.
    guard resets == resetCount else { return .unavailable }
    if let ad = answer.shownAd, ads[turnKey] != ad { ads[turnKey] = ad }
    // A failed ask (Gravity down, offline) is not the turn's answer: the
    // server freed the turn, so the next look asks again.
    if answer.reason == "unavailable", answers[turnKey] == task { forgetAnswer(turnKey: turnKey) }
    return answer
  }

  /// A chat's first reply can be asked about before its computer saved the
  /// chat's copy (`not_cloud`): one more ask a little later, never more.
  /// True the first time for a turn; the answer is then forgotten.
  func takeNotCloudRetry(turnKey: String) -> Bool {
    guard retriedNotCloud.insert(turnKey).inserted else { return false }
    return true
  }

  func forgetAnswer(turnKey: String) {
    answers[turnKey] = nil
    answerOrder.removeAll { $0 == turnKey }
  }

  func hide(turnKey: String) {
    hiddenTurns.insert(turnKey)
  }

  func setPickFolded(_ cardId: String, _ folded: Bool) {
    if folded { foldedPicks.insert(cardId) } else { foldedPicks.remove(cardId) }
  }

  /// Takes the one place for `slotId`; false while another chat holds it.
  @discardableResult
  func hold(_ slotId: String) -> Bool {
    if holder == slotId { return true }
    guard holder == nil else { return false }
    holder = slotId
    return true
  }

  func release(_ slotId: String) {
    if holder == slotId { holder = nil }
  }

  /// Gravity's view link, once per card per run, only on Gravity's own host.
  /// Not delivered (offline, Gravity down): the next time half the card is
  /// on screen sends it again.
  func noteViewed(_ ad: CloudSponsoredAd) {
    guard appActive, let url = cloudGravityURL(ad.impUrl), viewedAds.insert(ad.id).inserted else { return }
    var request = URLRequest(url: url)
    request.httpMethod = "GET"
    let session = viewSession
    let adId = ad.id
    Task { @MainActor in
      do {
        let (_, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        // Delivered, or refused for good (a 4xx other than "too many"): never sent twice.
        if status > 0 && status < 500 && status != 429 { return }
        cloudSponsoredLog.notice("sponsored view not delivered status=\(status, privacy: .public)")
      } catch {
        cloudSponsoredLog.notice("sponsored view not delivered error=\(CrashReporting.redactedErrorDescription(error), privacy: .public)")
      }
      CloudSponsoredStore.shared.viewedAds.remove(adId)
    }
  }

  /// Someone is watching this computer's chat or terminal: the Index may
  /// answer its agents. At most once per computer every few minutes, but at
  /// once when the tracking answer changed: the server picks what Gravity
  /// gets from the latest one, so a "no" must not wait out the interval.
  func noteSeen(instanceId: String) async {
    guard appActive else { return }
    let now = Date()
    let tracking = CloudSponsoredTracking.status
    if let last = lastSeenAt[instanceId], now.timeIntervalSince(last) < Self.seenEvery, lastSeenTracking[instanceId] == tracking { return }
    lastSeenAt[instanceId] = now
    let previous = seenInFlight[instanceId]
    let send = Task { @MainActor [self] in
      await previous?.value
      await sendSeen(instanceId: instanceId, at: now)
    }
    seenInFlight[instanceId] = send
    await send.value
    if seenInFlight[instanceId] == send { seenInFlight[instanceId] = nil }
  }

  private func sendSeen(instanceId: String, at now: Date) async {
    guard let client = await SyncMenuSafePublisher.shared.service.cloudServerClient() else {
      lastSeenAt[instanceId] = nil
      lastSeenTracking[instanceId] = nil
      return
    }
    // The answer as sent, read after any earlier report finished: the next
    // look compares against what the server actually got.
    let device = CloudSponsoredDevice.current
    lastSeenTracking[instanceId] = device.tracking
    do {
      try await client.sponsoredSeen(instanceId: instanceId, device: device)
    } catch {
      // Not said: the next look tries again instead of waiting out the interval.
      if lastSeenAt[instanceId] == now {
        lastSeenAt[instanceId] = nil
        lastSeenTracking[instanceId] = nil
      }
      cloudSponsoredLog.notice("sponsored seen failed error=\(CrashReporting.redactedErrorDescription(error), privacy: .public)")
    }
  }

  static var seenInterval: TimeInterval { seenEvery }

  /// Another account signed in: nothing of the last one's cards stays.
  /// The person said no: the next yes reports their presence at once.
  func forgetSeen() {
    lastSeenAt = [:]
    lastSeenTracking = [:]
  }

  func reset() {
    resetCount &+= 1
    for task in answers.values { task.cancel() }
    answers = [:]
    answerOrder = []
    retriedNotCloud = []
    ads = [:]
    hiddenTurns = []
    foldedPicks = []
    holder = nil
    lastSeenAt = [:]
    lastSeenTracking = [:]
    seenInFlight = [:]
  }

  #if DEBUG
  /// Fixture screens only: a card for a turn, with no account server.
  func seedPreview(turnKey: String, ad: CloudSponsoredAd) {
    ads[turnKey] = ad
    answers[turnKey] = Task { CloudSponsoredAdAnswer(ad: ad, reason: nil) }
  }
  #endif
}

/// Refuses every redirect: the view link's GET ends at Gravity's own host.
private final class CloudSponsoredNoRedirects: NSObject, URLSessionTaskDelegate, Sendable {
  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest,
    completionHandler: @escaping @Sendable (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }
}
