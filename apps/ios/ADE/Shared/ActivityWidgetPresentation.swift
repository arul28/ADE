import SwiftUI

/// The two things every Activity surface needs beyond the pure mapper in
/// `ActivityRowPresentation`: the tone → colour binding, and the lock-screen
/// widget's ranking.
///
/// Both live here rather than in the widget because the widget target cannot
/// see the app's views and the app cannot see the widget's — a copy on each
/// side is exactly how the lock screen ends up describing a session in words
/// and colours the app does not use.
///
/// **iOS 17 constraint.** Compiled into the widget extension. Keep it free of
/// any newer API, and of anything from the app's design system beyond
/// `ADESharedTheme`, which is in both targets.

/// Tone token → the shared palette. The five session hues keep the meanings
/// documented on `ActivityTone`; violet is the PR-review hue.
public func activityToneColor(_ tone: ActivityTone) -> Color {
    switch tone {
    case .blue: return ADESharedTheme.statusRunning
    case .violet: return ADESharedTheme.statusReview
    case .amber: return ADESharedTheme.warningAmber
    case .emerald: return ADESharedTheme.statusSuccess
    case .red: return ADESharedTheme.statusFailed
    case .neutral: return ADESharedTheme.statusIdle
    }
}

public enum ActivityWidgetPresentation {
    /// Where a widget tap lands when nothing in particular is asking. Handled by
    /// `DeepLinkRouter`'s workspace route, which is the Activity surface's home.
    public static let activityURL = URL(string: "ade://activity") ?? URL(fileURLWithPath: "/")

    /// One rendered row. The same anatomy on every surface: state glyph in the
    /// phase's tone, then the title, then the phase word, with the scope line
    /// underneath wherever the family has the height for it.
    ///
    /// `url` is the row's own destination (#20) — home-screen families wrap
    /// each row in a `Link`; accessory families have exactly one tap target, so
    /// they fall back to the widget-level `deepLink`.
    public struct CompactLine: Identifiable, Hashable, Sendable {
        public let id: String
        public let title: String
        public let phaseLabel: String
        public let tone: ActivityTone
        public let glyph: ActivityGlyph?
        /// "Studio Mac · ADE" — where this is happening. `nil` when the
        /// privacy setting is on.
        public let scope: String?
        /// Per-row deep link into the chat this row is about.
        public let url: URL?
        /// Whether the state wants the eye (needs-you, done, failed).
        public let prominent: Bool
        /// Live on a reachable machine — drives the pulsing dot.
        public let isActive: Bool

        public init(
            id: String,
            title: String,
            phaseLabel: String,
            tone: ActivityTone,
            glyph: ActivityGlyph?,
            scope: String? = nil,
            url: URL? = nil,
            prominent: Bool = false,
            isActive: Bool = false
        ) {
            self.id = id
            self.title = title
            self.phaseLabel = phaseLabel
            self.tone = tone
            self.glyph = glyph
            self.scope = scope
            self.url = url
            self.prominent = prominent
            self.isActive = isActive
        }
    }

    /// A nonzero state bucket, for the "glyph + count" strip the widget header
    /// and the island's compact leading both render.
    public struct GroupCount: Identifiable, Hashable, Sendable {
        public let group: ActivityStateGroup
        public let count: Int

        public var id: String { group.rawValue }

        public init(group: ActivityStateGroup, count: Int) {
            self.group = group
            self.count = count
        }
    }

    /// The single events line (#21): PR/CI traffic compressed to one sentence,
    /// living inside the agents widget rather than in a widget of its own.
    /// Agent rows stay agent-only; this is the mirror of the notch's right-wing
    /// signal slot.
    public struct EventSignal: Identifiable, Hashable, Sendable {
        public let id: String
        /// "#1038 checks failing" — already includes the PR number when there
        /// is one, so a caller never has to reassemble it.
        public let label: String
        public let tone: ActivityTone
        public let glyph: ActivityGlyph?
        /// Other event rows this line stands in for.
        public let moreCount: Int
        public let url: URL?

        public init(
            id: String,
            label: String,
            tone: ActivityTone,
            glyph: ActivityGlyph?,
            moreCount: Int,
            url: URL?
        ) {
            self.id = id
            self.label = label
            self.tone = tone
            self.glyph = glyph
            self.moreCount = moreCount
            self.url = url
        }
    }

    /// Items worth showing at all: not dismissed, not expired.
    public static func visibleItems(
        _ items: [AccountAttentionItem],
        now: Date = Date()
    ) -> [AccountAttentionItem] {
        items.filter { item in
            item.dismissedAt == nil && (item.expiresAt.map { $0 > now } ?? true)
        }
    }

    /// The agents/notifications split (decision #11) at its only iOS decision
    /// point. Anything that is not explicitly a pull request counts as agent
    /// work: a kind this build has never heard of is far likelier to be a new
    /// agent shape than a new flavour of PR, and dropping it entirely would be
    /// the one failure mode a status surface must not have.
    public static func agentItems(
        _ items: [AccountAttentionItem]
    ) -> [AccountAttentionItem] {
        items.filter { $0.kind != .pullRequest }
    }

    /// PR / CI traffic — the "notification side". Rendered as one signal line,
    /// never as rows.
    public static func eventItems(
        _ items: [AccountAttentionItem]
    ) -> [AccountAttentionItem] {
        items.filter { $0.kind == .pullRequest }
    }

    /// Nonzero state buckets across the agent feed, in display order. This is
    /// the honest headline: five short facts instead of one number that has to
    /// mean whichever thing happened to sort first.
    public static func groupCounts(
        for items: [AccountAttentionItem],
        now: Date = Date()
    ) -> [GroupCount] {
        var tally: [ActivityStateGroup: Int] = [:]
        for item in agentItems(visibleItems(items, now: now)) {
            // Item-aware on purpose: the shared table is what applies the
            // idle-tier demotion and the planning derivation, and a local copy
            // of either rule is how the four mirrors drifted apart.
            tally[ActivityPhaseVocabulary.stateGroup(for: item), default: 0] += 1
        }
        return tally
            .map { GroupCount(group: $0.key, count: $0.value) }
            .sorted { $0.group.rank < $1.group.rank }
    }

    /// The one events line. Picks the highest-priority PR/CI row and says how
    /// many others it stands in for.
    public static func eventSignal(
        for items: [AccountAttentionItem],
        hideDetails: Bool = false,
        now: Date = Date()
    ) -> EventSignal? {
        let events = ranked(eventItems(visibleItems(items, now: now)))
        guard let top = events.first else { return nil }
        let presentation = ActivityPhaseVocabulary.presentation(for: top.phase)
        var label = presentation.label
        if !hideDetails, case .pullRequest(_, _, _, let number, _, _) = top.destination, number > 0 {
            label = "#\(number) \(presentation.label.lowercased())"
        }
        return EventSignal(
            id: top.id,
            label: label,
            tone: presentation.tone,
            glyph: presentation.glyph,
            moreCount: max(0, events.count - 1),
            url: top.deepLinkURL
        )
    }

    /// Where a tap goes.
    ///
    /// The widget used to follow whatever sorted first, which on a busy account
    /// is usually a PR notification — so the one glance-and-tap surface people
    /// have could not reliably reach the session actually blocked on them.
    /// Ranking is explicit now: the top needs-you row, else the top live agent,
    /// else the Activity surface itself. The item URLs already carry
    /// `?item=&event=&accountMachineKey=`, so the ack path is unchanged.
    public static func deepLink(
        for items: [AccountAttentionItem],
        now: Date = Date()
    ) -> URL {
        let visible = visibleItems(items, now: now)
        let ordered = ranked(visible)
        if let needsYou = ordered.first(where: { $0.phase == .needsYou }),
           let url = needsYou.deepLinkURL {
            return url
        }
        // `active`, not `AccountAttentionItem.isLive`: the latter counts a PR
        // with failing checks as live, and a tap that lands on PR traffic when
        // an agent is mid-turn is exactly the miss this ranking exists to stop.
        let live = ordered.first { ActivityPhaseVocabulary.presentation(for: $0.phase).active }
        if let live, let url = live.deepLinkURL {
            return url
        }
        return activityURL
    }

    /// Priority order for the rectangular lines: the same band ranking the
    /// drawer uses, then the freshest, then a stable id tiebreak so two equal
    /// rows never trade places between 60-second timeline entries.
    public static func ranked(_ items: [AccountAttentionItem]) -> [AccountAttentionItem] {
        items.sorted { lhs, rhs in
            let lhsBand = activityBandRank(ActivityPhaseVocabulary.band(for: lhs))
            let rhsBand = activityBandRank(ActivityPhaseVocabulary.band(for: rhs))
            if lhsBand != rhsBand { return lhsBand < rhsBand }
            let lhsProminent = ActivityPhaseVocabulary.presentation(for: lhs.phase).prominent
            let rhsProminent = ActivityPhaseVocabulary.presentation(for: rhs.phase).prominent
            if lhsProminent != rhsProminent { return lhsProminent }
            if lhs.updatedAt != rhs.updatedAt { return lhs.updatedAt > rhs.updatedAt }
            return lhs.id < rhs.id
        }
    }

    /// The top `limit` agent rows. `hideDetails` swaps in the publisher's
    /// privacy preview, which is what that setting is for — a lock screen is
    /// readable by anyone holding the phone.
    public static func compactLines(
        for items: [AccountAttentionItem],
        limit: Int = 2,
        hideDetails: Bool = false,
        now: Date = Date()
    ) -> [CompactLine] {
        ranked(agentItems(visibleItems(items, now: now))).prefix(limit).map { item in
            let presentation = ActivityPhaseVocabulary.presentation(
                for: item.phase,
                chatActivityMode: item.chatActivityMode
            )
            return CompactLine(
                id: item.id,
                title: title(for: item, hideDetails: hideDetails),
                phaseLabel: presentation.label,
                tone: presentation.tone,
                glyph: presentation.glyph,
                scope: hideDetails ? nil : scope(for: item),
                url: item.deepLinkURL,
                prominent: presentation.prominent,
                isActive: presentation.active && item.machine.online
            )
        }
    }

    /// How many agent rows the rendered lines left off, for the "N more" tail.
    /// Event rows are excluded — they are represented by `eventSignal`, and
    /// counting them here would make "+2 more" promise two chats that are not
    /// there.
    public static func overflowCount(
        for items: [AccountAttentionItem],
        limit: Int = 2,
        now: Date = Date()
    ) -> Int {
        max(0, agentItems(visibleItems(items, now: now)).count - limit)
    }

    // MARK: - Freshness

    /// How much the widget is allowed to claim, given when the snapshot it is
    /// rendering was last refreshed.
    ///
    /// The widget renders a cached App-Group snapshot. Before this existed it
    /// would draw hours-old counts with total confidence, which is worse than
    /// drawing nothing: a status surface that is silently wrong teaches people
    /// to stop reading it.
    public enum Confidence: Equatable, Sendable {
        /// Refreshed recently enough to state counts as fact.
        case fresh
        /// Aging. Counts still render, with the age said out loud.
        case aging
        /// Too old to assert. The widget says when it last heard, and stops
        /// presenting the numbers as current.
        case untrusted
    }

    public struct Freshness: Equatable, Sendable {
        public let age: TimeInterval
        public let confidence: Confidence
        /// "Updated 14m ago" / "Last synced 3h ago". `nil` while fresh — a
        /// timestamp on a current reading is noise.
        public let label: String?

        public var isStale: Bool { confidence != .fresh }
    }

    /// Foreground polling runs every 20s and a push refresh lands in seconds,
    /// so ten minutes without either means something is actually wrong.
    public static let agingThreshold: TimeInterval = 600
    /// Past two hours the snapshot describes a session that has almost
    /// certainly moved on.
    public static let untrustedThreshold: TimeInterval = 7_200

    /// - Parameters:
    ///   - generatedAt: when the relay built the snapshot.
    ///   - fetchedAt: when this device last successfully wrote one to the
    ///     shared container. `nil` on snapshots written before the marker
    ///     existed, in which case `generatedAt` carries the age alone.
    public static func freshness(
        generatedAt: Date,
        fetchedAt: Date? = nil,
        now: Date = Date()
    ) -> Freshness {
        // Whichever timestamp is newer is the strongest honest claim: a relay
        // clock skewed into the future must not read as fresher than the fetch
        // that actually happened, and vice versa.
        let anchor = max(generatedAt, fetchedAt ?? generatedAt)
        let age = max(0, now.timeIntervalSince(anchor))
        let confidence: Confidence
        if age >= untrustedThreshold {
            confidence = .untrusted
        } else if age >= agingThreshold {
            confidence = .aging
        } else {
            confidence = .fresh
        }
        guard confidence != .fresh,
              let duration = ActivityRowPresentation.formatDuration(age) else {
            return Freshness(age: age, confidence: confidence, label: nil)
        }
        return Freshness(
            age: age,
            confidence: confidence,
            label: confidence == .untrusted
                ? "Last synced \(duration) ago"
                : "Updated \(duration) ago"
        )
    }

    private static func scope(for item: AccountAttentionItem) -> String? {
        let machine = item.machine.name.trimmingCharacters(in: .whitespacesAndNewlines)
        let project = item.project.name.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = [machine, project].filter { !$0.isEmpty }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private static func title(for item: AccountAttentionItem, hideDetails: Bool) -> String {
        guard hideDetails else {
            let title = item.title.trimmingCharacters(in: .whitespacesAndNewlines)
            return title.isEmpty ? "Untitled session" : title
        }
        let privateTitle = item.privacyPreview.trimmingCharacters(in: .whitespacesAndNewlines)
        return privateTitle.isEmpty ? "Activity update" : privateTitle
    }
}
