import SwiftUI
import UIKit

// The ADE Cloud page's cards (`CloudDashboardScreen`), top to bottom: the
// hero, the notices, lanes and computers, plans, sizes, invite friends, and
// what agents may do. The sign-ins card is `CloudSignInsCard.swift`; the
// words they share are `CloudPhoneFormat.swift`.

// MARK: - The page

struct CloudDashboardScreen: View {
  @ObservedObject var store: CloudPaneStore
  /// Close, for the sheet; nil inside Settings, whose stack has its own.
  var onClose: (() -> Void)?
  /// True on a phone: a row pushes the computer. False in the book layout: a row selects it.
  var pushes: Bool
  /// "You're on Plus", once per account, plan and period (`CloudPlanSeenStore`).
  @State private var moment: CloudPlanMoment?

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
          CloudNotices(store: store)
          CloudLanesCard(store: store, pushes: pushes)
          if let account = store.account, account.catalog != nil {
            CloudPlansCard(account: account, newPlanId: moment?.planId)
            CloudSizesCard(account: account, tiers: store.tiers)
          }
          if let referral = store.account?.referral {
            CloudInviteCard(referral: referral, syncService: store.syncService, onChanged: { Task { await store.reload() } })
          }
          CloudSignInsCard(store: store)
          CloudAgentsCard(store: store)
        }
      }
      .padding(.horizontal, 16)
      .padding(.top, 8)
      .padding(.bottom, 36)
    }
    .background(ADEColor.pageBackground.ignoresSafeArea())
    .refreshable { await store.reload() }
    .onAppear { observePlan(store.account) }
    .onChange(of: store.account) { _, account in observePlan(account) }
    .navigationTitle("ADE Cloud")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      if let onClose {
        ToolbarItem(placement: .topBarLeading) {
          Button { onClose() } label: { Image(systemName: "xmark").font(.system(size: 13, weight: .semibold)) }
            .accessibilityLabel("Close ADE Cloud")
        }
      }
    }
  }

  private func observePlan(_ account: CloudPhoneAccount?) {
    guard let account else { return }
    if let landed = CloudPlanSeenStore.observe(account) {
      moment = landed
      ProductAnalytics.shared.captureFeature(.cloudPlan, outcome: .completed)
    } else if let shown = moment, shown.planId != account.currentPlanId {
      moment = nil
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
/// plan in gold, when it renews, the hours, disk and computers. The numbers
/// are said once on the page; nothing below repeats them.
struct CloudHero: View {
  @ObservedObject var store: CloudPaneStore
  /// A plan that just landed ("You're on Plus"): its name glows.
  var celebrating = false

  var body: some View {
    if let account = store.account {
      let shape = RoundedRectangle(cornerRadius: 18, style: .continuous)
      VStack(alignment: .leading, spacing: 16) {
        HStack(spacing: 8) {
          CloudLogo(size: 18, glow: true)
          Text("ADE Cloud")
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(CloudBrandColor.skyText)
          CloudPlanWord(text: cloudPlanLabel(account.currentPlanId))
            .shadow(color: celebrating ? CloudBrandColor.lamp.opacity(0.8) : .clear, radius: 14)
          Spacer(minLength: 0)
          if let period = periodChip(account) {
            CloudSkyChip(text: period.0, tone: period.1)
          }
        }
        .accessibilityElement(children: .combine)
        hours(account)
        HStack(alignment: .top, spacing: 10) {
          if let disk = account.disk {
            CloudMiniMeter(
              label: "Disk",
              value: cloudGb(disk.usedGb),
              of: disk.limitGb.map { "of \(cloudGb($0))" },
              fraction: disk.limitGb.map { $0 > 0 ? disk.usedGb / $0 : 0 } ?? 0,
              note: "All your computers together"
            )
          }
          if let computers = account.computers {
            // No plan limits how many computers an account has: a count, with an empty meter.
            CloudMiniMeter(
              label: "Computers",
              value: "\(computers.total)",
              of: nil,
              fraction: nil,
              note: "\(computers.awake) awake now"
            )
          }
        }
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

  /// "Renews Dec 13", "Ends Dec 13", "Plus from Dec 13", "Payment failed", "Resets Dec 13".
  private func periodChip(_ account: CloudPhoneAccount) -> (String, CloudSkyChip.Tone)? {
    guard let billing = account.billing else { return nil }
    let end = cloudDate(billing.periodEnd)
    if billing.notice == "past_due" { return ("Payment failed", .crit) }
    if billing.cancelAtPeriodEnd == true { return ("Ends \(end)", .warn) }
    if let next = billing.nextPlanId, next != account.currentPlanId { return ("\(cloudPlanLabel(next)) from \(end)", .plain) }
    return (account.plan == "paid" ? "Renews \(end)" : "Resets \(end)", .plain)
  }

  private func hours(_ account: CloudPhoneAccount) -> some View {
    let hours = account.hours
    let percentLeft = hours.includedMilli > 0 ? Double(hours.leftMilli) / Double(hours.includedMilli) * 100 : 0
    let notes = cloudHoursNotes(account, now: store.now)
    let level = ADEUsagePressure.color(percentLeft: percentLeft, fallback: CloudBrandColor.violet)
    let calm = percentLeft > 20
    return VStack(alignment: .leading, spacing: 8) {
      Text("Computer hours left this month")
        .font(.system(size: 12))
        .foregroundStyle(CloudBrandColor.skyText2)
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(cloudHours(hours.leftMilli))
          .font(.system(size: 44, weight: .medium))
          .tracking(-1.2)
          .foregroundStyle(CloudBrandColor.skyText)
          .lineLimit(1)
          .minimumScaleFactor(0.6)
        Text("of \(cloudHours(hours.includedMilli)) h")
          .font(.system(size: 13))
          .foregroundStyle(CloudBrandColor.skyText2)
      }
      .accessibilityElement(children: .combine)
      GeometryReader { geo in
        ZStack(alignment: .leading) {
          Capsule().fill(Color.white.opacity(0.12))
          Capsule()
            .fill(calm ? AnyShapeStyle(CloudBrandColor.fill) : AnyShapeStyle(level))
            .frame(width: max(0, min(1, percentLeft / 100)) * geo.size.width)
            .shadow(color: calm ? CloudBrandColor.roseLight.opacity(0.45) : .clear, radius: 6)
        }
      }
      .frame(height: 6)
      .accessibilityHidden(true)
      ForEach(notes.filter { $0.tone == .warn }, id: \.self) { note in
        Text(note.text)
          .font(.system(size: 12))
          .foregroundStyle(Color(red: 0.988, green: 0.827, blue: 0.302))
          .fixedSize(horizontal: false, vertical: true)
      }
      let chips = notes.filter { $0.tone != .warn }
      if !chips.isEmpty {
        CloudFlowRow(spacing: 6) {
          ForEach(chips, id: \.self) { note in
            switch note.tone {
            case .lamp: CloudSkyChip(text: note.text, tone: .lamp)
            case .on: CloudSkyChip(text: "\u{25CF} \(note.text)", tone: .lamp)
            default: CloudSkyChip(text: note.text)
            }
          }
        }
        .padding(.top, 2)
      }
    }
  }
}

/// Disk and computers on the sky: frosted glass, white text.
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
      HStack(alignment: .firstTextBaseline, spacing: 4) {
        Text(value)
          .font(.system(size: 19, weight: .medium))
          .foregroundStyle(CloudBrandColor.skyText)
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
        .lineLimit(2)
    }
    .padding(10)
    .frame(maxWidth: .infinity, alignment: .leading)
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
          ADESettingsNotice(message: "You're out of hours. Your computers wait until your hours reset. Running work saves and stops.", tone: .warn)
        }
        if let disk = account.disk, let limit = disk.limitGb, limit > 0, disk.usedGb / limit >= 0.8 {
          ADESettingsNotice(message: "Your disk is \(Int((disk.usedGb / limit * 100).rounded()))% full. Free some space in the ADE desktop app before your lanes need more.", tone: .warn)
        }
        if let cleanup = account.planCleanup, let message = cloudPlanCleanupMessage(cleanup) {
          ADESettingsNotice(message: message, tone: .warn)
        }
        if let done = account.planCleanupDone, let sentence = cloudPlanCleanupDoneSentence(done) {
          ADESettingsNotice(message: "ADE freed computers for your plan. \(sentence)", tone: .neutral)
        }
        if let wakes = account.timedWakesCancelled {
          ADESettingsNotice(message: cloudTimedWakesCancelledSentence(wakes, resetsAt: account.billing?.periodEnd), tone: .warn)
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

  private var hint: String? {
    guard let computers = store.account?.computers else { return nil }
    return "\(computers.total) \(computers.total == 1 ? "computer" : "computers") · \(computers.awake) awake"
  }

  var body: some View {
    ADEKitCard(title: "Lanes and computers", symbol: "desktopcomputer", count: "\(store.machines.count)", hint: hint, flush: true) {
      if store.machines.isEmpty {
        Text("No cloud lanes yet. Pick ADE Cloud under Run on when you send a message: ADE makes a computer for the lane, and it shows here.")
          .font(.system(size: 13))
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
          .padding(.horizontal, ADEKit.inset)
          .padding(.bottom, ADEKit.inset)
      } else {
        VStack(spacing: 0) {
          ForEach(Array(store.machines.enumerated()), id: \.element.id) { index, machine in
            if index > 0 { ADESettingsHairline() }
            row(machine)
          }
        }
      }
    }
  }

  @ViewBuilder
  private func row(_ machine: CloudPhoneMachine) -> some View {
    let rowView = CloudMachineRow(
      machine: machine,
      tier: cloudPhoneTier(of: machine, in: store.tiers),
      idle: store.account?.dueForDeletion.first { $0.instanceId == machine.instanceId },
      now: store.now,
      busy: store.busy.contains(machine.instanceId)
    )
    if pushes {
      NavigationLink(value: machine) { rowView }
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
        Text(cloudMachineLine(machine, tier: tier, now: now))
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

// MARK: Plans

/// The plans side by side: what each includes, the current one on its own
/// patch of dusk sky with a gold edge. No price, no button and no line on
/// where to change a plan (App Store 3.1.1/3.1.3): the iPhone app states facts
/// only. What an hour and disk are is said once, under the plans.
struct CloudPlansCard: View {
  let account: CloudPhoneAccount
  /// A plan that just landed ("You're on Plus"): its card is marked New and glows.
  var newPlanId: String? = nil

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

  private var showsSimulatorMinutes: Bool { columns.contains { $0.facts.phoneMinutes != nil } }

  /// The one place for the explanations: what every plan includes.
  private var howItWorks: some View {
    VStack(alignment: .leading, spacing: 0) {
      howRow("clock", "Hours run your cloud computers", "and renew every month: Linux computers your agents work on, one per lane, as many as you like. An hour is one hour of a Small computer; bigger sizes use hours faster.")
      Divider().overlay(ADEKit.edge)
      howRow("moon.stars", "Computers sleep on their own", "a few minutes after work stops, so your hours only go to real work.")
      Divider().overlay(ADEKit.edge)
      howRow("internaldrive", "Disk", "is what all your computers hold at one time, shared between them.")
      if showsSimulatorMinutes {
        Divider().overlay(ADEKit.edge)
        howRow("iphone", "iOS Simulator minutes (soon):", "time on an iPhone simulator in the cloud, for agents to test your app.")
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
        if current, let old = oldTermsHours(column), let end {
          bigFact(cloudHours(old), staysOn ? "computer hours until \(cloudDate(end)), then \(cloudHours(column.facts.includedMilli))" : "computer hours until \(cloudDate(end))", current: current)
        } else {
          bigFact(cloudHours(column.facts.includedMilli), "computer hours a month", current: current)
        }
      }
      VStack(alignment: .leading, spacing: 6) {
        if current, let old = oldTermsDisk(column), let end {
          fact("internaldrive", "\(cloudGb(old)) disk until \(cloudDate(end))\(staysOn ? ", then \(cloudGb(column.facts.diskGb))" : "")", current: current)
        } else {
          fact("internaldrive", "\(cloudGb(column.facts.diskGb)) disk", current: current)
        }
        if let minutes = column.facts.phoneMinutes {
          fact("iphone", "\(minutes) iOS Simulator minutes, soon", current: current)
        }
        fact("bolt", column.id == "free" ? "Stops at the limit" : "Extra hours if on", current: current, quiet: column.id == "free")
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
    .accessibilityLabel("\(column.label)\(current ? ", your plan" : "")\(isNew ? ", new" : ""): \(cloudHours(column.facts.includedMilli)) computer hours a month, \(cloudGb(column.facts.diskGb)) disk\(column.facts.phoneMinutes.map { ", \($0) iOS Simulator minutes, coming soon" } ?? "")")
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

  /// The paid plan's disk this period when it isn't the table's (old terms), else nil.
  private func oldTermsDisk(_ column: Column) -> Double? {
    guard account.plan == "paid", account.billing?.notice != "past_due", let limit = account.disk?.limitGb else { return nil }
    return limit != column.facts.diskGb ? limit : nil
  }

}

// MARK: Sizes

/// The four sizes (`CloudSizeCards.tsx`), one row each, read at a glance: how
/// fast it uses hours (big), CPU · memory · disk, "Full computer" where it is
/// one, and the hours left at that size. The desktop screen every size has is
/// said once in the hint (one line: the kit hint does not wrap); what a size runs and its rate in words are read out.
struct CloudSizesCard: View {
  let account: CloudPhoneAccount
  let tiers: [CloudPhoneTier]

  private var leftMilli: Int { account.hours.leftMilli + max(0, account.earnedHours?.leftMilli ?? 0) }

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
    (["\(tier.cpu) CPU", "\(cloudGbText(tier.memoryGb)) GB memory"] + (tier.diskMaxGb.map { ["\(cloudGbText($0)) GB disk"] } ?? []))
      .joined(separator: " · ")
  }

  private func row(_ tier: CloudPhoneTier) -> some View {
    HStack(alignment: .center, spacing: 12) {
      Image(systemName: tier.symbol)
        .font(.system(size: 13, weight: .medium))
        .foregroundStyle(CloudBrandColor.mark)
        .frame(width: 28, height: 28)
        .background(CloudBrandColor.violet.opacity(0.12), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
      VStack(alignment: .leading, spacing: 3) {
        HStack(spacing: 6) {
          Text(tier.label)
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(ADEColor.textPrimary)
          if tier.full { ADEKitTag(text: "Full computer") }
        }
        Text(facts(tier))
          .font(.system(size: 12.5))
          .foregroundStyle(ADEColor.textSecondary)
        (Text(tier.hoursLeftLabel(leftMilli)).fontWeight(.semibold).foregroundColor(ADEColor.textPrimary)
          + Text(" left at this size").foregroundColor(ADEColor.textMuted))
          .font(.system(size: 12))
      }
      Spacer(minLength: 8)
      VStack(alignment: .trailing, spacing: 0) {
        Text("\(tier.rate.formatted(.number.precision(.fractionLength(0...1))))×")
          .font(.system(size: 26, weight: .semibold))
          .monospacedDigit()
          .foregroundStyle(CloudBrandColor.mark)
        Text("hours")
          .font(.system(size: 11))
          .foregroundStyle(ADEColor.textMuted)
      }
    }
    .padding(.horizontal, ADEKit.inset)
    .padding(.vertical, 11)
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .combine)
    .accessibilityHint("\(tier.runs). \(tier.rateLine).")
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
  let onChanged: () -> Void
  @State private var copied = false

  private var reward: String { cloudHours(referral.rewardMilli) }

  var body: some View {
    ADEKitCard(title: "Invite friends, get free cloud hours", symbol: "gift") {
      VStack(alignment: .leading, spacing: 12) {
        Text("When a friend you invite runs their first chat on ADE Cloud, you both get \(reward) free hours. They never expire, and they're used after your plan's hours.")
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
            ShareLink(item: url, subject: Text("ADE"), message: Text("You both get \(reward) free cloud hours.")) {
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
          stat("Hours earned", cloudHours(referral.hoursEarnedMilli))
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
            CloudInviteCodeBox(syncService: syncService, rewardMilli: referral.rewardMilli, onDone: { _ in onChanged() })
          }
          .padding(.top, 2)
        } else if referral.hasReferrer {
          Text(referral.referredState == "rewarded"
            ? "You were invited, and you both got \(reward) hours."
            : referral.referredState == "refused"
              ? "You were invited, but that invite can't give hours on this account."
              : "You were invited. You both get \(reward) hours when your first chat runs on ADE Cloud.")
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
        ? "You both got \(reward) free cloud hours. They never expire."
        : "Invite added. You both get \(reward) free cloud hours when your first chat runs on ADE Cloud."
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
          hint: store.limits.map(cloudLimitsSummary) ?? "Reading…"
        ) {
          ADESettingsChevron()
        }
      }
      .buttonStyle(ADEKitRowButtonStyle())
    }
  }
}
