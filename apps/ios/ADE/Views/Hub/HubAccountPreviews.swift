#if DEBUG
import SwiftUI

// Fixture screens for the account's projects on the Hub. No network, no
// pairing, no Clerk.
//
// `-adePreviewScreen hub-account -adeHubAccountState <state>` mounts the real
// Hub over a seeded account list. States: `zero-computers` (projects, no
// computer), `offline-computers` (the account's computers are all offline),
// `empty` (no projects, no computer), `loading`, `cant-load` (first start
// offline), `saved` (a read failed, the saved list shows).
//
// `-adePreviewScreen hub-account-states` shows every status line and empty
// state side by side, including the ones that need a paired computer
// (connecting, unreachable, disconnected), which a fixture cannot pair.

enum HubAccountPreviewData {
  static let identity = AccountIdentity(
    userId: "user_preview_hub",
    displayName: "Sam Rivera",
    email: "sam.rivera@example.com",
    imageURL: nil,
    providerLabel: "GitHub",
    providerId: "github"
  )

  static func machines(online: Bool) -> [AccountMachine] {
    let now = Date().timeIntervalSince1970 * 1000
    let rows = [
      #"{"machineKey":"mk-studio","deviceId":"dev-studio","name":"Mac Studio","platform":"darwin","deviceType":"desktop","online":\#(online),"lastSeenAt":\#(now - 7_200_000)}"#,
      #"{"machineKey":"mk-macbook","deviceId":"dev-macbook","name":"MacBook Pro","platform":"darwin","deviceType":"laptop","online":false,"lastSeenAt":\#(now - 86_400_000 * 3)}"#,
    ]
    return rows.map { try! JSONDecoder().decode(AccountMachine.self, from: Data($0.utf8)) }
  }

  static func project(
    _ id: String,
    owner: String,
    name: String,
    copies: [(machine: String, path: String)] = []
  ) -> AccountProject {
    let projectId = "ap_" + String(repeating: id, count: 32).prefix(32)
    return AccountProject(
      id: String(projectId),
      host: "github.com",
      repoId: nil,
      repoKey: "repo:github.com/\(owner)/\(name)",
      owner: owner,
      name: name,
      defaultBranch: "main",
      addedAt: 1_700_000_000_000,
      removedAt: nil,
      mergedInto: nil,
      aliases: ["repo:github.com/\(owner)/\(name)"],
      copies: copies.enumerated().map { index, copy in
        AccountProjectCopy(
          projectId: String(projectId),
          machineKey: copy.machine,
          checkoutId: "project_\(id)\(index)",
          rootPath: copy.path,
          isMain: true,
          lastSeenAt: 1_700_000_000_000
        )
      }
    )
  }

  static var projects: [AccountProject] {
    [
      project("a", owner: "sam-rivera", name: "ade", copies: [("mk-studio", "/Users/sam/code/ade"), ("mk-macbook", "/Users/sam/dev/ade")]),
      project("b", owner: "sam-rivera", name: "website", copies: [("mk-studio", "/Users/sam/code/website")]),
      project("c", owner: "northwind", name: "billing-service"),
      project("d", owner: "sam-rivera", name: "dotfiles"),
    ]
  }

  /// No saved icons: the cards show the default project icon.
  static let display: [String: AccountProjectDisplay] = [:]

  @MainActor
  static func seed(state: String) {
    AccountService.shared.seedPreviewSignedIn(identity)
    let store = AccountProjectStore.shared
    switch state {
    case "offline-computers":
      AccountService.shared.seedPreviewMachines(machines(online: false))
      store.seedPreview(projects: projects, display: display, phase: .ready, lastSuccessAt: Date())
    case "empty":
      AccountService.shared.seedPreviewMachines([])
      store.seedPreview(projects: [], display: [:], phase: .ready, lastSuccessAt: Date())
    case "loading":
      AccountService.shared.seedPreviewMachines([])
      store.seedPreview(projects: [], display: [:], phase: .loading, lastSuccessAt: nil)
    case "cant-load":
      AccountService.shared.seedPreviewMachines([])
      store.seedPreview(projects: [], display: [:], phase: .offline, lastSuccessAt: nil)
    case "saved":
      AccountService.shared.seedPreviewMachines(machines(online: false))
      store.seedPreview(projects: projects, display: display, phase: .offline, lastSuccessAt: Date().addingTimeInterval(-3_600))
    default:
      AccountService.shared.seedPreviewMachines([])
      store.seedPreview(
        projects: projects.map { project in
          AccountProject(
            id: project.id, host: project.host, repoId: project.repoId, repoKey: project.repoKey,
            owner: project.owner, name: project.name, defaultBranch: project.defaultBranch,
            addedAt: project.addedAt, removedAt: nil, mergedInto: nil, aliases: project.aliases, copies: []
          )
        },
        display: display,
        phase: .ready,
        lastSuccessAt: Date()
      )
    }
  }

  static var requestedState: String {
    let arguments = ProcessInfo.processInfo.arguments
    guard let index = arguments.firstIndex(of: "-adeHubAccountState"),
          arguments.index(after: index) < arguments.endIndex else { return "zero-computers" }
    return arguments[arguments.index(after: index)]
  }
}

/// `hub-account`: the real Hub over a seeded account list.
struct HubAccountPreviewHost: View {
  @EnvironmentObject private var syncService: SyncService
  @State private var seeded = false

  var body: some View {
    Group {
      if seeded {
        // The header reads the activity drawer, as under `ContentView`.
        HubScreen().environmentObject(syncService.attentionDrawer)
      } else {
        ADEColor.pageBackground.ignoresSafeArea()
      }
    }
    .task {
      HubAccountPreviewData.seed(state: HubAccountPreviewData.requestedState)
      seeded = true
    }
  }
}

/// `hub-account-states`: every status line and empty grid, one under another.
struct HubAccountStatesPreviewHost: View {
  private let notices: [(String, HubAccountNotice)] = [
    ("List read failed", .savedProjects),
    ("Connecting", .connecting(machineName: "Mac Studio")),
    ("Computer offline", .noComputerOnline(machineName: "Mac Studio", lastSeen: "2 hours ago", failed: false, byUser: false)),
    ("Connection failed", .noComputerOnline(machineName: "Mac Studio", lastSeen: nil, failed: true, byUser: false)),
    ("Disconnected by you", .noComputerOnline(machineName: "Mac Studio", lastSeen: nil, failed: false, byUser: true)),
    ("No computer", .noComputer(accountHasComputers: false)),
    ("Computers on the account", .noComputer(accountHasComputers: true)),
  ]
  private let empties: [(String, HubAccountEmptyKind)] = [
    ("Loading", .loading),
    ("First start offline", .cantLoad),
    ("No projects, no computer", .noProjects(hasComputer: false, canAddProject: false)),
    ("No projects, a computer", .noProjects(hasComputer: true, canAddProject: true)),
  ]

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        ForEach(notices, id: \.0) { label, notice in
          caption(label)
          HubAccountStatusCard(notice: notice)
        }
        ForEach(empties, id: \.0) { label, kind in
          caption(label)
          HubAccountEmptyCard(kind: kind).adeKitCard(padding: nil)
        }
        caption("Cards with no reachable computer")
        LazyVGrid(columns: HubProjectGridMetrics.columns, spacing: HubProjectGridMetrics.spacing) {
          ForEach(HubAccountPreviewData.projects) { project in
            HubProjectTile(
              presentation: HubProjectPresentation(
                project: hubAccountProjectSummary(project, display: HubAccountPreviewData.display[project.id]),
                isActive: false, isSwitching: false, isLoading: false,
                laneCount: 0, chatCount: 0, lanes: [],
                note: hubAccountProjectNote(project, machines: HubAccountPreviewData.machines(online: true))
              ),
              machineLabel: project.copies.isEmpty ? nil : "Mac Studio",
              machineCount: Set(project.copies.map(\.machineKey)).count,
              canForget: false,
              onOpenProject: {}, onChangeIcon: { _ in }, onMoveToTop: {}, onForget: {}
            )
          }
        }
      }
      .padding(16)
    }
    .background(ADEColor.pageBackground.ignoresSafeArea())
  }

  private func caption(_ text: String) -> some View {
    Text(text)
      .font(.system(size: 12, weight: .medium))
      .foregroundStyle(ADEColor.textMuted)
      .padding(.top, 6)
  }
}

// MARK: - The account project screens, on every display

// `-adePreviewScreen duo-account-<name>` mounts one screen of the account's
// projects under the Duo layout root, so it shows the way the app shows it
// on any iPhone and in each pose of the iPhone Duo (`fold`, `rotate`).
//
// - `duo-account-hub`: the real Hub (`-adeHubAccountState`, plus `online`:
//   computers online, a project with two folders on one computer). Tap a
//   card for the project home, then Location or Remove.
// - `duo-account-start-on`: the Add lane sheet's Start-on list, every kind.
// - `duo-account-create`: the Create form with Publish to GitHub
//   (`-adePublishState off|unavailable`).
// - `duo-account-github`: every GitHub state card.
// - `duo-account-settings`: Settings › Account with the GitHub section
//   (`-adeGitHubState connected|needs-reauth|unavailable|not-connected|unknown`).
// - `duo-account-prs`: the PRs tab reading GitHub with no computer
//   (`-adeGitHubDirectError not-connected|ended|app|rate`).

extension HubAccountPreviewData {
  static func argument(_ flag: String) -> String? {
    let arguments = ProcessInfo.processInfo.arguments
    guard let index = arguments.firstIndex(of: flag), arguments.index(after: index) < arguments.endIndex else { return nil }
    return arguments[arguments.index(after: index)]
  }

  /// `online`: both computers online; `ade` has two folders on Mac Studio,
  /// so Location offers "Use for new lanes".
  @MainActor
  static func seedOnline() {
    AccountService.shared.seedPreviewSignedIn(identity)
    let now = Date().timeIntervalSince1970 * 1000
    let rows = [
      #"{"machineKey":"mk-studio","deviceId":"dev-studio","name":"Mac Studio","platform":"darwin","deviceType":"desktop","online":true,"lastSeenAt":\#(now)}"#,
      #"{"machineKey":"mk-macbook","deviceId":"dev-macbook","name":"MacBook Pro","platform":"darwin","deviceType":"laptop","online":false,"lastSeenAt":\#(now - 86_400_000 * 3)}"#,
      #"{"machineKey":"mk-mini","deviceId":"dev-mini","name":"Mac mini","platform":"darwin","deviceType":"desktop","online":true,"lastSeenAt":\#(now)}"#,
    ]
    AccountService.shared.seedPreviewMachines(rows.map { try! JSONDecoder().decode(AccountMachine.self, from: Data($0.utf8)) })
    var list = projects
    let ade = list[0]
    let extra = AccountProjectCopy(
      projectId: ade.id,
      machineKey: "mk-studio",
      checkoutId: "project_a9",
      rootPath: "/Users/sam/worktrees/ade-release-candidate-with-a-long-folder-name",
      isMain: false,
      lastSeenAt: 1_600_000_000_000
    )
    list[0] = AccountProject(
      id: ade.id, host: ade.host, repoId: ade.repoId, repoKey: ade.repoKey, owner: ade.owner, name: ade.name,
      defaultBranch: ade.defaultBranch, addedAt: ade.addedAt, removedAt: nil, mergedInto: nil,
      aliases: ade.aliases, copies: ade.copies + [extra]
    )
    AccountProjectStore.shared.seedPreview(projects: list, display: display, phase: .ready, lastSuccessAt: Date())
  }
}

enum AccountProjectScreenPreviews {
  @MainActor
  static func view(_ name: String) -> AnyView? {
    switch name {
    case "duo-account-hub":
      return AnyView(AccountHubPreviewHost())
    case "duo-account-start-on":
      return AnyView(AccountSheetPreviewHost { AccountStartOnPreview() })
    case "duo-account-create":
      return AnyView(AccountSheetPreviewHost { AccountCreatePreview() })
    case "duo-account-github":
      return AnyView(AccountGitHubStatesPreview())
    case "duo-account-settings":
      return AnyView(AccountSettingsPreviewHost())
    case "duo-account-prs":
      return AnyView(AccountDirectPrsPreviewHost())
    default:
      return nil
    }
  }
}

/// The Hub with the state `-adeHubAccountState` names (`online` included).
private struct AccountHubPreviewHost: View {
  @EnvironmentObject private var syncService: SyncService
  @State private var seeded = false

  var body: some View {
    Group {
      if seeded {
        HubScreen().environmentObject(syncService.attentionDrawer)
      } else {
        ADEColor.pageBackground.ignoresSafeArea()
      }
    }
    .task {
      let state = HubAccountPreviewData.requestedState
      if state == "online" {
        HubAccountPreviewData.seedOnline()
      } else {
        HubAccountPreviewData.seed(state: state)
      }
      seeded = true
    }
  }
}

/// A sheet over a plain page, as the app presents the screen.
private struct AccountSheetPreviewHost<Sheet: View>: View {
  @ViewBuilder let sheet: () -> Sheet
  @State private var presented = false

  var body: some View {
    ADEColor.pageBackground.ignoresSafeArea()
      .sheet(isPresented: $presented) { sheet() }
      .task { presented = true }
  }
}

/// The Add lane sheet of an account project: a live computer, an online one
/// with the main copy, one that needs a copy first, one asleep (Wake) and
/// one offline.
private struct AccountStartOnPreview: View {
  var body: some View {
    AddLaneSheet(
      machines: [],
      startOn: LaneStartOnContext(
        accountProjectId: "ap_preview",
        projectName: "ade",
        candidates: [
          StartOnCandidate(accountMachineKey: "mk-studio", fleetKey: "studio", name: "Mac Studio", kind: .copy, isMain: false, lastSeenAt: 2, isLive: true),
          StartOnCandidate(accountMachineKey: "mk-macbook", fleetKey: nil, name: "MacBook Pro", symbol: "laptopcomputer", kind: .copy, isMain: true, lastSeenAt: 1, isLive: false),
          StartOnCandidate(accountMachineKey: "mk-mini", fleetKey: nil, name: "Mac mini in the office", kind: .cloneFirst, isMain: false, lastSeenAt: 0, isLive: false),
          StartOnCandidate(accountMachineKey: "mk-tower", fleetKey: nil, name: "Linux tower", kind: .offline, isMain: false, lastSeenAt: 0, isLive: false, canWake: true, lastSeen: "12 minutes ago"),
          StartOnCandidate(accountMachineKey: "mk-old", fleetKey: nil, name: "Old iMac", kind: .offline, isMain: false, lastSeenAt: 0, isLive: false, lastSeen: "3 weeks ago"),
        ],
        focusedKey: "studio",
        connect: { _ in nil },
        copy: { _ in nil }
      ),
      onLaneCreated: { _ in }
    )
  }
}

/// Create with Publish to GitHub (`-adePublishState off|unavailable`).
private struct AccountCreatePreview: View {
  @State private var name = "billing-dashboard"
  @State private var parent = "/Users/sam/Projects"
  @State private var publish = HubAccountPreviewData.argument("-adePublishState") != "off"

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: 16) {
          RemoteProjectCreateForm(
            name: $name,
            parentDir: $parent,
            publish: $publish,
            publishUnavailable: HubAccountPreviewData.argument("-adePublishState") == "unavailable"
              ? "Update ADE on Mac Studio to publish from your phone. It stays on that computer only."
              : nil,
            computerName: "Mac Studio",
            isSubmitting: false,
            onChooseParent: {},
            onCancel: {},
            onCreate: {}
          )
        }
        .padding(20)
        .frame(maxWidth: 560)
        .frame(maxWidth: .infinity)
      }
      .background(ADEColor.pageBackground.ignoresSafeArea())
      .navigationTitle("Create a new project")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) { Button("Close") {} }
      }
    }
    .presentationDetents([.large])
    .presentationDragIndicator(.visible)
  }
}

/// Every GitHub state card a direct read can end in.
private struct AccountGitHubStatesPreview: View {
  private let errors: [(String, GitHubDirectError)] = [
    ("Not connected", GitHubDirectError(kind: .notConnected)),
    ("Connection ended", GitHubDirectError(kind: .signInExpired)),
    ("App not installed", GitHubDirectError(kind: .appNotInstalled)),
    ("Read only", GitHubDirectError(kind: .appNotInstalled, reason: "read_only")),
    ("Update to approve", GitHubDirectError(kind: .rightsNotAccepted, accountType: "Organization")),
    ("Single sign-on", GitHubDirectError(kind: .repoNotReachable, sso: true)),
    ("Not reachable", GitHubDirectError(kind: .repoNotReachable)),
    ("Rate limit", GitHubDirectError(kind: .rateLimited, retryAt: Date().addingTimeInterval(600))),
    ("GitHub down", GitHubDirectError(kind: .githubUnavailable)),
  ]

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 12) {
          ForEach(errors, id: \.0) { label, error in
            Text(label)
              .font(.system(size: 12, weight: .medium))
              .foregroundStyle(ADEColor.textMuted)
              .padding(.top, 6)
            if let copy = githubDirectStateCopy(error, owner: "northwind", name: "billing-service", githubLogin: "sam-rivera") {
              GitHubStateCard(copy: copy)
            }
          }
        }
        .padding(16)
      }
      .background(ADEColor.pageBackground.ignoresSafeArea())
      .navigationTitle("GitHub states")
      .navigationBarTitleDisplayMode(.inline)
    }
  }
}

/// Settings › Account, signed in, with the GitHub section in the state
/// `-adeGitHubState` names.
private struct AccountSettingsPreviewHost: View {
  @EnvironmentObject private var fleet: MachineFleet
  @EnvironmentObject private var syncService: SyncService
  @StateObject private var machineController = SettingsMachineController()
  @State private var seeded = false

  var body: some View {
    Group {
      if seeded {
        NavigationStack {
          SettingsAccountPage(
            syncService: syncService,
            machineController: machineController,
            onSignIn: {},
            machinesPage: { AnyView(Text("Machines")) },
            integrationsPage: { AnyView(Text("Integrations")) }
          )
        }
        .environmentObject(syncService)
      } else {
        ADEColor.surfaceBackground.ignoresSafeArea()
      }
    }
    .task {
      HubAccountPreviewData.seedOnline()
      let state: GitHubAccountState
      switch HubAccountPreviewData.argument("-adeGitHubState") {
      case "needs-reauth": state = .needsReauth(reason: nil)
      case "unavailable": state = .unavailable(retryAt: Date().addingTimeInterval(900))
      case "not-connected": state = .notConnected
      case "unknown": state = .unknown
      default: state = .connected(login: "sam-rivera")
      }
      GitHubAccountConnection.shared.seedPreview(state: state)
      machineController.bind(syncService: syncService, fleet: fleet)
      seeded = true
    }
  }
}

/// Canned GitHub answers for the fixture screens.
struct GitHubDirectPreviewAnswers {
  var error: GitHubDirectError?
  var pulls: [GitHubDirectPull]
  var checks: GitHubDirectChecks
  var reviews: [GitHubDirectReview]
  var comments: [GitHubDirectComment]

  func listPulls() -> Result<(pulls: [GitHubDirectPull], truncated: Bool), GitHubDirectError> {
    if let error { return .failure(error) }
    return .success((pulls, true))
  }

  func getPull(_ number: Int) -> Result<GitHubDirectPullDetail, GitHubDirectError> {
    if let error { return .failure(error) }
    guard let pull = pulls.first(where: { $0.number == number }) else { return .failure(GitHubDirectError(kind: .notFound)) }
    return .success(GitHubDirectPullDetail(
      pull: pull,
      body: "Moves the account project list onto the phone, so the Hub lists every repository on the account with no computer on.\n\nThe card shows how many computers hold a copy, and the project home opens the folder on the one that is online.",
      mergeable: true, mergeableState: "clean", additions: 412, deletions: 97, changedFiles: 14, commits: 6,
      requestedReviewers: ["northwind-bot"]
    ))
  }

  static func fixture(error: GitHubDirectError?) -> GitHubDirectPreviewAnswers {
    func pull(_ number: Int, _ title: String, _ author: String, head: String, draft: Bool = false, labels: [String] = []) -> GitHubDirectPull {
      GitHubDirectPull(
        number: number, title: title, state: "open", draft: draft, merged: false, author: author, authorAvatarUrl: nil,
        headRef: head, headSha: "0123456789abcdef0123456789abcdef01234567", baseRef: "main", labels: labels,
        createdAt: "2026-11-10T09:12:00Z", updatedAt: "2026-11-12T08:40:00Z",
        htmlUrl: "https://github.com/sam-rivera/ade/pull/\(number)"
      )
    }
    return GitHubDirectPreviewAnswers(
      error: error,
      pulls: [
        pull(2204, "iPhone account projects 2: GitHub on the phone, Use for new lanes, Publish to GitHub", "sam-rivera", head: "ade/account-iphone-2", labels: ["ios"]),
        pull(2201, "Hub cards from the account list", "jordan-lee", head: "ade/hub-account-cards"),
        pull(2196, "Draft: Start on for chats", "sam-rivera", head: "ade/start-on-chats", draft: true),
        pull(2188, "Fix the relay drop on a slow network", "alex-chen", head: "fix/relay-drop", labels: ["bug", "sync"]),
      ],
      checks: GitHubDirectChecks(
        runs: [
          GitHubDirectCheckRun(name: "iOS build and tests", status: "completed", conclusion: "success", appName: "GitHub Actions", htmlUrl: "https://github.com/sam-rivera/ade/actions/runs/1"),
          GitHubDirectCheckRun(name: "Desktop tests (shard 3 of 6)", status: "completed", conclusion: "failure", appName: "GitHub Actions", htmlUrl: "https://github.com/sam-rivera/ade/actions/runs/2"),
          GitHubDirectCheckRun(name: "Lint", status: "in_progress", conclusion: nil, appName: "GitHub Actions", htmlUrl: nil),
        ],
        statuses: [],
        combinedState: nil
      ),
      reviews: [
        GitHubDirectReview(id: 1, author: "jordan-lee", state: "APPROVED", body: "Looks good on my phone.", submittedAt: "2026-11-12T07:00:00Z"),
      ],
      comments: [
        GitHubDirectComment(id: 1, kind: "review", author: "alex-chen", body: "This path can be long on a laptop. Truncate in the middle?", createdAt: "2026-11-11T18:00:00Z", path: "apps/ios/ADE/Views/Hub/ProjectLocationScreen.swift", line: 237, htmlUrl: nil),
      ]
    )
  }
}

/// The PRs tab with no computer: the open PRs read from GitHub. On the
/// Duo's inner display, a PR opens in the detail column.
private struct AccountDirectPrsPreviewHost: View {
  @EnvironmentObject private var syncService: SyncService
  @EnvironmentObject private var fleet: MachineFleet
  @State private var inputs: PrsRootInputs?

  var body: some View {
    Group {
      if let inputs {
        PRsTabView(syncService: syncService, machineFleet: fleet, isActive: true, inputs: inputs)
      } else {
        ADEColor.pageBackground.ignoresSafeArea()
      }
    }
    .task {
      HubAccountPreviewData.seedOnline()
      GitHubAccountConnection.shared.seedPreview(state: .connected(login: "sam-rivera"))
      let error: GitHubDirectError? = {
        switch HubAccountPreviewData.argument("-adeGitHubDirectError") {
        case "not-connected": return GitHubDirectError(kind: .notConnected)
        case "ended": return GitHubDirectError(kind: .signInExpired)
        case "app": return GitHubDirectError(kind: .appNotInstalled)
        case "rate": return GitHubDirectError(kind: .rateLimited, retryAt: Date().addingTimeInterval(600))
        default: return nil
        }
      }()
      GitHubDirectClient.shared.preview = .fixture(error: error)
      var next = PrsRootInputs(syncService, fleet: fleet, isActive: true, rootActionKey: PRsTabView.rootActionKey)
      next.directRepoOwner = "sam-rivera"
      next.directRepoName = "ade"
      next.directComputerName = "Mac Studio"
      inputs = next
    }
  }
}
#endif
