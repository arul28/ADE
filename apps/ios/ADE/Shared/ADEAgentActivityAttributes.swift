import ActivityKit
import SwiftUI

/// ActivityKit attributes shared by the main app (which starts / updates the
/// activity) and the widget extension (which renders it). The shapes here match
/// the brain-side Live Activity contract byte-for-byte so an APNs
/// content-state update decodes without a translation layer:
///
///   attributesType: "ADEAgentRunsAttributes"
///   attributes:     { "machineName": String }
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
        public let updatedAt: Double

        public init(
            id: String,
            prNumber: Int,
            title: String,
            phase: String,
            lane: String? = nil,
            repoOwner: String? = nil,
            repoName: String? = nil,
            updatedAt: Double = 0
        ) {
            self.id = id
            self.prNumber = prNumber
            self.title = title
            self.phase = phase
            self.lane = lane
            self.repoOwner = repoOwner
            self.repoName = repoName
            self.updatedAt = updatedAt
        }

        private enum CodingKeys: String, CodingKey {
            case id, prNumber, title, phase, lane, repoOwner, repoName, updatedAt
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
                return URL(string: "ade://pr/\(encodedOwner)/\(encodedRepo)/\(prNumber)")
            }
            return URL(string: "ade://pr/\(prNumber)")
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

        public init(
            id: String,
            title: String,
            phase: String,
            model: String? = nil,
            lane: String? = nil,
            detail: String? = nil,
            itemId: String? = nil
        ) {
            self.id = id
            self.title = title
            self.phase = phase
            self.model = model
            self.lane = lane
            self.detail = detail
            self.itemId = itemId
        }

        private enum CodingKeys: String, CodingKey {
            case id, title, phase, model, lane, detail, itemId
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
    }

    /// Machine that owns these runs. Rendered in the footer so a glance shows
    /// which paired Mac is producing output.
    public var machineName: String

    public init(machineName: String) {
        self.machineName = machineName
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
            return ADESharedTheme.statusSuccess
        case .merged, .mergeReady:
            return ADESharedTheme.statusSuccess
        case .checksFailing, .changesRequested:
            return ADESharedTheme.statusFailed
        case .reviewRequested:
            return ADESharedTheme.warningAmber
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
        case .checksFailing: return "Checks"
        case .reviewRequested: return "Review"
        case .changesRequested: return "Changes"
        case .mergeReady: return "Ready"
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
        case .starting: return ADESharedTheme.statusIdle
        case .running: return ADESharedTheme.statusSuccess
        case .waitingForApproval: return ADESharedTheme.warningAmber
        case .waitingForInput: return ADESharedTheme.statusAttention
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
        case .waitingForApproval: return "Approve"
        case .waitingForInput: return "Reply"
        case .completed: return "Done"
        case .failed: return "Failed"
        case .stale: return "Stale"
        }
    }
}
