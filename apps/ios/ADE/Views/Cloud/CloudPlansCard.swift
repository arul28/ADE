import SwiftUI

// The ADE Cloud page's plans card (`CloudDashboardScreen`).

/// The plans side by side: what each includes, the current one on its own
/// patch of dusk sky with a gold edge. No price, no button and no line on
/// where to change a plan (App Store 3.1.1/3.1.3): the iPhone app states facts
/// only. What Small computers and an hour are is said once, under the plans.
/// Every number is the server catalog's. No disk (Pricing v2).
struct CloudPlansCard: View {
  let account: CloudPhoneAccount
  /// The catalog's sizes: a plan's hours show as time on each.
  var tiers: [CloudPhoneTier] = []
  /// A plan that just landed ("You're on Plus"): its card is marked New and glows.
  var newPlanId: String? = nil
  /// The account server's own read wins over the page's: a yes or no lands there first.
  @ObservedObject private var accountStore = AccountCloudStore.shared

  private struct Column: Identifiable {
    let id: String
    let label: String
    let facts: CloudPhoneAccount.PlanFacts
  }

  private var columns: [Column] {
    guard let plans = account.catalog?.plans else { return [] }
    var out: [Column] = [
      Column(id: "free", label: "Free", facts: plans.free),
      Column(id: "plus", label: "Plus", facts: plans.plus ?? plans.paid),
    ]
    if let pro = plans.pro { out.append(Column(id: "pro", label: "Pro", facts: pro)) }
    if let max = plans.max { out.append(Column(id: "max", label: "Max", facts: max)) }
    return out
  }

  /// Only what's different from the hero's "Renews Dec 13".
  private var statusLine: String? {
    guard let billing = account.billing else { return nil }
    if billing.cancelAtPeriodEnd == true { return "Your plan ends \(cloudDate(billing.periodEnd)). You're on Free after that." }
    if let next = billing.nextPlanId, next != account.currentPlanId { return "You move to \(cloudPlanLabel(next)) on \(cloudDate(billing.periodEnd))." }
    if billing.notice == "past_due" { return "Your last payment failed." }
    return nil
  }

  var body: some View {
    ADEKitCard(title: "Plans", symbol: "square.stack.3d.up", hint: statusLine) {
      VStack(alignment: .leading, spacing: 12) {
        // Two plans a row on a phone, all four side by side on an iPad.
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 140), spacing: 8, alignment: .top)], alignment: .leading, spacing: 8) {
          ForEach(columns) { column in
            planColumn(column)
          }
        }
        howItWorks
      }
    }
  }

  /// Where the ad switch reaches this account (`sponsored` is sent), Free's
  /// Small is unlimited only with sponsored cards on (`CloudPlans.tsx`).
  private var freeSmallNeedsCards: Bool {
    (accountStore.account.map { $0.sponsored } ?? account.sponsored) != nil
  }

  private var words: CloudBalanceWords { CloudBalanceWords(account) }

  /// The one place for the explanations: what every plan includes.
  private var howItWorks: some View {
    VStack(alignment: .leading, spacing: 0) {
      howRow("infinity", freeSmallNeedsCards ? "Unlimited Small computers on paid plans, and on Free with sponsored cards on." : words.smallUnlimitedSentence, "Each lane has its own Linux computer your agents work on. \(cloudSmallFairUseSentence)")
      Divider().overlay(ADEKit.edge)
      howRow("clock", "\(words.title) run the bigger sizes", "and renew every month. \(words.unitSentence)\(currentHoursLine.map { " Your plan: \($0)." } ?? "")")
      Divider().overlay(ADEKit.edge)
      howRow("desktopcomputer", "Cloud computers", "count every lane's computer, asleep or awake. Free one up and its lane and chats stay.")
      Divider().overlay(ADEKit.edge)
      howRow("moon.stars", "Computers sleep on their own", "a few minutes after work stops, so your \(words.unit) only go to real work.")
      // The ADE Cloud iPhone, only while it is on for the account: it draws
      // from the credits, with no minutes of its own.
      if account.phoneOn {
        Divider().overlay(ADEKit.edge)
        howRow("iphone", "The ADE Cloud iPhone", "uses \(words.phoneRate), for agents to test your app on an iPhone simulator in the cloud.")
      }
    }
    .background(ADEKit.track.opacity(0.45), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(ADEKit.edge, lineWidth: 0.75))
  }

  private func howRow(_ symbol: String, _ lead: String, _ rest: String) -> some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: symbol)
        .font(.system(size: 12, weight: .medium))
        .foregroundStyle(CloudBrandColor.mark)
        .frame(width: 26, height: 26)
        .background(CloudBrandColor.violet.opacity(0.14), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
      (Text(lead).fontWeight(.semibold).foregroundColor(ADEColor.textSecondary) + Text(" \(rest)").foregroundColor(ADEColor.textMuted))
        .font(.system(size: 12))
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
  }

  private func planColumn(_ column: Column) -> some View {
    let current = column.id == account.currentPlanId
    let isNew = column.id == newPlanId
    // The plan that starts at the period end: a move down, or Free after a cancel.
    let next = !current && (account.billing?.nextPlanId == column.id || (account.billing?.cancelAtPeriodEnd == true && column.id == "free"))
    let shape = RoundedRectangle(cornerRadius: 14, style: .continuous)
    // An account from before the new plans keeps its old hours and disk until its period ends.
    // "then …" only when this plan carries on; a waiting move or cancel shows its own "From" column.
    let staysOn = account.billing?.cancelAtPeriodEnd != true && (account.billing?.nextPlanId ?? column.id) == column.id
    let end = account.billing?.periodEnd
    return VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 5) {
        Text(column.label)
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(current ? CloudBrandColor.skyText : ADEColor.textPrimary)
        Spacer(minLength: 0)
        if isNew {
          planTag("New", gold: true)
        } else if current {
          planTag("Your plan", gold: true)
        } else if next, let end {
          planTag("From \(cloudDate(end))", gold: false)
        }
      }
      VStack(alignment: .leading, spacing: 0) {
        if let computers = computerLimit(column) {
          bigFact("\(computers)", computers == 1 ? "cloud computer" : "cloud computers", current: current)
        } else if current, let old = oldTermsHours(column), let end {
          bigFact(cloudHours(old), staysOn ? "\(words.until(cloudDate(end))), then \(cloudHours(column.facts.includedMilli))" : words.until(cloudDate(end)), current: current)
        } else {
          bigFact(cloudHours(column.facts.includedMilli), words.perMonth, current: current)
        }
      }
      VStack(alignment: .leading, spacing: 6) {
        fact("infinity", column.id == "free" && freeSmallNeedsCards ? "Unlimited Small with cards" : "Unlimited Small", current: current)
        if current, let old = oldTermsHours(column), let end {
          fact("clock", "\(words.amount(old)) until \(cloudDate(end))\(staysOn ? ", then \(cloudHours(column.facts.includedMilli))" : "")", current: current)
        } else {
          fact("clock", words.planLine(column.facts.includedMilli), current: current)
        }
        fact("bolt", extraHoursSold(column) ? "\(words.extra) if on" : "No \(words.extra.lowercased())", current: current, quiet: !extraHoursSold(column))
      }
    }
    .padding(12)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .background {
      if current {
        CloudSky(moon: false, bank: false)
      } else {
        ADEKit.track.opacity(0.35)
      }
    }
    .clipShape(shape)
    .overlay(shape.strokeBorder(current || isNew ? CloudBrandColor.lamp.opacity(0.6) : ADEKit.edge, lineWidth: current || isNew ? 1 : 0.75))
    .shadow(color: isNew ? CloudBrandColor.lamp.opacity(0.45) : (current ? CloudBrandColor.violet.opacity(0.3) : .clear), radius: isNew ? 14 : 10, y: current ? 6 : 0)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(accessibilityLabel(column, current: current, isNew: isNew))
  }

  private func planTag(_ text: String, gold: Bool) -> some View {
    Text(text)
      .font(.system(size: 10.5, weight: .medium))
      .foregroundStyle(gold ? CloudBrandColor.lamp : ADEColor.textSecondary)
      .lineLimit(1)
      .padding(.horizontal, 7)
      .frame(height: 19)
      .background(gold ? CloudBrandColor.lamp.opacity(0.13) : Color.clear, in: Capsule())
      .overlay(Capsule().strokeBorder(gold ? CloudBrandColor.lamp.opacity(0.45) : ADEKit.edge, lineWidth: 0.75))
      .fixedSize()
  }

  private func bigFact(_ value: String, _ unit: String, current: Bool) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      Text(value)
        .font(.system(size: 26, weight: .semibold))
        .tracking(-0.6)
        .foregroundStyle(current ? CloudBrandColor.skyText : ADEColor.textPrimary)
        .lineLimit(1)
        .minimumScaleFactor(0.6)
      Text(unit)
        .font(.system(size: 11.5))
        .foregroundStyle(current ? CloudBrandColor.skyText2 : ADEColor.textMuted)
        .lineLimit(2)
    }
  }

  private func fact(_ symbol: String, _ text: String, current: Bool, quiet: Bool = false) -> some View {
    HStack(spacing: 7) {
      Image(systemName: symbol)
        .font(.system(size: 11, weight: .medium))
        .foregroundStyle(current ? CloudBrandColor.lamp : CloudBrandColor.mark)
        .frame(width: 14)
      Text(text)
        .font(.system(size: 12))
        .foregroundStyle(current ? CloudBrandColor.skyText2 : (quiet ? ADEColor.textMuted : ADEColor.textSecondary))
        .lineLimit(2)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  /// The paid plan's hours this period when they aren't the table's (old terms), else nil.
  private func oldTermsHours(_ column: Column) -> Int? {
    guard account.plan == "paid", account.billing?.notice != "past_due" else { return nil }
    let included = account.hours.includedMilli
    return included > 0 && included != column.facts.includedMilli ? included : nil
  }

  /// The plan's cloud computers.
  private func computerLimit(_ column: Column) -> Int? { column.facts.computerLimit }

  /// Extra hours are sold on the plan: the catalog's price is set (never
  /// shown), else every plan but Free, as older servers had it.
  private func extraHoursSold(_ column: Column) -> Bool {
    if let cents = column.facts.extraHourCents { return cents > 0 }
    return column.id != "free"
  }

  /// "100 hours on a Medium · 40 on a Large · 25 on an X-Large": the account's plan's hours.
  private var currentHoursLine: String? {
    guard let facts = columns.first(where: { $0.id == account.currentPlanId })?.facts else { return nil }
    return cloudHoursOnSizes(facts.includedMilli, tiers: tiers)
  }

  private func accessibilityLabel(_ column: Column, current: Bool, isNew: Bool) -> String {
    var parts: [String] = []
    if let computers = computerLimit(column) {
      parts.append(cloudComputersPhrase(computers))
      parts.append(column.id == "free" && freeSmallNeedsCards ? "unlimited Small computers with sponsored cards" : "unlimited Small computers")
      parts.append(words.planSentence(column.facts.includedMilli))
      parts.append(cloudHoursOnSizes(column.facts.includedMilli, tiers: tiers) ?? "\(cloudHours(column.facts.includedMilli)) credits a month")
    } else {
      parts.append("\(cloudHours(column.facts.includedMilli)) \(words.perMonth)")
    }
    parts.append(extraHoursSold(column) ? "\(words.extra.lowercased()) if on" : "no \(words.extra.lowercased())")
    return "\(column.label)\(current ? ", your plan" : "")\(isNew ? ", new" : ""): \(parts.joined(separator: ", "))"
  }

}

/// "Sponsored cards" (`CloudPlans.tsx` add-on): the account's answer to the
/// one-time question, on every device at once. Shown only while the server's
/// switch reaches the account (`sponsored.ads`). Flipping it saves the answer
/// on the account server (account token, no machine).
struct CloudSponsoredCard: View {
  /// The account as this page read it; the account server's own read wins.
  let pageAccount: CloudPhoneAccount?
  @ObservedObject private var accountStore = AccountCloudStore.shared
  @State private var saving = false
  @State private var error: String?
  /// The server's answer to this page's save, for a page whose account came
  /// through a computer (the account store then has no account to update).
  @State private var saved: CloudSponsoredState?
  /// This card showed the notice that cards are on: its words stay while the page is open, after the save made it a yes.
  @State private var toldHere = false
  /// Half of this card is on screen: only then is it the notice that cards are on.
  @State private var onScreen = false
  @ObservedObject private var sponsoredStore = CloudSponsoredStore.shared
  /// Turning cards on after a no asks once more (`CloudSponsoredState.confirmYes`).
  @State private var confirming = false
  /// Where the switch is going while its save runs, so it doesn't snap back before the answer.
  @State private var pendingOn: Bool?

  /// The shared account's answer wins even when it is none (the switch went off).
  private var sponsored: CloudSponsoredState? {
    if let account = accountStore.account { return account.sponsored }
    return saved ?? pageAccount?.sponsored
  }

  var body: some View {
    // Also once said yes where none show (a paid plan, another country), so it can be taken back.
    if let sponsored, sponsored.ads || sponsored.granted {
      VStack(alignment: .leading, spacing: 0) {
        ADESettingsRow(title: "Sponsored cards", symbol: "megaphone") {
          Toggle("Sponsored cards", isOn: Binding(
            // Where cards start on, they read on before any answer (this card is then the notice).
            // On while the second confirm is up, so the switch doesn't snap back under it.
            get: { pendingOn ?? (sponsored.granted || sponsored.toldOn || confirming) },
            set: { on in
              if on, sponsored.confirmYes { confirming = true } else { save(on ? CloudSponsoredState.granted : CloudSponsoredState.declined) }
            }
          ))
          .labelsHidden()
          .tint(ADEColor.accent)
          .disabled(saving)
        }
        // The state line in full, under the row (a row's hint is one short line).
        Text(stateLine(sponsored))
          .font(.system(size: 12.5))
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
          .padding(.horizontal, ADEKit.inset)
          .padding(.top, -4)
          .padding(.bottom, sponsored.smallUsesHoursWithoutCards ? 4 : 12)
        if sponsored.smallUsesHoursWithoutCards {
          Text("Small computers use your \(CloudBalanceWords(accountStore.account ?? pageAccount).unit) while sponsored cards are off.")
            .font(.system(size: 12.5))
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, ADEKit.inset)
            .padding(.bottom, 12)
        }
        if let error {
          Text(error)
            .font(.system(size: 12))
            .foregroundStyle(ADEColor.danger)
            .padding(.horizontal, ADEKit.inset)
            .padding(.bottom, 10)
        }
      }
      .adeKitCard(padding: nil)
      .alert("Turn on sponsored cards?", isPresented: $confirming) {
        Button("Turn on") { save(CloudSponsoredState.granted, confirmed: true) }
        Button("Keep them off", role: .cancel) {}
      } message: {
        Text(CloudSponsoredState.turnOnConfirm)
      }
      // Seen here, the notice that cards are on is saved as the account's yes, as in a chat.
      .onScrollVisibilityChange(threshold: 0.5) { onScreen = $0 }
      .task(id: "\(sponsored.toldOn)|\(onScreen)|\(sponsoredStore.appActive)") {
        guard sponsored.toldOn, onScreen, sponsoredStore.appActive else { return }
        toldHere = true
        sponsoredStore.noteNoticeShown()
      }
    }
  }

  private func stateLine(_ sponsored: CloudSponsoredState) -> String {
    // On or off, the row says everything the one-time question (or the notice) does.
    let what = "A Free ADE Cloud chat can show one sponsored card under a finished reply, and an agent may recommend a sponsored tool. \(CloudSponsoredState.sends)"
    guard sponsored.granted || sponsored.toldOn else {
      return "Off.\(sponsored.gpcOff ? " \(CloudSponsoredState.gpcOffLine)" : "") If you turn it on: \(what)"
    }
    return sponsored.ads
      ? "On.\(sponsored.toldOn || toldHere ? " They start on where you are; you can turn them off here." : "") \(what)"
      : "On, but none show for you now: sponsored cards run only in Free ADE Cloud chats, in the countries Gravity serves."
  }

  private func save(_ consent: String, confirmed: Bool = false) {
    guard !saving else { return }
    saving = true
    pendingOn = consent == CloudSponsoredState.granted
    error = nil
    Task {
      switch await cloudSaveSponsoredConsent(consent, confirmed: confirmed) {
      case .success(let state): saved = state
      case .failure(let failure): error = failure.message
      }
      saving = false
      pendingOn = nil
    }
  }
}
