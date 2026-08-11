import SwiftUI

/// The daily chart and the Live Limits pace bars for the Settings Usage page.
///
/// The chart is a `Canvas`, not a stack of shape views: a 60-bucket, 5-series
/// chart would otherwise be 300 view identities that SwiftUI diffs on every
/// state change (including the pace-bar touch that dims the other series). The
/// geometry itself is precomputed in `ADEUsageChartModel` and only scaled here.

// MARK: - Daily chart

struct SettingsUsageDailyChart: View {
  let model: ADEUsageChartModel
  /// Non-nil while a pace bar is touched: that provider stays lit and the rest
  /// fade back, so the reader can find one provider's days in a busy chart.
  let focusedProvider: String?

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.colorSchemeContrast) private var contrast

  private var increasedContrast: Bool { contrast == .increased }

  private var fillOpacity: Double { increasedContrast ? 0.34 : 0.20 }
  private var dimmedOpacity: Double { increasedContrast ? 0.12 : 0.06 }
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
          let dimmed = focusedProvider != nil && focusedProvider != series.id
          let area = adeUsageSeriesAreaPath(values: series.values, yMax: model.yMax, in: rect)
          context.fill(
            area,
            with: .color(series.color.opacity(dimmed ? dimmedOpacity : fillOpacity))
          )
          let line = adeUsageSeriesPath(values: series.values, yMax: model.yMax, in: rect)
          context.stroke(
            line,
            with: .color(series.color.opacity(dimmed ? 0.25 : 0.95)),
            style: StrokeStyle(lineWidth: lineWidth, lineCap: .round, lineJoin: .round)
          )
        }
      }
      .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: focusedProvider)
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
            .foregroundStyle(
              focusedProvider == nil || focusedProvider == series.id
                ? ADEColor.textSecondary
                : ADEColor.textMuted.opacity(0.5)
            )
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

/// One provider's quota windows read as pace rather than level.
struct SettingsUsagePaceProvider: View {
  let provider: String
  let windows: [MobileUsageQuotaWindow]
  let status: MobileUsageProviderStatus?
  let spendControlReached: Bool
  /// Which provider the chart is currently focused on, so the bar can show it.
  let focusedProvider: String?
  /// Tapping any bar in this card focuses the provider in the chart above; a
  /// second tap (or tapping another provider) releases it.
  let onToggleFocus: (String) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: ADEUsageLayout.rowGap) {
      HStack(spacing: 8) {
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
        Spacer(minLength: 8)
        Text(sourceLabel)
          .font(ADEUsageType.microFont())
          .foregroundStyle(ADEColor.textMuted)
      }

      if spendControlReached {
        Text("Spending cap reached")
          .font(ADEUsageType.detailFont(.medium))
          .foregroundStyle(ADEColor.warning)
      }

      if windows.isEmpty {
        Text(status?.state == "ok" ? "Waiting for the next reading." : "No limits reported yet.")
          .font(ADEUsageType.detailFont())
          .foregroundStyle(ADEColor.textMuted)
      } else {
        ForEach(windows) { window in
          SettingsUsagePaceBar(
            window: window,
            tint: ADEColor.providerBrand(for: provider),
            focusId: provider,
            isFocused: focusedProvider == provider,
            onToggleFocus: onToggleFocus
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
  }

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

struct SettingsUsagePaceBar: View {
  let window: MobileUsageQuotaWindow
  let tint: Color
  let focusId: String
  let isFocused: Bool
  let onToggleFocus: (String) -> Void

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.colorSchemeContrast) private var contrast

  private var percent: Double { window.clampedPercentUsed }
  private var pace: ADEUsageWindowPace? { adeUsageWindowPace(window) }

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(adeUsageWindowLabel(window))
          .font(ADEUsageType.detailFont(.medium))
          .foregroundStyle(ADEColor.textSecondary)
        Spacer(minLength: 8)
        Text("\(Int(percent.rounded()))%")
          .font(ADEUsageType.bodyFont(.semibold))
          .monospacedDigit()
          // Reserved width so a live tick from 9% to 10% cannot shuffle the row.
          .frame(width: 46, alignment: .trailing)
          .foregroundStyle(ADEUsagePressure.color(percent: percent, providerColor: ADEColor.textPrimary))
      }

      GeometryReader { proxy in
        ZStack(alignment: .leading) {
          Capsule()
            .fill(ADEColor.textMuted.opacity(contrast == .increased ? 0.28 : 0.16))
          Capsule()
            .fill(ADEUsagePressure.color(percent: percent, providerColor: tint))
            .frame(width: max(2, proxy.size.width * percent / 100))
          if let pace {
            // Pace marker: where an even burn would have you by now.
            Rectangle()
              .fill(ADEColor.textPrimary.opacity(0.45))
              .frame(width: 1.5)
              .offset(x: proxy.size.width * pace.elapsedFraction - 0.75)
          }
        }
      }
      .frame(height: 8)
      .animation(reduceMotion ? nil : .easeOut(duration: 0.25), value: percent)

      HStack(spacing: 6) {
        if let pace {
          Text(pace.paceLabel)
            .foregroundStyle(pace.isAheadOfPace ? ADEColor.warning : ADEColor.textMuted)
          Text("·")
            .foregroundStyle(ADEColor.textMuted)
          Text(pace.dryLabel)
            .foregroundStyle(pace.dryInMs != nil ? ADEColor.warning : ADEColor.textMuted)
          Text("·")
            .foregroundStyle(ADEColor.textMuted)
        }
        Text("Resets in \(adeUsageDurationLabel(milliseconds: window.resetsInMs))")
          .foregroundStyle(ADEColor.textMuted)
        Spacer(minLength: 0)
      }
      .font(ADEUsageType.microFont())
      .lineLimit(1)
    }
    .padding(.horizontal, isFocused ? 8 : 0)
    .padding(.vertical, isFocused ? 6 : 0)
    .background(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .fill(isFocused ? tint.opacity(0.10) : Color.clear)
    )
    .contentShape(Rectangle())
    // A tap, not a press-and-hold drag: a zero-distance drag gesture inside the
    // page's ScrollView would swallow the scroll before it started.
    .onTapGesture { onToggleFocus(focusId) }
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(.isButton)
    .accessibilityLabel("\(adeUsageWindowLabel(window)) limit, \(Int(percent.rounded())) percent used")
    .accessibilityValue(pace.map { "\($0.paceLabel). \($0.dryLabel)." } ?? "")
    .accessibilityHint(isFocused ? "Show every provider in the chart" : "Pick this provider out of the chart")
  }
}
