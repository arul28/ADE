import Combine
import Foundation
import SwiftUI

/// Presentation bucket for a drawer row — what glyph and hue it wears.
///
/// `awaitingInput` is the only amber kind, and that is deliberate: amber means
/// "your move" and nothing else (see `AgentRunPhase` and the desktop's
/// `sessionStatusPresentation`). `blocked` is a separate, neutral kind for
/// exactly that reason — it used to share `awaitingInput`, which put a raised
/// hand and an unmet dependency under one bell and one colour.
@available(iOS 17.0, *)
public enum AttentionKind: String, Codable, Hashable, Sendable {
    case awaitingInput
    case blocked
    case failed
    case ciFailing
    case reviewRequested
    case mergeReady
    case running
    case open
    case completed
    case merged
    case stale
}

@available(iOS 17.0, *)
public enum AttentionCollection: String, CaseIterable, Hashable, Sendable {
    case needsYou
    case live
    case recent
}

@available(iOS 17.0, *)
public struct AttentionProjectLens: Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let machineCount: Int
    public let itemCount: Int
}

/// A single row rendered inside the in-app Attention Drawer sheet.
///
/// Built by `AttentionDrawerModel.rebuild(from:)` from the active
/// `WorkspaceSnapshot` so the drawer doesn't need its own transport.
@available(iOS 17.0, *)
public struct AttentionItem: Identifiable, Equatable {
    public let id: String
    public let kind: AttentionKind
    public let title: String
    public let subtitle: String
    public let providerSlug: String?
    public let sessionId: String?
    public let itemId: String?
    public let prId: String?
    public let prNumber: Int?
    public let deepLink: URL?
    public let timestamp: Date
    public let collection: AttentionCollection
    public let machineId: String
    public let machineName: String
    public let machineOnline: Bool
    public let projectId: String
    public let projectName: String
    public let laneName: String?
    public let phaseLabel: String
    public let seenAt: Date?
    /// Inline App Intents execute against the currently paired host. Account
    /// items can belong to another machine, so they must navigate to their exact
    /// destination instead of invoking a local-host action.
    public let inlineActionsAllowed: Bool

    public init(
        id: String,
        kind: AttentionKind,
        title: String,
        subtitle: String,
        providerSlug: String? = nil,
        sessionId: String? = nil,
        itemId: String? = nil,
        prId: String? = nil,
        prNumber: Int? = nil,
        deepLink: URL? = nil,
        timestamp: Date,
        collection: AttentionCollection = .needsYou,
        machineId: String = "current-machine",
        machineName: String = "Connected Mac",
        machineOnline: Bool = true,
        projectId: String = "current-project",
        projectName: String = "Current project",
        laneName: String? = nil,
        phaseLabel: String? = nil,
        seenAt: Date? = nil,
        inlineActionsAllowed: Bool = true
    ) {
        self.id = id
        self.kind = kind
        self.title = title
        self.subtitle = subtitle
        self.providerSlug = providerSlug
        self.sessionId = sessionId
        self.itemId = itemId
        self.prId = prId
        self.prNumber = prNumber
        self.deepLink = deepLink
        self.timestamp = timestamp
        self.collection = collection
        self.machineId = machineId
        self.machineName = machineName
        self.machineOnline = machineOnline
        self.projectId = projectId
        self.projectName = projectName
        self.laneName = laneName
        self.phaseLabel = phaseLabel ?? Self.defaultPhaseLabel(for: kind)
        self.seenAt = seenAt
        self.inlineActionsAllowed = inlineActionsAllowed
    }

    public var scopeLabel: String {
        let project = projectName.trimmingCharacters(in: .whitespacesAndNewlines)
        let machine = machineName.trimmingCharacters(in: .whitespacesAndNewlines)
        if machine.isEmpty { return project }
        if project.isEmpty { return machine }
        return "\(machine) · \(project)"
    }

    private static func defaultPhaseLabel(for kind: AttentionKind) -> String {
        switch kind {
        case .awaitingInput: return "Needs you"
        case .blocked: return "Blocked"
        case .failed: return "Failed"
        case .ciFailing: return "Checks failing"
        case .reviewRequested: return "Review"
        case .mergeReady: return "Ready"
        case .running: return "Working"
        case .open: return "Open"
        case .completed: return "Done"
        case .merged: return "Merged"
        // "Stale", not "Offline": the run is reachable and silent. Calling it
        // offline points at the network, which is the one thing that is not
        // wrong here.
        case .stale: return "Stale"
        }
    }
}

/// Source of truth for the in-app Attention Drawer.
///
/// Reducer-only: never opens its own transport. It prefers the account-wide
/// snapshot written to the App Group and falls back to SyncService's current
/// workspace snapshot. Per-item seen IDs are persisted so opening one event
/// never clears another machine's unread badge.
@available(iOS 17.0, *)
@MainActor
public final class AttentionDrawerModel: ObservableObject {
    @Published public private(set) var items: [AttentionItem] = []
    @Published public private(set) var liveItems: [AttentionItem] = []
    @Published public private(set) var recentItems: [AttentionItem] = []
    @Published public private(set) var unreadCount: Int = 0
    @Published public private(set) var selectedProjectId: String?

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
    private var accountBackedItemIDs: Set<String> = []

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

    /// Rebuild `items` from the current workspace snapshot. Items are sorted
    /// by kind priority (awaiting > failed > ci > review > merge) then by
    /// newest timestamp first. `unreadCount` is recomputed against
    /// `lastSeenAt`.
    public func rebuild(from snapshot: WorkspaceSnapshot) {
        accountBackedItemIDs = []
        var result: [AttentionItem] = []
        var live: [AttentionItem] = []
        var recent: [AttentionItem] = []
        let generated = snapshot.generatedAt
        let machineId = Self.nonEmpty(snapshot.machineId) ?? "current-machine"
        let machineName = Self.nonEmpty(snapshot.machineName) ?? "Connected Mac"
        let projectId = Self.nonEmpty(snapshot.projectId) ?? "current-project"
        let projectName = Self.nonEmpty(snapshot.projectName) ?? "Current project"
        let machineOnline = snapshot.connection.lowercased() != "disconnected"

        for agent in snapshot.agents {
            if agent.awaitingInput {
                let preview = agent.preview?.trimmingCharacters(in: .whitespacesAndNewlines)
                let subtitle = preview.flatMap { $0.isEmpty ? nil : $0 } ?? "Approval needed"
                result.append(
                    AttentionItem(
                        id: "awaiting:\(agent.sessionId)",
                        kind: .awaitingInput,
                        title: Self.humanAgentTitle(agent),
                        subtitle: subtitle,
                        providerSlug: agent.provider,
                        sessionId: agent.sessionId,
                        itemId: agent.pendingInputItemId,
                        deepLink: URL(string: "ade://session/\(agent.sessionId)"),
                        timestamp: agent.lastActivityAt,
                        machineId: machineId,
                        machineName: machineName,
                        machineOnline: machineOnline,
                        projectId: projectId,
                        projectName: projectName,
                        laneName: agent.laneName
                    )
                )
            } else if Self.isAgentFailed(agent) {
                result.append(
                    AttentionItem(
                        id: "failed:\(agent.sessionId)",
                        kind: .failed,
                        title: Self.humanAgentTitle(agent),
                        subtitle: "Agent failed",
                        providerSlug: agent.provider,
                        sessionId: agent.sessionId,
                        deepLink: URL(string: "ade://session/\(agent.sessionId)"),
                        timestamp: agent.lastActivityAt,
                        machineId: machineId,
                        machineName: machineName,
                        machineOnline: machineOnline,
                        projectId: projectId,
                        projectName: projectName,
                        laneName: agent.laneName
                    )
                )
            } else if Self.isAgentCompleted(agent) {
                guard Date().timeIntervalSince(agent.lastActivityAt) <= 86_400 else { continue }
                recent.append(
                    AttentionItem(
                        id: "completed:\(agent.sessionId)",
                        kind: .completed,
                        title: Self.humanAgentTitle(agent),
                        subtitle: Self.nonEmpty(agent.preview) ?? "Agent work completed",
                        providerSlug: agent.provider,
                        sessionId: agent.sessionId,
                        deepLink: URL(string: "ade://session/\(agent.sessionId)"),
                        timestamp: agent.lastActivityAt,
                        collection: .recent,
                        machineId: machineId,
                        machineName: machineName,
                        machineOnline: machineOnline,
                        projectId: projectId,
                        projectName: projectName,
                        laneName: agent.laneName
                    )
                )
            } else if Self.isAgentLive(agent) {
                let isBlocked = Self.nonEmpty(agent.phase)?.lowercased() == "blocked"
                live.append(
                    AttentionItem(
                        id: "live:\(agent.sessionId)",
                        kind: machineOnline
                            ? (isBlocked ? .blocked : .running)
                            : .stale,
                        title: Self.humanAgentTitle(agent),
                        subtitle: Self.nonEmpty(agent.preview)
                            ?? Self.agentPhaseLabel(agent.phase)
                            ?? "Working",
                        providerSlug: agent.provider,
                        sessionId: agent.sessionId,
                        deepLink: URL(string: "ade://session/\(agent.sessionId)"),
                        timestamp: agent.lastActivityAt,
                        collection: .live,
                        machineId: machineId,
                        machineName: machineName,
                        machineOnline: machineOnline,
                        projectId: projectId,
                        projectName: projectName,
                        laneName: agent.laneName
                    )
                )
            }
        }

        for pr in snapshot.prs where pr.state == "open" {
            let prTimestamp = pr.updatedAt ?? generated
            if pr.checks == "failing" {
                result.append(
                    AttentionItem(
                        id: "ci:\(pr.id)",
                        kind: .ciFailing,
                        title: "PR #\(pr.number) · \(pr.title)",
                        subtitle: "Checks failing",
                        prId: pr.id,
                        prNumber: pr.number,
                        deepLink: URL(string: "ade://pr/\(pr.number)"),
                        timestamp: prTimestamp,
                        machineId: machineId,
                        machineName: machineName,
                        machineOnline: machineOnline,
                        projectId: projectId,
                        projectName: projectName
                    )
                )
            } else if pr.mergeReady {
                result.append(
                    AttentionItem(
                        id: "merge:\(pr.id)",
                        kind: .mergeReady,
                        title: "PR #\(pr.number) · \(pr.title)",
                        subtitle: "Ready to merge",
                        prId: pr.id,
                        prNumber: pr.number,
                        deepLink: URL(string: "ade://pr/\(pr.number)"),
                        timestamp: prTimestamp,
                        machineId: machineId,
                        machineName: machineName,
                        machineOnline: machineOnline,
                        projectId: projectId,
                        projectName: projectName
                    )
                )
            } else if pr.review == "pending" || pr.review == "changes_requested" {
                result.append(
                    AttentionItem(
                        id: "review:\(pr.id)",
                        kind: .reviewRequested,
                        title: "PR #\(pr.number) · \(pr.title)",
                        subtitle: pr.review == "changes_requested"
                            ? "Changes requested"
                            : "Review requested",
                        prId: pr.id,
                        prNumber: pr.number,
                        deepLink: URL(string: "ade://pr/\(pr.number)"),
                        timestamp: prTimestamp,
                        machineId: machineId,
                        machineName: machineName,
                        machineOnline: machineOnline,
                        projectId: projectId,
                        projectName: projectName
                    )
                )
            }
        }

        pruneDismissedItems(activeIDs: Set(result.map(\.id)))
        result.removeAll { dismissedItemIDs.contains($0.id) }
        for pr in snapshot.prs where pr.state == "merged" || pr.state == "closed" {
            let timestamp = pr.updatedAt ?? generated
            guard Date().timeIntervalSince(timestamp) <= 86_400 else { continue }
            recent.append(
                AttentionItem(
                    id: "\(pr.state):\(pr.id)",
                    kind: pr.state == "merged" ? .merged : .completed,
                    title: "PR #\(pr.number) · \(pr.title)",
                    subtitle: pr.state == "merged" ? "Pull request merged" : "Pull request closed",
                    prId: pr.id,
                    prNumber: pr.number,
                    deepLink: URL(string: "ade://pr/\(pr.number)"),
                    timestamp: timestamp,
                    collection: .recent,
                    machineId: machineId,
                    machineName: machineName,
                    machineOnline: machineOnline,
                    projectId: projectId,
                    projectName: projectName
                )
            )
        }

        sort(&result)
        sort(&live)
        sort(&recent)
        items = result
        liveItems = live
        recentItems = recent
        pruneSeenItems(activeIDs: Set((result + live + recent).map(\.id)))
        validateSelectedProject()
        recomputeUnreadCount()
    }

    /// Rebuild from the account-level contract. This path supplies real
    /// machine/project scope and shared seen state; `WorkspaceSnapshot` remains
    /// the local fallback until the signed-in transport writes this snapshot.
    public func rebuild(from snapshot: AccountAttentionSnapshot) {
        let now = Date()
        let active = snapshot.items.filter { item in
            item.dismissedAt == nil
                && (item.expiresAt == nil || item.expiresAt! > now)
        }
        let converted = active.map(Self.makeItem)
        accountBackedItemIDs = Set(converted.map(\.id))
        var needs = converted.filter { $0.collection == .needsYou }
        var live = converted.filter { $0.collection == .live }
        var recent = converted.filter { item in
            guard item.collection == .recent else { return false }
            return item.seenAt == nil || snapshot.generatedAt.timeIntervalSince(item.timestamp) <= 86_400
        }

        pruneDismissedItems(activeIDs: Set(needs.map(\.id)))
        needs.removeAll { dismissedItemIDs.contains($0.id) }
        sort(&needs)
        sort(&live)
        sort(&recent)
        items = needs
        liveItems = live
        recentItems = recent
        pruneSeenItems(activeIDs: Set(converted.map(\.id)))
        validateSelectedProject()
        recomputeUnreadCount()
    }

    public func selectProject(_ projectId: String?) {
        selectedProjectId = projectId
    }

    public func visibleItems(in collection: AttentionCollection) -> [AttentionItem] {
        let source: [AttentionItem]
        switch collection {
        case .needsYou: source = items
        case .live: source = liveItems
        case .recent: source = recentItems
        }
        guard let selectedProjectId else { return source }
        return source.filter { $0.projectId == selectedProjectId }
    }

    public var projectLenses: [AttentionProjectLens] {
        let all = items + liveItems + recentItems
        let grouped = Dictionary(grouping: all, by: \.projectId)
        return grouped.map { projectId, projectItems in
            AttentionProjectLens(
                id: projectId,
                name: projectItems.first?.projectName ?? "Project",
                machineCount: Set(projectItems.map(\.machineId)).count,
                itemCount: projectItems.count
            )
        }
        .sorted {
            if $0.itemCount != $1.itemCount { return $0.itemCount > $1.itemCount }
            return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
    }

    public var visibleMachineCount: Int {
        Set(
            (items + liveItems + recentItems)
                .filter { selectedProjectId == nil || $0.projectId == selectedProjectId }
                .map(\.machineId)
        ).count
    }

    /// Dismiss-all entry point. Updates `lastSeenAt` → `Date.now` and
    /// zeroes `unreadCount`. `items` is untouched (the drawer still lists
    /// outstanding attention until the underlying state clears).
    public func markAllSeen() {
        lastSeenAt = Date()
        let ids = accountBackedItemIDs.intersection(
            Set((items + recentItems.filter { $0.seenAt == nil }).map(\.id))
        )
        if !ids.isEmpty {
            Task { await AccountService.shared.acknowledgeAttentionItems(Array(ids), dismiss: false) }
        }
    }

    public func markSeen(_ itemId: String) {
        seenItemIDs.insert(itemId)
        persistSeenItems()
        recomputeUnreadCount()
        if accountBackedItemIDs.contains(itemId) {
            Task { await AccountService.shared.acknowledgeAttentionItems([itemId], dismiss: false) }
        }
    }

    /// Clear the currently visible attention cards from the drawer. The
    /// dismissal is scoped to the active attention IDs and is pruned once the
    /// backing state clears, so a future CI/review/agent regression reappears.
    public func clearVisibleItems() {
        let visible = visibleItems(in: .needsYou)
        guard !visible.isEmpty else { return }

        let visibleIds = Set(visible.map(\.id))
        dismissedItemIDs.formUnion(visibleIds)
        let accountIds = accountBackedItemIDs.intersection(visibleIds)
        persistDismissedItems()
        items.removeAll { visibleIds.contains($0.id) }
        validateSelectedProject()
        recomputeUnreadCount()
        if !accountIds.isEmpty {
            Task { await AccountService.shared.acknowledgeAttentionItems(Array(accountIds), dismiss: true) }
        }
    }

    // MARK: - Bell affordance

    /// Count label for the drawer badge. Returns `nil` at zero, `"9+"` for
    /// anything > 9 so the 16pt circle never grows past two glyphs.
    public var badgeLabel: String? {
        guard unreadCount > 0 else { return nil }
        return unreadCount > 9 ? "9+" : "\(unreadCount)"
    }

    // MARK: - Private

    private func recomputeUnreadCount() {
        let inbox = items + recentItems.filter { $0.seenAt == nil }
        unreadCount = inbox.filter {
            $0.seenAt == nil
                && !seenItemIDs.contains($0.id)
                && $0.timestamp > lastSeenAt
        }.count
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

    private static func kindPriority(_ kind: AttentionKind) -> Int {
        switch kind {
        case .awaitingInput:   return 0
        case .failed:          return 1
        case .ciFailing:       return 2
        case .reviewRequested: return 3
        case .mergeReady:      return 4
        case .running:         return 5
        // Blocked sorts below live work and above a silent one: it is not
        // asking for anything, but it has not gone quiet either.
        case .blocked:         return 6
        case .stale:           return 7
        case .open:            return 8
        case .completed:       return 8
        case .merged:          return 8
        }
    }

    private func sort(_ values: inout [AttentionItem]) {
        values.sort { lhs, rhs in
            let lp = Self.kindPriority(lhs.kind)
            let rp = Self.kindPriority(rhs.kind)
            if lp != rp { return lp < rp }
            if lhs.timestamp != rhs.timestamp { return lhs.timestamp > rhs.timestamp }
            return lhs.id < rhs.id
        }
    }

    private static func humanAgentTitle(_ snapshot: AgentSnapshot) -> String {
        let provider = ADESharedTheme.providerDisplayName(for: snapshot.provider) ?? "Agent"
        if let title = snapshot.title, !title.isEmpty {
            return "\(provider) · \(title)"
        }
        return "\(provider) · \(snapshot.sessionId)"
    }

    private static func agentPhaseLabel(_ phase: String?) -> String? {
        guard let phase = nonEmpty(phase)?.lowercased() else { return nil }
        switch phase {
        case "starting": return "Starting"
        case "running": return "Working"
        case "planning", "plan": return "Planning"
        case "development", "developing", "implementation", "implementing": return "Building"
        case "testing", "test": return "Testing"
        case "validation", "validating": return "Validating"
        case "review", "reviewing": return "Reviewing"
        case "pr", "pull_request": return "Preparing pull request"
        case "waiting_for_approval", "needs_approval": return "Needs approval"
        case "waiting_for_input", "awaiting_input", "needs_you": return "Needs reply"
        case "blocked": return "Blocked"
        case "completed", "done": return "Done"
        case "failed", "error": return "Failed"
        case "stale": return "Stale"
        default: return nil
        }
    }

    private static func isAgentFailed(_ snapshot: AgentSnapshot) -> Bool {
        let s = snapshot.status.lowercased()
        return s == "failed" || s == "error"
    }

    private static func isAgentCompleted(_ snapshot: AgentSnapshot) -> Bool {
        let status = snapshot.status.lowercased()
        return status == "completed" || status == "ended"
    }

    private static func isAgentLive(_ snapshot: AgentSnapshot) -> Bool {
        let status = snapshot.status.lowercased()
        return status != "idle"
            && status != "completed"
            && status != "ended"
            && status != "failed"
            && status != "error"
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else {
            return nil
        }
        return value
    }

    private static func makeItem(_ source: AccountAttentionItem) -> AttentionItem {
        let kind: AttentionKind
        let collection: AttentionCollection
        switch source.phase {
        case .needsYou:
            kind = .awaitingInput
            collection = .needsYou
        // Blocked already filed itself under `live` rather than `needsYou` —
        // the drawer never thought it was the user's move. It now looks the
        // part too, instead of borrowing the amber bell from a raised hand.
        case .blocked:
            kind = .blocked
            collection = .live
        case .failed:
            kind = .failed
            collection = .needsYou
        case .checksFailing:
            kind = .ciFailing
            collection = .needsYou
        case .reviewRequested, .changesRequested:
            kind = .reviewRequested
            collection = .needsYou
        case .mergeReady:
            kind = .mergeReady
            collection = .needsYou
        case .starting, .running:
            kind = .running
            collection = .live
        case .stale:
            kind = .stale
            collection = .live
        case .open:
            kind = .open
            collection = .recent
        case .completed, .closed:
            kind = .completed
            collection = .recent
        case .merged:
            kind = .merged
            collection = .recent
        }

        let destination = source.destination
        let session: (String?, String?)
        let pullRequest: (String?, Int?)
        switch destination {
        case .session(let sessionId, let itemId, _):
            session = (sessionId, itemId)
            pullRequest = (nil, nil)
        case .pullRequest(let prId, _, _, let number, _, _):
            session = (nil, nil)
            pullRequest = (prId, number)
        }

        let preview = nonEmpty(source.preview)
            ?? nonEmpty(source.detail)
            ?? nonEmpty(source.privacyPreview)
            ?? source.phase.displayLabel

        return AttentionItem(
            id: source.id,
            kind: kind,
            title: source.title,
            subtitle: preview,
            providerSlug: source.provider,
            sessionId: session.0,
            itemId: session.1,
            prId: pullRequest.0,
            prNumber: pullRequest.1,
            deepLink: source.deepLinkURL,
            timestamp: source.updatedAt,
            collection: collection,
            machineId: source.machine.machineKey,
            machineName: source.machine.name,
            machineOnline: source.machine.online,
            projectId: source.project.projectId,
            projectName: source.project.name,
            laneName: source.laneName,
            phaseLabel: source.phase.displayLabel,
            seenAt: source.seenAt,
            inlineActionsAllowed: false
        )
    }

    private func validateSelectedProject() {
        guard let selectedProjectId else { return }
        if !(items + liveItems + recentItems).contains(where: { $0.projectId == selectedProjectId }) {
            self.selectedProjectId = nil
        }
    }
}

// MARK: - SyncService wiring

@available(iOS 17.0, *)
extension AttentionDrawerModel {
    /// Wire the drawer model up to a live `SyncService`: rebuild whenever
    /// the service's `activeSessions` or App Group workspace snapshot changes. The
    /// workspace snapshot is read from the App Group since `SyncService`
    /// already writes the authoritative blob there — no separate transport.
    ///
    /// Returns the set of cancellables so callers (typically `SyncService`
    /// itself) can retain them for the drawer's lifetime.
    func bind(to syncService: SyncService) -> Set<AnyCancellable> {
        var bag: Set<AnyCancellable> = []

        let refresh: () -> Void = { [weak self, weak syncService] in
            guard let self, let syncService else { return }
            if let attention = ADESharedContainer.readAttentionSnapshot(),
               Date().timeIntervalSince(attention.generatedAt) <= 86_400 {
                self.rebuild(from: attention)
                return
            }
            let snapshot = ADESharedContainer.readWorkspaceSnapshot()
                ?? WorkspaceSnapshot(
                    generatedAt: Date(),
                    agents: syncService.activeSessions,
                    prs: [],
                    connection: "disconnected"
                )
            self.rebuild(from: snapshot)
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
