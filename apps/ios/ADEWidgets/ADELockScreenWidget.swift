import SwiftUI
import WidgetKit

/// The only ADE system widget. It deliberately compresses the whole workspace
/// into one priority-ranked status instead of spreading state across separate
/// external surfaces.
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
        .configurationDisplayName("ADE Status")
        .description("The most important ADE agent or PR status on your Lock Screen.")
        .supportedFamilies([.accessoryRectangular, .accessoryCircular, .accessoryInline])
    }
}

struct ADEStatusEntry: TimelineEntry {
    let date: Date
    let snapshot: WorkspaceSnapshot
}

struct ADEStatusTimelineProvider: TimelineProvider {
    func placeholder(in context: Context) -> ADEStatusEntry {
        ADEStatusEntry(date: Date(), snapshot: .empty)
    }

    func getSnapshot(in context: Context, completion: @escaping (ADEStatusEntry) -> Void) {
        let snapshot = ADESharedContainer.readWorkspaceSnapshot() ?? .empty
        completion(ADEStatusEntry(date: Date(), snapshot: snapshot))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<ADEStatusEntry>) -> Void) {
        let now = Date()
        let snapshot = ADESharedContainer.readWorkspaceSnapshot() ?? .empty
        completion(Timeline(entries: [ADEStatusEntry(date: now, snapshot: snapshot)], policy: .after(now.addingTimeInterval(60))))
    }
}

struct LockScreenWidgetEntryView: View {
    let entry: ADEStatusEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        let status = LockScreenPriorityStatus(snapshot: entry.snapshot)

        return Group {
            switch family {
            case .accessoryRectangular:
                LockScreenRectangularView(status: status)
            case .accessoryCircular:
                LockScreenCircularView(status: status)
            case .accessoryInline:
                LockScreenInlineView(status: status)
            default:
                LockScreenInlineView(status: status)
            }
        }
        .widgetURL(status.destinationURL)
    }
}

// MARK: - Priority model

private struct LockScreenPriorityStatus {
    enum Kind {
        case awaitingInput
        case failed
        case ciFailing
        case reviewRequested
        case mergeReady
        case running
        case openPullRequests
        case syncing
        case offline
        case idle
    }

    let kind: Kind
    let title: String
    let detail: String
    let inlineText: String
    let count: Int
    let symbol: String
    let shortLabel: String
    let tint: Color
    let destinationURL: URL
    let metrics: [Metric]

    struct Metric: Identifiable {
        let id: String
        let label: String
        let symbol: String
    }

    init(snapshot: WorkspaceSnapshot) {
        let running = snapshot.runningAgents.sorted { $0.lastActivityAt > $1.lastActivityAt }
        let awaiting = snapshot.agents.filter { agent in
            agent.awaitingInput || agent.status.lowercased() == "awaiting_input"
        }
        let failed = snapshot.agents.filter { agent in
            let status = agent.status.lowercased()
            return status == "failed" || status == "error"
        }.sorted { $0.lastActivityAt > $1.lastActivityAt }
        let openPrs = snapshot.prs.filter { $0.state == "open" }
        let ciFailing = openPrs.filter { $0.checks == "failing" }
        let reviewRequested = openPrs.filter {
            $0.review == "changes_requested" || $0.review == "pending"
        }
        let mergeReady = openPrs.filter {
            $0.mergeReady && $0.checks == "passing" && $0.review == "approved"
        }
        let waitingCount = max(snapshot.awaitingInputCount, awaiting.count)
        let idleCount = snapshot.idleCount

        let metrics = Self.metrics(
            runningCount: running.count,
            waitingCount: waitingCount,
            openPrCount: openPrs.count,
            idleCount: idleCount
        )

        if waitingCount > 0 {
            let first = awaiting.first
            self = .init(
                kind: .awaitingInput,
                title: waitingCount == 1 ? "1 chat waiting" : "\(waitingCount) chats waiting",
                detail: first.map { Self.agentTitle($0) } ?? "Reply or approve in ADE",
                inlineText: "ADE · \(waitingCount) waiting",
                count: waitingCount,
                symbol: "bell.badge.fill",
                shortLabel: "WAIT",
                tint: ADESharedTheme.warningAmber,
                destinationURL: Self.sessionURL(first?.sessionId),
                metrics: metrics
            )
        } else if let first = failed.first {
            self = .init(
                kind: .failed,
                title: failed.count == 1 ? "Agent failed" : "\(failed.count) agents failed",
                detail: Self.agentTitle(first),
                inlineText: "ADE · \(failed.count) failed",
                count: failed.count,
                symbol: "xmark.octagon.fill",
                shortLabel: "FAIL",
                tint: ADESharedTheme.statusFailed,
                destinationURL: Self.sessionURL(first.sessionId),
                metrics: metrics
            )
        } else if let first = ciFailing.first {
            self = .init(
                kind: .ciFailing,
                title: ciFailing.count == 1 ? "CI failing" : "\(ciFailing.count) PRs failing",
                detail: Self.prTitle(first),
                inlineText: "ADE · \(ciFailing.count) CI failing",
                count: ciFailing.count,
                symbol: "exclamationmark.triangle.fill",
                shortLabel: "CI",
                tint: ADESharedTheme.statusFailed,
                destinationURL: Self.prURL(first),
                metrics: metrics
            )
        } else if let first = reviewRequested.first {
            let changes = reviewRequested.filter { $0.review == "changes_requested" }.count
            let title = changes > 0
                ? (changes == 1 ? "Changes requested" : "\(changes) PRs need changes")
                : (reviewRequested.count == 1 ? "Review requested" : "\(reviewRequested.count) reviews waiting")
            self = .init(
                kind: .reviewRequested,
                title: title,
                detail: Self.prTitle(first),
                inlineText: "ADE · \(reviewRequested.count) review",
                count: reviewRequested.count,
                symbol: "eye.fill",
                shortLabel: "REV",
                tint: ADESharedTheme.warningAmber,
                destinationURL: Self.prURL(first),
                metrics: metrics
            )
        } else if let first = mergeReady.first {
            self = .init(
                kind: .mergeReady,
                title: mergeReady.count == 1 ? "Ready to merge" : "\(mergeReady.count) PRs ready",
                detail: Self.prTitle(first),
                inlineText: "ADE · \(mergeReady.count) ready",
                count: mergeReady.count,
                symbol: "checkmark.seal.fill",
                shortLabel: "READY",
                tint: ADESharedTheme.statusSuccess,
                destinationURL: Self.prURL(first),
                metrics: metrics
            )
        } else if let first = running.first {
            self = .init(
                kind: .running,
                title: running.count == 1 ? "1 agent running" : "\(running.count) agents running",
                detail: Self.runningDetail(first),
                inlineText: "ADE · \(running.count) running",
                count: running.count,
                symbol: "circle.dotted",
                shortLabel: "RUN",
                tint: ADESharedTheme.statusSuccess,
                destinationURL: Self.sessionURL(first.sessionId),
                metrics: metrics
            )
        } else if let first = openPrs.first {
            self = .init(
                kind: .openPullRequests,
                title: openPrs.count == 1 ? "1 open PR" : "\(openPrs.count) open PRs",
                detail: Self.prTitle(first),
                inlineText: "ADE · \(openPrs.count) PRs",
                count: openPrs.count,
                symbol: "arrow.triangle.pull",
                shortLabel: "PR",
                tint: ADESharedTheme.brandCursor,
                destinationURL: Self.prURL(first),
                metrics: metrics
            )
        } else if snapshot.connection.lowercased() == "syncing" {
            self = .init(
                kind: .syncing,
                title: "Syncing",
                detail: "Refreshing ADE state",
                inlineText: "ADE · syncing",
                count: 0,
                symbol: "arrow.triangle.2.circlepath",
                shortLabel: "SYNC",
                tint: ADESharedTheme.statusAttention,
                destinationURL: Self.workspaceURL,
                metrics: metrics
            )
        } else if snapshot.connection.lowercased() == "disconnected" {
            self = .init(
                kind: .offline,
                title: "Mac offline",
                detail: "Reconnect to update agents and PRs",
                inlineText: "ADE · offline",
                count: 0,
                symbol: "wifi.slash",
                shortLabel: "OFF",
                tint: ADESharedTheme.statusFailed,
                destinationURL: Self.workspaceURL,
                metrics: metrics
            )
        } else {
            self = .init(
                kind: .idle,
                title: "ADE idle",
                detail: "No agents or PRs need attention",
                inlineText: "ADE · idle",
                count: 0,
                symbol: "moon.zzz.fill",
                shortLabel: "IDLE",
                tint: ADESharedTheme.statusIdle,
                destinationURL: Self.workspaceURL,
                metrics: metrics
            )
        }
    }

    private init(
        kind: Kind,
        title: String,
        detail: String,
        inlineText: String,
        count: Int,
        symbol: String,
        shortLabel: String,
        tint: Color,
        destinationURL: URL,
        metrics: [Metric]
    ) {
        self.kind = kind
        self.title = title
        self.detail = detail
        self.inlineText = inlineText
        self.count = count
        self.symbol = symbol
        self.shortLabel = shortLabel
        self.tint = tint
        self.destinationURL = destinationURL
        self.metrics = metrics
    }

    private static let workspaceURL = URL(string: "ade://workspace") ?? URL(fileURLWithPath: "/")
    private static let deepLinkPathAllowed: CharacterSet = {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return allowed
    }()

    private static func sessionURL(_ sessionId: String?) -> URL {
        guard let sessionId = sessionId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !sessionId.isEmpty,
              let encoded = sessionId.addingPercentEncoding(withAllowedCharacters: deepLinkPathAllowed),
              let url = URL(string: "ade://session/\(encoded)") else {
            return workspaceURL
        }
        return url
    }

    private static func prURL(_ pr: PrSnapshot) -> URL {
        URL(string: "ade://pr/\(pr.number)") ?? workspaceURL
    }

    private static func agentTitle(_ agent: AgentSnapshot) -> String {
        let title = agent.title?.trimmingCharacters(in: .whitespacesAndNewlines)
        return title?.isEmpty == false ? title! : agent.sessionId
    }

    private static func runningDetail(_ agent: AgentSnapshot) -> String {
        let model = agent.modelId?.trimmingCharacters(in: .whitespacesAndNewlines)
        let label = model?.isEmpty == false ? model! : agent.provider.lowercased()
        let preview = agent.preview?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let preview, !preview.isEmpty {
            return "\(label) · \(preview)"
        }
        return "\(label) · working"
    }

    private static func prTitle(_ pr: PrSnapshot) -> String {
        "#\(pr.number) · \(pr.title)"
    }

    private static func metrics(
        runningCount: Int,
        waitingCount: Int,
        openPrCount: Int,
        idleCount: Int
    ) -> [Metric] {
        var result: [Metric] = []
        if runningCount > 0 {
            result.append(.init(id: "running", label: "\(runningCount) run", symbol: "circle.dotted"))
        }
        if waitingCount > 0 {
            result.append(.init(id: "waiting", label: "\(waitingCount) wait", symbol: "bell.fill"))
        }
        if openPrCount > 0 {
            result.append(.init(id: "prs", label: "\(openPrCount) PR", symbol: "arrow.triangle.pull"))
        }
        if result.isEmpty && idleCount > 0 {
            result.append(.init(id: "idle", label: "\(idleCount) idle", symbol: "moon.zzz.fill"))
        }
        return Array(result.prefix(3))
    }
}

// MARK: - Rectangular

private struct LockScreenRectangularView: View {
    let status: LockScreenPriorityStatus
    @Environment(\.isLuminanceReduced) private var isLuminanceReduced

    var body: some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Image(systemName: status.symbol)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(status.tint)
                        .widgetAccentable()
                        .frame(width: 14, alignment: .center)
                    Text(status.title)
                        .font(.system(size: 13, weight: .semibold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.82)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                Text(status.detail)
                    .font(.system(size: 10.5, weight: .regular))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.82)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if !status.metrics.isEmpty {
                    HStack(spacing: 5) {
                        ForEach(status.metrics) { metric in
                            Label(metric.label, systemImage: metric.symbol)
                                .font(.system(size: 9, weight: .semibold))
                                .labelStyle(.titleAndIcon)
                                .lineLimit(1)
                                .minimumScaleFactor(0.8)
                                .foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 0)
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .opacity(isLuminanceReduced ? 0.85 : 1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("ADE status")
        .accessibilityValue("\(status.title). \(status.detail)")
    }
}

// MARK: - Circular

private struct LockScreenCircularView: View {
    let status: LockScreenPriorityStatus
    @Environment(\.isLuminanceReduced) private var isLuminanceReduced

    var body: some View {
        Group {
            if status.count > 0 {
                Gauge(value: 1, in: 0...1) {
                    EmptyView()
                } currentValueLabel: {
                    VStack(spacing: -1) {
                        Text("\(min(status.count, 99))")
                            .font(.system(size: status.count >= 10 ? 16 : 20, weight: .black))
                            .minimumScaleFactor(0.7)
                            .lineLimit(1)
                        Text(status.shortLabel)
                            .font(.system(size: status.shortLabel.count > 4 ? 7 : 8, weight: .semibold))
                            .lineLimit(1)
                            .minimumScaleFactor(0.65)
                    }
                }
                .gaugeStyle(.accessoryCircular)
            } else {
                ZStack {
                    AccessoryWidgetBackground()
                    Image(systemName: status.symbol)
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(status.tint)
                }
            }
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
        Text(status.inlineText)
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
