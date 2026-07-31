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
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 5) {
                        Image(systemName: "point.3.filled.connected.trianglepath.dotted")
                            .font(.system(size: 14, weight: .bold))
                        Text(presentation.compactCountLabel)
                            .font(.system(size: 13, weight: .bold, design: .rounded))
                    }
                    .foregroundStyle(presentation.tint)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    AgentRunsCountBadge(presentation: presentation)
                }
                DynamicIslandExpandedRegion(.center) {
                    Group {
                        if let run = presentation.primary {
                            AgentActivityRunHero(
                                run: run,
                                compact: true,
                                allowsInlineActions: !presentation.accountWide,
                                hideDetails: presentation.hideDetails
                            )
                        } else if let pr = presentation.primaryPr {
                            AgentActivityPullRequestHero(
                                pr: pr,
                                compact: true,
                                hideDetails: presentation.hideDetails
                            )
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .privacySensitive()
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 5) {
                        ForEach(presentation.secondaryRuns) { run in
                            AgentRunRow(
                                run: run,
                                compact: true,
                                hideDetails: presentation.hideDetails
                            )
                        }
                        ForEach(presentation.secondaryPrs) { pr in
                            PullRequestActivityRow(
                                pr: pr,
                                compact: true,
                                hideDetails: presentation.hideDetails
                            )
                        }
                        HStack(spacing: 5) {
                            if presentation.overflowCount > 0 {
                                Text("+\(presentation.overflowCount) more")
                                    .font(.system(size: 9.5, weight: .semibold))
                                    .foregroundStyle(presentation.tint)
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
                    }
                    .padding(.horizontal, 4)
                    .privacySensitive()
                }
            } compactLeading: {
                Image(systemName: presentation.waitingCount > 0 ? presentation.primarySymbol : "point.3.filled.connected.trianglepath.dotted")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(presentation.tint)
            } compactTrailing: {
                if presentation.waitingCount > 0 {
                    Image(systemName: "bell.badge.fill")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(ADESharedTheme.warningAmber)
                } else {
                    Text("\(presentation.glanceCount)")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(presentation.tint)
                }
            } minimal: {
                Image(systemName: presentation.waitingCount > 0 ? "bell.fill" : "circle.fill")
                    .font(.system(size: presentation.waitingCount > 0 ? 12 : 9, weight: .bold))
                    .foregroundStyle(presentation.tint)
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
    let secondaryPrs: [ADEAgentRunsAttributes.PullRequest]
    let overflowCount: Int
    let isStale: Bool
    let machineName: String
    let accountWide: Bool
    let ownershipAccepted: Bool
    let hideDetails: Bool

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
        let remainingSlots = max(0, 2 - secondaryRuns.count)
        let secondaryPrs = Array(
            sortedPrs
                .filter { $0.id != primaryPr?.id }
                .prefix(remainingSlots)
        )
        self.secondaryRuns = secondaryRuns
        self.secondaryPrs = secondaryPrs
        let represented = (primary == nil && primaryPr == nil ? 0 : 1)
            + secondaryRuns.count
            + secondaryPrs.count
        self.overflowCount = max(0, activeCount + safeState.prs.count - represented)
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
        if isStale { return ADESharedTheme.statusIdle }
        if let primaryPr, primary == nil { return primaryPr.resolvedPhase.tint }
        return primary?.resolvedPhase.tint ?? ADESharedTheme.statusIdle
    }

    var primarySymbol: String {
        primary?.resolvedPhase.symbol ?? primaryPr?.resolvedPhase.symbol ?? "circle.dotted"
    }

    var glanceCount: Int {
        activeCount + prs.count
    }

    var compactCountLabel: String {
        if waitingCount > 0 { return "\(waitingCount)" }
        if activeCount == 0, primary?.resolvedPhase == .failed { return "!" }
        if activeCount == 0, primaryPr?.resolvedPhase == .checksFailing { return "!" }
        return "\(glanceCount)"
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
            HStack(spacing: 6) {
                Image(systemName: "point.3.filled.connected.trianglepath.dotted")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(presentation.tint)
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
                    if let pr = presentation.primaryPr {
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
                    ForEach(presentation.secondaryPrs) { pr in
                        PullRequestActivityRow(
                            pr: pr,
                            compact: true,
                            hideDetails: presentation.hideDetails
                        )
                    }
                    if presentation.overflowCount > 0 {
                        Text("+\(presentation.overflowCount) more")
                            .font(.system(size: 9.5, weight: .semibold))
                            .foregroundStyle(presentation.tint)
                            .padding(.leading, 22)
                    }
                }
            }

            if presentation.isStale {
                AgentRunsStaleHint()
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var headline: String {
        if !presentation.ownershipAccepted {
            return "Updating ADE"
        }
        if presentation.waitingCount > 0 {
            return presentation.waitingCount == 1 ? "1 item needs you" : "\(presentation.waitingCount) items need you"
        }
        if presentation.activeCount == 0, let phase = presentation.primary?.resolvedPhase {
            if phase == .failed { return "Agent work failed" }
            if phase == .completed { return "Agent work done" }
        }
        if presentation.runs.isEmpty && !presentation.prs.isEmpty {
            return presentation.prs.count == 1 ? "1 pull request updated" : "\(presentation.prs.count) pull requests updated"
        }
        // "working", not "running" — same word the row labels and the desktop
        // sidebar use for the in-flight phase.
        let count = presentation.activeCount
        return count == 1 ? "1 agent working" : "\(count) agents working"
    }
}

// MARK: - Focus cards

private struct ProviderActivityMark: View {
    let model: String?
    let fallbackSymbol: String
    let tint: Color
    let compact: Bool

    var body: some View {
        let provider = ADESharedTheme.providerSlug(forModel: model)
        ZStack {
            Circle()
                .fill(tint.opacity(0.16))
            if let assetName = ADESharedTheme.providerAssetName(for: provider) {
                Image(assetName)
                    .resizable()
                    .scaledToFit()
                    .padding(compact ? 2.5 : 3)
            } else {
                Image(systemName: fallbackSymbol)
                    .font(.system(size: compact ? 9 : 11, weight: .semibold))
                    .foregroundStyle(tint)
                    .contentTransition(.symbolEffect(.replace))
            }
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
            ProviderActivityMark(
                model: run.model,
                fallbackSymbol: phase.symbol,
                tint: phase.tint,
                compact: compact
            )
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
            ProviderActivityMark(
                model: run.model,
                fallbackSymbol: phase.symbol,
                tint: phase.tint,
                compact: true
            )
            .frame(width: 14, alignment: .center)

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

private struct AgentRunsCountBadge: View {
    let presentation: AgentRunsPresentation

    var body: some View {
        if presentation.waitingCount > 0 {
            Label("\(presentation.waitingCount)", systemImage: "bell.badge.fill")
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
