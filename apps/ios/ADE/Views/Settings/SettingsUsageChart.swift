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

  private var fillOpacity: Double { increasedContrast ? 0.24 : 0.10 }
  private var lineWidth: CGFloat { increasedContrast ? 2.0 : 1.4 }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .top, spacing: 8) {
        axisLabels
        chartCanvas
      }
      .frame(height: 120)

      HStack {
        Text(model.startLabel)
        Spacer(minLength: 8)
        Text(model.endLabel)
      }
      .font(.adeMono(10))
      .foregroundStyle(ADEColor.textMuted)
      .padding(.leading, 48)

      if model.hasData {
        legend
      }
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
    .font(.adeMono(10))
    .foregroundStyle(ADEColor.textMuted)
    // Reserved width: live refreshes must not shove the plot sideways.
    .frame(width: 40, alignment: .trailing)
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
            with: .color(ADEColor.textPrimary.opacity(fraction == 0 ? 0.16 : 0.06)),
            lineWidth: 0.75
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

  /// One legend item per series: brand mark (or swatch), full name, total.
  private var legend: some View {
    let columns = [GridItem(.adaptive(minimum: 140), spacing: 10, alignment: .leading)]
    return LazyVGrid(columns: columns, alignment: .leading, spacing: 6) {
      ForEach(model.series) { series in
        ADEKitLegendItem(
          color: series.color,
          label: series.label,
          value: model.metric == .cost ? adeUsageCost(series.total) : adeUsageCompact(Int(series.total.rounded())),
          assetName: series.assetName
        )
      }
    }
  }
}

/// The empty plot: a flat baseline and one line of copy. No fake bars.
struct SettingsUsageEmptyPlot: View {
  var body: some View {
    VStack(spacing: 8) {
      Spacer(minLength: 0)
      Text("No usage in this range yet.")
        .font(.system(size: 13))
        .foregroundStyle(ADEColor.textMuted)
      Spacer(minLength: 0)
      Rectangle().fill(ADEKit.rule).frame(height: 0.75)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("No usage in this range yet.")
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

