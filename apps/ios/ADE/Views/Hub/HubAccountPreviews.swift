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

  static let display: [String: AccountProjectDisplay] = [
    "ap_" + String(repeating: "a", count: 32): AccountProjectDisplay(name: "ADE"),
  ]

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
#endif
