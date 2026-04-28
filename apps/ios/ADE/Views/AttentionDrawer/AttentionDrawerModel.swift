import Combine
import Foundation
import SwiftUI

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
        timestamp: Date
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
    }

    /// Materialise a typed `ADESessionAttributes.ContentState.Attention`
    /// for reuse by `AttentionActionRow`, so the drawer's action pills share
    /// styling with the Live Activity / lock-screen card.
    public var attentionPayload: ADESessionAttributes.ContentState.Attention {
        .init(
            kind: kind,
            title: title,
            subtitle: subtitle,
            providerSlug: providerSlug,
            sessionId: sessionId,
            itemId: itemId,
            prId: prId,
            prNumber: prNumber
        )
    }
}

/// Source of truth for the in-app Attention Drawer.
///
/// Reducer-only — never opens its own WebSocket or APNs channel. It
/// subscribes to the `SyncService` `@Published var activeSessions` +
/// `@Published var localStateRevision` publishers and rebuilds its
/// `items` array from the `WorkspaceSnapshot` written to the App Group by
/// `SyncService.writeWorkspaceSnapshotNow()`.
///
/// `unreadCount` reflects items whose `timestamp > lastSeenAt`, where
/// `lastSeenAt` is persisted to the shared `UserDefaults` under
/// `ade.attention.lastSeenAt` so the badge survives relaunches.
@available(iOS 17.0, *)
@MainActor
public final class AttentionDrawerModel: ObservableObject {
    @Published public private(set) var items: [AttentionItem] = []
    @Published public private(set) var unreadCount: Int = 0

    public static let lastSeenAtKey = "ade.attention.lastSeenAt"

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

    public init(defaults: UserDefaults = ADESharedContainer.defaults) {
        self.defaults = defaults
        let stored = defaults.double(forKey: Self.lastSeenAtKey)
        self.lastSeenAt = stored > 0
            ? Date(timeIntervalSince1970: stored)
            : .distantPast
    }

    // MARK: - Reducer

    /// Rebuild `items` from the current workspace snapshot. Items are sorted
    /// by kind priority (awaiting > failed > ci > review > merge) then by
    /// newest timestamp first. `unreadCount` is recomputed against
    /// `lastSeenAt`.
    public func rebuild(from snapshot: WorkspaceSnapshot) {
        var result: [AttentionItem] = []
        let generated = snapshot.generatedAt

        for agent in snapshot.agents {
            if agent.awaitingInput {
                result.append(
                    AttentionItem(
                        id: "awaiting:\(agent.sessionId)",
                        kind: .awaitingInput,
                        title: Self.humanAgentTitle(agent),
                        subtitle: "Approval needed",
                        providerSlug: agent.provider,
                        sessionId: agent.sessionId,
                        deepLink: URL(string: "ade://session/\(agent.sessionId)"),
                        timestamp: agent.lastActivityAt
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
                        timestamp: agent.lastActivityAt
                    )
                )
            }
        }

        for pr in snapshot.prs where pr.state == "open" {
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
                        timestamp: generated
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
                        timestamp: generated
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
                        timestamp: generated
                    )
                )
            }
        }

        result.sort { lhs, rhs in
            let lp = Self.kindPriority(lhs.kind)
            let rp = Self.kindPriority(rhs.kind)
            if lp != rp { return lp < rp }
            return lhs.timestamp > rhs.timestamp
        }

        items = result
        recomputeUnreadCount()
    }

    /// Dismiss-all entry point. Updates `lastSeenAt` → `Date.now` and
    /// zeroes `unreadCount`. `items` is untouched (the drawer still lists
    /// outstanding attention until the underlying state clears).
    public func markAllSeen() {
        lastSeenAt = Date()
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
        unreadCount = items.filter { $0.timestamp > lastSeenAt }.count
    }

    private static func kindPriority(_ kind: AttentionKind) -> Int {
        switch kind {
        case .awaitingInput:   return 0
        case .failed:          return 1
        case .ciFailing:       return 2
        case .reviewRequested: return 3
        case .mergeReady:      return 4
        }
    }

    private static func humanAgentTitle(_ snapshot: AgentSnapshot) -> String {
        let provider = snapshot.provider.capitalized
        if let title = snapshot.title, !title.isEmpty {
            return "\(provider) · \(title)"
        }
        return "\(provider) · \(snapshot.sessionId)"
    }

    private static func isAgentFailed(_ snapshot: AgentSnapshot) -> Bool {
        let s = snapshot.status.lowercased()
        return s == "failed" || s == "error"
    }
}

// MARK: - SyncService wiring

@available(iOS 17.0, *)
extension AttentionDrawerModel {
    /// Wire the drawer model up to a live `SyncService`: rebuild whenever
    /// the service's `activeSessions` or `localStateRevision` change. The
    /// workspace snapshot is read from the App Group since `SyncService`
    /// already writes the authoritative blob there — no separate transport.
    ///
    /// Returns the set of cancellables so callers (typically `SyncService`
    /// itself) can retain them for the drawer's lifetime.
    func bind(to syncService: SyncService) -> Set<AnyCancellable> {
        var bag: Set<AnyCancellable> = []

        let refresh: () -> Void = { [weak self, weak syncService] in
            guard let self, let syncService else { return }
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

        refresh()
        return bag
    }
}
