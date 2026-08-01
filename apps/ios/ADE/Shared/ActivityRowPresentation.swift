import Foundation

/// The iOS mirror of `apps/desktop/src/shared/sessionStatusPresentation.ts` and
/// the PR half of `renderer/components/activity/activityPresentation.ts`.
///
/// One item in, one row's worth of vocabulary out: what it is called, which hue
/// it wears, which glyph it carries, and whether the label is followed by a
/// ticking elapsed duration. Nothing here imports SwiftUI — tones are tokens,
/// not colours — so the app, the widget extension, and any future surface all
/// read the same table without inheriting the app's design system.
///
/// **iOS 17 constraint.** This file compiles into the widget extension, whose
/// deployment target is 17.0. Keep it free of any newer API.
///
/// ── The one-hue-one-meaning rule ────────────────────────────────────────────
///
///   blue     work is happening, nothing is asked of you
///   amber    YOUR MOVE — and nothing else, ever
///   emerald  finished cleanly, you have not looked yet
///   red      it broke
///   violet   a human review is outstanding
///   neutral  true, but not actionable
///
/// Exactly one phase is amber: `needsYou`. A hue added here that the desktop
/// table does not have is a drift bug, not a feature.
public enum ActivityTone: String, Codable, Hashable, Sendable {
    case blue
    case violet
    case amber
    case emerald
    case red
    case neutral
}

/// Glyph identity, not an icon import — the same split the desktop makes so the
/// table stays renderer-free. `systemImage` is the SF Symbols binding both
/// Apple-platform consumers happen to share.
public enum ActivityGlyph: String, Codable, Hashable, Sendable {
    case working
    case planning
    case waiting
    case needsYou
    case done
    case stale
    case failed
    case review
    case merged

    public var systemImage: String {
        switch self {
        case .working: return "circle.dotted"
        case .planning: return "list.bullet.rectangle"
        case .waiting: return "hourglass"
        case .needsYou: return "bell.badge.fill"
        case .done: return "checkmark.circle.fill"
        case .stale: return "clock.badge.exclamationmark"
        case .failed: return "exclamationmark.triangle.fill"
        case .review: return "eye.fill"
        case .merged: return "arrow.triangle.merge"
        }
    }
}

/// Which of the three priority bands a row belongs to. Mirrors desktop's
/// `activityPriority.ts`: needs-you first, then work in flight, then outcomes.
public enum ActivityBand: String, Codable, Hashable, Sendable, CaseIterable {
    case needsYou
    case working
    case done

    public var title: String {
        switch self {
        case .needsYou: return "Needs you"
        case .working: return "Working"
        case .done: return "Done"
        }
    }
}

/// The label/tone/glyph triple for one phase, before an item's own data is
/// folded in.
public struct ActivityPhasePresentation: Hashable, Sendable {
    public let label: String
    public let tone: ActivityTone
    public let glyph: ActivityGlyph?
    /// Whether the label should be followed by a live elapsed duration
    /// ("Working 14s"). Only where elapsed time is the useful fact — a failed
    /// run's age is noise.
    public let showsElapsed: Bool
    /// Whether this state should pull the eye. Working is deliberately not
    /// prominent: an agent mid-turn is not yet your problem.
    public let prominent: Bool
    /// Liveness, not prominence — drives the pulsing dot on an online row.
    public let active: Bool

    public init(
        label: String,
        tone: ActivityTone,
        glyph: ActivityGlyph?,
        showsElapsed: Bool,
        prominent: Bool,
        active: Bool
    ) {
        self.label = label
        self.tone = tone
        self.glyph = glyph
        self.showsElapsed = showsElapsed
        self.prominent = prominent
        self.active = active
    }
}

public enum ActivityPhaseVocabulary {
    /// Session-derived phases delegate to the desktop's `PHASE_PRESENTATION`;
    /// PR phases come from `NON_SESSION_PRESENTATION` + `NON_SESSION_STATUS_DETAILS`.
    /// Both tables are transcribed verbatim — if one changes, this changes.
    public static func presentation(for phase: AccountAttentionPhase) -> ActivityPhasePresentation {
        switch phase {
        case .starting:
            return .init(label: "Starting", tone: .blue, glyph: .working, showsElapsed: false, prominent: false, active: true)
        case .running:
            return .init(label: "Working", tone: .blue, glyph: .working, showsElapsed: true, prominent: false, active: true)
        case .needsYou:
            return .init(label: "Needs you", tone: .amber, glyph: .needsYou, showsElapsed: false, prominent: true, active: true)
        case .completed:
            return .init(label: "Done", tone: .emerald, glyph: .done, showsElapsed: false, prominent: true, active: false)
        case .failed:
            return .init(label: "Failed", tone: .red, glyph: .failed, showsElapsed: false, prominent: true, active: false)
        // Running but silent past the threshold. Neutral, not blue: the process
        // is technically alive, but "how long has it been quiet" is the actual
        // question, so the elapsed ticker stays on.
        case .stale:
            return .init(label: "Stale", tone: .neutral, glyph: .stale, showsElapsed: true, prominent: false, active: false)
        // Merge-blocked, not "your move" — frequently something the reader
        // cannot clear at all, so it makes no claim on them and never paints amber.
        case .blocked:
            return .init(label: "Blocked", tone: .neutral, glyph: nil, showsElapsed: false, prominent: false, active: false)
        case .checksFailing:
            return .init(label: "Checks failing", tone: .red, glyph: .failed, showsElapsed: false, prominent: true, active: false)
        case .reviewRequested:
            return .init(label: "Review requested", tone: .violet, glyph: .review, showsElapsed: false, prominent: true, active: false)
        case .changesRequested:
            return .init(label: "Changes requested", tone: .red, glyph: .failed, showsElapsed: false, prominent: true, active: false)
        case .mergeReady:
            return .init(label: "Ready to merge", tone: .emerald, glyph: .done, showsElapsed: false, prominent: true, active: false)
        case .open:
            return .init(label: "Open", tone: .blue, glyph: nil, showsElapsed: false, prominent: false, active: false)
        case .merged:
            return .init(label: "Merged", tone: .emerald, glyph: .merged, showsElapsed: false, prominent: true, active: false)
        case .closed:
            return .init(label: "Closed", tone: .neutral, glyph: nil, showsElapsed: false, prominent: false, active: false)
        case .unrecognized(let raw):
            return unrecognizedPresentation(raw)
        }
    }

    /// A phase this build has never heard of gets the quietest presentation
    /// there is. The one exception is `planning`, which the desktop already
    /// renders as violet "Planning" from a session's chat activity mode and
    /// which a newer publisher may start sending as a phase.
    private static func unrecognizedPresentation(_ raw: String) -> ActivityPhasePresentation {
        switch raw.lowercased() {
        case "planning", "plan":
            return .init(label: "Planning", tone: .violet, glyph: .planning, showsElapsed: true, prominent: false, active: true)
        case "waiting":
            return .init(label: "Waiting", tone: .neutral, glyph: .waiting, showsElapsed: false, prominent: false, active: false)
        // The two resting states a session sits in between turns. Neither is a
        // claim on anyone, so both are neutral and neither ticks.
        case "ready":
            return .init(label: "Ready", tone: .neutral, glyph: nil, showsElapsed: false, prominent: false, active: false)
        case "idle":
            return .init(label: "Idle", tone: .neutral, glyph: nil, showsElapsed: false, prominent: false, active: false)
        case "stopped":
            return .init(label: "Stopped", tone: .neutral, glyph: nil, showsElapsed: false, prominent: false, active: false)
        case "ended":
            return .init(label: "Ended", tone: .neutral, glyph: nil, showsElapsed: false, prominent: false, active: false)
        default:
            // Never manufacture a hue for a state we cannot describe: a
            // fallback that could paint amber would defeat the rule it exists
            // to protect.
            return .init(label: "Unknown", tone: .neutral, glyph: nil, showsElapsed: false, prominent: false, active: false)
        }
    }

    /// Which priority band a phase files under. `idle`-tier rows are forced out
    /// of the needs-you band by `ActivityRowPresentation` — a row nobody is
    /// waiting on must never sit at the top of the drawer.
    public static func band(for phase: AccountAttentionPhase) -> ActivityBand {
        switch phase {
        case .needsYou, .failed, .checksFailing, .changesRequested:
            return .needsYou
        case .starting, .running, .blocked, .stale, .open, .reviewRequested:
            return .working
        case .completed, .merged, .closed, .mergeReady:
            return .done
        case .unrecognized:
            return .done
        }
    }
}

/// Everything one Activity row renders, derived from one `AccountAttentionItem`.
///
/// Pure value type with no transport, no service reference, and no colour — the
/// drawer, the hub strip, and (from P7) the lock-screen widget all build their
/// rows from this so the three surfaces cannot describe one session three ways.
public struct ActivityRowPresentation: Identifiable, Hashable, Sendable {
    public let id: String
    public let title: String
    public let laneName: String?
    public let projectName: String
    public let phaseLabel: String
    public let tone: ActivityTone
    public let glyph: ActivityGlyph?
    public let showsElapsed: Bool
    public let prominent: Bool
    public let isActive: Bool
    public let band: ActivityBand
    /// Anchor for the elapsed ticker. `statusSince` when the publisher supplies
    /// it (immutable for the life of a phase); `occurredAt` otherwise, which is
    /// approximate but never wrong enough to mislead.
    public let elapsedSince: Date?
    /// The italic one-liner under the title. `nil` when the item carries no
    /// prose worth the row height — the phase label already says the state.
    public let statusNote: String?
    public let modelLabel: String?
    public let providerSlug: String?
    public let machineKey: String
    public let machineName: String
    public let machineOnline: Bool
    public let machineLastSeenAt: Date?
    public let tier: AccountActivityTier
    public let isPullRequest: Bool
    public let prNumber: Int?
    public let sessionId: String?
    /// Pending approval/input item, when the row is holding for one.
    public let pendingItemId: String?
    public let planProgress: AccountAttentionPlanProgress?
    public let recentActivity: [String]
    public let actions: [AccountAttentionAction]
    public let deepLink: URL?
    public let updatedAt: Date
    public let seenAt: Date?
    /// Whether this row belongs in the Inbox bucket (PR/CI traffic and
    /// unlooked-at outcomes), per `AccountAttentionItem.needsInbox`.
    public let needsInbox: Bool
    /// Inline App Intents execute against the currently paired host, so an item
    /// owned by another machine must navigate instead of acting locally.
    public let inlineActionsAllowed: Bool

    public init(item: AccountAttentionItem, inlineActionsAllowed: Bool = false) {
        let presentation = ActivityPhaseVocabulary.presentation(for: item.phase)
        let rawBand = ActivityPhaseVocabulary.band(for: item.phase)

        id = item.id
        title = Self.nonEmpty(item.title) ?? "Untitled session"
        laneName = Self.nonEmpty(item.laneName)
        projectName = Self.nonEmpty(item.project.name) ?? "Project"
        phaseLabel = presentation.label
        tone = presentation.tone
        glyph = presentation.glyph
        showsElapsed = presentation.showsElapsed
        prominent = presentation.prominent
        isActive = presentation.active && item.machine.online
        tier = item.tier
        // An idle row is by definition not waiting on the reader. Letting one
        // reach the needs-you band is how a drawer stops meaning anything.
        band = (item.tier == .idle && rawBand == .needsYou) ? .working : rawBand
        elapsedSince = item.statusSince ?? item.occurredAt
        statusNote = Self.nonEmpty(item.preview)
            ?? Self.nonEmpty(item.detail)
            ?? Self.nonEmpty(item.privacyPreview)
        modelLabel = Self.nonEmpty(item.model)
        providerSlug = Self.nonEmpty(item.provider)
        machineKey = item.machine.machineKey
        machineName = Self.nonEmpty(item.machine.name) ?? "Mac"
        machineOnline = item.machine.online
        machineLastSeenAt = item.machine.lastSeenAt
        isPullRequest = item.kind == .pullRequest
        planProgress = item.planProgress
        recentActivity = item.recentActivity ?? []
        actions = item.actions
        deepLink = item.deepLinkURL
        updatedAt = item.updatedAt
        seenAt = item.seenAt
        needsInbox = item.needsInbox
        self.inlineActionsAllowed = inlineActionsAllowed

        switch item.destination {
        case .session(let sessionId, let itemId, _):
            self.sessionId = Self.nonEmpty(sessionId)
            pendingItemId = Self.nonEmpty(itemId)
            prNumber = nil
        case .pullRequest(_, _, _, let number, _, _):
            self.sessionId = nil
            pendingItemId = nil
            prNumber = number > 0 ? number : nil
        case .unrecognized:
            self.sessionId = nil
            pendingItemId = nil
            prNumber = nil
        }
    }

    /// "Studio Mac · ADE" — the row's scope in one line.
    public var scopeLabel: String {
        let project = projectName.trimmingCharacters(in: .whitespacesAndNewlines)
        let machine = machineName.trimmingCharacters(in: .whitespacesAndNewlines)
        if machine.isEmpty { return project }
        if project.isEmpty { return machine }
        return "\(machine) · \(project)"
    }

    /// Compact elapsed copy for the "Working 14s" ticker. Mirrors
    /// `formatWorkingDuration`: seconds, then minutes, then hours, then days —
    /// deliberately lossy above the hour, where the exact figure stops changing
    /// any decision.
    public func elapsedLabel(now: Date = Date()) -> String? {
        guard showsElapsed, let elapsedSince else { return nil }
        return Self.formatDuration(now.timeIntervalSince(elapsedSince))
    }

    /// "last seen 2h ago" copy for an offline machine's banner.
    public func lastSeenLabel(now: Date = Date()) -> String? {
        guard !machineOnline, let machineLastSeenAt else { return nil }
        guard let duration = Self.formatDuration(now.timeIntervalSince(machineLastSeenAt)) else {
            return nil
        }
        return "last seen \(duration) ago"
    }

    public static func formatDuration(_ seconds: TimeInterval) -> String? {
        guard seconds.isFinite, seconds >= 0, abs(seconds) < 3_200_000_000 else {
            return nil
        }
        let totalSeconds = Int(seconds)
        if totalSeconds < 60 { return "\(totalSeconds)s" }
        let totalMinutes = totalSeconds / 60
        if totalMinutes < 60 { return "\(totalMinutes)m" }
        let totalHours = totalMinutes / 60
        if totalHours < 24 { return "\(totalHours)h" }
        return "\(totalHours / 24)d"
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else { return nil }
        return value
    }
}

public extension Array where Element == ActivityRowPresentation {
    /// Priority order inside a band: rows that want a human first, then the
    /// freshest, then a stable id tiebreak so equal rows never swap places
    /// between snapshots.
    func sortedByActivityPriority() -> [ActivityRowPresentation] {
        sorted { lhs, rhs in
            if lhs.band != rhs.band {
                return activityBandRank(lhs.band) < activityBandRank(rhs.band)
            }
            if lhs.prominent != rhs.prominent { return lhs.prominent }
            if lhs.updatedAt != rhs.updatedAt { return lhs.updatedAt > rhs.updatedAt }
            return lhs.id < rhs.id
        }
    }
}

public func activityBandRank(_ band: ActivityBand) -> Int {
    switch band {
    case .needsYou: return 0
    case .working: return 1
    case .done: return 2
    }
}
