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

    /// One line of the rectangular family: a glyph, a title, and the phase.
    public struct CompactLine: Identifiable, Hashable, Sendable {
        public let id: String
        public let title: String
        public let phaseLabel: String
        public let tone: ActivityTone
        public let glyph: ActivityGlyph?

        public init(
            id: String,
            title: String,
            phaseLabel: String,
            tone: ActivityTone,
            glyph: ActivityGlyph?
        ) {
            self.id = id
            self.title = title
            self.phaseLabel = phaseLabel
            self.tone = tone
            self.glyph = glyph
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
            let lhsBand = activityBandRank(ActivityPhaseVocabulary.band(for: lhs.phase))
            let rhsBand = activityBandRank(ActivityPhaseVocabulary.band(for: rhs.phase))
            if lhsBand != rhsBand { return lhsBand < rhsBand }
            let lhsProminent = ActivityPhaseVocabulary.presentation(for: lhs.phase).prominent
            let rhsProminent = ActivityPhaseVocabulary.presentation(for: rhs.phase).prominent
            if lhsProminent != rhsProminent { return lhsProminent }
            if lhs.updatedAt != rhs.updatedAt { return lhs.updatedAt > rhs.updatedAt }
            return lhs.id < rhs.id
        }
    }

    /// The top `limit` rows as compact lines. `hideDetails` swaps in the
    /// publisher's privacy preview, which is what that setting is for — a lock
    /// screen is readable by anyone holding the phone.
    public static func compactLines(
        for items: [AccountAttentionItem],
        limit: Int = 2,
        hideDetails: Bool = false,
        now: Date = Date()
    ) -> [CompactLine] {
        ranked(visibleItems(items, now: now)).prefix(limit).map { item in
            let presentation = ActivityPhaseVocabulary.presentation(for: item.phase)
            return CompactLine(
                id: item.id,
                title: title(for: item, hideDetails: hideDetails),
                phaseLabel: presentation.label,
                tone: presentation.tone,
                glyph: presentation.glyph
            )
        }
    }

    /// How many visible rows the compact lines left off, for the "+N more" tail.
    public static func overflowCount(
        for items: [AccountAttentionItem],
        limit: Int = 2,
        now: Date = Date()
    ) -> Int {
        max(0, visibleItems(items, now: now).count - limit)
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
