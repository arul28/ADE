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
///
/// The five headline shapes are the notch/dropdown language, verbatim:
///
///   ●  needsYou  filled dot      your move
///   ▤  planning  notepad         a plan is being written
///   ◌  working   open circle     work in flight
///   ✓  done      checkmark       finished
///   ▲  failed    triangle        it broke
///
/// Shape carries the meaning as far as colour does — the five read apart at
/// 9pt on a lock screen and under any colour-vision deficiency, which is why
/// none of them is a bare dot in a different hue.
///
/// **What is shared and what is not.** The *glyph identity* is the contract
/// (`ACTIVITY_STATE_GLYPHS` in `renderer/components/activity/activityPresentation.ts`);
/// each surface maps it to its own icon set — Phosphor on the web,
/// SF Symbols here and in the notch. Two Swift surfaces may therefore pick
/// different symbols for one identity where their sizes differ: the notch
/// strip draws bare 14pt marks (`circle`, `checkmark`), while these rows draw
/// into a disc and use the enclosed forms. Divergence in *identity*, tone or
/// word is a drift bug; divergence in symbol at a different size is not.
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
        // Same notepad the notch strip uses; `list.bullet.rectangle` lost its
        // rules below ~10pt and read as a smear.
        case .planning: return "note.text"
        case .waiting: return "hourglass"
        // A filled dot, not a bell. The bell said "notification"; the row is
        // not a notification, it is a state, and the strip/island read it
        // beside four other state glyphs where a bell was the odd shape out.
        case .needsYou: return "circle.fill"
        case .done: return "checkmark.circle.fill"
        case .stale: return "clock.badge.exclamationmark"
        case .failed: return "exclamationmark.triangle.fill"
        case .review: return "eye.fill"
        case .merged: return "arrow.triangle.merge"
        }
    }
}

/// The coarse state buckets the notch strip, the widget header and the Dynamic
/// Island's compact leading all count by. Finer than `ActivityBand` (which
/// folds failure into "needs you") and coarser than a phase — this is the level
/// at which "glyph + count" is honest.
///
/// Rank is display order everywhere: your move, then breakage, then thinking,
/// then work in flight, then outcomes.
public enum ActivityStateGroup: String, Codable, Hashable, Sendable, CaseIterable {
    case needsYou
    case failed
    case planning
    case working
    case idle
    case done

    public var rank: Int {
        switch self {
        case .needsYou: return 0
        case .failed: return 1
        case .planning: return 2
        case .working: return 3
        case .idle: return 4
        case .done: return 5
        }
    }

    /// The two resting bands. Surfaces with room for a glance and nothing more
    /// — the island's compact pill, the notch popover — lead with the live
    /// bands and let these two be reached by opening the full list.
    public var isResting: Bool { self == .idle || self == .done }

    public var tone: ActivityTone {
        switch self {
        case .needsYou: return .amber
        case .failed: return .red
        case .planning: return .violet
        case .working: return .blue
        // Neutral, and never a live hue: painting the gone-quiet band blue is
        // how the island came to claim agents were working hours after they
        // had stopped.
        case .idle: return .neutral
        case .done: return .emerald
        }
    }

    public var glyph: ActivityGlyph {
        switch self {
        case .needsYou: return .needsYou
        case .failed: return .failed
        case .planning: return .planning
        case .working: return .working
        case .idle: return .stale
        case .done: return .done
        }
    }

    /// Sentence-case noun for the count beside the glyph. Used by VoiceOver on
    /// every surface, and as the visible word wherever there is room for one.
    public var label: String {
        switch self {
        case .needsYou: return "Needs you"
        case .failed: return "Failed"
        case .planning: return "Planning"
        case .working: return "Working"
        case .idle: return "Idle"
        case .done: return "Done"
        }
    }

    /// Snake-case slug used on the Live Activity wire, matching the publisher's
    /// event-kind convention. Kept separate from `rawValue` so a local rename
    /// can never silently change a payload contract.
    public var wireValue: String {
        switch self {
        case .needsYou: return "needs_you"
        case .failed: return "failed"
        case .planning: return "planning"
        case .working: return "working"
        case .idle: return "idle"
        case .done: return "done"
        }
    }

    public init?(wireValue: String) {
        switch wireValue.lowercased() {
        case "needs_you", "needsyou": self = .needsYou
        case "failed": self = .failed
        case "planning", "plan": self = .planning
        case "working", "running": self = .working
        case "idle", "stale": self = .idle
        case "done", "completed": self = .done
        default: return nil
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
    public static func presentation(
        for phase: AccountAttentionPhase,
        chatActivityMode: AccountChatActivityMode? = nil
    ) -> ActivityPhasePresentation {
        // The one additive field that can restate a phase, mirroring
        // `sessionStatusPresentation`: a running turn writing a plan reads
        // "Planning" in violet. Only `running` — a `starting` turn has not said
        // anything yet, so it keeps its own word even though it already counts
        // in the planning group.
        if case .running = phase, chatActivityMode?.isPlanning == true {
            return planningPresentation
        }
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

    /// The violet notepad, in one place: reached from a running turn's
    /// `chatActivityMode`, and from the Work tab, which synthesises a
    /// `planning` pseudo-phase to reuse this table.
    static let planningPresentation = ActivityPhasePresentation(
        label: "Planning",
        tone: .violet,
        glyph: .planning,
        showsElapsed: true,
        prominent: false,
        active: true
    )

    /// A phase this build has never heard of gets the quietest presentation
    /// there is. The one exception is `planning`, which the Work tab passes in
    /// deliberately (`workActivityPhase`) to borrow the violet row vocabulary.
    private static func unrecognizedPresentation(_ raw: String) -> ActivityPhasePresentation {
        switch raw.lowercased() {
        case "planning", "plan":
            return planningPresentation
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
        case .starting, .running, .blocked, .open, .reviewRequested:
            return .working
        // `stale` sits with the resting tail, not with work in flight. The
        // band is only three coarse steps, and the state group it now maps to
        // (`idle`) is a resting one — leaving it under `working` here would
        // sort gone-quiet rows above live ones in every list that sorts by
        // band.
        case .stale, .completed, .merged, .closed, .mergeReady:
            return .done
        case .unrecognized:
            return .done
        }
    }

    /// Which counting bucket an item belongs to — the iOS mirror of
    /// `activityStateGroup` in
    /// `renderer/components/activity/activityPresentation.ts`, and the only
    /// entry point a surface holding a real item should use.
    ///
    /// The idle-tier check runs FIRST and sends every idle row to `idle`,
    /// exactly as the canonical function does. Idle-tier rows are quiet roster
    /// history no matter what phase they preserved: an idle `failed` is not a
    /// live failure any more than an idle `needs_you` is a live question, so
    /// demoting only the raised hand (which this file used to do) left an idle
    /// failure counting as red on iOS and as done on every other surface.
    ///
    /// They land in `idle`, NOT `done` — `done` means work that finished. The
    /// two were one bucket until week-old roster rows filled it, which is the
    /// state the Activity sheet was in when this split was made.
    public static func stateGroup(for item: AccountAttentionItem) -> ActivityStateGroup {
        if item.tier == .idle { return .idle }
        return stateGroup(for: item.phase, chatActivityMode: item.chatActivityMode)
    }

    /// Which counting bucket a phase belongs to. The one place this is allowed
    /// to disagree with `band` is failure: the band folds breakage into "needs
    /// you" because both want a human, while the strip counts them apart
    /// because "2 failed" and "2 waiting on you" are different sentences.
    ///
    /// Tier-blind by necessity — the Live Activity wire enums project a bare
    /// phase and have no item to consult. Prefer `stateGroup(for:)` over an
    /// item wherever one exists.
    public static func stateGroup(
        for phase: AccountAttentionPhase,
        chatActivityMode: AccountChatActivityMode? = nil
    ) -> ActivityStateGroup {
        switch phase {
        case .needsYou:
            // A raised hand outranks a plan being written: the reader's move
            // is the fact worth counting, so `chatActivityMode` is not
            // consulted here — matching the canonical switch, where only the
            // live-turn phases read it.
            return .needsYou
        case .failed, .checksFailing, .changesRequested:
            return .failed
        // Planning is carried on this additive field, never on a phase; the
        // wire phase vocabulary is frozen and was deliberately not widened.
        case .starting, .running:
            return chatActivityMode?.isPlanning == true ? .planning : .working
        // Went quiet mid-work: neither live nor finished, which is the gap
        // `idle` exists to name. It used to file with `working`, and that is
        // what let a session that stopped hours ago keep counting as work in
        // flight on the lock screen.
        case .stale:
            return .idle
        // `mergeReady` files here, not under `done`. It is someone else's move,
        // not finished work, and filing it with the live band is what stops it
        // borrowing either the amber needs-you heading or the done tail.
        case .blocked, .open, .reviewRequested, .mergeReady:
            return .working
        case .completed, .merged, .closed:
            return .done
        case .unrecognized(let raw):
            // No `planning` branch here on purpose: there is exactly ONE
            // derivation of planning and it is `chatActivityMode` above. A
            // second one keyed off an unrecognized phase string could only ever
            // fire for a publisher that does not exist, and having two ways to
            // reach a state is how this table drifted in the first place.
            switch raw.lowercased() {
            case "waiting": return .working
            // The two resting states a session sits in between turns. They
            // reach this branch because neither is in the frozen wire phase
            // vocabulary, and both mean the same thing `idle` names.
            case "idle", "ready": return .idle
            default: return .done
            }
        }
    }

    /// Which priority band an item files under, with the same idle rule the
    /// state group applies: an idle row is quiet history and belongs in the
    /// tail, not one step above it.
    public static func band(for item: AccountAttentionItem) -> ActivityBand {
        if item.tier == .idle { return .done }
        return band(for: item.phase)
    }
}

/// Everything one Activity row renders, derived from one `AccountAttentionItem`.
///
/// Pure value type with no transport, no service reference, and no colour — the
/// drawer, the hub strip, and (from P7) the lock-screen widget all build their
/// rows from this so the three surfaces cannot describe one session three ways.
public struct ActivityRowPresentation: Identifiable, Hashable, Sendable {
    public let id: String
    /// What the row leads with: the chat's own name.
    ///
    /// The wire `title` USED to be a state sentence the publisher composed —
    /// "Claude is done" — which is why this line used to be treated as
    /// worthless and the preview shown in its place. That is no longer true.
    /// `attentionSessionTitle`
    /// (apps/ade-cli/src/services/push/attentionItemBuilder.ts) returns the
    /// session's real title first, the lane name second, and only composes
    /// "<Agent> <phase>" when the row has neither — and the publisher now
    /// re-reads it on every build, so a renamed chat is renamed here too. The
    /// lock screen and the Live Activity have shown that title all along; the
    /// drawer was the last surface still hiding it behind the status preview,
    /// which is how the same session read as two different things depending on
    /// where you looked at it.
    ///
    /// The status text is not lost — it is the tail of `scopeLine`, one line
    /// below, where it can be as specific as it likes without displacing the
    /// only text that identifies which chat this row is.
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
    /// Counting bucket for the strip / widget header / island compact leading.
    public let stateGroup: ActivityStateGroup
    /// Anchor for the elapsed ticker. `statusSince` when the publisher supplies
    /// it (immutable for the life of a phase); `occurredAt` otherwise, which is
    /// approximate but never wrong enough to mislead.
    public let elapsedSince: Date?
    /// The publisher's raw status prose, before the redundancy rule runs.
    /// `nil` when the item carries none. Read `statusDetail`, which is the
    /// version any surface should render; this is the input to it.
    let statusNote: String?
    public let modelLabel: String?
    public let providerSlug: String?
    public let machineKey: String
    /// The account-directory key, which is the one machine navigation resolves
    /// against — `machineKey` is the push-registration identity and the two are
    /// separately minted. Nil on rows from a publisher that predates it.
    public let accountMachineKey: String?
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
        let presentation = ActivityPhaseVocabulary.presentation(
            for: item.phase,
            chatActivityMode: item.chatActivityMode
        )

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
        // Both filing decisions come from the shared table, which applies the
        // canonical idle rule (idle → the tail) once, for every surface.
        band = ActivityPhaseVocabulary.band(for: item)
        stateGroup = ActivityPhaseVocabulary.stateGroup(for: item)
        elapsedSince = item.statusSince ?? item.occurredAt
        statusNote = Self.nonEmpty(item.preview)
            ?? Self.nonEmpty(item.detail)
            ?? Self.nonEmpty(item.privacyPreview)
        modelLabel = Self.nonEmpty(item.model)
        providerSlug = Self.nonEmpty(item.provider)
        machineKey = item.machine.machineKey
        accountMachineKey = Self.nonEmpty(item.machine.accountMachineKey)
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

    /// The publisher's status note, unless it only restates the rest of the row.
    ///
    /// `preview` falls back to `laneTitleLine` ("<lane> · <title>") when a run
    /// has no detail of its own, and both halves of that are already on the
    /// card — the lane on line one, the title on line two. Printing it again
    /// underneath is the redundancy this row was built to avoid, so it is
    /// dropped and the scope line falls through to the model instead.
    public var statusDetail: String? {
        guard let note = Self.nonEmpty(statusNote) else { return nil }
        if Self.restates(note, title) { return nil }
        if let lane = laneName, Self.restates(note, "\(lane) · \(title)") { return nil }
        return note
    }

    /// Does `note` say only what `composed` — some arrangement of the lane and
    /// the title, both already on the card — already says?
    ///
    /// Not `==`, because the two sides do not arrive comparable. The host runs
    /// `preview` through `sanitizeAttentionPreview`
    /// (apps/desktop/src/shared/types/attention.ts), which collapses every run
    /// of whitespace to one space AND truncates to 160 characters with a
    /// trailing `…`, while `title` reaches the phone only trimmed. So the exact
    /// composition this rule exists to suppress escaped it whenever the lane
    /// plus the title ran past 160 characters, or whenever either half carried
    /// a newline or a double space — and the row printed a truncated copy of
    /// its own first two lines underneath them.
    ///
    /// Both sides are therefore normalised the way the sanitizer normalises,
    /// and an elided note is matched by its stem: a note that ends in `…` and
    /// whose stem opens the composed string is that string, cut short.
    private static func restates(_ note: String, _ composed: String) -> Bool {
        let note = collapsingWhitespace(note)
        let composed = collapsingWhitespace(composed)
        if note.caseInsensitiveCompare(composed) == .orderedSame { return true }
        guard note.hasSuffix("…") else { return false }
        let stem = String(note.dropLast()).trimmingCharacters(in: .whitespaces)
        guard stem.count >= Self.minimumElidedStemLength, stem.count < composed.count else {
            return false
        }
        return composed.lowercased().hasPrefix(stem.lowercased())
    }

    /// How long a stem must be before "ends in `…` and opens the title" is read
    /// as evidence of truncation rather than as prose.
    ///
    /// The stem rule exists for exactly one producer: `sanitizeAttentionPreview`
    /// (apps/desktop/src/shared/types/attention.ts) cuts at
    /// `slice(0, 159).trimEnd() + "…"`, so anything it elided arrives with a
    /// stem of ~159 characters. Without a floor the rule also swallowed notes a
    /// human wrote — a chat titled "Working on the parser" whose note is
    /// "Working…" matched the prefix and lost its status line from both
    /// `scopeLine` and the row's accessibility label. 140 sits below the
    /// sanitizer's cut with room for whatever `trimEnd` removes, and far above
    /// any note short enough to have been typed rather than clipped.
    private static let minimumElidedStemLength = 140

    /// The sanitizer's whitespace rule, applied to this side of the comparison
    /// too: every run of whitespace becomes exactly one space.
    private static func collapsingWhitespace(_ value: String) -> String {
        value.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }

    /// The branded mark for this row's provider, or nil when the build ships
    /// none for it.
    ///
    /// Only chats get one. A pull-request item carries `provider: "GitHub"`
    /// from the publisher (`attentionItemBuilder.ts`), so a presence check on
    /// the slug is NOT the same question as "is this a chat" — `isPullRequest`
    /// is. The gate lives here rather than in the view so the mark and the
    /// spoken word below it are decided by one rule and cannot half-apply.
    public var providerMark: String? {
        guard !isPullRequest else { return nil }
        return ADESharedTheme.providerAssetName(for: providerSlug)
    }

    /// The provider's name in words, for the surfaces that speak rather than
    /// draw — and for `scopeLine` when there is no mark to draw.
    public var providerName: String? {
        guard !isPullRequest else { return nil }
        return ADESharedTheme.providerDisplayName(for: providerSlug)
    }

    /// The card's last line: which project this is, then the most specific
    /// thing known about it — the live status note when the publisher sent one,
    /// the model otherwise.
    ///
    /// The provider's NAME used to lead this line unconditionally. Where a mark
    /// exists it now sits on the same line and says it in one glyph, so the word
    /// is gone, exactly as it is on the Work session card this row mirrors.
    ///
    /// Where a mark does NOT exist the word stays. Pi and Gemini ship no
    /// bundled imageset, and the wire also publishes provider strings this build
    /// has no family for at all — `pushPublisherService.ts` falls back to
    /// `"CLI"` and `attentionItemBuilder.ts` passes through anything it does not
    /// recognise, so `"Shell"` reaches the phone verbatim. Dropping the word for
    /// those rows traded a name for nothing, which is strictly worse than the
    /// line it replaced. A generic SF Symbol is not the alternative: the Work
    /// card's fallback resolves two different unknown providers to the SAME
    /// glyph, so it identifies nothing while still making a claim about what is
    /// running. The word identifies; that is the whole job of this slot.
    ///
    /// The machine is deliberately absent — it already sits on line one, next
    /// to the lane.
    ///
    /// The model and the status note are deliberately EXCLUSIVE, where the
    /// model used to be unconditional. One `caption2` line clipped at
    /// `lineLimit(1)` holds about one fact after the project name: appending
    /// the model behind a status note puts it past the truncation point on any
    /// real row, so it would read as restored while rendering nothing, and on
    /// the short notes where it did fit it would stack three unrelated
    /// registers — where, what, and which model — on the smallest text in the
    /// drawer. The note is the fact that changes; the model is stable metadata
    /// the chat header shows in full the moment the row is opened. Nothing is
    /// lost to a screen reader either: `ActivityRow.accessibilityLabel` speaks
    /// `modelLabel` on every row, note or no note.
    public var scopeLine: String {
        var parts: [String] = []
        if providerMark == nil, let provider = providerName { parts.append(provider) }
        let project = projectName.trimmingCharacters(in: .whitespacesAndNewlines)
        if !project.isEmpty { parts.append(project) }
        if let detail = statusDetail {
            parts.append(detail)
        } else if let model = Self.nonEmpty(modelLabel) {
            parts.append(model)
        }
        return parts.joined(separator: " · ")
    }

    /// The subset of the item's own `actions[]` a surface should draw as
    /// buttons, rendered instead of the per-kind controls the drawer used to
    /// hardcode. Inline App Intents run against the paired host, so they only
    /// appear when the row's machine is both this one and reachable —
    /// otherwise every action degrades to navigation.
    ///
    /// `.open` is deliberately NOT included. It used to draw a full-width
    /// button under every single row, which on a ten-row account was most of
    /// the sheet's height spent restating that a list row is tappable. The row
    /// itself is the tap target, so only actions that genuinely do something a
    /// tap cannot — approve, deny, restart, rerun — earn a button.
    ///
    /// `.answer` is the one navigation that does earn one. The host splits a
    /// blocked run into `waiting_for_approval` (Approve/Deny) and
    /// `waiting_for_input` (Answer), and a question row carries only the latter
    /// — so with `.answer` filtered out, the rows that most need the user
    /// showed no control at all while an approval one row up showed two. It
    /// routes to the session rather than acting inline, because a drawer row
    /// cannot compose a reply and the payload the host sends carries only
    /// `{sessionId}`.
    public var visibleActions: [AccountAttentionAction] {
        let canActInline = inlineActionsAllowed && machineOnline
        return actions.filter { action in
            switch action.kind {
            case .approve, .deny, .restart, .rerunChecks:
                return canActInline
            // Navigation, not an inline intent: it does not need the machine to
            // be this one or even to be awake, because opening the session is
            // what wakes it.
            case .answer:
                return true
            case .open, .markSeen, .dismiss, .unrecognized:
                return false
            }
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
