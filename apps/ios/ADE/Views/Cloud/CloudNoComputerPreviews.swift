import SwiftUI

#if DEBUG
/// Fixture screens for ADE with no computer, selected like the other Duo
/// fixtures:
///
///     xcrun simctl launch <udid> com.ade.ios -adePreviewScreen duo-cloud-chat-asleep
///
/// Each one draws the real views of the cloud flow (state lines, held
/// messages, setup card, machine menu, model list) from in-process data. The
/// transcript rows and the composer are stand-ins: a fixture has no chat
/// engine and no account server.
enum CloudNoComputerPreviews {
  @MainActor
  static func view(_ name: String) -> AnyView? {
    switch name {
    case "duo-cloud-chat-asleep":
      return AnyView(CloudChatFixture(state: .asleep))
    case "duo-cloud-chat-waking":
      return AnyView(CloudChatFixture(state: .waking))
    case "duo-cloud-chat-deleted":
      return AnyView(CloudChatFixture(state: .deleted))
    case "duo-cloud-chat-deleted-kept":
      // A kept lane: what happened, its branch and the queue's size.
      return AnyView(CloudChatFixture(state: .deleted, deleted: CloudDeletedComputerFacts(
        fate: cloudComputerFateSentence(.idle, deletedAt: 1_763_424_000_000),
        branch: "fix-flaky-upload-test",
        sizeLabel: cloudQueueSizeLabel(account: nil)
      )))
    case "duo-cloud-chat-deleted-picked":
      // A kept lane whose next computer the person sized Large in the line's menu.
      return AnyView(CloudChatFixture(state: .deleted, deleted: CloudDeletedComputerFacts(
        fate: cloudComputerFateSentence(.idle, deletedAt: 1_763_424_000_000),
        branch: "fix-flaky-upload-test",
        sizeLabel: cloudQueueSizeLabel(account: nil)
      ), pickedSize: "large"))
    case "duo-cloud-chat-deleted-blocked":
      return AnyView(CloudChatFixture(state: .deleted, deleted: CloudDeletedComputerFacts(
        fate: cloudComputerFateSentence(.plan, deletedAt: 1_763_424_000_000),
        branch: "fix-flaky-upload-test",
        sizeLabel: cloudQueueSizeLabel(account: nil),
        blocked: "This account has no ADE Cloud credits left this period. Your lanes and chats stay readable."
      )))
    case "duo-cloud-chat-queued":
      // Right after a send to an asleep chat: the person's own bubble and
      // the working line, as a send to an awake computer looks.
      return AnyView(CloudChatHeldFixture(queued: [
        CloudChatQueuedMessage(messageId: "m1", state: "queued", text: "Run the tests again and fix what fails."),
      ]))
    case "duo-cloud-chat-queued-connecting":
      // The same send while the chat has no cached row yet: the
      // destination's connecting frame draws the held messages.
      return AnyView(CloudChatHeldConnectingFixture(queued: [
        CloudChatQueuedMessage(messageId: "m1", state: "queued", text: "Run the tests again and fix what fails."),
        CloudChatQueuedMessage(
          messageId: "m3",
          state: "failed",
          text: "Now update the changelog.",
          error: "This lane's computer couldn't start. Your message wasn't sent."
        ),
      ]))
    case "duo-cloud-chat-failed":
      return AnyView(CloudChatHeldFixture(queued: [
        CloudChatQueuedMessage(
          messageId: "m3",
          state: "failed",
          text: "Run the tests again and fix what fails.",
          error: "This lane's computer couldn't start. Your message wasn't sent."
        ),
      ]))
    case "duo-cloud-chat-sign-in":
      return AnyView(CloudChatHeldFixture(queued: [
        CloudChatQueuedMessage(
          messageId: "m2",
          state: "waiting_for_sign_in",
          text: "Now update the changelog.",
          signIn: CloudNoComputerFixtureData.decode(#"{"provider":"claude","label":"Claude","kind":"url_paste","jobId":"j1","url":"https://claude.ai/oauth/authorize","needsPastedCode":true,"reason":"Open the sign-in page, approve, then paste the code it shows."}"#)
        ),
      ]))
    case "duo-cloud-deleting-soon":
      return AnyView(CloudChatFixture(state: .asleep, deletingDays: 3))
    case "duo-cloud-refused-out_of_hours":
      // The server's code is still `out_of_hours`; the balance is credits.
      return AnyView(CloudChatFixture(state: .refused("This account has no ADE Cloud credits left this period. Your lanes and chats stay readable.")))
    case "duo-cloud-refused-too_many_awake":
      return AnyView(CloudChatFixture(state: .refused("Too many of your computers are awake at once. Put one you aren't using to sleep, then try again.")))
    case "duo-cloud-refused-account_blocked":
      return AnyView(CloudChatFixture(state: .refused("ADE Cloud is turned off for this account. Contact ADE support if you think this is a mistake.")))
    case "duo-cloud-new-chat":
      return AnyView(CloudNewChatFixture(refusal: nil))
    case "duo-cloud-new-chat-setup", "duo-cloud-launch-page":
      return AnyView(CloudLaunchPageFixture(state: "waiting"))
    case "duo-cloud-launch-page-making":
      return AnyView(CloudLaunchPageFixture(state: "making"))
    case "duo-cloud-launch-rows":
      return AnyView(CloudLaunchRowsFixture())
    case "duo-cloud-lane-launch-card":
      return AnyView(CloudLaneLaunchCardFixture())
    case "duo-cloud-new-chat-refused":
      return AnyView(CloudNewChatFixture(refusal: "This account has no ADE Cloud credits left this period. Your lanes and chats stay readable."))
    case "duo-cloud-models":
      return AnyView(CloudModelsFixture())
    case "duo-cloud-lanes":
      return AnyView(CloudLanesFixture())
    default:
      return nil
    }
  }
}

enum CloudNoComputerFixtureData {
  static func decode<T: Decodable>(_ json: String) -> T {
    try! JSONDecoder().decode(T.self, from: Data(json.utf8))
  }

  static var catalog: CloudModelCatalog {
    decode(#"""
    {"providers":[
      {"provider":"claude","label":"Claude","remoteSignIn":"url_paste","defaultModelId":"anthropic/claude-sonnet-4-5","models":[{"id":"anthropic/claude-haiku-4-5","displayName":"Claude Haiku 4.5"},{"id":"anthropic/claude-sonnet-4-5","displayName":"Claude Sonnet 4.5"}]},
      {"provider":"codex","label":"Codex","remoteSignIn":"device","defaultModelId":"openai/gpt-5.1-codex","models":[{"id":"openai/gpt-5.1-codex","displayName":"GPT-5.1 Codex"}]},
      {"provider":"qwen","label":"Qwen","remoteSignIn":"api_key","defaultModelId":"qwen/qwen3-coder","models":[{"id":"qwen/qwen3-coder","displayName":"Qwen3 Coder"}]},
      {"provider":"antigravity","label":"Antigravity","remoteSignIn":"desktop","defaultModelId":"antigravity/gemini-3-pro","models":[{"id":"antigravity/gemini-3-pro","displayName":"Gemini 3 Pro"}]}
    ]}
    """#)
  }

  /// A launch waiting on the Claude sign-in (`waiting`), making its computer
  /// (`making`), or failed (`failed`).
  static func launch(_ state: String, prompt: String = "Fix the README typo") -> AccountCloudLaunchStore.Entry {
    let stages: String
    let fields: String
    switch state {
    case "making":
      stages = #"[{"id":"computer","status":"running"}]"#
      fields = #""state":"making""#
    case "failed":
      stages = #"[{"id":"computer","status":"done"},{"id":"join","status":"done"},{"id":"clone","status":"failed"}]"#
      fields = #""state":"failed","error":"GitHub refused the clone: the repository is private and the computer has no access.""#
    default:
      stages = #"[{"id":"computer","status":"done"},{"id":"join","status":"done"},{"id":"clone","status":"done"}]"#
      fields = #""state":"waiting_for_sign_in","signIn":{"provider":"claude","label":"Claude","kind":"url_paste","jobId":"j1","url":"https://claude.ai/oauth/authorize","needsPastedCode":true,"reason":"Open the sign-in page, approve, then paste the code it shows."}"#
    }
    let record = #"{"launchId":"l_\#(state)",\#(fields),"projectOrigin":"github.com/octocat/hello-world","laneName":"Fix the README typo","instanceId":"i_\#(state)","stages":\#(stages),"request":{"chat":{"provider":"claude","modelId":"anthropic/claude-sonnet-4-5","prompt":"Fix the README typo"}}}"#
    return AccountCloudLaunchStore.Entry(
      launchId: state,
      origin: "github.com/octocat/hello-world",
      prompt: prompt,
      provider: "claude",
      modelId: "anthropic/claude-sonnet-4-5",
      record: decode(record),
      startError: nil,
      body: nil
    )
  }
}

/// A cloud chat's real thread and composer (Work's fixture transcript) with
/// the messages ADE Cloud holds for it, as `WorkSessionDestinationView`
/// passes them: from the store, with the sign-in step above the composer.
private struct CloudChatHeldFixture: View {
  let queued: [CloudChatQueuedMessage]
  @ObservedObject private var store = AccountCloudStore.shared

  var body: some View {
    NavigationStack {
      chat
        .safeAreaInset(edge: .bottom, spacing: 0) {
          CloudQueueSignInSteps(accountMachineKey: "mk-cloud", chatId: "chat-1")
        }
        .adeScreenBackground()
        .navigationTitle("Fix flaky upload test")
        .navigationBarTitleDisplayMode(.inline)
    }
    .task {
      AccountCloudStore.shared.seedPreview(
        access: nil,
        account: nil,
        queued: [AccountCloudStore.chatKey(machineKey: "mk-cloud", chatId: "chat-1"): queued]
      )
    }
  }

  private var chat: WorkChatSessionView {
    var view = workPreviewChatSessionView()
    let messages = store.threadMessages(machineKey: "mk-cloud", chatId: "chat-1")
    if !messages.isEmpty {
      view.cloudHeld = WorkCloudHeldThread(
        messages: messages,
        onCancel: { _ in nil },
        onPutBack: { _ in },
        onDismiss: { _ in }
      )
    }
    return view
  }
}

/// A cloud chat with no cached row yet: the destination's connecting frame
/// with the messages ADE Cloud holds for it.
private struct CloudChatHeldConnectingFixture: View {
  let queued: [CloudChatQueuedMessage]
  @ObservedObject private var store = AccountCloudStore.shared

  var body: some View {
    let messages = store.threadMessages(machineKey: "mk-cloud", chatId: "chat-1")
    NavigationStack {
      WorkChatConnectingFrame(
        machineName: "ADE Cloud",
        held: messages.isEmpty ? nil : WorkCloudHeldThread(
          messages: messages,
          onCancel: { _ in nil },
          onPutBack: { _ in },
          onDismiss: { _ in }
        ),
        sessionId: "chat-1"
      )
      .navigationTitle("Fix flaky upload test")
      .navigationBarTitleDisplayMode(.inline)
    }
    .task {
      AccountCloudStore.shared.seedPreview(
        access: nil,
        account: nil,
        queued: [AccountCloudStore.chatKey(machineKey: "mk-cloud", chatId: "chat-1"): queued]
      )
    }
  }
}

/// A cloud lane's chat: the state lines at the top, stand-in transcript rows,
/// and a stand-in composer.
private struct CloudChatFixture: View {
  let state: CloudLaneState
  var deletingDays: Int?
  var deleted: CloudDeletedComputerFacts = .unknown
  /// The size picked in the line's menu when the fixture opens.
  var pickedSize: String?
  @ObservedObject private var store = AccountCloudStore.shared

  /// The four sizes, as a signed-in account's catalog lists them.
  private static let tiers: [CloudPhoneTier] = [
    CloudPhoneTier(id: "small", label: "Small", type: "default", cpu: 2, memoryGb: 4, multiplierMilli: 0, diskMaxGb: 12),
    CloudPhoneTier(id: "medium", label: "Medium", type: "default", cpu: 4, memoryGb: 8, multiplierMilli: 1000, diskMaxGb: 20),
    CloudPhoneTier(id: "large", label: "Large", type: "vm", cpu: 4, memoryGb: 8, multiplierMilli: 2500, diskMaxGb: 50),
    CloudPhoneTier(id: "xlarge", label: "X-Large", type: "vm", cpu: 4, memoryGb: 16, multiplierMilli: 4000, diskMaxGb: 100),
  ]

  /// The deleted line's size menu, on the real store, as `CloudLaneStateLines` passes it.
  private var sizePick: CloudNewComputerSizePick? {
    guard state == .deleted else { return nil }
    return CloudNewComputerSizePick(
      tiers: Self.tiers,
      picked: store.newComputerSizes["mk-cloud"],
      pick: { store.pickNewComputerSize(machineKey: "mk-cloud", sizeId: $0) },
      words: CloudBalanceWords(store.account)
    )
  }

  private var shownDeleted: CloudDeletedComputerFacts {
    var facts = deleted
    if let picked = store.newComputerSizes["mk-cloud"], let tier = Self.tiers.first(where: { $0.id == picked }) {
      facts.sizeLabel = tier.label
    }
    return facts
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          bubble("Fix the flaky upload test.", mine: true)
          bubble("The test waited on a fixed sleep. I replaced it with a wait on the upload event and ran it 50 times: no failure.", mine: false)
          bubble("Push it and open a PR.", mine: true)
          bubble("Pushed to fix-flaky-upload-test and opened PR #412.", mine: false)
        }
        .padding(16)
      }
      .safeAreaInset(edge: .top, spacing: 0) {
        CloudLaneStateLinesContent(state: state, deletingDays: deletingDays, deletingSizeLabel: cloudQueueSizeLabel(account: nil), deleted: shownDeleted, sizePick: sizePick)
      }
      .safeAreaInset(edge: .bottom, spacing: 0) {
        composer
      }
      .navigationTitle("Fix flaky upload test")
      .navigationBarTitleDisplayMode(.inline)
      .background(ADEColor.pageBackground.ignoresSafeArea())
    }
    .task {
      AccountCloudStore.shared.seedPreview(access: nil, account: nil)
      AccountCloudStore.shared.pickNewComputerSize(machineKey: "mk-cloud", sizeId: pickedSize)
    }
  }

  private func bubble(_ text: String, mine: Bool) -> some View {
    Text(text)
      .font(.body)
      .foregroundStyle(ADEColor.textPrimary)
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      .background(mine ? ADEColor.accent.opacity(0.14) : Color.clear, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
      .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
  }

  private var composer: some View {
    HStack {
      Text("Message")
        .foregroundStyle(ADEColor.textMuted)
      Spacer()
      Image(systemName: "arrow.up.circle.fill")
        .font(.system(size: 26))
        .foregroundStyle(ADEColor.accent)
    }
    .padding(.horizontal, 14)
    .frame(minHeight: 48)
    .workChatGlass(in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    .padding(.horizontal, 12)
    .padding(.bottom, 8)
  }
}

/// The new-chat screen's machine row with ADE Cloud picked (no computer of
/// the person's own) and its footnote. A started chat opens its own page
/// (`CloudLaunchPageFixture`).
private struct CloudNewChatFixture: View {
  let refusal: String?

  private var options: [WorkNewChatMachineOption] {
    [
      WorkNewChatMachineOption(machineKey: "fleet-mini", name: "Mac mini", symbol: "macmini", isLive: false),
      WorkNewChatMachineOption(machineKey: ADECloudMachine.id, name: ADECloudMachine.name, symbol: ADECloudMachine.symbol, isLive: true, refusal: refusal),
    ]
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        Text("What should ADE Cloud work on?")
          .font(.title3.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .frame(maxWidth: .infinity)
          .padding(.top, 48)
      }
      .safeAreaInset(edge: .bottom, spacing: 0) {
        VStack(spacing: 8) {
          HStack(spacing: 8) {
            WorkNewChatMachineDropdown(options: options, selected: options[1], onSelect: { _ in })
            Text("New lane")
              .font(.subheadline.weight(.medium))
              .padding(.horizontal, 12)
              .frame(minHeight: 34)
              .adeKitPill()
            Spacer(minLength: 0)
          }
          .padding(.horizontal, 10)
          Text(refusal ?? cloudDesktopSignInSentence(label: "Antigravity"))
            .font(.caption)
            .foregroundStyle(refusal != nil ? ADEColor.warning : ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 14)
          HStack {
            Text("Fix the README typo")
              .foregroundStyle(ADEColor.textPrimary)
            Spacer()
            Text("Gemini 3 Pro")
              .font(.caption.weight(.medium))
              .foregroundStyle(ADEColor.textSecondary)
          }
          .padding(.horizontal, 14)
          .frame(minHeight: 52)
          .workChatGlass(in: RoundedRectangle(cornerRadius: 22, style: .continuous))
          .padding(.horizontal, 12)
        }
        .padding(.bottom, 8)
      }
      .navigationTitle("New chat")
      .navigationBarTitleDisplayMode(.inline)
      .background(ADEColor.pageBackground.ignoresSafeArea())
    }
    .task {
      AccountCloudLaunchStore.shared.seedPreview(
        catalog: CloudNoComputerFixtureData.catalog,
        catalogError: nil,
        entries: []
      )
    }
  }
}

/// The models ADE Cloud runs, with a provider that signs in on the desktop.
private struct CloudModelsFixture: View {
  var body: some View {
    ADEColor.pageBackground.ignoresSafeArea()
      .sheet(isPresented: .constant(true)) {
        WorkModelPickerSheet(
          currentModelId: "anthropic/claude-sonnet-4-5",
          currentProvider: "claude",
          isBusy: false,
          cloudCatalog: CloudNoComputerFixtureData.catalog
        ) { _, _, _, _ in }
      }
      .task {
        AccountCloudLaunchStore.shared.seedPreview(catalog: CloudNoComputerFixtureData.catalog, catalogError: nil, entries: [])
      }
  }
}

/// The Lanes tab's machine chips: every cloud lane's computer under one
/// "ADE Cloud" chip, picked.
private struct CloudLanesFixture: View {
  @State private var selected = "cloud"

  var body: some View {
    NavigationStack {
      List {
        Section {
          ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 7) {
              LaneMachineFilterChip(title: "All", symbol: "square.stack.3d.up", liveDot: nil, selected: selected == "all") { selected = "all" }
              LaneMachineFilterChip(title: "Mac mini", symbol: "macmini", liveDot: false, selected: selected == "mini") { selected = "mini" }
              LaneMachineFilterChip(title: ADECloudMachine.name, symbol: ADECloudMachine.symbol, liveDot: true, selected: selected == "cloud") { selected = "cloud" }
            }
          }
        }
        Section {
          ForEach(["Fix flaky upload test", "Update the changelog", "Try the new parser"], id: \.self) { name in
            Text(name).foregroundStyle(ADEColor.textPrimary)
          }
        }
      }
      .navigationTitle("Lanes")
    }
  }
}
/// The page a chat started on ADE Cloud opens: the message as a bubble, then
/// the setup steps, as a chat starting in a new lane of your own shows.
private struct CloudLaunchPageFixture: View {
  let state: String

  var body: some View {
    NavigationStack {
      WorkCloudLaunchPendingScreen(launchId: state, onChatReady: { _ in false })
    }
    .task {
      AccountCloudLaunchStore.shared.seedPreview(
        catalog: CloudNoComputerFixtureData.catalog,
        catalogError: nil,
        entries: [CloudNoComputerFixtureData.launch(state, prompt: "Yo so look at this app, I wanna make a better and free version of photo roulette. Right now the UI is too busy; make the game screen simpler.")]
      )
    }
  }
}

/// A kept lane's "New computer" on Lanes: the same setup card as a chat
/// launch's page, with the lane's steps (one making, one ready).
private struct CloudLaneLaunchCardFixture: View {
  @ObservedObject private var launches = AccountCloudLaunchStore.shared

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: 14) {
          ForEach(launches.entries) { entry in
            WorkCloudLaunchSetupCard(entry: entry)
          }
        }
        .padding(16)
      }
      .adeScreenBackground()
      .navigationTitle("Lanes")
    }
    .task {
      AccountCloudLaunchStore.shared.seedPreview(
        catalog: CloudNoComputerFixtureData.catalog,
        catalogError: nil,
        entries: [Self.lane("making"), Self.lane("running")]
      )
    }
  }

  private static func lane(_ state: String) -> AccountCloudLaunchStore.Entry {
    let stages = state == "making"
      ? #"[{"id":"computer","status":"done"},{"id":"join","status":"done"},{"id":"clone","status":"running"}]"#
      : #"[{"id":"computer","status":"done"},{"id":"join","status":"done"},{"id":"clone","status":"done"}]"#
    let record = #"{"launchId":"lane_\#(state)","kind":"lane","state":"\#(state)","projectOrigin":"github.com/octocat/hello-world","laneName":"Fix flaky upload test","instanceId":"i_lane_\#(state)","stages":\#(stages)}"#
    return AccountCloudLaunchStore.Entry(
      launchId: "lane_\(state)",
      origin: "github.com/octocat/hello-world",
      prompt: "",
      record: CloudNoComputerFixtureData.decode(record),
      kind: "lane",
      laneName: "Fix flaky upload test"
    )
  }
}

/// Work's list with chats starting on ADE Cloud: one launch row each, the
/// same row size as the chats under it.
private struct CloudLaunchRowsFixture: View {
  @ObservedObject private var launches = AccountCloudLaunchStore.shared

  var body: some View {
    NavigationStack {
      List {
        ForEach(launches.entries) { entry in
          WorkCloudLaunchRow(entry: entry, onOpen: {})
            .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
        }
      }
      .listStyle(.plain)
      .scrollContentBackground(.hidden)
      .background(ADEColor.pageBackground.ignoresSafeArea())
      .navigationTitle("Work")
    }
    .task {
      AccountCloudLaunchStore.shared.seedPreview(
        catalog: CloudNoComputerFixtureData.catalog,
        catalogError: nil,
        entries: [
          CloudNoComputerFixtureData.launch("making", prompt: "Make the game screen simpler"),
          CloudNoComputerFixtureData.launch("waiting", prompt: "Yo so look at this app, I wanna make a better and free version of photo roulette."),
          CloudNoComputerFixtureData.launch("failed", prompt: "Add a leaderboard"),
        ]
      )
    }
  }
}
#endif
