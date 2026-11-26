import OSLog
import SwiftUI
import UIKit

// An agent's size request in its chat (`cloud_tier_request`,
// `shared/cloudTierRequest.ts`): the phone's side of the desktop's
// `CloudTierRequestCard`. The person answers here; the answer goes to the
// chat's own machine (`cloud.tier_request_answer`), which marks the card
// answered for every surface and tells the agent. The change itself runs with
// the phone's own sign-in on the account server (`CloudServerClient`), as the
// ADE Cloud page's size change does. The server can't hold a resize until the
// agent is idle, so the phone offers "Do it now" and "Keep the size".

private let tierRequestLog = Logger(subsystem: "com.ade.ios", category: "cloud-tier-request")

let cloudTierRequestVariant = "cloud_tier_request"

/// The request a `cloud_tier_request` card carries (`cloudTierRequestOfCard`),
/// or nil for any other card or one missing its ids.
struct WorkCloudTierRequestFacts: Equatable {
  let requestId: String
  let instanceId: String
  let computerName: String
  let fromSizeId: String?
  let fromLabel: String?
  let toSizeId: String
  let toLabel: String
  let reason: String
  /// The size row's words as the agent's machine wrote them: "1 credit an hour on Medium (4 now)".
  let rateText: String?
  /// What the card says the person answered (`idle`, `now`, `dismiss`); nil while it still asks.
  let answer: String?
  /// How the change ended as the card says (`online`, `failed`, `cancelled`); nil before it ends.
  let outcome: String?

  init?(_ card: WorkAdeCardModel) {
    guard card.variant == cloudTierRequestVariant, card.id.hasPrefix("cloud-tier-request:") else { return nil }
    func row(_ key: String) -> WorkAdeCardRow? { card.rows.first { $0.key == key } }
    let requestId = String(card.id.dropFirst("cloud-tier-request:".count))
    guard !requestId.isEmpty,
          let computer = row("tier_request_computer"), let instanceId = computer.detail.flatMap({ nonEmptyTrimmed($0) }),
          let size = row("tier_request_size"), let sizeId = size.detail.flatMap({ nonEmptyTrimmed($0) }) else { return nil }
    self.requestId = requestId
    self.instanceId = instanceId
    computerName = computer.text
    toSizeId = sizeId
    toLabel = row("tier_request_to_label").flatMap { nonEmptyTrimmed($0.text) } ?? sizeId
    let from = row("tier_request_from")
    fromSizeId = from?.detail.flatMap { nonEmptyTrimmed($0) }
    fromLabel = from.map { $0.text.hasPrefix("Now ") ? String($0.text.dropFirst(4)) : $0.text }
    reason = row("tier_request_reason")?.text ?? ""
    // An older machine's row starts "To Medium, …"; the rates are then in the label only.
    rateText = size.text.hasPrefix("To ") ? nil : nonEmptyTrimmed(size.text)
    let answered = row("tier_request_answer")?.detail
    answer = ["idle", "now", "dismiss"].contains(answered ?? "") ? answered : nil
    let ended = row("tier_request_outcome")?.detail
    outcome = ["online", "failed", "cancelled"].contains(ended ?? "") ? ended : nil
  }
}

/// What the phone did with one request, while the card's own answer is on its way.
enum WorkCloudTierRequestRun: Equatable {
  /// The answer or the change is on its way; the sentence says which.
  case working(String)
  /// It went through here: the sentence until the card says so itself.
  case done(String)
  case failed(String)
}

/// The phone's answers to size requests, by request: a change runs on after
/// its card scrolls away, and two taps never start two changes.
@MainActor
final class WorkCloudTierRequestRuns: ObservableObject {
  static let shared = WorkCloudTierRequestRuns()

  @Published private(set) var runs: [String: WorkCloudTierRequestRun] = [:]
  /// The computers a change of this phone runs on: one change of a computer at a time.
  private var changing: Set<String> = []

  /// A chat the phone couldn't tell how its change ended is tried again after
  /// these waits: its computer restarts, or (a move) the chat shows up on the
  /// new computer once the phone's machine list has it.
  private let tellRetrySeconds: [UInt64] = [15, 30, 60, 120, 180, 240]
  private let pollSeconds: UInt64 = 5
  private let moveWaitMaxSeconds: Double = 30 * 60
  private let resizeWaitMaxSeconds: Double = 10 * 60

  func isWorking(_ requestId: String) -> Bool {
    if case .working = runs[requestId] { return true }
    return false
  }

  /// Keep the size: the agent is told, on the chat's own machine.
  func keepSize(_ facts: WorkCloudTierRequestFacts, sessionId: String) async {
    guard !isWorking(facts.requestId), let sync = SyncService.shared else { return }
    runs[facts.requestId] = .working("Telling the agent…")
    do {
      try await sync.answerCloudTierRequest(chatSessionId: sessionId, requestId: facts.requestId, answer: "dismiss")
      runs[facts.requestId] = .done("You kept \(facts.computerName) at its size.")
      ADEHaptics.success()
    } catch {
      tierRequestLog.notice("tier_request answer=dismiss failed error=\(CrashReporting.redactedErrorDescription(error), privacy: .public)")
      runs[facts.requestId] = .failed("ADE couldn't tell the agent: \(cloudWithoutStop(error.localizedDescription)).")
      ADEHaptics.error()
    }
  }

  /// Do it now: the agent hears the yes on its chat's machine, the change runs
  /// on the account server with the phone's sign-in (a resize, or a move to
  /// the other kind), and the chat hears how it ended. Again after a failed
  /// change: the card's yes stands, and the new end is told.
  func changeNow(_ facts: WorkCloudTierRequestFacts, sessionId: String) async {
    guard !isWorking(facts.requestId), !changing.contains(facts.instanceId), let sync = SyncService.shared else { return }
    changing.insert(facts.instanceId)
    defer { changing.remove(facts.instanceId) }
    runs[facts.requestId] = .working("Starting the change…")
    var background = UIBackgroundTaskIdentifier.invalid
    background = UIApplication.shared.beginBackgroundTask(withName: "ade.cloud.tier-request") {
      UIApplication.shared.endBackgroundTask(background)
      background = .invalid
    }
    defer {
      if background != .invalid { UIApplication.shared.endBackgroundTask(background) }
    }
    func refuse(_ sentence: String) {
      runs[facts.requestId] = .failed(sentence)
      ADEHaptics.error()
    }

    guard let client = await sync.cloudServerClient() else { return refuse("Sign in to ADE, then try again.") }
    let account: CloudPhoneAccount?
    if let known = AccountCloudStore.shared.account {
      account = known
    } else {
      account = try? await client.account()
    }
    guard let tier = cloudPhoneTiers(account?.catalog).first(where: { $0.id == facts.toSizeId }) else {
      return refuse("ADE Cloud doesn't offer that size now.")
    }
    let box: CloudServerInstance
    do {
      box = try await client.instance(facts.instanceId)
    } catch {
      return refuse(cloudPhoneWords(cloudServerFailureMessage(error)) ?? "ADE Cloud couldn't read this computer.")
    }
    // A disk can't shrink (a move keeps it too): refused before anything stops.
    if let disk = box.resources?.disk, let max = tier.diskMaxGb, disk > max {
      return refuse("\(tier.label) holds a disk of up to \(cloudGbText(max)) GB, and this computer's disk is \(cloudGbText(disk)) GB. A disk can't shrink, so pick a size that holds it.")
    }
    let move = (box.type == "vm" ? "vm" : "default") != tier.type

    // The yes first, while the chat's computer is still up: a resize restarts it.
    do {
      try await sync.answerCloudTierRequest(chatSessionId: sessionId, requestId: facts.requestId, answer: "now")
    } catch {
      // As the desktop: the person said yes, so the change goes on; the end is told below.
      tierRequestLog.notice("tier_request answer=now failed error=\(CrashReporting.redactedErrorDescription(error), privacy: .public)")
    }

    let outcome: (end: String, error: String?)
    if move {
      runs[facts.requestId] = .working("Moving \(facts.computerName) to \(tier.withArticle). It takes a few minutes.")
      let request = sync.cloudTierRequestChatPin(sessionId: sessionId).map {
        CloudMoveChatRequest(requestId: facts.requestId, chatSessionId: sessionId, pin: $0)
      }
      outcome = await runMove(client: client, facts: facts, tier: tier, request: request)
    } else {
      runs[facts.requestId] = .working("Changing \(facts.computerName) to \(tier.label). It restarts on the new size.")
      let result = await client.changeSize(instanceId: facts.instanceId, to: tier)
      outcome = result.ok
        ? await waitForSize(client: client, facts: facts, tier: tier, wasAwake: box.status == "running")
        : ("failed", cloudPhoneWords(result.message) ?? result.message)
    }
    switch outcome.end {
    case "online":
      runs[facts.requestId] = .done("\(facts.computerName) is on \(tier.label) now.")
      ADEHaptics.success()
    case "cancelled":
      runs[facts.requestId] = .done("The change was cancelled. \(facts.computerName) kept its size.")
    case "running":
      // Still going on the server: nothing to tell yet; whoever follows it there tells the chat.
      runs[facts.requestId] = .done(outcome.error ?? "The move is still running. Follow it on the ADE Cloud page.")
      return
    default:
      runs[facts.requestId] = .failed("The change to \(tier.label) stopped\(outcome.error.map { ": \(cloudWithoutStop($0))" } ?? "").")
      ADEHaptics.error()
    }
    await tellEnd(sync: sync, facts: facts, sessionId: sessionId, outcome: outcome)
  }

  /// A resize the server took, followed until the computer reads the new CPU
  /// and memory (and runs again, when it was awake): then it is online.
  private func waitForSize(client: CloudServerClient, facts: WorkCloudTierRequestFacts, tier: CloudPhoneTier, wasAwake: Bool) async -> (end: String, error: String?) {
    let since = Date()
    while Date().timeIntervalSince(since) < resizeWaitMaxSeconds {
      if let box = try? await client.instance(facts.instanceId), let size = box.resources,
         size.cpu == tier.cpu, size.memory == tier.memoryGb, !wasAwake || box.status == "running" {
        return ("online", nil)
      }
      try? await Task.sleep(nanoseconds: pollSeconds * 1_000_000_000)
    }
    return ("failed", "It isn't back on \(tier.label) after 10 minutes. Check it on the ADE Cloud page")
  }

  /// The server's move to the other kind, followed until it ends. A move that
  /// waits on the person's approval shows on the ADE Cloud page. The request
  /// rides on the move's record, so the desktop and ADE Web tell the chat too.
  private func runMove(client: CloudServerClient, facts: WorkCloudTierRequestFacts, tier: CloudPhoneTier, request: CloudMoveChatRequest?) async -> (end: String, error: String?) {
    let moveId = UUID().uuidString.lowercased()
    var record: CloudServerMove
    do {
      record = try await client.startMove(instanceId: facts.instanceId, to: tier.full ? "full" : "standard", sizeId: tier.id, moveId: moveId, request: request)
    } catch CloudServerClient.Failure.noAccess {
      return ("failed", cloudPhoneKindChangeReason(to: tier))
    } catch {
      return ("failed", cloudPhoneWords(cloudServerFailureMessage(error)) ?? "ADE Cloud couldn't start the move")
    }
    // The server answers a move already running for this computer instead: not this request's.
    guard record.moveId.lowercased() == moveId else {
      return ("failed", "Another change of this computer is already running. Follow it on the ADE Cloud page")
    }
    let since = Date()
    while !record.isFinished, Date().timeIntervalSince(since) < moveWaitMaxSeconds {
      if record.approval != nil {
        runs[facts.requestId] = .working("The move waits for you. Finish it on the ADE Cloud page.")
      }
      try? await Task.sleep(nanoseconds: pollSeconds * 1_000_000_000)
      if let fresh = try? await client.move(record.moveId) { record = fresh }
    }
    switch record.state {
    case "done": return ("online", nil)
    case "cancelled": return ("cancelled", nil)
    case "failed": return ("failed", record.error ?? cloudPhoneWords(record.message))
    default: return ("running", "The move is still running. Follow it on the ADE Cloud page.")
    }
  }

  /// How the change ended, to the chat's own machine, tried again while that
  /// computer comes back from its restart (or the chat shows up on the new
  /// computer after a move: the route is read again on every try).
  private func tellEnd(sync: SyncService, facts: WorkCloudTierRequestFacts, sessionId: String, outcome: (end: String, error: String?)) async {
    var attempt = 0
    while true {
      do {
        try await sync.answerCloudTierRequest(
          chatSessionId: sessionId,
          requestId: facts.requestId,
          answer: "now",
          outcome: outcome.end,
          error: outcome.end == "failed" ? outcome.error : nil
        )
        return
      } catch {
        guard attempt < tellRetrySeconds.count else {
          tierRequestLog.notice("tier_request tell_end failed outcome=\(outcome.end, privacy: .public) error=\(CrashReporting.redactedErrorDescription(error), privacy: .public)")
          return
        }
        try? await Task.sleep(nanoseconds: tellRetrySeconds[attempt] * 1_000_000_000)
        attempt += 1
      }
    }
  }
}

/// An agent's size request in its chat: what it asks for and why, the rates
/// now and after, and two buttons. Answered (here or anywhere), it is one
/// line with the answer, and "Try again" after a failed change.
struct WorkCloudTierRequestCard: View {
  let card: WorkAdeCardModel
  let sessionId: String
  /// False where the phone can't reach the chat's machine to answer (a
  /// cross-project quick look): the card reads, with no buttons.
  var canAct: Bool = true
  @ObservedObject private var runs = WorkCloudTierRequestRuns.shared
  @ObservedObject private var accountCloud = AccountCloudStore.shared

  var body: some View {
    if let facts = WorkCloudTierRequestFacts(card), !sessionId.isEmpty {
      if facts.answer != nil || card.isTerminal {
        let run = runs.runs[facts.requestId]
        VStack(alignment: .leading, spacing: 2) {
          answeredLine(card.subtitle.flatMap { nonEmptyTrimmed($0) } ?? card.fallbackText)
          // This phone's change still runs (a move waiting on approval), ended
          // before the card says so, or stopped: say so under the answer.
          switch run {
          case .working(let text): runLine(text, tone: ADEColor.textSecondary)
          case .done(let text) where facts.outcome == nil: runLine(text, tone: ADEColor.textSecondary)
          case .failed(let text): runLine(text, tone: ADEColor.warning)
          default: EmptyView()
          }
          if canRetry(facts, run: run) {
            Button {
              Task { await runs.changeNow(facts, sessionId: sessionId) }
            } label: {
              Text("Try again")
                .font(.system(size: 12.5, weight: .semibold))
                .foregroundStyle(ADEColor.accentBright)
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background(ADEColor.accent.opacity(0.12), in: Capsule(style: .continuous))
                .overlay(Capsule(style: .continuous).stroke(ADEColor.accent.opacity(0.36), lineWidth: 1))
            }
            .buttonStyle(.plain)
            .padding(.top, 4)
          }
        }
      } else {
        asking(facts)
      }
    } else {
      Text(card.fallbackText)
        .font(.system(size: 12.5))
        .foregroundStyle(ADEColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private func runLine(_ text: String, tone: Color) -> some View {
    Text(text)
      .font(.system(size: 12))
      .foregroundStyle(tone)
      .fixedSize(horizontal: false, vertical: true)
  }

  private func answeredLine(_ text: String) -> some View {
    Text(text)
      .font(.system(size: 12.5))
      .foregroundStyle(ADEColor.textMuted)
      .fixedSize(horizontal: false, vertical: true)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.vertical, 4)
  }

  /// The rates now → after from the account's catalog when the phone has it,
  /// else the size row the agent's machine wrote.
  private func rates(_ facts: WorkCloudTierRequestFacts) -> String? {
    let tiers = cloudPhoneTiers(accountCloud.account?.catalog)
    let words = CloudBalanceWords(accountCloud.account)
    guard let to = tiers.first(where: { $0.id == facts.toSizeId }) else { return facts.rateText }
    let from = facts.fromSizeId.flatMap { id in tiers.first { $0.id == id } }
    let line = words.changeRates(from: from, to: to)
    let hours = accountCloud.account.flatMap { words.hoursOn(to, leftMilli: $0.hoursLeftMilli) }
    return hours.map { "\(line). \($0)" } ?? line
  }

  private func asking(_ facts: WorkCloudTierRequestFacts) -> some View {
    let run = runs.runs[facts.requestId]
    let working = runs.isWorking(facts.requestId)
    return VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 6) {
        Image(systemName: "cloud")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(ADEColor.accent)
        Text(card.title.isEmpty ? "Change \(facts.computerName) to \(facts.toLabel)?" : card.title)
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .fixedSize(horizontal: false, vertical: true)
        Spacer(minLength: 0)
        Text("The agent asks")
          .font(.system(size: 11))
          .foregroundStyle(ADEColor.textMuted)
      }
      HStack(spacing: 6) {
        Text(facts.fromLabel ?? "Now")
        Image(systemName: "arrow.right").font(.system(size: 10, weight: .semibold))
        Text(facts.toLabel).fontWeight(.semibold)
      }
      .font(.system(size: 12.5))
      .foregroundStyle(ADEColor.textSecondary)
      .accessibilityElement(children: .combine)
      .accessibilityLabel("From \(facts.fromLabel ?? "its size") to \(facts.toLabel)")
      if let rates = rates(facts) {
        Text(rates)
          .font(.system(size: 12).monospacedDigit())
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      if !facts.reason.isEmpty {
        Text("Why: \(facts.reason)")
          .font(.system(size: 12))
          .foregroundStyle(ADEColor.textMuted)
          .fixedSize(horizontal: false, vertical: true)
      }
      switch run {
      case .working(let text), .done(let text):
        Text(text)
          .font(.system(size: 12))
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      case .failed(let text):
        Text(text)
          .font(.system(size: 12))
          .foregroundStyle(ADEColor.warning)
          .fixedSize(horizontal: false, vertical: true)
      case nil:
        Text(isMove(facts)
          ? "ADE moves it to a new computer in a few minutes: files and chats come along, the running turn stops."
          : "It restarts on the new size in about 2 minutes: files and chats stay, the running turn stops.")
          .font(.system(size: 11.5))
          .foregroundStyle(ADEColor.textMuted)
          .fixedSize(horizontal: false, vertical: true)
      }
      if canAct && !isDone(run) {
        HStack(spacing: 8) {
          Button {
            Task { await runs.changeNow(facts, sessionId: sessionId) }
          } label: {
            Text(working ? "Working…" : "Do it now")
              .font(.system(size: 12.5, weight: .semibold))
              .foregroundStyle(ADEColor.accentBright)
              .padding(.horizontal, 12)
              .padding(.vertical, 7)
              .background(ADEColor.accent.opacity(0.12), in: Capsule(style: .continuous))
              .overlay(Capsule(style: .continuous).stroke(ADEColor.accent.opacity(0.36), lineWidth: 1))
          }
          .buttonStyle(.plain)
          .disabled(working)
          Button {
            Task { await runs.keepSize(facts, sessionId: sessionId) }
          } label: {
            Text("Keep the size")
              .font(.system(size: 12.5, weight: .medium))
              .foregroundStyle(ADEColor.textSecondary)
              .padding(.horizontal, 12)
              .padding(.vertical, 7)
              .overlay(Capsule(style: .continuous).stroke(ADEColor.glassBorder, lineWidth: 1))
          }
          .buttonStyle(.plain)
          .disabled(working)
          Spacer(minLength: 0)
        }
        .padding(.top, 2)
      }
    }
    .padding(12)
    .background(ADEColor.cardBackground.opacity(0.45), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(ADEColor.accent.opacity(0.26), lineWidth: 1))
    .accessibilityElement(children: .contain)
  }

  /// Standard and full computers are different kinds: a change between them is a move to a new computer.
  private func isMove(_ facts: WorkCloudTierRequestFacts) -> Bool {
    guard let from = facts.fromSizeId.flatMap(cloudPhoneTierType(id:)), let to = cloudPhoneTierType(id: facts.toSizeId) else { return false }
    return from != to
  }

  /// A yes whose change failed, here or as the card says: the same change again.
  private func canRetry(_ facts: WorkCloudTierRequestFacts, run: WorkCloudTierRequestRun?) -> Bool {
    guard canAct, facts.answer == "now" || facts.answer == "idle" else { return false }
    switch run {
    case .failed: return true
    case nil: return facts.outcome == "failed"
    default: return false
    }
  }

  private func isDone(_ run: WorkCloudTierRequestRun?) -> Bool {
    if case .done = run { return true }
    return false
  }
}
