import Combine
import Foundation

/// What tells a plugin page that ADE's own world moved.
///
/// A page subscribes with `host.subscribe({kinds})` and then hears a `host`
/// event whenever a lane, a session, a pull request or a chat turn it might be
/// drawing has changed. This file is the PRODUCER of those frames, and it is the
/// half the phone was missing: the bridge accepted the subscription and
/// `deliverHostEvent` knew how to send a frame, but nothing ever called it, so
/// every page on the phone silently never heard from the host.
///
/// ## Why a fingerprint diff rather than row ids
///
/// The desktop gets ids for free: its services mutate one entity at a time and
/// say which. The phone does not. Its rows arrive as cr-sqlite changesets whose
/// primary keys are packed blobs, and `Database.applyChanges` deliberately
/// reports only the TABLE names it touched — `bumpLaneDetailRevisions` says so
/// out loud: everything but a local `lane_detail_snapshots` write "arrive[s]
/// over CRR without a cheap lane id and must stay broad".
///
/// So the phone answers "which ones" the only way it truthfully can: it keeps a
/// small fingerprint per entity — the fields a page could actually be drawing —
/// and diffs the new snapshot against the old one. Ids that changed are real
/// ids, not guesses, and an entity whose fingerprint is unchanged is genuinely
/// not reported.
///
/// The cost is bounded to the point of being uninteresting: the diff runs ONLY
/// while a plugin page is open AND subscribed to that kind, at most one live
/// guest exists, and every source is already in memory or already read by the
/// screen behind the page.
///
/// ## Why the coalescer exists
///
/// A rebase moves a dozen lanes in a few milliseconds and a PR poll finishes a
/// whole page of them at once. Delivered raw that is a dozen wake-ups of a
/// webview that will redraw once either way, so frames are gathered for
/// `PluginPageHostCoalescer.windowMs` and sent as the union — the same 120 ms
/// the desktop uses (`PLUGIN_WEBVIEW_HOST_COALESCE_MS`).

// MARK: - What the phone can be asked for

/// One entity, reduced to the fields whose movement a page would notice.
///
/// A dictionary of id → fingerprint rather than the models themselves: the
/// differ never needs to know what a lane IS, and keeping it that way is what
/// lets every rule below be tested without a database.
typealias PluginPageHostFingerprints = [String: String]

/// A chat session's turn, as the phone currently sees it.
struct PluginPageChatObservation: Equatable {
    var status: String
    /// The host's own sentence about a failure, when it wrote one.
    var statusNote: String?
    /// The turn id, when the producer knows it. Opaque to the page.
    var turnId: String?
}

/// The phone's live picture of the four host kinds.
///
/// A protocol so the whole producer is testable against a scripted world: every
/// rule below — the diff, the coalescing, the turn mapping, the ceilings — is
/// provable with no database, no socket and no waiting.
@MainActor
protocol PluginPageHostWorldReading: AnyObject {
    func pluginPageHostFingerprints(kind: PluginPageHostKind) -> PluginPageHostFingerprints
    /// Session id → turn observation, for the `chat` kind only.
    func pluginPageChatObservations() -> [String: PluginPageChatObservation]
}

// MARK: - The differ

/// What changed between two snapshots of one kind.
///
/// Pure, and deliberately total on both directions: an entity that APPEARED is
/// a change (a lane the page has never seen is one it should draw), and one
/// that DISAPPEARED is a change too (a page holding a deleted row needs to stop
/// drawing it). Reporting only updates would leave a page's list permanently
/// one archive behind.
enum PluginPageHostDiffer {
    static func changedIds(
        previous: PluginPageHostFingerprints,
        current: PluginPageHostFingerprints
    ) -> Set<String> {
        var changed = Set<String>()
        for (id, fingerprint) in current where previous[id] != fingerprint {
            changed.insert(id)
        }
        for id in previous.keys where current[id] == nil {
            changed.insert(id)
        }
        return changed
    }

    /// Turn moves between two chat snapshots.
    ///
    /// Only a TRANSITION is a turn. A session that was running and still is has
    /// not moved, and reporting it every time the roster is republished would
    /// make a page redraw on a heartbeat.
    ///
    /// The mapping collapses the phone's five roster statuses onto the three
    /// states a page understands: `running` is `started`, `idle`/`ended` reached
    /// FROM running is `completed`, and `failed` is `failed`. A session that
    /// appears already idle produces nothing — it did not finish while the page
    /// was watching, and telling a page a turn "completed" for work it never saw
    /// start is worse than silence.
    static func chatTurns(
        previous: [String: PluginPageChatObservation],
        current: [String: PluginPageChatObservation]
    ) -> [PluginPageChatTurn] {
        var turns: [PluginPageChatTurn] = []
        for (sessionId, now) in current {
            let before = previous[sessionId]
            guard before?.status != now.status else { continue }
            guard let state = turnState(from: before?.status, to: now.status) else { continue }
            turns.append(PluginPageChatTurn(
                sessionId: sessionId,
                state: state,
                turnId: now.turnId,
                message: state == .failed ? now.statusNote : nil
            ))
        }
        // Sorted so one window's frame is stable for a given pair of snapshots,
        // which is what makes the coalescing tests assert an exact array.
        return turns.sorted { $0.sessionId < $1.sessionId }
    }

    private static func turnState(from before: String?, to now: String) -> PluginPageChatTurn.State? {
        switch now {
        case "running":
            return .started
        case "failed":
            return .failed
        case "idle", "ended":
            // Only from a turn this page could have seen start. `awaiting` counts
            // as running for this purpose: the turn is live, it is just holding
            // for the reader.
            guard before == "running" || before == "awaiting" else { return nil }
            return .completed
        default:
            return nil
        }
    }
}

// MARK: - The coalescer

/// Gathers host changes for a window and emits the union.
///
/// Time is injected rather than taken from the clock so the tests wait on the
/// coalescer itself instead of on a sleep: `flush()` is what a test calls, and
/// production calls it from a timer.
@MainActor
final class PluginPageHostCoalescer {
    /// The same window the desktop uses (`PLUGIN_WEBVIEW_HOST_COALESCE_MS`).
    static let windowMs = 120

    /// One frame, ready to hand to a guest.
    struct Frame: Equatable {
        var kind: PluginPageHostKind
        var ids: [String]
        var overflow: Bool
        var turns: [PluginPageChatTurn]
    }

    private var pendingIds: [PluginPageHostKind: Set<String>] = [:]
    private var pendingOverflow: Set<PluginPageHostKind> = []
    private var pendingTurns: [String: PluginPageChatTurn] = [:]
    private var timer: Task<Void, Never>?

    private let emit: (Frame) -> Void
    private let sleep: (Int) async -> Void

    init(
        emit: @escaping (Frame) -> Void,
        sleep: @escaping (Int) async -> Void = { ms in
            try? await Task.sleep(nanoseconds: UInt64(ms) * 1_000_000)
        }
    ) {
        self.emit = emit
        self.sleep = sleep
    }

    deinit {
        timer?.cancel()
    }

    var hasPendingWork: Bool {
        pendingIds.values.contains { !$0.isEmpty } || !pendingTurns.isEmpty || !pendingOverflow.isEmpty
    }

    func ingest(kind: PluginPageHostKind, ids: Set<String>, overflow: Bool = false) {
        guard !ids.isEmpty || overflow else { return }
        pendingIds[kind, default: []].formUnion(ids)
        if overflow { pendingOverflow.insert(kind) }
        scheduleFlush()
    }

    /// A later move on the same session REPLACES the earlier one.
    ///
    /// Within one window a turn that started and then failed is one fact, not
    /// two, and the fact is the failure. Keeping both would make a page draw a
    /// spinner it must then immediately replace with an error.
    func ingest(turns: [PluginPageChatTurn]) {
        guard !turns.isEmpty else { return }
        for turn in turns {
            pendingTurns[turn.sessionId] = turn
        }
        pendingIds[.chat, default: []].formUnion(turns.map(\.sessionId))
        scheduleFlush()
    }

    private func scheduleFlush() {
        guard timer == nil else { return }
        timer = Task { [weak self] in
            guard let self else { return }
            await self.sleep(Self.windowMs)
            guard !Task.isCancelled else { return }
            self.flush()
        }
    }

    /// Send what has accumulated. Idempotent: an empty window emits nothing.
    func flush() {
        timer?.cancel()
        timer = nil
        let ids = pendingIds
        let overflowKinds = pendingOverflow
        let turns = pendingTurns.values.sorted { $0.sessionId < $1.sessionId }
        pendingIds = [:]
        pendingOverflow = []
        pendingTurns = [:]

        // A stable order so a page that logs frames sees the same sequence for
        // the same window, and so the tests can assert one array.
        for kind in PluginPageHostKind.allCases {
            let kindIds = ids[kind] ?? []
            let kindTurns = kind == .chat ? turns : []
            let carriesOverflow = overflowKinds.contains(kind)
            guard !kindIds.isEmpty || !kindTurns.isEmpty || carriesOverflow else { continue }

            // Sorted then capped, so which ids survive an overflow is
            // deterministic rather than whatever the set happened to hash to.
            let sorted = kindIds.sorted()
            let capped = Array(sorted.prefix(PluginPageHostEventLimits.maxIds))
            let cappedTurns = Array(kindTurns.prefix(PluginPageChatTurn.turnsMax))
            emit(Frame(
                kind: kind,
                ids: capped,
                overflow: carriesOverflow
                    || sorted.count > PluginPageHostEventLimits.maxIds
                    || kindTurns.count > PluginPageChatTurn.turnsMax,
                turns: cappedTurns
            ))
        }
    }

    func cancel() {
        timer?.cancel()
        timer = nil
        pendingIds = [:]
        pendingOverflow = []
        pendingTurns = [:]
    }
}

// MARK: - The source

/// Watches the phone's change streams and feeds one guest's host events.
///
/// Owned by the page host's coordinator and torn down with the guest, so a
/// closed page costs nothing: no observers, no diffs, no retained snapshots.
@MainActor
final class PluginPageHostEventSource {
    private weak var world: PluginPageHostWorldReading?
    private let coalescer: PluginPageHostCoalescer

    private var snapshots: [PluginPageHostKind: PluginPageHostFingerprints] = [:]
    private var chatSnapshot: [String: PluginPageChatObservation] = [:]
    /// Kinds the page has actually asked for. A kind nobody subscribed to is
    /// never diffed — the cost of this whole file is zero for a page that does
    /// not use it.
    private var kinds: Set<PluginPageHostKind> = []
    private var cancellables: Set<AnyCancellable> = []

    init(world: PluginPageHostWorldReading, emit: @escaping (PluginPageHostCoalescer.Frame) -> Void) {
        self.world = world
        self.coalescer = PluginPageHostCoalescer(emit: emit)
    }

    /// Test seam: a coalescer whose window the test drives.
    init(world: PluginPageHostWorldReading, coalescer: PluginPageHostCoalescer) {
        self.world = world
        self.coalescer = coalescer
    }

    /// Follow the phone's own revisions.
    ///
    /// One publisher per kind rather than a single database observer, because
    /// `SyncService` has already done the table-to-projection routing and
    /// re-deriving it here would be a second copy of a mapping that must not
    /// drift. `removeDuplicates` is what stops a republished roster with no
    /// content change from costing a diff.
    func observe(_ sync: SyncService) {
        cancellables.removeAll()
        sync.$lanesProjectionRevision
            .removeDuplicates()
            .dropFirst()
            .sink { [weak self] _ in self?.scan(kinds: [.lane]) }
            .store(in: &cancellables)
        sync.$prsProjectionRevision
            .removeDuplicates()
            .dropFirst()
            .sink { [weak self] _ in self?.scan(kinds: [.pr]) }
            .store(in: &cancellables)
        sync.$workProjectionRevision
            .removeDuplicates()
            .dropFirst()
            .sink { [weak self] _ in self?.scan(kinds: [.session, .chat]) }
            .store(in: &cancellables)
        sync.$rosterRevision
            .removeDuplicates()
            .dropFirst()
            .sink { [weak self] _ in self?.scan(kinds: [.session, .chat]) }
            .store(in: &cancellables)
    }

    /// Take the baseline WITHOUT emitting.
    ///
    /// A page that has just loaded already read the world; telling it every lane
    /// changed the instant it subscribed would make its first render a
    /// double-render. This is the same rule `deliverChanged` follows for the
    /// mirror.
    func subscribe(to added: Set<PluginPageHostKind>) {
        let fresh = added.subtracting(kinds)
        kinds.formUnion(added)
        for kind in fresh {
            snapshots[kind] = world?.pluginPageHostFingerprints(kind: kind) ?? [:]
        }
        if fresh.contains(.chat) {
            chatSnapshot = world?.pluginPageChatObservations() ?? [:]
        }
    }

    func unsubscribe(from removed: Set<PluginPageHostKind>) {
        kinds.subtract(removed)
        for kind in removed { snapshots[kind] = nil }
        if removed.contains(.chat) { chatSnapshot = [:] }
    }

    /// Re-read the world for the given kinds and queue whatever moved.
    func scan(kinds requested: Set<PluginPageHostKind>) {
        guard let world else { return }
        for kind in requested.intersection(kinds) {
            if kind == .chat {
                let current = world.pluginPageChatObservations()
                let turns = PluginPageHostDiffer.chatTurns(previous: chatSnapshot, current: current)
                chatSnapshot = current
                coalescer.ingest(turns: turns)
                continue
            }
            let current = world.pluginPageHostFingerprints(kind: kind)
            let changed = PluginPageHostDiffer.changedIds(previous: snapshots[kind] ?? [:], current: current)
            snapshots[kind] = current
            coalescer.ingest(kind: kind, ids: changed)
        }
    }

    func flushForTests() {
        coalescer.flush()
    }

    func cancel() {
        cancellables.removeAll()
        coalescer.cancel()
        kinds = []
        snapshots = [:]
        chatSnapshot = [:]
    }
}
