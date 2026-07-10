import Foundation
import SwiftUI

// The struct name is kept for source stability (referenced from WorkNewChatScreen
// and the Xcode project), but this is the tabbed activity module that matches the
// desktop redesign — named tabs, a unified range control, split token/code bars,
// tap tooltips, a warm empty state, and a streak/milestone footer chip.

private enum WorkUsageRange: String, CaseIterable, Identifiable {
  case today
  case week = "7d"
  case month = "30d"
  case year
  case all

  var id: String { rawValue }
  var title: String {
    switch self {
    case .today: return "Today"
    case .week: return "7d"
    case .month: return "30d"
    case .year: return "Year"
    case .all: return "All"
    }
  }
}

private enum WorkUsageTab: String, CaseIterable, Identifiable {
  case activity
  case tokens
  case code
  case clients

  var id: String { rawValue }
  var title: String {
    switch self {
    case .activity: return "Activity"
    case .tokens: return "Tokens"
    case .code: return "Code"
    case .clients: return "Clients"
    }
  }
}

private enum WorkUsageColors {
  static let tokenInput = ADEColor.info
  static let tokenOutput = ADEColor.warning
  static let tokenCache = ADEColor.textMuted
  static let insertions = ADEColor.success
  static let deletions = ADEColor.danger
  static let github = ADEColor.textMuted
  static let heatmap = ADEColor.info
  static let client: [String: Color] = [
    "desktop": ADEColor.info,
    "mobile": Color.pink,
    "tui": ADEColor.success,
    "web": Color.teal,
    "api": ADEColor.warning,
  ]
}

private struct WorkUsageVisualBucket: Identifiable {
  var id: String
  var date: String
  var inputTokens: Int
  var outputTokens: Int
  var cachedTokens: Int
  var insertions: Int
  var deletions: Int
  var githubAdditions: Int
  var githubDeletions: Int
  var sessions: Int
  var interactions: Int

  var tokens: Int { inputTokens + outputTokens + cachedTokens }
  var code: Int { insertions + deletions }
  var githubCode: Int { githubAdditions + githubDeletions }
  var activity: Int { tokens + sessions * 4_000 + interactions * 1_500 }
}

/// Compact day detail surfaced by a tap on a bar or heatmap cell.
private struct WorkUsageBucketDetail: Equatable {
  var date: String
  var inputTokens: Int
  var outputTokens: Int
  var cachedTokens: Int
  var insertions: Int
  var deletions: Int
  var sessions: Int

  var totalTokens: Int { inputTokens + outputTokens + cachedTokens }
  var code: Int { insertions + deletions }
}

private func workUsageBuckets(_ points: [MobileAdeUsageDailyPoint], maxCount: Int) -> [WorkUsageVisualBucket] {
  let ordered = points.sorted { $0.date < $1.date }
  guard !ordered.isEmpty else { return [] }
  let chunkSize = max(1, Int(ceil(Double(ordered.count) / Double(maxCount))))
  return stride(from: 0, to: ordered.count, by: chunkSize).map { start in
    let chunk = ordered[start..<min(start + chunkSize, ordered.count)]
    return WorkUsageVisualBucket(
      id: chunk.last?.date ?? String(start),
      date: chunk.last?.date ?? "",
      inputTokens: chunk.reduce(0) { $0 + ($1.inputTokens ?? 0) },
      outputTokens: chunk.reduce(0) { $0 + ($1.outputTokens ?? 0) },
      cachedTokens: chunk.reduce(0) { $0 + ($1.cachedTokens ?? 0) },
      insertions: chunk.reduce(0) { $0 + ($1.insertions ?? 0) },
      deletions: chunk.reduce(0) { $0 + ($1.deletions ?? 0) },
      githubAdditions: chunk.reduce(0) { $0 + ($1.githubAdditions ?? 0) },
      githubDeletions: chunk.reduce(0) { $0 + ($1.githubDeletions ?? 0) },
      sessions: chunk.reduce(0) { $0 + ($1.sessions ?? 0) },
      interactions: chunk.reduce(0) { $0 + ($1.interactions ?? 0) }
    )
  }
}

private func workUsageCompact(_ value: Int) -> String {
  if value >= 1_000_000_000 { return String(format: "%.1fB", Double(value) / 1_000_000_000) }
  if value >= 1_000_000 { return String(format: "%.1fM", Double(value) / 1_000_000) }
  if value >= 1_000 { return String(format: "%.1fK", Double(value) / 1_000) }
  return value.formatted()
}

private let workUsageDayParser: DateFormatter = {
  let formatter = DateFormatter()
  formatter.locale = Locale(identifier: "en_US_POSIX")
  formatter.dateFormat = "yyyy-MM-dd"
  return formatter
}()

private let workUsageDayDisplay: DateFormatter = {
  let formatter = DateFormatter()
  formatter.setLocalizedDateFormatFromTemplate("MMMd")
  return formatter
}()

private func workUsageFormatDay(_ date: String) -> String {
  guard let parsed = workUsageDayParser.date(from: date) else { return date }
  return workUsageDayDisplay.string(from: parsed)
}

private struct WorkUsageMilestone {
  let threshold: Int
  let label: String
}

private let workUsageMilestones: [WorkUsageMilestone] = [
  WorkUsageMilestone(threshold: 10_000_000_000, label: "10B lifetime tokens"),
  WorkUsageMilestone(threshold: 5_000_000_000, label: "5B lifetime tokens"),
  WorkUsageMilestone(threshold: 1_000_000_000, label: "1B lifetime tokens"),
  WorkUsageMilestone(threshold: 500_000_000, label: "500M lifetime tokens"),
  WorkUsageMilestone(threshold: 100_000_000, label: "100M lifetime tokens"),
]

struct WorkUsageActivityCarousel: View {
  @EnvironmentObject private var syncService: SyncService
  @AppStorage("ade.work.activityTab.v1") private var tabRaw = WorkUsageTab.activity.rawValue
  @AppStorage("ade.work.usageRange.v1") private var rangeRaw = WorkUsageRange.week.rawValue
  @AppStorage("ade.work.usageMilestone.v1") private var shownMilestone = 0
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var stats: MobileAdeUsageStats?
  @State private var loadedRange: String?
  @State private var loading = false
  @State private var selection: WorkUsageBucketDetail?
  @State private var chipScale: CGFloat = 1

  private var tab: WorkUsageTab { WorkUsageTab(rawValue: tabRaw) ?? .activity }
  private var range: WorkUsageRange { WorkUsageRange(rawValue: rangeRaw) ?? .week }
  private var loadKey: String { "\(rangeRaw):\(syncService.connectionState.rawValue)" }

  private var summary: MobileAdeUsageSummary? {
    loadedRange == rangeRaw ? stats?.summary : nil
  }

  private var hasActivity: Bool {
    guard let daily = stats?.daily else { return false }
    return daily.contains { point in
      (point.totalTokens ?? 0) > 0 || (point.sessions ?? 0) > 0
        || (point.insertions ?? 0) > 0 || (point.deletions ?? 0) > 0
        || (point.interactions ?? 0) > 0
    }
  }

  private var footerChip: (system: String, label: String, fresh: Bool)? {
    guard let summary else { return nil }
    if range == .all, let totalTokens = summary.totalTokens,
       let crossed = workUsageMilestones.first(where: { totalTokens >= $0.threshold }) {
      return ("trophy.fill", crossed.label, crossed.threshold > shownMilestone)
    }
    if let streak = summary.currentStreakDays, streak >= 3 {
      return ("flame.fill", "\(streak)-day streak", false)
    }
    return nil
  }

  var body: some View {
    VStack(spacing: 10) {
      header

      ZStack(alignment: .top) {
        chartArea
          .frame(height: 84)
        if let selection {
          WorkUsageTooltip(detail: selection)
            .padding(.top, -6)
            .transition(.opacity)
        }
      }

      footer
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
    .background {
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .fill(ADEColor.surfaceBackground.opacity(0.9))
    }
    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    .overlay {
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .stroke(ADEColor.glassBorder, lineWidth: 0.6)
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel(accessibilitySummary)
    .task(id: loadKey) { await loadStats() }
    .onChange(of: rangeRaw) { _, _ in selection = nil }
    .onChange(of: tabRaw) { _, _ in selection = nil }
  }

  private var accessibilitySummary: String {
    guard let summary else { return "Activity for \(range.title). Loading." }
    let sessions = (summary.chatSessions ?? 0) + (summary.terminalSessions ?? 0)
    return "Activity for \(range.title): \(workUsageCompact(summary.totalTokens ?? 0)) tokens, \(sessions) sessions, \(summary.activeDays ?? 0) active days."
  }

  private var header: some View {
    HStack(spacing: 8) {
      tabRow
      Spacer(minLength: 6)
      rangeControl
    }
  }

  private var tabRow: some View {
    HStack(spacing: 2) {
      ForEach(WorkUsageTab.allCases) { option in
        Button(option.title) {
          withAnimation(reduceMotion ? nil : .snappy(duration: 0.18)) { tabRaw = option.rawValue }
        }
        .font(.caption.weight(tab == option ? .semibold : .medium))
        .foregroundStyle(tab == option ? ADEColor.textPrimary : ADEColor.textMuted)
        .padding(.horizontal, 8)
        .frame(minHeight: 34)
        .background(
          tab == option ? ADEColor.recessedBackground.opacity(0.9) : .clear,
          in: RoundedRectangle(cornerRadius: 6, style: .continuous)
        )
        .contentShape(Rectangle())
        .buttonStyle(.plain)
        .accessibilityLabel("\(option.title) chart")
        .accessibilityAddTraits(tab == option ? .isSelected : [])
      }
    }
  }

  private var rangeControl: some View {
    Menu {
      Picker("Time range", selection: $rangeRaw) {
        ForEach(WorkUsageRange.allCases) { option in
          Text(option.title).tag(option.rawValue)
        }
      }
    } label: {
      HStack(spacing: 4) {
        Text(range.title)
          .font(.caption.weight(.medium))
        Image(systemName: "chevron.down")
          .font(.system(size: 9, weight: .semibold))
      }
      .foregroundStyle(ADEColor.textSecondary)
      .padding(.horizontal, 10)
      .frame(minHeight: 34)
      .background(ADEColor.recessedBackground.opacity(0.7), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
    .accessibilityLabel("Time range, \(range.title)")
  }

  @ViewBuilder
  private var chartArea: some View {
    if let stats, loadedRange == rangeRaw {
      if !hasActivity {
        WorkUsageWarmEmpty()
      } else {
        switch tab {
        case .activity:
          WorkUsageHeatmap(points: stats.daily, selectedId: selection?.date, onSelect: select)
        case .tokens:
          WorkUsageBars(points: stats.daily, mode: .tokens, selectedId: selection?.date, onSelect: select)
        case .code:
          WorkUsageBars(points: stats.daily, mode: .code, selectedId: selection?.date, onSelect: select)
        case .clients:
          WorkUsageClientMix(clients: stats.clients ?? [])
        }
      }
    } else if loading {
      WorkUsageSkeleton()
    } else {
      WorkUsageWarmEmpty()
    }
  }

  private var footer: some View {
    HStack(spacing: 6) {
      Group {
        if let summary {
          let sessions = (summary.chatSessions ?? 0) + (summary.terminalSessions ?? 0)
          Text("\(workUsageCompact(summary.totalTokens ?? 0)) tokens")
          Text("·")
          Text("\(workUsageCompact(sessions)) sessions")
          if let activeDays = summary.activeDays, activeDays > 0 {
            Text("·")
            Text("\(activeDays) active \(activeDays == 1 ? "day" : "days")")
          }
        } else if loading {
          Text("Loading activity…")
        } else {
          Text("No activity yet")
        }
      }
      .font(.caption2)
      .foregroundStyle(ADEColor.textMuted)
      .lineLimit(1)

      Spacer(minLength: 0)

      if let chip = footerChip {
        Label(chip.label, systemImage: chip.system)
          .labelStyle(.titleAndIcon)
          .font(.caption2.weight(.medium))
          .foregroundStyle(ADEColor.accent)
          .padding(.horizontal, 8)
          .padding(.vertical, 3)
          .background(ADEColor.accent.opacity(0.14), in: Capsule(style: .continuous))
          .overlay(Capsule(style: .continuous).stroke(ADEColor.accent.opacity(0.28), lineWidth: 0.6))
          .scaleEffect(chipScale)
          .onAppear {
            guard chip.fresh else { return }
            shownMilestone = max(shownMilestone, currentMilestoneThreshold())
            guard !reduceMotion else { return }
            chipScale = 0.9
            withAnimation(.snappy(duration: 0.5)) { chipScale = 1 }
          }
          .accessibilityLabel(chip.label)
      }
    }
    .overlay(alignment: .top) { Divider().opacity(0.12) }
    .padding(.top, 2)
  }

  private func currentMilestoneThreshold() -> Int {
    guard range == .all, let totalTokens = summary?.totalTokens else { return shownMilestone }
    return workUsageMilestones.first(where: { totalTokens >= $0.threshold })?.threshold ?? shownMilestone
  }

  private func select(_ detail: WorkUsageBucketDetail) {
    withAnimation(reduceMotion ? nil : .easeOut(duration: 0.14)) {
      selection = (selection?.date == detail.date) ? nil : detail
    }
  }

  @MainActor
  private func loadStats() async {
    let requestedRange = range.rawValue
    guard syncService.supportsRemoteAction("usage.getAdeStats") else {
      stats = nil
      loadedRange = nil
      loading = false
      return
    }
    loading = loadedRange != requestedRange
    do {
      let first = try await syncService.fetchAdeUsageStats(preset: requestedRange)
      guard !Task.isCancelled, range.rawValue == requestedRange else { return }
      withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) {
        stats = first
        loadedRange = requestedRange
      }
      loading = false
      // Pick up a background ledger refresh the host signals as still warming.
      if first.freshness?.state == "refreshing" {
        try? await Task.sleep(nanoseconds: 2_800_000_000)
        guard !Task.isCancelled, range.rawValue == requestedRange else { return }
        if let refreshed = try? await syncService.fetchAdeUsageStats(preset: requestedRange) {
          guard !Task.isCancelled, range.rawValue == requestedRange else { return }
          stats = refreshed
        }
      }
    } catch {
      guard !Task.isCancelled else { return }
      stats = nil
      loadedRange = nil
      loading = false
    }
  }
}

private struct WorkUsageTooltip: View {
  let detail: WorkUsageBucketDetail

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(workUsageFormatDay(detail.date))
        .font(.caption2.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
      Text("\(workUsageCompact(detail.totalTokens)) tokens · \(workUsageCompact(detail.inputTokens)) in / \(workUsageCompact(detail.outputTokens)) out")
        .font(.system(size: 11))
        .foregroundStyle(ADEColor.textMuted)
      if detail.cachedTokens > 0 || detail.sessions > 0 {
        Text("\(workUsageCompact(detail.cachedTokens)) cache · \(detail.sessions) \(detail.sessions == 1 ? "session" : "sessions")")
          .font(.system(size: 11))
          .foregroundStyle(ADEColor.textMuted)
      }
      if detail.code > 0 {
        Text("+\(workUsageCompact(detail.insertions)) / -\(workUsageCompact(detail.deletions)) lines")
          .font(.system(size: 11))
          .foregroundStyle(ADEColor.textMuted)
      }
    }
    .padding(.horizontal, 9)
    .padding(.vertical, 6)
    .background(ADEColor.cardBackground.opacity(0.98), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(ADEColor.glassBorder, lineWidth: 0.6))
    .shadow(color: Color.black.opacity(0.2), radius: 6, y: 2)
    .accessibilityElement(children: .combine)
  }
}

private struct WorkUsageHeatmap: View {
  let points: [MobileAdeUsageDailyPoint]
  let selectedId: String?
  let onSelect: (WorkUsageBucketDetail) -> Void

  var body: some View {
    let buckets = workUsageBuckets(points, maxCount: 70)
    let maximum = max(1, buckets.map(\.activity).max() ?? 1)
    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 3), count: 14), spacing: 3) {
      ForEach(buckets) { bucket in
        RoundedRectangle(cornerRadius: 2, style: .continuous)
          .fill(bucket.activity == 0
            ? ADEColor.textMuted.opacity(0.10)
            : WorkUsageColors.heatmap.opacity(0.25 + 0.72 * Double(bucket.activity) / Double(maximum)))
          .frame(height: 11)
          .overlay {
            if selectedId == bucket.date {
              RoundedRectangle(cornerRadius: 2, style: .continuous)
                .stroke(ADEColor.textPrimary.opacity(0.6), lineWidth: 1)
            }
          }
          .contentShape(Rectangle())
          .onTapGesture { onSelect(detail(bucket)) }
          .accessibilityLabel("\(workUsageFormatDay(bucket.date)), \(workUsageCompact(bucket.tokens)) tokens")
      }
    }
    .frame(maxHeight: .infinity, alignment: .center)
  }

  private func detail(_ bucket: WorkUsageVisualBucket) -> WorkUsageBucketDetail {
    WorkUsageBucketDetail(
      date: bucket.date,
      inputTokens: bucket.inputTokens,
      outputTokens: bucket.outputTokens,
      cachedTokens: bucket.cachedTokens,
      insertions: bucket.insertions,
      deletions: bucket.deletions,
      sessions: bucket.sessions
    )
  }
}

private enum WorkUsageBarMode { case tokens, code }

private struct WorkUsageBars: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let points: [MobileAdeUsageDailyPoint]
  let mode: WorkUsageBarMode
  let selectedId: String?
  let onSelect: (WorkUsageBucketDetail) -> Void

  var body: some View {
    let buckets = workUsageBuckets(points, maxCount: 36)
    let anyGithub = mode == .code && buckets.contains { $0.githubCode > 0 }
    let localMax = buckets.map { mode == .tokens ? $0.tokens : $0.code }.max() ?? 1
    let githubMax = anyGithub ? (buckets.map(\.githubCode).max() ?? 1) : 1
    let maximum = max(1, localMax, githubMax)
    let anyCache = mode == .tokens && buckets.contains { $0.cachedTokens > 0 }

    VStack(spacing: 6) {
      GeometryReader { proxy in
        HStack(alignment: .bottom, spacing: 2) {
          ForEach(Array(buckets.enumerated()), id: \.element.id) { index, bucket in
            bar(bucket: bucket, index: index, height: proxy.size.height, maximum: maximum, anyGithub: anyGithub)
          }
        }
      }
      legend(anyCache: anyCache, anyGithub: anyGithub)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(mode == .tokens ? "AI token flow" : "Code movement")
    .accessibilityValue(mode == .tokens
      ? "\(workUsageCompact(buckets.reduce(0) { $0 + $1.inputTokens })) input and \(workUsageCompact(buckets.reduce(0) { $0 + $1.outputTokens })) output tokens"
      : "\(workUsageCompact(buckets.reduce(0) { $0 + $1.insertions })) additions and \(workUsageCompact(buckets.reduce(0) { $0 + $1.deletions })) deletions")
  }

  @ViewBuilder
  private func bar(bucket: WorkUsageVisualBucket, index: Int, height: CGFloat, maximum: Int, anyGithub: Bool) -> some View {
    let total = mode == .tokens ? bucket.tokens : bucket.code
    let barHeight = total == 0 ? 2 : max(3, height * CGFloat(total) / CGFloat(maximum))
    let githubHeight = anyGithub && bucket.githubCode > 0
      ? max(2, height * CGFloat(bucket.githubCode) / CGFloat(maximum))
      : 0
    ZStack(alignment: .bottom) {
      if githubHeight > 0 {
        RoundedRectangle(cornerRadius: 2, style: .continuous)
          .fill(WorkUsageColors.github.opacity(0.3))
          .frame(height: githubHeight)
      }
      stackedSegments(bucket: bucket, barHeight: barHeight)
        .frame(height: barHeight)
        .clipShape(RoundedRectangle(cornerRadius: 2, style: .continuous))
      if selectedId == bucket.date {
        RoundedRectangle(cornerRadius: 2, style: .continuous)
          .stroke(ADEColor.textPrimary.opacity(0.55), lineWidth: 1)
          .frame(height: max(barHeight, githubHeight))
      }
    }
    .frame(maxWidth: .infinity)
    .frame(height: max(barHeight, githubHeight), alignment: .bottom)
    .contentShape(Rectangle())
    .onTapGesture { onSelect(detail(bucket)) }
    .animation(reduceMotion ? nil : .snappy(duration: 0.4).delay(Double(min(index, 24)) * 0.008), value: total)
  }

  /// Explicit proportional segment heights so a stacked bar reads input/output/
  /// cache (or additions/deletions) bottom-to-top without ambiguous flex layout.
  @ViewBuilder
  private func stackedSegments(bucket: WorkUsageVisualBucket, barHeight: CGFloat) -> some View {
    if mode == .tokens {
      let total = CGFloat(max(1, bucket.tokens))
      VStack(spacing: 0) {
        Rectangle().fill(WorkUsageColors.tokenCache)
          .frame(height: barHeight * CGFloat(bucket.cachedTokens) / total)
        Rectangle().fill(WorkUsageColors.tokenOutput)
          .frame(height: barHeight * CGFloat(bucket.outputTokens) / total)
        Rectangle().fill(WorkUsageColors.tokenInput)
          .frame(maxHeight: .infinity)
      }
    } else {
      let total = CGFloat(max(1, bucket.code))
      VStack(spacing: 0) {
        Rectangle().fill(WorkUsageColors.deletions)
          .frame(height: barHeight * CGFloat(bucket.deletions) / total)
        Rectangle().fill(WorkUsageColors.insertions)
          .frame(maxHeight: .infinity)
      }
    }
  }

  @ViewBuilder
  private func legend(anyCache: Bool, anyGithub: Bool) -> some View {
    HStack(spacing: 10) {
      if mode == .tokens {
        legendItem(WorkUsageColors.tokenInput, "Input")
        legendItem(WorkUsageColors.tokenOutput, "Output")
        if anyCache { legendItem(WorkUsageColors.tokenCache, "Cache") }
      } else {
        legendItem(WorkUsageColors.insertions, "Added")
        legendItem(WorkUsageColors.deletions, "Removed")
        if anyGithub { legendItem(WorkUsageColors.github.opacity(0.5), "GitHub") }
      }
      Spacer(minLength: 0)
    }
    .font(.system(size: 11))
    .foregroundStyle(ADEColor.textMuted)
  }

  private func legendItem(_ color: Color, _ label: String) -> some View {
    HStack(spacing: 4) {
      RoundedRectangle(cornerRadius: 2, style: .continuous).fill(color).frame(width: 8, height: 8)
      Text(label)
    }
  }

  private func detail(_ bucket: WorkUsageVisualBucket) -> WorkUsageBucketDetail {
    WorkUsageBucketDetail(
      date: bucket.date,
      inputTokens: bucket.inputTokens,
      outputTokens: bucket.outputTokens,
      cachedTokens: bucket.cachedTokens,
      insertions: bucket.insertions,
      deletions: bucket.deletions,
      sessions: bucket.sessions
    )
  }
}

private struct WorkUsageClientMix: View {
  let clients: [MobileAdeUsageClientSummary]

  private func label(_ client: String) -> String {
    switch client {
    case "desktop": return "Desktop"
    case "mobile": return "Mobile"
    case "tui": return "ADE Code"
    case "web": return "Web"
    default: return "API"
    }
  }

  var body: some View {
    let visible = clients.filter { $0.interactions > 0 }.sorted { $0.interactions > $1.interactions }
    let total = max(1, visible.reduce(0) { $0 + $1.interactions })
    if visible.isEmpty {
      WorkUsageWarmEmpty()
    } else {
      VStack(spacing: 10) {
        GeometryReader { proxy in
          HStack(spacing: 0) {
            ForEach(visible) { client in
              Rectangle()
                .fill(WorkUsageColors.client[client.client] ?? ADEColor.warning)
                .frame(width: proxy.size.width * CGFloat(client.interactions) / CGFloat(total))
            }
          }
          .clipShape(Capsule())
        }
        .frame(height: 10)
        LazyVGrid(
          columns: Array(repeating: GridItem(.flexible(), alignment: .leading), count: 2),
          alignment: .leading,
          spacing: 4
        ) {
          ForEach(visible.prefix(4)) { client in
            HStack(spacing: 4) {
              Circle().fill(WorkUsageColors.client[client.client] ?? ADEColor.warning).frame(width: 6, height: 6)
              Text(label(client.client))
              Text("\(Int(round(Double(client.interactions) / Double(total) * 100)))%")
                .foregroundStyle(ADEColor.textPrimary)
            }
            .lineLimit(1)
          }
        }
        .font(.caption2)
        .foregroundStyle(ADEColor.textMuted)
      }
      .frame(maxHeight: .infinity, alignment: .center)
      .accessibilityElement(children: .combine)
      .accessibilityLabel("Where you use ADE")
    }
  }
}

private struct WorkUsageWarmEmpty: View {
  private let fractions: [CGFloat] = [0.35, 0.55, 0.4, 0.7, 0.5, 0.62, 0.44, 0.58, 0.48, 0.66, 0.4, 0.54]

  var body: some View {
    VStack(spacing: 8) {
      HStack(alignment: .bottom, spacing: 3) {
        ForEach(Array(fractions.enumerated()), id: \.offset) { _, fraction in
          RoundedRectangle(cornerRadius: 2, style: .continuous)
            .fill(ADEColor.textMuted.opacity(0.12))
            .frame(height: 34 * fraction)
            .frame(maxWidth: .infinity)
        }
      }
      .frame(height: 34)
      Text("Your activity will appear here after your first chat.")
        .font(.caption2)
        .foregroundStyle(ADEColor.textMuted)
        .multilineTextAlignment(.center)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
    .accessibilityLabel("Your activity will appear here after your first chat.")
  }
}

private struct WorkUsageSkeleton: View {
  private let fractions: [CGFloat] = (0..<20).map { 0.3 + CGFloat(($0 * 37) % 60) / 100 }

  var body: some View {
    HStack(alignment: .bottom, spacing: 3) {
      ForEach(Array(fractions.enumerated()), id: \.offset) { _, fraction in
        RoundedRectangle(cornerRadius: 2, style: .continuous)
          .fill(ADEColor.textMuted.opacity(0.1))
          .frame(height: max(4, 76 * fraction))
          .frame(maxWidth: .infinity)
      }
    }
    .frame(maxHeight: .infinity, alignment: .bottom)
    .accessibilityLabel("Loading activity")
  }
}
