import Foundation
import SwiftUI

// The Limits tab of the Work usage module.
//
// Split out of `WorkUsageActivityCarousel.swift`, which had grown past 1000
// lines carrying two unrelated responsibilities: the activity charts and this.
// The carousel keeps the tab switch; everything that renders a live quota
// window lives here.
//
// Type, colour, and the arithmetic all come from `ADEUsageDesign.swift` — the
// same vocabulary the Settings Usage page and the desktop band use — so the
// compact module and the full page read as one surface.

/// Keep reset outcomes attached to the account that produced them. A provider
/// can expose more than one banked credit, so a single view-wide outcome would
/// incorrectly replace every account's button after one spend.
func workUsageResetOutcome(accountId: String, outcomes: [String: String]) -> String? {
  outcomes[accountId]
}

/// What spending a reset credit did, in the user's words.
///
/// Mirrors `resetCreditOutcomeText` in
/// `apps/desktop/src/shared/usageResetCredit.ts`, and is shared between the two
/// phone surfaces that spend a credit — the Limits module's account row and the
/// chat's "a reset credit is banked" notice — because a person who taps one
/// after the other must not be told two different things about the same answer.
///
/// The host names the outcome; the phone only phrases it. An unrecognized
/// status falls through to the host's own sentence and then to a plain failure:
/// a reset that did not happen is never reported as one.
func workResetCreditOutcomeText(_ result: UsageConsumeResetCreditResponse) -> String {
  let resetApplied = "Reset applied. Your windows have cleared."
  let genericFailure = "Could not use the reset credit."
  // `failure` is the host's catch-all bucket, so it is deliberately absent from
  // this switch: the four real outcomes always phrase themselves, while a
  // failure falls through to the host's own sentence and then to the generic
  // line. Same order as the TypeScript.
  switch result.status {
  case "reset": return resetApplied
  case "nothingToReset": return "Nothing to reset right now."
  case "noCredit": return "No reset credit left."
  case "alreadyRedeemed": return "That credit was already redeemed."
  default: break
  }
  if result.ok != true,
     let message = result.message?.trimmingCharacters(in: .whitespacesAndNewlines),
     !message.isEmpty {
    return message
  }
  // Only a host that really spent the credit sets `ok`; `{ok: true, status:
  // "failure"}` is contradictory, and the safe reading is the failure.
  if result.ok == true, result.status != "failure" { return resetApplied }
  return genericFailure
}

/// Live limits on the new-chat page: one section per provider, one row per
/// account, one meter per window — the desktop limits popover
/// (`UsageLimitsBand` + `UsageAccountRow`), ported rather than paraphrased.
///
/// Tapping a meter opens the same detail sheet the Settings page opens.
struct WorkUsageQuotaCompact: View {
  let snapshot: MobileUsageQuotaSnapshot?

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      if let snapshot {
        let accounts = adeUsagePoolAccounts(snapshot.accounts)
        ForEach(adeUsageQuotaProviders(snapshot), id: \.self) { provider in
          ADEUsageLimitsProviderSection(
            provider: provider,
            windows: snapshot.windows.filter { $0.provider == provider },
            accounts: accounts,
            status: snapshot.providerStatus?[provider],
            spendControlReached: provider == "codex" && snapshot.spendControlReached == true,
            resetCredits: resetCreditAccounts(in: snapshot, provider: provider),
            density: .compact
          )
        }
      } else {
        Text("Connect to a machine to load live limits.")
          .font(ADEUsageType.detailFont())
          .foregroundStyle(ADEColor.textMuted)
          .frame(maxWidth: .infinity, minHeight: 60)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

/// Claude and Codex always show (they are the two ADE drives); anything else
/// the host reports is appended rather than dropped.
func adeUsageQuotaProviders(_ snapshot: MobileUsageQuotaSnapshot) -> [String] {
  var ordered = ["claude", "codex"]
  for window in snapshot.windows where !ordered.contains(window.provider) {
    ordered.append(window.provider)
  }
  return ordered
}

// MARK: - Account rows

/// One account's windows, short window first. Mirrors desktop
/// `buildAccountRows`: the account is the row, its windows stack under it.
struct ADEUsageAccountLimitRow: Identifiable, Equatable {
  var id: String
  var account: ADEUsageAccountView?
  var segments: [ADEUsageLimitSegment]
}

/// Regroups the per-window cards into per-account rows. Order follows the
/// first appearance of each account in the (already short-first) cards, so the
/// grouping never reshuffles between polls.
func adeUsageAccountLimitRows(cards: [ADEUsageLimitCard]) -> [ADEUsageAccountLimitRow] {
  var order: [String] = []
  var rows: [String: ADEUsageAccountLimitRow] = [:]
  for card in cards {
    for segment in card.segments {
      let key = segment.account?.id ?? "\(card.provider):this-machine"
      if rows[key] == nil {
        order.append(key)
        rows[key] = ADEUsageAccountLimitRow(id: key, account: segment.account, segments: [])
      }
      rows[key]?.segments.append(segment)
    }
  }
  return order.compactMap { rows[$0] }
}

/// "5h" / "Weekly" — the meter's own name. Desktop `shortWindowLabel`, except
/// that a phone meter spans the full width, so "Weekly" is spelled out.
func adeUsageShortWindowLabel(_ window: MobileUsageQuotaWindow) -> String {
  switch window.windowType {
  case "five_hour":
    let minutes = window.windowDurationMs.map { Int(($0 / 60_000).rounded()) } ?? 300
    if minutes > 0 && minutes < 60 { return "\(minutes)m" }
    let hours = minutes > 0 ? Double(minutes) / 60 : 5
    return hours.rounded() == hours ? "\(Int(hours))h" : String(format: "%.1fh", hours)
  default:
    return adeUsageWindowLabel(window)
  }
}

/// Desktop `formatCountdown`: "3d 4h" / "1h 49m" / "12m" / "now".
func adeUsageCountdown(milliseconds: Double) -> String {
  guard milliseconds > 0 else { return "now" }
  let seconds = Int(milliseconds / 1_000)
  let days = seconds / 86_400
  let hours = (seconds % 86_400) / 3_600
  let minutes = (seconds % 3_600) / 60
  if days > 0 { return "\(days)d \(hours)h" }
  if hours > 0 { return "\(hours)h \(minutes)m" }
  return "\(max(1, minutes))m"
}

/// The pacing pill, read off the window with the LEAST headroom — the one that
/// decides when this login stops working (desktop `paceVisual`).
struct ADEUsagePaceTone: Equatable {
  enum Tone { case calm, warm, hot, cool }
  var label: String
  var tone: Tone

  var color: Color {
    switch tone {
    case .calm: return ADEColor.success
    case .warm: return ADEColor.warning
    case .hot: return ADEColor.danger
    case .cool: return ADEColor.textMuted
    }
  }

  static func tightest(_ segments: [ADEUsageLimitSegment], now: Date = Date()) -> ADEUsagePaceTone? {
    guard let tightest = segments.min(by: { $0.percentLeft < $1.percentLeft }),
          let pace = adeUsageWindowPace(tightest.window, now: now),
          pace.elapsedFraction > 0 else { return nil }
    let delta = pace.paceDelta
    let magnitude = Int(abs(delta).rounded())
    if magnitude < 5 { return ADEUsagePaceTone(label: "on pace", tone: .calm) }
    if delta > 0 {
      return ADEUsagePaceTone(label: "\(magnitude)% ahead ▴", tone: delta >= 25 ? .hot : .warm)
    }
    return ADEUsagePaceTone(label: "\(magnitude)% under ▾", tone: .cool)
  }
}

// MARK: - Provider section

/// One provider's live limits, shared by the new-chat module and the Settings
/// Usage page: logo + name + source + link, a hairline, then each account's
/// email with its windows stacked as headroom meters.
struct ADEUsageLimitsProviderSection: View {
  enum Density { case compact, regular }

  let provider: String
  let windows: [MobileUsageQuotaWindow]
  let accounts: [ADEUsageAccountView]
  let status: MobileUsageProviderStatus?
  let spendControlReached: Bool
  var resetCredits: [MobileUsageAccount] = []
  var density: Density = .compact

  @Environment(\.openURL) private var openURL
  @State private var detail: ADEUsageLimitSegment?

  private var cards: [ADEUsageLimitCard] {
    adeUsageLimitCards(provider: provider, windows: windows, accounts: accounts)
  }

  private var accountsWithoutWindows: [ADEUsageAccountView] {
    adeUsageAccountsMissingWindows(provider: provider, windows: windows, accounts: accounts)
  }

  var body: some View {
    let rows = adeUsageAccountLimitRows(cards: cards)
    VStack(alignment: .leading, spacing: density == .compact ? 8 : 10) {
      header
      Rectangle()
        .fill(ADEColor.textPrimary.opacity(0.08))
        .frame(height: 0.5)

      if spendControlReached {
        notice("Spending cap reached", color: ADEColor.warning)
      }
      if let message = statusMessage {
        notice(message, color: ADEColor.warning)
      }

      if rows.isEmpty && accountsWithoutWindows.isEmpty {
        Text(status?.state == "ok" ? "Waiting for the next reading." : "No limits reported yet.")
          .font(ADEUsageType.detailFont())
          .foregroundStyle(ADEColor.textMuted)
      } else {
        VStack(alignment: .leading, spacing: density == .compact ? 12 : 14) {
          ForEach(rows) { row in
            ADEUsageAccountLimitRowView(
              provider: provider,
              row: row,
              fallbackEmail: rows.count == 1 ? status?.accountEmail : nil,
              density: density,
              onSelect: { detail = $0 }
            )
          }
          ForEach(accountsWithoutWindows) { account in
            VStack(alignment: .leading, spacing: 3) {
              Text(adeUsageAccountTitle(account))
                .font(ADEUsageType.detailFont(.medium))
                .foregroundStyle(ADEColor.textPrimary)
              Text("No usage yet")
                .font(ADEUsageType.microFont())
                .foregroundStyle(ADEColor.textMuted)
            }
          }
        }
      }

      ADEResetCreditRows(accounts: resetCredits)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .contain)
    .sheet(item: $detail) { segment in
      ADEUsageAccountDetailSheet(
        provider: provider,
        windowLabel: adeUsageWindowLabel(segment.window),
        segment: segment,
        fallbackAccountUrl: status?.accountUrl
      )
    }
  }

  private var header: some View {
    HStack(spacing: 7) {
      if let assetName = providerAssetName(provider) {
        Image(assetName)
          .resizable()
          .scaledToFit()
          .frame(width: 16, height: 16)
          .accessibilityHidden(true)
      }
      Text(providerLabel(provider))
        .font(ADEUsageType.bodyFont(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
      Spacer(minLength: 6)
      Text(sourceLine)
        .font(ADEUsageType.microFont())
        .foregroundStyle(ADEColor.textMuted)
        .lineLimit(1)
      if let url = adeUsageLimitsURL(status?.accountUrl) {
        Button {
          openURL(url)
        } label: {
          Image(systemName: "arrow.up.right")
            .font(.system(size: 10, weight: .bold))
            .foregroundStyle(ADEColor.textSecondary)
            .frame(width: 22, height: 22)
            .background(ADEColor.textPrimary.opacity(0.06), in: Circle())
            .adeTapTarget(visual: 22)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Open \(providerLabel(provider)) limits in the browser")
      }
    }
  }

  private func notice(_ message: String, color: Color) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 6) {
      Circle().fill(color).frame(width: 5, height: 5)
      Text(message)
        .font(ADEUsageType.microFont())
        .foregroundStyle(ADEColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  /// "OAuth · 2m ago" — where the reading came from, and how old it is.
  private var sourceLine: String {
    let source: String
    switch status?.source {
    case "oauth": source = "OAuth"
    case "http": source = "HTTP"
    case "cli": source = "CLI"
    default: return status == nil ? "Waiting" : status?.state.capitalized ?? "Waiting"
    }
    guard let stamp = status?.lastSuccessAt ?? status?.updatedAt else { return source }
    return "\(source) · \(adeUsageRelativeTime(stamp))"
  }

  private var statusMessage: String? {
    guard let status, status.state != "ok" else { return nil }
    if let message = status.message?.trimmingCharacters(in: .whitespacesAndNewlines), !message.isEmpty {
      return message
    }
    return status.state == "stale" ? "Showing the last known reading." : "This limit is unavailable."
  }
}

/// One account: its email, then its windows as stacked full-width meters.
private struct ADEUsageAccountLimitRowView: View {
  let provider: String
  let row: ADEUsageAccountLimitRow
  let fallbackEmail: String?
  let density: ADEUsageLimitsProviderSection.Density
  let onSelect: (ADEUsageLimitSegment) -> Void

  private var identity: String {
    let email = row.account?.email ?? fallbackEmail
    if let email, !email.isEmpty { return email }
    if let label = row.account?.label, !label.isEmpty { return label }
    return "This machine"
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 5) {
      HStack(spacing: 6) {
        Text(identity)
          .font(ADEUsageType.detailFont(.medium))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
          .truncationMode(.middle)
        if let plan = row.account?.plan, !plan.isEmpty {
          Text(plan)
            .font(ADEUsageType.microFont())
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
        }
        Spacer(minLength: 4)
        if let pace = ADEUsagePaceTone.tightest(row.segments) {
          Text(pace.label)
            .font(ADEUsageType.microFont(.medium))
            .foregroundStyle(pace.color)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(pace.color.opacity(0.14), in: Capsule(style: .continuous))
            .fixedSize()
        }
      }
      ForEach(row.segments) { segment in
        ADEUsageWindowMeter(
          provider: provider,
          segment: segment,
          identity: identity,
          height: density == .compact ? 26 : 30,
          onSelect: onSelect
        )
      }
    }
  }
}

/// A window read as headroom: the tinted fill IS the percent left, so a row
/// reading "85% left" is 85% full (desktop `WindowMeter`). The fill takes the
/// provider's brand colour and goes warm/hot as the window runs dry.
private struct ADEUsageWindowMeter: View {
  let provider: String
  let segment: ADEUsageLimitSegment
  let identity: String
  let height: CGFloat
  let onSelect: (ADEUsageLimitSegment) -> Void

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.colorSchemeContrast) private var contrast

  private var left: Double { segment.percentLeft }
  private var tone: Color {
    ADEUsagePressure.color(percent: 100 - left, providerColor: adeUsageProviderColor(provider))
  }
  private var hasReset: Bool {
    adeUsageParseISODate(segment.window.resetsAt) != nil || segment.resetsInMs > 0
  }

  var body: some View {
    Button {
      onSelect(segment)
    } label: {
      HStack(spacing: 5) {
        Text(adeUsageShortWindowLabel(segment.window))
          .font(ADEUsageType.microFont(.medium))
          .foregroundStyle(ADEColor.textPrimary.opacity(0.78))
        Text("\(Int(left.rounded()))%")
          .font(ADEUsageType.microFont(.semibold).monospacedDigit())
          .foregroundStyle(tone)
        Text("left")
          .font(ADEUsageType.microFont())
          .foregroundStyle(ADEColor.textMuted)
        Spacer(minLength: 4)
        if hasReset {
          HStack(spacing: 3) {
            Image(systemName: "arrow.clockwise")
              .font(.system(size: 9, weight: .semibold))
            Text(adeUsageCountdown(milliseconds: segment.resetsInMs))
              .font(ADEUsageType.microFont().monospacedDigit())
          }
          .foregroundStyle(ADEColor.textMuted)
        }
      }
      .padding(.horizontal, 9)
      .frame(height: height)
      .frame(maxWidth: .infinity)
      .background(alignment: .leading) {
        GeometryReader { proxy in
          ZStack(alignment: .leading) {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
              .fill(ADEColor.textPrimary.opacity(contrast == .increased ? 0.12 : 0.05))
            RoundedRectangle(cornerRadius: 8, style: .continuous)
              .fill(tone.opacity(contrast == .increased ? 0.42 : 0.22))
              .frame(width: max(0, proxy.size.width * min(100, left) / 100))
          }
        }
      }
      .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
      .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
      .animation(reduceMotion ? nil : .smooth(duration: 0.4), value: left)
    }
    .buttonStyle(.plain)
    .frame(minHeight: max(height, 30))
    .accessibilityLabel(
      "\(adeUsageWindowLabel(segment.window)), \(identity), \(Int(left.rounded())) percent left"
        + (hasReset ? ", resets in \(adeUsageDurationLabel(milliseconds: segment.resetsInMs))" : "")
    )
    .accessibilityHint("Show account details")
  }
}
