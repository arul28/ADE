import Foundation

// Pricing v3: the ad price (`CloudAccountState.pricing`, `adPrice.ts` on the
// account server). The server decides every price, the discount and who sees
// ads; this file only reads its answer and says it in the words every DAEX
// surface uses (docs/features/ade-cloud/README.md, "The ad price"). Nothing
// here computes a price.

/// The header the phone sends on every account-server call to say it knows
/// Pricing v3 (`CLOUD_PRICING_HEADER`, `CLOUD_PRICING_VERSION`). Without it,
/// the server leaves `pricing` out (and `sponsored` on a paid plan), so an
/// older build shows today's product.
let cloudPricingHeader = "X-ADE-Pricing"
let cloudPricingVersion = "3"

/// `CloudAccountState.pricing`: sent only while Pricing v3 reaches the
/// account. Absent: every screen is today's.
struct CloudPricingState: Decodable, Equatable {
  /// `CloudAdsState`: the account's ads, for this request's country.
  struct Ads: Decodable, Equatable {
    /// This request's country has ads. False: one price, nothing about ads.
    let available: Bool
    /// Ads are on now: a yes that holds here and the notice seen.
    let on: Bool
    /// This region starts with ads on: the notice tells, it does not ask.
    let startsOn: Bool
    /// The account saw the notice (one answer on every device).
    let noticeSeen: Bool
    let discountPct: Int
    let windowMinutes: Int

    init(available: Bool, on: Bool, startsOn: Bool, noticeSeen: Bool, discountPct: Int, windowMinutes: Int) {
      self.available = available
      self.on = on
      self.startsOn = startsOn
      self.noticeSeen = noticeSeen
      self.discountPct = discountPct
      self.windowMinutes = windowMinutes
    }

    private enum CodingKeys: String, CodingKey { case available, on, startsOn, noticeSeen, discountPct, windowMinutes }

    init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      available = c.lenient(Bool.self, forKey: .available) ?? false
      on = c.lenient(Bool.self, forKey: .on) ?? false
      startsOn = c.lenient(Bool.self, forKey: .startsOn) ?? false
      noticeSeen = c.lenient(Bool.self, forKey: .noticeSeen) ?? false
      discountPct = max(0, c.lenient(Int.self, forKey: .discountPct) ?? 0)
      windowMinutes = max(0, c.lenient(Int.self, forKey: .windowMinutes) ?? 0)
    }
  }

  /// `CloudPrice` (with `instanceId` for a computer, `phoneId` for the iPhone):
  /// what one of them costs now.
  struct Price: Decodable, Equatable {
    /// `ad` or `full`; an unknown value reads as full.
    let now: String
    /// Why it has the full price (`CloudFullPriceReason`); nil with the ad price.
    let reason: String?
    /// The rate it uses now, in thousandths (an hour; a minute for the iPhone).
    let rateMilli: Int
    /// The other price, for "8 with ads" beside "10".
    let otherRateMilli: Int
    let instanceId: String?
    let phoneId: String?

    init(now: String, reason: String?, rateMilli: Int, otherRateMilli: Int, instanceId: String? = nil, phoneId: String? = nil) {
      self.now = now
      self.reason = reason
      self.rateMilli = rateMilli
      self.otherRateMilli = otherRateMilli
      self.instanceId = instanceId
      self.phoneId = phoneId
    }

    private enum CodingKeys: String, CodingKey { case now, reason, rateMilli, otherRateMilli, instanceId, phoneId }

    init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      now = c.lenient(String.self, forKey: .now) == "ad" ? "ad" : "full"
      reason = c.lenient(String.self, forKey: .reason)
      rateMilli = max(0, try c.decode(Int.self, forKey: .rateMilli))
      otherRateMilli = max(0, c.lenient(Int.self, forKey: .otherRateMilli) ?? rateMilli)
      instanceId = c.lenient(String.self, forKey: .instanceId)
      phoneId = c.lenient(String.self, forKey: .phoneId)
    }

    var isAd: Bool { now == "ad" }
  }

  let creditScale: Int
  let ads: Ads
  let computers: [Price]
  let phone: Price?

  init(creditScale: Int, ads: Ads, computers: [Price] = [], phone: Price? = nil) {
    self.creditScale = creditScale
    self.ads = ads
    self.computers = computers
    self.phone = phone
  }

  private enum CodingKeys: String, CodingKey { case creditScale, ads, computers, phone }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    // A scale of 0 or less is no scale: read as 1 (the old unit) rather than show zeros.
    let scale = c.lenient(Int.self, forKey: .creditScale) ?? 1
    creditScale = scale > 0 ? scale : 1
    ads = try c.decode(Ads.self, forKey: .ads)
    // One malformed row drops only itself, never the other computers' prices.
    computers = (c.lenient([ChatLaunchLossy<Price>].self, forKey: .computers) ?? []).compactMap(\.value).filter { $0.instanceId != nil }
    phone = c.lenient(Price.self, forKey: .phone)
  }

  /// What this computer costs now; nil when the server sent no row for it.
  func computer(_ instanceId: String?) -> Price? {
    guard let instanceId else { return nil }
    return computers.first { $0.instanceId == instanceId }
  }

  /// Two prices show: ads exist here and the discount is above 0.
  var showsTwoPrices: Bool { ads.available && ads.discountPct > 0 }
}

/// The account's Pricing v3 state, from the phone's own account read only: it
/// carries the phone's header and this phone's country (ads exist where the
/// request comes from). A machine's copy of the account (the cloud pane's
/// `cloud.list`) was read from that machine's country, so it is never used.
@MainActor func cloudPricing() -> CloudPricingState? {
  AccountCloudStore.shared.account?.pricing
}

/// What a size costs, from the catalog (`multiplierMilli` full, `adMultiplierMilli` with ads).
struct CloudRatePair: Equatable {
  let fullMilli: Int
  let adMilli: Int
}

/// The unit of a rate: computers by the hour, the iPhone and the Mac by the minute.
enum CloudRateUnit {
  case hour, minute

  var long: String { self == .hour ? "an hour" : "a minute" }
  var short: String { self == .hour ? "/h" : "/min" }
}

/// Every Pricing v3 word on the phone. Built from the account's
/// `pricing`; nil wherever `pricing` is absent, so a caller shows today's words.
struct CloudAdPriceWords: Equatable {
  let pricing: CloudPricingState
  /// The account is on the Free plan (the notice and the switch say Small is free).
  let freePlan: Bool

  init(pricing: CloudPricingState, freePlan: Bool) {
    self.pricing = pricing
    self.freePlan = freePlan
  }

  /// The words for this account, or nil without `pricing` (`cloudPricing`).
  @MainActor init?(_ account: CloudPhoneAccount?) {
    guard let pricing = cloudPricing() else { return nil }
    let plan = AccountCloudStore.shared.account?.currentPlanId ?? account?.currentPlanId
    self.init(pricing: pricing, freePlan: plan == "free")
  }

  private var ads: CloudPricingState.Ads { pricing.ads }
  private var pct: Int { ads.discountPct }
  private var cloud: String { Brand.cloudName }

  // MARK: Numbers

  /// Shown credits from thousandths at the server's scale: "4,180", "8", "2.5".
  /// Whole numbers with a thousands comma; tenths only when the value isn't whole.
  func number(_ milli: Int) -> String { cloudCredits(milli, scale: pricing.creditScale) }

  /// "8 credits", "1 credit".
  func credits(_ milli: Int) -> String {
    let shown = number(milli)
    return "\(shown) \(shown == "1" ? "credit" : "credits")"
  }

  // MARK: Prices (every place that shows one)

  /// A size's or the iPhone's price as the account pays it now, with the
  /// other price beside it: "8 credits an hour with ads · 10 with no ads",
  /// "10 credits an hour · 8 with ads", "10 credits an hour", "Free",
  /// "Free with ads · 5 credits an hour with no ads".
  func rate(_ pair: CloudRatePair, unit: CloudRateUnit = .hour) -> String {
    let full = pair.fullMilli, ad = pair.adMilli
    if full == 0 { return "Free" }
    guard pricing.showsTwoPrices, ad != full else {
      return single(ads.on && ads.available ? ad : full, unit)
    }
    if ads.on {
      return ad == 0
        ? "Free with ads · \(credits(full)) \(unit.long) with no ads"
        : "\(credits(ad)) \(unit.long) with ads · \(number(full)) with no ads"
    }
    return ad == 0
      ? "\(credits(full)) \(unit.long) · Free with ads"
      : "\(credits(full)) \(unit.long) · \(number(ad)) with ads"
  }

  /// The compact form for a narrow place: "8/h with ads", "10/h", "Free", "4/min with ads".
  func compactRate(_ pair: CloudRatePair, unit: CloudRateUnit = .hour) -> String {
    let full = pair.fullMilli, ad = pair.adMilli
    if full == 0 { return "Free" }
    let withAds = pricing.showsTwoPrices && ads.on && ad != full
    let now = withAds ? ad : full
    if now == 0 { return "Free with ads" }
    return "\(number(now))\(unit.short)\(withAds ? " with ads" : "")"
  }

  private func single(_ milli: Int, _ unit: CloudRateUnit) -> String {
    milli == 0 ? "Free" : "\(credits(milli)) \(unit.long)"
  }

  // MARK: What a computer (or the iPhone) costs now

  /// Line 1 of a computer's price, from the server's `rateMilli` (now) and `otherRateMilli`.
  func priceNow(_ price: CloudPricingState.Price, unit: CloudRateUnit = .hour) -> String {
    let now = price.rateMilli, other = price.otherRateMilli
    guard pricing.showsTwoPrices, now != other, price.reason != "no_ads_here" else { return single(now, unit) }
    if price.isAd {
      return now == 0
        ? "Free with ads · \(credits(other)) \(unit.long) with no ads"
        : "\(credits(now)) \(unit.long) with ads · \(number(other)) with no ads"
    }
    return other == 0
      ? "\(credits(now)) \(unit.long) · Free with ads"
      : "\(credits(now)) \(unit.long) · \(number(other)) with ads"
  }

  /// The compact form of what it costs now: "8/h with ads", "10/h".
  func compactPriceNow(_ price: CloudPricingState.Price, unit: CloudRateUnit = .hour) -> String {
    let withAds = price.isAd && pricing.showsTwoPrices && price.rateMilli != price.otherRateMilli
    if price.rateMilli == 0 { return withAds ? "Free with ads" : "Free" }
    return "\(number(price.rateMilli))\(unit.short)\(withAds ? " with ads" : "")"
  }

  /// Line 2: why it has the full price while ads are on, or nil.
  func reasonLine(_ price: CloudPricingState.Price) -> String? {
    // Two equal rates (a paid plan's Small, an iPhone started before Pricing v3): one price, no reason.
    guard ads.on, ads.available, !price.isAd, price.rateMilli != price.otherRateMilli else { return nil }
    switch price.reason {
    case "ads_off", "no_ads_here": return nil
    case "cli_session": return "Full price: a CLI session runs here"
    case "automation": return "Full price: an automation runs here"
    case "outside_agent": return "Full price: an outside agent works here"
    case "not_in_use":
      guard let span = cloudAdWindowPhrase(ads.windowMinutes) else { return "Full price: no chat in use lately" }
      return "Full price: no chat in use \(span)"
    case "unverified": return "Full price: ads cannot show on this connection"
    default: return "Full price"
    }
  }

  /// The reason short enough for a row beside a compact price: "CLI session".
  func shortReason(_ price: CloudPricingState.Price) -> String? {
    guard reasonLine(price) != nil else { return nil }
    switch price.reason {
    case "cli_session": return "CLI session"
    case "automation": return "automation"
    case "outside_agent": return "outside agent"
    case "not_in_use": return "no chat in use"
    case "unverified": return "full price"
    default: return "full price"
    }
  }

  // MARK: The notice and the switch

  /// The sentence of the notice and the switch, by plan, region and discount.
  /// `on`: the "ads start on" sentence (the switch on, the starts-on notice);
  /// else the "asked first" one (the switch off, the question).
  func offer(on: Bool) -> String {
    switch (freePlan, pct > 0, on) {
    case (false, true, true): return "Ads are on, so \(cloud) costs \(pct)% less."
    case (false, true, false): return "Turn on ads to pay \(pct)% less."
    case (true, true, true): return "Ads are on: Small computers are free, and bigger ones cost \(pct)% less."
    case (true, true, false): return "Turn on ads: Small computers are free, and bigger ones cost \(pct)% less."
    case (false, false, true): return "Ads are on in your \(cloud) chats."
    case (false, false, false): return "Turn on ads in your \(cloud) chats?"
    case (true, false, true): return "Ads are on, so Small computers are free."
    case (true, false, false): return "Turn on ads, so Small computers are free."
    }
  }

  /// The notice shows: ads exist here and the account hasn't answered it.
  var noticeDue: Bool { ads.available && !ads.noticeSeen }

  static let noticeFineLine = "One ad under a finished reply. Change this any time in Settings\u{00A0}›\u{00A0}\(Brand.cloudName)."
  /// The data line (today's consent facts). The phone sends the hashed email
  /// only with App Tracking Transparency allowed (`CloudSponsoredTracking`).
  static let dataLine = "To pick an ad, \(Brand.name) sends Gravity, our ad partner, your last message and the reply (or the agent's search), your IP address, your device type and a hashed copy of your account email. Ads are for people 18 or older."
  static let switchLabel = "Ads"
  static let switchNote = "Ads show under replies in chats that use \(Brand.cloudName). CLI sessions, automations and work an outside agent starts always use the full price."
  static let keepAds = "Keep ads"
  static let turnOffAds = "Turn off ads"
  static let turnOnAds = "Turn on ads"
  static let noThanks = "No thanks"
  static let confirmTitle = "Turn on ads?"
  static let keepAdsOff = "Keep ads off"

  // MARK: CLI sessions and automations

  /// The CLI start notice's title, while ads are on; nil otherwise.
  var cliStartNotice: String? {
    guard ads.available, ads.on else { return nil }
    if pct == 0 { return freePlan ? "CLI sessions use the full price. Small computers are free only in chats with ads." : nil }
    return "CLI sessions use the full price. Chats cost \(pct)% less with ads."
  }
  static let openAsChat = "Open as a chat"
  static let startCli = "Start CLI"

  /// The automation form's line, while ads are on; nil otherwise.
  var automationNotice: String? {
    guard ads.available, ads.on else { return nil }
    if pct == 0 { return freePlan ? "Automations use the full price. Small computers are free only in chats with ads." : nil }
    return "Automations use the full price. Chats cost \(pct)% less with ads."
  }

  // MARK: Time on a plan

  /// "up to 62 hours on a Medium with ads · 50 with no ads", or "50 hours on a
  /// Medium" with ads off, no ads here or a discount of 0. Nil for a size that
  /// uses no credits.
  func timeOn(_ milli: Int, tier: CloudPhoneTier) -> String? {
    guard tier.multiplierMilli > 0 else { return nil }
    let full = cloudWholeHours(milli, per: tier.multiplierMilli)
    let ad = tier.adMultiplierMilli.flatMap { $0 > 0 ? cloudWholeHours(milli, per: $0) : nil }
    if pricing.showsTwoPrices, ads.on, let ad, ad != full {
      return "up to \(cloudHoursCount(ad)) \(ad == 1 ? "hour" : "hours") on \(tier.withArticle) with ads · \(cloudHoursCount(full)) with no ads"
    }
    return "\(cloudHoursCount(full)) \(full == 1 ? "hour" : "hours") on \(tier.withArticle)"
  }
}

/// Shown credits from thousandths at a scale: `milli / 1000 x scale`, whole
/// numbers with a thousands comma, tenths only when not whole, rounded down
/// (`cloudHours` at scale 1).
func cloudCredits(_ milli: Int, scale: Int) -> String {
  cloudHours(max(0, milli) * max(1, scale))
}

private func cloudWholeHours(_ milli: Int, per rate: Int) -> Int {
  Int((Double(max(0, milli)) / Double(max(1, rate))).rounded(.down))
}

private func cloudHoursCount(_ hours: Int) -> String {
  hours.formatted(.number.locale(Locale(identifier: "en_US")))
}

/// "for an hour", "for 30 minutes", "for 2 hours", "for a day"; nil for a
/// window with no words of its own (the line then says "lately").
func cloudAdWindowPhrase(_ minutes: Int) -> String? {
  switch minutes {
  case 5, 10, 15, 30, 45: return "for \(minutes) minutes"
  case 60: return "for an hour"
  case 90: return "for 90 minutes"
  case 120, 240, 480, 720: return "for \(minutes / 60) hours"
  case 1440: return "for a day"
  default: return nil
  }
}

// MARK: - Ads in chats

/// Ads show in this account's DAEX Cloud chats now. Pricing v3: the server's
/// `pricing.ads.on` where ads exist (a "Keep ads" answer counts, and every
/// plan); before it, the Free plan's sponsored yes.
@MainActor func cloudChatAdsOn() -> Bool {
  let account = AccountCloudStore.shared.account
  if let pricing = account?.pricing { return pricing.ads.available && pricing.ads.on }
  guard let sponsored = account?.sponsored else { return false }
  return sponsored.ads && sponsored.granted
}

/// The ad place under a reply is live: ads may show, or the notice (or
/// today's question) is still due. Pricing v3: ads exist here and either are
/// on or the account hasn't answered the notice yet.
@MainActor func cloudChatAdsMayShow() -> Bool {
  let account = AccountCloudStore.shared.account
  if let pricing = account?.pricing { return pricing.ads.available && (pricing.ads.on || !pricing.ads.noticeSeen) }
  guard let sponsored = account?.sponsored else { return false }
  return sponsored.ads && sponsored.consent != CloudSponsoredState.declined
}

/// Where the account's ads show (`sponsored.format`); under the reply when the server sent none.
@MainActor func cloudChatAdsFormat() -> CloudSponsoredFormat {
  AccountCloudStore.shared.account?.sponsored?.format ?? .belowReply
}

/// The live DAEX Cloud iPhone's id when this chat holds it (the rule every
/// DAEX app uses): the chat made its brain's latest call to the live phone
/// (`CloudIphoneStatus.chatSessionId`, read through the chat's own brain) and
/// the account's `pricing.phone` names that phone. Nil otherwise, and with no
/// live phone (then nothing is read). One status read, only while a phone runs.
@MainActor func cloudHeldPhoneId(sessionId: String) async -> String? {
  guard let phoneId = cloudPricing()?.phone?.phoneId else { return nil }
  let sync = SyncMenuSafePublisher.shared.service
  guard sync.supportsCloudIphone(sessionId: sessionId),
        let status = try? await sync.fetchCloudIphoneStatus(sessionId: sessionId),
        let live = status.phone, live.state != "ended",
        status.chatSessionId == sessionId, live.id == phoneId else { return nil }
  return phoneId
}

/// Pricing v3's proof that a person sent a message (`POST /cloud/sponsored/sent`):
/// a chat on a DAEX Cloud computer (`instanceId`, the chat's own machine) or
/// one that holds the cloud iPhone. Sent only while the account state has
/// `pricing` (read again on every account read; a 404 is never remembered).
/// Never for CLI sessions, automations or outside agents: only the chat
/// composer's send calls it. An account call, no pin. Fire and forget.
@MainActor func cloudNoteMessageSent(instanceId: String?, sessionId: String, messageId: String) {
  guard let pricing = cloudPricing(), pricing.ads.available else { return }
  Task { @MainActor in
    let phoneId = await cloudHeldPhoneId(sessionId: sessionId)
    guard instanceId != nil || phoneId != nil,
          let client = await SyncMenuSafePublisher.shared.service.cloudServerClient() else { return }
    do {
      try await client.sponsoredSent(instanceId: instanceId, phoneId: phoneId, chatId: sessionId, messageId: messageId)
    } catch {
      cloudSponsoredLog.notice("ad proof (sent) failed error=\(CrashReporting.redactedErrorDescription(error), privacy: .public)")
    }
  }
}
