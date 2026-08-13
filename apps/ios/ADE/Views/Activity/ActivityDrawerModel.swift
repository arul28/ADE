import Combine
import Foundation
import SwiftUI

/// The two buckets the whole product now agrees on.
///
/// Sessions is "what are my agents doing"; Inbox is "what arrived and wants an
/// acknowledgement" — PR and CI traffic plus outcomes nobody has looked at.
/// The old third bucket, Recent, is gone: a time-ordered pile of things that
/// already resolved is not a bucket, it is a scroll.
public enum ActivityBucket: String, CaseIterable, Hashable, Sendable {
    case sessions
    case inbox

    public var title: String {
        switch self {
        case .sessions: return "Sessions"
        case .inbox: return "Inbox"
        }
    }
}

/// Where the currently rendered rows came from. The drawer needs this to tell
/// "genuinely all clear" apart from "we could not reach anything" — two states
/// that used to render the same empty screen.
public enum ActivitySource: Hashable, Sendable {
    /// A signed-in account snapshot, fresh enough to trust.
    case account
    /// This machine's local workspace snapshot only.
    case machineFallback
    /// Nothing at all — no account snapshot, no local snapshot.
    case none
}

/// One rendered line in a bucket: a row, or the divider that explains why the
/// rows beneath it are dimmed.
public enum ActivityListEntry: Identifiable, Hashable, Sendable {
    case offlineMachine(machineKey: String, name: String, lastSeenLabel: String?)
    case row(ActivityRowPresentation)

    public var id: String {
        switch self {
        case .offlineMachine(let machineKey, _, _): return "offline:\(machineKey)"
        case .row(let row): return row.id
        }
    }
}

/// One heading's worth of rows.
///
/// Keyed by `ActivityStateGroup`, not by the three-case `ActivityBand` it used
/// to use. The band folds failure into "needs you" and everything resting into
/// "done", so a drawer sectioned by it showed ten unrelated rows under one
/// heading — the state the Activity sheet was in when this was rewritten. The
/// state group is the vocabulary every other surface counts by, so sectioning
/// by it also means the headings and the glyph strip can never disagree.
public struct ActivitySection: Identifiable, Hashable, Sendable {
    public let group: ActivityStateGroup
    public let rows: [ActivityRowPresentation]
    public let entries: [ActivityListEntry]

    public var id: String { group.rawValue }
    public var title: String { group.label }
    public var count: Int { rows.count }
}

/// A nonzero state bucket for the drawer's glyph strip. Same shape the widget
/// and the island use, so all three read from one tally.
public struct ActivityGroupCount: Identifiable, Hashable, Sendable {
    public let group: ActivityStateGroup
    public let count: Int

    public var id: String { group.rawValue }
}

/// Source of truth for the in-app Activity drawer.
///
/// Reducer-only: it never opens its own transport. It prefers the account-wide
/// snapshot written to the App Group and falls back to `SyncService`'s current
/// workspace snapshot, projecting both through the same
/// `AccountAttentionItem` → `ActivityRowPresentation` path so a locally-derived
/// row and an account row can never look different.
///
/// Persistence keys are deliberately unchanged from the Attention era: they are
/// user state, not naming.
@MainActor
public final class ActivityDrawerModel: ObservableObject {
    /// Agent-kind rows, priority-flat: needs you → working → done.
    @Published public private(set) var sessions: [ActivityRowPresentation] = []
    /// PR/CI traffic plus outcomes nobody has looked at yet.
    @Published public private(set) var inbox: [ActivityRowPresentation] = []
    /// Machine presence from the snapshot, for the offline banners.
    @Published public private(set) var machines: [AccountAttentionMachine] = []
    /// Where each offline machine's work lives, so a surface scoped to one
    /// project — the Work list — can tell whether the outage touches it. The
    /// drawer itself banners per row and does not need this.
    @Published public private(set) var offlineScopes: [ActivityOfflineScope] = []
    @Published public private(set) var unreadCount: Int = 0
    @Published public private(set) var source: ActivitySource = .none
    /// Which single state the reader has narrowed to, or nil for all of them.
    /// Deliberately single-select: the glyph strip is the control, and a strip
    /// where several glyphs can be lit reads as a status display that has gone
    /// wrong rather than as a filter that is on.
    @Published public var stateFilter: ActivityStateGroup?
    /// Whether the resting bands (idle, done) are rendered inline.
    @Published public var restingExpanded: Bool = false
    /// The relay capped the account feed. Surfaced so the drawer can say so
    /// rather than quietly showing a partial list.
    @Published public private(set) var itemsTruncated: Bool = false

    public static let lastSeenAtKey = "ade.attention.lastSeenAt"
    public static let dismissedItemIDsKey = "ade.attention.dismissedItemIDs"
    public static let seenItemIDsKey = "ade.attention.seenItemIDs"

    private var lastSeenAt: Date {
        didSet {
            defaults.set(
                lastSeenAt.timeIntervalSince1970,
                forKey: Self.lastSeenAtKey
            )
            recomputeUnreadCount()
        }
    }

    private let defaults: UserDefaults
    private var dismissedItemIDs: Set<String>
    private var seenItemIDs: Set<String>

    public init(defaults: UserDefaults = ADESharedContainer.defaults) {
        self.defaults = defaults
        let stored = defaults.double(forKey: Self.lastSeenAtKey)
        self.lastSeenAt = stored > 0
            ? Date(timeIntervalSince1970: stored)
            : .distantPast
        self.dismissedItemIDs = Set(defaults.stringArray(forKey: Self.dismissedItemIDsKey) ?? [])
        self.seenItemIDs = Set(defaults.stringArray(forKey: Self.seenItemIDsKey) ?? [])
    }

    // MARK: - Reducer

    /// Rebuild from the account-level contract — the real path once signed in.
    ///
    /// `live`, when present, is this phone's own view of the machine it is
    /// paired to, and it WINS for that machine. The account feed is a 20-second
    /// REST poll of rows each machine's brain published, so it lags, and it
    /// goes quiet entirely when a brain is signed out or a scope is detached.
    /// This method used to not exist: the caller returned early on any account
    /// snapshot fetched within 24 hours, and since `generatedAt` is the relay's
    /// clock at fetch time it is ALWAYS within 24 hours while online. The live
    /// snapshot was therefore unreachable whenever the user was signed in —
    /// which is how the home dropdown could show a working Claude session at
    /// the same instant this drawer showed only week-old idle rows.
    ///
    /// Scope is deliberately narrow: only the live machine's own rows are
    /// replaced. Every other machine keeps its relay rows, so the feed stays
    /// account-wide.
    public func rebuild(
        from snapshot: AccountAttentionSnapshot,
        live: WorkspaceSnapshot? = nil
    ) {
        let now = Date()
        let active = snapshot.items.filter { item in
            item.dismissedAt == nil
                && (item.expiresAt.map { $0 > now } ?? true)
        }
        var machines = snapshot.machines ?? []
        var items = active

        if let live {
            // Identity is preferred, not required. When the live snapshot names
            // a machine we can also retire that machine's OTHER relay rows —
            // sessions it no longer has. When it does not, we merge on session
            // identity alone and leave the rest of the feed untouched.
            //
            // This used to bail out entirely on a missing `machineId`, which
            // sounded conservative and was the bug: nothing ever populated that
            // field, so EVERY refresh discarded the live rows and rendered the
            // relay's stale copy. The Hub read the socket directly and showed
            // four agents working while this sheet, at the same instant, showed
            // none. Degrading to a narrower merge is always better than
            // degrading to stale data.
            let liveMachine = Self.liveMachine(from: live, knownTo: machines)
            let liveItems = Self.accountItems(
                from: live,
                machine: liveMachine ?? Self.unidentifiedLiveMachine(from: live)
            )
            // Session identity is the net that always applies: the live
            // projection ids rows `live:<sessionId>` while the relay ids the
            // same chat `agent:<machineKey>:<sessionId>`, so without it one
            // session renders twice under two id schemes.
            let replacedSessions = Set(liveItems.compactMap(Self.sessionId))
            let replacedKeys = liveMachine.map(Self.machineIdentity) ?? []

            items = active.filter { item in
                // PR rows are account-scoped GitHub state the paired host does
                // not publish; dropping them would empty the Inbox every time
                // the phone connected to a machine.
                if item.kind == .pullRequest { return true }
                if let session = Self.sessionId(item), replacedSessions.contains(session) {
                    return false
                }
                guard !replacedKeys.isEmpty else { return true }
                return Self.machineIdentity(item.machine).isDisjoint(with: replacedKeys)
            } + liveItems

            if let liveMachine {
                machines = machines.filter {
                    Self.machineIdentity($0).isDisjoint(with: replacedKeys)
                } + [liveMachine]
            }
        }

        apply(
            items: items,
            machines: machines,
            source: .account,
            truncated: snapshot.itemsTruncated ?? false,
            // Rows we replaced with live ones DO own inline actions, but the
            // flag is per-apply rather than per-row, and the account rows in
            // the same list do not. Keeping it false is the safe direction: a
            // missing Approve button is a smaller failure than one that fires
            // at a machine which cannot service it.
            inlineActionsAllowed: false
        )
    }

    /// The chat this row is about, when it is about one. Pull requests have no
    /// session, and an unrecognised destination must not collapse into a shared
    /// `nil` key that would dedupe unrelated rows against each other.
    static func sessionId(_ item: AccountAttentionItem) -> String? {
        guard case .session(let sessionId, _, _) = item.destination else { return nil }
        let trimmed = sessionId.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// Every identity string that may stand for one physical machine.
    ///
    /// A machine has two keys in this system — the push-registration
    /// `machineKey` the publisher stamps on items, and the account-directory
    /// `accountMachineKey` the sync layer knows it by — and they are not the
    /// same value. Matching on either is what stops one Mac appearing twice.
    static func machineIdentity(_ machine: AccountAttentionMachine) -> Set<String> {
        var keys: Set<String> = []
        if let key = nonEmpty(machine.machineKey) { keys.insert(key) }
        if let key = nonEmpty(machine.accountMachineKey) { keys.insert(key) }
        return keys
    }

    /// A stand-in for the machine a live snapshot could not name.
    ///
    /// Only used to give the projected rows a machine to hang presence and a
    /// display name off. It is deliberately NOT added to the roster: an
    /// invented key would draw an offline banner for a machine that does not
    /// exist, and would not match any relay row anyway.
    static func unidentifiedLiveMachine(from snapshot: WorkspaceSnapshot) -> AccountAttentionMachine {
        AccountAttentionMachine(
            machineKey: "live:unidentified",
            name: nonEmpty(snapshot.machineName) ?? "This computer",
            online: snapshot.connection.lowercased() != "disconnected",
            lastSeenAt: snapshot.generatedAt
        )
    }

    /// The live snapshot's machine, resolved against the account roster so it
    /// carries the roster's presence and display name where one exists.
    /// Returns nil when the live snapshot names no machine at all — without an
    /// identity there is nothing to scope the replacement to, and replacing
    /// "every machine" would delete the rest of the account's feed.
    static func liveMachine(
        from snapshot: WorkspaceSnapshot,
        knownTo roster: [AccountAttentionMachine]
    ) -> AccountAttentionMachine? {
        guard let machineId = nonEmpty(snapshot.machineId) else { return nil }
        let online = snapshot.connection.lowercased() != "disconnected"
        let known = roster.first { machineIdentity($0).contains(machineId) }
        return AccountAttentionMachine(
            machineKey: known?.machineKey ?? machineId,
            accountMachineKey: known?.accountMachineKey,
            // Prefer the roster's name: the publisher resolves the OS display
            // name ("Arul's Mac Studio"), which is what the user recognises.
            name: known?.name
                ?? nonEmpty(snapshot.machineName)
                ?? "Connected computer",
            online: online,
            lastSeenAt: snapshot.generatedAt
        )
    }

    /// Rebuild from this machine's workspace snapshot. Projected into the same
    /// account item shape first, so the fallback path shares every rule above
    /// it instead of maintaining a parallel one.
    public func rebuild(from snapshot: WorkspaceSnapshot) {
        let machine = AccountAttentionMachine(
            machineKey: Self.nonEmpty(snapshot.machineId) ?? "current-machine",
            name: Self.nonEmpty(snapshot.machineName) ?? "Connected computer",
            online: snapshot.connection.lowercased() != "disconnected",
            lastSeenAt: snapshot.generatedAt
        )
        apply(
            items: Self.accountItems(from: snapshot, machine: machine),
            machines: [machine],
            source: .machineFallback,
            truncated: false,
            // These rows belong to the paired host, so inline App Intents are
            // pointed at the machine that actually owns them.
            inlineActionsAllowed: true
        )
    }

    /// Clear everything — used when no snapshot of any kind is available, so an
    /// empty drawer reports "no source" rather than "all clear".
    public func clearAll() {
        sessions = []
        inbox = []
        machines = []
        offlineScopes = []
        source = .none
        itemsTruncated = false
        recomputeUnreadCount()
    }

    private func apply(
        items: [AccountAttentionItem],
        machines: [AccountAttentionMachine],
        source: ActivitySource,
        truncated: Bool,
        inlineActionsAllowed: Bool
    ) {
        let rows = items.map {
            ActivityRowPresentation(item: $0, inlineActionsAllowed: inlineActionsAllowed)
        }
        pruneDismissedItems(activeIDs: Set(rows.map(\.id)))
        let visible = rows.filter { !dismissedItemIDs.contains($0.id) }

        sessions = visible
            .filter { !$0.isPullRequest }
            .sortedByActivityPriority()
        // PR/CI traffic always files here; agent rows join it only once they
        // have finished and nobody has looked — which is exactly the set that
        // would otherwise be a push nobody can act on.
        inbox = visible
            .filter { $0.isPullRequest || ($0.needsInbox && $0.band == .done) }
            .sortedByActivityPriority()
        self.machines = machines
        offlineScopes = Self.offlineScopes(from: items)
        self.source = source
        itemsTruncated = truncated
        pruneSeenItems(activeIDs: Set(rows.map(\.id)))
        recomputeUnreadCount()

        // The drawer is where the account feed and the live paired-host view
        // have already been merged and de-duplicated, which makes it the only
        // place that holds the truth the Live Activity wants. Handing it
        // straight over is what makes the island real-time: without this the
        // island could only ever show what the relay last thought was worth an
        // APNs push, which for a working count is "nothing".
        LiveActivityService.shared.refreshLocalContent(items: items)
    }

    // MARK: - Derived views

    /// One count per nonzero state group, in priority order — the drawer's
    /// glyph strip, and the thing the filter chips are built from. Computed
    /// from the UNFILTERED session list on purpose: a filter that hides its own
    /// counts cannot be turned off again.
    public var groupCounts: [ActivityGroupCount] {
        var tally: [ActivityStateGroup: Int] = [:]
        for row in sessions { tally[row.stateGroup, default: 0] += 1 }
        return ActivityStateGroup.allCases
            .sorted { $0.rank < $1.rank }
            .compactMap { group in
                guard let count = tally[group], count > 0 else { return nil }
                return ActivityGroupCount(group: group, count: count)
            }
    }

    /// What the strip renders: the nonzero groups, plus the selected one even
    /// when it has emptied out.
    ///
    /// Without that second clause, filtering to "needs you" and then answering
    /// the last question removes the only lit chip from the strip — leaving the
    /// reader in a filtered empty state with no visible control to leave it.
    public var stripCounts: [ActivityGroupCount] {
        let counts = groupCounts
        guard let stateFilter, !counts.contains(where: { $0.group == stateFilter }) else {
            return counts
        }
        return (counts + [ActivityGroupCount(group: stateFilter, count: 0)])
            .sorted { $0.group.rank < $1.group.rank }
    }

    /// Sessions grouped by state, each carrying its offline-machine dividers.
    ///
    /// When a state filter is on, only that section is returned. When it is
    /// off, the two resting bands collapse into one summary line unless the
    /// reader has expanded them — on a real account idle and done are most of
    /// the list, and letting them render inline is what buried the two rows
    /// that actually wanted a human.
    public var sessionSections: [ActivitySection] {
        let ordered = ActivityStateGroup.allCases.sorted { $0.rank < $1.rank }
        let visible = ordered.filter { group in
            guard let stateFilter else {
                return !group.isResting || restingExpanded
            }
            return group == stateFilter
        }
        return visible.compactMap { group in
            let rows = sessions.filter { $0.stateGroup == group }
            guard !rows.isEmpty else { return nil }
            return ActivitySection(group: group, rows: rows, entries: Self.entries(for: rows))
        }
    }

    /// The collapsed stand-in for the resting bands: "6 idle · 10 done".
    /// `nil` when there is nothing resting, or when the reader has expanded
    /// them, or while a filter is on (a filter already picked a single band).
    public var restingSummary: [ActivityGroupCount]? {
        guard stateFilter == nil, !restingExpanded else { return nil }
        let resting = groupCounts.filter { $0.group.isResting }
        return resting.isEmpty ? nil : resting
    }

    public var inboxEntries: [ActivityListEntry] {
        Self.entries(for: inbox)
    }

    public var isEmpty: Bool { sessions.isEmpty && inbox.isEmpty }

    public func rows(in bucket: ActivityBucket) -> [ActivityRowPresentation] {
        switch bucket {
        case .sessions: return sessions
        case .inbox: return inbox
        }
    }

    /// Ids currently on screen, for the presence ping. Capped the same way the
    /// relay caps its side of the call.
    public var visibleItemIds: [String] {
        Array((sessions + inbox).map(\.id).prefix(64))
    }

    /// Count label for the bell. `nil` at zero, `"9+"` past nine so the 16pt
    /// circle never grows past two glyphs.
    public var badgeLabel: String? {
        guard unreadCount > 0 else { return nil }
        return unreadCount > 9 ? "9+" : "\(unreadCount)"
    }

    // MARK: - Acknowledgements

    /// Per-item dismiss — the affordance iOS never had. Optimistic locally, and
    /// durable in `AccountService`'s pending-ack queue if the relay is out of
    /// reach, so the intent survives a refresh.
    public func dismiss(_ itemId: String) {
        dismissedItemIDs.insert(itemId)
        persistDismissedItems()
        sessions.removeAll { $0.id == itemId }
        inbox.removeAll { $0.id == itemId }
        recomputeUnreadCount()
        Task { await AccountService.shared.acknowledgeAttentionItems([itemId], dismiss: true) }
    }

    public func markSeen(_ itemId: String) {
        seenItemIDs.insert(itemId)
        persistSeenItems()
        recomputeUnreadCount()
        Task { await AccountService.shared.acknowledgeAttentionItems([itemId], dismiss: false) }
    }

    /// Mark every visible row seen. Rows stay listed — the underlying work has
    /// not changed — but the bell stops asking.
    public func markAllSeen() {
        lastSeenAt = Date()
        let ids = (sessions + inbox).filter { $0.seenAt == nil }.map(\.id)
        seenItemIDs.formUnion(ids)
        persistSeenItems()
        recomputeUnreadCount()
        guard !ids.isEmpty else { return }
        Task { await AccountService.shared.acknowledgeAttentionItems(ids, dismiss: false) }
    }

    /// Bulk dismiss for one bucket. Scoped to the ids on screen and pruned once
    /// the backing state clears, so a future regression reappears.
    public func dismissVisible(in bucket: ActivityBucket) {
        let ids = rows(in: bucket).map(\.id)
        guard !ids.isEmpty else { return }
        dismissedItemIDs.formUnion(ids)
        persistDismissedItems()
        let dismissed = Set(ids)
        sessions.removeAll { dismissed.contains($0.id) }
        inbox.removeAll { dismissed.contains($0.id) }
        recomputeUnreadCount()
        Task { await AccountService.shared.acknowledgeAttentionItems(ids, dismiss: true) }
    }

    // MARK: - Private

    /// The bell counts one thing: rows in the needs-you band, at signal tier,
    /// that have not been dismissed or already looked at. Ambient work in
    /// flight is visible in the drawer and never on the badge.
    private func recomputeUnreadCount() {
        unreadCount = sessions.filter { row in
            row.band == .needsYou
                && row.tier == .signal
                && row.seenAt == nil
                && !seenItemIDs.contains(row.id)
                && row.updatedAt > lastSeenAt
        }.count
    }

    /// Online rows first; then one banner per offline machine followed by its
    /// rows, so the explanation always precedes the dimmed run it explains.
    private static func entries(for rows: [ActivityRowPresentation]) -> [ActivityListEntry] {
        let online = rows.filter(\.machineOnline)
        let offline = rows.filter { !$0.machineOnline }
        var entries = online.map { ActivityListEntry.row($0) }
        var seenMachines: Set<String> = []
        for row in offline {
            if seenMachines.insert(row.machineKey).inserted {
                entries.append(
                    .offlineMachine(
                        machineKey: row.machineKey,
                        name: row.machineName,
                        lastSeenLabel: row.lastSeenLabel()
                    )
                )
            }
            entries.append(.row(row))
        }
        return entries
    }

    private func pruneDismissedItems(activeIDs: Set<String>) {
        let pruned = dismissedItemIDs.intersection(activeIDs)
        guard pruned != dismissedItemIDs else { return }
        dismissedItemIDs = pruned
        persistDismissedItems()
    }

    private func persistDismissedItems() {
        defaults.set(Array(dismissedItemIDs).sorted(), forKey: Self.dismissedItemIDsKey)
    }

    private func pruneSeenItems(activeIDs: Set<String>) {
        let pruned = seenItemIDs.intersection(activeIDs)
        guard pruned != seenItemIDs else { return }
        seenItemIDs = pruned
        persistSeenItems()
    }

    private func persistSeenItems() {
        defaults.set(Array(seenItemIDs).sorted(), forKey: Self.seenItemIDsKey)
    }

    /// One scope entry per offline (machine, project, lane) an item mentions.
    /// Deduplicated so a machine with forty stalled rows contributes one entry
    /// per lane, not forty.
    static func offlineScopes(from items: [AccountAttentionItem]) -> [ActivityOfflineScope] {
        var seen: Set<String> = []
        var scopes: [ActivityOfflineScope] = []
        for item in items where !item.machine.online {
            let scope = ActivityOfflineScope(
                machineKey: item.machine.machineKey,
                machineName: nonEmpty(item.machine.name) ?? "Computer",
                lastSeenAt: item.machine.lastSeenAt,
                projectId: item.project.projectId,
                laneId: nonEmpty(item.laneId)
            )
            guard seen.insert(scope.id).inserted else { continue }
            scopes.append(scope)
        }
        return scopes
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else { return nil }
        return value
    }
}

/// Where one offline machine's work lives. Presence plus scope, nothing else —
/// the row vocabulary stays in `ActivityRowPresentation`.
public struct ActivityOfflineScope: Identifiable, Hashable, Sendable {
    public let machineKey: String
    public let machineName: String
    public let lastSeenAt: Date?
    public let projectId: String
    public let laneId: String?

    public var id: String { "\(machineKey)|\(projectId)|\(laneId ?? "")" }

    public init(
        machineKey: String,
        machineName: String,
        lastSeenAt: Date?,
        projectId: String,
        laneId: String?
    ) {
        self.machineKey = machineKey
        self.machineName = machineName
        self.lastSeenAt = lastSeenAt
        self.projectId = projectId
        self.laneId = laneId
    }

    /// "last seen 2h ago" — the same wording and the same clock arithmetic the
    /// row banner uses, so two banners for one machine cannot disagree.
    public func lastSeenLabel(now: Date = Date()) -> String? {
        guard let lastSeenAt,
              let duration = ActivityRowPresentation.formatDuration(now.timeIntervalSince(lastSeenAt))
        else { return nil }
        return "last seen \(duration) ago"
    }
}

// MARK: - Workspace snapshot projection

extension ActivityDrawerModel {
    /// Project the machine-local snapshot into account items. Ids keep their
    /// historical prefixes (`awaiting:`, `live:`, `ci:` …) so dismissals
    /// persisted before this rewrite still match their rows.
    static func accountItems(
        from snapshot: WorkspaceSnapshot,
        machine: AccountAttentionMachine
    ) -> [AccountAttentionItem] {
        let project = AccountAttentionProject(
            projectId: nonEmpty(snapshot.projectId) ?? "current-project",
            name: nonEmpty(snapshot.projectName) ?? "Current project"
        )
        var items: [AccountAttentionItem] = []

        for agent in snapshot.agents {
            let phase = agentPhase(agent, machineOnline: machine.online)
            let idPrefix: String
            switch phase {
            case .needsYou: idPrefix = "awaiting"
            case .failed: idPrefix = "failed"
            case .completed: idPrefix = "completed"
            default: idPrefix = "live"
            }
            guard phase != .completed
                || Date().timeIntervalSince(agent.lastActivityAt) <= 86_400 else { continue }
            items.append(
                AccountAttentionItem(
                    id: "\(idPrefix):\(agent.sessionId)",
                    revision: 0,
                    fingerprint: "local:\(agent.sessionId)",
                    kind: .agent,
                    eventKind: agentEventKind(phase),
                    phase: phase,
                    machine: machine,
                    project: project,
                    laneName: agent.laneName,
                    provider: agent.provider,
                    model: agent.modelId,
                    title: agentTitle(agent),
                    preview: nonEmpty(agent.preview) ?? "",
                    privacyPreview: "",
                    destination: .session(
                        sessionId: agent.sessionId,
                        itemId: agent.pendingInputItemId,
                        eventId: nil
                    ),
                    occurredAt: agent.lastActivityAt,
                    updatedAt: agent.lastActivityAt
                )
            )
        }

        for pr in snapshot.prs {
            guard let phase = prPhase(pr) else { continue }
            let timestamp = pr.updatedAt ?? snapshot.generatedAt
            if pr.state != "open",
               Date().timeIntervalSince(timestamp) > 86_400 { continue }
            items.append(
                AccountAttentionItem(
                    id: "\(prIdPrefix(phase, state: pr.state)):\(pr.id)",
                    revision: 0,
                    fingerprint: "local:\(pr.id)",
                    kind: .pullRequest,
                    eventKind: prEventKind(phase),
                    phase: phase,
                    machine: machine,
                    project: project,
                    title: "PR #\(pr.number) · \(pr.title)",
                    preview: "",
                    privacyPreview: "",
                    destination: .pullRequest(
                        prId: pr.id,
                        repoOwner: nil,
                        repoName: nil,
                        number: pr.number,
                        tab: "overview",
                        eventId: nil
                    ),
                    occurredAt: timestamp,
                    updatedAt: timestamp
                )
            )
        }

        return items
    }

    private static func agentPhase(
        _ agent: AgentSnapshot,
        machineOnline: Bool
    ) -> AccountAttentionPhase {
        let status = agent.status.lowercased()
        if agent.awaitingInput { return .needsYou }
        if status == "failed" || status == "error" { return .failed }
        if status == "completed" || status == "ended" { return .completed }
        if status == "idle" { return .completed }
        if !machineOnline { return .stale }
        if nonEmpty(agent.phase)?.lowercased() == "blocked" { return .blocked }
        return .running
    }

    private static func agentEventKind(
        _ phase: AccountAttentionPhase
    ) -> AccountAttentionEventKind {
        switch phase {
        case .needsYou: return .agentNeedsYou
        case .failed: return .agentFailed
        case .completed: return .agentCompleted
        default: return .agentRunning
        }
    }

    private static func prPhase(_ pr: PrSnapshot) -> AccountAttentionPhase? {
        switch pr.state {
        case "merged": return .merged
        case "closed": return .closed
        case "open":
            if pr.checks == "failing" { return .checksFailing }
            if pr.mergeReady { return .mergeReady }
            if pr.review == "changes_requested" { return .changesRequested }
            if pr.review == "pending" { return .reviewRequested }
            return .open
        default: return nil
        }
    }

    private static func prIdPrefix(
        _ phase: AccountAttentionPhase,
        state: String
    ) -> String {
        switch phase {
        case .checksFailing: return "ci"
        case .mergeReady: return "merge"
        case .reviewRequested, .changesRequested: return "review"
        default: return state
        }
    }

    private static func prEventKind(
        _ phase: AccountAttentionPhase
    ) -> AccountAttentionEventKind {
        switch phase {
        case .checksFailing: return .prChecksFailing
        case .mergeReady: return .prMergeReady
        case .reviewRequested: return .prReviewRequested
        case .changesRequested: return .prChangesRequested
        case .merged: return .prMerged
        case .closed: return .prClosed
        default: return .prOpened
        }
    }

    private static func agentTitle(_ agent: AgentSnapshot) -> String {
        if let title = nonEmpty(agent.title) { return title }
        let provider = ADESharedTheme.providerDisplayName(for: agent.provider) ?? "Agent"
        return "\(provider) · \(agent.sessionId)"
    }
}

// MARK: - SyncService wiring

extension ActivityDrawerModel {
    /// Wire the model up to a live `SyncService`: rebuild whenever its sessions
    /// or the App Group snapshots change. The workspace snapshot is read from
    /// the App Group because `SyncService` already writes the authoritative blob
    /// there — no separate transport.
    ///
    /// Returns the cancellables so callers (typically `SyncService` itself) can
    /// retain them for the drawer's lifetime.
    func bind(to syncService: SyncService) -> Set<AnyCancellable> {
        var bag: Set<AnyCancellable> = []

        let refresh: () -> Void = { [weak self, weak syncService] in
            guard let self, let syncService else { return }

            // The live view of the machine this phone is actually paired to.
            // Preferred over anything the relay says about that same machine —
            // see `rebuild(from:live:)`.
            let live = ADESharedContainer.readWorkspaceSnapshot()
                ?? (syncService.activeSessions.isEmpty ? nil : WorkspaceSnapshot(
                    generatedAt: Date(),
                    agents: syncService.activeSessions,
                    prs: [],
                    connection: "disconnected"
                ))

            if let account = ADESharedContainer.readAttentionSnapshot(),
               Date().timeIntervalSince(account.generatedAt) <= 86_400 {
                self.rebuild(from: account, live: live)
                return
            }
            if let live {
                self.rebuild(from: live)
                return
            }
            self.clearAll()
        }

        syncService.$activeSessions
            .receive(on: DispatchQueue.main)
            .sink { _ in refresh() }
            .store(in: &bag)

        syncService.$localStateRevision
            .receive(on: DispatchQueue.main)
            .sink { _ in refresh() }
            .store(in: &bag)

        syncService.$workspaceSnapshotRevision
            .receive(on: DispatchQueue.main)
            .sink { _ in refresh() }
            .store(in: &bag)

        AccountService.shared.$attentionSnapshotRevision
            .receive(on: DispatchQueue.main)
            .sink { _ in refresh() }
            .store(in: &bag)

        refresh()
        return bag
    }
}
