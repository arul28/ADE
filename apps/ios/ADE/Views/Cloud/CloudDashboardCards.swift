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
          CloudHero(store: store)
          CloudNotices(store: store)
          CloudLanesCard(store: store, pushes: pushes)
          if let account = store.account, account.catalog != nil {
            CloudPlansCard(account: account)
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
}

// MARK: Hero

/// The top block: the plan, the hours, disk and computers. The numbers are
/// said once on the page; nothing below repeats them.
struct CloudHero: View {
  @ObservedObject var store: CloudPaneStore

  var body: some View {
    if let account = store.account {
      VStack(alignment: .leading, spacing: 14) {
        HStack(spacing: 10) {
          ADEBrandTile(brand: .cloud, size: 28)
          VStack(alignment: .leading, spacing: 1) {
            Text(cloudPlanName(account))
              .font(.system(size: 16, weight: .semibold))
              .foregroundStyle(ADEColor.textPrimary)
            Text("ADE Cloud")
              .font(.system(size: 12))
              .foregroundStyle(ADEColor.textMuted)
          }
          Spacer(minLength: 0)
        }
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
            CloudMiniMeter(
              label: "Computers",
              value: "\(computers.total)",
              of: "of \(computers.limit)",
              fraction: computers.limit > 0 ? Double(computers.total) / Double(computers.limit) : 0,
              note: "\(computers.awake) awake now"
            )
          }
        }
      }
      .adeKitCard()
    }
  }

  private func hours(_ account: CloudPhoneAccount) -> some View {
    let hours = account.hours
    let percentLeft = hours.includedMilli > 0 ? Double(hours.leftMilli) / Double(hours.includedMilli) * 100 : 0
    let resets: String? = account.billing.map { billing in
      billing.cancelAtPeriodEnd == true ? "plan ends \(cloudDate(billing.periodEnd))" : "resets \(cloudDate(billing.periodEnd))"
    }
    return VStack(alignment: .leading, spacing: 6) {
      ADEEyebrow("Hours left this month")
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Text(cloudHours(hours.leftMilli))
          .font(.system(size: 30, weight: .medium, design: .monospaced))
          .foregroundStyle(ADEColor.textPrimary)
        Text(["of \(cloudHours(hours.includedMilli)) h", resets].compactMap { $0 }.joined(separator: ", "))
          .font(.system(size: 13))
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(2)
      }
      .accessibilityElement(children: .combine)
      ADEKitMeter(
        fraction: percentLeft / 100,
        color: ADEUsagePressure.color(percentLeft: percentLeft, fallback: ADEColor.accent),
        height: 5
      )
      VStack(alignment: .leading, spacing: 3) {
        ForEach(cloudHoursNotes(account, now: store.now), id: \.self) { line in
          Text(line)
            .font(.system(size: 12.5))
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      .padding(.top, 2)
    }
  }
}

struct CloudMiniMeter: View {
  let label: String
  let value: String
  let of: String?
  let fraction: Double
  let note: String

  var body: some View {
    VStack(alignment: .leading, spacing: 5) {
      ADEEyebrow(label)
      HStack(alignment: .firstTextBaseline, spacing: 4) {
        Text(value)
          .font(.system(size: 17, weight: .medium, design: .monospaced))
          .foregroundStyle(ADEColor.textPrimary)
        if let of {
          Text(of).font(.system(size: 12)).foregroundStyle(ADEColor.textMuted)
        }
      }
      ADEKitMeter(
        fraction: fraction,
        color: ADEUsagePressure.color(percentLeft: (1 - min(1, fraction)) * 100, fallback: ADEKit.fill)
      )
      Text(note)
        .font(.system(size: 11.5))
        .foregroundStyle(ADEColor.textMuted)
        .lineLimit(2)
    }
    .padding(10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(ADEKit.track.opacity(0.6), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
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
    return "\(computers.total) of \(computers.limit) computers · \(computers.awake) awake"
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
          if let mark = cloudMachineMark(machine, now: now) {
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

/// The plans side by side: what each includes, the current one marked. No
/// price, no button and no line on where to change a plan (App Store
/// 3.1.1/3.1.3): the iPhone app states facts only.
struct CloudPlansCard: View {
  let account: CloudPhoneAccount

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
    return out
  }

  private var statusLine: String? {
    guard let billing = account.billing else { return nil }
    if billing.cancelAtPeriodEnd == true { return "Your plan ends \(cloudDate(billing.periodEnd)). You're on Free after that." }
    if let next = billing.nextPlanId, next != account.currentPlanId { return "You move to \(cloudPlanLabel(next)) on \(cloudDate(billing.periodEnd))." }
    if account.plan == "paid" { return "Renews \(cloudDate(billing.periodEnd))." }
    return nil
  }

  var body: some View {
    ADEKitCard(title: "Plans", symbol: "square.stack.3d.up", hint: statusLine) {
      VStack(alignment: .leading, spacing: 12) {
        HStack(alignment: .top, spacing: 8) {
          ForEach(columns) { column in
            planColumn(column)
          }
        }
        Text("An hour is one hour of a Small computer while it's awake; bigger sizes use hours faster. Disk and computers count what you have at one time, across all your computers.")
          .font(.system(size: 12))
          .foregroundStyle(ADEColor.textMuted)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
  }

  private func planColumn(_ column: Column) -> some View {
    let current = column.id == account.currentPlanId
    let next = account.billing?.nextPlanId == column.id && !current
    let shape = RoundedRectangle(cornerRadius: 10, style: .continuous)
    return VStack(alignment: .leading, spacing: 8) {
      VStack(alignment: .leading, spacing: 4) {
        Text(column.label)
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
        if current {
          ADEKitTag(text: "Your plan", tone: .accent)
        } else if next, let end = account.billing?.periodEnd {
          ADEKitTag(text: "From \(cloudDate(end))", tone: .neutral, keepsCase: true)
        } else {
          Color.clear.frame(height: 18)
        }
      }
      fact(Int(Double(column.facts.includedMilli) / 1000).formatted(), "hours a month")
      fact(cloudGb(column.facts.diskGb), "disk in all")
      fact("\(column.facts.computerLimit)", column.facts.computerLimit == 1 ? "computer at a time" : "computers at a time")
      Text(column.id == "free" ? "Work stops until the next month" : "Extra hours, if you turn them on")
        .font(.system(size: 11.5))
        .foregroundStyle(ADEColor.textMuted)
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(10)
    .frame(maxWidth: .infinity, alignment: .topLeading)
    .background(current ? ADEColor.accent.opacity(0.08) : Color.clear, in: shape)
    .overlay(shape.strokeBorder(current ? ADEColor.accent.opacity(0.45) : ADEKit.edge, lineWidth: current ? 1 : 0.75))
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(column.label)\(current ? ", your plan" : ""): \(Int(Double(column.facts.includedMilli) / 1000)) hours a month, \(cloudGb(column.facts.diskGb)) disk, \(column.facts.computerLimit) computers")
  }

  private func fact(_ value: String, _ unit: String) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      Text(value)
        .font(.system(size: 15, weight: .medium, design: .monospaced))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)
        .minimumScaleFactor(0.7)
      Text(unit)
        .font(.system(size: 11))
        .foregroundStyle(ADEColor.textMuted)
        .lineLimit(2)
    }
  }
}

// MARK: Sizes

/// The four sizes (`cloudTierFacts`): CPU, memory, how far the disk can grow,
/// what each runs, how fast it uses hours, and how long the hours left last.
struct CloudSizesCard: View {
  let account: CloudPhoneAccount
  let tiers: [CloudPhoneTier]

  private var leftMilli: Int { account.hours.leftMilli + max(0, account.earnedHours?.leftMilli ?? 0) }

  var body: some View {
    if !tiers.isEmpty {
      ADEKitCard(title: "Sizes", symbol: "cpu", hint: "Each lane picks its size when it starts.", flush: true) {
        VStack(spacing: 0) {
          ForEach(Array(tiers.enumerated()), id: \.element.id) { index, tier in
            if index > 0 { ADESettingsHairline() }
            row(tier)
          }
        }
      }
    }
  }

  private func row(_ tier: CloudPhoneTier) -> some View {
    HStack(alignment: .top, spacing: 12) {
      Image(systemName: tier.symbol)
        .font(.system(size: 13, weight: .medium))
        .foregroundStyle(ADEColor.textSecondary)
        .frame(width: 28, height: 28)
        .background(ADEKit.track, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
      VStack(alignment: .leading, spacing: 3) {
        HStack(spacing: 6) {
          Text(tier.label)
            .font(.system(size: 15, weight: .medium))
            .foregroundStyle(ADEColor.textPrimary)
          if tier.full { ADEKitTag(text: "Full computer") }
          Spacer(minLength: 4)
          Text("\(tier.rate.formatted(.number.precision(.fractionLength(0...1))))×")
            .font(.system(size: 14, weight: .medium, design: .monospaced))
            .foregroundStyle(ADEColor.textPrimary)
        }
        Text(tier.specs.joined(separator: " · "))
          .font(.system(size: 12.5))
          .foregroundStyle(ADEColor.textSecondary)
        Text(tier.runs)
          .font(.system(size: 12.5))
          .foregroundStyle(ADEColor.textSecondary)
        Text("\(tier.rateLine). Your hours last \(tier.hoursLeftLabel(leftMilli)) here.")
          .font(.system(size: 12))
          .foregroundStyle(ADEColor.textMuted)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .padding(.horizontal, ADEKit.inset)
    .padding(.vertical, 11)
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .combine)
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
