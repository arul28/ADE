import ActivityKit
import SwiftUI

/// ActivityKit attributes shared by the main app (which starts / updates the
/// activity) and the widget extension (which renders it). The shapes here match
/// the brain-side Live Activity contract byte-for-byte so an APNs
/// content-state update decodes without a translation layer:
///
///   attributesType: "ADEAgentRunsAttributes"
///   attributes:     { "machineName": String, "accountWide"?: Bool }
///   activityId:     "agent-runs"
///   contentState:   { updatedAt, activeCount, runs: [Run], prs: [PullRequest] }
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

        public init(updatedAt: Double, activeCount: Int, runs: [Run], prs: [PullRequest] = []) {
            self.updatedAt = updatedAt
            self.activeCount = activeCount
            self.runs = runs
            self.prs = prs
        }

        private enum CodingKeys: String, CodingKey {
            case updatedAt, activeCount, runs, prs
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
        }

        /// `Date` view over the unix-seconds marker for relative formatting.
        public var updatedAtDate: Date {
            Date(timeIntervalSince1970: updatedAt)
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

    public init(machineName: String, accountWide: Bool? = nil) {
        self.machineName = machineName
        self.accountWide = accountWide
    }

    public var isAccountWide: Bool {
        if let accountWide { return accountWide }
        let marker = machineName.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return marker == "all machines" || marker == "account"
    }
}

public enum PullRequestPhase: String, CaseIterable, Sendable {
    case opened
    case reopened
    case closed
    case merged
    case checksFailing = "checks_failing"
    case reviewRequested = "review_requested"
    case changesRequested = "changes_requested"
    case mergeReady = "merge_ready"

    public var tint: Color {
        switch self {
        case .opened, .reopened:
            return ADESharedTheme.statusRunning
        case .merged, .mergeReady:
            return ADESharedTheme.statusSuccess
        case .checksFailing, .changesRequested:
            return ADESharedTheme.statusFailed
        case .reviewRequested:
            return ADESharedTheme.statusReview
        case .closed:
            return ADESharedTheme.statusIdle
        }
    }

    public var symbol: String {
        switch self {
        case .opened, .reopened:
            return "arrow.triangle.pull"
        case .closed:
            return "xmark.circle.fill"
        case .merged:
            return "arrow.triangle.merge"
        case .checksFailing:
            return "xmark.octagon.fill"
        case .reviewRequested:
            return "person.crop.circle.badge.clock"
        case .changesRequested:
            return "exclamationmark.bubble.fill"
        case .mergeReady:
            return "checkmark.seal.fill"
        }
    }

    public var label: String {
        switch self {
        case .opened: return "Opened"
        case .reopened: return "Reopened"
        case .closed: return "Closed"
        case .merged: return "Merged"
        case .checksFailing: return "Checks failing"
        case .reviewRequested: return "Review requested"
        case .changesRequested: return "Changes requested"
        case .mergeReady: return "Ready to merge"
        }
    }

    public var needsAttention: Bool {
        self == .checksFailing || self == .changesRequested || self == .reviewRequested || self == .mergeReady
    }
}

/// Phase of a single agent run, with the color / symbol / label mapping the
/// widget and Dynamic Island render. Colors reuse `ADESharedTheme` so the Live
/// Activity stays in lockstep with the lock-screen widget's palette.
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

    public var isTerminal: Bool {
        self == .completed || self == .failed
    }

    public var tint: Color {
        switch self {
        case .starting, .running: return ADESharedTheme.statusRunning
        case .waitingForApproval: return ADESharedTheme.warningAmber
        case .waitingForInput: return ADESharedTheme.warningAmber
        case .completed: return ADESharedTheme.statusSuccess
        case .failed: return ADESharedTheme.statusFailed
        case .stale: return ADESharedTheme.statusIdle
        }
    }

    public var symbol: String {
        switch self {
        case .starting: return "hourglass"
        case .running: return "circle.dotted"
        case .waitingForApproval: return "bell.badge.fill"
        case .waitingForInput: return "keyboard.badge.ellipsis"
        case .completed: return "checkmark.circle.fill"
        case .failed: return "xmark.octagon.fill"
        case .stale: return "wifi.slash"
        }
    }

    /// Short trailing phase label. Sentence case, matching ADE copy norms.
    public var label: String {
        switch self {
        case .starting: return "Starting"
        case .running: return "Running"
        case .waitingForApproval, .waitingForInput: return "Needs you"
        case .completed: return "Completed"
        case .failed: return "Failed"
        case .stale: return "Stale"
        }
    }
}
