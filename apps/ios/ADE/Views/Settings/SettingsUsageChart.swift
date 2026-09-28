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
//
// The provider sections themselves are `ADEUsageLimitsProviderSection`
// (WorkUsageLimitsModule.swift), shared with the new-chat module.

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
          if let resetsValue {
            row("Resets", resetsValue)
          }
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

  private var resetsValue: String? {
    let countdown = adeUsageDurationLabel(milliseconds: segment.resetsInMs)
    guard let date = adeUsageParseISODate(segment.window.resetsAt) else {
      guard segment.resetsInMs > 0 else { return nil }
      return "in \(countdown)"
    }
    let absolute = date.formatted(.dateTime.month(.defaultDigits).day().hour().minute())
    return "\(absolute) · in \(countdown)"
  }

  private var limitsURL: URL? {
    adeUsageLimitsURL(segment.account?.url ?? fallbackAccountUrl)
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

