import SwiftUI
import UIKit

// The ADE Cloud page's cards (`CloudDashboardScreen`), top to bottom: the
// hero, the notices, lanes and computers, plans, sizes, invite friends, and
// what agents may do. The plans card is `CloudPlansCard.swift`, the
// sign-ins card `CloudSignInsCard.swift`; the words they share are
// `CloudPhoneFormat.swift`.

// MARK: - The page

struct CloudDashboardScreen: View {
  @ObservedObject var store: CloudPaneStore
  /// Close, for the sheet; nil inside Settings, whose stack has its own.
  var onClose: (() -> Void)?
  /// True on a phone: a row pushes the computer. False in the book layout: a row selects it.
  var pushes: Bool
  /// "You're on Plus", once per account, plan and period (`CloudPlanSeenStore`).
  @State private var moment: CloudPlanMoment?
  /// The account server's own read wins for a tester's provider pick: a save lands there first.
  @ObservedObject private var accountStore = AccountCloudStore.shared

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        switch store.phase {
        case .loading where store.machines.isEmpty && store.account == nil:
          ProgressView()
            .frame(maxWidth: .infinity)
            .padding(.vertical, 40)
        case .failed(let message):
          ADESettingsNotice(message: "Couldn't read ADE Cloud. \(message)", actionTitle: "Try again") {
            Task { await store.reload() }
          }
        default:
          CloudHero(store: store, celebrating: moment != nil)
          if let moment {
            CloudPlanMomentCard(moment: moment) { self.moment = nil }
          }
          if let account = accountStore.account ?? store.account, CloudPhoneProviderPicker.shows(account) {
            CloudPhoneProviderPicker(account: account, syncService: store.syncService, onSaved: { await store.reload() })
              .adeKitCard()
          }
          CloudNotices(store: store)
          // A move of a computer to the other kind, while it runs (and its reason once it failed).
          ForEach(store.shownMoves) { move in
            CloudMoveCard(store: store, move: move)
          }
          CloudLanesCard(store: store, pushes: pushes)
          CloudSavedLaneWorkCard(store: store)
          if let account = store.account, account.catalog != nil {
            CloudPlansCard(account: account, tiers: store.tiers, newPlanId: moment?.planId)
            CloudSizesCard(account: account, tiers: store.tiers)
          }
          CloudSponsoredCard(pageAccount: store.account)
          if let referral = store.account?.referral {
            CloudInviteCard(referral: referral, syncService: store.syncService, words: CloudBalanceWords(store.account), onChanged: { Task { await store.reload() } })
          }
          if store.isDirect {
            // No computer answers for the account: its ADE Cloud sign-ins, read directly.
            SettingsCloudAccountProviders(syncService: store.syncService)
          } else {
            CloudSignInsCard(store: store)
          }
          CloudAgentsCard(store: store)
        }
      }
      .padding(.horizontal, 16)
      .padding(.top, 8)
      .padding(.bottom, 36)
    }
    .background(ADEColor.pageBackground.ignoresSafeArea())
    .refreshable { await store.refresh() }
    .onAppear { observePlan(store.account) }
    .onChange(of: store.account) { _, account in observePlan(account) }
    .navigationTitle("ADE Cloud")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      if let onClose {
        // As every Settings page's close: the trailing side, which the Duo's edge bar carries.
        ToolbarItem(placement: .topBarTrailing) {
          Button(role: .close) { onClose() }
            .accessibilityLabel("Close ADE Cloud")
        }
      }
    }
  }

  private func observePlan(_ account: CloudPhoneAccount?) {
    guard let account else {
      moment = nil
      return
    }
    // Another account, plan or period: the banner was about something else.
    if let shown = moment, shown.accountKey != CloudPlanSeenStore.accountKey(account).key || shown.key != CloudPlanSeenStore.momentKey(account) {
      moment = nil
    }
    if let landed = CloudPlanSeenStore.observe(account) {
      moment = landed
      ProductAnalytics.shared.captureFeature(.cloudPlan, outcome: .completed)
    }
  }
}

/// "You're on Plus": the plan, its hours and disk, the renewal date, and the
/// free hours it replaced. Facts only (App Store 3.1.1): no price.
struct CloudPlanMomentCard: View {
  let moment: CloudPlanMoment
  let onDismiss: () -> Void

  var body: some View {
    let shape = RoundedRectangle(cornerRadius: 14, style: .continuous)
    HStack(alignment: .top, spacing: 12) {
      CloudLogo(size: 18, glow: true)
        .frame(width: 34, height: 34)
        .background(CloudBrandColor.violet.opacity(0.14), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
      VStack(alignment: .leading, spacing: 4) {
        Text(moment.title)
          .font(.system(size: 14.5, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Text(moment.detail)
          .font(.system(size: 12.5))
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      Spacer(minLength: 0)
      Button(action: onDismiss) {
        Image(systemName: "xmark")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(ADEColor.textMuted)
          .frame(width: 28, height: 28)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Dismiss")
    }
    .padding(12)
    .background(
      LinearGradient(colors: [CloudBrandColor.violet.opacity(0.12), CloudBrandColor.lamp.opacity(0.08)], startPoint: .leading, endPoint: .trailing),
      in: shape
    )
    .overlay(shape.strokeBorder(CloudBrandColor.lamp.opacity(0.45), lineWidth: 0.75))
    .accessibilityElement(children: .combine)
  }
}

// MARK: Hero

/// The top block, on ADE Cloud's dusk sky (in both themes): the logo, the
/// plan in gold, when it renews, the balance left, and the computers. The
/// numbers are said once on the page; nothing below repeats them. Plain
/// labels and lines only: every line wraps, so nothing is cut off at a
/// narrow width or a large text size.
struct CloudHero: View {
  @ObservedObject var store: CloudPaneStore
  /// A plan that just landed ("You're on Plus"): its name glows.
  var celebrating = false
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  var body: some View {
    if let account = store.account {
      let shape = RoundedRectangle(cornerRadius: 18, style: .continuous)
      let words = CloudBalanceWords(account)
      VStack(alignment: .leading, spacing: 16) {
        header(account)
        balance(account, words: words)
        // No disk: each size has its own disk maximum, and only one
        // computer's nearly full disk is ever shown (on its own page).
        meters(account, words: words)
      }
      .padding(16)
      .padding(.bottom, 6)
      .background { CloudSky() }
      .clipShape(shape)
      .overlay(shape.strokeBorder(CloudBrandColor.violetLight.opacity(0.18), lineWidth: 0.75))
      .shadow(color: CloudBrandColor.violet.opacity(0.25), radius: 18, y: 10)
      .environment(\.colorScheme, .dark)
    }
  }

  /// "ADE Cloud Pro", and when the period ends as a plain line beside it,
  /// or under it when both don't fit.
  private func header(_ account: CloudPhoneAccount) -> some View {
    let title = HStack(spacing: 8) {
      CloudLogo(size: 18, glow: true)
      Text("ADE Cloud")
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(CloudBrandColor.skyText)
        .fixedSize()
      CloudPlanWord(text: cloudPlanLabel(account.currentPlanId))
        .shadow(color: celebrating ? CloudBrandColor.lamp.opacity(0.8) : .clear, radius: 14)
        .fixedSize()
    }
    let period = periodLine(account).map { line in
      Text(line.0)
        .font(.system(size: 12.5, weight: line.1 == .plain ? .regular : .semibold))
        .foregroundStyle(line.1.color)
        .fixedSize(horizontal: false, vertical: true)
    }
    return ViewThatFits(in: .horizontal) {
      HStack(alignment: .center, spacing: 8) {
        title
        Spacer(minLength: 8)
        period?.fixedSize()
      }
      VStack(alignment: .leading, spacing: 6) {
        title
        period
      }
    }
    .accessibilityElement(children: .combine)
  }

  private enum PeriodTone: Equatable {
    case plain, warn, crit
    var color: Color {
      switch self {
      case .plain: CloudBrandColor.skyText2
      case .warn: Color(red: 0.988, green: 0.827, blue: 0.302)
      case .crit: Color(red: 0.988, green: 0.647, blue: 0.647)
      }
    }
  }

  /// "Renews Dec 13", "Ends Dec 13", "Plus from Dec 13", "Payment failed", "Resets Dec 13".
  private func periodLine(_ account: CloudPhoneAccount) -> (String, PeriodTone)? {
    guard let billing = account.billing else { return nil }
    let end = cloudDate(billing.periodEnd)
    if billing.notice == "past_due" { return ("Payment failed", .crit) }
    if billing.cancelAtPeriodEnd == true { return ("Ends \(end)", .warn) }
    if let next = billing.nextPlanId, next != account.currentPlanId { return ("\(cloudPlanLabel(next)) from \(end)", .plain) }
    return (account.plan == "paid" ? "Renews \(end)" : "Resets \(end)", .plain)
  }

  /// The free plan's hours are held, so the account has none of its own
  /// this month: the GitHub rules hold them, or this computer's free plan
  /// went to another account.
  private func freeHoursHeld(_ account: CloudPhoneAccount) -> Bool {
    guard account.plan == "free", account.hours.includedMilli <= 0, (account.catalog?.plans.free.includedMilli ?? 0) > 0 else { return false }
    return account.freePlan?.github != nil || account.freePlan?.state == "refused"
  }

  private func balance(_ account: CloudPhoneAccount, words: CloudBalanceWords) -> some View {
    let hours = account.hours
    let notes = cloudHoursNotes(account, now: store.now)
    return VStack(alignment: .leading, spacing: 8) {
      Text(words.leftTitle)
        .font(.system(size: 12))
        .foregroundStyle(CloudBrandColor.skyText2)
        .fixedSize(horizontal: false, vertical: true)
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(cloudHours(hours.leftMilli))
          .font(.system(size: 44, weight: .medium))
          .tracking(-1.2)
          .foregroundStyle(CloudBrandColor.skyText)
          .lineLimit(1)
          .minimumScaleFactor(0.6)
        // Free hours held (GitHub rules, or another account used them here):
        // the plan's hours, on hold, never "of 0 h" (the desktop's hero).
        Text(freeHoursHeld(account)
          ? "\(words.of(account.catalog?.plans.free.includedMilli ?? 0)), on hold"
          : words.of(hours.includedMilli))
          .font(.system(size: 13))
          .foregroundStyle(CloudBrandColor.skyText2)
          .fixedSize(horizontal: false, vertical: true)
      }
      .accessibilityElement(children: .combine)
      CloudCreditsBar(account: account)
      // The same number as the big one above, so the two never disagree.
      if let line = words.leftBuys(
        hours.leftMilli,
        medium: store.tiers.first { $0.id == "medium" },
        phoneOn: account.phoneOn
      ) {
        Text(line)
          .font(.system(size: 12.5))
          .foregroundStyle(CloudBrandColor.skyText)
          .fixedSize(horizontal: false, vertical: true)
      }
      ForEach(notes.filter { $0.tone == .warn }, id: \.self) { note in
        Text(note.text)
          .font(.system(size: 12))
          .foregroundStyle(Color(red: 0.988, green: 0.827, blue: 0.302))
          .fixedSize(horizontal: false, vertical: true)
      }
      // Earned, extra and the pace: plain lines, never pills.
      let facts = notes.filter { $0.tone != .warn }
      if !facts.isEmpty {
        VStack(alignment: .leading, spacing: 3) {
          ForEach(facts, id: \.self) { note in
            Text(note.text)
              .font(.system(size: 12))
              .foregroundStyle(note.tone == .lamp || note.tone == .on ? CloudBrandColor.lamp : CloudBrandColor.skyText2)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
        .padding(.top, 2)
      }
    }
  }

  /// The computers and Small, side by side; one over the other at the
  /// accessibility text sizes.
  @ViewBuilder
  private func meters(_ account: CloudPhoneAccount, words: CloudBalanceWords) -> some View {
    let layout = dynamicTypeSize.isAccessibilitySize
      ? AnyLayout(VStackLayout(alignment: .leading, spacing: 10))
      : AnyLayout(HStackLayout(alignment: .top, spacing: 10))
    layout {
      if let computers = account.computers {
        // The plan's computer limit, asleep or not.
        let limit = account.computerLimit
        CloudMiniMeter(
          label: "Cloud computers",
          value: "\(computers.total)",
          of: limit.map { "of \($0)" },
          fraction: limit.map { Double(computers.total) / Double(max(1, $0)) },
          note: "\(computers.awake) awake now"
        )
      }
      // Small shows only when it uses the balance (Free, sponsored cards off);
      // an unlimited Small is the plan's fact, not a meter.
      if let small = cloudSmallTierUsingHours(account) {
        CloudMiniMeter(
          label: "Small computers",
          value: small.hoursLeftLabel(account.hours.leftMilli + max(0, account.earnedHours?.leftMilli ?? 0)),
          of: nil,
          fraction: nil,
          note: account.sponsored?.smallUsesHoursWithoutCards == true ? "Left at this size. Sponsored cards make it unlimited." : "Left at this size"
        )
      }
      if let past = pastYourPlan(account, words: words) {
        CloudMiniMeter(label: "When credits run out", value: past.value, of: nil, fraction: nil, note: past.note)
      }
    }
    // The two tiles stand as tall as the taller one.
    .fixedSize(horizontal: false, vertical: true)
  }

  /// What happens past the plan's balance: extra on or off, or the free plan
  /// stopping. No price here (App Store 3.1.1); the desktop shows it.
  private func pastYourPlan(_ account: CloudPhoneAccount, words: CloudBalanceWords) -> (value: String, note: String)? {
    if let extra = account.extraHours, extra.available {
      guard extra.enabled else { return ("Pause", "Bigger computers pause until the plan renews") }
      let used = extra.usedMilli ?? 0
      return ("Keep going", used > 0 ? "\(words.amount(used)) extra this month" : "Extra \(words.unit), billed after use")
    }
    if account.plan == "free" { return ("Pause", "Bigger computers pause until next month") }
    return nil
  }
}

/// Credits on the hero: the whole plan as one bar, the computers' and the
/// iPhone's use as two segments and what is left as the rest, with a legend
/// of the three numbers under it. The iPhone shows only while it is on for
/// the account or used some this period.
struct CloudCreditsBar: View {
  let account: CloudPhoneAccount

  private struct Part: Identifiable {
    let id: String
    let label: String
    let milli: Int
    let color: Color
  }

  private var parts: [Part] {
    let hours = account.hours
    let used = max(0, hours.usedMilli ?? max(0, hours.includedMilli - hours.leftMilli))
    let phone = min(used, max(0, account.phone?.creditsUsedMilli ?? 0))
    var parts = [Part(id: "computers", label: "Computers", milli: used - phone, color: CloudBrandColor.violetLight)]
    if account.phoneOn || phone > 0 {
      parts.append(Part(id: "iphone", label: "iPhone", milli: phone, color: CloudBrandColor.roseLight))
    }
    parts.append(Part(id: "left", label: "Left", milli: max(0, hours.leftMilli), color: Color.white.opacity(0.22)))
    return parts
  }

  var body: some View {
    let parts = parts
    // The plan, or more when extra credits ran past it.
    let total = max(1, max(account.hours.includedMilli, parts.reduce(0) { $0 + $1.milli }))
    VStack(alignment: .leading, spacing: 10) {
      GeometryReader { geo in
        HStack(spacing: 0) {
          ForEach(parts) { part in
            Rectangle()
              .fill(part.color)
              .frame(width: geo.size.width * Double(part.milli) / Double(total))
          }
        }
        .frame(width: geo.size.width, alignment: .leading)
        .background(Color.white.opacity(0.12))
        .clipShape(Capsule())
      }
      .frame(height: 8)
      .accessibilityHidden(true)
      HStack(alignment: .top, spacing: 8) {
        ForEach(parts) { part in
          VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 5) {
              Circle().fill(part.color).frame(width: 7, height: 7)
              Text(part.label)
                .font(.system(size: 11.5))
                .foregroundStyle(CloudBrandColor.skyText2)
                .fixedSize(horizontal: false, vertical: true)
            }
            Text(cloudHours(part.milli))
              .font(.system(size: 15, weight: .medium))
              .monospacedDigit()
              .foregroundStyle(CloudBrandColor.skyText)
              .fixedSize(horizontal: false, vertical: true)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          .accessibilityElement(children: .ignore)
          .accessibilityLabel("\(part.label): \(CloudBalanceWords(account).spelled(part.milli))")
        }
      }
    }
  }
}

/// The computers and Small on the sky: frosted glass, white text. Every
/// line wraps; none is cut off.
struct CloudMiniMeter: View {
  let label: String
  let value: String
  let of: String?
  /// Nil for a count with nothing to fill toward: the meter's row stays, empty, so the two line up.
  let fraction: Double?
  let note: String

  var body: some View {
    VStack(alignment: .leading, spacing: 5) {
      Text(label)
        .font(.system(size: 11.5))
        .foregroundStyle(CloudBrandColor.skyText2)
        .fixedSize(horizontal: false, vertical: true)
      HStack(alignment: .firstTextBaseline, spacing: 4) {
        Text(value)
          .font(.system(size: 19, weight: .medium))
          .foregroundStyle(CloudBrandColor.skyText)
          .lineLimit(1)
          .minimumScaleFactor(0.7)
        if let of {
          Text(of).font(.system(size: 11.5)).foregroundStyle(CloudBrandColor.skyText2)
        }
      }
      if let fraction {
        let percentLeft = (1 - min(1, fraction)) * 100
        ADEKitMeter(
          fraction: fraction,
          color: ADEUsagePressure.color(percentLeft: percentLeft, fallback: CloudBrandColor.violetLight)
        )
      } else {
        ADEKitMeter(fraction: 0, color: ADEKit.fill).hidden().accessibilityHidden(true)
      }
      Text(note)
        .font(.system(size: 11))
        .foregroundStyle(CloudBrandColor.skyText2)
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(10)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .background(.ultraThinMaterial.opacity(0.5), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .background(CloudBrandColor.glass, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(CloudBrandColor.glassEdge, lineWidth: 0.75))
    .accessibilityElement(children: .combine)
  }
}

// MARK: Notices

/// Out of hours, a failed payment, a full disk, what a cheaper plan will
/// free and what it freed, cancelled timed wakes, and the last action's
/// failure (the desktop's `PlanNotices`, in its words).
struct CloudNotices: View {
  @ObservedObject var store: CloudPaneStore

  var body: some View {
    VStack(spacing: 8) {
      if let account = store.account {
        if account.billing?.notice == "past_due" {
          ADESettingsNotice(message: "A payment didn't go through, so your plan follows the free plan's limits until it's paid.", tone: .crit)
        } else if account.outOfHours {
          ADESettingsNotice(message: CloudBalanceWords(account).outNotice(smallUsesBalance: cloudSmallTierUsingHours(account) != nil), tone: .warn)
        }
        if account.atComputerLimit, let limit = account.computerLimit {
          // Every computer of the plan is taken: a new lane would be refused.
          ADESettingsNotice(message: "\(CloudComputerLimit.headline(limit: limit)) A new lane needs a computer of its own.", tone: .neutral, actionTitle: "Make room") {
            CloudLaneActions.shared.showComputerLimit(CloudComputerLimit(
              message: CloudComputerLimit.headline(limit: limit),
              planId: account.currentPlanId,
              limit: limit,
              total: account.computers?.total,
              lanes: [],
              nextPlan: account.computers?.nextPlan
            ))
          }
        }
        if let cleanup = account.planCleanup, let message = cloudPlanCleanupMessage(cleanup) {
          ADESettingsNotice(message: message, tone: .warn)
        }
        if let done = account.planCleanupDone, let sentence = cloudPlanCleanupDoneSentence(done) {
          ADESettingsNotice(message: "ADE freed computers for your plan. \(sentence)", tone: .neutral)
        }
        if let wakes = account.timedWakesCancelled {
          ADESettingsNotice(message: cloudTimedWakesCancelledSentence(wakes, resetsAt: account.billing?.periodEnd, words: CloudBalanceWords(account)), tone: .warn)
        }
        ForEach(account.dueForDeletion, id: \.instanceId) { entry in
          ADESettingsNotice(message: cloudIdleCleanupMessage(entry, now: store.now.timeIntervalSince1970 * 1000), tone: .warn)
        }
      }
      if let error = store.actionError {
        ADESettingsNotice(message: error, tone: .crit, dismiss: { store.actionError = nil })
      }
    }
  }
}

// MARK: Lanes and computers

struct CloudLanesCard: View {
  @ObservedObject var store: CloudPaneStore
  var pushes: Bool
  /// The lanes ADE kept without a computer, every project's: they list under the computers.
  @ObservedObject private var cloudStore = AccountCloudStore.shared

  private var hint: String? {
    guard let computers = store.account?.computers else { return nil }
    return "\(computers.total) \(computers.total == 1 ? "computer" : "computers") · \(computers.awake) awake"
  }

  var body: some View {
    // An unread list is not an empty one: the server's sentence, no count.
    let unread = store.machines.isEmpty ? store.instancesError : nil
    ADEKitCard(title: "Lanes and computers", symbol: "desktopcomputer", count: unread == nil ? "\(store.machines.count)" : nil, hint: unread == nil ? hint : nil, flush: true) {
      if let unread {
        ADESettingsNotice(message: unread, tone: .warn, actionTitle: "Try again") {
          Task { await store.reload() }
        }
        .padding(.horizontal, ADEKit.inset)
        .padding(.bottom, ADEKit.inset)
        // Every branch keeps the block: it shows nothing when empty, and its pull and first-look reads live in it.
        keptLanes
      } else if store.machines.isEmpty, cloudStore.lanesWithoutComputer.isEmpty, cloudStore.lanesWithoutComputerUnread {
        // The kept lanes couldn't be read: an empty list says nothing.
        ADESettingsNotice(message: "ADE couldn't read your cloud lanes without a computer.", tone: .warn, actionTitle: "Try again") {
          Task { await cloudStore.refreshLanesWithoutComputer(using: store.syncService, force: true) }
        }
        .padding(.horizontal, ADEKit.inset)
        .padding(.bottom, ADEKit.inset)
        keptLanes
      } else if store.machines.isEmpty, cloudStore.lanesWithoutComputer.isEmpty {
        Text("No cloud lanes yet. Pick ADE Cloud under Run on when you send a message: ADE makes a computer for the lane, and it shows here.")
          .font(.system(size: 13))
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
          .padding(.horizontal, ADEKit.inset)
          .padding(.bottom, ADEKit.inset)
        keptLanes
      } else {
        VStack(spacing: 0) {
          ForEach(Array(store.machines.enumerated()), id: \.element.id) { index, machine in
            if index > 0 { ADESettingsHairline() }
            row(machine)
          }
        }
        keptLanes
      }
    }
  }

  /// Lanes whose computer ADE removed while it kept the lane (every
  /// project's, as the computers above are), each with "New computer".
  private var keptLanes: some View {
    CloudKeptLanesBlock(
      origin: nil,
      refreshToken: store.refreshes,
      onComputerUp: { await store.load() },
      insets: EdgeInsets(top: store.machines.isEmpty ? 0 : 8, leading: ADEKit.inset, bottom: ADEKit.inset, trailing: ADEKit.inset),
      opensChats: false
    )
  }

  @ViewBuilder
  private func row(_ machine: CloudPhoneMachine) -> some View {
    let rowView = CloudMachineRow(
      machine: machine,
      tier: cloudPhoneTier(of: machine, in: store.tiers),
      words: CloudBalanceWords(store.account),
      idle: store.account?.dueForDeletion.first { $0.instanceId == machine.instanceId },
      now: store.now,
      busy: store.busy.contains(machine.instanceId)
    )
    if pushes {
      // A link that carries its page, not a value: Settings' stack keeps a
      // `[String]` path, which can't hold a machine, so a value link there
      // did nothing.
      NavigationLink { CloudMachineScreen(store: store, instanceId: machine.instanceId) } label: { rowView }
        .buttonStyle(ADEKitRowButtonStyle())
    } else {
      Button {
        ADEHaptics.light()
        store.selectedId = machine.instanceId
      } label: { rowView }
        .buttonStyle(ADEKitRowButtonStyle())
        .background(store.selected?.instanceId == machine.instanceId ? ADEColor.accent.opacity(0.12) : Color.clear)
    }
  }
}

struct CloudMachineRow: View {
  let machine: CloudPhoneMachine
  let tier: CloudPhoneTier?
  let words: CloudBalanceWords
  var idle: CloudPhoneAccount.IdleCleanup? = nil
  let now: Date
  var busy = false

  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: tier?.symbol ?? "cloud")
        .font(.system(size: 13, weight: .medium))
        .foregroundStyle(ADEColor.textSecondary)
        .frame(width: 28, height: 28)
        .background(ADEKit.track, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
      VStack(alignment: .leading, spacing: 3) {
        HStack(spacing: 6) {
          Text(machine.displayName)
            .font(.system(size: 15, weight: .medium))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
          if let mark = cloudMachineMark(machine, idle: idle, now: now) {
            ADEKitTag(text: mark.text, tone: mark.tone)
          }
        }
        Text(cloudMachineLine(machine, tier: tier, now: now, words: words))
          .font(.system(size: 12.5))
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
      }
      .layoutPriority(1)
      Spacer(minLength: 8)
      if busy {
        ProgressView()
      } else {
        VStack(alignment: .trailing, spacing: 3) {
          HStack(spacing: 5) {
            ADEKitDot(tone: cloudStateTone(machine))
            Text(machine.stateLabel)
              .font(.system(size: 12.5))
              .foregroundStyle(ADEColor.textSecondary)
          }
          let lastRun = cloudLastRun(machine, now: now)
          if !lastRun.isEmpty && !machine.isAwake {
            Text(lastRun)
              .font(.system(size: 11.5))
              .foregroundStyle(ADEColor.textMuted)
          }
        }
        .fixedSize()
      }
    }
    .padding(.horizontal, ADEKit.inset)
    .padding(.vertical, 10)
    .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
    .contentShape(Rectangle())
    .accessibilityElement(children: .combine)
  }
}

// MARK: Sizes

/// The four sizes (`CloudSizeCards.tsx`), one row each, read at a glance:
/// the hours left as time on that size (big; "Unlimited" on Small, which
/// never uses hours unless the catalog rates it), CPU · memory, and "Full computer" where it is one.
/// Never a multiplier and never disk. The desktop screen every size has is
/// said once in the hint (one line: the kit hint does not wrap); what a size runs is read out.
struct CloudSizesCard: View {
  let account: CloudPhoneAccount
  let tiers: [CloudPhoneTier]

  private var leftMilli: Int { account.hours.leftMilli + max(0, account.earnedHours?.leftMilli ?? 0) }
  private var words: CloudBalanceWords { CloudBalanceWords(account) }

  var body: some View {
    if !tiers.isEmpty {
      ADEKitCard(title: "Sizes", symbol: "cpu", hint: "Every size has a screen the agent can use.", flush: true) {
        VStack(spacing: 0) {
          ForEach(Array(tiers.enumerated()), id: \.element.id) { index, tier in
            if index > 0 { ADESettingsHairline() }
            row(tier)
          }
        }
      }
    }
  }

  private func facts(_ tier: CloudPhoneTier) -> String {
    tier.specs.joined(separator: " · ")
  }

  private func row(_ tier: CloudPhoneTier) -> some View {
    HStack(alignment: .center, spacing: 12) {
      Image(systemName: tier.symbol)
        .font(.system(size: 13, weight: .medium))
        .foregroundStyle(CloudBrandColor.mark)
        .frame(width: 28, height: 28)
        .background(CloudBrandColor.violet.opacity(0.12), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
      VStack(alignment: .leading, spacing: 3) {
        // The name never breaks; the tag goes under it when it doesn't fit beside it.
        let name = Text(tier.label)
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1).fixedSize()
        if tier.full {
          ViewThatFits(in: .horizontal) {
            HStack(spacing: 6) { name; ADEKitTag(text: "Full computer").fixedSize() }
            VStack(alignment: .leading, spacing: 4) { name; ADEKitTag(text: "Full computer").fixedSize() }
          }
        } else {
          name
        }
        Text(facts(tier))
          .font(.system(size: 12.5))
          .foregroundStyle(ADEColor.textSecondary)
        Text(words.uses(tier))
          .font(.system(size: 12))
          .foregroundStyle(ADEColor.textMuted)
      }
      Spacer(minLength: 8)
      VStack(alignment: .trailing, spacing: 0) {
        Text(tier.hoursLeftLabel(leftMilli))
          .font(.system(size: tier.usesHours ? 24 : 18, weight: .semibold))
          .monospacedDigit()
          .foregroundStyle(CloudBrandColor.mark)
          .lineLimit(1)
          .minimumScaleFactor(0.7)
        Text(tier.usesHours ? "left on it" : "this month")
          .font(.system(size: 11))
          .foregroundStyle(ADEColor.textMuted)
      }
    }
    .padding(.horizontal, ADEKit.inset)
    .padding(.vertical, 11)
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .combine)
    .accessibilityHint("\(tier.runs). \(tier.hoursLine(leftMilli: leftMilli, words: words)).")
  }
}

// MARK: Invite friends

/// "Invite friends, get free cloud hours" (`CloudInvite.tsx`): the person's
/// own link with Copy and Share, friends joined, hours earned, rewards left,
/// and, while they may, a box for someone else's invite. Sharing a link is
/// not a purchase; nothing here sells hours.
struct CloudInviteCard: View {
  let referral: CloudPhoneReferral
  let syncService: SyncService
  /// The account's unit: rewards are hours, or credits.
  let words: CloudBalanceWords
  let onChanged: () -> Void
  @State private var copied = false

  private var reward: String { cloudHours(referral.rewardMilli) }

  var body: some View {
    ADEKitCard(title: "Invite friends, get \(words.freeCloud)", symbol: "gift") {
      VStack(alignment: .leading, spacing: 12) {
        Text("When a friend you invite runs their first chat on ADE Cloud, you both get \(reward) \(words.free). They never expire, and they're used after your plan's \(words.unit).")
          .font(.system(size: 13))
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
        Text(referral.link)
          .font(.adeMono(12.5))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
          .truncationMode(.middle)
          .textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .leading)
          .adeKitField(padding: 10)
        HStack(spacing: 8) {
          Button {
            UIPasteboard.general.string = referral.link
            ADEHaptics.light()
            copied = true
            ProductAnalytics.shared.captureInvite(.linkCopied, outcome: "from_dashboard")
          } label: {
            Label(copied ? "Copied" : "Copy link", systemImage: copied ? "checkmark" : "doc.on.doc")
          }
          .buttonStyle(ADEKitButtonStyle(prominent: true))
          if let url = URL(string: referral.link) {
            ShareLink(item: url, subject: Text("ADE"), message: Text("You both get \(reward) \(words.freeCloud).")) {
              Label("Share", systemImage: "square.and.arrow.up")
            }
            .buttonStyle(ADEKitButtonStyle())
            .simultaneousGesture(TapGesture().onEnded {
              ProductAnalytics.shared.captureInvite(.linkCopied, outcome: "shared_from_dashboard")
            })
          }
        }
        HStack(spacing: 8) {
          stat("Friends joined", "\(referral.friendsJoined)")
          stat("\(words.title) earned", cloudHours(referral.hoursEarnedMilli))
          stat("Rewards left", "\(referral.rewardsLeft) of \(referral.rewardLimit)")
        }
        if referral.offersCodeBox {
          VStack(alignment: .leading, spacing: 6) {
            Text("Were you invited?")
              .font(.system(size: 13.5, weight: .semibold))
              .foregroundStyle(ADEColor.textPrimary)
            Text(referral.enterCodeUntil.map { "Paste the link or code by \(cloudDate($0))." } ?? "Paste the link or code.")
              .font(.system(size: 12.5))
              .foregroundStyle(ADEColor.textSecondary)
            CloudInviteCodeBox(syncService: syncService, rewardMilli: referral.rewardMilli, words: words, onDone: { _ in onChanged() })
          }
          .padding(.top, 2)
        } else if referral.hasReferrer {
          Text(referral.referredState == "rewarded"
            ? "You were invited, and you both got \(reward) \(words.unit)."
            : referral.referredState == "refused"
              ? "You were invited, but that invite can't give \(words.unit) on this account."
              : "You were invited. You both get \(reward) \(words.unit) when your first chat runs on ADE Cloud.")
            .font(.system(size: 12.5))
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
    }
  }

  private func stat(_ label: String, _ value: String) -> some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(label)
        .font(.system(size: 11.5))
        .foregroundStyle(ADEColor.textMuted)
        .lineLimit(2)
        .fixedSize(horizontal: false, vertical: true)
      Text(value)
        .font(.system(size: 16, weight: .medium, design: .monospaced))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)
        .minimumScaleFactor(0.7)
    }
    .padding(10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(ADEKit.track.opacity(0.6), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    .accessibilityElement(children: .combine)
  }
}

/// "Paste an invite link or code": the friend's side of an invite, on the
/// ADE Cloud page and in Settings › Account. A full link, an `ade://` link or
/// the bare code; the server checks every rule and says why it refuses.
struct CloudInviteCodeBox: View {
  let syncService: SyncService
  /// Hours per reward from the referral the caller shows; the answer's own wins.
  let rewardMilli: Int
  /// The account's unit: rewards are hours, or credits.
  let words: CloudBalanceWords
  let onDone: (CloudPhoneReferral?) -> Void
  @State private var code = ""
  @State private var busy = false
  @State private var error: String?
  @State private var accepted: String?

  private var canWrite: Bool { syncService.canInvokeRemoteAction("cloud.write") }

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      if let accepted {
        Label(accepted, systemImage: "checkmark.circle.fill")
          .font(.system(size: 13, weight: .medium))
          .foregroundStyle(ADEColor.success)
          .fixedSize(horizontal: false, vertical: true)
      } else {
        HStack(spacing: 8) {
          TextField("Paste an invite link or code", text: $code)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .font(.adeMono(13))
            .submitLabel(.go)
            .onSubmit { Task { await submit() } }
            .adeKitField(padding: 10)
            .accessibilityLabel("Invite link or code")
          Button(busy ? "Checking…" : "Add invite") { Task { await submit() } }
            .buttonStyle(ADEKitButtonStyle(prominent: true))
            .disabled(busy || code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !canWrite)
        }
        if let error {
          Text(error)
            .font(.system(size: 12.5))
            .foregroundStyle(ADEColor.danger)
            .fixedSize(horizontal: false, vertical: true)
        } else if !canWrite {
          Text("Add it from a phone that controls \(syncService.machineDisplayName).")
            .font(.system(size: 12))
            .foregroundStyle(ADEColor.textMuted)
        }
      }
    }
  }

  private func submit() async {
    let value = code.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !value.isEmpty, !busy else { return }
    busy = true
    defer { busy = false }
    error = nil
    let outcome = await syncService.redeemCloudInvite(value)
    if outcome.ok {
      ADEHaptics.success()
      let reward = cloudHours(outcome.referral?.rewardMilli ?? rewardMilli)
      accepted = outcome.rewarded == true
        ? "You both got \(reward) \(words.freeCloud). They never expire."
        : "Invite added. You both get \(reward) \(words.freeCloud) when your first chat runs on ADE Cloud."
      onDone(outcome.referral)
    } else {
      ADEHaptics.error()
      error = outcome.message ?? "That invite didn't work."
    }
  }
}

// MARK: Agents

struct CloudAgentsCard: View {
  @ObservedObject var store: CloudPaneStore

  var body: some View {
    ADEKitCard(title: "What agents may do alone", symbol: "shield.lefthalf.filled", flush: true) {
      NavigationLink {
        CloudLimitsScreen(store: store)
      } label: {
        ADESettingsRow(
          title: store.limits.map(cloudLimitsPresetName) ?? "…",
          hint: store.limits.map { cloudLimitsSummary($0, words: CloudBalanceWords(store.account)) } ?? store.limitsError ?? "Reading…"
        ) {
          ADESettingsChevron()
        }
      }
      .buttonStyle(ADEKitRowButtonStyle())
    }
  }
}
