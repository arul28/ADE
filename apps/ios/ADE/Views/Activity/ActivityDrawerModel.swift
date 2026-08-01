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

public struct ActivitySection: Identifiable, Hashable, Sendable {
    public let band: ActivityBand
    public let rows: [ActivityRowPresentation]
    public let entries: [ActivityListEntry]

    public var id: String { band.rawValue }
    public var title: String { band.title }
    public var count: Int { rows.count }
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
    @Published public private(set) var unreadCount: Int = 0
    @Published public private(set) var source: ActivitySource = .none
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
    public func rebuild(from snapshot: AccountAttentionSnapshot) {
        let now = Date()
        let active = snapshot.items.filter { item in
            item.dismissedAt == nil
                && (item.expiresAt == nil || item.expiresAt! > now)
        }
        apply(
            items: active,
            machines: snapshot.machines ?? [],
            source: .account,
            truncated: snapshot.itemsTruncated ?? false,
            inlineActionsAllowed: false
        )
    }

    /// Rebuild from this machine's workspace snapshot. Projected into the same
    /// account item shape first, so the fallback path shares every rule above
    /// it instead of maintaining a parallel one.
    public func rebuild(from snapshot: WorkspaceSnapshot) {
        let machine = AccountAttentionMachine(
            machineKey: Self.nonEmpty(snapshot.machineId) ?? "current-machine",
            name: Self.nonEmpty(snapshot.machineName) ?? "Connected Mac",
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
        self.source = source
        itemsTruncated = truncated
        pruneSeenItems(activeIDs: Set(rows.map(\.id)))
        recomputeUnreadCount()
    }

    // MARK: - Derived views

    /// Sessions grouped into the three priority bands, each carrying its
    /// offline-machine dividers.
    public var sessionSections: [ActivitySection] {
        ActivityBand.allCases.compactMap { band in
            let rows = sessions.filter { $0.band == band }
            guard !rows.isEmpty else { return nil }
            return ActivitySection(band: band, rows: rows, entries: Self.entries(for: rows))
        }
    }

    public var inboxEntries: [ActivityListEntry] {
        Self.entries(for: inbox)
    }

    /// Rows for the hub's "Live now" strip: work actually in flight across every
    /// machine on the account, quietest tier excluded.
    public var liveNow: [ActivityRowPresentation] {
        sessions.filter { row in
            guard row.tier != .idle else { return false }
            return row.band == .needsYou || row.band == .working
        }
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

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else { return nil }
        return value
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
            if let account = ADESharedContainer.readAttentionSnapshot(),
               Date().timeIntervalSince(account.generatedAt) <= 86_400 {
                self.rebuild(from: account)
                return
            }
            if let snapshot = ADESharedContainer.readWorkspaceSnapshot() {
                self.rebuild(from: snapshot)
                return
            }
            guard !syncService.activeSessions.isEmpty else {
                self.clearAll()
                return
            }
            self.rebuild(
                from: WorkspaceSnapshot(
                    generatedAt: Date(),
                    agents: syncService.activeSessions,
                    prs: [],
                    connection: "disconnected"
                )
            )
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
