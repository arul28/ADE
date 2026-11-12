import SwiftUI

// The account's projects on the Hub. The account list says which projects
// exist; the machines say where each one has a folder and what runs there.
// A Hub card that a machine already shows (the focused machine's catalog, or
// another machine's roster) is matched to its account project; a project no
// card shows becomes a card of its own, so an account with no computer, or
// with every computer offline, still lists its projects.

// MARK: - Join

/// One machine folder behind a Hub card: the account machine key and that
/// machine's registry id of the folder.
struct HubAccountCopyRef: Hashable {
  let accountMachineKey: String
  let checkoutId: String
}

/// A Hub card as the join sees it.
struct HubAccountJoinCard: Equatable {
  let cardId: String
  /// `owner/name`, lowercased, only for a github.com origin.
  let gitHubIdentity: String?
  let copies: [HubAccountCopyRef]
}

struct HubAccountJoin: Equatable {
  /// Card id -> the account project it shows.
  var accountIdByCardId: [String: String] = [:]
  /// Projects on the account that no card shows, in the list's order.
  var unmatchedProjects: [AccountProject] = []
  /// Cards of repositories that were removed from the account.
  var hiddenCardIds: Set<String> = []
  /// GitHub repositories a machine shows that the list does not name yet.
  var unknownIdentities: Set<String> = []
}

/// Pure: match Hub cards to account projects. For each card, in order:
/// 1. one of its folders is a copy on the account (machine key + registry id);
/// 2. its GitHub `owner/name` is the project's address or an old address.
/// The first card that claims a project keeps it; a later card stays a card
/// of its own. A card that matches no live project but names a removed one
/// is hidden. Only github.com addresses match by name, because a machine's
/// catalog drops the host.
func hubJoinAccountProjects(
  cards: [HubAccountJoinCard],
  live: [AccountProject],
  removed: [AccountProject]
) -> HubAccountJoin {
  var join = HubAccountJoin()
  var projectByCopy: [HubAccountCopyRef: String] = [:]
  var projectByIdentity: [String: String] = [:]
  for project in live {
    for copy in project.copies {
      let ref = HubAccountCopyRef(accountMachineKey: copy.machineKey, checkoutId: copy.checkoutId)
      if projectByCopy[ref] == nil { projectByCopy[ref] = project.id }
    }
    for identity in accountProjectGitHubIdentities(project) where projectByIdentity[identity] == nil {
      projectByIdentity[identity] = project.id
    }
  }
  var removedIdentities = Set<String>()
  for project in removed {
    for identity in accountProjectGitHubIdentities(project) where projectByIdentity[identity] == nil {
      removedIdentities.insert(identity)
    }
  }

  var claimed = Set<String>()
  for card in cards {
    let byCopy = card.copies.lazy.compactMap { projectByCopy[$0] }.first
    let byName = card.gitHubIdentity.flatMap { projectByIdentity[$0] }
    if let projectId = byCopy ?? byName {
      if claimed.insert(projectId).inserted {
        join.accountIdByCardId[card.cardId] = projectId
      }
      continue
    }
    if let identity = card.gitHubIdentity {
      if removedIdentities.contains(identity) {
        join.hiddenCardIds.insert(card.cardId)
      } else {
        join.unknownIdentities.insert(identity)
      }
    }
  }
  join.unmatchedProjects = live.filter { !claimed.contains($0.id) }
  return join
}

/// Every github.com `owner/name` (lowercased) a project answers to: its
/// current owner and name, then each address in `aliases`.
func accountProjectGitHubIdentities(_ project: AccountProject) -> [String] {
  var identities: [String] = []
  if project.host.lowercased() == "github.com",
     let current = workRepoIdentity(owner: project.owner, name: project.name) {
    identities.append(current)
  }
  for alias in project.aliases {
    guard let parsed = accountRepoKeyParts(alias), parsed.host == "github.com" else { continue }
    let identity = "\(parsed.owner)/\(parsed.name)".lowercased()
    if !identities.contains(identity) { identities.append(identity) }
  }
  return identities
}

/// `repo:<host>/<owner>/<name>` into its parts, host lowercased.
func accountRepoKeyParts(_ key: String) -> (host: String, owner: String, name: String)? {
  guard key.hasPrefix("repo:") else { return nil }
  let parts = key.dropFirst("repo:".count).split(separator: "/", omittingEmptySubsequences: true).map(String.init)
  guard parts.count == 3 else { return nil }
  return (parts[0].lowercased(), parts[1], parts[2])
}

/// `owner/name`, lowercased, for an origin on github.com only. A roster's
/// origin can be any host, and only github.com addresses may match by name.
func hubGitHubRepoIdentity(originUrl: String?) -> String? {
  guard let raw = originUrl?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return nil }
  let host: String?
  if raw.contains("://") {
    host = URL(string: raw)?.host?.lowercased()
  } else if let colon = raw.firstIndex(of: ":") {
    let beforeColon = raw[..<colon]
    host = beforeColon.split(separator: "@").last.map { String($0).lowercased() }
  } else {
    host = nil
  }
  guard host == "github.com" || host == "www.github.com" || host == "ssh.github.com" else { return nil }
  return workRepoIdentity(originUrl: raw)
}

// MARK: - Account-only cards

/// The Hub card of a project that no reachable machine shows: the account's
/// name, and the icon a machine showed last.
func hubAccountProjectSummary(_ project: AccountProject, display: AccountProjectDisplay?) -> MobileProjectSummary {
  MobileProjectSummary(
    id: project.id,
    displayName: project.name,
    repoOwner: project.owner,
    repoName: project.name,
    defaultBaseRef: project.defaultBranch,
    iconDataUrl: display?.iconDataUrl,
    laneCount: 0,
    isAvailable: false,
    isCached: false
  )
}

/// The account machines that hold a folder of the project, one per machine,
/// the main folder first.
func accountProjectCopyMachines(_ project: AccountProject, machines: [AccountMachine]) -> [(copy: AccountProjectCopy, machine: AccountMachine?)] {
  var seen = Set<String>()
  let ordered = project.copies.sorted { lhs, rhs in
    if lhs.isMain != rhs.isMain { return lhs.isMain }
    return lhs.lastSeenAt > rhs.lastSeenAt
  }
  return ordered.compactMap { copy in
    guard seen.insert(copy.machineKey).inserted else { return nil }
    return (copy, machines.first { $0.machineKey == copy.machineKey })
  }
}

/// The line under an account-only card's name: where it is, or why nothing
/// shows it.
func hubAccountProjectNote(_ project: AccountProject, machines: [AccountMachine]) -> String {
  let held = accountProjectCopyMachines(project, machines: machines)
  guard !held.isEmpty else { return "Not on a computer yet" }
  let online = held.filter { $0.machine?.online == true }
  if let first = online.first {
    let name = first.machine?.displayName ?? "a computer"
    return online.count > 1 ? "On \(name) and \(online.count - 1) more" : "On \(name)"
  }
  // The computer list did not load (offline): say how many hold a copy, not
  // that none is online.
  if held.allSatisfy({ $0.machine == nil }) {
    return held.count == 1 ? "On 1 computer" : "On \(held.count) computers"
  }
  return "No computer online"
}

// MARK: - What the Hub says above the projects

/// At most one line of status above the project grid.
enum HubAccountNotice: Equatable {
  /// The account list could not be read; the saved list shows.
  case savedProjects
  /// A paired computer is connecting; the projects show meanwhile.
  case connecting(machineName: String?)
  /// The phone has a computer, but none is reachable. `byUser`: the user
  /// disconnected it. `failed`: the last attempt to reach it failed.
  case noComputerOnline(machineName: String?, lastSeen: String?, failed: Bool, byUser: Bool)
  /// Signed in with projects, but this phone has no computer.
  case noComputer(accountHasComputers: Bool)
}

/// What the grid says when it has no card.
enum HubAccountEmptyKind: Equatable {
  /// The first read of the account list is running.
  case loading
  /// The first read failed and nothing is saved.
  case cantLoad
  /// A computer is connecting and has shown nothing yet.
  case connecting
  /// The account has no projects.
  case noProjects(hasComputer: Bool, canAddProject: Bool)
  /// The machine-only Hub (signed out, or an older server): a connected
  /// machine with no projects.
  case machineEmpty
}

struct HubAccountStatusInputs: Equatable {
  /// The account list decides which projects exist.
  var governedByAccount: Bool
  var listPhase: AccountProjectStore.Phase
  var listHasSavedCopy: Bool
  var focusedState: RemoteConnectionState
  var focusedDisconnectedByUser: Bool
  var focusedMachineName: String?
  var focusedLastSeen: String?
  var anyFleetMachineLive: Bool
  var anyFleetMachineConnecting: Bool
  /// The phone holds a pairing it can reconnect with (primary or fleet).
  var hasPairedComputer: Bool
  var accountHasComputers: Bool
  var hasCards: Bool
  var canAddProject: Bool
}

/// Pure: the one notice above the grid, if any. A failed list read comes
/// first (it explains why the list may be old), then the computers.
func hubAccountNotice(_ inputs: HubAccountStatusInputs) -> HubAccountNotice? {
  guard inputs.hasCards else { return nil }
  if inputs.governedByAccount, inputs.listPhase == .offline, inputs.listHasSavedCopy {
    return .savedProjects
  }
  if inputs.focusedState == .connected || inputs.anyFleetMachineLive { return nil }
  if inputs.focusedState == .connecting || inputs.anyFleetMachineConnecting {
    return .connecting(machineName: inputs.focusedMachineName)
  }
  // A failed connect names its computer even before the phone saved a
  // pairing (an Open from a project's sheet), so the line matches the header.
  let failedAttempt = inputs.focusedState == .error && inputs.focusedMachineName != nil
  if inputs.hasPairedComputer || failedAttempt {
    return .noComputerOnline(
      machineName: inputs.focusedMachineName,
      lastSeen: inputs.focusedLastSeen,
      failed: inputs.focusedState == .error,
      byUser: inputs.focusedDisconnectedByUser
    )
  }
  if inputs.governedByAccount {
    return .noComputer(accountHasComputers: inputs.accountHasComputers)
  }
  return nil
}

/// Pure: what an empty grid says.
func hubAccountEmptyKind(_ inputs: HubAccountStatusInputs) -> HubAccountEmptyKind {
  let computerConnecting = inputs.focusedState == .connecting || inputs.anyFleetMachineConnecting
  guard inputs.governedByAccount else {
    return inputs.focusedState == .connected ? .machineEmpty : .connecting
  }
  if !inputs.listHasSavedCopy {
    switch inputs.listPhase {
    case .loading: return computerConnecting ? .connecting : .loading
    case .offline: return .cantLoad
    default: break
    }
  }
  if computerConnecting { return .connecting }
  return .noProjects(
    hasComputer: inputs.hasPairedComputer || inputs.accountHasComputers,
    canAddProject: inputs.canAddProject
  )
}

/// "2 hours ago" for an epoch-ms time; nil when unknown.
func hubAccountRelativeTime(epochMs: Double?, now: Date = Date()) -> String? {
  guard let epochMs, epochMs > 0 else { return nil }
  let formatter = RelativeDateTimeFormatter()
  formatter.unitsStyle = .full
  return formatter.localizedString(for: Date(timeIntervalSince1970: epochMs / 1000), relativeTo: now)
}

// MARK: - Views

/// The status line above the grid: a calm card with a status dot, a title,
/// one sentence and its actions. One at a time.
struct HubAccountStatusCard: View {
  let notice: HubAccountNotice
  var onRetryList: () -> Void = {}
  var onReconnect: () -> Void = {}
  var onConnectComputer: () -> Void = {}
  var onOpenSettings: () -> Void = {}

  var body: some View {
    switch notice {
    case .connecting(let name):
      HStack(spacing: 10) {
        ProgressView().controlSize(.small)
        Text(name.map { "Connecting to \($0)…" } ?? "Connecting to your computer…")
          .font(.system(size: 13.5))
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
        Spacer(minLength: 0)
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 11)
      .adeKitCard(padding: nil)
      .accessibilityElement(children: .combine)
    default:
      VStack(alignment: .leading, spacing: 10) {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          ADEKitDot(tone: tone, size: 7)
            .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 }
          VStack(alignment: .leading, spacing: 3) {
            Text(title)
              .font(.system(size: 14.5, weight: .semibold))
              .foregroundStyle(ADEColor.textPrimary)
            Text(message)
              .font(.system(size: 13))
              .foregroundStyle(ADEColor.textSecondary)
              .fixedSize(horizontal: false, vertical: true)
          }
          Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
        actions
          .padding(.leading, 15)
      }
      .padding(14)
      .adeKitCard(padding: nil)
    }
  }

  private var tone: ADEKitTone {
    switch notice {
    case .savedProjects: return .warn
    case .noComputerOnline(_, _, let failed, _): return failed ? .crit : .neutral
    case .noComputer, .connecting: return .neutral
    }
  }

  private var title: String {
    switch notice {
    case .savedProjects: return "Showing saved projects"
    case .connecting: return ""
    case .noComputerOnline(let name, _, let failed, let byUser):
      if failed { return name.map { "Can’t reach \($0)" } ?? "Can’t reach your computer" }
      if byUser { return name.map { "Disconnected from \($0)" } ?? "Disconnected" }
      return name.map { "\($0) is offline" } ?? "No computer online"
    case .noComputer: return "No computer connected"
    }
  }

  private var message: String {
    switch notice {
    case .savedProjects:
      return "ADE could not reach your account. The list may be out of date."
    case .connecting:
      return ""
    case .noComputerOnline(_, let lastSeen, let failed, let byUser):
      if failed { return "Check that ADE is running on it and that both are online." }
      if byUser { return "Reconnect to run agents. Your projects stay here." }
      if let lastSeen { return "Last seen \(lastSeen). Start ADE on it to run agents." }
      return "Start ADE on it to run agents. Your projects stay here."
    case .noComputer(let accountHasComputers):
      return accountHasComputers
        ? "Connect one of your computers to run agents on these projects."
        : "Your projects are on your account. Connect a computer to run agents on them."
    }
  }

  @ViewBuilder
  private var actions: some View {
    HStack(spacing: 8) {
      switch notice {
      case .savedProjects:
        Button("Try again", action: onRetryList)
          .buttonStyle(ADEKitButtonStyle())
      case .noComputerOnline:
        Button("Reconnect", action: onReconnect)
          .buttonStyle(ADEKitButtonStyle())
        Button("Connection settings", action: onOpenSettings)
          .buttonStyle(ADEKitButtonStyle())
      case .noComputer:
        Button("Connect a computer", action: onConnectComputer)
          .buttonStyle(ADEKitButtonStyle())
      case .connecting:
        EmptyView()
      }
    }
  }
}

/// The grid with no card: why, and the one thing to do.
struct HubAccountEmptyCard: View {
  let kind: HubAccountEmptyKind
  var onRetryList: () -> Void = {}
  var onConnectComputer: () -> Void = {}
  var onAddProject: () -> Void = {}

  var body: some View {
    switch kind {
    case .loading:
      HStack(spacing: 10) {
        ProgressView().controlSize(.small)
        Text("Loading your projects…")
          .font(.system(size: 14))
          .foregroundStyle(ADEColor.textSecondary)
      }
      .frame(maxWidth: .infinity)
      .padding(.vertical, 28)
    case .connecting:
      HubConnectingCard()
    case .machineEmpty:
      HubEmptyProjectsCard()
    case .cantLoad:
      emptyLayout(
        symbol: "wifi.exclamationmark",
        title: "Can’t load your projects",
        message: "Connect to the internet, then try again."
      ) {
        Button("Try again", action: onRetryList)
          .buttonStyle(ADEKitButtonStyle(prominent: true))
      }
    case .noProjects(let hasComputer, let canAddProject):
      emptyLayout(
        symbol: "folder.badge.plus",
        title: "No projects yet",
        message: hasComputer
          ? "Add a project on one of your computers. It shows here, on every device."
          : "Your projects show here. Connect a computer to add your first one."
      ) {
        if canAddProject {
          Button("Add project", action: onAddProject)
            .buttonStyle(ADEKitButtonStyle(prominent: true))
        } else if !hasComputer {
          Button("Connect a computer", action: onConnectComputer)
            .buttonStyle(ADEKitButtonStyle(prominent: true))
        }
      }
    }
  }

  private func emptyLayout<Actions: View>(
    symbol: String,
    title: String,
    message: String,
    @ViewBuilder actions: () -> Actions
  ) -> some View {
    VStack(spacing: 6) {
      Image(systemName: symbol)
        .font(.system(size: 22, weight: .regular))
        .foregroundStyle(ADEColor.textMuted)
      Text(title)
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(ADEColor.textPrimary)
      Text(message)
        .font(.system(size: 12.5))
        .foregroundStyle(ADEColor.textSecondary)
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: 320)
      actions()
        .padding(.top, 10)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 28)
    .padding(.horizontal, 16)
  }
}

// MARK: - Project home

/// The page of a project that no reachable machine shows: the computers
/// that hold a folder of it, and Open on the ones that are online. Open goes
/// through the owned-link route, which connects that computer, waits for its
/// catalog and opens the folder there.
struct AccountProjectHomeScreen: View {
  let projectId: String
  var onConnectComputer: () -> Void = {}

  @ObservedObject private var store = AccountProjectStore.shared
  @ObservedObject private var account = AccountService.shared
  @Environment(\.dismiss) private var dismiss

  private var project: AccountProject? {
    store.liveProjects.first { $0.id == projectId }
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        if let project {
          content(project)
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 24)
        } else {
          Text("This project was removed from your account.")
            .font(.system(size: 14))
            .foregroundStyle(ADEColor.textSecondary)
            .frame(maxWidth: .infinity)
            .padding(.top, 48)
        }
      }
      .background(ADEColor.pageBackground.ignoresSafeArea())
      .navigationTitle("")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }
        }
      }
    }
  }

  @ViewBuilder
  private func content(_ project: AccountProject) -> some View {
    let display = store.display[project.id]
    let held = accountProjectCopyMachines(project, machines: account.machines)
    VStack(alignment: .leading, spacing: 18) {
      HStack(alignment: .center, spacing: 12) {
        HubProjectIcon(iconDataUrl: display?.iconDataUrl, isActive: false, size: 44)
        VStack(alignment: .leading, spacing: 2) {
          Text(project.name)
            .font(.system(size: 20, weight: .bold))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(2)
          Text(project.host == "github.com" ? "\(project.owner)/\(project.name)" : "\(project.host)/\(project.owner)/\(project.name)")
            .font(.system(size: 13))
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(1)
        }
      }

      VStack(alignment: .leading, spacing: 8) {
        Text("Computers")
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(ADEColor.textSecondary)
        if held.isEmpty {
          VStack(alignment: .leading, spacing: 10) {
            Text("This project is not on a computer yet. Open it in ADE on a computer to add it there.")
              .font(.system(size: 13.5))
              .foregroundStyle(ADEColor.textSecondary)
              .fixedSize(horizontal: false, vertical: true)
            if account.machines.isEmpty {
              Button("Connect a computer") {
                dismiss()
                onConnectComputer()
              }
              .buttonStyle(ADEKitButtonStyle())
            }
          }
          .padding(14)
          .adeKitCard(padding: nil)
        } else {
          VStack(spacing: 0) {
            ForEach(Array(held.enumerated()), id: \.element.copy.machineKey) { index, entry in
              if index > 0 { Divider().padding(.leading, 14) }
              copyRow(entry.copy, machine: entry.machine)
            }
          }
          .adeKitCard(padding: nil)
        }
      }
    }
  }

  private func copyRow(_ copy: AccountProjectCopy, machine: AccountMachine?) -> some View {
    let online = machine?.online == true
    return HStack(alignment: .center, spacing: 10) {
      ADEKitDot(tone: online ? .ok : .neutral, size: 7)
      VStack(alignment: .leading, spacing: 2) {
        Text(machine?.displayName ?? "A computer that left your account")
          .font(.system(size: 14.5, weight: .medium))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
        Text(copy.rootPath)
          .font(.adeMono(11))
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(1)
          .truncationMode(.middle)
        if !online {
          Text(hubAccountRelativeTime(epochMs: machine?.lastSeenAt).map { "Offline, last seen \($0)" } ?? "Offline")
            .font(.system(size: 12))
            .foregroundStyle(ADEColor.textSecondary)
        }
      }
      Spacer(minLength: 8)
      if online {
        Button("Open") {
          dismiss()
          DeepLinkRouter.shared.openAccountProjectCopy(
            accountMachineKey: copy.machineKey,
            checkoutId: copy.checkoutId
          )
        }
        .buttonStyle(ADEKitButtonStyle(prominent: true))
        .accessibilityLabel("Open on \(machine?.displayName ?? "this computer")")
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 11)
  }
}
