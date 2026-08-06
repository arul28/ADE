import ActivityKit
import SwiftUI

public func adeAccountWideActivityMatchesCurrentOwnership(
    attributesEpoch: Int?,
    contentEpoch: Int?,
    currentEpoch: Int?,
    hasCurrentOwner: Bool
) -> Bool {
    guard hasCurrentOwner, let currentEpoch else { return false }
    if let attributesEpoch, let contentEpoch {
        return attributesEpoch == currentEpoch && contentEpoch == currentEpoch
    }
    // Preserve the original account-wide wire format for a first-owner
    // installation during relay rollout. Once this installation has crossed
    // any sign-out or account-switch boundary, an unfenced legacy activity is
    // no longer safe to attribute to the current account.
    return attributesEpoch == nil
        && contentEpoch == nil
        && currentEpoch == 2
}

/// ActivityKit attributes shared by the main app (which starts / updates the
/// activity) and the widget extension (which renders it). The shapes here match
/// the brain-side Live Activity contract byte-for-byte so an APNs
/// content-state update decodes without a translation layer:
///
///   attributesType: "ADEAgentRunsAttributes"
///   attributes:     {
///                     "machineName": String,
///                     "accountWide"?: Bool,
///                     "ownershipEpoch"?: Int
///                   }
///   activityId:     "agent-runs"
///   contentState:   {
///                     updatedAt,
///                     activeCount,
///                     runs: [Run],
///                     prs: [PullRequest],
///                     ownershipEpoch?: Int,
///                     groups?: [{ group, count }],
///                     moreCount?: Int
///                   }
///
/// `groups` and `moreCount` are the island's account-wide tallies. They are
/// optional because the relay does not send them yet; without them the compact
/// leading counts only the three-row roster, which undercounts but never lies.
/// `groups[].group` is one of `needs_you | failed | planning | working | done`.
///
/// Decoding is deliberately lenient — a run row with an unrecognised `phase`
/// still renders (as `.running`), and a missing optional collapses to `nil`
/// rather than failing the whole push.
public struct ADEAgentRunsAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        /// Host-stamped freshness marker (unix seconds). Rendered as a relative
        /// "updated Ns ago" so a stalled push is visible at a glance.
        public var updatedAt: Double
        /// Total number of active runs on the machine — may exceed `runs.count`
        /// because the roster is capped at three for the glance.
        public var activeCount: Int
        public var runs: [Run]
        public var prs: [PullRequest]
        /// Repeated on every account-wide update so a delayed update from a
        /// prior owner cannot refresh an otherwise valid ActivityKit instance.
        public var ownershipEpoch: Int?
        /// Account-wide state-group tallies — what the island's compact
        /// leading counts. **Optional and additive.** The roster is capped at
        /// three runs, so these cannot be derived from `runs`; when the
        /// publisher omits them the island falls back to counting the visible
        /// roster, which undercounts rather than lies.
        public var groups: [StateGroupCount]?
        /// How many rows the capped roster left off, straight from the
        /// publisher. Absent → derived locally from `activeCount` and the
        /// rendered rows.
        public var moreCount: Int?

        public init(
            updatedAt: Double,
            activeCount: Int,
            runs: [Run],
            prs: [PullRequest] = [],
            ownershipEpoch: Int? = nil,
            groups: [StateGroupCount]? = nil,
            moreCount: Int? = nil
        ) {
            self.updatedAt = updatedAt
            self.activeCount = activeCount
            self.runs = runs
            self.prs = prs
            self.ownershipEpoch = ownershipEpoch
            self.groups = groups
            self.moreCount = moreCount
        }

        private enum CodingKeys: String, CodingKey {
            case updatedAt, activeCount, runs, prs, ownershipEpoch, groups, moreCount
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            // Accept both integer and fractional unix seconds.
            self.updatedAt = (try? c.decode(Double.self, forKey: .updatedAt)) ?? 0
            self.activeCount = (try? c.decode(Int.self, forKey: .activeCount)) ?? 0
            let decodedRuns = (try? c.decode([Run].self, forKey: .runs)) ?? []
            self.runs = Array(decodedRuns.prefix(3))
            let decodedPrs = (try? c.decode([PullRequest].self, forKey: .prs)) ?? []
            self.prs = Array(decodedPrs.prefix(2))
            self.ownershipEpoch = try? c.decodeIfPresent(Int.self, forKey: .ownershipEpoch)
            let decodedGroups = (try? c.decodeIfPresent([StateGroupCount].self, forKey: .groups))
                ?? nil
            // An all-zero or unparseable tally is worse than none: it would
            // render a confident "0" over a roster that plainly has rows.
            let usableGroups = decodedGroups?.filter { $0.resolvedGroup != nil && $0.count > 0 }
            self.groups = (usableGroups?.isEmpty ?? true) ? nil : usableGroups
            let decodedMore = (try? c.decodeIfPresent(Int.self, forKey: .moreCount)) ?? nil
            self.moreCount = decodedMore.map { max(0, $0) }
        }

        /// Publisher-supplied tallies, resolved and ordered, or `nil` when the
        /// payload predates the field.
        public var resolvedGroups: [(group: ActivityStateGroup, count: Int)]? {
            guard let groups else { return nil }
            let resolved = groups.compactMap { entry -> (ActivityStateGroup, Int)? in
                guard let group = entry.resolvedGroup, entry.count > 0 else { return nil }
                return (group, entry.count)
            }
            guard !resolved.isEmpty else { return nil }
            return resolved
                .sorted { $0.0.rank < $1.0.rank }
                .map { (group: $0.0, count: $0.1) }
        }

        /// `Date` view over the unix-seconds marker for relative formatting.
        public var updatedAtDate: Date {
            Date(timeIntervalSince1970: updatedAt)
        }
    }

    /// One `{group, count}` tally on the Live Activity wire.
    public struct StateGroupCount: Codable, Hashable, Identifiable, Sendable {
        /// Wire slug: `needs_you` | `failed` | `planning` | `working` | `done`.
        public let group: String
        public let count: Int

        public var id: String { group }

        public init(group: String, count: Int) {
            self.group = group
            self.count = count
        }

        public init(group: ActivityStateGroup, count: Int) {
            self.group = group.wireValue
            self.count = count
        }

        private enum CodingKeys: String, CodingKey {
            case group, count
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.group = (try? c.decode(String.self, forKey: .group)) ?? ""
            self.count = max(0, (try? c.decode(Int.self, forKey: .count)) ?? 0)
        }

        public var resolvedGroup: ActivityStateGroup? {
            ActivityStateGroup(wireValue: group)
        }
    }

    public struct PullRequest: Codable, Hashable, Identifiable {
        public let id: String
        public let prNumber: Int
        public let title: String
        public let phase: String
        public let lane: String?
        public let repoOwner: String?
        public let repoName: String?
        /// Canonical Relay machine identity for account-wide activities.
        /// Taps use it to connect to the exact host before opening the PR.
        public let accountMachineKey: String?
        public let updatedAt: Double

        public init(
            id: String,
            prNumber: Int,
            title: String,
            phase: String,
            lane: String? = nil,
            repoOwner: String? = nil,
            repoName: String? = nil,
            accountMachineKey: String? = nil,
            updatedAt: Double = 0
        ) {
            self.id = id
            self.prNumber = prNumber
            self.title = title
            self.phase = phase
            self.lane = lane
            self.repoOwner = repoOwner
            self.repoName = repoName
            self.accountMachineKey = accountMachineKey
            self.updatedAt = updatedAt
        }

        private enum CodingKeys: String, CodingKey {
            case id, prNumber, title, phase, lane, repoOwner, repoName, accountMachineKey, updatedAt
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
            self.prNumber = (try? c.decode(Int.self, forKey: .prNumber)) ?? 0
            self.title = (try? c.decode(String.self, forKey: .title)) ?? "Pull request"
            self.phase = (try? c.decode(String.self, forKey: .phase)) ?? PullRequestPhase.opened.rawValue
            self.lane = try? c.decodeIfPresent(String.self, forKey: .lane)
            self.repoOwner = try? c.decodeIfPresent(String.self, forKey: .repoOwner)
            self.repoName = try? c.decodeIfPresent(String.self, forKey: .repoName)
            self.accountMachineKey = try? c.decodeIfPresent(String.self, forKey: .accountMachineKey)
            self.updatedAt = (try? c.decode(Double.self, forKey: .updatedAt)) ?? 0
        }

        public var resolvedPhase: PullRequestPhase {
            PullRequestPhase(rawValue: phase.lowercased()) ?? .opened
        }

        public var subtitle: String? {
            let lane = lane?.trimmingCharacters(in: .whitespacesAndNewlines)
            return lane?.isEmpty == false ? lane : nil
        }

        public var deepLinkURL: URL? {
            guard prNumber > 0 else { return nil }
            let owner = repoOwner?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let repo = repoName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !owner.isEmpty,
               !repo.isEmpty,
               let encodedOwner = owner.addingPercentEncoding(withAllowedCharacters: Self.pathSegmentAllowed),
               let encodedRepo = repo.addingPercentEncoding(withAllowedCharacters: Self.pathSegmentAllowed) {
                var components = URLComponents(
                    string: "ade://pr/\(encodedOwner)/\(encodedRepo)/\(prNumber)"
                )
                components?.queryItems = accountMachineQueryItems
                return components?.url
            }
            var components = URLComponents(string: "ade://pr/\(prNumber)")
            components?.queryItems = accountMachineQueryItems
            return components?.url
        }

        private var accountMachineQueryItems: [URLQueryItem]? {
            guard let key = accountMachineKey?
                .trimmingCharacters(in: .whitespacesAndNewlines),
                  !key.isEmpty else { return nil }
            return [URLQueryItem(name: "accountMachineKey", value: key)]
        }

        private static var pathSegmentAllowed: CharacterSet {
            var allowed = CharacterSet.alphanumerics
            allowed.insert(charactersIn: "-._~")
            return allowed
        }
    }

    public struct Run: Codable, Hashable, Identifiable {
        public let id: String
        public let title: String
        /// Raw phase slug from the host. Kept as the wire string so an unknown
        /// future phase round-trips; use `resolvedPhase` for rendering.
        public let phase: String
        public let model: String?
        public let lane: String?
        public let detail: String?
        /// Approval item id, present only on rows whose `phase` is
        /// `waiting_for_approval`. Threaded into the lock-screen Approve/Deny
        /// intents so they resolve the exact pending request. Optional and
        /// additive — older payloads without it decode to `nil`.
        public let itemId: String?
        /// Canonical Relay machine identity for account-wide activities.
        public let accountMachineKey: String?

        public init(
            id: String,
            title: String,
            phase: String,
            model: String? = nil,
            lane: String? = nil,
            detail: String? = nil,
            itemId: String? = nil,
            accountMachineKey: String? = nil
        ) {
            self.id = id
            self.title = title
            self.phase = phase
            self.model = model
            self.lane = lane
            self.detail = detail
            self.itemId = itemId
            self.accountMachineKey = accountMachineKey
        }

        private enum CodingKeys: String, CodingKey {
            case id, title, phase, model, lane, detail, itemId, accountMachineKey
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
            self.title = (try? c.decode(String.self, forKey: .title)) ?? "Agent run"
            self.phase = (try? c.decode(String.self, forKey: .phase)) ?? AgentRunPhase.running.rawValue
            self.model = try? c.decodeIfPresent(String.self, forKey: .model)
            self.lane = try? c.decodeIfPresent(String.self, forKey: .lane)
            self.detail = try? c.decodeIfPresent(String.self, forKey: .detail)
            self.itemId = try? c.decodeIfPresent(String.self, forKey: .itemId)
            self.accountMachineKey = try? c.decodeIfPresent(String.self, forKey: .accountMachineKey)
        }

        public var resolvedPhase: AgentRunPhase {
            AgentRunPhase(rawValue: phase.lowercased()) ?? .running
        }

        /// "lane · model" subtitle, dropping whichever half is missing.
        public var subtitle: String? {
            let parts = [lane, model]
                .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
            return parts.isEmpty ? nil : parts.joined(separator: " · ")
        }

        public var deepLinkURL: URL? {
            var allowed = CharacterSet.alphanumerics
            allowed.insert(charactersIn: "-._~")
            guard let encoded = id.addingPercentEncoding(withAllowedCharacters: allowed) else {
                return nil
            }
            var components = URLComponents(string: "ade://session/\(encoded)")
            var queryItems: [URLQueryItem] = []
            if let itemId = itemId?.trimmingCharacters(in: .whitespacesAndNewlines),
               !itemId.isEmpty {
                queryItems.append(URLQueryItem(name: "item", value: itemId))
            }
            if let key = accountMachineKey?
                .trimmingCharacters(in: .whitespacesAndNewlines),
               !key.isEmpty {
                queryItems.append(URLQueryItem(name: "accountMachineKey", value: key))
            }
            components?.queryItems = queryItems.isEmpty ? nil : queryItems
            return components?.url
        }
    }

    /// Machine that owns these runs, or an account-level label when this is an
    /// aggregate. Rendered in the footer so scope is always visible.
    public var machineName: String
    /// Account aggregates span several machines and must survive the
    /// single-paired-host orphan cleanup. Optional keeps attributes started by
    /// older relay versions decodable.
    public var accountWide: Bool?
    /// Non-PII ownership fence stamped by Relay for account-wide activities.
    /// The main app ends an activity unless this exactly matches the current
    /// signed-in ownership epoch for this installation.
    public var ownershipEpoch: Int?

    public init(
        machineName: String,
        accountWide: Bool? = nil,
        ownershipEpoch: Int? = nil
    ) {
        self.machineName = machineName
        self.accountWide = accountWide
        self.ownershipEpoch = ownershipEpoch
    }

    public var isAccountWide: Bool {
        if let accountWide { return accountWide }
        let marker = machineName.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return marker == "all machines" || marker == "account"
    }
}

/// Live Activity wire phase for a pull request.
///
/// **Presentation is not defined here.** Every hue and glyph is resolved by
/// projecting onto `AccountAttentionPhase` and asking `ActivityPhaseVocabulary`
/// — the single table the drawer, the row, the widget and the island all read.
/// This enum used to carry its own copy, which is how the Live Activity ended
/// up showing an octagon for a failure the rest of the app drew as a triangle.
/// The raw values are the wire format and are not free to change.
public enum PullRequestPhase: String, CaseIterable, Sendable {
    case opened
    case reopened
    case closed
    case merged
    case checksFailing = "checks_failing"
    case reviewRequested = "review_requested"
    case changesRequested = "changes_requested"
    case mergeReady = "merge_ready"

    /// Projection onto the shared vocabulary's phase space.
    public var attentionPhase: AccountAttentionPhase {
        switch self {
        case .opened, .reopened: return .open
        case .closed: return .closed
        case .merged: return .merged
        case .checksFailing: return .checksFailing
        case .reviewRequested: return .reviewRequested
        case .changesRequested: return .changesRequested
        case .mergeReady: return .mergeReady
        }
    }

    private var presentation: ActivityPhasePresentation {
        ActivityPhaseVocabulary.presentation(for: attentionPhase)
    }

    public var tone: ActivityTone { presentation.tone }

    public var stateGroup: ActivityStateGroup {
        ActivityPhaseVocabulary.stateGroup(for: attentionPhase)
    }

    public var tint: Color { activityToneColor(tone) }

    /// The shared glyph, with a PR-shaped fallback for the phases the session
    /// vocabulary leaves glyph-less (a plain open PR is not a session state).
    public var glyph: ActivityGlyph? { presentation.glyph }

    public var symbol: String {
        if let glyph = presentation.glyph { return glyph.systemImage }
        switch self {
        case .closed: return "xmark.circle.fill"
        default: return "arrow.triangle.pull"
        }
    }

    /// Shared label, except for the two phases that collapse to one session
    /// phase — a PR that was *reopened* is worth distinguishing from one that
    /// was merely opened, and the shared table has no word for that.
    public var label: String {
        switch self {
        case .opened: return "Opened"
        case .reopened: return "Reopened"
        default: return presentation.label
        }
    }

    public var needsAttention: Bool {
        self == .checksFailing || self == .changesRequested || self == .reviewRequested || self == .mergeReady
    }
}

/// Phase of a single agent run, with the color / symbol / label mapping the
/// widget and Dynamic Island render. Colors reuse `ADESharedTheme` so the Live
/// Activity stays in lockstep with the lock-screen widget's palette.
///
/// This is the iOS mirror of the desktop's one presentation vocabulary
/// (`apps/desktop/src/shared/sessionStatusPresentation.ts`). The hue rule is
/// the whole point of that module and must hold here too, because a user who
/// learns a color on the sidebar reads the same color on their Lock Screen:
///
///   blue     work is happening, nothing is asked of you
///   amber    YOUR MOVE — and nothing else, ever
///   emerald  finished cleanly, you have not looked yet
///   red      it broke
///   neutral  true, but not actionable (stale)
///
/// Amber previously carried five unrelated meanings across ADE, so it meant
/// nothing. Anything that is merely *interesting* — a stale run, a sync in
/// flight, an offline host — is neutral. Spending amber on it is what trains
/// people to stop looking at the one color that should always mean "act".
///
/// The raw values are the push / Live Activity wire format (see
/// `apps/desktop/src/shared/sessionCanonicalState.ts`). Presentation here is
/// free to change; the slugs are not — desktop versions already in the field
/// send them.
public enum AgentRunPhase: String, CaseIterable, Sendable {
    case starting
    case running
    case waitingForApproval = "waiting_for_approval"
    case waitingForInput = "waiting_for_input"
    case completed
    case failed
    case stale

    /// True for the phases that should be visually prioritised — they need the
    /// user to act, so the widget tints their rows and sorts them first.
    public var needsAttention: Bool {
        self == .waitingForApproval || self == .waitingForInput
    }

    /// Whether the state should pull the eye. Read straight off the shared
    /// vocabulary's `prominent` flag: an outcome (done, failed) or a raised
    /// hand earns colour and weight; work in flight does not, because
    /// prominence is a request for attention, not a progress report.
    public var isProminent: Bool { presentation.prominent }

    public var isTerminal: Bool {
        self == .completed || self == .failed
    }

    /// Projection onto the shared vocabulary's phase space. Both waiting
    /// variants collapse to `.needsYou`: the row says which kind of answer is
    /// wanted in words and in its inline actions, and one state may not wear
    /// two glyphs on a surface that shows five states side by side.
    public var attentionPhase: AccountAttentionPhase {
        switch self {
        case .starting: return .starting
        case .running: return .running
        case .waitingForApproval, .waitingForInput: return .needsYou
        case .completed: return .completed
        case .failed: return .failed
        case .stale: return .stale
        }
    }

    private var presentation: ActivityPhasePresentation {
        ActivityPhaseVocabulary.presentation(for: attentionPhase)
    }

    public var tone: ActivityTone { presentation.tone }

    public var stateGroup: ActivityStateGroup {
        ActivityPhaseVocabulary.stateGroup(for: attentionPhase)
    }

    public var glyph: ActivityGlyph? { presentation.glyph }

    /// Hue, glyph and word all come from `ActivityPhaseVocabulary` — see the
    /// note on `PullRequestPhase`. Nothing about a Live Activity justifies its
    /// own colour table, and having one is what let the island drift.
    public var tint: Color { activityToneColor(tone) }

    public var symbol: String { presentation.glyph?.systemImage ?? "circle.dotted" }

    public var label: String { presentation.label }
}
