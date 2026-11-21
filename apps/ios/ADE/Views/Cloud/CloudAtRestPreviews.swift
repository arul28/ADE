import SwiftUI

#if DEBUG
/// Fixture screens for an ADE Cloud lane whose computer is not awake,
/// selected like the other Duo fixtures:
///
///     xcrun simctl launch <udid> com.ade.ios -adePreviewScreen duo-cloud-rest-lane
///
/// The lane detail, the files and file screens, the session copy, the move
/// sheet, the CTO copy and the ADE Cloud sign-ins are the real views, fed
/// from in-process data (no account server, no GitHub). The Work list and
/// the tab bar of `duo-cloud-work` and `duo-cloud-account-tabs` are
/// stand-ins around them.
enum CloudAtRestPreviews {
  @MainActor
  static func view(_ name: String) -> AnyView? {
    switch name {
    case "duo-cloud-rest-lane":
      seed()
      return AnyView(NavigationStack { CloudLaneAtRestScreen(subject: Data.subject, onAwake: {}) })
    case "duo-cloud-rest-lane-unpushed":
      seed(contents: Data.unpushed)
      return AnyView(NavigationStack { CloudLaneAtRestScreen(subject: Data.subject, onAwake: {}) })
    case "duo-cloud-files":
      seed()
      return AnyView(CloudLaneFilesSheet(repo: Data.repo, branch: Data.branch, summary: Data.summary, fleetKey: Data.subject.fleetKey, onAwake: {}))
    case "duo-cloud-files-folder":
      seed()
      return AnyView(NavigationStack {
        CloudLaneFolderScreen(repo: Data.repo, branch: Data.branch, folder: "apps/web/src", summary: Data.summary, fleetKey: Data.subject.fleetKey, onAwake: {})
      })
    case "duo-cloud-files-file":
      seed()
      return AnyView(NavigationStack {
        CloudGitHubFileScreen(repo: Data.repo, branch: Data.branch, path: "apps/web/src/upload.ts", changed: Data.summary.changed.first)
      })
    case "duo-cloud-files-no-access":
      seed(contents: Data.noAccess)
      return AnyView(CloudLaneFilesSheet(repo: Data.repo, branch: Data.branch, summary: Data.summary, fleetKey: Data.subject.fleetKey, onAwake: {}))
    case "duo-cloud-files-unpushed":
      seed(contents: Data.unpushed)
      return AnyView(CloudLaneFilesSheet(repo: Data.repo, branch: Data.branch, summary: Data.summary, fleetKey: Data.subject.fleetKey, onAwake: {}))
    case "duo-cloud-work":
      seed()
      return AnyView(CloudWorkFixture())
    case "duo-cloud-session-copy":
      return AnyView(CloudSessionCopyScreen(row: Data.cliCopy, fleetKey: nil, fixtureCopy: Data.cliCopyText))
    case "duo-cloud-session-copy-deleted":
      // The CLI's computer was deleted: a composer, and one message ADE Cloud holds.
      AccountCloudStore.shared.seedPreview(access: nil, account: nil, queued: [
        AccountCloudStore.chatKey(machineKey: Data.machineKey, chatId: Data.cliCopy.sessionId): [
          CloudChatQueuedMessage(messageId: "m-cli", state: "queued", text: "Run the upload tests once more, then push."),
        ],
      ])
      return AnyView(CloudSessionCopyScreen(
        row: Data.cliCopy,
        fleetKey: ADECloudMachine.savedFleetKeyPrefix + Data.machineKey,
        fixtureCopy: Data.cliCopyText
      ))
    case "duo-cloud-shell-copy-deleted":
      return AnyView(CloudSessionCopyScreen(
        row: Data.shellCopy,
        fleetKey: ADECloudMachine.savedFleetKeyPrefix + Data.machineKey,
        fixtureCopy: CloudSessionCopy(session: Data.shellCopy, format: "text", text: "$ git status --short\n M apps/web/src/upload.ts\n$")
      ))
    case "duo-lane-move":
      // The machine list of a lane on one of the person's computers.
      return AnyView(LaneMoveMenuFixture(source: LaneMoveData.ownSource, fixture: LaneMoveFixture(options: Data.moveOptions, items: LaneMoveData.items)))
    case "duo-lane-move-cloud":
      // The machine list of an awake ADE Cloud lane: Change size… under the machines.
      return AnyView(LaneMoveMenuFixture(source: LaneMoveData.cloudSource, fixture: LaneMoveFixture(options: Data.moveOptions, items: LaneMoveData.items)))
    case "duo-lane-move-asleep":
      // An asleep computer lists the same places; its move comes from the saved copy.
      return AnyView(LaneMoveMenuFixture(
        source: LaneMoveData.asleepSource,
        fixture: LaneMoveFixture(restoreTargets: LaneMoveData.restoreTargets, preview: LaneMoveData.asleepPreview(saved: true))
      ))
    case "duo-lane-move-asleep-wake":
      // A computer that holds other lanes too wakes first.
      return AnyView(CloudLaneMoveFixture(deleted: false))
    case "duo-lane-move-review-asleep":
      return AnyView(LaneMoveReviewFixture(
        source: LaneMoveData.asleepSource,
        target: LaneMoveData.restoreTargets[0],
        items: [],
        preview: LaneMoveData.asleepPreview(saved: true)
      ))
    case "duo-lane-move-review-asleep-unsaved":
      return AnyView(LaneMoveReviewFixture(
        source: LaneMoveData.asleepSource,
        target: LaneMoveData.restoreTargets[0],
        items: [],
        preview: LaneMoveData.asleepPreview(saved: false)
      ))
    case "duo-lane-move-releasing":
      return AnyView(LaneMoveProgressFixture(run: LaneMoveData.asleepRun(wakeInstead: false), source: LaneMoveData.asleepSource))
    case "duo-lane-move-wake-instead":
      return AnyView(LaneMoveProgressFixture(run: LaneMoveData.asleepRun(wakeInstead: true), source: LaneMoveData.asleepSource))
    case "duo-lane-move-deleted":
      // A kept lane: the computers that have this project open.
      return AnyView(LaneMoveMenuFixture(
        source: LaneMoveData.keptSource,
        fixture: LaneMoveFixture(restoreTargets: LaneMoveData.restoreTargets, preview: LaneMoveData.preview)
      ))
    case "duo-lane-move-review":
      // Own computer to own computer; one chat and one CLI arrive as a summary.
      return AnyView(LaneMoveReviewFixture(source: LaneMoveData.ownSource, target: LaneMoveData.studio, items: LaneMoveData.items))
    case "duo-lane-move-review-cloud":
      // ADE Cloud to a computer without the project: the clone and the delete notes.
      return AnyView(LaneMoveReviewFixture(source: LaneMoveData.cloudSource, target: LaneMoveData.air, items: LaneMoveData.items))
    case "duo-lane-move-review-restore":
      // A kept lane back from saved copies onto the Mac Studio.
      return AnyView(LaneMoveReviewFixture(
        source: LaneMoveData.keptSource,
        target: LaneMoveData.restoreTargets[0],
        items: [],
        preview: LaneMoveData.preview
      ))
    case "duo-lane-move-moving":
      return AnyView(LaneMoveProgressFixture(run: LaneMoveData.run(.moving)))
    case "duo-lane-move-arrived":
      return AnyView(LaneMoveProgressFixture(run: LaneMoveData.run(.done)))
    case "duo-lane-move-failed":
      return AnyView(LaneMoveProgressFixture(run: LaneMoveData.run(.failed)))
    case "duo-lane-move-delete-failed":
      return AnyView(LaneMoveProgressFixture(run: LaneMoveData.run(.deleteFailed)))
    case "duo-lane-move-tag":
      // The prompt box's machine label, as a control and as a plain label.
      return AnyView(LaneMoveTagFixture())
    case "duo-cloud-move-asleep":
      return AnyView(CloudMoveFixture(deleted: false))
    case "duo-cloud-move-deleted":
      return AnyView(CloudMoveFixture(deleted: true))
    case "duo-cloud-cto-copy":
      return AnyView(CloudCtoCopyFixture())
    case "duo-cloud-cto-copy-sheet":
      return AnyView(CtoAccountCopySheet(name: "Atlas", copy: Data.ctoCopy))
    case "duo-cloud-account-tabs":
      seed()
      return AnyView(CloudAccountTabsFixture())
    case "duo-cloud-settings-direct":
      AccountCloudLaunchStore.shared.seedPreview(catalog: CloudNoComputerFixtureData.catalog, catalogError: nil, entries: [])
      return AnyView(CloudSettingsDirectFixture())
    default:
      return nil
    }
  }

  @MainActor
  private static func seed(contents: GitHubContentsPreviewAnswers = Data.contents) {
    CloudAtRestStore.shared.seedPreview(origin: Data.origin, overview: Data.overview, summaries: [Data.summary])
    GitHubDirectClient.shared.contentsPreview = contents
  }

  enum Data {
    static let origin = "github.com/sam-rivera/northwind"
    static let repo = GitHubDirectRepoRef(owner: "sam-rivera", name: "northwind")!
    static let branch = "fix-flaky-upload-test"
    static let machineKey = "mk_cloud_fixture"
    static let subject = CloudLaneAtRestSubject(
      fleetKey: "cloud-fixture",
      accountMachineKey: machineKey,
      laneId: "lane-upload",
      laneName: "Fix flaky upload test",
      branchHint: branch,
      repo: repo
    )
    static let checkedAt = Date().addingTimeInterval(-42 * 60).timeIntervalSince1970 * 1000

    static let summary = CloudGitSummary(
      machineKey: machineKey,
      laneId: "lane-upload",
      branch: branch,
      upstream: "origin/\(branch)",
      ahead: 2,
      behind: 0,
      headSha: "9f2c1e0",
      dirty: true,
      changed: [
        CloudGitChangedFile(path: "apps/web/src/upload.ts", status: "M", added: 24, removed: 9),
        CloudGitChangedFile(path: "apps/web/src/upload.test.ts", status: "M", added: 41, removed: 12),
        CloudGitChangedFile(path: "apps/web/src/uploadEvents.ts", status: "A", added: 58, removed: 0),
        CloudGitChangedFile(path: "docs/testing.md", status: "M", added: 3, removed: 1),
      ],
      truncated: false,
      checkedAt: checkedAt
    )

    static let cliCopy = CloudSessionRow(
      machineKey: machineKey, sessionId: "s-cli", kind: "cli", title: "Claude Code: run the upload tests",
      laneId: "lane-upload", laneName: "Fix flaky upload test", toolType: "claude-code", projectKey: origin,
      parentChatId: nil, status: "exited", lastActivityAt: nil, lineCount: 18,
      updatedAt: Date().addingTimeInterval(-40 * 60).timeIntervalSince1970 * 1000
    )
    static let shellCopy = CloudSessionRow(
      machineKey: machineKey, sessionId: "s-shell", kind: "shell", title: "Shell", laneId: "lane-upload",
      laneName: "Fix flaky upload test", toolType: nil, projectKey: origin, parentChatId: nil, status: "exited",
      lastActivityAt: nil, lineCount: 6, updatedAt: Date().addingTimeInterval(-55 * 60).timeIntervalSince1970 * 1000
    )
    static let overview = CloudProjectOverview(sessions: [cliCopy, shellCopy], checkedAt: Date().timeIntervalSince1970 * 1000)

    static let cliCopyText = CloudSessionCopy(session: cliCopy, format: "xterm", text: [
      "\u{1B}[1m> pnpm vitest run apps/web/src/upload.test.ts --repeat 50\u{1B}[0m",
      "",
      " \u{1B}[32m✓\u{1B}[0m apps/web/src/upload.test.ts (50 runs) 4.82s",
      "   \u{1B}[32m✓\u{1B}[0m uploads a file and waits for the done event",
      "   \u{1B}[32m✓\u{1B}[0m retries once after a dropped connection",
      "   \u{1B}[32m✓\u{1B}[0m reports progress in order",
      "",
      " Test Files  \u{1B}[32m1 passed\u{1B}[0m (1)",
      "      Tests  \u{1B}[32m150 passed\u{1B}[0m (150)",
      "   Duration  5.31s",
      "",
      "\u{1B}[36m●\u{1B}[0m All 50 runs passed. The fixed sleep is gone; the test waits on the",
      "  upload's done event now.",
      "",
      "\u{1B}[1m> git push origin fix-flaky-upload-test\u{1B}[0m",
      "To github.com:sam-rivera/northwind.git",
      "   4b1d2a9..9f2c1e0  fix-flaky-upload-test -> fix-flaky-upload-test",
      "",
    ].joined(separator: "\r\n"))

    static let contents = GitHubContentsPreviewAnswers(
      error: nil,
      folders: [
        "": [
          entry("apps", folder: true), entry("docs", folder: true), entry(".github", folder: true),
          entry("package.json"), entry("pnpm-lock.yaml", size: 182_000), entry("README.md"),
        ],
        "apps": [entry("apps/web", folder: true), entry("apps/api", folder: true)],
        "apps/web": [entry("apps/web/src", folder: true), entry("apps/web/package.json"), entry("apps/web/vite.config.ts")],
        "apps/web/src": [
          entry("apps/web/src/components", folder: true), entry("apps/web/src/upload.ts"),
          entry("apps/web/src/upload.test.ts"), entry("apps/web/src/main.tsx"), entry("apps/web/src/logo.png", size: 18_400),
        ],
        "docs": [entry("docs/testing.md"), entry("docs/deploy.md")],
      ],
      files: [
        "apps/web/src/upload.ts": """
        import { emit } from "./events";

        export type UploadResult = { id: string; bytes: number };

        /** Uploads one file and resolves when the server says it is done. */
        export async function upload(file: File, url: string): Promise<UploadResult> {
          const body = new FormData();
          body.append("file", file);
          const response = await fetch(url, { method: "POST", body });
          if (!response.ok) throw new Error(`Upload failed: ${response.status}`);
          const result = (await response.json()) as UploadResult;
          emit("upload:done", result);
          return result;
        }
        """,
        "README.md": "# Northwind\n\nThe Northwind web app and its API.\n",
      ],
      commitList: [
        commit("4b1d2a9e", "Wait on the upload event in the upload test", "sam-rivera", minutesAgo: 80),
        commit("7c03f1aa", "Add an upload progress event", "sam-rivera", minutesAgo: 190),
        commit("d1e9b442", "Merge main into fix-flaky-upload-test", "sam-rivera", minutesAgo: 60 * 26),
        commit("a88c0d17", "Log the upload test's timing", "northwind-bot", minutesAgo: 60 * 50),
      ]
    )

    static let unpushed = GitHubContentsPreviewAnswers(error: nil, folders: [:], files: [:], commitList: [])

    static let noAccess = GitHubContentsPreviewAnswers(
      error: GitHubDirectError(kind: .appNotInstalled, owner: "sam-rivera", name: "northwind"),
      folders: [:], files: [:], commitList: []
    )

    static let ctoCopy = CloudCtoCopy(
      ownerName: "Sam",
      savedAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-3 * 3600)),
      projectNotes: "Northwind ships the web app from main every Thursday. The upload path is the part customers notice first, so its tests must never be flaky.",
      userNotes: "Sam likes short PR descriptions and one change per PR.",
      openWork: "Fix flaky upload test is pushed and waits for review on PR #412. Next: the changelog for Thursday.",
      routines: [
        CloudCtoCopy.Routine(title: "Morning PR sweep", cron: "0 9 * * 1-5", paused: false),
        CloudCtoCopy.Routine(title: "Weekly dependency check", cron: "0 8 * * 1", paused: true),
      ],
      tail: "Sam: Push it and open a PR.\n\nAtlas: Pushed fix-flaky-upload-test and opened PR #412. The test now waits on the upload's done event instead of a fixed sleep; 50 runs passed.",
      tailTruncated: true,
      storySummary: nil
    )

    static let signIns: CloudAccountSignIns = CloudNoComputerFixtureData.decode(#"""
    {"signIns":[
      {"id":"claude","label":"Claude","providers":["claude"],"method":"claude-token","keyName":"Claude pass","keyUrl":null,"saved":true,"savedAt":null},
      {"id":"qwen","label":"Qwen Code","providers":["qwen"],"method":"key","keyName":"DashScope API key","keyUrl":"https://bailian.console.alibabacloud.com/?apiKey=1","saved":false,"savedAt":null}
    ],"claudePasses":1,"unknown":false,"carried":{"antigravity":true}}
    """#)

    /// Two open chats, one with a subagent under it (it moves with its parent).
    static let laneChats: [AgentChatSessionSummary] = ["chat-a", "chat-b", "chat-sub"].compactMap { id in
      let parent = id == "chat-sub" ? #","orchestrationParentSessionId":"chat-a","spawnKind":"subagent""# : ""
      let title = ["chat-a": "Fix the flaky upload test", "chat-b": "Update the changelog", "chat-sub": "Find every fixed sleep"][id] ?? id
      let json = #"{"sessionId":"\#(id)","laneId":"lane-upload","provider":"claude","model":"claude-sonnet-4-5","status":"idle","startedAt":"2026-11-17T08:00:00Z","lastActivityAt":"2026-11-17T08:30:00Z","title":"\#(title)","surface":"work"\#(parent)}"#
      return try? JSONDecoder().decode(AgentChatSessionSummary.self, from: Foundation.Data(json.utf8))
    }

    static let moveOptions = AgentChatCrossMachineHandoffOptions(
      machines: [
        AgentChatCrossMachineHandoffMachineOption(machineKey: "studio", name: "Mac Studio", online: true, unavailableReason: nil, hasRepository: true),
        AgentChatCrossMachineHandoffMachineOption(machineKey: "air", name: "MacBook Air", online: true, unavailableReason: nil, hasRepository: false),
        AgentChatCrossMachineHandoffMachineOption(machineKey: "mini", name: "Mac mini", online: false, unavailableReason: nil, hasRepository: true),
      ],
      blockers: [
        AgentChatCrossMachineHandoffBlocker(id: "dirty", title: "Uncommitted changes", detail: "3 files are not committed.", clearedByIncludeChanges: true, fixHint: nil),
      ],
      changes: AgentChatCrossMachineHandoffChanges(unpushedCommits: 2, changedFiles: 3)
    )

    private static func entry(_ path: String, folder: Bool = false, size: Int = 2_400) -> GitHubDirectContentEntry {
      GitHubDirectContentEntry(name: (path as NSString).lastPathComponent, path: path, type: folder ? "dir" : "file", size: folder ? 0 : size)
    }

    private static func commit(_ sha: String, _ title: String, _ author: String, minutesAgo: Double) -> GitHubDirectCommit {
      GitHubDirectCommit(sha: sha + "00000000000000000000000000000000", title: title, author: author, date: Date().addingTimeInterval(-minutesAgo * 60), htmlUrl: nil)
    }
  }
}

/// Work with no computer awake: the saved chats (one with a subagent under
/// it) and the read-only CLI and shell copies. The rows are stand-ins; a tap
/// on a copy opens the real copy screen.
private struct CloudWorkFixture: View {
  @State private var opened: CloudSessionRow?

  var body: some View {
    NavigationStack {
      List {
        Section {
          CloudLaneStateLinesContent(state: .asleep, deletingDays: nil)
            .listRowInsets(EdgeInsets())
            .listRowBackground(Color.clear)
        }
        Section("Fix flaky upload test") {
          row(symbol: "bubble.left.and.text.bubble.right", title: "Fix the flaky upload test", detail: "Claude, 40 min ago")
          row(symbol: "arrow.turn.down.right", title: "Find every fixed sleep in the tests", detail: "Subagent, 52 min ago")
            .padding(.leading, 22)
          Button { opened = CloudAtRestPreviews.Data.cliCopy } label: {
            row(symbol: "terminal", title: CloudAtRestPreviews.Data.cliCopy.title ?? "CLI", detail: "Saved copy, 40 min ago")
          }
          .buttonStyle(.plain)
          Button { opened = CloudAtRestPreviews.Data.shellCopy } label: {
            row(symbol: "chevron.left.forwardslash.chevron.right", title: "Shell", detail: "Saved copy, 55 min ago")
          }
          .buttonStyle(.plain)
        }
      }
      .navigationTitle("Work")
      .navigationBarTitleDisplayMode(.inline)
    }
    .sheet(item: $opened) { row in
      CloudSessionCopyScreen(
        row: row,
        fleetKey: nil,
        fixtureCopy: row.isShell
          ? CloudSessionCopy(session: row, format: "text", text: "$ ls\nREADME.md  apps  docs  package.json\n$ git status --short\n M apps/web/src/upload.ts\n?? apps/web/src/uploadEvents.ts\n$")
          : CloudAtRestPreviews.Data.cliCopyText
      )
    }
  }

  private func row(symbol: String, title: String, detail: String) -> some View {
    HStack(spacing: 12) {
      Image(systemName: symbol)
        .foregroundStyle(ADEColor.textMuted)
        .frame(width: 22)
      VStack(alignment: .leading, spacing: 2) {
        Text(title).foregroundStyle(ADEColor.textPrimary).lineLimit(1)
        Text(detail).font(.caption).foregroundStyle(ADEColor.textSecondary)
      }
      Spacer(minLength: 0)
    }
    .contentShape(Rectangle())
  }
}

/// The data of the "Move this lane to" fixtures. Nothing here reaches a brain.
@MainActor
private enum LaneMoveData {
  static let route = LaneMoveRoute(machineKey: "fleet-macbook-pro", projectId: "project-northwind", rootPath: "/Users/sam/northwind")

  static let ownSource = LaneMoveSource(
    kind: .own,
    laneId: "lane-upload",
    laneName: "Fix flaky upload test",
    machineName: "MacBook Pro",
    viaSessionId: "chat-a",
    fleetKey: "fleet-macbook-pro",
    computer: nil,
    sessions: [],
    chats: CloudAtRestPreviews.Data.laneChats
  )

  static let cloudSource = LaneMoveSource(
    kind: .cloud,
    laneId: "lane-upload",
    laneName: "Fix flaky upload test",
    machineName: ADECloudMachine.name,
    viaSessionId: "chat-a",
    fleetKey: "cloud-fixture",
    computer: LaneMoveCloudComputer(instanceId: "inst-fixture", accountMachineKey: CloudAtRestPreviews.Data.machineKey, laneId: "lane-upload"),
    sessions: [],
    chats: CloudAtRestPreviews.Data.laneChats
  )

  static let asleepSource = LaneMoveSource(
    kind: .cloudAsleep,
    laneId: "lane-upload",
    laneName: "Fix flaky upload test",
    machineName: ADECloudMachine.name,
    viaSessionId: "chat-a",
    fleetKey: "cloud-fixture",
    computer: LaneMoveCloudComputer(instanceId: "inst-fixture", accountMachineKey: CloudAtRestPreviews.Data.machineKey, laneId: "lane-upload")
  )

  static let keptSource = LaneMoveSource(
    kind: .cloudGone,
    laneId: "lane-upload",
    laneName: "Fix flaky upload test",
    machineName: ADECloudMachine.name,
    viaSessionId: nil,
    fleetKey: nil,
    computer: nil
  )

  /// Two chats with full history, one that arrives as a summary, and two CLIs.
  static let items: [LaneMoveItem] = [
    LaneMoveItem(id: "chat-a", title: "Fix the flaky upload test", kind: .chat, provider: "claude", history: .full),
    LaneMoveItem(id: "chat-sub", title: "Find every fixed sleep", kind: .chat, provider: "claude", history: .full),
    LaneMoveItem(id: "chat-b", title: "Update the changelog", kind: .chat, provider: "kimi", history: .summary),
    LaneMoveItem(id: "cli-a", title: "Run the upload tests 50 times", kind: .cli, provider: "codex", history: .full),
    LaneMoveItem(id: "cli-b", title: "Check the docs links", kind: .cli, provider: "qwen", history: .summary),
  ]

  static let studio = LaneMoveTarget(id: "studio", machineKey: "studio", name: "Mac Studio", ready: true, reason: nil, hasRepository: true, route: nil)
  static let air = LaneMoveTarget(id: "air", machineKey: "air", name: "MacBook Air", ready: true, reason: nil, hasRepository: false, route: nil)

  static let restoreTargets: [LaneMoveTarget] = [
    LaneMoveTarget(id: "fleet-studio", machineKey: "fleet-studio", name: "Mac Studio", ready: true, reason: nil, hasRepository: true,
                   route: LaneMoveRoute(machineKey: "fleet-studio", projectId: "project-northwind", rootPath: nil)),
    LaneMoveTarget(id: "fleet-mini", machineKey: "fleet-mini", name: "Mac mini", ready: false, reason: "Mac mini is not on.", hasRepository: true,
                   route: LaneMoveRoute(machineKey: "fleet-mini", projectId: "project-northwind", rootPath: nil)),
  ]

  static let preview = CloudKeptLaneRestorePreview(
    laneId: "lane-upload",
    laneName: "Fix flaky upload test",
    branchRef: "fix-flaky-upload-test",
    hasRepository: true,
    work: CloudKeptLaneRestorePreview.Work(unpushedCommits: 2, changedFiles: 3, bytes: 48_000),
    chats: [
      CloudKeptLaneRestorePreview.Chat(chatId: "chat-a", title: "Fix the flaky upload test", provider: "claude", kind: "chat", history: .full),
      CloudKeptLaneRestorePreview.Chat(chatId: "chat-b", title: "Update the changelog", provider: "kimi", kind: "chat", history: .transcript),
      CloudKeptLaneRestorePreview.Chat(chatId: "cli-b", title: "Check the docs links", provider: "qwen", kind: "cli", history: .fresh),
    ]
  )

  /// The asleep computer's saved copy: complete, or not (the move then wakes it).
  static func asleepPreview(saved: Bool) -> CloudKeptLaneRestorePreview {
    CloudKeptLaneRestorePreview(
      laneId: preview.laneId,
      laneName: preview.laneName,
      branchRef: preview.branchRef,
      hasRepository: true,
      work: preview.work,
      chats: preview.chats,
      fromComputer: CloudKeptLaneRestorePreview.FromComputer(
        saved: saved,
        reason: saved ? nil : "ADE couldn't save this lane's work when the computer went to sleep.",
        ignored: LaneMoveIgnoredFiles(paths: [".env", ".env.local", "tmp/upload-cache.db"], more: 2, rebuildable: 1, incomplete: nil)
      )
    )
  }

  /// A move off the asleep computer onto the Mac Studio: deleting it first, or refused.
  static func asleepRun(wakeInstead: Bool) -> LaneMoveRun {
    let reason = "The computer woke, so its saved copy may not be current."
    return LaneMoveRun(
      id: "restore-fixture",
      kind: .restore,
      laneId: "lane-upload",
      laneName: "Fix flaky upload test",
      targetName: "Mac Studio",
      route: restoreTargets[0].route ?? route,
      computer: nil,
      phase: wakeInstead ? .failed : .moving,
      error: wakeInstead ? reason : nil,
      startedAt: Date().addingTimeInterval(-6),
      fromComputer: "inst-fixture",
      restore: CloudKeptLaneRestoreRecord(
        restoreId: "restore-fixture",
        laneId: "lane-upload",
        laneName: "Fix flaky upload test",
        state: wakeInstead ? "failed" : "running",
        localLaneId: nil,
        step: "release",
        chats: preview.chats.map {
          CloudKeptLaneRestoreRecord.Chat(chatId: $0.chatId, title: $0.title, state: "pending", history: $0.history, error: nil)
        },
        error: wakeInstead ? reason : nil,
        wakeInstead: wakeInstead
      )
    )
  }

  /// A move off ADE Cloud onto the Mac Studio, in one of its phases.
  static func run(_ phase: LaneMoveRun.Phase) -> LaneMoveRun {
    let ended = phase != .moving
    let failedChat = phase == .failed
    let batch = LaneMoveBatchRecord(
      batchId: "batch-fixture",
      state: phase == .moving ? "running" : (failedChat ? "partial" : "completed"),
      machineKey: "studio",
      machineName: "Mac Studio",
      items: [
        LaneMoveBatchItem(id: "lane-item", kind: "lane", state: "continued", destinationLaneId: "lane-studio"),
        LaneMoveBatchItem(id: "item-a", kind: "chat", state: "continued", sourceSessionId: "chat-a", destinationSessionId: "dest-a"),
        LaneMoveBatchItem(id: "item-sub", kind: "chat", state: ended ? "continued" : "sending", sourceSessionId: "chat-sub",
                          destinationSessionId: ended ? "dest-sub" : nil),
        LaneMoveBatchItem(id: "item-b", kind: "chat", state: failedChat ? "failed" : (ended ? "continued" : "pending"),
                          sourceSessionId: "chat-b", destinationSessionId: ended && !failedChat ? "dest-b" : nil,
                          error: failedChat ? "Mac Studio couldn't start a Kimi chat: Kimi isn't signed in there." : nil),
      ]
    )
    return LaneMoveRun(
      id: "batch-fixture",
      kind: .live,
      laneId: "lane-upload",
      laneName: "Fix flaky upload test",
      targetName: "Mac Studio",
      route: route,
      computer: cloudSource.computer,
      phase: phase,
      error: phase == .deleteFailed ? "ADE Cloud took the delete but the computer is still there. Check again in a minute; if it stays, delete it again." : nil,
      startedAt: Date().addingTimeInterval(-40),
      arrived: phase == .done || phase == .deleteFailed,
      batch: batch
    )
  }
}

/// "Move this lane to": the machine list, with fixed places and no send.
private struct LaneMoveMenuFixture: View {
  let source: LaneMoveSource
  let fixture: LaneMoveFixture

  var body: some View {
    ADEColor.pageBackground.ignoresSafeArea()
      .onAppear {
        LaneMoveFixtureFlag.active = true
        LaneMoveRuns.shared.seedPreview([])
      }
      .sheet(isPresented: .constant(true)) {
        LaneMoveSheet(source: source, fixture: fixture)
      }
  }
}

/// The review step, opened on one machine. Move sends nothing.
private struct LaneMoveReviewFixture: View {
  let source: LaneMoveSource
  let target: LaneMoveTarget
  let items: [LaneMoveItem]
  var preview: CloudKeptLaneRestorePreview? = nil

  var body: some View {
    ADEColor.pageBackground.ignoresSafeArea()
      .onAppear {
        LaneMoveFixtureFlag.active = true
        LaneMoveRuns.shared.seedPreview([])
      }
      .sheet(isPresented: .constant(true)) {
        NavigationStack {
          LaneMoveReviewView(
            source: source,
            target: target,
            route: target.route ?? LaneMoveData.route,
            items: items,
            changes: AgentChatCrossMachineHandoffChanges(unpushedCommits: 2, changedFiles: 3),
            initialRunId: nil,
            close: {},
            wake: source.kind == .cloudAsleep ? {} : nil,
            fixturePreview: preview
          )
        }
      }
  }
}

/// The same screen following a move: moving, arrived, failed, or arrived
/// with the ADE Cloud computer still there.
private struct LaneMoveProgressFixture: View {
  let run: LaneMoveRun
  var source: LaneMoveSource = LaneMoveData.cloudSource

  var body: some View {
    ADEColor.pageBackground.ignoresSafeArea()
      .sheet(isPresented: .constant(true)) {
        NavigationStack {
          LaneMoveReviewView(
            source: source,
            target: LaneMoveData.studio,
            route: LaneMoveData.route,
            items: LaneMoveData.items,
            changes: nil,
            initialRunId: run.id,
            close: {},
            wake: source.kind == .cloudAsleep ? {} : nil
          )
        }
      }
      .onAppear {
        LaneMoveFixtureFlag.active = true
        LaneMoveRuns.shared.seedPreview([run])
      }
  }
}

/// The prompt box's machine label: a control when the lane can move, a quiet label when not.
private struct LaneMoveTagFixture: View {
  @State private var opened: LaneMoveSource?

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      HStack(spacing: 8) {
        Text("Sonnet 4.5").font(.system(size: 12, weight: .medium)).foregroundStyle(ADEColor.textSecondary)
        WorkComposerMachineTag(name: "MacBook Pro") { opened = LaneMoveData.ownSource }
      }
      HStack(spacing: 8) {
        Text("Sonnet 4.5").font(.system(size: 12, weight: .medium)).foregroundStyle(ADEColor.textSecondary)
        WorkComposerMachineTag(name: "Mac Studio")
      }
    }
    .padding(20)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .background(ADEColor.pageBackground.ignoresSafeArea())
    .onAppear {
      LaneMoveFixtureFlag.active = true
      LaneMoveRuns.shared.seedPreview([])
    }
    .sheet(item: $opened) { source in
      LaneMoveSheet(source: source, fixture: LaneMoveFixture(options: CloudAtRestPreviews.Data.moveOptions, items: LaneMoveData.items))
    }
  }
}

/// "Move to…" on a lane whose ADE Cloud computer sleeps or was deleted.
private struct CloudLaneMoveFixture: View {
  let deleted: Bool

  var body: some View {
    ADEColor.pageBackground.ignoresSafeArea()
      .sheet(isPresented: .constant(true)) {
        CloudLaneRestingMoveSheet(
          laneId: "lane-upload",
          laneName: "Fix flaky upload test",
          fleetKey: deleted ? ADECloudMachine.savedFleetKeyPrefix + "mk_cloud_fixture" : "cloud-fixture",
          deleted: deleted,
          onAwake: {}
        )
      }
  }
}

private struct CloudMoveFixture: View {
  let deleted: Bool

  var body: some View {
    ADEColor.pageBackground.ignoresSafeArea()
      .sheet(isPresented: .constant(true)) {
        WorkCloudRestingMoveSheet(
          target: WorkCloudRestingMoveTarget(sessionId: "chat-1", title: "Fix the flaky upload test", fleetKey: "cloud-fixture", deleted: deleted),
          onAwake: {},
          onOpenChat: {}
        )
      }
  }
}

/// The CTO whose home sleeps on ADE Cloud, with the account copy under it.
private struct CloudCtoCopyFixture: View {
  @StateObject private var model = CtoAccountCopyModel()

  var body: some View {
    NavigationStack {
      CtoStateCard(
        look: CtoPreviewData.look,
        name: "Atlas",
        state: .asleep,
        line: "Asleep on ADE Cloud",
        message: "Its notes and recent chat come along. Tap Reconnect to wake it, or pick another home.",
        actionTitle: "Reconnect",
        action: {},
        secondaryActionTitle: "Pick another home",
        secondaryAction: {}
      )
      .safeAreaInset(edge: .bottom, spacing: 0) {
        CtoAccountCopyEntry(name: "Atlas", model: model)
      }
      .background(ADEColor.pageBackground.ignoresSafeArea())
      .navigationTitle("CTO")
      .navigationBarTitleDisplayMode(.inline)
    }
    .onAppear { model.seedPreview(CloudAtRestPreviews.Data.ctoCopy) }
  }
}

/// An account project with no computer: its tabs read what the account
/// keeps. The tab bar is a stand-in; each tab's content is the real view.
private struct CloudAccountTabsFixture: View {
  var body: some View {
    TabView {
      NavigationStack { CloudLaneAtRestScreen(subject: CloudAtRestPreviews.Data.subject, onAwake: {}) }
        .tabItem { Label("Lanes", systemImage: "square.stack.3d.up") }
      CloudLaneFilesSheet(
        repo: CloudAtRestPreviews.Data.repo,
        branch: CloudAtRestPreviews.Data.branch,
        summary: CloudAtRestPreviews.Data.summary,
        fleetKey: "cloud-fixture",
        onAwake: {}
      )
      .tabItem { Label("Files", systemImage: "folder") }
      CloudCtoCopyFixture()
        .tabItem { Label("CTO", systemImage: "sparkles") }
    }
  }
}

/// Settings › ADE Cloud's sign-ins read straight from the account: a Qwen
/// key to add, and an Antigravity sign-in carried from ADE desktop.
private struct CloudSettingsDirectFixture: View {
  var body: some View {
    NavigationStack {
      ScrollView {
        SettingsCloudAccountProviders(
          syncService: SyncService.shared ?? SyncService(),
          fixtureSignIns: CloudAtRestPreviews.Data.signIns
        )
        .padding(.vertical, 12)
      }
      .background(ADEColor.pageBackground.ignoresSafeArea())
      .navigationTitle("ADE Cloud")
      .navigationBarTitleDisplayMode(.inline)
    }
  }
}
#endif
