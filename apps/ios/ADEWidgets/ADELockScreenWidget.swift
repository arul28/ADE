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
    let attentionSnapshot: AccountAttentionSnapshot?
    let hideDetails: Bool

    init(
        date: Date,
        snapshot: WorkspaceSnapshot,
        attentionSnapshot: AccountAttentionSnapshot? = nil,
        hideDetails: Bool = false
    ) {
        self.date = date
        self.snapshot = snapshot
        self.attentionSnapshot = attentionSnapshot
        self.hideDetails = hideDetails
    }
}

struct ADEStatusTimelineProvider: TimelineProvider {
    func placeholder(in context: Context) -> ADEStatusEntry {
        ADEStatusEntry(date: Date(), snapshot: .empty)
    }

    func getSnapshot(in context: Context, completion: @escaping (ADEStatusEntry) -> Void) {
        let snapshot = ADESharedContainer.readWorkspaceSnapshot() ?? .empty
        completion(ADEStatusEntry(
            date: Date(),
            snapshot: snapshot,
            attentionSnapshot: ADESharedContainer.readAttentionSnapshot(),
            hideDetails: ADESharedContainer.hideAttentionDetails
        ))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<ADEStatusEntry>) -> Void) {
        let now = Date()
        let snapshot = ADESharedContainer.readWorkspaceSnapshot() ?? .empty
        completion(Timeline(
            entries: [
                ADEStatusEntry(
                    date: now,
                    snapshot: snapshot,
                    attentionSnapshot: ADESharedContainer.readAttentionSnapshot(),
                    hideDetails: ADESharedContainer.hideAttentionDetails
                )
            ],
            policy: .after(now.addingTimeInterval(60))
        ))
    }
}

struct LockScreenWidgetEntryView: View {
    let entry: ADEStatusEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        let status: LockScreenPriorityStatus
        if let account = entry.attentionSnapshot,
           Date().timeIntervalSince(account.generatedAt) <= 86_400 {
            status = LockScreenPriorityStatus(
                attentionSnapshot: account,
                hideDetails: entry.hideDetails
            )
        } else {
            status = LockScreenPriorityStatus(
                snapshot: entry.snapshot,
                hideDetails: entry.hideDetails
            )
        }

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
        .privacySensitive()
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
    /// Up to two rows for the rectangular family. Empty on the machine-local
    /// fallback path, which has no per-item feed to list — that path keeps the
    /// single-focus layout.
    let lines: [ActivityWidgetPresentation.CompactLine]
    /// Visible rows the two lines left off.
    let overflowCount: Int

    struct Metric: Identifiable {
        let id: String
        let label: String
        let symbol: String
    }

    init(attentionSnapshot: AccountAttentionSnapshot, hideDetails: Bool = false) {
        let now = Date()
        let visible = ActivityWidgetPresentation.visibleItems(attentionSnapshot.items, now: now)
        let ordered = visible.sorted { lhs, rhs in
            let priority = Self.priority(lhs.phase) - Self.priority(rhs.phase)
            if priority != 0 { return priority < 0 }
            return lhs.updatedAt > rhs.updatedAt
        }
        // The rectangular family lists rows; the circular and inline families
        // still compress everything into the single focus below.
        let lines = ActivityWidgetPresentation.compactLines(
            for: visible,
            hideDetails: hideDetails,
            now: now
        )
        let overflow = ActivityWidgetPresentation.overflowCount(for: visible, now: now)
        // Tapping goes to whatever is actually blocked on the reader, not to
        // whatever happened to sort first.
        let destination = ActivityWidgetPresentation.deepLink(for: visible, now: now)
        // "N need" means N rows are blocked on the reader. It used to count the
        // whole inbox — PR traffic and finished-but-unlooked-at rows included —
        // which made a quiet account read as a demanding one.
        let needsYou = visible.filter { $0.phase == .needsYou }
        let live = visible.filter(\.isLive)
        let machines = Set(visible.map(\.machine.machineKey))
        let onlineMachines = Set(visible.filter(\.machine.online).map(\.machine.machineKey))
        let metrics = [
            needsYou.isEmpty ? nil : Metric(id: "needs", label: "\(needsYou.count) need", symbol: "bell.fill"),
            live.isEmpty ? nil : Metric(id: "live", label: "\(live.count) live", symbol: "waveform.path.ecg"),
            machines.isEmpty ? nil : Metric(
                id: "machines",
                label: machines.count == 1 ? "1 computer" : "\(machines.count) computers",
                symbol: "desktopcomputer"
            ),
        ].compactMap { $0 }

        guard let focus = ordered.first else {
            self = .init(
                kind: .idle,
                title: "ADE idle",
                detail: "No work needs attention",
                inlineText: "ADE · idle",
                count: 0,
                symbol: "moon.zzz.fill",
                shortLabel: "IDLE",
                tint: ADESharedTheme.statusIdle,
                destinationURL: ActivityWidgetPresentation.activityURL,
                metrics: []
            )
            return
        }

        if onlineMachines.isEmpty, !machines.isEmpty {
            self = .init(
                kind: .offline,
                title: hideDetails
                    ? "Computer offline"
                    : (machines.count == 1 ? "\(focus.machine.name) offline" : "\(machines.count) computers offline"),
                detail: hideDetails ? "Open ADE for details" : "Last known work · \(focus.project.name)",
                inlineText: "ADE · offline",
                count: 0,
                symbol: "wifi.slash",
                shortLabel: "OFF",
                tint: ADESharedTheme.statusIdle,
                destinationURL: destination,
                metrics: metrics,
                lines: lines,
                overflowCount: overflow
            )
            return
        }

        let presentation = Self.presentation(for: focus.phase)
        let scope = "\(focus.machine.name) · \(focus.project.name)"
        let attentionCount = needsYou.count
        let ambientCount = visible.count
        let privateTitle = focus.privacyPreview
            .trimmingCharacters(in: .whitespacesAndNewlines)
        self = .init(
            kind: presentation.kind,
            title: hideDetails
                ? (privateTitle.isEmpty ? "Activity update" : privateTitle)
                : focus.title,
            detail: hideDetails ? "Across your signed-in machines" : scope,
            inlineText: attentionCount > 0
                ? "ADE · \(attentionCount) need you"
                : live.isEmpty
                    ? "ADE · \(ambientCount) recent"
                    : "ADE · \(live.count) live",
            count: attentionCount > 0
                ? attentionCount
                : (live.isEmpty ? ambientCount : live.count),
            symbol: presentation.symbol,
            shortLabel: presentation.label,
            tint: presentation.tint,
            destinationURL: destination,
            metrics: metrics,
            lines: lines,
            overflowCount: overflow
        )
    }

    init(snapshot: WorkspaceSnapshot, hideDetails: Bool = false) {
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
        let snapshotAge = Date().timeIntervalSince(snapshot.generatedAt)
        let isStale = snapshot.generatedAt.timeIntervalSince1970 > 0 && snapshotAge > 90

        let metrics = Self.metrics(
            runningCount: running.count,
            waitingCount: waitingCount,
            openPrCount: openPrs.count,
            idleCount: idleCount
        )

        if isStale {
            let machine = snapshot.machineName?.trimmingCharacters(in: .whitespacesAndNewlines)
            let minutes = max(1, Int(snapshotAge / 60))
            self = .init(
                kind: .offline,
                title: hideDetails
                    ? "Computer offline"
                    : "\((machine?.isEmpty == false ? machine : nil) ?? "Computer") offline",
                detail: minutes == 1 ? "Last update 1 minute ago" : "Last update \(minutes) minutes ago",
                inlineText: "ADE · offline \(minutes)m",
                count: 0,
                symbol: "wifi.slash",
                shortLabel: "OFF",
                tint: ADESharedTheme.statusIdle,
                destinationURL: Self.workspaceURL,
                metrics: metrics
            )
        } else if waitingCount > 0 {
            let first = awaiting.first
            self = .init(
                kind: .awaitingInput,
                title: waitingCount == 1 ? "1 chat waiting" : "\(waitingCount) chats waiting",
                detail: hideDetails
                    ? "Open ADE to reply or approve"
                    : (first.map { Self.agentTitle($0) } ?? "Reply or approve in ADE"),
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
                detail: hideDetails ? "Open ADE for details" : Self.agentTitle(first),
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
                detail: hideDetails ? "Open ADE for details" : Self.prTitle(first),
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
                detail: hideDetails ? "Open ADE for details" : Self.prTitle(first),
                inlineText: "ADE · \(reviewRequested.count) review",
                count: reviewRequested.count,
                symbol: "eye.fill",
                shortLabel: "REV",
                tint: changes > 0 ? ADESharedTheme.statusFailed : ADESharedTheme.statusReview,
                destinationURL: Self.prURL(first),
                metrics: metrics
            )
        } else if let first = mergeReady.first {
            self = .init(
                kind: .mergeReady,
                title: mergeReady.count == 1 ? "Ready to merge" : "\(mergeReady.count) PRs ready",
                detail: hideDetails ? "Open ADE for details" : Self.prTitle(first),
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
                title: running.count == 1 ? "1 agent working" : "\(running.count) agents working",
                detail: hideDetails ? "Agent work is in progress" : Self.runningDetail(first),
                inlineText: "ADE · \(running.count) working",
                count: running.count,
                symbol: "circle.dotted",
                shortLabel: "WORK",
                tint: ADESharedTheme.statusRunning,
                destinationURL: Self.sessionURL(first.sessionId),
                metrics: metrics
            )
        } else if let first = openPrs.first {
            self = .init(
                kind: .openPullRequests,
                title: openPrs.count == 1 ? "1 open PR" : "\(openPrs.count) open PRs",
                detail: hideDetails ? "Open ADE for details" : Self.prTitle(first),
                inlineText: "ADE · \(openPrs.count) PRs",
                count: openPrs.count,
                symbol: "arrow.triangle.pull",
                shortLabel: "PR",
                tint: ADESharedTheme.statusRunning,
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
                // Neutral, not amber. A sync in flight is true but not
                // actionable — nobody is being asked for anything — and amber
                // is spent only on "your move".
                tint: ADESharedTheme.statusIdle,
                destinationURL: Self.workspaceURL,
                metrics: metrics
            )
        } else if snapshot.connection.lowercased() == "disconnected" {
            self = .init(
                kind: .offline,
                title: "Computer offline",
                detail: "Reconnect to update agents and PRs",
                inlineText: "ADE · offline",
                count: 0,
                symbol: "wifi.slash",
                shortLabel: "OFF",
                // Neutral, like the other two "Mac offline" branches above.
                // Red is the alarm hue and now means only "it broke" — a host
                // that is simply not reachable is true, but it is not a
                // failure, and three offline states in one widget wearing two
                // different colours is exactly how a hue stops meaning
                // anything.
                tint: ADESharedTheme.statusIdle,
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
        metrics: [Metric],
        lines: [ActivityWidgetPresentation.CompactLine] = [],
        overflowCount: Int = 0
    ) {
        self.lines = lines
        self.overflowCount = overflowCount
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
            result.append(.init(id: "running", label: "\(runningCount) working", symbol: "circle.dotted"))
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

    private static func priority(_ phase: AccountAttentionPhase) -> Int {
        switch phase {
        case .needsYou: return 0
        case .failed, .checksFailing, .changesRequested: return 1
        case .reviewRequested, .mergeReady, .blocked: return 2
        case .starting, .running: return 3
        case .open, .stale: return 4
        case .completed, .merged: return 5
        case .closed: return 6
        case .unrecognized: return 7
        }
    }

    /// Glyph / label / hue for the focus row. Amber appears exactly once here,
    /// on `.needsYou`, and that is the whole rule (see `AgentRunPhase` and the
    /// desktop's `sessionStatusPresentation`).
    private static func presentation(
        for phase: AccountAttentionPhase
    ) -> (kind: Kind, symbol: String, label: String, tint: Color) {
        switch phase {
        case .needsYou:
            return (.awaitingInput, "bell.badge.fill", "YOU", ADESharedTheme.warningAmber)
        // Blocked is neutral, not amber: `AccountAttentionItem.needsInbox`
        // deliberately excludes it, so it never reaches the inbox and is not
        // the user's move. Painting it amber made "go act" and "waiting on
        // something else" the same colour.
        case .blocked:
            return (.idle, "hourglass", "HOLD", ADESharedTheme.statusIdle)
        case .failed:
            return (.failed, "xmark.octagon.fill", "FAIL", ADESharedTheme.statusFailed)
        case .checksFailing, .changesRequested:
            return (.ciFailing, "exclamationmark.triangle.fill", "CHECK", ADESharedTheme.statusFailed)
        case .reviewRequested:
            return (.reviewRequested, "eye.fill", "REV", ADESharedTheme.statusReview)
        case .mergeReady:
            return (.mergeReady, "checkmark.seal.fill", "READY", ADESharedTheme.statusSuccess)
        case .starting, .running:
            // Same dashed-circle glyph the snapshot path and the desktop
            // sidebar use for work in flight; the widget used to show a
            // heartbeat trace here and a dotted circle two branches down.
            return (.running, "circle.dotted", "WORK", ADESharedTheme.statusRunning)
        case .open:
            return (.idle, "arrow.triangle.pull", "OPEN", ADESharedTheme.statusRunning)
        // Stale is a silence, not a disconnection: the run is alive and has
        // said nothing for hours. A clock asks "how long?", which is the
        // question the row actually raises; `wifi.slash` sent people to check
        // their network.
        case .stale:
            return (.idle, "clock.badge.exclamationmark", "STALE", ADESharedTheme.statusIdle)
        case .completed:
            return (.idle, "checkmark.circle.fill", "DONE", ADESharedTheme.statusSuccess)
        case .merged:
            return (.idle, "arrow.triangle.merge", "MERGED", ADESharedTheme.statusSuccess)
        case .closed:
            return (.idle, "xmark.circle.fill", "CLOSED", ADESharedTheme.statusIdle)
        case .unrecognized:
            return (.idle, "questionmark.circle", "UNKNOWN", ADESharedTheme.statusIdle)
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
        guard !status.lines.isEmpty else { return "\(status.title). \(status.detail)" }
        var parts = status.lines.map { "\($0.title), \($0.phaseLabel)" }
        if status.overflowCount > 0 { parts.append("\(status.overflowCount) more") }
        return parts.joined(separator: ". ")
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

            HStack(spacing: 6) {
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
                Spacer(minLength: 0)
            }
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
