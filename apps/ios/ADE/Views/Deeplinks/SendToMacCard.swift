import SwiftUI
import UIKit

/// Categorises an ADE URL that iOS can't open natively so the
/// `SendToMacCard` can render a short, human description ("Lane shared with
/// you" / "Branch feat-x in acme/widget" / "ADE-123") without re-parsing the
/// URL inside the view body.
struct SendToMacTarget: Equatable, Identifiable {
  enum Kind: Equatable {
    case lane(id: String)
    case session(id: String)
    case file(path: String, line: Int?)
    case commit(sha: String)
    case artifact(id: String)
    case repoBranch(owner: String, repo: String, branch: String)
    case pr(owner: String, repo: String, number: Int)
    case linearIssue(identifier: String, branch: String?)
    case other
  }

  var url: URL
  var kind: Kind
  var envelope: ADEDeeplinkEnvelope?

  /// `Identifiable` conformance powers the `.sheet(item:)` binding in
  /// `ADEApp`; using the URL string keeps repeat shares of the same link
  /// from spawning duplicate sheets.
  var id: String { url.absoluteString }

  /// Best-effort parse of ADE's custom scheme and HTTPS mirror. Unknown
  /// shapes fall back to `.other` so the card can still render a generic
  /// "Open this on your Mac" message rather than refusing to display.
  init(url: URL) {
    self.url = url
    self.envelope = SendToMacTarget.parseEnvelope(url)
    if let kind = SendToMacTarget.parseHttpsOpenURL(url) {
      self.kind = kind
      return
    }
    let host = url.host?.lowercased()
    let parts = url.pathComponents
      .filter { $0 != "/" }
      .map { $0.removingPercentEncoding ?? $0 }
    switch host {
    case "lane":
      if let id = parts.first, !id.isEmpty {
        self.kind = .lane(id: id)
      } else {
        self.kind = .other
      }
    case "session":
      if let id = parts.first, ADEDeepLinkURLParsing.isValidOpaqueId(id) {
        self.kind = .session(id: id)
      } else {
        self.kind = .other
      }
    case "file":
      let path = parts.joined(separator: "/")
      if ADEDeepLinkURLParsing.isValidRepoRelativePath(path) {
        let line = URLComponents(url: url, resolvingAgainstBaseURL: false)
          .map(ADEDeepLinkURLParsing.adeQueryValues(from:))
          .flatMap { ADEDeepLinkURLParsing.positiveInteger($0["line"]) }
        self.kind = .file(path: path, line: line)
      } else {
        self.kind = .other
      }
    case "commit":
      if let sha = parts.first, ADEDeepLinkURLParsing.isValidCommitSha(sha) {
        self.kind = .commit(sha: sha)
      } else {
        self.kind = .other
      }
    case "artifact":
      if let id = parts.first, ADEDeepLinkURLParsing.isValidOpaqueId(id) {
        self.kind = .artifact(id: id)
      } else {
        self.kind = .other
      }
    case "repo":
      if parts.count >= 4,
         parts[2].lowercased() == "branch",
         !parts[0].isEmpty,
         !parts[1].isEmpty {
        let branch = parts.dropFirst(3).joined(separator: "/")
        if branch.isEmpty {
          self.kind = .other
        } else {
          self.kind = .repoBranch(owner: parts[0], repo: parts[1], branch: branch)
        }
      } else {
        self.kind = .other
      }
    case "pr":
      if parts.count >= 3,
         !parts[0].isEmpty,
         !parts[1].isEmpty,
         let number = Int(parts[2]),
         number > 0 {
        self.kind = .pr(owner: parts[0], repo: parts[1], number: number)
      } else {
        self.kind = .other
      }
    case "linear-issue":
      // `ade://linear-issue/<ADE-123>[?branch=<branch>]` — Linear hand-off.
      // The branch hint is optional; the desktop resolves the actual lane
      // via its `lane.linearIssue` mapping.
      if let identifier = parts.first, !identifier.isEmpty {
        let branchHint = URLComponents(url: url, resolvingAgainstBaseURL: false)?
          .queryItems?
          .first(where: { $0.name == "branch" })?
          .value?
          .trimmingCharacters(in: .whitespacesAndNewlines)
        let normalisedBranch = (branchHint?.isEmpty == false) ? branchHint : nil
        self.kind = .linearIssue(identifier: identifier, branch: normalisedBranch)
      } else {
        self.kind = .other
      }
    default:
      self.kind = .other
    }
  }

  private static func parseHttpsOpenURL(_ url: URL) -> Kind? {
    guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
          components.scheme?.lowercased() == "https",
          ADEDeepLinkURLParsing.isADEWebHost(components.host),
          components.path == "/open" else {
      return nil
    }
    let query = ADEDeepLinkURLParsing.adeQueryValues(from: components)
    switch query["type"]?.lowercased() {
    case "lane":
      guard let id = query["id"], !id.isEmpty else { return .other }
      return .lane(id: id)
    case "session":
      guard let id = query["id"], ADEDeepLinkURLParsing.isValidOpaqueId(id) else { return .other }
      return .session(id: id)
    case "file":
      guard let path = query["path"], ADEDeepLinkURLParsing.isValidRepoRelativePath(path) else { return .other }
      return .file(path: path, line: ADEDeepLinkURLParsing.positiveInteger(query["line"]))
    case "commit":
      guard let sha = query["sha"], ADEDeepLinkURLParsing.isValidCommitSha(sha) else { return .other }
      return .commit(sha: sha)
    case "artifact":
      guard let id = query["id"], ADEDeepLinkURLParsing.isValidOpaqueId(id) else { return .other }
      return .artifact(id: id)
    case "branch":
      guard let repo = ADEDeepLinkURLParsing.splitRepo(query["repo"]),
            let branch = query["branch"],
            !branch.isEmpty else {
        return .other
      }
      return .repoBranch(owner: repo.owner, repo: repo.repo, branch: branch)
    case "pr":
      guard let repo = ADEDeepLinkURLParsing.splitRepo(query["repo"]),
            let number = ADEDeepLinkURLParsing.positiveInteger(query["number"]) else {
        return .other
      }
      return .pr(owner: repo.owner, repo: repo.repo, number: number)
    case "linear-issue":
      guard let identifier = query["issue"], !identifier.isEmpty else { return .other }
      let branch = query["branch"]?.trimmingCharacters(in: .whitespacesAndNewlines)
      return .linearIssue(identifier: identifier, branch: branch?.isEmpty == false ? branch : nil)
    default:
      return .other
    }
  }

  private static func parseEnvelope(_ url: URL) -> ADEDeeplinkEnvelope? {
    guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
    return ADEDeepLinkURLParsing.envelope(from: ADEDeepLinkURLParsing.adeQueryValues(from: components))
  }

  var headline: String {
    switch kind {
    case .lane: return "Lane shared with you"
    case .session: return "Chat shared with you"
    case .file: return "File shared with you"
    case .commit: return "Commit shared with you"
    case .artifact: return "Artifact shared with you"
    case .repoBranch(_, _, _): return "Branch shared with you"
    case .pr: return "Pull request shared with you"
    case .linearIssue: return "Linear issue shared with you"
    case .other: return "Shared from your Mac"
    }
  }

  var detail: String {
    switch kind {
    case .lane(let id):
      if let repo = envelope?.repoSlug {
        return "This lane lives in \(repo) on another machine."
      }
      return "Lane \(shortenedLaneId(id))"
    case .session(let id):
      if let repo = envelope?.repoSlug {
        return "This chat lives in \(repo) on another machine."
      }
      return "Session \(id)"
    case .file(let path, let line):
      return line.map { "\(path):\($0)" } ?? path
    case .commit(let sha):
      if let repo = envelope?.repoSlug {
        return "Commit \(sha.prefix(12)) in \(repo)"
      }
      return "Commit \(sha.prefix(12))"
    case .artifact(let id):
      if let repo = envelope?.repoSlug {
        return "Artifact \(shortenedOpaqueId(id)) in \(repo)"
      }
      return "Artifact \(shortenedOpaqueId(id))"
    case .repoBranch(let owner, let repo, let branch):
      return "Branch \(branch) in \(owner)/\(repo)"
    case .pr(let owner, let repo, let number):
      return "#\(number) in \(owner)/\(repo)"
    case .linearIssue(let identifier, let branch):
      if let branch, !branch.isEmpty {
        return "\(identifier) on \(branch)"
      }
      return identifier
    case .other:
      return url.absoluteString
    }
  }

  private func shortenedLaneId(_ id: String) -> String {
    // Lane ids are UUIDs (36 chars); show only the leading segment so the
    // detail line stays readable on small screens.
    guard id.count > 8, let dash = id.firstIndex(of: "-") else { return id }
    return String(id[..<dash])
  }

  private func shortenedOpaqueId(_ id: String) -> String {
    guard id.count > 12 else { return id }
    return "\(id.prefix(12))..."
  }

  var usesMonospacedDetail: Bool {
    switch kind {
    case .lane, .session, .commit, .artifact:
      return envelope?.repoSlug == nil
    case .file, .repoBranch, .pr, .linearIssue, .other:
      return true
    }
  }

  var envelopePullRequestURL: URL? {
    guard let owner = envelope?.repoOwner,
          let repo = envelope?.repoName,
          let prNumber = envelope?.prNumber,
          prNumber > 0 else {
      return nil
    }
    return URL(string: "https://github.com/\(owner)/\(repo)/pull/\(prNumber)")
  }

  var envelopeLinearURL: URL? {
    guard let linearIssue = envelope?.linearIssue else { return nil }
    return URL(string: "https://linear.app/issue/\(linearIssue)")
  }
}

/// Sheet shown when iOS receives a cross-machine deep link (lane / repo /
/// owner-scoped PR / linear-issue) it can't render directly. Offers two
/// outcomes: bounce the URL to the paired desktop via a remote command, or
/// dismiss.
struct SendToMacCard: View {
  let target: SendToMacTarget
  let onDismiss: () -> Void

  @EnvironmentObject private var syncService: SyncService
  @State private var isSending = false
  @State private var sendCompleted = false
  @State private var sendOutcome: SyncRemoteCommandDelivery?

  var body: some View {
    VStack(spacing: 20) {
      header
      targetCard
      machineRow
      actions
    }
    .padding(.horizontal, 20)
    .padding(.top, 22)
    .padding(.bottom, 24)
    .background(ADEColor.surfaceBackground)
    .presentationDetents([.medium])
    .presentationDragIndicator(.visible)
  }

  private var header: some View {
    VStack(spacing: 6) {
      Image(systemName: "laptopcomputer.and.arrow.down")
        .font(.system(size: 30, weight: .semibold))
        .foregroundStyle(ADEColor.accent)
        .padding(.bottom, 4)

      Text("Open on your Mac")
        .font(.system(.title3, design: .rounded).weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
        .multilineTextAlignment(.center)

      Text("This link works best on the desktop app. Send it to your paired Mac and it'll open there.")
        .font(.system(.footnote, design: .rounded))
        .foregroundStyle(ADEColor.textSecondary)
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private var targetCard: some View {
    HStack(alignment: .top, spacing: 12) {
      Image(systemName: targetSymbol)
        .font(.system(size: 18, weight: .semibold))
        .foregroundStyle(ADEColor.accent)
        .frame(width: 34, height: 34)
        .background(ADEColor.accent.opacity(0.15), in: RoundedRectangle(cornerRadius: 8, style: .continuous))

      VStack(alignment: .leading, spacing: 4) {
        Text(target.headline)
          .font(.system(.subheadline, design: .rounded).weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Text(target.detail)
          .font(.system(.footnote, design: target.usesMonospacedDetail ? .monospaced : .rounded))
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(2)
          .truncationMode(.middle)
      }
      Spacer(minLength: 0)
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(ADEColor.cardBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .stroke(ADEColor.border, lineWidth: 1)
    )
  }

  private var targetSymbol: String {
    switch target.kind {
    case .lane: return "square.stack.3d.up"
    case .session: return "bubble.left.and.bubble.right"
    case .file: return "doc.text"
    case .commit: return "point.topleft.down.curvedto.point.bottomright.up"
    case .artifact: return "shippingbox"
    case .repoBranch: return "arrow.triangle.branch"
    case .pr: return "arrow.triangle.merge"
    case .linearIssue: return "smallcircle.filled.circle"
    case .other: return "link"
    }
  }

  private var machineRow: some View {
    HStack(spacing: 10) {
      Circle()
        .fill(machineTint)
        .frame(width: 8, height: 8)
      Image(systemName: "desktopcomputer")
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(ADEColor.textSecondary)
      VStack(alignment: .leading, spacing: 1) {
        Text(machineLabel)
          .font(.system(.footnote, design: .rounded).weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
        if let secondary = machineSecondaryLabel {
          Text(secondary)
            .font(.system(.caption2, design: .rounded))
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
        }
      }
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
    .background(ADEColor.recessedBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
  }

  /// Display name for the paired Mac. Prefers the live `hostName` published
  /// by `SyncService`, falls back to a placeholder when no machine is
  /// attached so the card still reads correctly. The user can still try to
  /// send; the queueing path inside `SyncService` will surface the offline
  /// case in its own way.
  private var machineLabel: String {
    let trimmed = syncService.hostName?.trimmingCharacters(in: .whitespacesAndNewlines)
    if let trimmed, !trimmed.isEmpty {
      return trimmed
    }
    // TODO: thread the paired-device record through here once SyncService
    // exposes a richer "last paired" identity; today `hostName` is the only
    // stable display string we have.
    return "Your Mac"
  }

  private var machineSecondaryLabel: String? {
    switch syncService.connectionState {
    case .connected:
      return "Connected"
    case .connecting:
      return "Connecting…"
    case .error:
      return "Last seen offline"
    case .disconnected:
      return "Offline"
    }
  }

  private var machineTint: Color {
    switch syncService.connectionState {
    case .connected: return ADEColor.success
    case .connecting: return ADEColor.warning
    case .error: return ADEColor.danger
    case .disconnected: return ADEColor.textMuted
    }
  }

  private var actions: some View {
    VStack(spacing: 10) {
      Button {
        Task { await sendToMac() }
      } label: {
        HStack(spacing: 8) {
          if isSending {
            ProgressView()
              .progressViewStyle(.circular)
              .controlSize(.small)
              .tint(.white)
          } else if sendCompleted {
            Image(systemName: "checkmark")
              .font(.system(size: 14, weight: .semibold))
          } else {
            Image(systemName: "paperplane.fill")
              .font(.system(size: 14, weight: .semibold))
          }
          Text(sendButtonTitle)
            .font(.system(.body, design: .rounded).weight(.semibold))
            .lineLimit(2)
            .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 13)
        .foregroundStyle(.white)
        .background(ADEColor.accent, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
      }
      .buttonStyle(.plain)
      .disabled(isSending || sendCompleted)

      externalActions

      if let sendStatusMessage {
        Text(sendStatusMessage)
          .font(.system(.footnote, design: .rounded))
          .foregroundStyle(sendStatusTint)
          .multilineTextAlignment(.center)
          .fixedSize(horizontal: false, vertical: true)
      }

      Button(action: onDismiss) {
        Text(sendCompleted ? "Done" : "Cancel")
          .font(.system(.body, design: .rounded).weight(.medium))
          .frame(maxWidth: .infinity)
          .padding(.vertical, 12)
          .foregroundStyle(ADEColor.textPrimary)
          .background(ADEColor.cardBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
          .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
              .stroke(ADEColor.border, lineWidth: 1)
          )
      }
      .buttonStyle(.plain)
    }
  }

  @ViewBuilder
  private var externalActions: some View {
    if let url = target.envelopePullRequestURL,
       let prNumber = target.envelope?.prNumber {
      externalActionButton(
        title: "Open PR #\(prNumber) on GitHub",
        symbol: "arrow.up.right.square",
        url: url
      )
    }
    if let url = target.envelopeLinearURL {
      externalActionButton(
        title: "Open in Linear",
        symbol: "smallcircle.filled.circle",
        url: url
      )
    }
  }

  private func externalActionButton(title: String, symbol: String, url: URL) -> some View {
    Button {
      openExternal(url)
    } label: {
      HStack(spacing: 8) {
        Image(systemName: symbol)
          .font(.system(size: 14, weight: .semibold))
        Text(title)
          .font(.system(.body, design: .rounded).weight(.medium))
          .lineLimit(1)
      }
      .frame(maxWidth: .infinity)
      .padding(.vertical, 12)
      .foregroundStyle(ADEColor.textPrimary)
      .background(ADEColor.cardBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .stroke(ADEColor.border, lineWidth: 1)
      )
    }
    .buttonStyle(.plain)
  }

  private var sendButtonTitle: String {
    if isSending { return "Sending…" }
    if sendCompleted {
      if case .queued = sendOutcome { return "Queued" }
      return "Sent"
    }
    if case .dropped = sendOutcome { return "Try again" }
    if let repo = target.envelope?.repoSlug,
       let branch = target.envelope?.branch,
       !repo.isEmpty,
       !branch.isEmpty {
      return "Send to Mac to create a lane from \(branch)"
    }
    return "Send to Mac"
  }

  private var sendStatusMessage: String? {
    guard let sendOutcome else { return nil }
    switch sendOutcome {
    case .dispatched:
      return "Sent to your Mac."
    case .queued:
      return "Queued for when your Mac reconnects."
    case .dropped(let message):
      return message.isEmpty ? "This command could not be sent." : message
    }
  }

  private var sendStatusTint: Color {
    guard let sendOutcome else { return ADEColor.textSecondary }
    switch sendOutcome {
    case .dispatched, .queued: return ADEColor.success
    case .dropped: return ADEColor.danger
    }
  }

  @MainActor
  private func sendToMac() async {
    isSending = true
    sendOutcome = nil
    let delivery = await syncService.sendRemoteCommand(.openDeeplink, payload: ["url": target.url.absoluteString])
    isSending = false
    sendOutcome = delivery
    switch delivery {
    case .dispatched, .queued:
      sendCompleted = true
      // Brief confirmation pause so the user sees the outcome before the
      // sheet collapses; 0.8s is short enough not to feel sluggish.
      try? await Task.sleep(nanoseconds: 800_000_000)
      onDismiss()
    case .dropped:
      sendCompleted = false
    }
  }

  private func openExternal(_ url: URL) {
    UIApplication.shared.open(url)
  }
}
