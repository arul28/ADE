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
              status: snapshot.providerStatus?[provider],
              spendControlReached: provider == "codex" && snapshot.spendControlReached == true,
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
  let status: MobileUsageProviderStatus?
  let spendControlReached: Bool
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

      if cards.isEmpty {
        Text(status?.state == "ok" ? "Waiting for the next reading." : "No limits reported yet.")
          .font(ADEUsageType.microFont())
          .foregroundStyle(ADEColor.textMuted)
      } else {
        ForEach(cards) { card in
          WorkUsageQuotaWindowRow(card: card, onSelect: onSelect)
        }
      }

      if spendControlReached {
        Text("Spending cap reached")
          .font(ADEUsageType.microFont(.semibold))
          .foregroundStyle(ADEColor.warning)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var accountSubtitle: String? { adeUsageAccountSubtitle(status) }
}

private struct WorkUsageQuotaWindowRow: View {
  let card: ADEUsageLimitCard
  let onSelect: (ADEUsageLimitSegment) -> Void

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

      // One chip per account. A single account needs no chip row — the card
      // number already is that account's number.
      if card.segments.count > 1 {
        HStack(spacing: 6) {
          ForEach(card.segments) { segment in
            Button {
              onSelect(segment)
            } label: {
              HStack(spacing: 3) {
                Text(segment.account?.initials ?? "··")
                  .foregroundStyle(adeUsageAccountAccent(segment.account?.id ?? segment.id))
                Text("\(Int(segment.percentLeft.rounded()))%")
                  .foregroundStyle(ADEColor.textSecondary)
              }
              .font(ADEUsageType.microFont(.semibold).monospacedDigit())
              .padding(.horizontal, 5)
              .padding(.vertical, 2)
              .background(
                adeUsageAccountAccent(segment.account?.id ?? segment.id).opacity(0.14),
                in: RoundedRectangle(cornerRadius: 5, style: .continuous)
              )
              // Only the drawn background stays compact: unlike
              // `.adeTapTarget`, this frame really does take 44pt of layout.
              // That is the point here — these chips sit side by side, so
              // overflowing 44pt shapes would overlap and the nearer chip
              // would swallow its neighbour's taps. The row pays the height.
              .frame(minWidth: 44, minHeight: 44)
              .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(
              "\(card.label), \(segment.account?.email ?? "this machine"), "
              + "\(Int(segment.percentLeft.rounded())) percent left"
            )
            .accessibilityHint("Show account details")
          }
          Spacer(minLength: 0)
        }
      }
    }
    // A single-account card IS the control: the chip row is absent, so the row
    // itself opens the sheet. Multi-account cards stay a plain container whose
    // chips are the controls.
    .modifier(WorkUsageQuotaRowInteraction(
      isSingleSegment: card.segments.count == 1,
      label: singleSegmentAccessibilityLabel,
      action: selectSingleSegment
    ))
  }

  private func selectSingleSegment() {
    guard card.segments.count == 1, let segment = card.segments.first else { return }
    onSelect(segment)
  }

  private var singleSegmentAccessibilityLabel: String {
    var parts = ["\(card.label) limit", "\(Int(card.percentLeft.rounded())) percent left"]
    if let forecast = card.forecast {
      parts.append(
        "plus \(Int(forecast.percent.rounded())) percent in "
        + adeUsageDurationLabel(milliseconds: forecast.resetsInMs)
      )
    }
    return parts.joined(separator: ", ")
  }
}

/// The tap gesture alone left VoiceOver with four unrelated strings and no way
/// to reach the sheet, and a 20pt row is under the 44pt minimum. Both are only
/// true for the single-account shape, so the modifier is a no-op otherwise.
private struct WorkUsageQuotaRowInteraction: ViewModifier {
  let isSingleSegment: Bool
  let label: String
  let action: () -> Void

  func body(content: Content) -> some View {
    if isSingleSegment {
      content
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .onTapGesture(perform: action)
        .accessibilityElement(children: .ignore)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel(label)
        .accessibilityHint("Show account details")
        .accessibilityAction { action() }
    } else {
      content
    }
  }
}

private func mobileUsageStatusLabel(_ status: MobileUsageProviderStatus?) -> String {
  guard let status else { return "WAITING" }
  let source = status.source?.uppercased() ?? "UNKNOWN"
  return status.state == "ok" ? source : "\(status.state.uppercased()) · \(source)"
}
