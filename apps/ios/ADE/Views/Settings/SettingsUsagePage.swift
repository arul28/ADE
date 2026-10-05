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
  /// The page total split by token type and speed: the providers' splits
  /// added up, and only when every provider with a cost sent one.
  var costSplit: MobileAdeUsageCostSplit?
  /// Models ranked by cost, for the breakdown's Models view.
  var models: [MobileAdeUsageModelSummary] = []

  static func build(from stats: MobileAdeUsageStats?) -> SettingsUsagePageModel {
    var model = SettingsUsagePageModel()
    guard let stats else { return model }

    let providerSummaries = stats.providers ?? []
    var totalCost = 0.0
    var rows: [SettingsUsageProviderRow] = []
    // Only the providers that survive the guard below reach the screen, so only
    // their rate cards may describe what is on it — a provider with nothing in
    // range must not flip the note to "mixed".
    var countedPricingSources: [String] = []
    rows.reserveCapacity(providerSummaries.count)
    for summary in providerSummaries {
      let cost = max(0, summary.rangeCostUsd ?? 0)
      let tokens = summary.totalTokens
        ?? ((summary.inputTokens ?? 0) + (summary.outputTokens ?? 0) + (summary.cachedTokens ?? 0))
      guard cost > 0 || tokens > 0 else { continue }
      if let pricingSource = summary.pricingSource { countedPricingSources.append(pricingSource) }
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
      sources: countedPricingSources,
      pricingUpdatedAt: stats.pricingUpdatedAt
    )
    model.chart = ADEUsageChartModel.build(
      points: stats.daily,
      metric: totalCost > 0 ? .cost : .tokens
    )
    let pricedProviders = providerSummaries.filter { ($0.rangeCostUsd ?? 0) > 0 }
    if !pricedProviders.isEmpty, pricedProviders.allSatisfy({ $0.costSplit != nil }) {
      model.costSplit = pricedProviders.compactMap(\.costSplit).reduce(.zero, +)
    }
    model.models = (stats.models ?? [])
      .filter { ($0.costUsd ?? 0) > 0 || ($0.totalTokens ?? 0) > 0 }
      .sorted { ($0.costUsd ?? 0) > ($1.costUsd ?? 0) }
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


/// The Usage page's breakdown views. Every case but `models` is a host
/// `usage.getCostBreakdown` dimension, sent as its raw value.
enum SettingsUsageBreakdownView: String, CaseIterable {
  case models
  case chat
  case lane
  case account

  var title: String {
    switch self {
    case .models: return "Models"
    case .chat: return "Chats"
    case .lane: return "Lanes"
    case .account: return "Accounts"
    }
  }
}

struct SettingsUsagePage: View {
  let syncService: SyncService

  @ObservedObject private var store = MobileUsageQuotaStore.shared
  @AppStorage("ade.settings.usageRange.v1") private var rangeRaw = "30d"
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  @State private var model = SettingsUsagePageModel()
  @State private var estimationSheetPresented = false
  @State private var breakdownView: SettingsUsageBreakdownView = .models
  @State private var breakdown: MobileAdeUsageCostBreakdown?
  @State private var breakdownLane: (id: String, name: String)?
  @State private var billing: MobileAdeUsageCostBreakdownTotals?
  @State private var ledgerAvailable = false
  @State private var breakdownFailed = false

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
      // Billed vs plan value for ADE's own chats, from the host's ledger.
      let totals = try? await syncService.fetchUsageCostBreakdown(by: "account", preset: rangeRaw)
      ledgerAvailable = totals != nil
      // The picker hides with the ledger; a ledger view left selected would
      // spin with no way back to Models.
      if !ledgerAvailable {
        breakdownView = .models
        breakdownLane = nil
      }
      billing = totals?.available == true ? totals?.totals : nil
    }
    .task(id: "\(modelKey):\(breakdownView):\(breakdownLane?.id ?? "")") {
      guard breakdownView != .models else { breakdown = nil; return }
      breakdownFailed = false
      do {
        breakdown = try await syncService.fetchUsageCostBreakdown(by: breakdownView.rawValue, preset: rangeRaw, laneId: breakdownLane?.id)
        breakdownFailed = breakdown == nil
      } catch {
        if Task.isCancelled || error is CancellationError { return }
        breakdown = nil
        breakdownFailed = true
      }
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

      if let billing, billing.turns > 0 {
        Text("ADE chats · billed to API keys \(adeUsageCost(billing.billedUsd)) · plan value \(adeUsageCost(billing.planValueUsd))")
          .font(ADEUsageType.detailFont())
          .monospacedDigit()
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }

      if let split = model.costSplit, split.total > 0 {
        SettingsUsageCostSplitBars(split: split)
      }

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
      SettingsUsageDailyChart(model: model.chart)
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
            ADEUsageLimitsProviderSection(
              provider: provider,
              windows: snapshot.windows.filter { $0.provider == provider },
              accounts: pooledAccounts(snapshot),
              status: snapshot.providerStatus?[provider],
              spendControlReached: provider == "codex" && snapshot.spendControlReached == true,
              resetCredits: resetCreditAccounts(in: snapshot, provider: provider),
              density: .regular
            )
          }
        }
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

  /// Accounts pooled by email: the same login reported by two machines is one
  /// account with two `Via` entries, not two rows of the same numbers. Hosts
  /// that predate the directory send none, and the cards fall back to one
  /// unnamed account per provider.
  private func pooledAccounts(_ snapshot: MobileUsageQuotaSnapshot) -> [ADEUsageAccountView] {
    adeUsagePoolAccounts(snapshot.accounts)
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

      if ledgerAvailable {
        Picker("Breakdown", selection: $breakdownView) {
          ForEach(SettingsUsageBreakdownView.allCases, id: \.self) { view in
            Text(view.title).tag(view)
          }
        }
        .pickerStyle(.segmented)
        .onChange(of: breakdownView) { _, _ in breakdownLane = nil }
        .accessibilityLabel("Breakdown view")
      }

      if breakdownView == .models {
        modelsList
      } else {
        ledgerList
      }
    }
    .padding(ADEUsageLayout.cardPadding)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(usageCardBackground)
  }

  @ViewBuilder
  private var modelsList: some View {
    if model.models.isEmpty {
      Text(model.hasAnything
        ? "This range has activity but no per-model ledger yet."
        : "Nothing here yet — your first Claude or Codex turn shows up within a minute.")
        .font(ADEUsageType.detailFont())
        .foregroundStyle(ADEColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
    } else {
      let total = model.models.reduce(0) { $0 + ($1.costUsd ?? 0) }
      VStack(spacing: 12) {
        ForEach(model.models.prefix(12)) { entry in
          NavigationLink {
            SettingsUsageModelDetailScreen(syncService: syncService, provider: entry.provider, model: entry.model, preset: rangeRaw)
          } label: {
            SettingsUsageBreakdownRowView(
              label: entry.model,
              detail: "\(adeUsageCompact(entry.totalTokens ?? 0)) tokens",
              assetName: providerAssetName(entry.provider),
              cost: entry.costUsd ?? 0,
              share: total > 0 ? (entry.costUsd ?? 0) / total : 0,
              showsChevron: true
            )
          }
          .buttonStyle(.plain)
        }
      }
    }
  }

  @ViewBuilder
  private var ledgerList: some View {
    if let lane = breakdownLane {
      Button {
        breakdownLane = nil
        breakdownView = .lane
      } label: {
        Text("Lanes › \(lane.name)")
          .font(ADEUsageType.detailFont(.medium))
          .foregroundStyle(ADEColor.purpleAccent)
      }
      .buttonStyle(.plain)
    }
    Text(breakdownView == .account ? "ADE chats on this machine. Billed is what API keys were charged." : "ADE chats in this project. Billed is what API keys were charged.")
      .font(ADEUsageType.microFont())
      .foregroundStyle(ADEColor.textMuted)
      .fixedSize(horizontal: false, vertical: true)
    if let breakdown, breakdown.by == breakdownView.rawValue {
      if breakdown.rows.isEmpty {
        Text("No ADE chat turns in this range.")
          .font(ADEUsageType.detailFont())
          .foregroundStyle(ADEColor.textSecondary)
      } else {
        let total = breakdown.totals.costUsd
        VStack(spacing: 12) {
          ForEach(breakdown.rows) { row in
            let rowView = SettingsUsageBreakdownRowView(
              label: row.label,
              detail: [breakdownLane == nil ? row.detail : nil, row.billedUsd > 0 ? "billed \(adeUsageCost(row.billedUsd))" : nil]
                .compactMap { $0 }.joined(separator: " · "),
              assetName: row.provider.flatMap(providerAssetName),
              cost: row.costUsd,
              share: total > 0 ? row.costUsd / total : 0,
              showsChevron: breakdownView == .lane && row.laneId != nil
            )
            if breakdownView == .lane, let laneId = row.laneId {
              Button {
                breakdownLane = (laneId, row.label)
                breakdownView = .chat
              } label: { rowView }
              .buttonStyle(.plain)
            } else {
              rowView
            }
          }
          if let other = breakdown.other {
            SettingsUsageBreakdownRowView(
              label: "Other (\(other.count))",
              detail: nil,
              assetName: nil,
              cost: other.costUsd,
              share: total > 0 ? other.costUsd / total : 0,
              showsChevron: false
            )
          }
        }
      }
    } else if breakdownFailed {
      Text("Couldn't load this view.")
        .font(ADEUsageType.detailFont())
        .foregroundStyle(ADEColor.textSecondary)
    } else {
      ProgressView().frame(maxWidth: .infinity)
    }
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


// MARK: - Cost split and breakdown pieces

/// The type and speed bars under the hero, the same split the desktop draws.
/// Colours are the validated data-viz categorical order (blue, orange, aqua,
/// yellow; orange/violet for the speed premiums) with grey for the remainder,
/// and every segment is named with its dollars in the legend, so identity never
/// rests on colour alone.
struct SettingsUsageCostSplitBars: View {
  let split: MobileAdeUsageCostSplit
  @Environment(\.colorScheme) private var colorScheme

  private func color(_ light: UInt32, _ dark: UInt32) -> Color {
    let hex = colorScheme == .dark ? dark : light
    return Color(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
  }

  var body: some View {
    let neutral = color(0xA3A19C, 0x5F5C6B)
    VStack(alignment: .leading, spacing: 12) {
      SettingsUsageSplitBar(title: "By type", segments: [
        ("Input", split.input, color(0x2A78D6, 0x3987E5)),
        ("Cache read", split.cacheRead, color(0xEB6834, 0xD95926)),
        ("Cache write", split.cacheWrite, color(0x1BAF7A, 0x199E70)),
        ("Output", split.output, color(0xEDA100, 0xC98500)),
        ("Other", split.other, neutral),
      ])
      if split.premium > 0 {
        SettingsUsageSplitBar(title: "By speed", segments: [
          ("Standard rate", max(0, split.total - split.premium), neutral),
          ("Fast premium", split.fastPremium, color(0xEB6834, 0xD95926)),
          ("Ultrafast premium", split.ultrafastPremium, color(0x4A3AA7, 0x9085E9)),
        ])
      } else {
        Text("By speed · all at standard rates")
          .font(ADEUsageType.microFont())
          .foregroundStyle(ADEColor.textMuted)
      }
    }
  }
}

struct SettingsUsageSplitBar: View {
  let title: String
  let segments: [(String, Double, Color)]

  var body: some View {
    let visible = segments.filter { $0.1 > 0 }
    let total = visible.reduce(0) { $0 + $1.1 }
    VStack(alignment: .leading, spacing: 6) {
      Text(title)
        .font(ADEUsageType.microFont())
        .foregroundStyle(ADEColor.textMuted)
      GeometryReader { proxy in
        HStack(spacing: 2) {
          ForEach(Array(visible.enumerated()), id: \.offset) { _, segment in
            Rectangle()
              .fill(segment.2)
              .frame(width: max(3, (proxy.size.width - CGFloat(visible.count - 1) * 2) * (total > 0 ? segment.1 / total : 0)))
          }
        }
        .clipShape(Capsule())
      }
      .frame(height: 8)
      .accessibilityHidden(true)
      FlowLegend(items: visible.map { (label: $0.0, value: adeUsageCost($0.1), color: $0.2) })
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(title): " + visible.map { "\($0.0) \(adeUsageCost($0.1))" }.joined(separator: ", "))
  }
}

/// Legend items that wrap onto as many lines as they need.
private struct FlowLegend: View {
  let items: [(label: String, value: String, color: Color)]

  var body: some View {
    let columns = [GridItem(.adaptive(minimum: 130), spacing: 8, alignment: .leading)]
    LazyVGrid(columns: columns, alignment: .leading, spacing: 4) {
      ForEach(Array(items.enumerated()), id: \.offset) { _, item in
        HStack(spacing: 5) {
          RoundedRectangle(cornerRadius: 2).fill(item.color).frame(width: 8, height: 8)
          Text(item.label).foregroundStyle(ADEColor.textMuted)
          Text(item.value).foregroundStyle(ADEColor.textPrimary).monospacedDigit()
        }
        .font(ADEUsageType.microFont())
        .lineLimit(1)
      }
    }
  }
}

struct SettingsUsageBreakdownRowView: View {
  let label: String
  let detail: String?
  let assetName: String?
  let cost: Double
  let share: Double
  let showsChevron: Bool

  var body: some View {
    HStack(alignment: .center, spacing: 10) {
      if let assetName {
        Image(assetName).resizable().scaledToFit().frame(width: 16, height: 16).accessibilityHidden(true)
      }
      VStack(alignment: .leading, spacing: 2) {
        Text(label)
          .font(ADEUsageType.bodyFont(.medium))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
        if let detail, !detail.isEmpty {
          Text(detail)
            .font(ADEUsageType.detailFont())
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
        }
      }
      Spacer(minLength: 8)
      Text("\(Int((share * 100).rounded()))%")
        .font(ADEUsageType.detailFont())
        .monospacedDigit()
        .foregroundStyle(ADEColor.textMuted)
      Text(adeUsageCost(cost))
        .font(ADEUsageType.bodyFont(.semibold))
        .monospacedDigit()
        .foregroundStyle(ADEColor.textPrimary)
        .frame(width: 76, alignment: .trailing)
      if showsChevron {
        Image(systemName: "chevron.right")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(ADEColor.textMuted)
          .accessibilityHidden(true)
      }
    }
    .contentShape(Rectangle())
    .accessibilityElement(children: .combine)
  }
}

// MARK: - Model detail

/// One model's cost, cache hit rate, daily trend, split and price — the pushed
/// counterpart of the desktop's model dialog. "Set price" and "Map to" show
/// only when the host can save them.
struct SettingsUsageModelDetailScreen: View {
  let syncService: SyncService
  let provider: String
  let model: String
  let preset: String

  @State private var detail: MobileAdeUsageModelDetail?
  @State private var failed = false
  @State private var inputPrice = ""
  @State private var outputPrice = ""
  @State private var mapTo = ""
  @State private var saving = false
  @State private var message: String?

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        if let detail {
          HStack(spacing: 12) {
            kpi("Cost", adeUsageCost(detail.costUsd))
            kpi("Tokens", adeUsageCompact(detail.totalTokens))
            kpi("Per 1M", detail.costPerMillionUsd.map(adeUsageCost) ?? "—")
            kpi("Cache hit", detail.cacheHitRate.map { "\(Int(($0 * 100).rounded()))%" } ?? "—")
          }
          trend(detail.daily)
          if let split = detail.costSplit, split.total > 0 {
            SettingsUsageCostSplitBars(split: split)
          }
          priceSection(detail)
        } else if failed {
          Text("This machine can't show model detail yet. Update ADE on it and reconnect.")
            .font(ADEUsageType.detailFont())
            .foregroundStyle(ADEColor.textSecondary)
        } else {
          ProgressView().frame(maxWidth: .infinity)
        }
        if let message {
          Text(message)
            .font(ADEUsageType.microFont())
            .foregroundStyle(ADEColor.textMuted)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      .padding(16)
    }
    .background(SettingsUsageBackdrop().ignoresSafeArea())
    .navigationTitle(model)
    .navigationBarTitleDisplayMode(.inline)
    .task { await load() }
  }

  private func load() async {
    do {
      guard let result = try await syncService.fetchUsageModelDetail(provider: provider, model: model, preset: preset) else {
        failed = true
        return
      }
      detail = result
      mapTo = result.mapTo ?? ""
      if result.price.unpriced != true {
        inputPrice = String(result.price.input)
        outputPrice = String(result.price.output)
      }
    } catch {
      failed = true
    }
  }

  private func kpi(_ label: String, _ value: String) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(label.uppercased())
        .font(ADEUsageType.microFont(.semibold))
        .foregroundStyle(ADEColor.textMuted)
      Text(value)
        .font(ADEUsageType.bodyFont(.semibold))
        .monospacedDigit()
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)
        .minimumScaleFactor(0.7)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func trend(_ days: [MobileAdeUsageModelDetailDay]) -> some View {
    let peak = days.map(\.costUsd).max() ?? 0
    return VStack(alignment: .leading, spacing: 6) {
      Text("Daily cost · peak \(adeUsageCost(peak))")
        .font(ADEUsageType.microFont())
        .foregroundStyle(ADEColor.textMuted)
      HStack(alignment: .bottom, spacing: 2) {
        ForEach(days) { day in
          RoundedRectangle(cornerRadius: 1.5)
            .fill(ADEColor.purpleAccent)
            .frame(height: max(2, peak > 0 ? 56 * day.costUsd / peak : 2))
            .frame(maxWidth: 14)
        }
      }
      .frame(height: 56, alignment: .bottom)
      .accessibilityLabel("Daily cost over \(days.count) days")
    }
  }

  @ViewBuilder
  private func priceSection(_ detail: MobileAdeUsageModelDetail) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("PRICE")
        .font(ADEUsageType.microFont(.semibold))
        .foregroundStyle(ADEColor.textMuted)
      Text(detail.price.unpriced == true
        ? "No public price, so this model counts as $0."
        : "$\(detail.price.input.formatted()) in · $\(detail.price.output.formatted()) out per 1M · \(detail.price.source == "custom" ? "your price" : detail.price.source == "list" ? "models.dev" : "built-in estimate")")
        .font(ADEUsageType.detailFont())
        .foregroundStyle(ADEColor.textSecondary)
      if syncService.canSetUsageModelPrices {
        HStack {
          TextField("Input $/1M", text: $inputPrice).keyboardType(.decimalPad)
          TextField("Output $/1M", text: $outputPrice).keyboardType(.decimalPad)
          Button("Save") { Task { await savePrice() } }
            .disabled(saving || Double(inputPrice) == nil || Double(outputPrice) == nil)
        }
        .textFieldStyle(.roundedBorder)
        if detail.price.source == "custom" {
          Button("Back to automatic") { Task { await save(clearPrice: true, done: "Back to automatic pricing.") } }
            .disabled(saving)
        }
        Text("MAP TO")
          .font(ADEUsageType.microFont(.semibold))
          .foregroundStyle(ADEColor.textMuted)
          .padding(.top, 6)
        Text("Count this model as another one. Its tokens and cost move to that model, at that model's price.")
          .font(ADEUsageType.microFont())
          .foregroundStyle(ADEColor.textMuted)
          .fixedSize(horizontal: false, vertical: true)
        HStack {
          TextField("Model id", text: $mapTo)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .textFieldStyle(.roundedBorder)
          Button(mapTo.isEmpty && detail.mapTo != nil ? "Remove" : "Map") {
            Task { await save(mapTo: mapTo.trimmingCharacters(in: .whitespaces), done: mapTo.isEmpty ? "Mapping removed." : "Now counted as \(mapTo).") }
          }
          .disabled(saving || mapTo.trimmingCharacters(in: .whitespaces) == (detail.mapTo ?? ""))
        }
        if let mappedFrom = detail.mappedFrom, !mappedFrom.isEmpty {
          Text("Also counted here:")
            .font(ADEUsageType.microFont())
            .foregroundStyle(ADEColor.textMuted)
          ForEach(mappedFrom, id: \.self) { source in
            HStack {
              Text(source)
                .font(ADEUsageType.microFont().monospaced())
                .foregroundStyle(ADEColor.textPrimary)
              Spacer()
              Button("Unmap") {
                Task { await save(mapTo: "", target: source, done: "\(source) is counted on its own again.") }
              }
              .disabled(saving)
            }
          }
        }
      }
    }
  }

  private func savePrice() async {
    guard let input = Double(inputPrice), let output = Double(outputPrice) else { return }
    await save(price: MobileAdeUsageModelPrice(input: input, output: output, cacheRead: nil, cacheWrite: nil, source: nil, unpriced: nil), done: "Price saved.")
  }

  /// Applies to every raw id behind this model, or to `target` (a model mapped onto this one).
  private func save(price: MobileAdeUsageModelPrice? = nil, clearPrice: Bool = false, mapTo: String? = nil, target: String? = nil, done: String) async {
    saving = true
    defer { saving = false }
    let ids = target.map { [$0] } ?? detail?.modelIds ?? []
    do {
      try await syncService.setUsageModelPrice(model: ids.first ?? model, otherModelIds: Array(ids.dropFirst()), price: price, clearPrice: clearPrice, mapTo: mapTo)
      message = "\(done) The machine re-prices its history in the background."
      await load()
    } catch {
      message = error.localizedDescription
    }
  }
}
