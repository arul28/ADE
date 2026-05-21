import SwiftUI

/// Categorises an ADE URL that iOS can't open natively so the
/// `SendToMacCard` can render a short, human description ("Lane shared with
/// you" / "Branch feat-x in acme/widget" / "ADE-123") without re-parsing the
/// URL inside the view body.
struct SendToMacTarget: Equatable, Identifiable {
  enum Kind: Equatable {
    case lane(id: String)
    case repoBranch(owner: String, repo: String, branch: String)
    case pr(owner: String, repo: String, number: Int)
    case linearIssue(identifier: String, branch: String?)
    case other
  }

  var url: URL
  var kind: Kind

  /// `Identifiable` conformance powers the `.sheet(item:)` binding in
  /// `ADEApp`; using the URL string keeps repeat shares of the same link
  /// from spawning duplicate sheets.
  var id: String { url.absoluteString }

  /// Best-effort parse of ADE's custom scheme and HTTPS mirror. Unknown
  /// shapes fall back to `.other` so the card can still render a generic
  /// "Open this on your Mac" message rather than refusing to display.
  init(url: URL) {
    self.url = url
    if let kind = SendToMacTarget.parseHttpsOpenURL(url) {
      self.kind = kind
      return
    }
    let host = url.host?.lowercased()
    let parts = url.pathComponents.filter { $0 != "/" }
    switch host {
    case "lane":
      if let id = parts.first, !id.isEmpty {
        self.kind = .lane(id: id)
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
          components.host?.lowercased() == "ade.app",
          components.path == "/open" else {
      return nil
    }
    let query = ADEDeepLinkURLParsing.adeQueryValues(from: components)
    switch query["type"]?.lowercased() {
    case "lane":
      guard let id = query["id"], !id.isEmpty else { return .other }
      return .lane(id: id)
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

  var headline: String {
    switch kind {
    case .lane: return "Lane shared with you"
    case .repoBranch(_, _, _): return "Branch shared with you"
    case .pr: return "Pull request shared with you"
    case .linearIssue: return "Linear issue shared with you"
    case .other: return "Shared from your Mac"
    }
  }

  var detail: String {
    switch kind {
    case .lane(let id):
      return "Lane \(shortenedLaneId(id))"
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
          .font(.system(.footnote, design: .monospaced))
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
    case .connected, .syncing:
      return "Connected"
    case .connecting:
      return "Connecting…"
    case .error:
      return "Last seen offline"
    case .disconnected:
      return "Offline — we'll deliver when it's back"
    }
  }

  private var machineTint: Color {
    switch syncService.connectionState {
    case .connected, .syncing: return ADEColor.success
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
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 13)
        .foregroundStyle(.white)
        .background(ADEColor.accent, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
      }
      .buttonStyle(.plain)
      .disabled(isSending || sendCompleted)

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

  private var sendButtonTitle: String {
    if isSending { return "Sending…" }
    if sendCompleted { return "Sent" }
    return "Send to Mac"
  }

  @MainActor
  private func sendToMac() async {
    guard let sync = SyncService.shared else {
      // Without a SyncService singleton there's nothing to dispatch to;
      // collapse to the dismiss path so the user isn't stuck.
      onDismiss()
      return
    }
    isSending = true
    await sync.sendRemoteCommand(.openDeeplink, payload: ["url": target.url.absoluteString])
    isSending = false
    sendCompleted = true
    // Brief confirmation pause so the user sees the "Sent" state before the
    // sheet collapses; 0.6s is short enough not to feel sluggish.
    try? await Task.sleep(nanoseconds: 600_000_000)
    onDismiss()
  }
}
