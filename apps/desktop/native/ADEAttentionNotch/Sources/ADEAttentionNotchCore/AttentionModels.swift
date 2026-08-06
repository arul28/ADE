import Foundation

public struct AttentionMachine: Codable, Equatable, Sendable {
    public let machineKey: String
    public let name: String
    public let online: Bool
    public let lastSeenAt: String?

    public init(machineKey: String, name: String, online: Bool, lastSeenAt: String?) {
        self.machineKey = machineKey
        self.name = name
        self.online = online
        self.lastSeenAt = lastSeenAt
    }
}

public struct AttentionProject: Codable, Equatable, Sendable {
    public let projectId: String
    public let name: String
    public let rootPath: String?

    public init(projectId: String, name: String, rootPath: String? = nil) {
        self.projectId = projectId
        self.name = name
        self.rootPath = rootPath
    }
}

public struct AttentionPlanProgress: Codable, Equatable, Sendable {
    public let completed: Int
    public let total: Int
    public let current: String?

    public init(completed: Int, total: Int, current: String? = nil) {
        self.completed = completed
        self.total = total
        self.current = current
    }
}

/// Mirrors ADE's tagged AttentionDestination contract while remaining forward-compatible.
public struct AttentionDestination: Codable, Equatable, Sendable {
    public let kind: String
    public let sessionId: String?
    public let itemId: String?
    public let eventId: String?
    public let prId: String?
    public let repoOwner: String?
    public let repoName: String?
    public let number: Int?
    public let tab: String?

    public init(
        kind: String,
        sessionId: String? = nil,
        itemId: String? = nil,
        eventId: String? = nil,
        prId: String? = nil,
        repoOwner: String? = nil,
        repoName: String? = nil,
        number: Int? = nil,
        tab: String? = nil
    ) {
        self.kind = kind
        self.sessionId = sessionId
        self.itemId = itemId
        self.eventId = eventId
        self.prId = prId
        self.repoOwner = repoOwner
        self.repoName = repoName
        self.number = number
        self.tab = tab
    }

    public var deepLink: String? {
        var components = URLComponents()
        components.scheme = "ade"

        if kind == "session", let sessionId {
            components.host = "session"
            components.path = "/\(sessionId)"
            components.queryItems = [
                itemId.map { URLQueryItem(name: "item", value: $0) },
                eventId.map { URLQueryItem(name: "event", value: $0) },
            ].compactMap { $0 }
            return components.url?.absoluteString
        }

        guard kind == "pull_request", let number else { return nil }
        components.host = "pr"
        if let repoOwner, let repoName {
            components.path = "/\(repoOwner)/\(repoName)/\(number)"
        } else {
            components.path = "/\(number)"
        }
        components.queryItems = [
            (tab != nil && tab != "overview") ? URLQueryItem(name: "tab", value: tab) : nil,
            eventId.map { URLQueryItem(name: "event", value: $0) },
        ].compactMap { $0 }
        return components.url?.absoluteString
    }
}

public struct AttentionAction: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let kind: String
    public let label: String
    public let destructive: Bool?
    public let payload: [String: AttentionJSONValue]?

    public init(
        id: String,
        kind: String,
        label: String,
        destructive: Bool? = nil,
        payload: [String: AttentionJSONValue]? = nil
    ) {
        self.id = id
        self.kind = kind
        self.label = label
        self.destructive = destructive
        self.payload = payload
    }

    public var opensDestination: Bool {
        switch kind {
        case "approve", "deny", "answer", "restart", "rerun_checks", "open":
            return true
        default:
            return false
        }
    }

    public var navigationLabel: String {
        switch kind {
        case "approve": return "Open to approve"
        case "deny": return "Open to deny"
        case "answer": return "Open to answer"
        case "restart": return "Open to restart"
        case "rerun_checks": return "Open to rerun checks"
        case "open": return "Open in ADE"
        default: return "Open in ADE"
        }
    }

    public var navigationAccessibilityHint: String {
        kind == "open"
            ? "Opens the exact item in ADE"
            : "\(navigationLabel) in ADE"
    }
}

/// Actions worth rendering *beside* the surface's own prominent "Open in ADE".
/// A plain `open` action renders with the identical label, so keeping it here
/// would draw the same button twice.
public func notchSecondaryActions(_ actions: [AttentionAction]) -> [AttentionAction] {
    actions.filter { $0.opensDestination && $0.kind != "open" }
}

public enum AttentionJSONValue: Codable, Equatable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case null

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else {
            self = .string(try container.decode(String.self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }
}

/// The chat-activity flavour of a running turn.
///
/// It exists because "planning" is a state the Activity glyph language names
/// (violet notepad) but `AttentionPhase` cannot carry — the phase vocabulary is
/// frozen push wire. Decoding is total in both directions a drift can come
/// from: a value this build has never heard of, and a value that is not even a
/// string, both land on `.unknown`, which every reader treats as absent and
/// falls back to the phase. Throwing here would cost the whole item.
public enum AttentionChatActivityMode: String, Codable, Equatable, Sendable {
    case planning
    case unknown

    public init(from decoder: Decoder) throws {
        guard let container = try? decoder.singleValueContainer(),
              let raw = try? container.decode(String.self) else {
            self = .unknown
            return
        }
        self = AttentionChatActivityMode(rawValue: raw) ?? .unknown
    }
}

public struct AttentionItem: Codable, Equatable, Sendable, Identifiable {
    public let contractVersion: Int
    public let id: String
    public let revision: Int
    public let fingerprint: String
    public let kind: String
    public let eventKind: String
    public let phase: String
    public let machine: AttentionMachine
    public let project: AttentionProject
    public let laneId: String?
    public let laneName: String?
    public let provider: String?
    public let model: String?
    /// Optional and additive: a publisher that never sets it leaves the item
    /// reading exactly as it does today.
    public let chatActivityMode: AttentionChatActivityMode?
    public let title: String
    public let preview: String
    public let privacyPreview: String
    public let detail: String?
    public let recentActivity: [String]?
    public let planProgress: AttentionPlanProgress?
    public let destination: AttentionDestination
    public let actions: [AttentionAction]
    public let occurredAt: String
    public let updatedAt: String
    /// Immutable for the life of a phase, so the row's elapsed ticker survives
    /// the cosmetic republishes that churn `updatedAt` every poll. Absent from
    /// publishers older than the Activity revamp — fall back to `occurredAt`.
    public let statusSince: String?
    /// `"signal" | "ambient" | "idle"`, decoded as a plain string so a tier
    /// this build has never heard of degrades instead of costing us the item.
    /// The wire name stays `activityTier`; `tier` is the local shorthand.
    public let activityTier: String?
    public let seenAt: String?
    public let dismissedAt: String?
    public let expiresAt: String?

    public var tier: String? { activityTier }

    /// Idle rows are disk-only roster history: quiet, never alerting, always
    /// filed under Done no matter what phase they preserved.
    public var isIdleTier: Bool { activityTier == "idle" }

    /// Only signal-tier rows may interrupt. Legacy items without a tier fall
    /// back to the phase test the surface has always used.
    public var isSignalTier: Bool {
        guard let activityTier else { return isAttention }
        return activityTier == "signal"
    }

    /// What "Working 3s" counts from. `updatedAt` is deliberately not a
    /// candidate: it churns on every cosmetic republish, so a ticker anchored
    /// to it would reset itself every poll.
    public var elapsedAnchor: String {
        statusSince?.notchNonEmpty ?? occurredAt
    }

    public init(
        contractVersion: Int = 1,
        id: String,
        revision: Int = 1,
        fingerprint: String,
        kind: String,
        eventKind: String,
        phase: String,
        machine: AttentionMachine,
        project: AttentionProject,
        laneId: String? = nil,
        laneName: String? = nil,
        provider: String? = nil,
        model: String? = nil,
        chatActivityMode: AttentionChatActivityMode? = nil,
        title: String,
        preview: String,
        privacyPreview: String,
        detail: String? = nil,
        recentActivity: [String]? = nil,
        planProgress: AttentionPlanProgress? = nil,
        destination: AttentionDestination,
        actions: [AttentionAction] = [],
        occurredAt: String,
        updatedAt: String,
        statusSince: String? = nil,
        activityTier: String? = nil,
        seenAt: String? = nil,
        dismissedAt: String? = nil,
        expiresAt: String? = nil
    ) {
        self.contractVersion = contractVersion
        self.id = id
        self.revision = revision
        self.fingerprint = fingerprint
        self.kind = kind
        self.eventKind = eventKind
        self.phase = phase
        self.machine = machine
        self.project = project
        self.laneId = laneId
        self.laneName = laneName
        self.provider = provider
        self.model = model
        self.chatActivityMode = chatActivityMode
        self.title = title
        self.preview = preview
        self.privacyPreview = privacyPreview
        self.detail = detail
        self.recentActivity = recentActivity
        self.planProgress = planProgress
        self.destination = destination
        self.actions = actions
        self.occurredAt = occurredAt
        self.updatedAt = updatedAt
        self.statusSince = statusSince
        self.activityTier = activityTier
        self.seenAt = seenAt
        self.dismissedAt = dismissedAt
        self.expiresAt = expiresAt
    }

    public var isAttention: Bool {
        switch phase {
        case "needs_you", "failed", "checks_failing", "changes_requested",
             "review_requested", "merge_ready":
            return true
        default:
            return false
        }
    }

    public var isCelebration: Bool {
        eventKind == "pr_merged" && phase == "merged" && seenAt == nil
    }

    /// The one optional field this build trusts from a publisher, checked at the
    /// boundary rather than believed: only the single literal counts, on a live
    /// agent turn. Anything else is absent and the phase decides.
    public var isPlanning: Bool {
        chatActivityMode == .planning
    }

    /// Someone has already dealt with this — on this Mac, on the phone, or in
    /// the web client. A takeover card for an acked row is a card about
    /// yesterday, so the surface drops it as soon as a snapshot says so.
    public var isAcknowledged: Bool {
        seenAt != nil || dismissedAt != nil
    }

    public var statusLabel: String {
        switch phase {
        case "starting": return "Starting"
        case "running": return "Working"
        case "needs_you": return "Needs you"
        case "blocked": return "Blocked"
        case "failed": return "Failed"
        case "checks_failing": return "Checks failing"
        case "changes_requested": return "Changes requested"
        case "review_requested": return "Review requested"
        case "merge_ready": return "Ready to merge"
        case "completed": return "Completed"
        case "merged": return "Merged"
        default:
            return phase.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    public func presentation(hideDetails: Bool) -> AttentionItemPresentation {
        if hideDetails {
            let genericTitle = kind == "pull_request" ? "Pull request update" : "Agent update"
            return AttentionItemPresentation(
                title: genericTitle,
                preview: privacyPreview,
                compactIdentity: "ADE",
                scopeLabel: "Private details hidden",
                recentActivity: [],
                planProgress: nil,
                celebrationTitle: genericTitle,
                accessibilitySummary: "\(statusLabel). \(privacyPreview)"
            )
        }

        let trimmedLane = laneName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let trimmedProject = project.name.trimmingCharacters(in: .whitespacesAndNewlines)
        let compactIdentity = !trimmedLane.isEmpty
            ? trimmedLane
            : (!trimmedProject.isEmpty ? trimmedProject : title)
        return AttentionItemPresentation(
            title: title,
            preview: preview,
            compactIdentity: compactIdentity,
            scopeLabel: "\(project.name) · \(machine.name)",
            recentActivity: recentActivity ?? [],
            planProgress: planProgress,
            celebrationTitle: title,
            accessibilitySummary: "\(statusLabel), \(title), \(project.name) on \(machine.name)"
        )
    }
}

public struct AttentionItemPresentation: Equatable, Sendable {
    public let title: String
    public let preview: String
    public let compactIdentity: String
    public let scopeLabel: String
    public let recentActivity: [String]
    public let planProgress: AttentionPlanProgress?
    public let celebrationTitle: String
    public let accessibilitySummary: String
}

/// Mirrors the renderer's `AttentionTone` union so a phase reads as the same
/// colour in the notch as it does in the Activity pane and header control.
public enum NotchStatusTone: String, Equatable, Sendable {
    case blue
    case amber
    case red
    case violet
    case cyan
    case emerald
    case neutral
}

/// Mirrors `PHASE_PRESENTATION` in
/// `apps/desktop/src/renderer/components/activity/activityPresentation.ts`.
public func notchStatusTone(for phase: String?) -> NotchStatusTone {
    switch phase {
    case "starting", "running", "open":
        return .blue
    case "needs_you", "blocked":
        return .amber
    case "failed", "checks_failing", "changes_requested":
        return .red
    case "review_requested":
        return .violet
    case "completed", "merged", "merge_ready":
        return .emerald
    default:
        return .neutral
    }
}

/// `3 items · 2 projects · 1 machine` — never `1 machines`.
public func attentionPluralized(_ count: Int, _ noun: String) -> String {
    "\(count) \(noun)\(count == 1 ? "" : "s")"
}

public func attentionScopeSummary(itemCount: Int, projectCount: Int, machineCount: Int) -> String {
    [
        attentionPluralized(itemCount, "item"),
        attentionPluralized(projectCount, "project"),
        attentionPluralized(machineCount, "machine"),
    ].joined(separator: " · ")
}

/// What the surface says when it has no item to show, or when the stream itself
/// is unhealthy. The surface stays visible in both cases: silently vanishing
/// reads as "nothing is happening" when the truth may be "we lost the stream".
public struct NotchStatusPresentation: Equatable, Sendable {
    public let title: String
    public let message: String
    public let hint: String?
    /// Fits a compact ear (~90pt at 9.5pt semibold).
    public let compactLabel: String
    public let tone: NotchStatusTone
    public let symbolName: String
    public let isProblem: Bool

    public init(
        title: String,
        message: String,
        hint: String?,
        compactLabel: String,
        tone: NotchStatusTone,
        symbolName: String,
        isProblem: Bool
    ) {
        self.title = title
        self.message = message
        self.hint = hint
        self.compactLabel = compactLabel
        self.tone = tone
        self.symbolName = symbolName
        self.isProblem = isProblem
    }
}

/// Returns `nil` only when there is nothing to say: items are present and the
/// stream is healthy.
public func notchStatusPresentation(
    availability: AttentionAvailability?,
    itemCount: Int
) -> NotchStatusPresentation? {
    if let availability, availability.isProblem {
        return problemPresentation(availability, itemCount: itemCount)
    }
    guard itemCount == 0 else { return nil }
    return NotchStatusPresentation(
        title: availability?.title.notchNonEmpty ?? "All clear",
        message: availability?.message.notchNonEmpty ?? "Nothing needs you.",
        hint: nil,
        compactLabel: "All clear",
        tone: .emerald,
        symbolName: "checkmark.circle",
        isProblem: false
    )
}

private func problemPresentation(
    _ availability: AttentionAvailability,
    itemCount: Int
) -> NotchStatusPresentation {
    let fallbackTitle: String
    let compactLabel: String
    let tone: NotchStatusTone
    let symbolName: String
    switch availability.state {
    case .degraded:
        fallbackTitle = "Activity is out of sync"
        compactLabel = "Reconnecting"
        tone = .amber
        symbolName = "antenna.radiowaves.left.and.right.slash"
    case .signedOut:
        fallbackTitle = "Signed out of ADE"
        compactLabel = "Sign in"
        tone = .amber
        symbolName = "person.crop.circle.badge.exclamationmark"
    case .unavailable:
        fallbackTitle = "Activity is unavailable"
        compactLabel = "Unavailable"
        tone = .red
        symbolName = "exclamationmark.triangle.fill"
    case .incompatible:
        fallbackTitle = "ADE needs an update"
        compactLabel = "Update ADE"
        tone = .red
        symbolName = "arrow.up.circle"
    case .unknown, .ready:
        fallbackTitle = "Activity status unknown"
        compactLabel = "Degraded"
        tone = .amber
        symbolName = "questionmark.circle"
    }

    let fallbackMessage = itemCount > 0
        ? "Showing the last state ADE received."
        : "ADE can't reach your account Activity stream."

    return NotchStatusPresentation(
        title: availability.title.notchNonEmpty ?? fallbackTitle,
        message: availability.message.notchNonEmpty ?? fallbackMessage,
        hint: recoveryHint(availability.recovery, hostName: availability.hostName),
        compactLabel: compactLabel,
        tone: tone,
        symbolName: symbolName,
        isProblem: true
    )
}

/// The helper only ever navigates, so recovery is phrased as guidance rather
/// than an action button the notch cannot actually perform.
private func recoveryHint(
    _ recovery: AttentionAvailabilityRecovery?,
    hostName: String?
) -> String? {
    let host = hostName?.notchNonEmpty
    switch recovery {
    case .retry:
        return "Retry from ADE to reconnect."
    case .signIn:
        return "Sign in to ADE to restore account Activity."
    case .updateHost:
        return host.map { "Update ADE on \($0)." } ?? "Update ADE to continue."
    case .restartHost:
        return host.map { "Restart ADE on \($0)." } ?? "Restart ADE to reconnect."
    case .unknown, .none:
        return nil
    }
}

extension String {
    /// Trimmed value, or `nil` when the host sent blank copy.
    var notchNonEmpty: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

/// Operational state of the account attention stream. Unknown codes decode to
/// `.unknown` so a newer host can never blind the helper.
public enum AttentionAvailabilityState: String, Codable, Equatable, Sendable {
    case ready
    case degraded
    case signedOut = "signed_out"
    case unavailable
    case incompatible
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = AttentionAvailabilityState(rawValue: raw) ?? .unknown
    }
}

public enum AttentionAvailabilityRecovery: String, Codable, Equatable, Sendable {
    case retry
    case signIn = "sign_in"
    case updateHost = "update_host"
    case restartHost = "restart_host"
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = AttentionAvailabilityRecovery(rawValue: raw) ?? .unknown
    }
}

/// Host-authored availability copy. Decoding is total: a partial or drifted
/// payload degrades to defaults instead of throwing away the whole snapshot.
public struct AttentionAvailability: Codable, Equatable, Sendable {
    public let state: AttentionAvailabilityState
    public let title: String
    public let message: String
    public let recovery: AttentionAvailabilityRecovery?
    public let hostName: String?

    public init(
        state: AttentionAvailabilityState,
        title: String = "",
        message: String = "",
        recovery: AttentionAvailabilityRecovery? = nil,
        hostName: String? = nil
    ) {
        self.state = state
        self.title = title
        self.message = message
        self.recovery = recovery
        self.hostName = hostName
    }

    private enum CodingKeys: String, CodingKey {
        case state, title, message, recovery, hostName
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        state = (try? container.decode(AttentionAvailabilityState.self, forKey: .state)) ?? .unknown
        title = ((try? container.decodeIfPresent(String.self, forKey: .title)) ?? nil) ?? ""
        message = ((try? container.decodeIfPresent(String.self, forKey: .message)) ?? nil) ?? ""
        recovery = (try? container.decodeIfPresent(AttentionAvailabilityRecovery.self, forKey: .recovery)) ?? nil
        let host = ((try? container.decodeIfPresent(String.self, forKey: .hostName)) ?? nil) ?? ""
        hostName = host.isEmpty ? nil : host
    }

    public var isProblem: Bool { state != .ready }
}

/// The whole account's shape, sent alongside a bounded projection of its items.
///
/// Load-bearing: the host publishes only the top-priority slice (48 rows) to
/// stay inside the pipe's byte budget, so "5 working · 2 need you · 61 total"
/// can only be honest if the totals travel separately from the rows.
public struct AttentionCounts: Codable, Equatable, Sendable {
    public let needsYou: Int
    /// Optional because they are the two newest counts on the wire: a host that
    /// predates them sends nothing, and `nil` means "this frame carries no
    /// account-wide figure for that group", which is not the same claim as `0`.
    /// Readers floor with them only when present, so an older host keeps
    /// exactly the behaviour it has today instead of being told it has none.
    public let failed: Int?
    public let planning: Int?
    public let working: Int
    public let done: Int
    public let total: Int
    public let machinesOnline: Int
    public let machinesTotal: Int

    public init(
        needsYou: Int = 0,
        failed: Int? = nil,
        planning: Int? = nil,
        working: Int = 0,
        done: Int = 0,
        total: Int = 0,
        machinesOnline: Int = 0,
        machinesTotal: Int = 0
    ) {
        self.needsYou = needsYou
        self.failed = failed.map { max(0, $0) }
        self.planning = planning.map { max(0, $0) }
        self.working = working
        self.done = done
        self.total = total
        self.machinesOnline = machinesOnline
        self.machinesTotal = machinesTotal
    }

    private enum CodingKeys: String, CodingKey {
        case needsYou, failed, planning, working, done, total, machinesOnline, machinesTotal
    }

    /// Totally decoding, like every other advisory block: a host that learns to
    /// send a ninth count, or forgets one, must not cost us the snapshot.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        func count(_ key: CodingKeys) -> Int {
            max(0, ((try? container.decodeIfPresent(Int.self, forKey: key)) ?? nil) ?? 0)
        }
        func optionalCount(_ key: CodingKeys) -> Int? {
            guard let value = (try? container.decodeIfPresent(Int.self, forKey: key)) ?? nil else {
                return nil
            }
            return max(0, value)
        }
        needsYou = count(.needsYou)
        failed = optionalCount(.failed)
        planning = optionalCount(.planning)
        working = count(.working)
        done = count(.done)
        total = count(.total)
        machinesOnline = count(.machinesOnline)
        machinesTotal = count(.machinesTotal)
    }

    /// How many rows the account has that this frame did not carry.
    public func overflow(shownItemCount: Int) -> Int {
        max(0, total - shownItemCount)
    }
}

/// Per-kind delight for an event that just happened, rendered as a transient
/// rather than a row. `celebration` and `alert` drive the two presentations the
/// surface already knows how to animate; `success` and `info` ride the alert
/// machinery with a calmer tone.
public enum NotchToastTreatment: String, Codable, Equatable, Sendable, CaseIterable {
    case celebration
    case success
    case alert
    case info

    /// A treatment this build has never heard of reads as ordinary news rather
    /// than throwing — a decode failure here would be reported to the host as a
    /// protocol error and latch the helper into "needs an update".
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = NotchToastTreatment(rawValue: raw) ?? .info
    }

    /// Only a merge earns the confetti; everything else rides the flash card.
    public var presentation: NotchPresentationState {
        self == .celebration ? .celebration : .flash
    }

    public var defaultTone: NotchStatusTone {
        switch self {
        case .celebration, .success: return .emerald
        case .alert: return .amber
        case .info: return .blue
        }
    }

    /// How long the takeover owns the surface. A needs-you card is the one
    /// place the notch is actionable, so it gets long enough to read and act on
    /// (~10s) before it morphs back into its amber glyph; a merge card outlives
    /// its ~1s confetti burst and settles; ordinary news is briefer still.
    public var defaultDurationMs: Int {
        switch self {
        case .celebration: return 3_000
        case .alert: return 10_000
        case .success, .info: return 5_000
        }
    }
}

public struct AttentionToast: Codable, Equatable, Sendable {
    public let itemId: String?
    public let eventKind: String
    public let treatment: NotchToastTreatment
    public let title: String
    public let subtitle: String?
    public let tone: String?
    public let durationMs: Int?

    public init(
        itemId: String? = nil,
        eventKind: String,
        treatment: NotchToastTreatment,
        title: String,
        subtitle: String? = nil,
        tone: String? = nil,
        durationMs: Int? = nil
    ) {
        self.itemId = itemId
        self.eventKind = eventKind
        self.treatment = treatment
        self.title = title
        self.subtitle = subtitle
        self.tone = tone
        self.durationMs = durationMs
    }

    /// Host-chosen hue when it sent one, otherwise the treatment's own.
    public var resolvedTone: NotchStatusTone {
        tone.flatMap { NotchStatusTone(rawValue: $0) } ?? treatment.defaultTone
    }

    /// Clamped so a drifted host cannot pin the surface open, or flash it so
    /// briefly that it reads as a glitch.
    public var resolvedDurationMs: Int {
        guard let durationMs else { return treatment.defaultDurationMs }
        return max(800, min(15_000, durationMs))
    }
}

public struct AttentionSnapshot: Codable, Equatable, Sendable {
    public let contractVersion: Int
    /// Revisions are monotonic only within one stream. Account switches and
    /// fallback ownership changes intentionally replace this opaque identity.
    public let streamId: String?
    public let revision: Int
    public let generatedAt: String
    public let items: [AttentionItem]
    public let availability: AttentionAvailability?
    /// The account's real totals, independent of how many rows this frame
    /// carried. Absent from hosts older than the Activity revamp, in which case
    /// the surface counts what it can see.
    public let counts: AttentionCounts?

    public init(
        contractVersion: Int = 1,
        streamId: String? = nil,
        revision: Int,
        generatedAt: String,
        items: [AttentionItem],
        availability: AttentionAvailability? = nil,
        counts: AttentionCounts? = nil
    ) {
        self.contractVersion = contractVersion
        self.streamId = streamId
        self.revision = revision
        self.generatedAt = generatedAt
        self.items = items
        self.availability = availability
        self.counts = counts
    }

    private enum CodingKeys: String, CodingKey {
        case contractVersion, streamId, revision, generatedAt, items, availability, counts
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        contractVersion = try container.decode(Int.self, forKey: .contractVersion)
        let decodedStreamId =
            ((try? container.decodeIfPresent(String.self, forKey: .streamId)) ?? nil)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        streamId = decodedStreamId?.isEmpty == false ? decodedStreamId : nil
        revision = try container.decode(Int.self, forKey: .revision)
        generatedAt = try container.decode(String.self, forKey: .generatedAt)
        items = try container.decode([AttentionItem].self, forKey: .items)
        // Availability is advisory chrome. Never fail a snapshot over it.
        availability = (try? container.decodeIfPresent(AttentionAvailability.self, forKey: .availability)) ?? nil
        counts = (try? container.decodeIfPresent(AttentionCounts.self, forKey: .counts)) ?? nil
    }

    /// The counts the host sent, or an honest tally of the rows on hand when it
    /// sent none. Never invents an overflow it cannot see.
    ///
    /// Tallied through the same five-way table the strip and the panel file
    /// rows under, and agent-only for the same reason the host's block is: a
    /// pull request is not "planning", and its `total` is the session figure.
    /// A group with no rows stays absent rather than becoming a `0` the strip
    /// would then floor against.
    public func resolvedCounts() -> AttentionCounts {
        if let counts { return counts }
        let tally = notchStripTally(items)
        var online = Set<String>()
        var machines = Set<String>()
        for item in items where item.dismissedAt == nil {
            machines.insert(item.machine.machineKey)
            if item.machine.online { online.insert(item.machine.machineKey) }
        }
        return AttentionCounts(
            needsYou: tally[.needsYou] ?? 0,
            failed: tally[.failed],
            planning: tally[.planning],
            working: tally[.working] ?? 0,
            done: tally[.done] ?? 0,
            total: tally.values.reduce(0, +),
            machinesOnline: online.count,
            machinesTotal: machines.count
        )
    }
}

public enum AttentionSnapshotAcceptance: Equatable, Sendable {
    /// The helper should replace its item set. `resetPresentationState` marks
    /// an ownership/stream boundary, where old fingerprints must not trigger
    /// alerts or celebrations in the newly selected account.
    case accepted(resetPresentationState: Bool)
    case rejectedStale
}

/// Native-side final defense against a delayed snapshot rolling the ambient
/// surface backward. Relay revisions are only comparable inside `streamId`;
/// legacy frames without one fall back to their host timestamp.
public struct AttentionSnapshotCursor: Equatable, Sendable {
    private var streamId: String?
    private var revision: Int?
    private var generatedAt: Date?

    public init() {}

    public mutating func accept(_ snapshot: AttentionSnapshot) -> AttentionSnapshotAcceptance {
        let incomingGeneratedAt = parseAttentionDate(snapshot.generatedAt)
        let streamChanged = revision != nil
            && streamId != snapshot.streamId
            && (streamId != nil || snapshot.streamId != nil)
        let sameAuthenticatedStream = streamId != nil && streamId == snapshot.streamId

        if sameAuthenticatedStream,
           let revision, snapshot.revision < revision {
            return .rejectedStale
        }
        // Across stream/account boundaries revisions are intentionally
        // incomparable. The host timestamp prevents a delayed frame from the
        // previous account switching the helper back after the new one won.
        if !sameAuthenticatedStream,
           let generatedAt, let incomingGeneratedAt,
           incomingGeneratedAt < generatedAt {
            return .rejectedStale
        }

        let resetPresentationState = streamChanged
            || (revision != nil && snapshot.revision < (revision ?? snapshot.revision))
        streamId = snapshot.streamId
        revision = snapshot.revision
        generatedAt = incomingGeneratedAt
        return .accepted(resetPresentationState: resetPresentationState)
    }
}

/// When the compact strip is on the menu bar. Nothing else.
///
/// The two modes are deliberately indistinguishable once the strip is on
/// screen: both render the identical compact chrome at the identical rect, and
/// in both a click — and only a click — opens the full panel. The retired
/// `minimal`/`click` values described a third "peek" layout that no longer
/// exists, and hover used to reveal into the *expanded* rect, which is why the
/// same feature looked like two different products.
public enum NotchRevealMode: String, Codable, Equatable, Sendable, CaseIterable {
    /// The strip is pinned to the menu bar.
    case always
    /// The strip is dormant until the pointer enters the top-edge hot zone,
    /// then appears exactly as it does in `always`.
    case hover

    /// Total decoding, and legacy-aware: `minimal` and `click` both kept a
    /// strip on screen at rest, so both land on `always` rather than silently
    /// hiding a surface the user had pinned. Anything unrecognised keeps
    /// today's default instead of costing the helper the settings frame.
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = NotchRevealMode(legacyRawValue: raw)
    }

    public init(legacyRawValue: String) {
        switch legacyRawValue {
        case "always", "minimal", "click":
            self = .always
        case "hover":
            self = .hover
        default:
            self = .hover
        }
    }

    public var menuTitle: String {
        switch self {
        case .always: return "Always show"
        case .hover: return "Show on hover"
        }
    }
}

public struct NotchSettings: Codable, Equatable, Sendable {
    public var enabled: Bool
    public var revealMode: NotchRevealMode
    /// When false the tall panel is never drawn, so the surface can never grow
    /// far enough to sit over menu-bar content. A click still does something:
    /// it opens Activity in ADE instead of growing the notch.
    public var expandedPanelEnabled: Bool
    public var preferredDisplayId: UInt32?
    public var hideDetails: Bool
    public var celebrationsEnabled: Bool
    public var soundsEnabled: Bool

    public init(
        enabled: Bool = false,
        revealMode: NotchRevealMode = .hover,
        expandedPanelEnabled: Bool = true,
        preferredDisplayId: UInt32? = nil,
        hideDetails: Bool = true,
        celebrationsEnabled: Bool = true,
        soundsEnabled: Bool = false
    ) {
        self.enabled = enabled
        self.revealMode = revealMode
        self.expandedPanelEnabled = expandedPanelEnabled
        self.preferredDisplayId = preferredDisplayId
        self.hideDetails = hideDetails
        self.celebrationsEnabled = celebrationsEnabled
        self.soundsEnabled = soundsEnabled
    }

    private enum CodingKeys: String, CodingKey {
        case enabled, revealMode, expandedPanelEnabled, preferredDisplayId
        case hideDetails, celebrationsEnabled, soundsEnabled
    }

    /// Decoding is total, and forward/backward compatible in both directions: a
    /// host that predates a key keeps the private, silent defaults of a fresh
    /// launch, and the retired `automaticRevealEnabled` / `tickerEnabled` keys a
    /// host may still be sending are simply not read — the behaviours they
    /// gated no longer exist.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let defaults = NotchSettings()
        enabled = ((try? container.decodeIfPresent(Bool.self, forKey: .enabled)) ?? nil)
            ?? defaults.enabled
        revealMode = ((try? container.decodeIfPresent(NotchRevealMode.self, forKey: .revealMode)) ?? nil)
            ?? defaults.revealMode
        expandedPanelEnabled = ((try? container.decodeIfPresent(Bool.self, forKey: .expandedPanelEnabled)) ?? nil)
            ?? defaults.expandedPanelEnabled
        preferredDisplayId = (try? container.decodeIfPresent(UInt32.self, forKey: .preferredDisplayId)) ?? nil
        hideDetails = ((try? container.decodeIfPresent(Bool.self, forKey: .hideDetails)) ?? nil)
            ?? defaults.hideDetails
        celebrationsEnabled = ((try? container.decodeIfPresent(Bool.self, forKey: .celebrationsEnabled)) ?? nil)
            ?? defaults.celebrationsEnabled
        soundsEnabled = ((try? container.decodeIfPresent(Bool.self, forKey: .soundsEnabled)) ?? nil)
            ?? defaults.soundsEnabled
    }
}

/// Settings changes exposed by the native surface's context menu. Keeping the
/// mapping in the core target makes every presentation surface apply identical
/// changes and lets the wire-level behaviour stay covered without AppKit.
public enum NotchSettingsMenuAction: Equatable, Sendable {
    case setRevealMode(NotchRevealMode)
    case toggleHideDetails
    case toggleCelebrations
    case hide
}

public func applyingNotchSettingsMenuAction(
    _ action: NotchSettingsMenuAction,
    to settings: NotchSettings
) -> NotchSettings {
    var next = settings
    switch action {
    case .setRevealMode(let revealMode):
        next.revealMode = revealMode
    case .toggleHideDetails:
        next.hideDetails.toggle()
    case .toggleCelebrations:
        next.celebrationsEnabled.toggle()
    case .hide:
        next.enabled = false
    }
    return next
}

public enum NotchInput: Equatable, Sendable {
    case snapshot(AttentionSnapshot)
    case settings(NotchSettings)
    case toast(AttentionToast)
    case visibility(Bool)
    case reanchor
    case quit
    case ignored
}

private struct CommandEnvelope: Decodable {
    let type: String
    let snapshot: AttentionSnapshot?
    let settings: NotchSettings?
    let toast: AttentionToast?
    let visible: Bool?
}

public enum NotchInputDecoder {
    public static func decode(line: String, decoder: JSONDecoder = JSONDecoder()) throws -> NotchInput {
        let data = Data(line.utf8)
        if let envelope = try? decoder.decode(CommandEnvelope.self, from: data) {
            switch envelope.type {
            case "snapshot":
                guard let snapshot = envelope.snapshot else { throw NotchProtocolError.missingPayload("snapshot") }
                return .snapshot(snapshot)
            case "settings":
                guard let settings = envelope.settings else { throw NotchProtocolError.missingPayload("settings") }
                return .settings(settings)
            case "toast":
                guard let toast = envelope.toast else { throw NotchProtocolError.missingPayload("toast") }
                return .toast(toast)
            case "visibility":
                guard let visible = envelope.visible else { throw NotchProtocolError.missingPayload("visible") }
                return .visibility(visible)
            case "reanchor": return .reanchor
            case "quit": return .quit
            default: return .ignored
            }
        }
        return .snapshot(try decoder.decode(AttentionSnapshot.self, from: data))
    }
}

public enum NotchProtocolError: Error, Equatable {
    case missingPayload(String)
}

public struct NotchOutput: Encodable, Equatable, Sendable {
    public let type: String
    public let itemId: String?
    public let action: AttentionAction?
    public let destination: AttentionDestination?
    public let deepLink: String?
    public let message: String?
    public let displayId: UInt32?
    public let surface: String?
    public let settings: NotchSettings?

    public init(
        type: String,
        itemId: String? = nil,
        action: AttentionAction? = nil,
        destination: AttentionDestination? = nil,
        deepLink: String? = nil,
        message: String? = nil,
        displayId: UInt32? = nil,
        surface: String? = nil,
        settings: NotchSettings? = nil
    ) {
        self.type = type
        self.itemId = itemId
        self.action = action
        self.destination = destination
        self.deepLink = deepLink
        self.message = message
        self.displayId = displayId
        self.surface = surface
        self.settings = settings
    }
}
