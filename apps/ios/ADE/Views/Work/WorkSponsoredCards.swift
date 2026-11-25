import GravitySDK
import OSLog
import SwiftUI
import UIKit

// Sponsored cards in an ADE Cloud chat (`docs/plans/pricing-v2-and-gravity.md`),
// the phone's side of the desktop's `SponsoredReplySlot.tsx` and
// `SponsoredPickCard.tsx`. The account server decides; these only ask at the
// right moment and show what comes back (`CloudSponsored.swift`).
//
// Only in a chat whose own machine is an ADE Cloud lane computer
// (`WorkChatSessionView.sponsoredInstanceId`). Never in a subagent view, the
// Work list, a notification, a Live Activity, or a chat on the person's own
// machines. Nothing here rewards a view or a click.

// MARK: - Where the slot is on screen

/// A card answered for a format drawn away from the slot under the reply:
/// the dock above the prompt box, or the end of the reply.
struct WorkSponsoredPlacedAd: Equatable {
  let turnKey: String
  let turnId: String
  let ad: CloudSponsoredAd
  let format: CloudSponsoredFormat

  /// Changes whenever another card (or format) is placed.
  var key: String { "\(turnKey)|\(ad.id)|\(format.rawValue)" }
}

/// Where the place under a chat's last reply sits in the transcript, from the
/// transcript's own geometry (`WorkChatTranscriptGeometry`): a hosted cell is
/// not told when its scroll view moves. The slot is the row just above the
/// bottom gutter, so its place follows from the distance to the bottom.
/// Held by the chat as `@State`, so a change redraws only the sponsored views.
///
/// Also the hand-off between the slot (`WorkSponsoredReplySlot`) and the
/// reply's end (`WorkSponsoredInlineOutlet`): the slot publishes an inline
/// card (`placed`) and the reply's row draws it. The dock above the prompt
/// box asks for its own card (`WorkSponsoredDockSlot`): it is always on
/// screen, while the slot's cell may not exist during scrollback.
@MainActor
final class WorkSponsoredSlotModel: ObservableObject {
  /// Some of the slot is on screen: a card may be asked for.
  @Published private(set) var onScreen = false
  /// At least half of the slot (the card) is on screen: its view counts.
  @Published private(set) var halfOnScreen = false
  /// The chat screen is on screen (not covered by a pushed screen or gone).
  @Published private(set) var chatVisible = false
  /// The latest inline card answered for the reply's end.
  @Published private(set) var placed: WorkSponsoredPlacedAd?
  /// The end of the reply the inline line goes at is on screen.
  @Published private(set) var inlineOnScreen = false
  /// At least half of the inline line is on screen: its view counts.
  @Published private(set) var inlineHalfOnScreen = false
  /// What the slot under the reply draws now ("consent", "ad:<id>", or nil).
  /// The chat folds it into that row's revision, so the row is measured
  /// again when a card appears or goes: a cached height kept from before the
  /// card drew the card over the turn's footer and under the prompt box.
  @Published private(set) var shownKey: String?
  /// The ad the inline line at the reply's end draws now, as a key (nil while
  /// none draws). The chat folds it into the reply row's revision: the line can
  /// draw after the answer was placed (once the place is free), and a height
  /// cached before it squeezed the reply's last lines into the line.
  @Published private(set) var inlineShownKey: String?
  /// The slot's own height, as it last drew. Not published: geometry reads it.
  var height: CGFloat = 0
  /// The inline line's height, as it last drew (0 while it isn't drawn).
  var inlineHeight: CGFloat = 0
  /// The transcript row whose reply ends the finished turn, and that turn:
  /// where an inline line goes. Set by the chat as it builds its rows (the
  /// cells of that apply read it, and its geometry pass measures that row);
  /// not published.
  var inlineHost: (rowId: String, turnId: String)?

  func setChatVisible(_ visible: Bool) {
    if chatVisible != visible { chatVisible = visible }
  }

  func setShownKey(_ key: String?) {
    if shownKey != key { shownKey = key }
  }

  func setInlineShownKey(_ key: String?) {
    if inlineShownKey != key { inlineShownKey = key }
  }

  func place(_ next: WorkSponsoredPlacedAd) {
    if placed != next { placed = next }
  }

  #if DEBUG
  /// Fixture screens only: the slot on screen in a visible chat, with no transcript to measure.
  func seedPreviewOnScreen() {
    onScreen = true
    chatVisible = true
  }
  #endif

  /// `distanceFromBottom`: how far the content's end is below the visible
  /// bottom. `tail`: the gutter row under the slot. `visibleHeight`: the
  /// transcript between the header and the composer.
  func update(distanceFromBottom: CGFloat, tail: CGFloat, visibleHeight: CGFloat) {
    let next = Self.visibility(bottom: distanceFromBottom - tail, height: height, visibleHeight: visibleHeight)
    if onScreen != next.onScreen { onScreen = next.onScreen }
    if halfOnScreen != next.half { halfOnScreen = next.half }
  }

  /// The inline line's place: `below` is how far the content's end is below
  /// the line's bottom edge (nil while its row isn't in the transcript).
  func updateInline(distanceFromBottom: CGFloat, below: CGFloat?, visibleHeight: CGFloat) {
    let next = below.map {
      Self.visibility(bottom: distanceFromBottom - $0, height: inlineHeight, visibleHeight: visibleHeight)
    } ?? (onScreen: false, half: false)
    if inlineOnScreen != next.onScreen { inlineOnScreen = next.onScreen }
    if inlineHalfOnScreen != next.half { inlineHalfOnScreen = next.half }
  }

  /// `bottom`: the thing's bottom edge measured from the visible bottom, down positive.
  private static func visibility(bottom: CGFloat, height measured: CGFloat, visibleHeight: CGFloat) -> (onScreen: Bool, half: Bool) {
    let height = max(1, measured)
    let top = bottom - height
    let shown = max(0, min(0, bottom) - max(-visibleHeight, top))
    let onScreen = visibleHeight > 0 && top <= 0 && bottom >= -visibleHeight
    return (onScreen, onScreen && measured > 1 && shown >= height * 0.5)
  }
}

// MARK: - The slot under the last reply

/// Asks for a finished reply's sponsored card in the account's format
/// (`CloudSponsoredState.format`): it draws a card under the reply itself, or
/// hands an inline one to the reply's end (`WorkSponsoredSlotModel.placed`).
/// The docked format asks from the dock (`WorkSponsoredDockSlot`). Where the
/// chat has no such place (a sign-in card stands in for the prompt box, no
/// reply row to end), the card shows under the reply. The one-time question
/// is always asked here.
/// Asks only while the app is in front, the turn finished well (and in the
/// last day), and the card's place is on screen; once per turn per app run.
/// At most one card in the whole app (`CloudSponsoredStore.holder`).
struct WorkSponsoredReplySlot: View {
  let instanceId: String
  let sessionId: String
  let turn: CloudSponsoredTurn
  @ObservedObject var slot: WorkSponsoredSlotModel
  /// The prompt box is on screen, so a docked card has its place.
  var dockAvailable = false
  /// The transcript row whose reply ends this turn, so an inline line has its place.
  var inlineHostRowId: String? = nil
  @ObservedObject private var store = CloudSponsoredStore.shared
  @ObservedObject private var accountStore = AccountCloudStore.shared

  private enum Showing: Equatable {
    case consent
    case ad(CloudSponsoredAd)
  }

  private var turnKey: String { CloudSponsoredStore.turnKey(chatId: sessionId, turnId: turn.turnId) }
  private var sponsored: CloudSponsoredState? { accountStore.account?.sponsored }

  /// The format the card is drawn (and asked) in: the account's, or under
  /// the reply when the chat has no place for it.
  private var shownFormat: CloudSponsoredFormat {
    // A turn already asked for stays in the format it was asked in.
    if let asked = store.askedFormats[turnKey] { return asked }
    switch sponsored?.format ?? .belowReply {
    case .belowReply: return .belowReply
    case .abovePrompt: return dockAvailable ? .abovePrompt : .belowReply
    case .inline: return inlineHostRowId != nil ? .inline : .belowReply
    }
  }

  /// The card's place is on screen: the dock always is while the chat is.
  private var seen: Bool {
    switch shownFormat {
    case .belowReply: return slot.onScreen
    case .abovePrompt: return true
    case .inline: return slot.inlineOnScreen
    }
  }

  private var wanted: Bool {
    guard let sponsored, sponsored.ads, sponsored.consent != CloudSponsoredState.declined else { return false }
    return turn.isFresh() && !store.hiddenTurns.contains(turnKey) && store.appActive && slot.chatVisible
  }

  /// Another sponsored unit (a pick card, another chat's card) holds the one place.
  private var placeTaken: Bool { !store.placeFree(forChat: sessionId) }

  private var showing: Showing? {
    guard wanted, let sponsored else { return nil }
    // The question is always asked under the reply.
    if sponsored.consent == nil { return .consent }
    // A card shows, and holds the place, only while its spot is on screen.
    if sponsored.granted, shownFormat == .belowReply, slot.onScreen, let ad = store.ads[turnKey] { return .ad(ad) }
    return nil
  }

  var body: some View {
    let showing = showing
    let format = shownFormat
    VStack(alignment: .leading, spacing: 0) {
      if store.holder == sessionId {
        switch showing {
        case .consent:
          WorkSponsoredConsentCard(smallNeedsCards: sponsored?.smallUsesHoursWithoutCards == true, format: format, words: CloudBalanceWords(accountStore.account))
        case .ad(let ad):
          if let gravity = ad.gravity {
            WorkSponsoredGravityCard(ad: ad, gravity: gravity, sessionId: sessionId) {
              store.hide(chatId: sessionId, turnId: turn.turnId)
            }
          } else {
            WorkSponsoredAdCard(ad: ad, test: sponsored?.test == true, slot: slot) {
              store.hide(chatId: sessionId, turnId: turn.turnId)
            }
          }
        case nil:
          EmptyView()
        }
      }
    }
    .frame(maxWidth: .infinity, minHeight: 1, alignment: .leading)
    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { slot.height = $0 }
    .task(id: "\(turnKey)|\(sponsored?.granted == true)|\(wanted)|\(seen)|\(placeTaken)|\(format.rawValue)") { await askIfWanted() }
    .task(id: "\(showing != nil)|\(store.holder ?? "")") {
      if showing != nil { store.hold(sessionId) } else { store.release(sessionId) }
    }
    // The row under the reply is measured again whenever what it draws changes.
    .task(id: Self.shownKey(showing, holds: store.holder == sessionId)) {
      slot.setShownKey(Self.shownKey(showing, holds: store.holder == sessionId))
    }
    // The reply's end draws this turn's inline card.
    .task(id: "\(turnKey)|\(format.rawValue)|\(store.ads[turnKey]?.id ?? "")") {
      guard format == .inline, let ad = store.ads[turnKey] else { return }
      slot.place(WorkSponsoredPlacedAd(turnKey: turnKey, turnId: turn.turnId, ad: ad, format: format))
    }
    .onDisappear { store.release(sessionId) }
    .accessibilityElement(children: .contain)
  }

  private static func shownKey(_ showing: Showing?, holds: Bool) -> String? {
    guard holds, let showing else { return nil }
    switch showing {
    case .consent: return "consent"
    case .ad(let ad): return "ad:\(ad.id)"
    }
  }

  private func askIfWanted() async {
    // No ask while another sponsored unit holds the one place; the dock asks for its own.
    guard sponsored?.granted == true, wanted, seen, !placeTaken, shownFormat != .abovePrompt, store.ads[turnKey] == nil else { return }
    await workSponsoredAsk(instanceId: instanceId, sessionId: sessionId, turn: turn, format: shownFormat, store: store)
  }
}

/// One ask per turn (`CloudSponsoredStore.askAd`); a `not_cloud` answer (the
/// computer hadn't saved the chat's copy yet) is asked once more ~12 s later,
/// never more.
@MainActor
private func workSponsoredAsk(instanceId: String, sessionId: String, turn: CloudSponsoredTurn, format: CloudSponsoredFormat, store: CloudSponsoredStore) async {
  let key = CloudSponsoredStore.turnKey(chatId: sessionId, turnId: turn.turnId)
  store.noteAsked(turnKey: key, format: format)
  // A turn asked before keeps that format: the card is drawn only in the format it was asked in.
  let format = store.askedFormats[key] ?? format
  let ask: @MainActor () async -> CloudSponsoredAdAnswer = {
    guard let client = await SyncMenuSafePublisher.shared.service.cloudServerClient() else { return .unavailable }
    // Apple's tracking prompt, once, before the first card; the card is asked for whatever the answer.
    _ = await CloudSponsoredTracking.askOnce()
    do {
      return try await client.sponsoredAd(instanceId: instanceId, chatId: sessionId, turn: turn, device: .current, format: format)
    } catch {
      cloudSponsoredLog.notice("sponsored ad ask failed error=\(CrashReporting.redactedErrorDescription(error), privacy: .public)")
      return .unavailable
    }
  }
  while !Task.isCancelled {
    let answer = await store.askAd(turnKey: key, ask: ask)
    guard answer.shownAd == nil, answer.reason == "not_cloud" else { return }
    try? await Task.sleep(for: workSponsoredNotCloudRetry)
    guard !Task.isCancelled, store.takeNotCloudRetry(turnKey: key) else { return }
    store.forgetAnswer(turnKey: key)
  }
}

private let workSponsoredNotCloudRetry: Duration = .seconds(12)

/// Whether a card drawn away from the slot may show now: the store still
/// holds it (an account change clears the store, so another account's card
/// never draws), the account still shows cards in that format and said yes,
/// the app is in front, the chat is on screen, and the person didn't hide
/// that turn's card.
@MainActor
private func workSponsoredPlacedAllowed(_ placed: WorkSponsoredPlacedAd, slot: WorkSponsoredSlotModel, store: CloudSponsoredStore, account: AccountCloudStore) -> Bool {
  guard let sponsored = account.account?.sponsored, sponsored.ads, sponsored.granted,
        (sponsored.format ?? .belowReply) == placed.format,
        store.ads[placed.turnKey]?.id == placed.ad.id else { return false }
  return store.appActive && slot.chatVisible && !store.hiddenTurns.contains(placed.turnKey)
}

// MARK: - The dock above the prompt box

/// Directly above the prompt box: the latest finished reply's card, as one
/// row as wide as the prompt box. It asks for that card itself (the dock is
/// on screen whenever the chat is, even scrolled back), stays while the next
/// turn runs, and gives way to that reply's own card, or to nothing when it
/// gets none. Draws nothing (and takes no room) otherwise, and outside ADE
/// Cloud chats.
struct WorkSponsoredDockSlot: View {
  /// The ADE Cloud lane computer of a chat that may show cards; nil elsewhere.
  let instanceId: String?
  let sessionId: String
  /// A turn runs now: the previous reply's card stays.
  let turnActive: Bool
  /// The latest finished turn (fresh), or nil while one runs.
  let turn: CloudSponsoredTurn?
  @ObservedObject var slot: WorkSponsoredSlotModel
  @ObservedObject private var store = CloudSponsoredStore.shared
  @ObservedObject private var accountStore = AccountCloudStore.shared
  /// The latest finished reply's card, kept while the next turn runs.
  @State private var kept: WorkSponsoredPlacedAd?

  private var placeId: String { CloudSponsoredStore.placeId(sessionId: sessionId, format: .abovePrompt) }
  private var turnKey: String? { turn.map { CloudSponsoredStore.turnKey(chatId: sessionId, turnId: $0.turnId) } }
  private var sponsored: CloudSponsoredState? { accountStore.account?.sponsored }

  private var wanted: Bool {
    guard instanceId != nil, let sponsored, sponsored.ads, sponsored.granted, sponsored.format == .abovePrompt,
          let turn, let turnKey else { return false }
    return turn.isFresh() && !store.hiddenTurns.contains(turnKey) && store.appActive && slot.chatVisible
  }

  private var shown: WorkSponsoredPlacedAd? {
    guard instanceId != nil, let kept, kept.turnId == turn?.turnId || turnActive,
          workSponsoredPlacedAllowed(kept, slot: slot, store: store, account: accountStore) else { return nil }
    return kept
  }

  var body: some View {
    let shown = shown
    let wanted = wanted
    VStack(spacing: 0) {
      // Drawn at once (the hold below follows): the chat's own units never show together.
      if let shown, store.placeFree(forChat: sessionId) {
        Group {
          if let gravity = shown.ad.gravity {
            WorkSponsoredGravityCard(ad: shown.ad, gravity: gravity, sessionId: sessionId, place: .dock) {
              store.hide(chatId: sessionId, turnId: shown.turnId)
            }
          } else {
            WorkSponsoredDockCard(ad: shown.ad, test: accountStore.account?.sponsored?.test == true) {
              store.hide(chatId: sessionId, turnId: shown.turnId)
            }
          }
        }
        .padding(.bottom, 8)
        .transition(.opacity)
      }
    }
    .frame(maxWidth: .infinity)
    .animation(.easeInOut(duration: 0.18), value: shown?.turnKey)
    .task(id: "\(shown?.turnKey ?? "")|\(store.holder ?? "")") {
      if shown != nil { store.hold(placeId) } else { store.release(placeId) }
    }
    // A newly finished reply replaces the kept card with its own, or with none.
    .task(id: "\(turnKey ?? "")|\(turnKey.flatMap { store.ads[$0]?.id } ?? "")") {
      guard let turn, let turnKey else { return }
      if let ad = store.ads[turnKey], store.shows(turnKey: turnKey, in: .abovePrompt) {
        kept = WorkSponsoredPlacedAd(turnKey: turnKey, turnId: turn.turnId, ad: ad, format: .abovePrompt)
      } else if kept?.turnKey != turnKey {
        kept = nil
      }
    }
    .task(id: "\(turnKey ?? "")|\(wanted)|\(store.placeFree(forChat: sessionId))") {
      guard wanted, let instanceId, let turn, let turnKey, store.placeFree(forChat: sessionId), store.ads[turnKey] == nil else { return }
      await workSponsoredAsk(instanceId: instanceId, sessionId: sessionId, turn: turn, format: .abovePrompt, store: store)
    }
    .onDisappear { store.release(placeId) }
  }
}

// MARK: - The end of the reply

/// At the end of a finished turn's last reply, in the reply's own row: the
/// inline format's one linked sentence, once the slot placed one for this
/// turn. Takes no room otherwise. Not toggled as the reply scrolls in and out
/// (that would change the row's height under the reader); the ask waited for
/// the reply's end to be on screen, and the view counts only once half the
/// line is.
struct WorkSponsoredInlineOutlet: View {
  let sessionId: String
  let turnId: String
  @ObservedObject var slot: WorkSponsoredSlotModel
  @ObservedObject private var store = CloudSponsoredStore.shared
  @ObservedObject private var accountStore = AccountCloudStore.shared

  private var placeId: String { CloudSponsoredStore.placeId(sessionId: sessionId, format: .inline) }

  private var shown: WorkSponsoredPlacedAd? {
    guard let placed = slot.placed, placed.format == .inline, placed.turnId == turnId,
          placed.turnKey == CloudSponsoredStore.turnKey(chatId: sessionId, turnId: turnId),
          workSponsoredPlacedAllowed(placed, slot: slot, store: store, account: accountStore) else { return nil }
    return placed
  }

  var body: some View {
    let shown = shown
    let draws = shown != nil && store.placeFree(forChat: sessionId)
    VStack(alignment: .leading, spacing: 0) {
      // Drawn at once, so the row measures with it (the hold below follows).
      if let shown, draws {
        // ADE's own linked sentence, never a card (Gravity's design is a card).
        WorkSponsoredInlineLine(ad: shown.ad, test: accountStore.account?.sponsored?.test == true, slot: slot) {
          store.hide(chatId: sessionId, turnId: shown.turnId)
        }
        .padding(.top, 8)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { slot.inlineHeight = $0 }
    .task(id: draws ? shown?.key : nil) { slot.setInlineShownKey(draws ? shown?.key : nil) }
    .task(id: "\(shown?.turnKey ?? "")|\(store.holder ?? "")") {
      if shown != nil { store.hold(placeId) } else { store.release(placeId) }
    }
    .onDisappear { store.release(placeId) }
  }
}

// MARK: - The cards

/// The shared frame: quiet, native, never louder than the reply above it.
/// No accent fill, no motion, no images from outside.
private struct WorkSponsoredFrame<Content: View>: View {
  @ViewBuilder var content: () -> Content

  var body: some View {
    let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
    VStack(alignment: .leading, spacing: 5, content: content)
      .padding(.horizontal, 12)
      .padding(.vertical, 10)
      // As wide as the chat column, so it lines up with the composer below.
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(ADEColor.textPrimary.opacity(0.02), in: shape)
      .overlay(shape.strokeBorder(ADEKit.edge, lineWidth: 0.75))
      .padding(.top, 2)
  }
}

/// The brand's first letter on a small tile: no outside images.
private struct WorkSponsoredMonogram: View {
  let name: String
  var size: CGFloat = 16

  var body: some View {
    Text(name.first.map { String($0).uppercased() } ?? "·")
      .font(.system(size: size * 0.62, weight: .semibold))
      .foregroundStyle(ADEColor.textSecondary)
      .frame(width: size, height: size)
      .background(ADEColor.textPrimary.opacity(0.08), in: RoundedRectangle(cornerRadius: size / 4, style: .continuous))
      .accessibilityHidden(true)
  }
}

/// "Sponsored", or "Sponsored · test" for Gravity's test ads.
private func workSponsoredLabel(test: Bool, ad: CloudSponsoredAd) -> String {
  test || ad.test ? "Sponsored · test" : "Sponsored"
}

/// A small outline button ("Learn more", "Open site", "Use it").
private struct WorkSponsoredCTA: View {
  let title: String
  var external = false
  /// The smaller size for the cards' head row.
  var compact = false
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 4) {
        Text(title)
        if external {
          Image(systemName: "arrow.up.right")
            .font(.system(size: 9, weight: .bold))
            .accessibilityHidden(true)
        }
      }
      .font(.system(size: compact ? 11.5 : 12.5, weight: .medium))
      .foregroundStyle(ADEColor.textSecondary)
      .padding(.horizontal, compact ? 8 : 10)
      .frame(minHeight: compact ? 24 : 28)
      .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(ADEColor.textPrimary.opacity(0.14), lineWidth: 0.75))
      .contentShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
    }
    .buttonStyle(.plain)
  }
}

/// Opens a link outside the app, only when it is Gravity's own.
@MainActor
private func workSponsoredOpen(_ value: String?) {
  guard let url = cloudGravityURL(value) else { return }
  UIApplication.shared.open(url)
}

/// The one-time question, under the first finished reply of a Free cloud chat.
/// While the server's `smallNeedsCards` rule is on, a no has Free's Small
/// computers use hours, so the card says that up front.
struct WorkSponsoredConsentCard: View {
  var smallNeedsCards = false
  /// Where the cards show, so the question names the place.
  var format: CloudSponsoredFormat = .belowReply
  /// The account's unit (hours or credits).
  var words: CloudBalanceWords = .hours
  @State private var busy = false
  @State private var error: String?

  var body: some View {
    WorkSponsoredFrame {
      Text("ADE Cloud Free")
        .font(.system(size: 11.5))
        .foregroundStyle(ADEColor.textMuted)
      Text(smallNeedsCards ? "Keep Small computers unlimited" : "Free cloud chats are ad-supported")
        .font(.system(size: 13.5, weight: .semibold))
        .foregroundStyle(ADEColor.textPrimary)
        .fixedSize(horizontal: false, vertical: true)
      Text((smallNeedsCards
        ? "Free shows \(format.placeSentence) in ADE Cloud chats. Without them, \(words.smallWithoutCards). An agent may also recommend a sponsored tool."
        : "A Free chat on ADE Cloud can show \(format.placeSentence), and an agent may recommend a sponsored tool.")
        + " To pick them, ADE sends Gravity, our ad partner, your last message and the reply (or the agent's search), your IP address, your device type and a hashed copy of your account email. Sponsored cards are for people 18 or older. You can change this in Settings › ADE Cloud.")
        .font(.system(size: 12.5))
        .foregroundStyle(ADEColor.textSecondary)
        .lineSpacing(1.5)
        .fixedSize(horizontal: false, vertical: true)
      ViewThatFits(in: .horizontal) {
        HStack(spacing: 8) {
          answers
          Spacer(minLength: 8)
          howItWorks
        }
        VStack(alignment: .leading, spacing: 8) {
          HStack(spacing: 8) { answers }
          howItWorks
        }
        VStack(alignment: .leading, spacing: 8) {
          answers
          howItWorks
        }
      }
      .padding(.top, 4)
      if let error {
        Text(error)
          .font(.system(size: 11.5))
          .foregroundStyle(ADEColor.danger)
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Sponsored cards on ADE Cloud Free")
  }

  @ViewBuilder
  private var answers: some View {
    WorkSponsoredCTA(title: "Show sponsored cards") { answer(CloudSponsoredState.granted) }
      .disabled(busy)
    WorkSponsoredCTA(title: smallNeedsCards ? "No thanks, use my \(words.unit)" : "No thanks") { answer(CloudSponsoredState.declined) }
      .disabled(busy)
  }

  private var howItWorks: some View {
    Button("How it works") {
      if let url = URL(string: "https://ade-app.dev/privacy#sponsored") { UIApplication.shared.open(url) }
    }
    .buttonStyle(.plain)
    .font(.system(size: 12))
    .foregroundStyle(ADEColor.textMuted)
    .frame(minHeight: 28)
  }

  private func answer(_ consent: String) {
    guard !busy else { return }
    busy = true
    error = nil
    Task {
      if case .failure(let failure) = await cloudSaveSponsoredConsent(consent) { error = failure.message }
      busy = false
    }
  }
}

/// The head row both cards share: the brand's mark, the brand, "Sponsored",
/// then Learn more and hide at the top right, so the ad's own text below gets
/// the card's whole width. When the row does not fit (a narrow phone, a long
/// brand), Learn more moves under the text and hide stays top right.
private struct WorkSponsoredCardLayout<Copy: View>: View {
  let ad: CloudSponsoredAd
  let test: Bool
  let onHide: () -> Void
  @ViewBuilder var copy: () -> Copy

  var body: some View {
    // The copy has no width of its own (it wraps to what it is given), so
    // only the head row decides which layout fits.
    ViewThatFits(in: .horizontal) {
      VStack(alignment: .leading, spacing: 4) {
        head(.full)
        copyBox
      }
      VStack(alignment: .leading, spacing: 4) {
        head(.tight)
        copyBox
      }
      VStack(alignment: .leading, spacing: 4) {
        head(.tightest)
        copyBox
      }
      VStack(alignment: .leading, spacing: 4) {
        head(.noCTA)
        copyBox
        outlinedCTA
          .frame(maxWidth: .infinity, alignment: .trailing)
          .padding(.top, 2)
      }
    }
  }

  /// The head row, widest first: with the brand's mark and an outlined
  /// button; without the mark and with Learn more as a plain link (a phone);
  /// the same without a test ad's "test" mark; and without Learn more, which
  /// then sits under the text.
  private enum Head { case full, tight, tightest, noCTA }

  private var copyBox: some View {
    copy().frame(idealWidth: 0, maxWidth: .infinity, alignment: .leading)
  }

  private var outlinedCTA: some View {
    WorkSponsoredCTA(title: ad.cta ?? "Learn more", external: true, compact: true) { workSponsoredOpen(ad.clickUrl) }
      .fixedSize()
  }

  private var linkCTA: some View {
    Button { workSponsoredOpen(ad.clickUrl) } label: {
      HStack(spacing: 3) {
        Text(ad.cta ?? "Learn more")
        Image(systemName: "arrow.up.right")
          .font(.system(size: 9, weight: .bold))
          .accessibilityHidden(true)
      }
      .font(.system(size: 11.5, weight: .medium))
      .foregroundStyle(ADEColor.textSecondary)
      .frame(minHeight: 28)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .fixedSize()
  }

  private func head(_ head: Head) -> some View {
    HStack(spacing: 6) {
      if head == .full { WorkSponsoredMonogram(name: ad.brand) }
      Text(ad.brand)
        .font(.system(size: 11.5, weight: .medium))
        .foregroundStyle(ADEColor.textSecondary)
        .lineLimit(1)
      Text("· \(head == .tightest ? "Sponsored" : workSponsoredLabel(test: test, ad: ad))")
        .font(.system(size: 11.5))
        .foregroundStyle(ADEColor.textMuted)
        .lineLimit(1)
        .layoutPriority(1)
      Spacer(minLength: 6)
      switch head {
      case .full: outlinedCTA
      case .tight, .tightest: linkCTA
      case .noCTA: EmptyView()
      }
      Button(action: onHide) {
        Image(systemName: "xmark")
          .font(.system(size: 10, weight: .bold))
          .foregroundStyle(ADEColor.textMuted)
          .frame(width: 28, height: 28)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .padding(.vertical, -4)
      .padding(.leading, -4)
      .padding(.trailing, -6)
      .accessibilityLabel("Hide this card")
    }
  }
}

/// One sponsored card under the reply: the head row, then the title and the
/// text. Its view counts once half of it is on screen.
struct WorkSponsoredAdCard: View {
  let ad: CloudSponsoredAd
  let test: Bool
  @ObservedObject var slot: WorkSponsoredSlotModel
  @ObservedObject private var store = CloudSponsoredStore.shared
  let onHide: () -> Void

  var body: some View {
    WorkSponsoredFrame {
      WorkSponsoredCardLayout(ad: ad, test: test, onHide: onHide) {
        VStack(alignment: .leading, spacing: 3) {
          Button { workSponsoredOpen(ad.clickUrl) } label: {
            Text(ad.title)
              .font(.system(size: 13.5, weight: .semibold))
              .foregroundStyle(ADEColor.textPrimary)
              .multilineTextAlignment(.leading)
              .fixedSize(horizontal: false, vertical: true)
          }
          .buttonStyle(.plain)
          if !ad.text.isEmpty {
            Text(ad.text)
              .font(.system(size: 12.5))
              .foregroundStyle(ADEColor.textSecondary)
              .lineSpacing(1.5)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Sponsored: \(ad.brand)")
    .task(id: "\(ad.id)|\(slot.halfOnScreen)|\(store.appActive)") {
      if slot.halfOnScreen, store.appActive { store.noteViewed(ad) }
    }
  }
}

/// The docked card above the prompt box, as wide as the prompt box: the head
/// row, then the title and text as one line that wraps, never cut off
/// (Gravity's ask). Floats over the thread like the other rows above the
/// prompt box, so it carries its own glass. On screen whenever it draws (the
/// chat is on screen), so its view counts once it shows.
struct WorkSponsoredDockCard: View {
  let ad: CloudSponsoredAd
  let test: Bool
  @ObservedObject private var store = CloudSponsoredStore.shared
  let onHide: () -> Void

  var body: some View {
    WorkSponsoredCardLayout(ad: ad, test: test, onHide: onHide) {
      Button { workSponsoredOpen(ad.clickUrl) } label: {
        (Text(ad.title).fontWeight(.semibold).foregroundStyle(ADEColor.textPrimary)
          + Text(ad.text.isEmpty ? "" : " — \(ad.text)").foregroundStyle(ADEColor.textSecondary))
          .font(.system(size: 13))
          .multilineTextAlignment(.leading)
          .fixedSize(horizontal: false, vertical: true)
          .frame(maxWidth: .infinity, alignment: .leading)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("\(ad.title). \(ad.text)")
    }
    .padding(.leading, 12)
    .padding(.trailing, 10)
    .padding(.vertical, 9)
    .frame(maxWidth: .infinity, alignment: .leading)
    .workChatGlass(in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Sponsored: \(ad.brand)")
    .task(id: "\(ad.id)|\(store.appActive)") {
      if store.appActive { store.noteViewed(ad) }
    }
  }
}

/// The inline format: one linked sentence at the end of the reply, in the
/// reply's own flow and size, quieter. A small "Sponsored · brand" tag, the
/// ad's text as an underlined link to Gravity's tracked link, then hide. Its
/// view counts once half of it is on screen.
struct WorkSponsoredInlineLine: View {
  let ad: CloudSponsoredAd
  let test: Bool
  @ObservedObject var slot: WorkSponsoredSlotModel
  @ObservedObject private var store = CloudSponsoredStore.shared
  let onHide: () -> Void

  /// The hide mark's link: handled here, never opened.
  private static let hideURL = URL(string: "ade-sponsored:hide")!

  /// One run of text, so it wraps as the reply's own last sentence does: the
  /// tag, the ad's text as an underlined link (with its arrow), then hide.
  private var sentence: AttributedString {
    var tag = AttributedString("\(workSponsoredLabel(test: test, ad: ad)) · \(ad.brand)\u{2002}")
    tag.font = .caption
    tag.foregroundColor = ADEColor.textMuted
    var link = AttributedString(ad.text)
    link.link = URL(string: ad.clickUrl)
    link.foregroundColor = ADEColor.textSecondary
    link.underlineStyle = Text.LineStyle(pattern: .solid, color: ADEColor.textSecondary.opacity(0.4))
    var arrow = AttributedString("\u{2009}\u{2197}\u{FE0E}")
    arrow.link = URL(string: ad.clickUrl)
    arrow.font = .caption.weight(.semibold)
    arrow.foregroundColor = ADEColor.textMuted
    var gap = AttributedString("\u{2002}")
    gap.font = .caption
    var hide = AttributedString("\u{2009}\u{2715}\u{2009}")
    hide.link = Self.hideURL
    hide.font = .caption.weight(.semibold)
    hide.foregroundColor = ADEColor.textMuted
    return tag + link + arrow + gap + hide
  }

  var body: some View {
    Text(sentence)
      .font(WorkChatTypography.body)
      .tint(ADEColor.textSecondary)
      .multilineTextAlignment(.leading)
      .fixedSize(horizontal: false, vertical: true)
      .frame(maxWidth: .infinity, alignment: .leading)
      .environment(\.openURL, OpenURLAction { url in
        if url == Self.hideURL { onHide() } else { workSponsoredOpen(url.absoluteString) }
        return .handled
      })
      .accessibilityLabel("Sponsored, \(ad.brand): \(ad.text)")
      .accessibilityAddTraits(.isLink)
      .accessibilityAction { workSponsoredOpen(ad.clickUrl) }
      .accessibilityAction(named: "Hide this sponsored line", onHide)
      .task(id: "\(ad.id)|\(slot.inlineHalfOnScreen)|\(store.appActive)") {
        if slot.inlineHalfOnScreen, store.appActive { store.noteViewed(ad) }
      }
  }
}

// MARK: - Gravity's renderer

/// The one Gravity instance the cards draw with. Keyless on purpose: ADE's
/// Gravity key is the account server's secret, and the server asks for the
/// ads. On the phone the SDK only draws a card, sends its view and
/// viewability links, and opens its tracked link, none of which takes a key.
private let workSponsoredGravity = Gravity(apiKey: "")

/// Where a Gravity-drawn card sits: in the transcript (under the reply, or
/// at its end), or docked above the prompt box, floating over the thread.
enum WorkSponsoredGravityPlace {
  case transcript
  case dock
}

/// Gravity's design tokens (`$card`, `$border`, `$primary`...) in ADE's own
/// colors, so the card reads as ADE's in light and dark: the quiet fill and
/// hairline of ADE's sponsored card in the transcript, the prompt box's glass
/// in the dock, ADE's text tones, and the accent for the one filled button.
/// `$primary` is opaque: designs use it for text as well as for fills.
private enum WorkSponsoredGravityTheme {
  static let transcript = theme(card: ADEColor.textPrimary.opacity(0.02), radius: 12)
  /// The card's own fill is the glass behind it.
  static let dock = theme(card: .clear, radius: 14)

  private static func theme(card: Color, radius: CGFloat) -> GravityTheme {
    GravityTheme(
      background: ADEColor.pageBackground,
      foreground: ADEColor.textPrimary,
      card: card,
      cardForeground: ADEColor.textPrimary,
      primary: ADEColor.accent,
      primaryForeground: Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(white: 0.05, alpha: 1) : .white }),
      muted: ADEKit.track,
      mutedForeground: ADEColor.textSecondary,
      accent: ADEKit.pressed,
      accentForeground: ADEColor.textPrimary,
      border: ADEKit.edge,
      radius: radius
    )
  }
}

/// A sponsored card in Gravity's own design (`CloudSponsoredAd.gravity`),
/// drawn by Gravity's renderer (`SpecAdView`) in ADE's colors, under the reply
/// and docked above the prompt box (the inline format is ADE's own linked
/// sentence, `WorkSponsoredInlineLine`). The renderer sends the card's view link once half of it is on
/// screen, and its measured and viewable links, and opens Gravity's tracked
/// link on a tap; so nothing here calls `noteViewed` (that would count the
/// view twice). ADE keeps the rest: the place, the one card on screen, and
/// hide, a small round badge on the card's top right corner, outside the
/// design so it never covers the design's own "Sponsored" or its copy.
struct WorkSponsoredGravityCard: View {
  let ad: CloudSponsoredAd
  let gravity: AdResponse
  /// The chat: the renderer's session (it only labels feedback, which ADE leaves off).
  let sessionId: String
  var place: WorkSponsoredGravityPlace = .transcript
  let onHide: () -> Void

  /// The hide badge's size, and how far it reaches past the card's top and
  /// right edges (its center sits on the corner). The card keeps that much
  /// room above it, so its slot's frame holds the whole badge.
  private static let badge: CGFloat = 22
  private static var overhang: CGFloat { badge / 2 }

  var body: some View {
    card
      .overlay(alignment: .topTrailing) { hideBadge }
      .padding(.top, Self.overhang)
      .frame(maxWidth: .infinity, alignment: .leading)
      // No label of its own: the design's link already reads as the whole
      // card, its "Sponsored" included (a label here hid the card's children).
      .accessibilityElement(children: .contain)
  }

  @ViewBuilder
  private var card: some View {
    switch place {
    case .transcript:
      SpecAdView(ad: gravity, gravity: workSponsoredGravity, sessionId: sessionId, theme: WorkSponsoredGravityTheme.transcript, showFeedback: false)
    case .dock:
      SpecAdView(ad: gravity, gravity: workSponsoredGravity, sessionId: sessionId, theme: WorkSponsoredGravityTheme.dock, showFeedback: false)
        .workChatGlass(in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
  }

  /// A 44 pt target around the badge, reaching out past the corner more than
  /// into the card: inside the card it stays within the design's padding,
  /// clear of its "Sponsored" label.
  private var hideBadge: some View {
    let target: CGFloat = 44
    let inside: CGFloat = 14
    let shift = target - inside
    return Button(action: onHide) {
      Image(systemName: "xmark")
        .font(.system(size: 8.5, weight: .bold))
        .foregroundStyle(ADEColor.textSecondary)
        .frame(width: Self.badge, height: Self.badge)
        .background(ADEColor.raisedBackground, in: Circle())
        .overlay(Circle().strokeBorder(ADEColor.border, lineWidth: 0.75))
        .padding(.leading, inside - Self.overhang)
        .padding(.bottom, inside - Self.overhang)
        .frame(width: target, height: target, alignment: .bottomLeading)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .offset(x: shift, y: -shift)
    .accessibilityLabel("Hide this card")
    // Read after the card it hides.
    .accessibilitySortPriority(-1)
  }
}

// MARK: - Someone is watching (`useSponsoredViewer`)

/// Draws nothing. While a chat or terminal of an ADE Cloud computer is on
/// screen and the account said yes, tells the account server so at most
/// every few minutes (`POST /cloud/sponsored/seen`): the Index answers an
/// agent there only while someone watches. Its own view, so the screen that
/// carries it doesn't redraw for the account or the app's state.
struct WorkSponsoredViewerBeacon: View {
  /// The ADE Cloud lane computer on screen; nil on the person's own machine.
  let instanceId: String?
  /// The chat's slot, told whether the chat screen is on screen; nil for a terminal.
  var slot: WorkSponsoredSlotModel? = nil
  @ObservedObject private var store = CloudSponsoredStore.shared
  @ObservedObject private var accountStore = AccountCloudStore.shared
  /// The screen that carries this is on screen (appeared and not covered).
  @State private var visible = false

  private var enabled: Bool {
    guard let sponsored = accountStore.account?.sponsored else { return false }
    return sponsored.ads && sponsored.granted
  }

  var body: some View {
    Color.clear
      .frame(width: 0, height: 0)
      .accessibilityHidden(true)
      .onAppear {
        visible = true
        slot?.setChatVisible(true)
      }
      .onDisappear {
        visible = false
        slot?.setChatVisible(false)
      }
      .task(id: "\(instanceId ?? "")|\(enabled)|\(store.appActive)|\(visible)") {
        guard let instanceId, enabled, store.appActive, visible else { return }
        while !Task.isCancelled {
          await store.noteSeen(instanceId: instanceId)
          try? await Task.sleep(for: .seconds(CloudSponsoredStore.seenInterval))
        }
      }
  }
}

// MARK: - The Index's pick (`sponsored_pick`)

/// The facts a `sponsored_pick` card carries (`sponsoredPickOfCard`), or nil
/// for any other card, or one whose link isn't Gravity's.
struct WorkSponsoredPickFacts: Equatable {
  let name: String
  let category: String?
  let description: String
  let need: String
  /// Gravity's tracked link: the only link the card opens.
  let url: String
  let steps: [String]

  init?(_ card: WorkAdeCardModel) {
    guard card.variant == cloudSponsoredPickVariant, card.id.hasPrefix("sponsored-pick:") else { return nil }
    func row(_ key: String) -> WorkAdeCardRow? { card.rows.first { $0.key == key } }
    guard let url = row("sponsored_url")?.detail, cloudGravityURL(url) != nil else { return nil }
    name = card.title
    category = card.subtitle.flatMap { nonEmptyTrimmed($0) }
    description = row("sponsored_description")?.text ?? ""
    need = row("sponsored_need")?.text ?? ""
    self.url = url
    steps = card.rows.filter { $0.key == "sponsored_step" }.map(\.text)
  }

  /// What Use it puts in the prompt box (`sponsoredPickUseText`): the person sends it, or edits it first.
  var useText: String {
    let lines = steps.map { "- \($0)" }.joined(separator: "\n")
    return lines.isEmpty ? "Set up \(name) for this." : "Set up \(name) for this.\n\(lines)"
  }
}

/// An agent's Sponsored recommendation (`cloud.recommend`, Gravity's Index):
/// calm, labeled, and inert. Open site follows Gravity's tracked link; Use it
/// puts the steps in the prompt box, so nothing is set up until the person
/// sends it. Not now folds it to one line. Where the chat has no prompt box
/// (a subagent's view, a read-only look) there is no Use it.
struct WorkSponsoredPickCard: View {
  let card: WorkAdeCardModel
  @Environment(\.workSceneBridge) private var bridge
  @ObservedObject private var store = CloudSponsoredStore.shared
  @ObservedObject private var accountCloud = AccountCloudStore.shared

  /// The account may see sponsored cards now; one that said no or moved to a paid plan sees old picks folded, with nothing to open.
  private var allowed: Bool {
    guard let sponsored = accountCloud.account?.sponsored else { return false }
    return sponsored.ads && sponsored.consent == CloudSponsoredState.granted
  }

  /// The pick counts as the one sponsored unit on screen while it shows open.
  private var placeId: String { "pick:\(card.id)" }

  var body: some View {
    if let facts = WorkSponsoredPickFacts(card) {
      let foldedByPerson = store.foldedPicks.contains(card.id)
      // Another sponsored unit holds the place: one line, nothing to open.
      let placeTaken = store.holder != nil && store.holder != placeId
      Group {
        if foldedByPerson || placeTaken || !allowed {
          HStack(spacing: 6) {
            Text("Sponsored · \(facts.name)")
              .font(.system(size: 11.5))
              .foregroundStyle(ADEColor.textMuted)
              .lineLimit(1)
            if foldedByPerson && !placeTaken && allowed {
              Button("Show") { store.setPickFolded(card.id, false) }
                .buttonStyle(.plain)
                .font(.system(size: 11.5, weight: .medium))
                .foregroundStyle(ADEColor.textSecondary)
                .frame(minHeight: 28)
            }
          }
          .frame(minHeight: 28)
        } else {
          full(facts)
        }
      }
      .task(id: "\(foldedByPerson)|\(allowed)|\(store.holder ?? "")") {
        if foldedByPerson || !allowed { store.release(placeId) } else { store.hold(placeId) }
      }
      .onDisappear { store.release(placeId) }
    } else {
      Text(card.fallbackText)
        .font(.system(size: 12.5))
        .foregroundStyle(ADEColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private func full(_ facts: WorkSponsoredPickFacts) -> some View {
    WorkSponsoredFrame {
      HStack(spacing: 6) {
        WorkSponsoredMonogram(name: facts.name)
        Text(facts.name)
          .font(.system(size: 11.5, weight: .medium))
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
        Text(facts.category.map { "· Sponsored · \($0)" } ?? "· Sponsored")
          .font(.system(size: 11.5))
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(1)
          .layoutPriority(1)
        Spacer(minLength: 0)
      }
      if !facts.description.isEmpty {
        Text(facts.description)
          .font(.system(size: 12.5))
          .foregroundStyle(ADEColor.textSecondary)
          .lineSpacing(1.5)
          .fixedSize(horizontal: false, vertical: true)
      }
      if !facts.need.isEmpty {
        Text("For: \(facts.need)")
          .font(.system(size: 11.5))
          .foregroundStyle(ADEColor.textMuted)
          .fixedSize(horizontal: false, vertical: true)
      }
      HStack(spacing: 8) {
        WorkSponsoredCTA(title: "Open site", external: true) { workSponsoredOpen(facts.url) }
        if let bridge, bridge.canReply {
          WorkSponsoredCTA(title: "Use it") { bridge.reply(facts.useText) }
        }
        Button("Not now") { store.setPickFolded(card.id, true) }
          .buttonStyle(.plain)
          .font(.system(size: 12))
          .foregroundStyle(ADEColor.textMuted)
          .frame(minHeight: 28)
      }
      .padding(.top, 4)
      Text("The agent installs nothing unless you ask.")
        .font(.system(size: 11))
        .foregroundStyle(ADEColor.textMuted)
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Sponsored recommendation: \(facts.name)")
  }
}
