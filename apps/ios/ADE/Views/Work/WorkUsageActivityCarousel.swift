import Foundation
import SwiftUI

private enum WorkUsageRange: String, CaseIterable, Identifiable {
  case day = "today"
  case week = "7d"
  case month = "30d"
  case year

  var id: String { rawValue }
  var title: String {
    switch self {
    case .day: return "Day"
    case .week: return "Week"
    case .month: return "Month"
    case .year: return "Year"
    }
  }
}

private enum WorkUsageChart: Int, CaseIterable {
  case activity
  case tokens
  case code
  case clients

  var title: String {
    switch self {
    case .activity: return "ADE activity"
    case .tokens: return "AI token flow"
    case .code: return "Code movement"
    case .clients: return "Where you use ADE"
    }
  }

  var detail: String {
    switch self {
    case .activity: return "Your daily rhythm"
    case .tokens: return "Input and output"
    case .code: return "Additions and deletions"
    case .clients: return "Desktop, mobile, terminal, and web"
    }
  }
}

private struct WorkUsageVisualBucket: Identifiable {
  var id: String
  var inputTokens: Int
  var outputTokens: Int
  var insertions: Int
  var deletions: Int
  var sessions: Int
  var interactions: Int

  var tokens: Int { inputTokens + outputTokens }
  var code: Int { insertions + deletions }
  var activity: Int { tokens + sessions * 4_000 + interactions * 1_500 }
}

private func workUsageBuckets(_ points: [MobileAdeUsageDailyPoint], maxCount: Int) -> [WorkUsageVisualBucket] {
  let ordered = points.sorted { $0.date < $1.date }
  guard !ordered.isEmpty else { return [] }
  let chunkSize = max(1, Int(ceil(Double(ordered.count) / Double(maxCount))))
  return stride(from: 0, to: ordered.count, by: chunkSize).map { start in
    let chunk = ordered[start..<min(start + chunkSize, ordered.count)]
    return WorkUsageVisualBucket(
      id: chunk.last?.date ?? String(start),
      inputTokens: chunk.reduce(0) { $0 + ($1.inputTokens ?? 0) },
      outputTokens: chunk.reduce(0) { $0 + ($1.outputTokens ?? 0) },
      insertions: chunk.reduce(0) { $0 + ($1.insertions ?? 0) },
      deletions: chunk.reduce(0) { $0 + ($1.deletions ?? 0) },
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

struct WorkUsageActivityCarousel: View {
  @EnvironmentObject private var syncService: SyncService
  @AppStorage("ade.work.usageChart.v1") private var chartRaw = WorkUsageChart.activity.rawValue
  @AppStorage("ade.work.usageRange.v1") private var rangeRaw = WorkUsageRange.week.rawValue
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var stats: MobileAdeUsageStats?
  @State private var loadedRange: String?
  @State private var loading = false
  @State private var direction: CGFloat = 1

  private var chart: WorkUsageChart { WorkUsageChart(rawValue: chartRaw) ?? .activity }
  private var range: WorkUsageRange { WorkUsageRange(rawValue: rangeRaw) ?? .week }
  private var loadKey: String { "\(rangeRaw):\(syncService.connectionState.rawValue)" }

  private var chartHeading: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(chart.title)
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
      Text(chart.detail)
        .font(.caption2)
        .foregroundStyle(ADEColor.textMuted)
        .lineLimit(1)
    }
    .accessibilityElement(children: .combine)
  }

  private var rangeSelector: some View {
    HStack(spacing: 2) {
      ForEach(WorkUsageRange.allCases) { option in
        Button(option.title) { rangeRaw = option.rawValue }
          .font(.caption2.weight(range == option ? .semibold : .medium))
          .foregroundStyle(range == option ? ADEColor.textPrimary : ADEColor.textMuted)
          .frame(minWidth: 44, minHeight: 44)
          .background(
            range == option ? ADEColor.surfaceBackground.opacity(0.92) : .clear,
            in: RoundedRectangle(cornerRadius: 6, style: .continuous)
          )
          .contentShape(Rectangle())
          .buttonStyle(.plain)
          .accessibilityLabel("\(option.title) activity range")
          .accessibilityAddTraits(range == option ? .isSelected : [])
      }
    }
    .padding(2)
    .background(ADEColor.recessedBackground.opacity(0.75), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
  }

  var body: some View {
    VStack(spacing: 8) {
      ViewThatFits(in: .horizontal) {
        HStack(alignment: .top, spacing: 10) {
          chartHeading
          Spacer(minLength: 4)
          rangeSelector
        }

        VStack(alignment: .leading, spacing: 4) {
          chartHeading
          rangeSelector
            .frame(maxWidth: .infinity, alignment: .trailing)
        }
      }

      ZStack {
        Group {
          if let stats, loadedRange == rangeRaw {
            switch chart {
            case .activity: WorkUsageHeatmap(points: stats.daily)
            case .tokens: WorkUsageBars(points: stats.daily, mode: .tokens)
            case .code: WorkUsageBars(points: stats.daily, mode: .code)
            case .clients: WorkUsageClientMix(clients: stats.clients ?? [])
            }
          } else if loading {
            ProgressView().controlSize(.small).tint(ADEColor.purpleAccent)
          } else {
            Text("Activity appears after your first ADE session.")
              .font(.caption2)
              .foregroundStyle(ADEColor.textMuted)
          }
        }
        .id(chart.rawValue)
        .transition(reduceMotion ? .opacity : .asymmetric(
          insertion: .move(edge: direction > 0 ? .trailing : .leading).combined(with: .opacity),
          removal: .move(edge: direction > 0 ? .leading : .trailing).combined(with: .opacity)
        ))
      }
      .frame(height: 76)
      .clipped()

      HStack(spacing: 8) {
        Button { changeChart(by: -1) } label: {
          Image(systemName: "chevron.left")
            .font(.caption.weight(.semibold))
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Previous activity chart")
        Spacer(minLength: 0)
        if loadedRange == rangeRaw, let summary = stats?.summary {
          Text("\(workUsageCompact(summary.totalTokens ?? 0)) tokens")
          Text("·")
          Text("\(workUsageCompact((summary.chatSessions ?? 0) + (summary.terminalSessions ?? 0))) sessions")
          if let activeDays = summary.activeDays, activeDays > 0 {
            Text("·")
            Text("\(activeDays)d active")
          }
        } else {
          Text("Cross-client activity")
        }
        Spacer(minLength: 0)
        Button { changeChart(by: 1) } label: {
          Image(systemName: "chevron.right")
            .font(.caption.weight(.semibold))
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Next activity chart")
      }
      .font(.system(.caption2, design: .monospaced))
      .foregroundStyle(ADEColor.textMuted)
      .overlay(alignment: .top) { Divider().opacity(0.12) }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
    .background {
      RoundedRectangle(cornerRadius: 15, style: .continuous)
        .fill(ADEColor.surfaceBackground.opacity(0.82))
        .overlay(alignment: .topTrailing) {
          Circle()
            .fill(ADEColor.purpleAccent.opacity(0.13))
            .frame(width: 120, height: 120)
            .blur(radius: 30)
            .offset(x: 26, y: -60)
        }
    }
    .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
    .overlay { RoundedRectangle(cornerRadius: 15, style: .continuous).stroke(ADEColor.glassBorder, lineWidth: 0.6) }
    .task(id: loadKey) { await loadStats() }
  }

  private func changeChart(by delta: Int) {
    let cases = WorkUsageChart.allCases
    let next = (chart.rawValue + delta + cases.count) % cases.count
    direction = delta >= 0 ? 1 : -1
    withAnimation(reduceMotion ? .linear(duration: 0.08) : .snappy(duration: 0.28)) {
      chartRaw = next
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
      withAnimation(.easeOut(duration: 0.2)) {
        stats = first
        loadedRange = requestedRange
      }
      loading = false
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

private struct WorkUsageHeatmap: View {
  let points: [MobileAdeUsageDailyPoint]

  var body: some View {
    let buckets = workUsageBuckets(points, maxCount: 70)
    let maximum = max(1, buckets.map(\.activity).max() ?? 1)
    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 3), count: 14), spacing: 3) {
      ForEach(buckets) { bucket in
        RoundedRectangle(cornerRadius: 2, style: .continuous)
          .fill(bucket.activity == 0
            ? ADEColor.textMuted.opacity(0.10)
            : Color.blue.opacity(0.25 + 0.75 * Double(bucket.activity) / Double(maximum)))
          .frame(height: 11)
          .accessibilityLabel("\(bucket.id), \(workUsageCompact(bucket.tokens)) tokens")
      }
    }
    .frame(maxHeight: .infinity, alignment: .center)
  }
}

private enum WorkUsageBarMode { case tokens, code }

private struct WorkUsageBars: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let points: [MobileAdeUsageDailyPoint]
  let mode: WorkUsageBarMode

  var body: some View {
    let buckets = workUsageBuckets(points, maxCount: 36)
    let values = buckets.map { mode == .tokens ? $0.tokens : $0.code }
    let maximum = max(1, values.max() ?? 1)
    GeometryReader { proxy in
      HStack(alignment: .bottom, spacing: 2) {
        ForEach(Array(buckets.enumerated()), id: \.element.id) { index, bucket in
          let primary = mode == .tokens ? bucket.inputTokens : bucket.insertions
          let secondary = mode == .tokens ? bucket.outputTokens : bucket.deletions
          let total = primary + secondary
          let height = total == 0 ? 2 : max(3, proxy.size.height * CGFloat(total) / CGFloat(maximum))
          let split = total == 0 ? 0 : CGFloat(secondary) / CGFloat(total)
          VStack(spacing: 0) {
            RoundedRectangle(cornerRadius: 2, style: .continuous)
              .fill(mode == .tokens ? Color.blue : Color.green)
              .overlay(alignment: .bottom) {
                Rectangle()
                  .fill(mode == .tokens ? ADEColor.purpleAccent : Color.pink)
                  .frame(height: height * split)
              }
          }
          .frame(maxWidth: .infinity)
          .frame(height: height)
          .animation(
            reduceMotion ? nil : .snappy(duration: 0.45).delay(Double(min(index, 24)) * 0.01),
            value: total
          )
        }
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(mode == .tokens ? "AI token flow" : "Code movement")
    .accessibilityValue(mode == .tokens
      ? "\(workUsageCompact(buckets.reduce(0) { $0 + $1.inputTokens })) input and \(workUsageCompact(buckets.reduce(0) { $0 + $1.outputTokens })) output tokens"
      : "\(workUsageCompact(buckets.reduce(0) { $0 + $1.insertions })) additions and \(workUsageCompact(buckets.reduce(0) { $0 + $1.deletions })) deletions")
  }
}

private struct WorkUsageClientMix: View {
  let clients: [MobileAdeUsageClientSummary]
  private let colors: [String: Color] = [
    "desktop": ADEColor.purpleAccent,
    "mobile": Color.pink,
    "tui": Color.green,
    "web": Color.cyan,
    "api": Color.orange,
  ]

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
      Text("Client mix appears as you use ADE across devices.")
        .font(.caption2)
        .foregroundStyle(ADEColor.textMuted)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    } else {
      VStack(spacing: 10) {
        GeometryReader { proxy in
          HStack(spacing: 0) {
            ForEach(visible) { client in
              Rectangle()
                .fill(colors[client.client] ?? Color.orange)
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
              Circle().fill(colors[client.client] ?? Color.orange).frame(width: 6, height: 6)
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
