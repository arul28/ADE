import SwiftUI
import WidgetKit

/// The only ADE system widget. It deliberately compresses the whole workspace
/// into one priority-ranked status instead of spreading state across separate
/// external surfaces.
///
/// Six families, two layouts. The accessory families have room for one fact and
/// exactly one tap target, so they stay single-focus. The home-screen families
/// render the unified row design — state glyph in the phase's tone, title,
/// phase word — with a per-row deep link, an "N more" tail, and one events line
/// for PR/CI traffic. Agent rows stay agent-only; events never become rows.
///
/// Two layouts, so two files: the accessory families live here, the home-screen
/// families in `ADEActivityHomeWidget.swift`, and the status both of them read
/// in `LockScreenPriorityStatus.swift`.
struct ADELockScreenWidget: Widget {
    static let kind = "ADELockScreenWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(
            kind: Self.kind,
            provider: ADEStatusTimelineProvider()
        ) { entry in
            LockScreenWidgetEntryView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("ADE Activity")
        .description("Agents that need you, work in flight, and the latest PR signal.")
        .supportedFamilies([
            .accessoryRectangular,
            .accessoryCircular,
            .accessoryInline,
            .systemSmall,
            .systemMedium,
            .systemLarge,
        ])
    }
}

struct ADEStatusEntry: TimelineEntry {
    let date: Date
    let snapshot: WorkspaceSnapshot
    let attentionSnapshot: AccountAttentionSnapshot?
    let hideDetails: Bool
    /// When this device last wrote the account snapshot. Drives the honest
    /// staleness copy — the widget renders a cache, and how old that cache is
    /// is a fact the reader is entitled to.
    let snapshotFetchedAt: Date?

    init(
        date: Date,
        snapshot: WorkspaceSnapshot,
        attentionSnapshot: AccountAttentionSnapshot? = nil,
        hideDetails: Bool = false,
        snapshotFetchedAt: Date? = nil
    ) {
        self.date = date
        self.snapshot = snapshot
        self.attentionSnapshot = attentionSnapshot
        self.hideDetails = hideDetails
        self.snapshotFetchedAt = snapshotFetchedAt
    }

    var freshness: ActivityWidgetPresentation.Freshness? {
        guard let attentionSnapshot else { return nil }
        return ActivityWidgetPresentation.freshness(
            generatedAt: attentionSnapshot.generatedAt,
            fetchedAt: snapshotFetchedAt,
            now: date
        )
    }
}

struct ADEStatusTimelineProvider: TimelineProvider {
    func placeholder(in context: Context) -> ADEStatusEntry {
        ADEStatusEntry(date: Date(), snapshot: .empty)
    }

    func getSnapshot(in context: Context, completion: @escaping (ADEStatusEntry) -> Void) {
        completion(Self.entry(at: Date()))
    }

    /// Two entries, not one. The first renders what is in the container now;
    /// the second is pre-dated to the moment the snapshot crosses into "aging"
    /// so the widget admits it is behind *without* needing a timeline refresh
    /// it may never be granted. Refreshes come from the app, the push handler
    /// and the background task; this only guarantees the widget never keeps
    /// insisting a stale reading is current.
    func getTimeline(in context: Context, completion: @escaping (Timeline<ADEStatusEntry>) -> Void) {
        let now = Date()
        let first = Self.entry(at: now)
        var entries = [first]
        if let attention = first.attentionSnapshot {
            let anchor = max(
                attention.generatedAt,
                first.snapshotFetchedAt ?? attention.generatedAt
            )
            let agesAt = anchor.addingTimeInterval(ActivityWidgetPresentation.agingThreshold)
            if agesAt > now.addingTimeInterval(60) {
                entries.append(Self.entry(at: agesAt, reusing: first))
            }
        }
        completion(Timeline(entries: entries, policy: .after(now.addingTimeInterval(60))))
    }

    private static func entry(at date: Date) -> ADEStatusEntry {
        ADEStatusEntry(
            date: date,
            snapshot: ADESharedContainer.readWorkspaceSnapshot() ?? .empty,
            attentionSnapshot: ADESharedContainer.readAttentionSnapshot(),
            hideDetails: ADESharedContainer.hideAttentionDetails,
            snapshotFetchedAt: ADESharedContainer.attentionSnapshotFetchedAt
        )
    }

    private static func entry(at date: Date, reusing entry: ADEStatusEntry) -> ADEStatusEntry {
        ADEStatusEntry(
            date: date,
            snapshot: entry.snapshot,
            attentionSnapshot: entry.attentionSnapshot,
            hideDetails: entry.hideDetails,
            snapshotFetchedAt: entry.snapshotFetchedAt
        )
    }
}

struct LockScreenWidgetEntryView: View {
    let entry: ADEStatusEntry
    @Environment(\.widgetFamily) private var family

    /// The account feed, when there is one recent enough to be worth
    /// rendering at all. A day-old snapshot still beats the machine-local
    /// fallback, but it says its age out loud.
    private var accountSnapshot: AccountAttentionSnapshot? {
        guard let account = entry.attentionSnapshot,
              entry.date.timeIntervalSince(account.generatedAt) <= 86_400 else {
            return nil
        }
        return account
    }

    var body: some View {
        let account = accountSnapshot
        let status: LockScreenPriorityStatus = account.map {
            LockScreenPriorityStatus(attentionSnapshot: $0, hideDetails: entry.hideDetails)
        } ?? LockScreenPriorityStatus(snapshot: entry.snapshot, hideDetails: entry.hideDetails)

        switch family {
        case .accessoryRectangular:
            // Accessory families get exactly one tap target from WidgetKit, so
            // the per-row links of the home families are not available here.
            LockScreenRectangularView(status: status, freshness: entry.freshness)
                .widgetURL(status.destinationURL)
                .privacySensitive()
        case .accessoryCircular:
            LockScreenCircularView(status: status)
                .widgetURL(status.destinationURL)
                .privacySensitive()
        case .accessoryInline:
            LockScreenInlineView(status: status)
                .widgetURL(status.destinationURL)
                .privacySensitive()
        default:
            ActivityHomeWidgetView(
                model: ActivityHomeModel(
                    entry: entry,
                    account: account,
                    fallback: status,
                    family: family
                ),
                family: family
            )
            .privacySensitive()
        }
    }
}

// MARK: - Rectangular

/// Two compact session lines plus the metrics tail when the account feed can
/// supply them, and the original single-focus layout when it cannot (the
/// machine-local fallback path, which has no per-item feed).
///
/// The rectangular family is the only one with room for more than one fact, and
/// it used to spend all of it on one row — so a lock screen with four agents
/// running looked identical to one with a single agent.
private struct LockScreenRectangularView: View {
    let status: LockScreenPriorityStatus
    /// `nil` on the machine-local fallback path, which has no account snapshot
    /// whose age could be reported.
    var freshness: ActivityWidgetPresentation.Freshness?
    @Environment(\.isLuminanceReduced) private var isLuminanceReduced

    var body: some View {
        ZStack {
            AccessoryWidgetBackground()
            if status.lines.isEmpty {
                focusLayout
            } else {
                lineLayout
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("ADE status")
        .accessibilityValue(accessibilityValue)
    }

    private var accessibilityValue: String {
        var parts: [String]
        if status.lines.isEmpty {
            parts = ["\(status.title). \(status.detail)"]
        } else {
            parts = status.lines.map { "\($0.title), \($0.phaseLabel)" }
            if status.overflowCount > 0 { parts.append("\(status.overflowCount) more") }
        }
        if let label = freshness?.label { parts.append(label) }
        return parts.joined(separator: ". ")
    }

    /// The tail line: the age when the snapshot is behind, otherwise the
    /// metrics. Age wins the space — a wrong number stated confidently is worse
    /// than one fewer fact.
    @ViewBuilder
    private var tailLine: some View {
        HStack(spacing: 6) {
            if let label = freshness?.label {
                Label(label, systemImage: "clock.arrow.circlepath")
                    .font(.caption2.weight(.semibold))
                    .labelStyle(.titleAndIcon)
                    .lineLimit(1)
                    .foregroundStyle(.secondary)
            } else {
                if status.overflowCount > 0 {
                    Text("+\(status.overflowCount) more")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
                ForEach(status.metrics.prefix(status.overflowCount > 0 ? 1 : 2)) { metric in
                    Label(metric.label, systemImage: metric.symbol)
                        .font(.caption2.weight(.semibold))
                        .labelStyle(.titleAndIcon)
                        .lineLimit(1)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
        }
    }

    private var lineLayout: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(status.lines) { line in
                HStack(spacing: 5) {
                    Image(systemName: line.glyph?.systemImage ?? "circle.fill")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(activityToneColor(line.tone))
                        .widgetAccentable()
                        .accessibilityHidden(true)
                    Text(line.title)
                        .font(.footnote.weight(.semibold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                        .truncationMode(.tail)
                    Spacer(minLength: 4)
                    Text(line.phaseLabel)
                        .font(.system(size: 9, weight: .bold, design: .rounded))
                        .foregroundStyle(activityToneColor(line.tone))
                        .lineLimit(1)
                        .fixedSize()
                        .widgetAccentable()
                }
            }

            tailLine
        }
        .padding(.horizontal, 1)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .opacity(isLuminanceReduced ? 0.85 : 1)
    }

    private var focusLayout: some View {
        Group {
            HStack(spacing: 8) {
                ZStack {
                    Circle()
                        .fill(status.tint.opacity(0.16))
                    Image(systemName: status.symbol)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(status.tint)
                        .contentTransition(.symbolEffect(.replace))
                }
                .frame(width: 30, height: 30)
                .widgetAccentable()

                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 5) {
                        Text(status.title)
                            .font(.footnote.weight(.semibold))
                            .lineLimit(1)
                            .minimumScaleFactor(0.78)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Text(status.shortLabel)
                            .font(.system(size: status.shortLabel.count > 4 ? 7 : 8, weight: .bold, design: .rounded))
                            .foregroundStyle(status.tint)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 2)
                            .background(status.tint.opacity(0.12), in: Capsule())
                            .widgetAccentable()
                    }
                    Text(status.detail)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.78)
                    if !status.metrics.isEmpty {
                        HStack(spacing: 6) {
                            ForEach(status.metrics.prefix(2)) { metric in
                                Label(metric.label, systemImage: metric.symbol)
                                    .font(.caption2.weight(.semibold))
                                    .labelStyle(.titleAndIcon)
                                    .lineLimit(1)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 0)
                        }
                    }
                }
            }
            .padding(.horizontal, 1)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .opacity(isLuminanceReduced ? 0.85 : 1)
        }
    }
}

// MARK: - Circular

private struct LockScreenCircularView: View {
    let status: LockScreenPriorityStatus
    @Environment(\.isLuminanceReduced) private var isLuminanceReduced

    var body: some View {
        ZStack {
            AccessoryWidgetBackground()
            Gauge(value: status.count > 0 ? 0.84 : 0.18, in: 0...1) {
                EmptyView()
            } currentValueLabel: {
                VStack(spacing: -1) {
                    if status.count > 0 {
                        Text("\(min(status.count, 99))")
                            .font(.system(size: status.count >= 10 ? 15 : 18, weight: .black, design: .rounded))
                    } else {
                        Image(systemName: status.symbol)
                            .font(.system(size: 15, weight: .semibold))
                            .contentTransition(.symbolEffect(.replace))
                    }
                    Text(status.shortLabel)
                        .font(.system(size: status.shortLabel.count > 4 ? 6.5 : 7.5, weight: .bold, design: .rounded))
                        .lineLimit(1)
                        .minimumScaleFactor(0.6)
                }
            }
            .gaugeStyle(.accessoryCircular)
            .tint(status.tint)
        }
        .widgetAccentable()
        .opacity(isLuminanceReduced ? 0.85 : 1)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("ADE status")
        .accessibilityValue(status.inlineText)
    }
}

// MARK: - Inline

private struct LockScreenInlineView: View {
    let status: LockScreenPriorityStatus

    var body: some View {
        Label(status.inlineText, systemImage: status.symbol)
            .labelStyle(.titleAndIcon)
            .lineLimit(1)
            .minimumScaleFactor(0.82)
            .accessibilityLabel("ADE")
            .accessibilityValue(status.inlineText)
    }
}

// MARK: - Previews

#if DEBUG

private enum LockScreenPreviewData {
    static let now = Date()

    static func agent(
        id: String,
        title: String,
        status: String,
        awaiting: Bool = false,
        preview: String? = nil,
        minutesAgo: TimeInterval = 1
    ) -> AgentSnapshot {
        AgentSnapshot(
            sessionId: id,
            provider: "codex",
            modelId: "gpt-5-codex",
            laneName: "Primary",
            title: title,
            status: status,
            awaitingInput: awaiting,
            lastActivityAt: now.addingTimeInterval(-minutesAgo * 60),
            elapsedSeconds: Int(minutesAgo * 60),
            preview: preview,
            pendingInputItemId: awaiting ? "approval-\(id)" : nil,
            progress: nil,
            phase: nil,
            toolCalls: 0
        )
    }

    static func pr(
        id: String,
        number: Int,
        title: String,
        checks: String,
        review: String,
        mergeReady: Bool = false
    ) -> PrSnapshot {
        PrSnapshot(
            id: id,
            number: number,
            title: title,
            checks: checks,
            review: review,
            state: "open",
            mergeReady: mergeReady,
            branch: "feature/status-widget",
            updatedAt: now
        )
    }

    static func snapshot(
        agents: [AgentSnapshot] = [],
        prs: [PrSnapshot] = [],
        connection: String = "connected",
        awaitingInputCount: Int = 0,
        idleCount: Int = 0
    ) -> WorkspaceSnapshot {
        WorkspaceSnapshot(
            generatedAt: now,
            agents: agents,
            prs: prs,
            connection: connection,
            awaitingInputCount: awaitingInputCount,
            idleCount: idleCount
        )
    }

    static let waiting = snapshot(
        agents: [
            agent(id: "chat-wait", title: "Release checklist", status: "awaiting_input", awaiting: true),
            agent(id: "chat-run", title: "Fix login bug", status: "running", preview: "editing tests")
        ],
        prs: [pr(id: "pr-625", number: 625, title: "Mobile widget cleanup", checks: "passing", review: "approved", mergeReady: true)],
        awaitingInputCount: 1
    )

    static let failed = snapshot(
        agents: [agent(id: "chat-fail", title: "Pairing regression", status: "failed")]
    )

    static let ciFailing = snapshot(
        agents: [agent(id: "chat-run", title: "Refactor sync", status: "running", preview: "running shard 3")],
        prs: [pr(id: "pr-626", number: 626, title: "Sync reconnect hardening", checks: "failing", review: "pending")]
    )

    static let review = snapshot(
        prs: [pr(id: "pr-627", number: 627, title: "PR detail polish", checks: "passing", review: "changes_requested")]
    )

    static let ready = snapshot(
        prs: [pr(id: "pr-628", number: 628, title: "Ship mobile status", checks: "passing", review: "approved", mergeReady: true)]
    )

    static let running = snapshot(
        agents: [
            agent(id: "chat-a", title: "Implement status widget", status: "running", preview: "building lock screen"),
            agent(id: "chat-b", title: "Audit sync", status: "running", preview: "reading tests", minutesAgo: 2)
        ]
    )

    static let offline = snapshot(connection: "disconnected")
    static let idle = snapshot()
}

@available(iOS 17.0, *)
#Preview("Lock · priority states", as: .accessoryRectangular) {
    ADELockScreenWidget()
} timeline: {
    ADEStatusEntry(date: Date(), snapshot: LockScreenPreviewData.waiting)
    ADEStatusEntry(date: Date(), snapshot: LockScreenPreviewData.failed)
    ADEStatusEntry(date: Date(), snapshot: LockScreenPreviewData.ciFailing)
    ADEStatusEntry(date: Date(), snapshot: LockScreenPreviewData.review)
    ADEStatusEntry(date: Date(), snapshot: LockScreenPreviewData.ready)
    ADEStatusEntry(date: Date(), snapshot: LockScreenPreviewData.running)
    ADEStatusEntry(date: Date(), snapshot: LockScreenPreviewData.offline)
    ADEStatusEntry(date: Date(), snapshot: LockScreenPreviewData.idle)
}

@available(iOS 17.0, *)
#Preview("Lock · circular", as: .accessoryCircular) {
    ADELockScreenWidget()
} timeline: {
    ADEStatusEntry(date: Date(), snapshot: LockScreenPreviewData.waiting)
    ADEStatusEntry(date: Date(), snapshot: LockScreenPreviewData.ciFailing)
    ADEStatusEntry(date: Date(), snapshot: LockScreenPreviewData.running)
    ADEStatusEntry(date: Date(), snapshot: LockScreenPreviewData.offline)
}

@available(iOS 17.0, *)
#Preview("Lock · inline", as: .accessoryInline) {
    ADELockScreenWidget()
} timeline: {
    ADEStatusEntry(date: Date(), snapshot: LockScreenPreviewData.waiting)
    ADEStatusEntry(date: Date(), snapshot: LockScreenPreviewData.ready)
    ADEStatusEntry(date: Date(), snapshot: LockScreenPreviewData.idle)
}

#endif
