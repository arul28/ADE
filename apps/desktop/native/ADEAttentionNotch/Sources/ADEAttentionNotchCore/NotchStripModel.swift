import Foundation

// What the compact strip says, and how wide it has to be to say it.
//
// The strip used to repeat one provider logo per live agent and end in a bare
// dot and number, which told nobody anything and was sized by a constant. It is
// now two wings around the hardware cutout: state groups with counts on the
// left, one real signal on the right, and a width derived from both.

/// The five states the strip counts and the panel files under, one hue each.
///
/// This is the Swift mirror of `ACTIVITY_STATE_GLYPHS` / `activityStateGroup`
/// in `apps/desktop/src/renderer/components/activity/activityPresentation.ts`,
/// which is the single table for every Activity surface. Amber is "your move"
/// and is spent nowhere else; violet is deliberation; a change belongs there
/// first and here second.
///
/// Declaration order *is* priority order, the way `ACTIVITY_STATE_GROUPS`'
/// array order is on the canonical side: `allCases` yields these in the order
/// written, and the strip, the sections and the counts all walk it as-is. A
/// separate rank table would only be a second copy of this line-up to keep in
/// step. To reprioritise, move a case.
public enum NotchStripGroupKind: String, CaseIterable, Equatable, Sendable {
    case needsYou
    case failed
    case planning
    case working
    case done

    /// Matches `ActivitySectionId`, so a section id crossing between the
    /// helper and the host means the same thing on both ends.
    public var sectionId: String {
        switch self {
        case .needsYou: return "needs-you"
        case .failed: return "failed"
        case .planning: return "planning"
        case .working: return "working"
        case .done: return "done"
        }
    }

    public var tone: NotchStatusTone {
        switch self {
        case .needsYou: return .amber
        case .failed: return .red
        case .planning: return .violet
        case .working: return .blue
        case .done: return .emerald
        }
    }

    /// One glyph per meaning: a filled dot only ever means "your move", an open
    /// circle only ever means "still running", the notepad only ever means the
    /// agent is planning.
    public var symbolName: String {
        switch self {
        case .needsYou: return "circle.fill"
        case .failed: return "exclamationmark.triangle.fill"
        case .planning: return "note.text"
        case .working: return "circle"
        case .done: return "checkmark"
        }
    }

    /// Section heading, matching `ACTIVITY_STATE_GLYPHS[...].label`.
    public var sectionLabel: String {
        switch self {
        case .needsYou: return "Needs you"
        case .failed: return "Failed"
        case .planning: return "Planning"
        case .working: return "Working"
        case .done: return "Done"
        }
    }

    /// Spoken, not drawn — the strip shows the glyph, VoiceOver reads this.
    public var label: String {
        switch self {
        case .needsYou: return "needs you"
        case .failed: return "failed"
        case .planning: return "planning"
        case .working: return "working"
        case .done: return "done"
        }
    }
}

/// Which group a row belongs to. Mirrors `activityStateGroup` exactly,
/// including its two load-bearing rules:
///
/// - `planning` comes from `chatActivityMode`, not from a phase. The phase
///   vocabulary is frozen push wire and cannot carry the state, so a running
///   turn that says it is planning wears the violet notepad instead of the blue
///   circle. An item that does not carry the field groups exactly as before.
/// - `review_requested`, `merge_ready` and `blocked` are somebody *else's*
///   move, so they file with the live band rather than borrowing amber. Their
///   phase tone stays violet/emerald in a row pill — the group is about who has
///   to act, the pill is about what the phase is.
public func notchStripGroupKind(for item: AttentionItem) -> NotchStripGroupKind {
    // Idle rows are disk-only roster history: quiet, never alerting, always the
    // ambient tail no matter what phase they preserved.
    if item.isIdleTier { return .done }
    switch item.phase {
    case "needs_you":
        return .needsYou
    case "failed", "checks_failing", "changes_requested":
        return .failed
    case "starting", "running":
        return item.isPlanning ? .planning : .working
    case "stale", "open", "review_requested", "merge_ready", "blocked":
        return .working
    default:
        return .done
    }
}

public struct NotchStripGroup: Identifiable, Equatable, Sendable {
    public let kind: NotchStripGroupKind
    public let count: Int

    public init(kind: NotchStripGroupKind, count: Int) {
        self.kind = kind
        self.count = count
    }

    public var id: String { kind.rawValue }
    public var tone: NotchStatusTone { kind.tone }
    public var symbolName: String { kind.symbolName }
    public var accessibilityLabel: String { "\(count) \(kind.label)" }
}

/// How many rows of each group the frame carried, agent-only.
///
/// Agent-only is load-bearing twice over: the strip's state groups are agent
/// states (a pull request is not "planning"), and the host's `counts` block
/// counts agent items exclusively — tallying PR rows here and then flooring
/// with an agent-only total would overcount every group it touched.
public func notchStripTally(_ items: [AttentionItem]) -> [NotchStripGroupKind: Int] {
    var tally: [NotchStripGroupKind: Int] = [:]
    for item in notchItems(items, in: .agents) where item.dismissedAt == nil {
        tally[notchStripGroupKind(for: item), default: 0] += 1
    }
    return tally
}

/// Every nonzero group, in priority order.
///
/// The host's counts are the account's truth and the rows are a bounded
/// projection of it, so each group the host counts takes whichever is larger.
/// Every count the host sends comes from this same five-way table, so this is
/// a floor and not a reinterpretation. `failed` and `planning` are optional
/// because they are the newest two on the wire: a host that does not send them
/// leaves those groups purely row-derived, which is exactly the behaviour every
/// shipped build already has.
public func notchStripGroups(
    items: [AttentionItem],
    counts: AttentionCounts? = nil
) -> [NotchStripGroup] {
    var tally = notchStripTally(items)
    if let counts {
        tally[.needsYou] = max(tally[.needsYou] ?? 0, counts.needsYou)
        tally[.working] = max(tally[.working] ?? 0, counts.working)
        tally[.done] = max(tally[.done] ?? 0, counts.done)
        if let failed = counts.failed { tally[.failed] = max(tally[.failed] ?? 0, failed) }
        if let planning = counts.planning { tally[.planning] = max(tally[.planning] ?? 0, planning) }
    }
    return NotchStripGroupKind.allCases
        .compactMap { kind in
            let count = tally[kind] ?? 0
            return count > 0 ? NotchStripGroup(kind: kind, count: count) : nil
        }
}

/// One panel section: a state group and the rows filed under it.
///
/// The panel and the strip read the same table, so a row the strip counts as
/// `failed` is a row the panel files under Failed. They used to disagree — the
/// panel had its own three-way split by numeric phase priority, which put a
/// failure under "Needs you" and had no Planning at all.
public struct NotchActivityGroupSection: Identifiable, Equatable, Sendable {
    public let kind: NotchStripGroupKind
    public let items: [AttentionItem]

    public init(kind: NotchStripGroupKind, items: [AttentionItem]) {
        self.kind = kind
        self.items = items
    }

    /// Matches the host's `ActivitySectionId` and the strip's own group id.
    public var id: String { kind.sectionId }
    public var title: String { kind.sectionLabel }
    public var tone: NotchStatusTone { kind.tone }
}

/// Every nonempty section, most urgent first, rows in priority order.
public func notchActivityGroupSections(_ items: [AttentionItem]) -> [NotchActivityGroupSection] {
    var grouped: [NotchStripGroupKind: [AttentionItem]] = [:]
    for item in sortedAttentionItems(items) {
        grouped[notchStripGroupKind(for: item), default: []].append(item)
    }
    return NotchStripGroupKind.allCases
        .compactMap { kind in
            guard var sectionItems = grouped[kind], !sectionItems.isEmpty else { return nil }
            if kind == .done {
                // Idle roster history is the ambient tail even when its
                // preserved phase outranks a fresh completed outcome.
                sectionItems = sectionItems.filter { !$0.isIdleTier }
                    + sectionItems.filter(\.isIdleTier)
            }
            return NotchActivityGroupSection(kind: kind, items: sectionItems)
        }
}

/// The single thing the right wing says. Present in both reveal modes: a strip
/// that only counts states still makes you open something to learn what
/// happened.
public struct NotchTopSignal: Equatable, Sendable {
    public let text: String
    public let tone: NotchStatusTone
    public let symbolName: String
    public let itemId: String?
    /// False for the quiet fallback summary, which is drawn muted rather than
    /// in a tone that would claim something happened.
    public let isNotable: Bool

    public init(
        text: String,
        tone: NotchStatusTone,
        symbolName: String,
        itemId: String? = nil,
        isNotable: Bool
    ) {
        self.text = text
        self.tone = tone
        self.symbolName = symbolName
        self.itemId = itemId
        self.isNotable = isNotable
    }
}

/// Fits the right wing at 9.5pt semibold without truncating mid-word.
private let notchSignalCharacterBudget = 30

private func notchSignalText(for item: AttentionItem, hideDetails: Bool) -> String {
    if hideDetails {
        return item.kind == "pull_request" ? "Pull request update" : "Agent update"
    }
    if item.kind == "pull_request", let number = item.destination.number {
        return "\(item.statusLabel) #\(number)"
    }
    let title = item.title.trimmingCharacters(in: .whitespacesAndNewlines)
    return notchTruncated(title.isEmpty ? item.statusLabel : title, to: notchSignalCharacterBudget)
}

private func notchTruncated(_ value: String, to budget: Int) -> String {
    guard value.count > budget, budget > 1 else { return value }
    let clipped = value.prefix(budget - 1).trimmingCharacters(in: .whitespaces)
    return "\(clipped)…"
}

/// Stream health outranks any row: a signal drawn from items nobody can refresh
/// is a lie with a colour on it.
public func notchTopSignal(
    items: [AttentionItem],
    counts: AttentionCounts,
    status: NotchStatusPresentation?,
    hideDetails: Bool
) -> NotchTopSignal {
    if let status, status.isProblem {
        return NotchTopSignal(
            text: status.compactLabel,
            tone: status.tone,
            symbolName: status.symbolName,
            isNotable: true
        )
    }
    let ranked = sortedAttentionItems(items)
    if let notable = ranked.first(where: notchSignalIsNotable) {
        let kind = notchStripGroupKind(for: notable)
        return NotchTopSignal(
            text: notchSignalText(for: notable, hideDetails: hideDetails),
            tone: kind.tone,
            symbolName: kind.symbolName,
            itemId: notable.id,
            isNotable: true
        )
    }
    if counts.machinesTotal > 0 {
        return NotchTopSignal(
            text: "\(counts.machinesOnline)/\(counts.machinesTotal) machines",
            tone: .neutral,
            symbolName: "desktopcomputer",
            isNotable: false
        )
    }
    return NotchTopSignal(
        text: status?.compactLabel ?? "All clear",
        tone: .neutral,
        symbolName: "checkmark.circle",
        isNotable: false
    )
}

/// Worth a wing of its own: something asked for you, broke, or just landed.
/// Ambient "still running" rows are already counted on the left.
private func notchSignalIsNotable(_ item: AttentionItem) -> Bool {
    if item.isIdleTier { return false }
    switch notchStripGroupKind(for: item) {
    case .needsYou, .failed, .planning:
        return true
    case .done:
        // A merge or a finished run is news for as long as it is unseen.
        return item.kind == "pull_request" && item.seenAt == nil
    case .working:
        return false
    }
}

/// How much room the two wings need. The strip is centered on a hardware cutout
/// that is itself centered, so both ears are the same width and the wider wing
/// decides it; a fixed panel width is what made the old strip look padded out
/// for no reason.
public struct NotchStripMetrics: Equatable, Sendable {
    public let leadingWidth: Double
    public let trailingWidth: Double

    public static let empty = NotchStripMetrics(leadingWidth: 0, trailingWidth: 0)

    public init(leadingWidth: Double, trailingWidth: Double) {
        self.leadingWidth = max(0, leadingWidth)
        self.trailingWidth = max(0, trailingWidth)
    }

    public var widest: Double { max(leadingWidth, trailingWidth) }
}

/// Advances measured from the strip's own type ramp (9.5pt semibold, monospaced
/// digits). Approximate by design: a `TextKit` measurement here would cost a
/// layout pass on every snapshot for sub-point accuracy nobody can see.
private enum NotchStripTypeMetrics {
    static let glyph: Double = 11
    static let glyphGap: Double = 3.5
    static let digit: Double = 6.4
    static let groupGap: Double = 9
    static let character: Double = 5.9
    static let signalGap: Double = 5
    static let emptyIdentity: Double = 56
}

public func notchStripMetrics(
    groups: [NotchStripGroup],
    signal: NotchTopSignal?
) -> NotchStripMetrics {
    var leading: Double = 0
    if groups.isEmpty {
        leading = NotchStripTypeMetrics.emptyIdentity
    } else {
        for group in groups {
            let digits = Double(max(1, String(group.count).count))
            leading += NotchStripTypeMetrics.glyph
                + NotchStripTypeMetrics.glyphGap
                + digits * NotchStripTypeMetrics.digit
        }
        leading += Double(groups.count - 1) * NotchStripTypeMetrics.groupGap
    }

    var trailing: Double = 0
    if let signal {
        trailing = NotchStripTypeMetrics.glyph
            + NotchStripTypeMetrics.signalGap
            + Double(signal.text.count) * NotchStripTypeMetrics.character
    }
    return NotchStripMetrics(leadingWidth: leading, trailingWidth: trailing)
}

// MARK: - Expanded panel

/// The expanded panel's two tabs. Agents are the feed; events are the PR and CI
/// outcomes that ADE's Activity pane files under Notifications.
public enum NotchPanelTab: String, CaseIterable, Equatable, Sendable {
    case agents
    case events

    public var title: String {
        switch self {
        case .agents: return "Agents"
        case .events: return "Events"
        }
    }
}

public func notchPanelTab(for item: AttentionItem) -> NotchPanelTab {
    item.kind == "pull_request" ? .events : .agents
}

public func notchItems(_ items: [AttentionItem], in tab: NotchPanelTab) -> [AttentionItem] {
    items.filter { notchPanelTab(for: $0) == tab }
}

/// One PR, one story. Three failing checks on the same pull request arrived as
/// three rows and read as three problems; clustered they read as the one thing
/// that is actually wrong.
public struct NotchEventCluster: Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let subtitle: String
    public let tone: NotchStatusTone
    public let items: [AttentionItem]

    public init(
        id: String,
        title: String,
        subtitle: String,
        tone: NotchStatusTone,
        items: [AttentionItem]
    ) {
        self.id = id
        self.title = title
        self.subtitle = subtitle
        self.tone = tone
        self.items = items
    }

    public var count: Int { items.count }
    public var lead: AttentionItem? { items.first }

    public var accessibilityLabel: String {
        "\(title). \(subtitle). \(attentionPluralized(count, "update"))"
    }
}

/// Groups by repository and pull-request number, preserving the priority order
/// the rows arrived in: the most urgent cluster stays first, and inside it the
/// most urgent update leads.
public func notchEventClusters(
    _ items: [AttentionItem],
    hideDetails: Bool = false
) -> [NotchEventCluster] {
    var order: [String] = []
    var grouped: [String: [AttentionItem]] = [:]
    for item in sortedAttentionItems(notchItems(items, in: .events)) {
        let key = notchEventClusterKey(for: item)
        if grouped[key] == nil {
            grouped[key] = []
            order.append(key)
        }
        grouped[key]?.append(item)
    }
    return order.compactMap { key in
        guard let clustered = grouped[key], let lead = clustered.first else { return nil }
        return NotchEventCluster(
            id: key,
            title: notchEventClusterTitle(for: lead, hideDetails: hideDetails),
            subtitle: lead.presentation(hideDetails: hideDetails).title,
            tone: notchStatusTone(for: lead.phase),
            items: clustered
        )
    }
}

private func notchEventClusterKey(for item: AttentionItem) -> String {
    let destination = item.destination
    if let number = destination.number {
        let repo = [destination.repoOwner, destination.repoName]
            .compactMap { $0?.notchNonEmpty }
            .joined(separator: "/")
        return repo.isEmpty ? "pr:\(item.project.projectId):\(number)" : "pr:\(repo)#\(number)"
    }
    if let prId = destination.prId?.notchNonEmpty { return "pr:\(prId)" }
    return "event:\(item.id)"
}

private func notchEventClusterTitle(for item: AttentionItem, hideDetails: Bool) -> String {
    guard !hideDetails else { return "Pull request" }
    let destination = item.destination
    let repo = destination.repoName?.notchNonEmpty ?? item.project.name.notchNonEmpty
    guard let number = destination.number else { return repo ?? "Pull request" }
    guard let repo else { return "#\(number)" }
    return "\(repo) #\(number)"
}
