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

/// Live limits: one group per provider, one card per window, one row per
/// account — the compact form of the Settings page and the desktop band.
///
/// Compact means fewer words, not fewer facts: each window still says how much
/// headroom is left, when the next reset returns some, and which account it
/// belongs to. Tapping a row opens the same detail sheet the Settings page
/// opens.
struct WorkUsageQuotaCompact: View {
  let snapshot: MobileUsageQuotaSnapshot?

  @State private var detail: WorkUsageQuotaDetail?

  var body: some View {
    ScrollView(.vertical, showsIndicators: false) {
      VStack(alignment: .leading, spacing: 10) {
        if let snapshot {
          let accounts = adeUsagePoolAccounts(snapshot.accounts)
          ForEach(quotaProviders(snapshot), id: \.self) { provider in
            WorkUsageQuotaProviderCard(
              provider: provider,
              cards: adeUsageLimitCards(
                provider: provider,
                windows: snapshot.windows.filter { $0.provider == provider },
                accounts: accounts
              ),
              accountsWithoutWindows: adeUsageAccountsMissingWindows(
                provider: provider,
                windows: snapshot.windows.filter { $0.provider == provider },
                accounts: accounts
              ),
              status: snapshot.providerStatus?[provider],
              spendControlReached: provider == "codex" && snapshot.spendControlReached == true,
              resetCredits: resetCreditAccounts(in: snapshot, provider: provider),
              onSelect: { segment in
                detail = WorkUsageQuotaDetail(
                  provider: provider,
                  segment: segment,
                  accountUrl: snapshot.providerStatus?[provider]?.accountUrl
                )
              }
            )
          }
        } else {
          Text("Connect to a machine to load live limits.")
            .font(ADEUsageType.microFont())
            .foregroundStyle(ADEColor.textMuted)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .sheet(item: $detail) { detail in
      ADEUsageAccountDetailSheet(
        provider: detail.provider,
        windowLabel: adeUsageWindowLabel(detail.segment.window),
        segment: detail.segment,
        fallbackAccountUrl: detail.accountUrl
      )
    }
  }

  /// Claude and Codex always show (they are the two ADE drives); anything else
  /// the host reports is appended rather than dropped.
  private func quotaProviders(_ snapshot: MobileUsageQuotaSnapshot) -> [String] {
    var ordered = ["claude", "codex"]
    for window in snapshot.windows where !ordered.contains(window.provider) {
      ordered.append(window.provider)
    }
    return ordered
  }
}

private struct WorkUsageQuotaDetail: Identifiable {
  var id: String { "\(provider):\(segment.id)" }
  let provider: String
  let segment: ADEUsageLimitSegment
  let accountUrl: String?
}

private struct WorkUsageQuotaProviderCard: View {
  let provider: String
  let cards: [ADEUsageLimitCard]
  /// Signed-in accounts that have not reported a window yet.
  let accountsWithoutWindows: [ADEUsageAccountView]
  let status: MobileUsageProviderStatus?
  let spendControlReached: Bool
  /// Accounts on this provider with a credit banked. Empty renders nothing.
  let resetCredits: [MobileUsageAccount]
  let onSelect: (ADEUsageLimitSegment) -> Void

  @Environment(\.openURL) private var openURL

  var body: some View {
    VStack(alignment: .leading, spacing: 5) {
      HStack(spacing: 6) {
        if let assetName = providerAssetName(provider) {
          Image(assetName)
            .resizable()
            .scaledToFit()
            .frame(width: 14, height: 14)
            .accessibilityHidden(true)
        }
        Text(providerLabel(provider))
          .font(ADEUsageType.detailFont(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        if let subtitle = accountSubtitle {
          Text(subtitle)
            .font(ADEUsageType.microFont())
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
            .truncationMode(.middle)
        }
        Spacer(minLength: 4)
        Text(mobileUsageStatusLabel(status))
          .font(ADEUsageType.microFont())
          .foregroundStyle(ADEColor.textMuted)
        if let url = adeUsageLimitsURL(status?.accountUrl) {
          Button {
            openURL(url)
          } label: {
            Image(systemName: "arrow.up.right.square")
              .font(ADEUsageType.microFont(.semibold))
              .foregroundStyle(ADEColor.textSecondary)
              // An 11pt glyph is not a target. The hit area reaches 44pt while
              // the provider header keeps its 14pt rhythm.
              .adeTapTarget(visual: 16)
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Open \(providerLabel(provider)) limits in the browser")
        }
      }

      if cards.isEmpty && accountsWithoutWindows.isEmpty {
        Text(status?.state == "ok" ? "Waiting for the next reading." : "No limits reported yet.")
          .font(ADEUsageType.microFont())
          .foregroundStyle(ADEColor.textMuted)
      } else {
        ForEach(cards) { card in
          WorkUsageQuotaWindowRow(card: card, onSelect: onSelect)
        }
        ForEach(accountsWithoutWindows) { account in
          Text("\(adeUsageAccountTitle(account)) · No usage yet")
            .font(ADEUsageType.microFont())
            .foregroundStyle(ADEColor.textMuted)
        }
      }

      if spendControlReached {
        Text("Spending cap reached")
          .font(ADEUsageType.microFont(.semibold))
          .foregroundStyle(ADEColor.warning)
      }

      ADEResetCreditRows(accounts: resetCredits)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var accountSubtitle: String? { adeUsageAccountSubtitle(status) }
}

private struct WorkUsageQuotaWindowRow: View {
  let card: ADEUsageLimitCard
  let onSelect: (ADEUsageLimitSegment) -> Void

  /// The provider's brand, not a hash of the account id — a Claude account was
  /// being drawn in Gemini's blue.
  private var accent: Color { adeUsageProviderColor(card.provider) }

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      HStack(spacing: 6) {
        Text(card.label)
          // Reserved width: these tick while the module is on screen, and
          // without a fixed advance every poll shuffles the row sideways.
          .frame(width: 58, alignment: .leading)
          .foregroundStyle(ADEColor.textSecondary)
        Text("\(Int(card.percentLeft.rounded()))% left")
          .foregroundStyle(
            ADEUsagePressure.color(percent: card.percentUsed, providerColor: ADEColor.textPrimary)
          )
          .frame(width: 64, alignment: .leading)
        if let forecast = card.forecast {
          Text("+\(Int(forecast.percent.rounded()))% in \(adeUsageDurationLabel(milliseconds: forecast.resetsInMs))")
            .foregroundStyle(ADEColor.textMuted)
        }
        Spacer(minLength: 0)
      }
      .font(ADEUsageType.microFont().monospacedDigit())
      .lineLimit(1)

      // One row per account, ALWAYS — including the single-account case, which
      // is exactly the case that used to hide the email. A machine shared
      // between two logins gave no other clue whose quota was on screen.
      //
      // Full-width rows rather than side-by-side chips: the email is the point,
      // and it does not fit beside a neighbour. Each row is its own 44pt
      // control, so nothing overlaps and the sheet is one tap away.
      ForEach(card.segments) { segment in
        Button {
          onSelect(segment)
        } label: {
          HStack(spacing: 6) {
            Text(segment.account?.initials ?? "··")
              .foregroundStyle(accent)
              .padding(.horizontal, 5)
              .padding(.vertical, 2)
              .background(
                accent.opacity(0.14),
                in: RoundedRectangle(cornerRadius: 5, style: .continuous)
              )
            Text("\(Int(segment.percentLeft.rounded()))%")
              .foregroundStyle(ADEColor.textSecondary)
              // Reserved width so a live tick cannot shuffle the row.
              .frame(width: 40, alignment: .leading)
            Text(segment.account?.email ?? "This machine")
              .foregroundStyle(ADEColor.textMuted)
              .lineLimit(1)
              .truncationMode(.middle)
            Spacer(minLength: 0)
          }
          .font(ADEUsageType.microFont(.semibold).monospacedDigit())
          .frame(minHeight: 44)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(
          "\(card.label), \(segment.account?.email ?? "this machine"), "
          + "\(Int(segment.percentLeft.rounded())) percent left"
        )
        .accessibilityHint("Show account details")
      }
    }
  }
}

private func mobileUsageStatusLabel(_ status: MobileUsageProviderStatus?) -> String {
  guard let status else { return "WAITING" }
  let source = status.source?.uppercased() ?? "UNKNOWN"
  return status.state == "ok" ? source : "\(status.state.uppercased()) · \(source)"
}
