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
