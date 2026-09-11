import SwiftUI

/// The daily chart and the Live Limits pace bars for the Settings Usage page.
///
/// The chart is a `Canvas`, not a stack of shape views: a 60-bucket, 5-series
/// chart would otherwise be 300 view identities that SwiftUI diffs on every
/// state change. The geometry itself is precomputed in `ADEUsageChartModel` and
/// only scaled here.

// MARK: - Daily chart

struct SettingsUsageDailyChart: View {
  let model: ADEUsageChartModel

  @Environment(\.colorSchemeContrast) private var contrast

  private var increasedContrast: Bool { contrast == .increased }

  private var fillOpacity: Double { increasedContrast ? 0.34 : 0.20 }
  private var lineWidth: CGFloat { increasedContrast ? 2.2 : 1.6 }

  var body: some View {
    VStack(alignment: .leading, spacing: ADEUsageLayout.rowGap) {
      HStack(alignment: .top, spacing: 10) {
        axisLabels
        chartCanvas
      }
      .frame(height: 156)

      HStack {
        Text(model.startLabel)
        Spacer(minLength: 8)
        Text(model.endLabel)
      }
      .font(ADEUsageType.microFont())
      .foregroundStyle(ADEColor.textMuted)

      legend
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(accessibilityLabel)
  }

  private var accessibilityLabel: String {
    guard model.hasData else { return "Daily usage chart. No usage in this range." }
    let noun = model.metric == .cost ? "cost" : "tokens"
    let parts = model.series.map { series -> String in
      let value = model.metric == .cost
        ? adeUsageCost(series.total)
        : adeUsageCompact(Int(series.total.rounded()))
      return "\(series.label) \(value)"
    }
    return "Daily \(noun) by provider. \(parts.joined(separator: ", "))."
  }

  private var axisLabels: some View {
    VStack(alignment: .trailing, spacing: 0) {
      Text(model.axisTop)
      Spacer(minLength: 0)
      Text(model.axisMid)
      Spacer(minLength: 0)
      Text(model.metric == .cost ? "$0" : "0")
    }
    .font(ADEUsageType.microFont())
    .foregroundStyle(ADEColor.textMuted)
    .monospacedDigit()
    // Reserved width: live refreshes must not shove the plot sideways.
    .frame(width: 44, alignment: .trailing)
  }

  @ViewBuilder
  private var chartCanvas: some View {
    if model.hasData {
      Canvas(opaque: false, rendersAsynchronously: false) { context, size in
        let rect = CGRect(origin: .zero, size: size).insetBy(dx: 0, dy: 2)
        guard rect.height > 0, rect.width > 0 else { return }

        // Baseline + midline. Every series shares this zero baseline — the
        // areas are layered, not stacked, so heights compare directly.
        for fraction in [0.0, 0.5, 1.0] {
          let y = rect.maxY - rect.height * fraction
          var line = Path()
          line.move(to: CGPoint(x: rect.minX, y: y))
          line.addLine(to: CGPoint(x: rect.maxX, y: y))
          context.stroke(
            line,
            with: .color(ADEColor.textMuted.opacity(fraction == 0 ? 0.35 : 0.14)),
            lineWidth: 0.6
          )
        }

        // Draw the largest series first so smaller ones land on top and stay
        // findable; each keeps its own translucent fill.
        for series in model.series {
          let area = adeUsageSeriesAreaPath(values: series.values, yMax: model.yMax, in: rect)
          context.fill(
            area,
            with: .color(series.color.opacity(fillOpacity))
          )
          let line = adeUsageSeriesPath(values: series.values, yMax: model.yMax, in: rect)
          context.stroke(
            line,
            with: .color(series.color.opacity(0.95)),
            style: StrokeStyle(lineWidth: lineWidth, lineCap: .round, lineJoin: .round)
          )
        }
      }
    } else {
      SettingsUsageEmptyPlot()
    }
  }

  /// Provider brand marks stand in for colour dots: the mark is the legend, so
  /// the reader never has to learn a colour key.
  private var legend: some View {
    HStack(spacing: 14) {
      ForEach(model.series) { series in
        HStack(spacing: 5) {
          if let assetName = series.assetName {
            Image(assetName)
              .resizable()
              .scaledToFit()
              .frame(width: 13, height: 13)
              .accessibilityHidden(true)
          } else {
            RoundedRectangle(cornerRadius: 3, style: .continuous)
              .fill(series.color.opacity(0.7))
              .frame(width: 11, height: 11)
              .accessibilityHidden(true)
          }
          Text(series.label)
            .font(ADEUsageType.microFont(.medium))
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(1)
        }
      }
      Spacer(minLength: 0)
    }
  }
}

/// Warm, specific empty plot. Bars are decorative placeholders, never data.
struct SettingsUsageEmptyPlot: View {
  private let fractions: [CGFloat] = [0.30, 0.52, 0.38, 0.66, 0.47, 0.60, 0.41, 0.55, 0.45, 0.63]

  var body: some View {
    VStack(spacing: 12) {
      HStack(alignment: .bottom, spacing: 6) {
        ForEach(Array(fractions.enumerated()), id: \.offset) { _, fraction in
          RoundedRectangle(cornerRadius: 3, style: .continuous)
            .fill(ADEColor.textMuted.opacity(0.12))
            .frame(height: max(6, 84 * fraction))
            .frame(maxWidth: .infinity)
        }
      }
      Text("Nothing here yet — your first Claude or Codex turn shows up within a minute.")
        .font(ADEUsageType.detailFont())
        .foregroundStyle(ADEColor.textSecondary)
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Nothing here yet. Your first Claude or Codex turn shows up within a minute.")
  }
}

// MARK: - Live Limits

/// One provider's limits: who is signed in, where to see the limits on the
/// provider's own site, and one card per quota window.
///
/// Mirrors the desktop band — provider header, then a card per window read as
/// headroom with one row per account — with the phone's trade: accounts stack
/// as rows instead of sharing a proportional segment row, because four segments
/// on a 390pt screen is four unreadable slivers.
struct SettingsUsagePaceProvider: View {
  let provider: String
  let windows: [MobileUsageQuotaWindow]
  let accounts: [ADEUsageAccountView]
  let status: MobileUsageProviderStatus?
  let spendControlReached: Bool

  @Environment(\.openURL) private var openURL
  @State private var detail: ADEUsageLimitSegment?

  private var cards: [ADEUsageLimitCard] {
    adeUsageLimitCards(provider: provider, windows: windows, accounts: accounts)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: ADEUsageLayout.rowGap) {
      header

      if spendControlReached {
        Text("Spending cap reached")
          .font(ADEUsageType.detailFont(.medium))
          .foregroundStyle(ADEColor.warning)
      }

      if cards.isEmpty {
        Text(status?.state == "ok" ? "Waiting for the next reading." : "No limits reported yet.")
          .font(ADEUsageType.detailFont())
          .foregroundStyle(ADEColor.textMuted)
      } else {
        ForEach(cards) { card in
          SettingsUsageLimitCard(
            card: card,
            tint: ADEColor.providerBrand(for: provider),
            onSelect: { detail = $0 }
          )
        }
      }

      if let message = statusMessage {
        Text(message)
          .font(ADEUsageType.microFont())
          .foregroundStyle(ADEColor.warning)
      }
    }
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
    HStack(spacing: 8) {
      if let assetName = providerAssetName(provider) {
        Image(assetName)
          .resizable()
          .scaledToFit()
          .frame(width: 16, height: 16)
          .accessibilityHidden(true)
      }
      VStack(alignment: .leading, spacing: 1) {
        Text(providerLabel(provider))
          .font(ADEUsageType.bodyFont(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        // The account the numbers belong to, and the plan it is on. Absent on
        // older hosts and on providers that keep no local account record — the
        // line hides rather than guessing.
        if let subtitle = accountSubtitle {
          Text(subtitle)
            .font(ADEUsageType.microFont())
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
            .truncationMode(.middle)
        }
      }
      Spacer(minLength: 8)
      Text(sourceLabel)
        .font(ADEUsageType.microFont())
        .foregroundStyle(ADEColor.textMuted)
      if let url = limitsURL {
        Button {
          openURL(url)
        } label: {
          Image(systemName: "arrow.up.right.square")
            .font(ADEUsageType.detailFont(.medium))
            .foregroundStyle(ADEColor.textSecondary)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Open \(providerLabel(provider)) limits in the browser")
      }
    }
  }

  private var accountSubtitle: String? {
    let email = status?.accountEmail?.trimmingCharacters(in: .whitespaces)
    let plan = status?.accountPlan?.trimmingCharacters(in: .whitespaces)
    return [email, plan].compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: " · ")
      .nilIfEmpty
  }

  /// The host supplies the URL (one source shared with desktop), so a provider
  /// whose host predates the field simply shows no link.
  private var limitsURL: URL? { adeUsageLimitsURL(status?.accountUrl) }

  private var sourceLabel: String {
    switch status?.source {
    case "oauth": return "OAuth"
    case "http": return "HTTP"
    case "cli": return "CLI"
    default: return "Waiting"
    }
  }

  private var statusMessage: String? {
    guard let status, status.state != "ok" else { return nil }
    if let message = status.message?.trimmingCharacters(in: .whitespacesAndNewlines), !message.isEmpty {
      return message
    }
    return status.state == "stale" ? "Showing the last known reading." : "This limit is unavailable."
  }
}

/// One window, read as headroom: the pooled number, the next restore, and a row
/// per account underneath.
struct SettingsUsageLimitCard: View {
  let card: ADEUsageLimitCard
  let tint: Color
  let onSelect: (ADEUsageLimitSegment) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      VStack(alignment: .leading, spacing: 2) {
        Text(card.label)
          .font(ADEUsageType.detailFont(.medium))
          .foregroundStyle(ADEColor.textSecondary)
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          Text("\(Int(card.percentLeft.rounded()))%")
            .font(ADEUsageType.titleFont(.semibold))
            .monospacedDigit()
            .foregroundStyle(
              ADEUsagePressure.color(percent: card.percentUsed, providerColor: ADEColor.textPrimary)
            )
          Text("left")
            .font(ADEUsageType.detailFont())
            .foregroundStyle(ADEColor.textMuted)
          Spacer(minLength: 0)
          if let forecast = card.forecast {
            Label(
              "+\(Int(forecast.percent.rounded()))% in \(adeUsageDurationLabel(milliseconds: forecast.resetsInMs))",
              systemImage: "arrow.clockwise"
            )
            .font(ADEUsageType.microFont())
            .monospacedDigit()
            .foregroundStyle(ADEColor.textMuted)
            .labelStyle(.titleAndIcon)
          }
        }
      }

      ForEach(card.segments) { segment in
        SettingsUsageAccountRow(segment: segment, tint: tint, onSelect: onSelect)
      }
    }
  }
}

private struct SettingsUsageAccountRow: View {
  let segment: ADEUsageLimitSegment
  let tint: Color
  let onSelect: (ADEUsageLimitSegment) -> Void

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.colorSchemeContrast) private var contrast

  private var accent: Color { adeUsageAccountAccent(segment.account?.id ?? segment.id) }
  private var left: Double { segment.percentLeft }

  var body: some View {
    Button {
      onSelect(segment)
    } label: {
      VStack(alignment: .leading, spacing: 5) {
        HStack(spacing: 6) {
          Text(segment.account?.initials ?? "··")
            .font(ADEUsageType.microFont(.semibold))
            .foregroundStyle(accent)
            .padding(.horizontal, 4)
            .padding(.vertical, 1)
            .background(accent.opacity(0.16), in: RoundedRectangle(cornerRadius: 4, style: .continuous))
          Text("\(Int(left.rounded()))%")
            .font(ADEUsageType.detailFont(.medium))
            .monospacedDigit()
            .foregroundStyle(ADEColor.textPrimary)
            // Reserved width so a live tick cannot shuffle the row.
            .frame(width: 44, alignment: .leading)
          if let email = segment.account?.email {
            Text(email)
              .font(ADEUsageType.microFont())
              .foregroundStyle(ADEColor.textMuted)
              .lineLimit(1)
              .truncationMode(.middle)
          }
          Spacer(minLength: 4)
          Label(
            adeUsageDurationLabel(milliseconds: segment.resetsInMs),
            systemImage: "arrow.clockwise"
          )
          .font(ADEUsageType.microFont())
          .monospacedDigit()
          .foregroundStyle(ADEColor.textMuted)
          .labelStyle(.titleAndIcon)
        }

        GeometryReader { proxy in
          ZStack(alignment: .leading) {
            Capsule()
              .fill(ADEColor.textMuted.opacity(contrast == .increased ? 0.28 : 0.16))
            Capsule()
              .fill(ADEUsagePressure.color(percent: 100 - left, providerColor: accent))
              .frame(width: max(2, proxy.size.width * left / 100))
          }
        }
        .frame(height: 6)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.25), value: left)
      }
    }
    .buttonStyle(.plain)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(
      "\(adeUsageWindowLabel(segment.window)) limit, \(segment.account?.email ?? "this machine"), "
      + "\(Int(left.rounded())) percent left"
    )
    .accessibilityHint("Show account details")
  }
}

/// The phone's version of the desktop hover popover: plan, machines, headroom,
/// reset, restore — and the way out to the provider's own page.
struct ADEUsageAccountDetailSheet: View {
  let provider: String
  let windowLabel: String
  let segment: ADEUsageLimitSegment
  let fallbackAccountUrl: String?

  @Environment(\.dismiss) private var dismiss
  @Environment(\.openURL) private var openURL

  private var pace: ADEUsageWindowPace? { adeUsageWindowPace(segment.window) }

  var body: some View {
    NavigationStack {
      List {
        Section {
          row("Plan", segment.account?.plan ?? "Unknown")
          row("Via", segment.account?.machines.map(\.label).joined(separator: " · ") ?? "This machine")
          row("Left", "\(Int(segment.percentLeft.rounded()))%")
          row("Resets", resetsValue)
          if segment.restoresPercentOfPool >= 0.5 {
            row("Restores", "+\(Int(segment.restoresPercentOfPool.rounded()))% of pool")
          }
          if let pace {
            row("Pace", "\(pace.paceLabel) · \(pace.dryLabel)")
          }
        }
        if let url = limitsURL {
          Section {
            Button {
              openURL(url)
            } label: {
              Label("Open limits in browser", systemImage: "arrow.up.right.square")
            }
          }
        }
      }
      .navigationTitle("\(providerLabel(provider)) · \(windowLabel)")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }
        }
      }
    }
    .presentationDetents([.medium])
  }

  private var resetsValue: String {
    let countdown = adeUsageDurationLabel(milliseconds: segment.resetsInMs)
    guard let date = ISO8601DateFormatter().date(from: segment.window.resetsAt) else {
      return "in \(countdown)"
    }
    let absolute = date.formatted(.dateTime.month(.defaultDigits).day().hour().minute())
    return "\(absolute) · in \(countdown)"
  }

  private var limitsURL: URL? {
    adeUsageLimitsURL(segment.account?.accountUrl ?? fallbackAccountUrl)
  }

  private func row(_ label: String, _ value: String) -> some View {
    HStack(alignment: .firstTextBaseline) {
      Text(label)
        .font(ADEUsageType.detailFont())
        .foregroundStyle(ADEColor.textMuted)
      Spacer(minLength: 12)
      Text(value)
        .font(ADEUsageType.detailFont(.medium))
        .foregroundStyle(ADEColor.textPrimary)
        .multilineTextAlignment(.trailing)
    }
  }
}

/// Only an https URL the host supplied is ever opened.
func adeUsageLimitsURL(_ raw: String?) -> URL? {
  guard let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
        !trimmed.isEmpty,
        let url = URL(string: trimmed),
        url.scheme?.lowercased() == "https" else { return nil }
  return url
}

private extension String {
  var nilIfEmpty: String? { isEmpty ? nil : self }
}
