import SwiftUI

// An agent's Sponsored recommendation in an ADE Cloud chat (`sponsored_pick`,
// Gravity's Index): the phone's side of the desktop's `SponsoredPickCard.tsx`.
// The account server decides; this only shows what comes back
// (`CloudSponsored.swift`). Shares the cards' frame and buttons with
// `WorkSponsoredCards.swift`.

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
