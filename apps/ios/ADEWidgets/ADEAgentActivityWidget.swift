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
            // this height — events ride the compact trailing wing instead.
            //
            // Every region here is height- or width-bounded by its own view,
            // because the expanded island clips overflow with no visible tell:
            // the symptom of a region that asked for too much is a line that
            // simply is not on screen, which no amount of looking at the code
            // reveals.
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    AgentRunsStateStrip(presentation: presentation)
                        // The expanded island's corners are rounder than a
                        // widget banner. Without this inset the leading glyph
                        // loses its left edge to the capsule.
                        .padding(.leading, 10)
                        .padding(.vertical, 2)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    AgentRunsSecondStateBadge(presentation: presentation)
                        .padding(.trailing, 10)
                        .padding(.vertical, 2)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    AgentRunsIslandBody(presentation: presentation)
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
                    .foregroundStyle(presentation.leadTint)
                    .accessibilityLabel(presentation.minimalAccessibilityLabel)
            }
            .widgetURL(presentation.destinationURL)
            .keylineTint(presentation.leadTint)
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
    /// Every agent this activity knows about, roster rows plus the remainder
    /// the roster could not carry. The denominator behind "N more".
    let totalAgentCount: Int
    /// Approvals dispatch to *this* device's paired host and the intent carries
    /// no machine key, so an account-wide aggregate must not offer them — the
    /// capsule would resolve against whichever host happens to answer.
    let allowsInlineActions: Bool
    let isStale: Bool
    let machineName: String
    let ownershipAccepted: Bool
    let hideDetails: Bool
    /// Nonzero state buckets, in display order — the mac notch strip's content.
    /// Publisher-supplied when the payload carries `groups`, otherwise counted
    /// from the visible roster (which undercounts, and says so by never
    /// claiming more than it can see).
    let groups: [ActivityWidgetPresentation.GroupCount]
    /// Agent rows the lock-screen banner draws. Three is what the family's
    /// height affords once the strip and the last line are paid for; a lead row
    /// carrying Approve/Deny capsules costs another row's worth of space, so
    /// the budget drops to two rather than pushing the last line off the
    /// surface where nobody can see it went missing.
    let bannerRuns: [ADEAgentRunsAttributes.Run]
    /// Agent rows the expanded island draws. Two, not three — three plus a
    /// footer overflowed the bottom region, and the region clips silently, so
    /// the symptom was a footer that simply was not there.
    let islandRuns: [ADEAgentRunsAttributes.Run]
    /// How much this frame is allowed to claim, given how old it is.
    ///
    /// A Live Activity's content changes only when an APNs push arrives, and
    /// the relay deliberately spends pushes only on transitions that matter —
    /// so with nothing publishing, the island will happily sit on an
    /// hours-old frame forever. It used to present those counts with total
    /// confidence, which is worse than showing nothing: a status surface that
    /// is silently wrong teaches people to stop reading it. The static widgets
    /// already had this ladder; this shares it rather than inventing a second.
    let freshness: ActivityWidgetPresentation.Freshness

    /// Whether the counts may still be stated as fact.
    var assertsCounts: Bool { freshness.confidence != .untrusted }

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
        let allowsInlineActions = !accountWide
        self.allowsInlineActions = allowsInlineActions
        // Only the lead row can grow capsules, so it is the only row that can
        // change the banner's budget — checked here rather than in the view so
        // the row count and the count of rows the view iterates cannot drift.
        let leadCarriesApproval = allowsInlineActions
            && (sorted.first.map {
                $0.resolvedPhase == .waitingForApproval && !($0.itemId ?? "").isEmpty
            } ?? false)
        self.bannerRuns = Array(sorted.prefix(leadCarriesApproval ? 2 : 3))
        self.islandRuns = Array(sorted.prefix(2))

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

        // Events are a signal line, never rows — so the total counts agent rows
        // only. It used to add `prs.count` to `activeCount`, which promised
        // chats that were actually pull requests.
        //
        // Stored as a TOTAL rather than as a pre-subtracted overflow: the two
        // surfaces draw different row counts, and one shared "N more" said
        // "9 more" on the island while only two of the twelve rows were up.
        let totalRuns = max(safeState.runs.count + hiddenActiveCount, activeCount)
        self.totalAgentCount = safeState.moreCount
            .map { safeState.runs.count + $0 }
            ?? totalRuns
        // ActivityKit push staleness only. A run whose *phase* is `.stale` used
        // to fold in here, which greyed the whole glance and showed
        // "Reconnecting" because a single agent had gone quiet — a silence, not
        // a transport failure. The stale run says so on its own row.
        self.isStale = ownershipAccepted && isStale
        // Anchored on the relay's build time, which is the only timestamp a
        // pushed frame carries. `fetchedAt` belongs to the App-Group snapshot
        // path and has no meaning here.
        self.freshness = ActivityWidgetPresentation.freshness(
            generatedAt: safeState.updatedAtDate
        )
        self.machineName = ownershipAccepted ? attributes.machineName : "ADE"
        self.ownershipAccepted = ownershipAccepted
        self.hideDetails = !ownershipAccepted || ADESharedContainer.hideAttentionDetails
    }

    /// Tint of the glance — attention amber wins, otherwise the primary run's
    /// phase color, dimmed toward idle when the push feed itself is stale.
    ///
    /// Amber is checked first, and deliberately outranks staleness: "your move"
    /// is the one thing the glance may never swallow, and a late push does not
    /// make a raised hand less true.
    ///
    /// Compact island wings do **not** use this. `waitingCount` includes PRs
    /// (`checksFailing` and friends), so a failed lead glyph was painting
    /// amber whenever a PR was also asking. The lead bucket's own tone is
    /// `leadTint`.
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

    /// The compact leading / minimal / keyline color: the lead group's own
    /// tone, never the glance tint. Failed is red. Needs-you is amber.
    var leadTint: Color {
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

    /// The bucket the compact TRAILING speaks for: the second-highest-priority
    /// nonzero state.
    ///
    /// The pill is about two glyphs wide before the counts stop being legible
    /// in motion, so it shows the two states that matter most right now rather
    /// than a fixed pair or a single total. A bare "12" in the trailing slot —
    /// which is what this used to be — answers a question nobody asks: the
    /// useful second fact is "and one of them failed", not "twelve things
    /// exist".
    var secondGroup: ActivityWidgetPresentation.GroupCount? {
        groups.count > 1 ? groups[1] : nil
    }

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
    struct EventSignal: Identifiable {
        let id: String
        let label: String
        let glyph: ActivityGlyph?
        let symbol: String
        let tint: Color
        let moreCount: Int
        let url: URL?
    }

    var eventSignal: EventSignal? { eventSignals.first }

    /// Recent PR/CI clauses for the lock-screen last line. Two fit; the rest
    /// collapse into the trailing `+N` on the last one.
    var eventSignals: [EventSignal] {
        guard ownershipAccepted else { return [] }
        let shown = Array(prs.prefix(2))
        return shown.enumerated().map { index, pr in
            let phase = pr.resolvedPhase
            let label = hideDetails
                ? phase.label
                : (pr.prNumber > 0 ? "#\(pr.prNumber) \(phase.label.lowercased())" : phase.label)
            return EventSignal(
                id: pr.id,
                label: label,
                glyph: phase.glyph,
                symbol: phase.symbol,
                tint: phase.tint,
                moreCount: index == shown.count - 1 ? max(0, prs.count - shown.count) : 0,
                url: pr.deepLinkURL
            )
        }
    }

    /// Connected-machine count from the keys this frame actually carries.
    /// Older payloads omit `accountMachineKey`; treat that as one host rather
    /// than advertising "All machines" over a blank.
    var connectedMachineCount: Int {
        var keys = Set<String>()
        for run in runs {
            if let key = Self.nonEmpty(run.accountMachineKey) { keys.insert(key) }
        }
        for pr in prs {
            if let key = Self.nonEmpty(pr.accountMachineKey) { keys.insert(key) }
        }
        if keys.isEmpty {
            return ownershipAccepted && (!runs.isEmpty || !prs.isEmpty) ? 1 : 0
        }
        return keys.count
    }

    var machineCountLabel: String? {
        guard ownershipAccepted else { return nil }
        let count = connectedMachineCount
        guard count > 0 else { return nil }
        if count == 1 {
            let name = machineName.trimmingCharacters(in: .whitespacesAndNewlines)
            if !name.isEmpty && name.lowercased() != "all machines" {
                return name
            }
            return "1 machine"
        }
        return "\(count) machines"
    }

    /// "N more" for a surface that drew `shown` rows, or nil when it drew them
    /// all. Takes the row count because the banner and the island have
    /// different budgets and a shared constant would be wrong on one of them.
    func overflowLabel(shown: Int) -> String? {
        let remainder = max(0, totalAgentCount - shown)
        guard remainder > 0 else { return nil }
        return remainder == 1 ? "1 more" : "\(remainder) more"
    }

    /// What to say when there is nothing to list. The unaccepted-ownership case
    /// is not "no runs" — it is a frame this device is not allowed to read yet.
    var emptyStateLabel: String {
        ownershipAccepted ? "No active runs" : "Refreshing account activity"
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

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
            return nil
        }
        return value
    }
}

// MARK: - Lock screen / banner

/// Three bands, top to bottom: counts, rows, remainder.
///
/// ```
/// ◌4  ◷4  ✓4                          ● 2 machines
/// ────────────────────────────────────────────────
/// ● Should I force-push the rebase?             2m
/// ◌ Explore innovative features…                9m
/// ⚠ credential-store-hardening                 28m
/// 9 more                     ⑂ #1078 merged  +2
/// ```
///
/// Nothing here is nested in a card. The previous layout spent its first row on
/// a prose headline restating the strip, its second on a boxed hero holding one
/// run, and the hero's own title on the runtime's name — so a banner with room
/// for four facts carried one, and every row after it was pushed into the
/// clipped region.
private struct AgentRunsLockScreenView: View {
    let presentation: AgentRunsPresentation

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            // The one and only place a per-state count appears. The banner is
            // the widest surface this activity has, so unlike the island's
            // leading region it shows every nonzero band rather than the top
            // three — "what is the whole account doing", on one line.
            HStack(spacing: 8) {
                AgentRunsStateStrip(presentation: presentation, limit: 6)
                Spacer(minLength: 6)
                if let machines = presentation.machineCountLabel {
                    HStack(spacing: 4) {
                        Circle()
                            .fill(ADESharedTheme.warningAmber)
                            .frame(width: 6, height: 6)
                        Text(machines)
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    .accessibilityLabel(machines)
                }
            }

            // A hairline, not a container. The rows below need separating from
            // the tally above; a box around either would cost padding on four
            // sides to say the same thing.
            Rectangle()
                .fill(Color.primary.opacity(0.12))
                .frame(height: 0.5)
                .accessibilityHidden(true)

            if presentation.bannerRuns.isEmpty && presentation.primaryPr == nil {
                Text(presentation.emptyStateLabel)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                VStack(alignment: .leading, spacing: 5) {
                    ForEach(presentation.bannerRuns) { run in
                        AgentRunRow(
                            run: run,
                            compact: false,
                            allowsInlineActions: presentation.allowsInlineActions,
                            hideDetails: presentation.hideDetails
                        )
                    }
                    // A PR earns a row only when there is no agent work at all.
                    // Otherwise events are the one clause on the last line —
                    // rows are for agents (decision #11), and a PR mixed into
                    // the roster is how "3 agents" came to mean "1 agent and 2
                    // pull requests".
                    if presentation.bannerRuns.isEmpty, let pr = presentation.primaryPr {
                        PullRequestActivityRow(
                            pr: pr,
                            compact: false,
                            hideDetails: presentation.hideDetails
                        )
                    }
                }
            }

            lastLine
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Everything that is not a row, on one line, and absent when there is
    /// nothing to put on it. Overflow and age lead; the single event clause
    /// trails. Each of these used to claim a line of its own, which is height a
    /// surface capped near 160pt spends on an actual agent instead.
    @ViewBuilder
    private var lastLine: some View {
        let more = presentation.overflowLabel(shown: presentation.bannerRuns.count)
        let age = presentation.freshness.label
        let signals = presentation.eventSignals
        if more != nil || age != nil || presentation.isStale || !signals.isEmpty {
            HStack(spacing: 8) {
                if let more {
                    Link(destination: ActivityWidgetPresentation.activityURL) {
                        Text(more)
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(.secondary)
                    }
                }
                if presentation.isStale {
                    AgentRunsStaleHint()
                } else if let age {
                    Text(age)
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 4)
                HStack(spacing: 8) {
                    ForEach(signals) { signal in
                        AgentRunsSignalLine(signal: signal)
                    }
                }
            }
        }
    }
}

// MARK: - Row mark

/// The row's leading mark: the *state* glyph on a tone-tinted disc.
///
/// This used to be the provider logo. Three identical Claude marks stacked in a
/// column told the reader nothing they did not already know, while the one fact
/// that differed between the rows — which state each was in — was left to a
/// small word at the far right. The provider is not drawn at all now: it is
/// metadata, and a row this narrow only has room for status and content.
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

// MARK: - Shared row

/// One agent, one line: state glyph, the chat title, compact elapsed.
///
/// The text used to prefer `run.detail` (the status note / preview), which is
/// how a failed row whose note still said "phase 3 running" looked like live
/// work. The publisher now ships the session title; this strips a duplicated
/// `lane ·` prefix so the line can use the full remaining width.
private struct AgentRunRow: View {
    let run: ADEAgentRunsAttributes.Run
    let compact: Bool
    /// See `AgentRunsPresentation.allowsInlineActions` — the intent cannot name
    /// a machine, so account-wide aggregates stay tap-to-open.
    let allowsInlineActions: Bool
    let hideDetails: Bool

    private var phase: AgentRunPhase { run.resolvedPhase }

    /// Inline Approve / Deny only earns space on the full lock-screen row for a
    /// run actually blocked on approval — and only when the host supplied the
    /// pending `itemId` (older hosts omit it; a button dispatching an empty
    /// item id could not target the approval, so the row stays tap-to-open).
    /// The Dynamic Island (`compact`) stays glance-only.
    ///
    /// `AgentRunsPresentation.bannerRuns` predicts this exact condition to size
    /// its row budget; the two must agree or the banner draws a row it has no
    /// height for.
    private var showsApprovalActions: Bool {
        allowsInlineActions
            && !compact
            && phase == .waitingForApproval
            && !(run.itemId ?? "").isEmpty
    }

    /// No tinted pill behind the needs-you row. It cost 6pt of height and 6pt
    /// of leading inset, which knocked that row's glyph out of the column the
    /// other rows' glyphs sit in — so the one row meant to stand out was the
    /// one that looked misaligned. Needs-you already sorts to the top and wears
    /// the only amber glyph on the surface; that is the prominence, and it
    /// costs no space.
    var body: some View {
        if showsApprovalActions {
            VStack(alignment: .leading, spacing: 6) {
                linkedRowContent
                approvalActions
            }
        } else {
            linkedRowContent
        }
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
        HStack(spacing: 7) {
            ActivityStateMark(symbol: phase.symbol, tint: phase.tint, compact: true)
                .frame(width: 16, alignment: .center)

            Text(text)
                .font(compact ? .system(size: 11, weight: .medium) : .caption.weight(.medium))
                .foregroundStyle(.primary)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
                .layoutPriority(0)

            if let since = run.statusSinceDate,
               let duration = ActivityRowPresentation.formatDuration(Date().timeIntervalSince(since)) {
                Text(duration)
                    .monospacedDigit()
                    .font(compact ? .system(size: 9, weight: .semibold) : .caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
                    .frame(minWidth: 22, alignment: .trailing)
                    .layoutPriority(1)
            }
        }
        .contentShape(Rectangle())
        // One rotor stop per row, carrying what the glyph, the text and the
        // ticker say between them. Dropping the phase word from the row made
        // this mandatory: without it VoiceOver reads a chat preview with no
        // indication of what state the chat is in.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
    }

    /// The chat's own title. Status notes stay off this line — they are how a
    /// failed session whose last note said "phase 3 running" looked live.
    private var text: String {
        guard !hideDetails else { return "Agent activity" }
        return Self.displayTitle(run)
    }

    static func displayTitle(_ run: ADEAgentRunsAttributes.Run) -> String {
        var title = run.title.trimmingCharacters(in: .whitespacesAndNewlines)
        if let lane = run.lane?.trimmingCharacters(in: .whitespacesAndNewlines), !lane.isEmpty {
            let prefix = "\(lane) · "
            if title.hasPrefix(prefix) {
                title = String(title.dropFirst(prefix.count))
            }
        }
        if !title.isEmpty { return title }
        let detail = run.detail?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return detail.isEmpty ? "Agent run" : detail
    }

    private var accessibilityLabel: String {
        var parts = [phase.label, text]
        if let since = run.statusSinceDate,
           let duration = ActivityRowPresentation.formatDuration(Date().timeIntervalSince(since)) {
            parts.append("\(duration) ago")
        }
        return parts.joined(separator: ", ")
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
}

/// The PR fallback row, drawn only when there is no agent work at all.
///
/// Keeps its phase word where an agent row drops it: a PR carries no
/// `statusSince`, so the trailing slot has no ticker to spend it on, and
/// "merged" / "checks failing" is the news rather than a restatement of the
/// glyph.
private struct PullRequestActivityRow: View {
    let pr: ADEAgentRunsAttributes.PullRequest
    let compact: Bool
    let hideDetails: Bool

    private var phase: PullRequestPhase { pr.resolvedPhase }

    /// Unboxed, for the same reason `AgentRunRow` is: the glyph column has to
    /// line up whichever kind of row lands in it.
    @ViewBuilder
    var body: some View {
        if let url = pr.deepLinkURL {
            Link(destination: url) { rowContent }
                .buttonStyle(.plain)
        } else {
            rowContent
        }
    }

    private var rowContent: some View {
        HStack(spacing: 7) {
            Image(systemName: phase.symbol)
                .font(.system(size: compact ? 10 : 11, weight: .semibold))
                .foregroundStyle(phase.tint)
                .frame(width: 16, alignment: .center)

            Text(title)
                .font(compact ? .system(size: 11, weight: .medium) : .caption.weight(.medium))
                .foregroundStyle(.primary)
                .lineLimit(1)
                .truncationMode(.tail)

            Spacer(minLength: 6)

            Text(phase.label)
                .font(compact ? .system(size: 9, weight: .semibold) : .caption2.weight(.semibold))
                .foregroundStyle(phase.needsAttention ? phase.tint : .secondary)
                .lineLimit(1)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(phase.label), \(title)")
    }

    private var title: String {
        hideDetails ? "Pull request update" : "#\(pr.prNumber) \(pr.title)"
    }
}

// MARK: - Expanded island

/// The expanded island's bottom region: at most two rows, then exactly one
/// footer line.
///
/// The region is roughly 160pt tall and clips whatever overflows without any
/// visible sign that it did — which is how three rows, a stale hint and an
/// event line between them sheared the footer clean off and left "12" in the
/// trailing region missing its top edge. Everything drawn here is counted
/// against that budget, and the count lives in
/// `AgentRunsPresentation.islandRuns` rather than in a `prefix` here so the
/// footer's "N more" is computed from the same number.
///
/// Events get no line of their own: the compact trailing already carries the
/// top one, and it is the region that survives the island being collapsed.
private struct AgentRunsIslandBody: View {
    let presentation: AgentRunsPresentation

    private var runs: [ADEAgentRunsAttributes.Run] { presentation.islandRuns }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(runs) { run in
                AgentRunRow(
                    run: run,
                    compact: true,
                    allowsInlineActions: false,
                    hideDetails: presentation.hideDetails
                )
            }
            if runs.isEmpty {
                if let pr = presentation.primaryPr {
                    PullRequestActivityRow(
                        pr: pr,
                        compact: true,
                        hideDetails: presentation.hideDetails
                    )
                } else {
                    Text(presentation.emptyStateLabel)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            footer
        }
        .padding(.horizontal, 14)
        .padding(.bottom, 10)
        .privacySensitive()
    }

    /// Overflow only. Scope used to sit here ("All machines") and the rounded
    /// island clipped it off the bottom edge. Machine count lives on the lock
    /// screen header, where there is width for it.
    @ViewBuilder
    private var footer: some View {
        if let more = presentation.overflowLabel(shown: runs.count) {
            HStack {
                Link(destination: ActivityWidgetPresentation.activityURL) {
                    Text(more)
                        .font(.system(size: 9.5, weight: .semibold))
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            .lineLimit(1)
            .padding(.top, 2)
        } else if presentation.isStale {
            Text("Reconnecting")
                .font(.system(size: 9.5, weight: .medium))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .padding(.top, 2)
        }
    }
}

/// Expanded island, trailing region: the second-highest-priority state, so the
/// two expanded wings say the two things that matter most rather than one thing
/// and a grand total.
///
/// The region is narrow and clips silently — a 15pt bold "12" lost its top edge
/// there. Three defences, because any one of them alone has a counterexample:
/// two digits is the hard cap (an account with 100+ rows in one state does not
/// need the exact figure to know it is a lot), the type is a size smaller than
/// the leading strip's, and `minimumScaleFactor` absorbs whatever the first two
/// did not anticipate.
private struct AgentRunsSecondStateBadge: View {
    let presentation: AgentRunsPresentation

    @ViewBuilder
    var body: some View {
        if let second = presentation.secondGroup {
            badge(
                symbol: second.group.glyph.systemImage,
                count: "\(min(second.count, 99))",
                tint: activityToneColor(second.group.tone),
                label: "\(second.count) \(second.group.label)"
            )
        } else if let signal = presentation.eventSignal {
            // Only one state bucket is nonzero, so the second-most-important
            // fact is the event feed rather than a repeat of the leading wing.
            badge(
                symbol: signal.symbol,
                count: signal.moreCount > 0 ? "\(min(signal.moreCount + 1, 99))" : nil,
                tint: signal.tint,
                label: signal.label
            )
        }
    }

    private func badge(symbol: String, count: String?, tint: Color, label: String) -> some View {
        HStack(spacing: 3) {
            Image(systemName: symbol)
                .font(.system(size: 11, weight: .semibold))
            if let count {
                Text(count)
                    .font(.system(size: 12, weight: .bold, design: .rounded).monospacedDigit())
            }
        }
        .foregroundStyle(tint)
        .lineLimit(1)
        .minimumScaleFactor(0.7)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
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
        .foregroundStyle(presentation.leadTint)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(presentation.minimalAccessibilityLabel)
    }
}

/// Compact trailing: the SECOND state, then the top event signal, then the
/// total.
///
/// The pill's two wings are the only thing visible when the island is
/// collapsed, so between them they should say the two most important facts
/// about the account — "4 need you" and "1 failed" — rather than one fact and
/// a grand total. A PR signal still wins the slot when there are no two
/// distinct agent states to show, because at that point it is the second fact.
private struct AgentRunsCompactTrailing: View {
    let presentation: AgentRunsPresentation

    var body: some View {
        if let second = presentation.secondGroup {
            HStack(spacing: 3) {
                Image(systemName: second.group.glyph.systemImage)
                    .font(.system(size: 11, weight: .semibold))
                Text("\(min(second.count, 99))")
                    .font(.system(size: 13, weight: .bold, design: .rounded).monospacedDigit())
            }
            .foregroundStyle(activityToneColor(second.group.tone))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(second.count) \(second.group.label)")
        } else if let signal = presentation.eventSignal {
            HStack(spacing: 2) {
                Image(systemName: signal.symbol)
                    .font(.system(size: 11, weight: .semibold))
                if signal.moreCount > 0 {
                    Text("\(min(signal.moreCount + 1, 99))")
                        .font(.system(size: 11, weight: .bold, design: .rounded).monospacedDigit())
                }
            }
            .foregroundStyle(signal.tint)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(signal.label)
        } else {
            Text("\(min(presentation.glanceCount, 99))")
                .font(.system(size: 13, weight: .bold, design: .rounded).monospacedDigit())
                .foregroundStyle(presentation.tint)
        }
    }
}

/// The state strip: every nonzero bucket as glyph + count, the same language
/// the mac notch's compact strip and the in-app Activity sheet speak.
///
/// `limit` exists because the two surfaces that draw this have very different
/// budgets — the island's expanded leading region is narrow, the lock screen
/// banner is full width and can carry all six.
private struct AgentRunsStateStrip: View {
    let presentation: AgentRunsPresentation
    var limit: Int = 3

    private var visible: [ActivityWidgetPresentation.GroupCount] {
        Array(presentation.groups.prefix(limit))
    }

    private var summarySentence: String {
        presentation.groups
            .map { "\($0.count) \($0.group.label.lowercased())" }
            .joined(separator: ", ")
    }

    var body: some View {
        HStack(spacing: 7) {
            if presentation.groups.isEmpty {
                Image(systemName: presentation.leadGlyph.systemImage)
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(presentation.tint)
            }
            ForEach(visible) { entry in
                // Each count is its own destination. The island's expanded
                // region and the lock-screen banner both support per-element
                // links, so the strip is navigation rather than a readout.
                Link(destination: ActivityWidgetPresentation.activityURL(for: entry.group)) {
                    HStack(spacing: 2) {
                        Image(systemName: entry.group.glyph.systemImage)
                            .font(.system(size: 11, weight: .semibold))
                        Text("\(entry.count)")
                            .font(.system(size: 12, weight: .bold, design: .rounded).monospacedDigit())
                    }
                    .foregroundStyle(activityToneColor(entry.group.tone))
                }
                .accessibilityLabel("\(entry.count) \(entry.group.label)")
            }
        }
        // The island's leading region is narrow and clips without warning. Three
        // glyph+count pairs fit at rest; a three-digit tally on any of them does
        // not, so the strip shrinks rather than losing a bucket off the edge.
        .lineLimit(1)
        .minimumScaleFactor(0.7)
        // Dimmed rather than hidden once the frame is too old to assert: the
        // shape of the account is still probably right, but the numbers are
        // no longer a claim. The headline says how old, in words.
        .opacity(presentation.assertsCounts ? 1 : 0.45)
        // One rotor stop for the whole strip. Six unlabelled glyph+number pairs
        // made VoiceOver users assemble the sentence themselves.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            presentation.groups.isEmpty
                ? "No agent activity"
                : "Agent states: \(summarySentence)"
        )
    }
}

/// PR/CI traffic as one clause on the banner's trailing edge — never a row and
/// no longer a line of its own. Events were never worth a whole line, and the
/// line they had was taken from the third agent row.
///
/// No leading `Spacer` here: the clause is laid out by the last line's HStack,
/// which needs it to size to its content so the overflow count keeps the
/// leading edge.
private struct AgentRunsSignalLine: View {
    let signal: AgentRunsPresentation.EventSignal

    var body: some View {
        Link(destination: signal.url ?? ActivityWidgetPresentation.activityURL) {
            HStack(spacing: 4) {
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
            }
            .contentShape(Rectangle())
        }
        .accessibilityLabel(
            signal.moreCount > 0
                ? "\(signal.label), and \(signal.moreCount) more events"
                : signal.label
        )
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
    /// `statusSince` is populated on purpose: without it the trailing edge of
    /// every row is empty, and a preview that never shows the ticker is how the
    /// row's only time signal goes unreviewed.
    static var running: Self {
        .init(
            updatedAt: Date().timeIntervalSince1970,
            activeCount: 9,
            runs: [
                .init(id: "a", title: "Claude is working", phase: "running", model: "gpt-5-codex", lane: "Primary", detail: "Explore innovative features for the sync transport", statusSince: Date().timeIntervalSince1970 - 540),
                .init(id: "b", title: "Claude is working", phase: "running", model: "claude-sonnet-5", lane: "feat/pair", statusSince: Date().timeIntervalSince1970 - 120),
                .init(id: "d", title: "credential-store-hardening", phase: "failed", model: "claude", lane: "creds", statusSince: Date().timeIntervalSince1970 - 1_680),
            ],
            moreCount: 6
        )
    }

    static var waiting: Self {
        .init(
            updatedAt: Date().timeIntervalSince1970,
            activeCount: 3,
            runs: [
                .init(id: "c", title: "Release checklist", phase: "waiting_for_approval", model: "claude", lane: "Primary", detail: "Should I force-push the rebase?", itemId: "item_release_push", statusSince: Date().timeIntervalSince1970 - 130),
                .init(id: "a", title: "Refactor sync transport", phase: "running", model: "gpt-5-codex", lane: "Primary", statusSince: Date().timeIntervalSince1970 - 900),
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
