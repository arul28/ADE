import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

/// Live Activity surface for the "agent runs" activity. Lock-screen / banner
/// presentation plus Dynamic Island. Visual language matches
/// `ADELockScreenWidget`: phase-tinted status glyphs, tight typography, calm
/// restraint — no chrome that doesn't carry state.
struct ADEAgentActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: ADEAgentRunsAttributes.self) { context in
            AgentRunsLockScreenView(
                presentation: AgentRunsPresentation(
                    state: context.state,
                    attributes: context.attributes,
                    isStale: context.isStale
                )
            )
            .activityBackgroundTint(Color.black.opacity(0.28))
            .activitySystemActionForegroundColor(.primary)
            .privacySensitive()
        } dynamicIsland: { context in
            let presentation = AgentRunsPresentation(
                state: context.state,
                attributes: context.attributes,
                isStale: context.isStale
            )
            // Long-press expansion is iOS's stand-in for the mac's hover
            // reveal; there is no mode UI here because island visibility is
            // the OS's decision, not ours. Agents | Events tabs do not fit in
            // this height — events ride the single signal line at the bottom.
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    AgentRunsStateStrip(presentation: presentation)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    AgentRunsCountBadge(presentation: presentation)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 5) {
                        ForEach(presentation.expandedRuns) { run in
                            AgentRunRow(
                                run: run,
                                compact: true,
                                hideDetails: presentation.hideDetails
                            )
                        }
                        if presentation.expandedRuns.isEmpty, let pr = presentation.primaryPr {
                            PullRequestActivityRow(
                                pr: pr,
                                compact: true,
                                hideDetails: presentation.hideDetails
                            )
                        }
                        HStack(spacing: 6) {
                            if presentation.overflowCount > 0 {
                                Link(destination: AgentRunsPresentation.activityURL) {
                                    Text(
                                        presentation.overflowCount == 1
                                            ? "1 more"
                                            : "\(presentation.overflowCount) more"
                                    )
                                    .font(.system(size: 9.5, weight: .semibold))
                                    .foregroundStyle(.secondary)
                                }
                            }
                            if presentation.isStale {
                                AgentRunsStaleHint()
                            }
                            Spacer(minLength: 0)
                            if let machine = presentation.machineFooter {
                                Text(machine)
                                    .font(.system(size: 9.5, weight: .medium))
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                        }
                        if let signal = presentation.eventSignal {
                            AgentRunsSignalLine(signal: signal)
                        }
                    }
                    .padding(.horizontal, 4)
                    .privacySensitive()
                }
            } compactLeading: {
                // The mac notch's left wing, in the space of one glyph: the
                // highest-priority state and how many rows are in it. This used
                // to be a generic mesh icon, which said only "ADE is running".
                AgentRunsCompactLeading(presentation: presentation)
            } compactTrailing: {
                // The notch's right-wing signal slot. Falls back to the total
                // when there is no event worth the space — never to a bare
                // number that could mean any of five things.
                AgentRunsCompactTrailing(presentation: presentation)
            } minimal: {
                Image(systemName: presentation.leadGlyph.systemImage)
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(presentation.tint)
                    .accessibilityLabel(presentation.minimalAccessibilityLabel)
            }
            .widgetURL(presentation.destinationURL)
            .keylineTint(presentation.tint)
        }
    }
}

// MARK: - Presentation model

struct AgentRunsPresentation {
    let runs: [ADEAgentRunsAttributes.Run]
    let prs: [ADEAgentRunsAttributes.PullRequest]
    let activeCount: Int
    let waitingCount: Int
    let primary: ADEAgentRunsAttributes.Run?
    let primaryPr: ADEAgentRunsAttributes.PullRequest?
    let secondaryRuns: [ADEAgentRunsAttributes.Run]
    let overflowCount: Int
    let isStale: Bool
    let machineName: String
    let accountWide: Bool
    let ownershipAccepted: Bool
    let hideDetails: Bool
    /// Nonzero state buckets, in display order — the mac notch strip's content.
    /// Publisher-supplied when the payload carries `groups`, otherwise counted
    /// from the visible roster (which undercounts, and says so by never
    /// claiming more than it can see).
    let groups: [ActivityWidgetPresentation.GroupCount]
    /// Rows the expanded view renders. ~3 fit; the rest become "N more".
    let expandedRuns: [ADEAgentRunsAttributes.Run]

    /// Where "N more" and the minimal glyph go when there is no better target.
    static let activityURL = URL(string: "ade://activity") ?? URL(fileURLWithPath: "/")

    init(state: ADEAgentRunsAttributes.ContentState, attributes: ADEAgentRunsAttributes, isStale: Bool) {
        let accountWide = attributes.isAccountWide
        let ownership = ADESharedContainer.readAccountDeviceOwnershipState()
        let ownershipAccepted = !accountWide
            || adeAccountWideActivityMatchesCurrentOwnership(
                attributesEpoch: attributes.ownershipEpoch,
                contentEpoch: state.ownershipEpoch,
                currentEpoch: ownership?.ownershipEpoch,
                hasCurrentOwner: ownership?.ownerId != nil
            )
        let safeState = ownershipAccepted
            ? state
            : ADEAgentRunsAttributes.ContentState(
                updatedAt: state.updatedAt,
                activeCount: 0,
                runs: [],
                prs: [],
                ownershipEpoch: state.ownershipEpoch
            )
        // Match the original T3 Code activity hierarchy: user-blocked work,
        // failures, in-flight work, then outcomes. PR attention participates in
        // the same focus decision instead of being hidden behind a running run.
        let sorted = safeState.runs.sorted { lhs, rhs in
            Self.priority(lhs.resolvedPhase) < Self.priority(rhs.resolvedPhase)
        }
        self.runs = sorted
        let sortedPrs = Array(safeState.prs.sorted { lhs, rhs in
            let l = Self.priority(lhs.resolvedPhase)
            let r = Self.priority(rhs.resolvedPhase)
            if l != r { return l < r }
            return lhs.updatedAt > rhs.updatedAt
        })
        self.prs = sortedPrs
        let visibleInFlightCount = safeState.runs.filter {
            $0.resolvedPhase == .starting || $0.resolvedPhase == .running
        }.count
        // `activeCount` may include runs omitted from the compact roster. Keep
        // that hidden remainder, but do not let completed/failed roster rows
        // inflate the live count and headline themselves as still working.
        let hiddenActiveCount = max(0, safeState.activeCount - safeState.runs.count)
        let activeCount = hiddenActiveCount + visibleInFlightCount
        self.activeCount = activeCount
        self.waitingCount = safeState.runs.filter { $0.resolvedPhase.needsAttention }.count
            + safeState.prs.filter { $0.resolvedPhase.needsAttention }.count

        let attentionRun = sorted.first(where: { $0.resolvedPhase.needsAttention })
        let attentionPr = sortedPrs.first(where: { $0.resolvedPhase.needsAttention })
        let primary: ADEAgentRunsAttributes.Run?
        let primaryPr: ADEAgentRunsAttributes.PullRequest?
        if let attentionRun {
            primary = attentionRun
            primaryPr = nil
        } else if let attentionPr {
            primary = nil
            primaryPr = attentionPr
        } else if let first = sorted.first {
            primary = first
            primaryPr = nil
        } else {
            primary = nil
            primaryPr = sortedPrs.first
        }
        self.primary = primary
        self.primaryPr = primaryPr

        // Keep the chosen presentation values local until every dependent
        // value is resolved; closures that touch `self` here capture stored
        // properties that have not all been initialized yet.
        let remainingRuns = sorted.filter { $0.id != primary?.id }
        let secondaryRuns = Array(remainingRuns.prefix(2))
        self.secondaryRuns = secondaryRuns
        let expandedRuns = Array(sorted.prefix(3))
        self.expandedRuns = expandedRuns

        // State buckets. Prefer the publisher's account-wide tally; it is the
        // only source that can see past the three-row roster cap.
        if let published = safeState.resolvedGroups {
            self.groups = published.map {
                ActivityWidgetPresentation.GroupCount(group: $0.group, count: $0.count)
            }
        } else {
            var tally: [ActivityStateGroup: Int] = [:]
            for run in sorted {
                tally[run.resolvedPhase.stateGroup, default: 0] += 1
            }
            // Runs the roster omitted are in flight by construction.
            if hiddenActiveCount > 0 {
                tally[.working, default: 0] += hiddenActiveCount
            }
            self.groups = tally
                .map { ActivityWidgetPresentation.GroupCount(group: $0.key, count: $0.value) }
                .sorted { $0.group.rank < $1.group.rank }
        }

        // Events are a signal line, never rows — so "N more" counts agent rows
        // only. It used to add `prs.count` to `activeCount` and subtract the
        // rendered rows, which promised chats that were actually pull requests.
        let totalRuns = max(safeState.runs.count + hiddenActiveCount, activeCount)
        self.overflowCount = safeState.moreCount
            ?? max(0, totalRuns - expandedRuns.count)
        // ActivityKit push staleness only. A run whose *phase* is `.stale` used
        // to fold in here, which greyed the whole glance and showed
        // "Reconnecting" because a single agent had gone quiet — a silence, not
        // a transport failure. The stale run says so on its own row.
        self.isStale = ownershipAccepted && isStale
        self.machineName = ownershipAccepted ? attributes.machineName : "ADE"
        self.accountWide = accountWide
        self.ownershipAccepted = ownershipAccepted
        self.hideDetails = !ownershipAccepted || ADESharedContainer.hideAttentionDetails
    }

    /// Tint of the glance — attention amber wins, otherwise the primary run's
    /// phase color, dimmed toward idle when the push feed itself is stale.
    ///
    /// Amber is checked first, and deliberately outranks staleness: "your move"
    /// is the one thing the glance may never swallow, and a late push does not
    /// make a raised hand less true.
    var tint: Color {
        if waitingCount > 0 { return ADESharedTheme.warningAmber }
        // The lead bucket, which on a publisher-supplied tally can be
        // `needsYou` even when no *visible* roster row is — the roster is
        // capped at three and a raised hand may be sitting behind the cap.
        if let leadGroup, leadGroup.group == .needsYou {
            return activityToneColor(leadGroup.group.tone)
        }
        if isStale { return ADESharedTheme.statusIdle }
        if let leadGroup { return activityToneColor(leadGroup.group.tone) }
        if let primaryPr, primary == nil { return primaryPr.resolvedPhase.tint }
        return primary?.resolvedPhase.tint ?? ADESharedTheme.statusIdle
    }

    /// Everything the activity is currently tracking. Only used where a single
    /// number is genuinely the right answer — the compact trailing's fallback
    /// and the expanded count badge.
    var glanceCount: Int {
        groups.reduce(0) { $0 + $1.count } + prs.count
    }

    // MARK: - Notch mapping

    /// The bucket the compact leading speaks for.
    var leadGroup: ActivityWidgetPresentation.GroupCount? { groups.first }

    var leadGlyph: ActivityGlyph { leadGroup?.group.glyph ?? .working }

    /// One glyph plus one count. Together they say *what* and *how many*, which
    /// is the whole job of the left wing — a bare "3" said neither.
    var leadCountLabel: String? {
        guard let leadGroup, leadGroup.count > 0 else { return nil }
        return "\(min(leadGroup.count, 99))"
    }

    var minimalAccessibilityLabel: String {
        guard let leadGroup else { return "ADE" }
        return "\(leadGroup.count) \(leadGroup.group.label)"
    }

    /// The one event worth the right wing, mirroring the notch's signal slot.
    struct EventSignal {
        let label: String
        let glyph: ActivityGlyph?
        let symbol: String
        let tint: Color
        let moreCount: Int
        let url: URL?
    }

    var eventSignal: EventSignal? {
        guard ownershipAccepted, let top = prs.first else { return nil }
        let phase = top.resolvedPhase
        let label = hideDetails
            ? phase.label
            : (top.prNumber > 0 ? "#\(top.prNumber) \(phase.label.lowercased())" : phase.label)
        return EventSignal(
            label: label,
            glyph: phase.glyph,
            symbol: phase.symbol,
            tint: phase.tint,
            moreCount: max(0, prs.count - 1),
            url: top.deepLinkURL
        )
    }

    /// Footer only earns its space when there's more than one run or a machine
    /// name worth showing.
    var machineFooter: String? {
        if !ownershipAccepted { return "ADE" }
        if hideDetails { return "ADE" }
        let trimmed = machineName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if activeCount > runs.count {
            return "\(trimmed) · \(activeCount) working"
        }
        return trimmed
    }

    var destinationURL: URL {
        let workspace = URL(string: "ade://workspace") ?? URL(fileURLWithPath: "/")
        guard ownershipAccepted else { return workspace }
        let attentionRun = runs.first(where: { $0.resolvedPhase.needsAttention })
        if let url = attentionRun?.deepLinkURL {
            return url
        }
        if let prUrl = prs.first(where: { $0.resolvedPhase.needsAttention })?.deepLinkURL {
            return prUrl
        }
        guard let target = primary else {
            if let prUrl = primaryPr?.deepLinkURL {
                return prUrl
            }
            return workspace
        }
        return target.deepLinkURL ?? workspace
    }

    /// Focus order, matching the desktop sidebar's prominence rule: the states
    /// that want a human come first, and merely-in-flight work recedes.
    ///
    /// `.completed` therefore outranks `.running` — a finished run you have not
    /// looked at is a result, while a running one is a progress report. This is
    /// safe here in a way it would not be on the Lock Screen widget: the Live
    /// Activity roster is the host's current runs, so a `.completed` row is
    /// freshly finished rather than an outcome from hours ago.
    ///
    /// `.stale` sits last on its own — it is neither an outcome nor live work.
    private static func priority(_ phase: AgentRunPhase) -> Int {
        switch phase {
        case .waitingForApproval, .waitingForInput: return 0
        case .failed: return 1
        case .completed: return 2
        case .starting, .running: return 3
        case .stale: return 4
        }
    }

    private static func priority(_ phase: PullRequestPhase) -> Int {
        switch phase {
        case .checksFailing, .changesRequested: return 1
        case .reviewRequested, .mergeReady: return 2
        case .opened, .reopened: return 3
        case .merged, .closed: return 4
        }
    }
}

// MARK: - Lock screen / banner

private struct AgentRunsLockScreenView: View {
    let presentation: AgentRunsPresentation

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 8) {
                // The state strip, same language as the notch and the island's
                // compact leading — not a generic app mark.
                AgentRunsStateStrip(presentation: presentation)
                Text(headline)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
                Spacer(minLength: 0)
                if let footer = presentation.machineFooter {
                    Text(footer)
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }

            if presentation.primary == nil && presentation.primaryPr == nil {
                Text(
                    presentation.ownershipAccepted
                        ? "No active runs"
                        : "Refreshing account activity"
                )
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    if let run = presentation.primary {
                        AgentActivityRunHero(
                            run: run,
                            compact: false,
                            allowsInlineActions: !presentation.accountWide,
                            hideDetails: presentation.hideDetails
                        )
                    }
                    // A PR only earns a card when there is no agent work at
                    // all. Otherwise events are one line at the bottom — rows
                    // are for agents (decision #11), and a PR mixed into the
                    // roster is how "3 agents" came to mean "1 agent and 2
                    // pull requests".
                    if presentation.primary == nil, let pr = presentation.primaryPr {
                        AgentActivityPullRequestHero(
                            pr: pr,
                            compact: false,
                            hideDetails: presentation.hideDetails
                        )
                    }
                    ForEach(presentation.secondaryRuns) { run in
                        AgentRunRow(
                            run: run,
                            compact: true,
                            hideDetails: presentation.hideDetails
                        )
                    }
                    if presentation.overflowCount > 0 {
                        Link(destination: AgentRunsPresentation.activityURL) {
                            Text(
                                presentation.overflowCount == 1
                                    ? "1 more"
                                    : "\(presentation.overflowCount) more"
                            )
                            .font(.system(size: 9.5, weight: .semibold))
                            .foregroundStyle(.secondary)
                        }
                        .padding(.leading, 24)
                    }
                }
            }

            if let signal = presentation.eventSignal {
                AgentRunsSignalLine(signal: signal)
            }

            if presentation.isStale {
                AgentRunsStaleHint()
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// One sentence for the lead state bucket. The strip beside it already
    /// carries every other bucket's glyph and count, so the headline does not
    /// have to be a summary of everything — it only has to name the loudest
    /// thing, in the same words the rows use.
    private var headline: String {
        if !presentation.ownershipAccepted {
            return "Updating ADE"
        }
        if let lead = presentation.leadGroup {
            switch lead.group {
            case .needsYou:
                return lead.count == 1 ? "1 agent needs you" : "\(lead.count) agents need you"
            case .failed:
                return lead.count == 1 ? "1 agent failed" : "\(lead.count) agents failed"
            case .planning:
                return lead.count == 1 ? "1 agent planning" : "\(lead.count) agents planning"
            // "working", not "running" — same word the row labels and the
            // desktop sidebar use for the in-flight phase.
            case .working:
                return lead.count == 1 ? "1 agent working" : "\(lead.count) agents working"
            case .done:
                return lead.count == 1 ? "1 agent done" : "\(lead.count) agents done"
            }
        }
        if presentation.runs.isEmpty && !presentation.prs.isEmpty {
            return presentation.prs.count == 1 ? "1 pull request updated" : "\(presentation.prs.count) pull requests updated"
        }
        return "No active runs"
    }
}

// MARK: - Focus cards

/// The row's leading mark: the *state* glyph on a tone-tinted disc.
///
/// This used to be the provider logo. Three identical Claude marks stacked in a
/// column told the reader nothing they did not already know, while the one fact
/// that differed between the rows — which state each was in — was left to a
/// small word at the far right. The provider now rides the subtitle, where it
/// belongs: it is metadata, not status.
private struct ActivityStateMark: View {
    let symbol: String
    let tint: Color
    let compact: Bool

    var body: some View {
        ZStack {
            Circle()
                .fill(tint.opacity(0.16))
            Image(systemName: symbol)
                .font(.system(size: compact ? 9 : 11, weight: .semibold))
                .foregroundStyle(tint)
                .contentTransition(.symbolEffect(.replace))
        }
        .frame(width: compact ? 16 : 20, height: compact ? 16 : 20)
        .overlay(Circle().strokeBorder(tint.opacity(0.24), lineWidth: 0.5))
        .accessibilityHidden(true)
    }
}

private struct AgentActivityRunHero: View {
    let run: ADEAgentRunsAttributes.Run
    let compact: Bool
    let allowsInlineActions: Bool
    let hideDetails: Bool

    private var phase: AgentRunPhase { run.resolvedPhase }
    private var showsApprovalActions: Bool {
        allowsInlineActions
            && !compact
            && phase == .waitingForApproval
            && !(run.itemId ?? "").isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: showsApprovalActions ? 7 : 0) {
            if let url = run.deepLinkURL {
                Link(destination: url) { content }
                    .buttonStyle(.plain)
            } else {
                content
            }

            if showsApprovalActions {
                HStack(spacing: 8) {
                    Button(intent: ApproveSessionIntent(sessionId: run.id, itemId: run.itemId ?? "")) {
                        heroAction("Approve", symbol: "checkmark", tint: phase.tint)
                    }
                    .buttonStyle(.plain)
                    Button(intent: DenySessionIntent(sessionId: run.id, itemId: run.itemId ?? "")) {
                        heroAction("Deny", symbol: "xmark", tint: .secondary)
                    }
                    .buttonStyle(.plain)
                    Spacer(minLength: 0)
                }
                .padding(.leading, 27)
            }
        }
        .padding(.horizontal, compact ? 5 : 8)
        .padding(.vertical, compact ? 3 : 7)
        .background(
            // The stronger fill goes to the states that want a human — needs
            // you, done, failed. In-flight work recedes, mirroring the desktop
            // sidebar's rule that prominence is a request for attention, not a
            // progress report.
            RoundedRectangle(cornerRadius: compact ? 7 : 10, style: .continuous)
                .fill(phase.tint.opacity(phase.isProminent ? 0.16 : 0.1))
        )
        .overlay(
            RoundedRectangle(cornerRadius: compact ? 7 : 10, style: .continuous)
                .stroke(phase.tint.opacity(0.22), lineWidth: 0.6)
        )
    }

    private var content: some View {
        HStack(spacing: 8) {
            ActivityStateMark(symbol: phase.symbol, tint: phase.tint, compact: compact)
            VStack(alignment: .leading, spacing: compact ? 0 : 2) {
                Text(hideDetails ? "Agent activity" : run.title)
                    .font(compact ? .system(size: 11.5, weight: .semibold) : .footnote.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                if !compact, let subtitle {
                    Text(subtitle)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 5)
            Text(phase.label)
                .font(compact ? .system(size: 9.5, weight: .bold) : .caption2.weight(.bold))
                .foregroundStyle(phase.tint)
                .lineLimit(1)
        }
        .contentShape(Rectangle())
    }

    private var subtitle: String? {
        guard !hideDetails else { return nil }
        let detail = run.detail?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let detail, !detail.isEmpty { return detail }
        return run.subtitle
    }

    private func heroAction(_ title: String, symbol: String, tint: Color) -> some View {
        Label(title, systemImage: symbol)
            .font(.system(size: 10.5, weight: .semibold))
            .foregroundStyle(tint)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(tint.opacity(0.13), in: Capsule())
    }
}

private struct AgentActivityPullRequestHero: View {
    let pr: ADEAgentRunsAttributes.PullRequest
    let compact: Bool
    let hideDetails: Bool

    private var phase: PullRequestPhase { pr.resolvedPhase }

    var body: some View {
        Group {
            if let url = pr.deepLinkURL {
                Link(destination: url) { content }
                    .buttonStyle(.plain)
            } else {
                content
            }
        }
        .padding(.horizontal, compact ? 5 : 8)
        .padding(.vertical, compact ? 3 : 7)
        .background(
            RoundedRectangle(cornerRadius: compact ? 7 : 10, style: .continuous)
                .fill(phase.tint.opacity(0.14))
        )
        .overlay(
            RoundedRectangle(cornerRadius: compact ? 7 : 10, style: .continuous)
                .stroke(phase.tint.opacity(0.22), lineWidth: 0.6)
        )
    }

    private var content: some View {
        HStack(spacing: 8) {
            Image(systemName: phase.symbol)
                .font(.system(size: compact ? 11 : 14, weight: .semibold))
                .foregroundStyle(phase.tint)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: compact ? 0 : 2) {
                Text(hideDetails ? "Pull request update" : "#\(pr.prNumber) \(pr.title)")
                    .font(compact ? .system(size: 11.5, weight: .semibold) : .footnote.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                if !hideDetails, !compact, let subtitle = pr.subtitle {
                    Text(subtitle)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 5)
            Text(phase.label)
                .font(compact ? .system(size: 9.5, weight: .bold) : .caption2.weight(.bold))
                .foregroundStyle(phase.tint)
                .lineLimit(1)
        }
        .contentShape(Rectangle())
    }
}

// MARK: - Shared row

private struct AgentRunRow: View {
    let run: ADEAgentRunsAttributes.Run
    let compact: Bool
    let hideDetails: Bool

    private var phase: AgentRunPhase { run.resolvedPhase }

    /// Inline Approve / Deny only earns space on the full lock-screen row for a
    /// run actually blocked on approval — and only when the host supplied the
    /// pending `itemId` (older hosts omit it; a button dispatching an empty
    /// item id could not target the approval, so the row stays tap-to-open).
    /// The Dynamic Island (`compact`) stays glance-only.
    private var showsApprovalActions: Bool {
        !compact && phase == .waitingForApproval && !(run.itemId ?? "").isEmpty
    }

    var body: some View {
        Group {
            if showsApprovalActions {
                VStack(alignment: .leading, spacing: 7) {
                    linkedRowContent
                    approvalActions
                }
            } else {
                linkedRowContent
            }
        }
        .padding(.vertical, phase.needsAttention && !compact ? 3 : 0)
        .padding(.horizontal, phase.needsAttention && !compact ? 6 : 0)
        .background(
            phase.needsAttention && !compact
                ? RoundedRectangle(cornerRadius: 7, style: .continuous).fill(phase.tint.opacity(0.14))
                : nil
        )
    }

    @ViewBuilder
    private var linkedRowContent: some View {
        if let url = run.deepLinkURL {
            Link(destination: url) { rowContent }
                .buttonStyle(.plain)
        } else {
            rowContent
        }
    }

    private var rowContent: some View {
        HStack(spacing: 8) {
            ActivityStateMark(symbol: phase.symbol, tint: phase.tint, compact: true)
                .frame(width: 16, alignment: .center)

            VStack(alignment: .leading, spacing: 1) {
                Text(hideDetails ? "Agent activity" : run.title)
                    .font(compact ? .system(size: 11, weight: .medium) : .caption.weight(.medium))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
                if let subtitle = subtitle {
                    Text(subtitle)
                        .font(compact ? .system(size: 9, weight: .regular) : .caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.85)
                }
            }

            Spacer(minLength: 4)

            // Colour is reserved for the states that want a human: a failed or
            // finished run keeps its hue, working / starting / stale recede to
            // secondary so the few rows that matter stand out.
            Text(phase.label)
                .font(compact ? .system(size: 9, weight: .semibold) : .caption2.weight(.semibold))
                .foregroundStyle(phase.isProminent ? phase.tint : .secondary)
                .lineLimit(1)
        }
        .contentShape(Rectangle())
    }

    /// Approve / Deny capsules, aligned under the title (past the status glyph).
    /// Approve carries the phase amber; Deny stays neutral so the destructive
    /// choice never reads as the primary one.
    private var approvalActions: some View {
        HStack(spacing: 8) {
            Button(intent: ApproveSessionIntent(sessionId: run.id, itemId: run.itemId ?? "")) {
                approvalLabel("Approve", systemImage: "checkmark", tint: phase.tint)
            }
            .buttonStyle(.plain)

            Button(intent: DenySessionIntent(sessionId: run.id, itemId: run.itemId ?? "")) {
                approvalLabel("Deny", systemImage: "xmark", tint: .secondary)
            }
            .buttonStyle(.plain)

            Spacer(minLength: 0)
        }
        .padding(.leading, 22)
    }

    private func approvalLabel(_ title: String, systemImage: String, tint: Color) -> some View {
        HStack(spacing: 4) {
            Image(systemName: systemImage)
                .font(.system(size: 10, weight: .semibold))
            Text(title)
                .font(.system(size: 11, weight: .semibold))
        }
        .foregroundStyle(tint)
        .padding(.horizontal, 12)
        .padding(.vertical, 5)
        .background(tint.opacity(0.16), in: Capsule(style: .continuous))
        .overlay(Capsule(style: .continuous).stroke(tint.opacity(0.30), lineWidth: 0.6))
    }

    /// Prefer the host-supplied detail line; fall back to "lane · model".
    private var subtitle: String? {
        guard !hideDetails else { return nil }
        let detail = run.detail?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let detail, !detail.isEmpty { return detail }
        return run.subtitle
    }
}

private struct PullRequestActivityRow: View {
    let pr: ADEAgentRunsAttributes.PullRequest
    let compact: Bool
    let hideDetails: Bool

    private var phase: PullRequestPhase { pr.resolvedPhase }

    var body: some View {
        Group {
            if let url = pr.deepLinkURL {
                Link(destination: url) { rowContent }
                    .buttonStyle(.plain)
            } else {
                rowContent
            }
        }
        .padding(.vertical, phase.needsAttention && !compact ? 3 : 0)
        .padding(.horizontal, phase.needsAttention && !compact ? 6 : 0)
        .background(
            phase.needsAttention && !compact
                ? RoundedRectangle(cornerRadius: 7, style: .continuous).fill(phase.tint.opacity(0.14))
                : nil
        )
    }

    private var rowContent: some View {
        HStack(spacing: 8) {
            Image(systemName: phase.symbol)
                .font(.system(size: compact ? 10 : 11, weight: .semibold))
                .foregroundStyle(phase.tint)
                .frame(width: 14, alignment: .center)

            VStack(alignment: .leading, spacing: 1) {
                Text(hideDetails ? "Pull request update" : "#\(pr.prNumber) \(pr.title)")
                    .font(compact ? .system(size: 11, weight: .medium) : .caption.weight(.medium))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
                if !hideDetails, let subtitle = pr.subtitle {
                    Text(subtitle)
                        .font(compact ? .system(size: 9, weight: .regular) : .caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.85)
                }
            }

            Spacer(minLength: 4)

            Text(phase.label)
                .font(compact ? .system(size: 9, weight: .semibold) : .caption2.weight(.semibold))
                .foregroundStyle(phase.needsAttention ? phase.tint : .secondary)
                .lineLimit(1)
        }
        .contentShape(Rectangle())
    }
}

// MARK: - Island wings

/// Compact leading: highest-priority state glyph + its count.
private struct AgentRunsCompactLeading: View {
    let presentation: AgentRunsPresentation

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: presentation.leadGlyph.systemImage)
                .font(.system(size: 12, weight: .bold))
            if let count = presentation.leadCountLabel {
                Text(count)
                    .font(.system(size: 13, weight: .bold, design: .rounded).monospacedDigit())
            }
        }
        .foregroundStyle(presentation.tint)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(presentation.minimalAccessibilityLabel)
    }
}

/// Compact trailing: the top event signal, or the total when there is none.
private struct AgentRunsCompactTrailing: View {
    let presentation: AgentRunsPresentation

    var body: some View {
        if let signal = presentation.eventSignal {
            HStack(spacing: 2) {
                Image(systemName: signal.symbol)
                    .font(.system(size: 11, weight: .semibold))
                if signal.moreCount > 0 {
                    Text("\(signal.moreCount + 1)")
                        .font(.system(size: 11, weight: .bold, design: .rounded).monospacedDigit())
                }
            }
            .foregroundStyle(signal.tint)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(signal.label)
        } else {
            Text("\(presentation.glanceCount)")
                .font(.system(size: 13, weight: .bold, design: .rounded).monospacedDigit())
                .foregroundStyle(presentation.tint)
        }
    }
}

/// The expanded view's leading strip: every nonzero bucket as glyph + count,
/// the same language the mac notch's compact strip speaks.
private struct AgentRunsStateStrip: View {
    let presentation: AgentRunsPresentation

    var body: some View {
        HStack(spacing: 7) {
            if presentation.groups.isEmpty {
                Image(systemName: presentation.leadGlyph.systemImage)
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(presentation.tint)
            }
            ForEach(presentation.groups.prefix(3)) { entry in
                HStack(spacing: 2) {
                    Image(systemName: entry.group.glyph.systemImage)
                        .font(.system(size: 11, weight: .semibold))
                    Text("\(entry.count)")
                        .font(.system(size: 12, weight: .bold, design: .rounded).monospacedDigit())
                }
                .foregroundStyle(activityToneColor(entry.group.tone))
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(entry.count) \(entry.group.label)")
            }
        }
    }
}

/// One line for PR/CI traffic inside the agents activity — the island has no
/// room for Agents | Events tabs, and events were never worth a second row.
private struct AgentRunsSignalLine: View {
    let signal: AgentRunsPresentation.EventSignal

    var body: some View {
        Link(destination: signal.url ?? AgentRunsPresentation.activityURL) {
            HStack(spacing: 5) {
                Image(systemName: signal.symbol)
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(signal.tint)
                Text(signal.label)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                if signal.moreCount > 0 {
                    Text("+\(signal.moreCount)")
                        .font(.system(size: 9.5, weight: .bold, design: .rounded).monospacedDigit())
                        .foregroundStyle(.tertiary)
                }
                Spacer(minLength: 0)
            }
            .padding(.top, 3)
            .contentShape(Rectangle())
        }
        .accessibilityLabel(
            signal.moreCount > 0
                ? "\(signal.label), and \(signal.moreCount) more events"
                : signal.label
        )
    }
}

private struct AgentRunsCountBadge: View {
    let presentation: AgentRunsPresentation

    var body: some View {
        if presentation.waitingCount > 0 {
            Label("\(presentation.waitingCount)", systemImage: ActivityGlyph.needsYou.systemImage)
                .font(.system(size: 12, weight: .semibold))
                .labelStyle(.titleAndIcon)
                .foregroundStyle(ADESharedTheme.warningAmber)
        } else {
            Text("\(presentation.glanceCount)")
                .font(.system(size: 15, weight: .bold))
                .foregroundStyle(presentation.tint)
        }
    }
}

private struct AgentRunsStaleHint: View {
    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "arrow.triangle.2.circlepath")
                .font(.system(size: 9, weight: .semibold))
            Text("Reconnecting")
                .font(.system(size: 10, weight: .medium))
        }
        .foregroundStyle(.secondary)
        .opacity(0.85)
    }
}

// MARK: - Previews

#if DEBUG
private extension ADEAgentRunsAttributes {
    static var preview: ADEAgentRunsAttributes { .init(machineName: "Arul's MacBook Pro") }
}

private extension ADEAgentRunsAttributes.ContentState {
    static var running: Self {
        .init(
            updatedAt: Date().timeIntervalSince1970,
            activeCount: 2,
            runs: [
                .init(id: "a", title: "Refactor sync transport", phase: "running", model: "gpt-5-codex", lane: "Primary", detail: "editing SyncService.swift"),
                .init(id: "b", title: "Audit pairing", phase: "running", model: "claude-sonnet-5", lane: "feat/pair"),
            ]
        )
    }

    static var waiting: Self {
        .init(
            updatedAt: Date().timeIntervalSince1970,
            activeCount: 3,
            runs: [
                .init(id: "c", title: "Release checklist", phase: "waiting_for_approval", model: "claude", lane: "Primary", detail: "approve git push", itemId: "item_release_push"),
                .init(id: "a", title: "Refactor sync transport", phase: "running", model: "gpt-5-codex", lane: "Primary"),
            ]
        )
    }
}

@available(iOS 17.0, *)
#Preview("Agent runs · running", as: .content, using: ADEAgentRunsAttributes.preview) {
    ADEAgentActivityWidget()
} contentStates: {
    ADEAgentRunsAttributes.ContentState.running
    ADEAgentRunsAttributes.ContentState.waiting
}
#endif
