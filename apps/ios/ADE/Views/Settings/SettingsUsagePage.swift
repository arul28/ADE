import SwiftUI

/// The single Usage page — one scroll, no tab split between "limits" and
/// "activity". Mirrors the desktop composition exactly:
///
///   cost hero + per-provider cost split → daily chart → Live Limits →
///   metric strip → breakdown
///
/// Everything numeric is precomputed into `SettingsUsagePageModel` when the
/// payload changes, never in `body`.

// MARK: - Page model

struct SettingsUsageProviderRow: Identifiable, Equatable {
  var id: String
  var label: String
  var assetName: String?
  var color: Color
  var costUsd: Double
  var totalTokens: Int
  var cachedTokens: Int
  var outputTokens: Int
  var estimation: ADEUsageEstimationKind
  /// 0...1 share of the range cost (or of tokens when nothing has a cost).
  var share: Double
}

struct SettingsUsagePageModel: Equatable {
  var totalCostUsd: Double = 0
  var providers: [SettingsUsageProviderRow] = []
  var chart = ADEUsageChartModel()
  var totalTokens = 0
  var cachedTokens = 0
  var uncachedTokens = 0
  var outputTokens = 0
  /// Share of all tokens that were served from cache, as a percentage.
  var cacheSharePercent: Double = 0
  var anyEstimated = false
  var hasAnything = false
  /// Which rate card produced the cost above it, or nil when the host does not
  /// report one.
  var ratesNote: String?

  static func build(from stats: MobileAdeUsageStats?) -> SettingsUsagePageModel {
    var model = SettingsUsagePageModel()
    guard let stats else { return model }

    let providerSummaries = stats.providers ?? []
    var totalCost = 0.0
    var rows: [SettingsUsageProviderRow] = []
    rows.reserveCapacity(providerSummaries.count)
    for summary in providerSummaries {
      let cost = max(0, summary.rangeCostUsd ?? 0)
      let tokens = summary.totalTokens
        ?? ((summary.inputTokens ?? 0) + (summary.outputTokens ?? 0) + (summary.cachedTokens ?? 0))
      guard cost > 0 || tokens > 0 else { continue }
      totalCost += cost
      rows.append(
        SettingsUsageProviderRow(
          id: summary.provider,
          label: providerLabel(summary.provider),
          assetName: providerAssetName(summary.provider),
          color: ADEColor.providerBrand(for: summary.provider),
          costUsd: cost,
          totalTokens: tokens,
          cachedTokens: summary.cachedTokens ?? 0,
          outputTokens: summary.outputTokens ?? 0,
          estimation: ADEUsageEstimationKind(raw: summary.estimation),
          share: 0
        )
      )
    }

    // Share is by cost when any cost is known, otherwise by tokens — so the
    // split bar is never a row of zero-width slivers on a subscription-only
    // machine.
    let shareBasisTotal = totalCost > 0
      ? totalCost
      : Double(rows.reduce(0) { $0 + $1.totalTokens })
    if shareBasisTotal > 0 {
      for index in rows.indices {
        let value = totalCost > 0 ? rows[index].costUsd : Double(rows[index].totalTokens)
        rows[index].share = value / shareBasisTotal
      }
    }
    rows.sort { lhs, rhs in
      lhs.share == rhs.share ? lhs.label < rhs.label : lhs.share > rhs.share
    }

    let dailyTotalTokens = stats.daily.reduce(0) { $0 + ($1.totalTokens ?? 0) }
    let totalTokens = stats.summary.totalTokens ?? dailyTotalTokens
    let cached = rows.reduce(0) { $0 + $1.cachedTokens }
      .nonZeroOr(stats.daily.reduce(0) { $0 + ($1.cachedTokens ?? 0) })
    let output = rows.reduce(0) { $0 + $1.outputTokens }
      .nonZeroOr(stats.daily.reduce(0) { $0 + ($1.outputTokens ?? 0) })

    model.totalCostUsd = totalCost
    model.providers = rows
    model.totalTokens = totalTokens
    model.cachedTokens = min(cached, totalTokens)
    model.uncachedTokens = max(0, totalTokens - min(cached, totalTokens))
    model.outputTokens = output
    model.cacheSharePercent = totalTokens > 0 ? Double(min(cached, totalTokens)) / Double(totalTokens) * 100 : 0
    model.anyEstimated = rows.contains { $0.estimation.isEstimated }
    model.ratesNote = adeUsageRatesNote(
      sources: providerSummaries.compactMap(\.pricingSource),
      pricingUpdatedAt: stats.pricingUpdatedAt
    )
    model.chart = ADEUsageChartModel.build(
      points: stats.daily,
      metric: totalCost > 0 ? .cost : .tokens
    )
    model.hasAnything = totalTokens > 0 || totalCost > 0 || model.chart.hasData
    return model
  }
}

/// Which rate card produced the cost figure.
///
/// The cost is this page's headline and the rates behind it are not the user's
/// to guess: a machine pricing from the maintained public list and one pricing
/// from ADE's built-in table can report different numbers for identical usage,
/// and only this line says which one is on screen. Nil when no provider reports
/// a source (older hosts), so nothing is claimed that was not measured.
func adeUsageRatesNote(sources: [String], pricingUpdatedAt: String?) -> String? {
  let known = Set(sources.filter { !$0.isEmpty })
  guard !known.isEmpty else { return nil }
  let age = adeUsageParseISODate(pricingUpdatedAt) == nil
    ? nil
    : adeUsageRelativeTime(pricingUpdatedAt)
  let fromList = age.map { "the public rate list, updated \($0)" } ?? "the public rate list"
  if known.contains("mixed") || known.count > 1 {
    return "Rates from \(fromList), except a few models only ADE's built-in list knows."
  }
  if known.contains("list") { return "Rates from \(fromList)." }
  return "Rates from ADE's built-in list — the public rate list couldn't be reached."
}

private extension Int {
  /// `self` unless it is zero, in which case the fallback. Lets a summary-first
  /// figure degrade to the daily-series sum on hosts that omit it.
  func nonZeroOr(_ fallback: Int) -> Int { self == 0 ? fallback : self }
}

// MARK: - Page

struct SettingsUsagePage: View {
  let syncService: SyncService

  @ObservedObject private var store = MobileUsageQuotaStore.shared
  @AppStorage("ade.settings.usageRange.v1") private var rangeRaw = "30d"
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  @State private var model = SettingsUsagePageModel()
  @State private var focusedProvider: String?
  @State private var estimationSheetPresented = false

  init(syncService: SyncService) {
    self.syncService = syncService
  }

  private static let ranges: [(id: String, title: String)] = [
    ("today", "Today"), ("7d", "7d"), ("30d", "30d"), ("year", "Year"), ("all", "All"),
  ]

  /// Recomputing the page model is keyed on the payload identity, not on every
  /// published change, so a quota tick does not re-fold the daily series.
  private var modelKey: String {
    "\(store.statsRange ?? "-"):\(store.stats?.generatedAt ?? "-")"
  }

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: ADEUsageLayout.sectionGap) {
        rangeControl
        costBand
        chartBand
        limitsBand
        metricStrip
        breakdownBand
        if let error = store.statsErrorMessage ?? store.errorMessage {
          Text(error)
            .font(ADEUsageType.detailFont())
            .foregroundStyle(ADEColor.warning)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 20)
    }
    .background(SettingsUsageBackdrop().ignoresSafeArea())
    .adeNavigationGlass()
    .navigationTitle("Usage")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Button {
          Task { await refresh() }
        } label: {
          if store.refreshing || store.statsLoading {
            ProgressView().controlSize(.small)
          } else {
            Image(systemName: "arrow.clockwise")
          }
        }
        .disabled(store.refreshing || store.statsLoading)
        .accessibilityLabel("Refresh usage")
      }
    }
    .task(id: "\(rangeRaw):\(syncService.connectionState.rawValue)") {
      await store.loadStats(range: rangeRaw, using: syncService)
    }
    .task(id: syncService.connectionState.rawValue) {
      await store.load(using: syncService)
    }
    .task(id: modelKey) {
      let next = SettingsUsagePageModel.build(from: store.stats)
      withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { model = next }
    }
    .refreshable { await refresh() }
    .sheet(isPresented: $estimationSheetPresented) {
      SettingsUsageEstimationSheet(providers: model.providers, ratesNote: model.ratesNote)
        .presentationDetents([.medium, .large])
    }
  }

  private func refresh() async {
    await store.load(using: syncService, refresh: true)
    await store.loadStats(range: rangeRaw, using: syncService, force: true)
  }

  // MARK: Range

  private var rangeControl: some View {
    Picker("Range", selection: $rangeRaw) {
      ForEach(Self.ranges, id: \.id) { range in
        Text(range.title).tag(range.id)
      }
    }
    .pickerStyle(.segmented)
    .accessibilityLabel("Usage range")
  }

  // MARK: Cost hero

  private var costBand: some View {
    VStack(alignment: .leading, spacing: ADEUsageLayout.rowGap) {
      Text("ESTIMATED COST")
        .font(ADEUsageType.microFont(.semibold))
        .tracking(0.8)
        .foregroundStyle(ADEColor.textMuted)

      HStack(alignment: .firstTextBaseline, spacing: 2) {
        Text(adeUsageCost(model.totalCostUsd))
          .font(ADEUsageType.heroFont())
          .foregroundStyle(ADEColor.textPrimary)
        Button {
          estimationSheetPresented = true
        } label: {
          Text("*")
            .font(ADEUsageType.titleFont())
            .foregroundStyle(ADEColor.purpleAccent)
            .padding(.horizontal, 8)
            .frame(minWidth: 44, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("How this figure was worked out")
        Spacer(minLength: 0)
      }

      Text("* if billed at full API rate")
        .font(ADEUsageType.microFont())
        .foregroundStyle(ADEColor.textMuted)

      if !model.providers.isEmpty {
        costSplitBar
        VStack(spacing: 8) {
          ForEach(model.providers.prefix(5)) { provider in
            HStack(spacing: 8) {
              if let assetName = provider.assetName {
                Image(assetName)
                  .resizable()
                  .scaledToFit()
                  .frame(width: 14, height: 14)
                  .accessibilityHidden(true)
              } else {
                Circle().fill(provider.color).frame(width: 8, height: 8)
                  .accessibilityHidden(true)
              }
              Text(provider.label)
                .font(ADEUsageType.bodyFont())
                .foregroundStyle(ADEColor.textSecondary)
                .lineLimit(1)
              Spacer(minLength: 8)
              Text("\(Int((provider.share * 100).rounded()))%")
                .font(ADEUsageType.detailFont())
                .monospacedDigit()
                .foregroundStyle(ADEColor.textMuted)
                .frame(width: 44, alignment: .trailing)
              Text(adeUsageCost(provider.costUsd))
                .font(ADEUsageType.bodyFont(.semibold))
                .monospacedDigit()
                .foregroundStyle(ADEColor.textPrimary)
                .frame(width: 76, alignment: .trailing)
            }
            .accessibilityElement(children: .combine)
          }
        }
      }
    }
    .padding(ADEUsageLayout.cardPadding)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(usageCardBackground)
  }

  private var costSplitBar: some View {
    GeometryReader { proxy in
      HStack(spacing: 1.5) {
        ForEach(model.providers) { provider in
          Rectangle()
            .fill(provider.color)
            .frame(width: max(2, proxy.size.width * provider.share))
        }
        Spacer(minLength: 0)
      }
      .clipShape(Capsule())
    }
    .frame(height: 8)
    .accessibilityHidden(true)
  }

  // MARK: Chart

  private var chartBand: some View {
    VStack(alignment: .leading, spacing: ADEUsageLayout.rowGap) {
      HStack(alignment: .firstTextBaseline) {
        Text(model.chart.metric == .cost ? "DAILY COST" : "DAILY TOKENS")
          .font(ADEUsageType.microFont(.semibold))
          .tracking(0.8)
          .foregroundStyle(ADEColor.textMuted)
        Spacer(minLength: 8)
        if model.chart.isCombinedFallback, model.chart.hasData {
          Text("Combined")
            .font(ADEUsageType.microFont())
            .foregroundStyle(ADEColor.textMuted)
        }
      }
      SettingsUsageDailyChart(model: model.chart, focusedProvider: focusedProvider)
      if model.chart.isCombinedFallback, model.chart.hasData {
        Text("This machine reports daily totals without a provider split. Update ADE on it to see one line per provider.")
          .font(ADEUsageType.microFont())
          .foregroundStyle(ADEColor.textMuted)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .padding(ADEUsageLayout.cardPadding)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(usageCardBackground)
  }

  // MARK: Live limits

  private var limitsBand: some View {
    VStack(alignment: .leading, spacing: ADEUsageLayout.rowGap) {
      HStack(alignment: .firstTextBaseline) {
        Text("LIVE LIMITS")
          .font(ADEUsageType.microFont(.semibold))
          .tracking(0.8)
          .foregroundStyle(ADEColor.textMuted)
        Spacer(minLength: 8)
        if let snapshot = store.snapshot {
          Text("Checked \(adeUsageRelativeTime(snapshot.lastPolledAt))")
            .font(ADEUsageType.microFont())
            .foregroundStyle(ADEColor.textMuted)
        }
      }

      if let snapshot = store.snapshot {
        VStack(alignment: .leading, spacing: 20) {
          ForEach(quotaProviders(snapshot), id: \.self) { provider in
            SettingsUsagePaceProvider(
              provider: provider,
              windows: snapshot.windows.filter { $0.provider == provider },
              status: snapshot.providerStatus?[provider],
              spendControlReached: provider == "codex" && snapshot.spendControlReached == true,
              focusedProvider: focusedProvider,
              onToggleFocus: { provider in
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.18)) {
                  focusedProvider = focusedProvider == provider ? nil : provider
                }
              }
            )
          }
        }
        Text("Tap a bar to pick that provider out of the chart.")
          .font(ADEUsageType.microFont())
          .foregroundStyle(ADEColor.textMuted)
      } else {
        Text("Pair with an updated ADE machine to see live Claude and Codex limits.")
          .font(ADEUsageType.detailFont())
          .foregroundStyle(ADEColor.textMuted)
      }
    }
    .padding(ADEUsageLayout.cardPadding)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(usageCardBackground)
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

  // MARK: Metric strip

  private var metricStrip: some View {
    VStack(alignment: .leading, spacing: ADEUsageLayout.rowGap) {
      Text("TOKENS")
        .font(ADEUsageType.microFont(.semibold))
        .tracking(0.8)
        .foregroundStyle(ADEColor.textMuted)

      LazyVGrid(
        columns: [GridItem(.flexible(), alignment: .leading), GridItem(.flexible(), alignment: .leading)],
        alignment: .leading,
        spacing: 18
      ) {
        metricTile("Total", adeUsageCompact(model.totalTokens))
        metricTile("Cached", adeUsageCompact(model.cachedTokens))
        metricTile("Uncached", adeUsageCompact(model.uncachedTokens))
        metricTile("Output", adeUsageCompact(model.outputTokens))
        metricTile("Cached share", "\(Int(model.cacheSharePercent.rounded()))%")
      }
    }
    .padding(ADEUsageLayout.cardPadding)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(usageCardBackground)
  }

  private func metricTile(_ label: String, _ value: String) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(value)
        .font(ADEUsageType.titleFont())
        .monospacedDigit()
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)
      Text(label)
        .font(ADEUsageType.detailFont())
        .foregroundStyle(ADEColor.textMuted)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(label), \(value)")
  }

  // MARK: Breakdown

  private var breakdownBand: some View {
    VStack(alignment: .leading, spacing: ADEUsageLayout.rowGap) {
      Text("BREAKDOWN")
        .font(ADEUsageType.microFont(.semibold))
        .tracking(0.8)
        .foregroundStyle(ADEColor.textMuted)

      if model.providers.isEmpty {
        Text(model.hasAnything
          ? "This range has activity but no per-provider ledger yet."
          : "Nothing here yet — your first Claude or Codex turn shows up within a minute.")
          .font(ADEUsageType.detailFont())
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      } else {
        VStack(spacing: 14) {
          ForEach(model.providers) { provider in
            HStack(alignment: .top, spacing: 10) {
              if let assetName = provider.assetName {
                Image(assetName)
                  .resizable()
                  .scaledToFit()
                  .frame(width: 16, height: 16)
                  .padding(.top, 1)
                  .accessibilityHidden(true)
              }
              VStack(alignment: .leading, spacing: 2) {
                Text(provider.label)
                  .font(ADEUsageType.bodyFont(.medium))
                  .foregroundStyle(ADEColor.textPrimary)
                Text("\(adeUsageCompact(provider.totalTokens)) tokens · \(provider.estimation.shortLabel)")
                  .font(ADEUsageType.detailFont())
                  .foregroundStyle(ADEColor.textMuted)
              }
              Spacer(minLength: 8)
              Text(adeUsageCost(provider.costUsd))
                .font(ADEUsageType.bodyFont(.semibold))
                .monospacedDigit()
                .foregroundStyle(ADEColor.textPrimary)
                .frame(width: 76, alignment: .trailing)
            }
            .accessibilityElement(children: .combine)
          }
        }
      }
    }
    .padding(ADEUsageLayout.cardPadding)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(usageCardBackground)
  }

  private var usageCardBackground: some View {
    RoundedRectangle(cornerRadius: ADEUsageLayout.cardCorner, style: .continuous)
      .fill(ADEColor.surfaceBackground.opacity(0.82))
      .overlay(
        RoundedRectangle(cornerRadius: ADEUsageLayout.cardCorner, style: .continuous)
          .stroke(ADEColor.glassBorder, lineWidth: 0.75)
      )
  }
}

// MARK: - Estimation footnote

/// What the `*` on the hero means, provider by provider: which ledgers were
/// counted and which were estimated from character counts.
struct SettingsUsageEstimationSheet: View {
  let providers: [SettingsUsageProviderRow]
  /// Which rate card priced these tokens. Nil on hosts that do not report one.
  var ratesNote: String?

  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: ADEUsageLayout.rowGap) {
          Text("This is what the range would have cost at full API rates. Subscription plans bill separately, so it is a yardstick, not a bill.")
            .font(ADEUsageType.bodyFont())
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)

          if let ratesNote {
            Text(ratesNote)
              .font(ADEUsageType.detailFont())
              .foregroundStyle(ADEColor.textMuted)
              .fixedSize(horizontal: false, vertical: true)
          }

          if providers.isEmpty {
            Text("No provider ledgers in this range yet.")
              .font(ADEUsageType.detailFont())
              .foregroundStyle(ADEColor.textMuted)
              .padding(.top, 8)
          } else {
            ForEach(providers) { provider in
              VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                  if let assetName = provider.assetName {
                    Image(assetName)
                      .resizable()
                      .scaledToFit()
                      .frame(width: 16, height: 16)
                      .accessibilityHidden(true)
                  }
                  Text(provider.label)
                    .font(ADEUsageType.bodyFont(.semibold))
                    .foregroundStyle(ADEColor.textPrimary)
                  Spacer(minLength: 8)
                  Text(provider.estimation.shortLabel)
                    .font(ADEUsageType.microFont(.semibold))
                    .foregroundStyle(provider.estimation.isEstimated ? ADEColor.warning : ADEColor.success)
                }
                Text(provider.estimation.explanation)
                  .font(ADEUsageType.detailFont())
                  .foregroundStyle(ADEColor.textMuted)
                  .fixedSize(horizontal: false, vertical: true)
              }
              .padding(.vertical, 8)
              .accessibilityElement(children: .combine)
            }
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20)
      }
      .background(SettingsUsageBackdrop().ignoresSafeArea())
      .navigationTitle("How this is worked out")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button("Done") { dismiss() }
        }
      }
    }
  }
}

/// Quiet page backdrop, matched to the rest of Settings.
struct SettingsUsageBackdrop: View {
  var body: some View {
    ADEColor.recessedBackground.opacity(0.55)
  }
}
