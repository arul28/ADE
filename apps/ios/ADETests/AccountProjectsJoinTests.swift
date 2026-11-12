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

  func testOnlyGitHubOriginsGiveANameToMatch() {
    let cases: [(String?, String?)] = [
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

  private func card(_ id: String, identity: String?, copies: [(String, String)] = []) -> HubAccountJoinCard {
    HubAccountJoinCard(
      cardId: id,
      gitHubIdentity: identity,
      copies: copies.map { HubAccountCopyRef(accountMachineKey: $0.0, checkoutId: $0.1) }
    )
  }

  private func response(cursor: Int, reset: Bool, _ projects: [AccountProject]) -> AccountProjectListResponse {
    AccountProjectListResponse(cursor: cursor, reset: reset, projects: projects)
  }
}
