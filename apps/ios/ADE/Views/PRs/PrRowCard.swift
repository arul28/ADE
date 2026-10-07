import SwiftUI
import UIKit

// The PR list row, the desktop `GitHubTabPrRow` on the flat base: the number
// and title (two lines at most) with the author on the right, then one detail
// line with where it merges, its lane, and its diff stat. Nothing else: no
// @author text, no comment count, no card.

// MARK: - Shared bits

private func prAdaptiveColor(light: UInt32, dark: UInt32) -> Color {
  func ui(_ value: UInt32) -> UIColor {
    UIColor(
      red: CGFloat((value >> 16) & 0xff) / 255,
      green: CGFloat((value >> 8) & 0xff) / 255,
      blue: CGFloat(value & 0xff) / 255,
      alpha: 1
    )
  }
  return Color(UIColor { $0.userInterfaceStyle == .dark ? ui(dark) : ui(light) })
}

/// GitHub's own PR state colours (desktop `--pr-open/merged/closed`): open
/// green, merged purple, closed red, draft neutral; GitHub's light-theme
/// shades in light mode.
func prStateColor(_ state: String) -> Color {
  switch state {
  case "open": return prAdaptiveColor(light: 0x1A7F37, dark: 0x3FB950)
  case "merged": return prAdaptiveColor(light: 0x8250DF, dark: 0xA371F7)
  case "closed": return prAdaptiveColor(light: 0xCF222E, dark: 0xF85149)
  default: return ADEColor.textMuted
  }
}

/// GitHub's state glyph for a PR (open, draft, merged, closed).
func prStateSymbol(_ state: String) -> String {
  switch state {
  case "merged": return "arrow.triangle.merge"
  case "closed": return "xmark.circle"
  case "draft": return "circle.dashed"
  default: return "arrow.triangle.pull"
  }
}

/// A PR's state as a GitHub-coloured glyph on a light wash of the same colour
/// (desktop `.ade-home-pr-icon`).
struct PrStateIcon: View {
  let state: String
  var size: CGFloat = 22

  var body: some View {
    let tint = prStateColor(state)
    Image(systemName: prStateSymbol(state))
      .font(.system(size: size * 0.48, weight: .semibold))
      .foregroundStyle(tint)
      .frame(width: size, height: size)
      .background(
        state == "draft" ? ADEColor.textPrimary.opacity(0.07) : tint.opacity(0.15),
        in: RoundedRectangle(cornerRadius: size * 0.3, style: .continuous)
      )
      .accessibilityLabel(state.capitalized)
  }
}

/// A PR's state as GitHub shows it: glyph and word on a light wash of the
/// state colour ("Open", "Draft", "Merged", "Closed").
struct PrStatePill: View {
  let state: String

  var body: some View {
    let tint = prStateColor(state)
    HStack(spacing: 4) {
      Image(systemName: prStateSymbol(state))
        .font(.system(size: 10, weight: .semibold))
      Text(state.isEmpty ? "Unknown" : state.capitalized)
        .font(.system(size: 12, weight: .semibold))
    }
    .foregroundStyle(tint)
    .padding(.horizontal, 8)
    .frame(height: 22)
    .background(state == "draft" ? ADEColor.textPrimary.opacity(0.07) : tint.opacity(0.14), in: Capsule())
    .fixedSize()
  }
}

func prDiffAddColor() -> Color { prStateColor("open") }
func prDiffDeleteColor() -> Color { prStateColor("closed") }

/// `+1,204 −380` in mono green / red.
struct PrDiffStat: View {
  let additions: Int
  let deletions: Int
  var abbreviated = false
  var size: CGFloat = 11

  var body: some View {
    HStack(spacing: 4) {
      Text(verbatim: "+\(format(additions))").foregroundStyle(prDiffAddColor())
      Text(verbatim: "−\(format(deletions))").foregroundStyle(prDiffDeleteColor())
    }
    .font(.adeMono(size))
    .fixedSize()
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(additions) added, \(deletions) removed")
  }

  private func format(_ value: Int) -> String {
    abbreviated ? prAbbreviatedCount(value) : value.formatted(.number)
  }
}

/// An author's avatar: a known bot in its brand color with its initial, a
/// person's GitHub picture (initials while it loads or when it fails).
struct PrAvatar: View {
  let login: String?
  var isBot: Bool? = nil
  var avatarUrl: String? = nil
  var size: CGFloat = 20

  private var identity: PrAuthorIdentity {
    PrAuthorIdentity.classify(login, accountIsBot: isBot)
  }

  private var imageURL: URL? {
    if let avatarUrl, let url = URL(string: avatarUrl) { return url }
    guard let login, !login.isEmpty, !identity.isBot else { return nil }
    let px = Int(size * 2)
    return URL(string: "https://avatars.githubusercontent.com/\(login)?size=\(px)")
  }

  var body: some View {
    Group {
      if let url = imageURL {
        AsyncImage(url: url) { phase in
          if let image = phase.image {
            image.resizable().scaledToFill()
          } else {
            initials
          }
        }
      } else {
        initials
      }
    }
    .frame(width: size, height: size)
    .clipShape(Circle())
    .overlay(Circle().stroke(ADEFlat.hairline, lineWidth: 0.5))
    .accessibilityHidden(true)
  }

  private var tint: Color {
    if let hex = identity.brandColorHex, let value = UInt32(hex.dropFirst(), radix: 16) {
      return Color(
        red: Double((value >> 16) & 0xff) / 255,
        green: Double((value >> 8) & 0xff) / 255,
        blue: Double(value & 0xff) / 255
      )
    }
    return ADEColor.textMuted
  }

  private var initials: some View {
    let name = identity.isBot ? identity.displayName : (login ?? "")
    return ZStack {
      Circle().fill(tint.opacity(identity.isBot ? 0.22 : 0.16))
      Text(String(name.prefix(1)).uppercased())
        .font(.system(size: size * 0.5, weight: .bold, design: .rounded))
        .foregroundStyle(identity.isBot ? tint : ADEColor.textSecondary)
    }
  }
}

/// A PR's lane on a detail line: the lane chip, `was: <lane>` for a lane that
/// is gone, and the lane's machine icon only when it is not the primary machine.
struct PrLaneChip: View {
  let laneName: String?
  var ghostLaneName: String? = nil
  /// Set only for a lane on a machine other than the primary one.
  var machineName: String? = nil

  var body: some View {
    if let laneName, !laneName.isEmpty {
      ADEKitChip(
        symbol: machineName == nil ? "arrow.triangle.branch" : "desktopcomputer",
        text: laneName,
        tint: ADEColor.textSecondary
      )
      .accessibilityLabel(machineName.map { "Lane \(laneName) on \($0)" } ?? "Lane \(laneName)")
    } else if let ghostLaneName, !ghostLaneName.isEmpty {
      ADEKitChip(symbol: nil, text: "was: \(ghostLaneName)", tint: ADEColor.textMuted)
        .accessibilityLabel("Built in lane \(ghostLaneName), now deleted")
    }
  }
}

/// An empty state as one quiet flat row.
struct PrFlatEmptyRow: View {
  let title: String
  var message: String? = nil

  var body: some View {
    VStack(spacing: 4) {
      Text(title)
        .font(.subheadline.weight(.medium))
        .foregroundStyle(ADEColor.textSecondary)
      if let message {
        Text(message)
          .font(.caption)
          .foregroundStyle(ADEColor.textMuted)
          .multilineTextAlignment(.center)
      }
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 20)
    .accessibilityElement(children: .combine)
  }
}

// MARK: - Row

struct PrRowCard: View {
  let data: Data

  init(pr: PullRequestListItem) {
    self.data = Data(pr: pr)
  }

  init(item: GitHubPrListItem, linkedPr: PullRequestListItem? = nil, laneMachineName: String? = nil) {
    var data = Data(item: item, linkedPr: linkedPr)
    data.laneMachineName = laneMachineName
    self.data = data
  }

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: prStateSymbol(data.state))
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(prStateColor(data.state))
        .frame(width: 16, height: 18)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 5) {
        Text("\(Text(verbatim: "#\(data.prNumber)").font(.adeMono(13, weight: .medium)).foregroundStyle(ADEColor.textMuted)) \(data.title)")
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(2)
          .multilineTextAlignment(.leading)
          .frame(maxWidth: .infinity, alignment: .leading)

        HStack(spacing: 6) {
          if let branch = data.branchLine {
            Text(verbatim: branch)
              .font(.adeMono(11))
              .foregroundStyle(ADEColor.textMuted)
              .lineLimit(1)
              .truncationMode(.middle)
          }
          PrLaneChip(
            laneName: data.laneLabel,
            ghostLaneName: data.detached?.laneName,
            machineName: data.laneMachineName
          )
          .frame(maxWidth: 150, alignment: .leading)
          .fixedSize(horizontal: false, vertical: true)
          if data.isExternal {
            Text(verbatim: "\(data.repoOwner)/\(data.repoName)")
              .font(.adeMono(10.5))
              .foregroundStyle(ADEColor.textMuted)
              .lineLimit(1)
          }
          Spacer(minLength: 4)
          if data.needsBranchCleanup {
            Image(systemName: "arrow.triangle.branch")
              .font(.system(size: 10, weight: .semibold))
              .foregroundStyle(ADEColor.warning)
              .accessibilityLabel("Remote branch still exists")
          }
          if let additions = data.additions, let deletions = data.deletions, additions + deletions > 0 {
            PrDiffStat(additions: additions, deletions: deletions, abbreviated: true, size: 10.5)
          }
          if !data.isTerminal, let ci = data.ciIndicator {
            PrRowCiGlyph(indicator: ci)
              .font(.system(size: 11))
          }
        }
      }
      PrAvatar(login: data.authorLogin, isBot: data.isBot ? true : nil, size: 20)
        .padding(.top, 1)
    }
    .contentShape(Rectangle())
    .accessibilityElement(children: .combine)
    .accessibilityLabel(accessibilitySummary)
    .adeInspectable(
      "PR.List.Row",
      metadata: [
        "label": "PR #\(data.prNumber): \(data.title), state \(data.state)",
        "prId": data.id,
        "number": String(data.prNumber),
        "state": data.state,
        "title": data.title,
        "role": "row"
      ]
    )
  }

  private var accessibilitySummary: String {
    var parts = ["Pull request \(data.prNumber)", data.title, data.state]
    if let author = data.authorLogin, !author.isEmpty { parts.append("by \(author)") }
    if let branch = data.branchLine { parts.append(branch.replacingOccurrences(of: "→", with: "into")) }
    if let lane = data.laneLabel {
      parts.append("lane \(lane)")
      if let machine = data.laneMachineName { parts.append("on \(machine)") }
    } else if let ghost = data.detached?.laneName {
      parts.append("was lane \(ghost)")
    }
    if let additions = data.additions, let deletions = data.deletions { parts.append("\(additions) added, \(deletions) removed") }
    if !data.isTerminal, let ci = data.ciIndicator { parts.append(ci.title) }
    return parts.joined(separator: ", ")
  }
}

/// The row's CI signal. `not_run` is a hollow dashed ring: an empty slot where
/// a result should be, never the failure red.
struct PrRowCiGlyph: View {
  let indicator: PrRowCard.Data.CIIndicator

  var body: some View {
    switch indicator.glyph {
    case .symbol:
      // CI is a coloured dot (desktop `.kit-dot`); the detail has the counts.
      ADEKitDot(color: indicator.color, size: 7)
        .frame(width: 12, height: 12)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(indicator.title)
    case .hollowRing:
      Circle()
        .strokeBorder(indicator.color, style: StrokeStyle(lineWidth: 1.3, lineCap: .round, dash: [2.2, 2.6]))
        .frame(width: 12, height: 12)
        .accessibilityElement()
        .accessibilityLabel(indicator.title)
    }
  }
}

struct PrRowCardSkeleton: View {
  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      VStack(alignment: .leading, spacing: 8) {
        ADESkeletonView(height: 14, cornerRadius: 4)
        ADESkeletonView(width: 200, height: 14, cornerRadius: 4)
        HStack(spacing: 8) {
          ADESkeletonView(width: 70, height: 10, cornerRadius: 3)
          ADESkeletonView(width: 90, height: 12, cornerRadius: 4)
          Spacer(minLength: 0)
          ADESkeletonView(width: 56, height: 10, cornerRadius: 3)
        }
      }
      ADESkeletonView(width: 20, height: 20, cornerRadius: 10)
    }
  }
}

/// "TODAY · 11 merged · +20k −6.7k", with a spinner while more history loads.
struct PrListGroupHeader: View {
  let group: PrListPeriodGroup
  var isLoading = false

  var body: some View {
    let detail = ["\(group.count) \(group.outcome)", group.diffSummary].compactMap { $0 }.joined(separator: " · ")
    ADEFlatSectionHeader(group.label, detail: detail) {
      if isLoading {
        ProgressView().controlSize(.mini)
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(.isHeader)
  }
}

/// The long-press preview of a row: the start of the description, the checks,
/// and the lane. Reads the cached snapshot, so it never waits on the network.
struct PrRowContextPreview: View {
  let data: PrRowCard.Data
  let syncService: SyncService
  let snapshotPrId: String?
  let warmKey: String

  @State private var snapshot: PullRequestSnapshot?

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(verbatim: "#\(data.prNumber)")
          .font(.adeMono(13, weight: .semibold))
          .foregroundStyle(ADEColor.textMuted)
        PrStatePill(state: data.state)
        Spacer(minLength: 0)
        PrAvatar(login: data.authorLogin, isBot: data.isBot ? true : nil, size: 22)
      }
      Text(data.title)
        .font(.headline)
        .foregroundStyle(ADEColor.textPrimary)
        .fixedSize(horizontal: false, vertical: true)
      if let branch = data.branchLine {
        Text(verbatim: branch).font(.adeMono(11)).foregroundStyle(ADEColor.textMuted).lineLimit(1)
      }
      Divider().overlay(ADEFlat.hairline)
      let description = prCleanBody(snapshot?.detail?.body).body
      Text(description.isEmpty ? "No description." : prDigestPreview(description, max: 420))
        .font(.footnote)
        .foregroundStyle(description.isEmpty ? ADEColor.textMuted : ADEColor.textSecondary)
        .lineLimit(7)
        .fixedSize(horizontal: false, vertical: true)
      HStack(spacing: 8) {
        if let checks = checksLine {
          Label(checks.text, systemImage: checks.symbol)
            .font(.caption)
            .foregroundStyle(checks.tint)
        }
        Spacer(minLength: 0)
        PrLaneChip(laneName: data.laneLabel, ghostLaneName: data.detached?.laneName, machineName: data.laneMachineName)
      }
    }
    .padding(16)
    .frame(width: 340, alignment: .leading)
    .background(ADEColor.pageBackground)
    .task {
      if let entry = syncService.prDetailWarmEntry(for: warmKey), let cached = entry.snapshot {
        snapshot = cached
      }
      if snapshot == nil, let snapshotPrId {
        snapshot = try? await syncService.fetchPullRequestSnapshot(prId: snapshotPrId)
      }
    }
  }

  private var checksLine: (text: String, symbol: String, tint: Color)? {
    if let checks = snapshot?.checks, !checks.isEmpty {
      let overall = snapshot?.status?.checksStatus
      let summary = prChecksHeadline(checks: checks, overallChecksStatus: overall)
      let notRun = overall?.lowercased() == "not_run"
      return (summary.text, summary.failing > 0 ? "xmark.circle.fill" : summary.running > 0 ? "clock" : "checkmark.circle.fill",
              summary.failing > 0 ? ADEColor.danger : summary.running > 0 ? ADEColor.warning : (notRun ? ADEColor.textMuted : ADEColor.success))
    }
    if let ci = data.ciIndicator { return (ci.title, "checklist", ci.color) }
    return nil
  }
}

// MARK: - Model

extension PrRowCard {
  struct Data {
    let id: String
    let prNumber: Int
    let title: String
    let state: String
    let updatedAt: String
    let headBranch: String?
    let baseBranch: String?
    let authorLogin: String?
    let isBot: Bool
    let repoOwner: String
    let repoName: String
    let isExternal: Bool
    let isUnmapped: Bool
    let laneId: String?
    let laneLabel: String?
    let checksStatus: String?
    /// Host-supplied explanation for a non-obvious rollup, carried on the CI
    /// glyph's accessibility label.
    let checksReason: String?
    let reviewStatus: String?
    let warnMessage: String?
    var additions: Int?
    var deletions: Int?
    /// True for merged/closed rows, which read as a record rather than a queue item.
    var isTerminal: Bool = false
    /// Lane provenance frozen when the lane was deleted.
    var detached: PrDetachedLane? = nil
    var mergedAt: String? = nil
    var needsBranchCleanup: Bool = false
    /// The lane's machine, only when it is not the primary machine.
    var laneMachineName: String? = nil

    /// `head → base` for an open PR, `→ base` once it merged or closed.
    var branchLine: String? {
      guard let base = baseBranch, !base.isEmpty else { return nil }
      if !isTerminal, let head = headBranch, !head.isEmpty { return "\(head) → \(base)" }
      return "→ \(base)"
    }

    struct CIIndicator {
      /// `not_run` has no honest SF Symbol, so it draws a hollow dashed ring.
      enum Glyph: Equatable {
        case symbol(String)
        case hollowRing
      }

      let glyph: Glyph
      let color: Color
      let title: String
    }

    var ciIndicator: CIIndicator? {
      switch checksStatus {
      case "passing":
        return CIIndicator(glyph: .symbol("checkmark.circle.fill"), color: ADEColor.success, title: "CI passing")
      case "failing":
        return CIIndicator(glyph: .symbol("xmark.circle.fill"), color: ADEColor.danger, title: "CI failing")
      case "pending":
        return CIIndicator(glyph: .symbol("clock.fill"), color: ADEColor.warning, title: "CI pending")
      case "not_run":
        return CIIndicator(glyph: .hollowRing, color: ADEColor.textMuted, title: checksReason ?? noCIReasonText)
      default:
        return nil
      }
    }

    init(pr: PullRequestListItem) {
      self.id = pr.id
      self.prNumber = pr.githubPrNumber
      self.title = pr.title
      self.state = pr.state
      self.updatedAt = pr.updatedAt
      self.headBranch = pr.headBranch
      self.baseBranch = pr.baseBranch
      self.authorLogin = nil
      self.isBot = false
      self.repoOwner = pr.repoOwner
      self.repoName = pr.repoName
      self.isExternal = false
      self.isUnmapped = false
      self.laneId = pr.laneId.isEmpty ? nil : pr.laneId
      self.laneLabel = pr.laneName ?? (pr.laneId.isEmpty ? nil : pr.laneId)
      // Only "none" (nothing observed, nothing expected) is silent; "not_run" is a finding.
      self.checksStatus = pr.checksStatus == "none" ? nil : pr.checksStatus
      self.checksReason = pr.checksReason
      self.reviewStatus = pr.reviewStatus == "none" ? nil : pr.reviewStatus
      self.warnMessage = Self.warnMessage(workflowDisplayState: pr.workflowDisplayState, checksStatus: pr.checksStatus, baseBranch: pr.baseBranch)
      self.additions = pr.additions
      self.deletions = pr.deletions
      self.isTerminal = pr.state == "merged" || pr.state == "closed"
      self.detached = pr.detached
      self.mergedAt = pr.mergedAt
    }

    init(item: GitHubPrListItem, linkedPr: PullRequestListItem?) {
      let terminal = item.state == "merged" || item.state == "closed"
      let unmapped = !terminal
        && item.scope != "external"
        && item.linkedPrId == nil
        && item.linkedLaneId == nil
        && item.adeKind == nil
      self.id = item.linkedPrId ?? item.id
      self.prNumber = item.githubPrNumber
      self.title = item.title
      self.state = item.isDraft ? "draft" : item.state
      self.updatedAt = item.updatedAt
      self.headBranch = item.headBranch
      self.baseBranch = item.baseBranch
      self.authorLogin = item.author
      self.isBot = item.isBot
      self.repoOwner = item.repoOwner
      self.repoName = item.repoName
      self.isExternal = item.scope == "external"
      self.isUnmapped = unmapped
      let laneId = item.linkedLaneId ?? linkedPr?.laneId
      self.laneId = laneId?.isEmpty == false ? laneId : nil
      self.laneLabel = item.linkedLaneName ?? item.linkedLaneId ?? linkedPr?.laneName ?? (linkedPr?.laneId.isEmpty == false ? linkedPr?.laneId : nil)
      self.checksStatus = linkedPr?.checksStatus == "none" ? nil : linkedPr?.checksStatus
      self.checksReason = linkedPr?.checksReason
      self.reviewStatus = linkedPr?.reviewStatus == "none" ? nil : linkedPr?.reviewStatus
      self.warnMessage = unmapped
        ? nil
        : Self.warnMessage(workflowDisplayState: item.workflowDisplayState, checksStatus: linkedPr?.checksStatus, baseBranch: item.baseBranch)
      // The live linked row first; the list item's own values keep a detached
      // PR's stats after its lane is gone.
      self.additions = linkedPr?.additions ?? item.additions
      self.deletions = linkedPr?.deletions ?? item.deletions
      self.isTerminal = terminal
      self.detached = item.detached ?? linkedPr?.detached
      self.mergedAt = item.mergedAt ?? linkedPr?.mergedAt
      // The only actionable thing left on a merged PR: its remote branch still exists.
      self.needsBranchCleanup = terminal && item.cleanupState == "required"
    }

    private static func warnMessage(workflowDisplayState: String?, checksStatus: String?, baseBranch: String?) -> String? {
      if let state = workflowDisplayState {
        switch state {
        case "rebase-needed": return "Rebase against \(baseBranch ?? "base")"
        case "conflict", "merge-conflict": return "Merge conflict detected"
        case "queued": return "In queue"
        default: break
        }
      }
      if checksStatus == "failing" { return "CI failing" }
      // "not_run" is stated by the hollow ring; it is not a warning.
      return nil
    }
  }
}
