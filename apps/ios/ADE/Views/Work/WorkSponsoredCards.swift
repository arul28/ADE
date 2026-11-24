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

/// Where the place under a chat's last reply sits in the transcript, from the
/// transcript's own geometry (`WorkChatTranscriptGeometry`): a hosted cell is
/// not told when its scroll view moves. The slot is the row just above the
/// bottom gutter, so its place follows from the distance to the bottom.
/// Held by the chat as `@State`, so a change redraws only the slot.
@MainActor
final class WorkSponsoredSlotModel: ObservableObject {
  /// Some of the slot is on screen: a card may be asked for.
  @Published private(set) var onScreen = false
  /// At least half of the slot (the card) is on screen: its view counts.
  @Published private(set) var halfOnScreen = false
  /// The chat screen is on screen (not covered by a pushed screen or gone).
  @Published private(set) var chatVisible = false
  /// The slot's own height, as it last drew. Not published: geometry reads it.
  var height: CGFloat = 0

  func setChatVisible(_ visible: Bool) {
    if chatVisible != visible { chatVisible = visible }
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
    let height = max(1, self.height)
    // Measured from the visible bottom, down positive.
    let bottom = distanceFromBottom - tail
    let top = bottom - height
    let shown = max(0, min(0, bottom) - max(-visibleHeight, top))
    let nextOnScreen = visibleHeight > 0 && top <= 0 && bottom >= -visibleHeight
    let nextHalf = nextOnScreen && self.height > 1 && shown >= height * 0.5
    if onScreen != nextOnScreen { onScreen = nextOnScreen }
    if halfOnScreen != nextHalf { halfOnScreen = nextHalf }
  }
}

// MARK: - The slot under the last reply

/// One sponsored card under a finished reply, or the one-time question.
/// Asks only while the app is in front, the turn finished well (and in the
/// last day), and the place under the reply is on screen; once per turn per
/// app run. At most one card in the whole app (`CloudSponsoredStore.holder`).
struct WorkSponsoredReplySlot: View {
  let instanceId: String
  let sessionId: String
  let turn: CloudSponsoredTurn
  @ObservedObject var slot: WorkSponsoredSlotModel
  @ObservedObject private var store = CloudSponsoredStore.shared
  @ObservedObject private var accountStore = AccountCloudStore.shared

  private static let notCloudRetry: Duration = .seconds(12)

  private enum Showing: Equatable {
    case consent
    case ad(CloudSponsoredAd)
  }

  private var turnKey: String { CloudSponsoredStore.turnKey(chatId: sessionId, turnId: turn.turnId) }
  private var sponsored: CloudSponsoredState? { accountStore.account?.sponsored }

  private var wanted: Bool {
    guard let sponsored, sponsored.ads, sponsored.consent != CloudSponsoredState.declined else { return false }
    return turn.isFresh() && !store.hiddenTurns.contains(turnKey) && store.appActive && slot.chatVisible
  }

  /// Another sponsored unit (a pick card, another chat's card) holds the one place.
  private var placeTaken: Bool { store.holder != nil && store.holder != sessionId }

  private var showing: Showing? {
    guard wanted, let sponsored else { return nil }
    if sponsored.consent == nil { return .consent }
    // A card shows, and holds the place, only while its spot is on screen.
    if sponsored.granted, slot.onScreen, let ad = store.ads[turnKey] { return .ad(ad) }
    return nil
  }

  var body: some View {
    let showing = showing
    VStack(alignment: .leading, spacing: 0) {
      if store.holder == sessionId {
        switch showing {
        case .consent:
          WorkSponsoredConsentCard(smallNeedsCards: sponsored?.smallUsesHoursWithoutCards == true)
        case .ad(let ad):
          WorkSponsoredAdCard(ad: ad, test: sponsored?.test == true, slot: slot) {
            store.hide(turnKey: turnKey)
          }
        case nil:
          EmptyView()
        }
      }
    }
    .frame(maxWidth: .infinity, minHeight: 1, alignment: .leading)
    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { slot.height = $0 }
    .task(id: "\(turnKey)|\(sponsored?.granted == true)|\(wanted)|\(slot.onScreen)|\(placeTaken)") { await askIfWanted() }
    .task(id: "\(showing != nil)|\(store.holder ?? "")") {
      if showing != nil { store.hold(sessionId) } else { store.release(sessionId) }
    }
    .onDisappear { store.release(sessionId) }
    .accessibilityElement(children: .contain)
  }

  /// One ask per turn; a `not_cloud` answer (the computer hadn't saved the
  /// chat's copy yet) is asked once more ~12 s later, never more.
  private func askIfWanted() async {
    // No ask while another sponsored unit holds the one place.
    guard sponsored?.granted == true, wanted, slot.onScreen, !placeTaken, store.ads[turnKey] == nil else { return }
    let key = turnKey
    let ask: @MainActor () async -> CloudSponsoredAdAnswer = { [instanceId, sessionId, turn] in
      guard let client = await SyncMenuSafePublisher.shared.service.cloudServerClient() else { return .unavailable }
      // Apple's tracking prompt, once, before the first card; the card is asked for whatever the answer.
      _ = await CloudSponsoredTracking.askOnce()
      do {
        return try await client.sponsoredAd(instanceId: instanceId, chatId: sessionId, turn: turn, device: .current)
      } catch {
        cloudSponsoredLog.notice("sponsored ad ask failed error=\(CrashReporting.redactedErrorDescription(error), privacy: .public)")
        return .unavailable
      }
    }
    while !Task.isCancelled {
      let answer = await store.askAd(turnKey: key, ask: ask)
      guard answer.shownAd == nil, answer.reason == "not_cloud" else { return }
      try? await Task.sleep(for: Self.notCloudRetry)
      guard !Task.isCancelled, store.takeNotCloudRetry(turnKey: key) else { return }
      store.forgetAnswer(turnKey: key)
    }
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

  var body: some View {
    Text(name.first.map { String($0).uppercased() } ?? "·")
      .font(.system(size: 10, weight: .semibold))
      .foregroundStyle(ADEColor.textSecondary)
      .frame(width: 16, height: 16)
      .background(ADEColor.textPrimary.opacity(0.08), in: RoundedRectangle(cornerRadius: 4, style: .continuous))
      .accessibilityHidden(true)
  }
}

/// A small outline button ("Learn more", "Open site", "Use it").
private struct WorkSponsoredCTA: View {
  let title: String
  var external = false
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
      .font(.system(size: 12.5, weight: .medium))
      .foregroundStyle(ADEColor.textSecondary)
      .padding(.horizontal, 10)
      .frame(minHeight: 28)
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
        ? "Free shows one sponsored card under a finished reply in ADE Cloud chats. Without them, Small computers use your hours, half an hour for each hour awake. An agent may also recommend a sponsored tool."
        : "A Free chat on ADE Cloud can show one sponsored card under a finished reply, and an agent may recommend a sponsored tool.")
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
    WorkSponsoredCTA(title: smallNeedsCards ? "No thanks, use my hours" : "No thanks") { answer(CloudSponsoredState.declined) }
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

/// One sponsored card: the brand, "Sponsored", hide, the title, the text,
/// and Learn more. Its view counts once half of it is on screen.
struct WorkSponsoredAdCard: View {
  let ad: CloudSponsoredAd
  let test: Bool
  @ObservedObject var slot: WorkSponsoredSlotModel
  @ObservedObject private var store = CloudSponsoredStore.shared
  let onHide: () -> Void

  var body: some View {
    WorkSponsoredFrame {
      HStack(spacing: 6) {
        WorkSponsoredMonogram(name: ad.brand)
        Text(ad.brand)
          .font(.system(size: 11.5, weight: .medium))
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
        Text(test || ad.test ? "· Sponsored · test" : "· Sponsored")
          .font(.system(size: 11.5))
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(1)
          .layoutPriority(1)
        Spacer(minLength: 4)
        Button(action: onHide) {
          Image(systemName: "xmark")
            .font(.system(size: 10, weight: .bold))
            .foregroundStyle(ADEColor.textMuted)
            .frame(width: 28, height: 28)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.vertical, -6)
        .padding(.trailing, -6)
        .accessibilityLabel("Hide this card")
      }
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
      // The call to action sits on the right, under the hide button.
      WorkSponsoredCTA(title: ad.cta ?? "Learn more", external: true) { workSponsoredOpen(ad.clickUrl) }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.top, 4)
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Sponsored: \(ad.brand)")
    .task(id: "\(ad.id)|\(slot.halfOnScreen)|\(store.appActive)") {
      if slot.halfOnScreen, store.appActive { store.noteViewed(ad) }
    }
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
