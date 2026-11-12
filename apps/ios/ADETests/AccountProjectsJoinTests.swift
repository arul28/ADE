import XCTest
@testable import ADE

/// The account project list on the phone: how a list answer changes what the
/// phone holds, and how the Hub's machine cards match account projects. Both
/// are cross-machine contracts: a wrong merge shows a removed project again or
/// drops a live one, and a wrong join shows one repository as two cards or
/// hides a project that a machine still shows.
final class AccountProjectsJoinTests: XCTestCase {

  // MARK: - List answers

  func testListAnswersReplaceOnResetAndMergeDeltas() {
    let first = AccountProjectListState().applying(response(cursor: 3, reset: true, [
      project("a", name: "ade"),
      project("b", name: "website"),
    ]))
    XCTAssertEqual(first.cursor, 3)
    XCTAssertEqual(first.liveProjects.map(\.name), ["ade", "website"])

    // A delta replaces rows by id and keeps the rest.
    let removedB = project("b", name: "website", removedAt: 10)
    let delta = first.applying(response(cursor: 5, reset: false, [removedB, project("c", name: "docs")]))
    XCTAssertEqual(delta.cursor, 5)
    XCTAssertEqual(delta.liveProjects.map(\.name), ["ade", "docs"])
    XCTAssertEqual(delta.removedProjects.map(\.id), [removedB.id])

    // A reset drops rows the answer does not carry.
    let reset = delta.applying(response(cursor: 9, reset: true, [project("c", name: "docs")]))
    XCTAssertEqual(reset.liveProjects.map(\.name), ["docs"])
    XCTAssertTrue(reset.removedProjects.isEmpty)
  }

  func testMergedRowsAreNeitherLiveNorRemoved() {
    let state = AccountProjectListState().applying(response(cursor: 1, reset: true, [
      project("a", name: "ade", mergedInto: projectId("b")),
      project("b", name: "ade"),
    ]))
    XCTAssertEqual(state.liveProjects.map(\.id), [projectId("b")])
    XCTAssertTrue(state.removedProjects.isEmpty)
  }

  func testMergedTargetsFollowChainsToALiveProjectOnly() {
    // a -> b -> c (live); d -> e (removed); f -> a project the phone lacks.
    let state = AccountProjectListState().applying(response(cursor: 1, reset: true, [
      project("a", name: "ade", removedAt: 1, mergedInto: projectId("b")),
      project("b", name: "ade", removedAt: 2, mergedInto: projectId("c")),
      project("c", name: "ade"),
      project("d", name: "web", removedAt: 1, mergedInto: projectId("e")),
      project("e", name: "web", removedAt: 3),
      project("f", name: "docs", removedAt: 1, mergedInto: projectId("z")),
    ]))
    XCTAssertEqual(state.mergedTargets, [projectId("a"): projectId("c"), projectId("b"): projectId("c")])
  }

  // MARK: - Join

  func testJoinMatchesByCopyBeforeName() {
    // The card's folder is a copy of `other`, although its name is `ade`'s.
    let ade = project("a", name: "ade")
    let other = project("b", name: "fork", copies: [copy("b", machine: "mk-1", checkout: "project_1")])
    let join = hubJoinAccountProjects(
      cards: [card("card-1", identity: "owner/ade", copies: [("mk-1", "project_1")])],
      live: [ade, other],
      removed: []
    )
    XCTAssertEqual(join.accountIdByCardId["card-1"], other.id)
    XCTAssertEqual(join.unmatchedProjects.map(\.id), [ade.id])
  }

  func testJoinMatchesOldAddressesAndKeepsTheFirstClaim() {
    // Renamed on GitHub: the old address is an alias.
    let renamed = project("a", name: "ade-app", aliases: ["repo:github.com/owner/ade"])
    let join = hubJoinAccountProjects(
      cards: [
        card("first", identity: "owner/ade"),
        card("second", identity: "owner/ade-app"),
      ],
      live: [renamed],
      removed: []
    )
    XCTAssertEqual(join.accountIdByCardId["first"], renamed.id)
    // A second card of the same project stays a card of its own.
    XCTAssertNil(join.accountIdByCardId["second"])
    XCTAssertTrue(join.unmatchedProjects.isEmpty)
  }

  func testJoinHidesRemovedAndReportsUnknownRepositories() {
    let removed = project("a", name: "old", removedAt: 5)
    let join = hubJoinAccountProjects(
      cards: [
        card("removed-card", identity: "owner/old"),
        card("new-card", identity: "owner/new"),
        card("no-origin", identity: nil),
      ],
      live: [],
      removed: [removed]
    )
    XCTAssertEqual(join.hiddenCardIds, ["removed-card"])
    XCTAssertEqual(join.unknownIdentities, ["owner/new"])
    XCTAssertTrue(join.accountIdByCardId.isEmpty)
  }

  func testRemovedAddressThatALiveProjectHoldsDoesNotHide() {
    // Removed, then added again as a new row: the live row wins.
    let removed = project("a", name: "ade", removedAt: 5)
    let live = project("b", name: "ade")
    let join = hubJoinAccountProjects(cards: [card("card", identity: "owner/ade")], live: [live], removed: [removed])
    XCTAssertEqual(join.accountIdByCardId["card"], live.id)
    XCTAssertTrue(join.hiddenCardIds.isEmpty)
  }

  func testEnterpriseProjectsMatchOnlyByCopy() {
    let enterprise = project("a", name: "ade", host: "git.example.com",
                             copies: [copy("a", machine: "mk-1", checkout: "project_9")])
    let byName = hubJoinAccountProjects(cards: [card("name", identity: "owner/ade")], live: [enterprise], removed: [])
    XCTAssertNil(byName.accountIdByCardId["name"])
    let byCopy = hubJoinAccountProjects(
      cards: [card("copy", identity: nil, copies: [("mk-1", "project_9")])],
      live: [enterprise],
      removed: []
    )
    XCTAssertEqual(byCopy.accountIdByCardId["copy"], enterprise.id)
  }

  func testJoinUsesTheIdAMachineSentFirst() {
    let ade = project("a", name: "ade")
    let fork = project("b", name: "fork", copies: [copy("b", machine: "mk-1", checkout: "project_1")])
    let gone = project("c", name: "old", removedAt: 5)
    let merged = project("d", name: "ade-old", removedAt: 4, mergedInto: ade.id)
    let unknown = projectId("e")
    let join = hubJoinAccountProjects(
      cards: [
        // The sent id beats a copy and a name that point at `fork`.
        card("sent", identity: "owner/fork", copies: [("mk-1", "project_1")], sentId: ade.id),
        // A merged id claims the project it became; `ade` is taken, so this
        // card stays a card of its own and claims nothing else.
        card("merged", identity: "owner/fork", sentId: merged.id),
        card("removed", identity: "owner/ade", sentId: gone.id),
        // An id the list does not hold yet: ask for a read, then match by name.
        card("unknown", identity: "owner/fork", sentId: unknown),
      ],
      live: [ade, fork],
      removed: [gone],
      merged: [merged.id: ade.id]
    )
    XCTAssertEqual(join.accountIdByCardId, ["sent": ade.id, "unknown": fork.id])
    XCTAssertEqual(join.hiddenCardIds, ["removed"])
    XCTAssertEqual(join.unknownIdentities, ["id:\(unknown)"])
    XCTAssertTrue(join.unmatchedProjects.isEmpty)
  }

  func testResolverOrder() {
    let ade = project("a", name: "ade", copies: [copy("a", machine: "mk-1", checkout: "project_1")])
    let web = project("b", name: "web")
    let gone = project("c", name: "old", removedAt: 5)
    let resolver = hubAccountResolver(
      live: [ade, web],
      removed: [gone],
      merged: [projectId("m"): ade.id],
      accountMachineKey: { $0 == "machine:dev-1" ? "mk-1" : nil }
    )
    let cases: [(String?, String, String?, String?, String?)] = [
      // fleet key, checkout, identity, sent id -> expected
      (nil, "x", "owner/old", projectId("q"), projectId("q")),
      (nil, "x", nil, projectId("m"), ade.id),
      // The copy table beats a GitHub address that names another project.
      ("machine:dev-1", "project_1", "owner/web", nil, ade.id),
      ("machine:dev-2", "project_1", nil, nil, nil),
      (nil, "x", "owner/ade", nil, ade.id),
      (nil, "x", "owner/old", nil, gone.id),
      (nil, "x", "owner/none", nil, nil),
    ]
    for (fleetKey, checkout, identity, sent, expected) in cases {
      XCTAssertEqual(
        resolver.accountProjectId(fleetKey: fleetKey, checkoutId: checkout, gitHubIdentity: identity, sentId: sent),
        expected,
        "\(fleetKey ?? "-") \(checkout) \(identity ?? "-") \(sent ?? "-")"
      )
    }
  }

  func testFleetMergeKeysOnTheAccountProject() {
    let ade = project("a", name: "ade")
    let web = project("b", name: "web")
    let resolver = hubAccountResolver(live: [ade, web], removed: [], merged: [:], accountMachineKey: { _ in nil })
    // The focused machine has `ade` in a folder named `work`, with no origin.
    var focused = MobileProjectSummary(id: "project_f", displayName: "work", rootPath: "/f/work",
                                       laneCount: 0, isAvailable: true, isCached: false)
    focused.accountProjectId = ade.id
    let machines = [
      fleetMachine("machine:one", [
        // `ade` again, under another folder name: joins the focused card.
        rosterProject("project_1", folder: "ade-checkout", origin: nil, sentId: ade.id),
        // Same folder name as the focused card, but the account says `web`.
        rosterProject("project_2", folder: "work", origin: nil, sentId: web.id),
      ]),
      fleetMachine("machine:two", [
        // `web` on a second computer, found by its GitHub address.
        rosterProject("project_3", folder: "website", origin: "github.com/owner/web", sentId: nil),
      ]),
    ]
    let merge = hubMergeFleetRosters(focused: [(project: focused, roster: nil)], machines: machines, resolver: resolver)
    XCTAssertEqual(merge.projectLocations["project_f"]?.map(\.project.id), ["project_1"])
    XCTAssertEqual(merge.extraProjects.count, 1)
    let webCard = merge.extraProjects[0].summary.id
    XCTAssertEqual(merge.projectLocations[webCard]?.map(\.project.id), ["project_2", "project_3"])
    XCTAssertEqual(merge.accountIdByCardId, ["project_f": ade.id, webCard: web.id])

    // Without an account the same folder name merges, and `ade-checkout` does not.
    let plain = hubMergeFleetRosters(focused: [(project: focused, roster: nil)], machines: machines)
    XCTAssertEqual(plain.projectLocations["project_f"]?.map(\.project.id), ["project_2"])
  }

  func testOldAndNewBrainRowsDecode() throws {
    let old = #"{"projectId":"p","displayName":"ade","booted":false,"runningCount":0,"attentionCount":0,"lanes":[],"chats":[]}"#
    let new = #"{"projectId":"p","displayName":"ade","booted":false,"runningCount":0,"attentionCount":0,"lanes":[],"chats":[],"accountProjectId":"ap_1","githubRepoId":42}"#
    let decoder = JSONDecoder()
    let oldRow = try decoder.decode(RemoteRosterProject.self, from: Data(old.utf8))
    let newRow = try decoder.decode(RemoteRosterProject.self, from: Data(new.utf8))
    XCTAssertNil(oldRow.accountProjectId)
    XCTAssertEqual(newRow.accountProjectId, "ap_1")
    XCTAssertEqual(newRow.githubRepoId, 42)
    // A roster delta's head carries the link too.
    var patched = oldRow
    patched.apply(head: try decoder.decode(RemoteRosterProjectHead.self, from: Data(new.utf8)))
    XCTAssertEqual(patched.asRemoteMachineProjectSummary.accountProjectId, "ap_1")
  }

  func testOnlyGitHubOriginsGiveANameToMatch() {
    let cases: [(String?, String?)] = [
      ("github.com/Owner/Repo", "owner/repo"),
      ("gitlab.com/owner/repo", nil),
      ("https://github.com/Owner/Repo.git", "owner/repo"),
      ("git@github.com:Owner/Repo.git", "owner/repo"),
      ("ssh://git@github.com/owner/repo", "owner/repo"),
      ("https://gitlab.com/owner/repo.git", nil),
      ("git@gitlab.com:owner/repo.git", nil),
      (nil, nil),
    ]
    for (origin, expected) in cases {
      XCTAssertEqual(hubGitHubRepoIdentity(originUrl: origin), expected, origin ?? "nil")
    }
  }

  // MARK: - Fixtures

  private func projectId(_ seed: String) -> String {
    "ap_" + String(repeating: seed, count: 32)
  }

  private func project(
    _ seed: String,
    name: String,
    host: String = "github.com",
    removedAt: Double? = nil,
    mergedInto: String? = nil,
    aliases: [String]? = nil,
    copies: [AccountProjectCopy] = []
  ) -> AccountProject {
    AccountProject(
      id: projectId(seed),
      host: host,
      repoId: nil,
      repoKey: "repo:\(host)/owner/\(name)",
      owner: "owner",
      name: name,
      defaultBranch: nil,
      addedAt: Double(seed.unicodeScalars.first!.value),
      removedAt: removedAt,
      mergedInto: mergedInto,
      aliases: aliases ?? ["repo:\(host)/owner/\(name)"],
      copies: copies
    )
  }

  private func copy(_ seed: String, machine: String, checkout: String) -> AccountProjectCopy {
    AccountProjectCopy(projectId: projectId(seed), machineKey: machine, checkoutId: checkout,
                       rootPath: "/code/\(checkout)", isMain: true, lastSeenAt: 1)
  }

  private func card(
    _ id: String,
    identity: String?,
    copies: [(String, String)] = [],
    sentId: String? = nil
  ) -> HubAccountJoinCard {
    HubAccountJoinCard(
      cardId: id,
      gitHubIdentity: identity,
      copies: copies.map { HubAccountCopyRef(accountMachineKey: $0.0, checkoutId: $0.1) },
      accountProjectId: sentId
    )
  }

  private func rosterProject(_ id: String, folder: String, origin: String?, sentId: String?) -> RemoteRosterProject {
    RemoteRosterProject(
      projectId: id, rootPath: "/code/\(folder)", displayName: folder, iconDataUrl: nil, lastOpenedAt: nil,
      booted: false, runningCount: 0, attentionCount: 0, lanes: [], chats: [],
      repoOriginUrl: origin, accountProjectId: sentId
    )
  }

  private func fleetMachine(_ key: String, _ projects: [RemoteRosterProject]) -> MachineFleet.Machine {
    MachineFleet.Machine(machineKey: key, name: key, state: .live, projects: projects,
                         rosterRevision: 1, lastUpdateAt: nil, isPinned: true)
  }

  private func response(cursor: Int, reset: Bool, _ projects: [AccountProject]) -> AccountProjectListResponse {
    AccountProjectListResponse(cursor: cursor, reset: reset, projects: projects)
  }
}
