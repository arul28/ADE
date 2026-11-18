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
    case "duo-cloud-chat-queued":
      return AnyView(CloudChatFixture(state: .waking, queued: [
        CloudChatQueuedMessage(messageId: "m1", state: "queued", text: "Run the tests again and fix what fails."),
      ]))
    case "duo-cloud-chat-sign-in":
      return AnyView(CloudChatFixture(state: .waking, queued: [
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
      return AnyView(CloudChatFixture(state: .refused("This account has no ADE Cloud hours left this period. Your lanes and chats stay readable.")))
    case "duo-cloud-refused-too_many_awake":
      return AnyView(CloudChatFixture(state: .refused("Too many of your computers are awake at once. Put one you aren't using to sleep, then try again.")))
    case "duo-cloud-refused-account_blocked":
      return AnyView(CloudChatFixture(state: .refused("ADE Cloud is turned off for this account. Contact ADE support if you think this is a mistake.")))
    case "duo-cloud-new-chat":
      return AnyView(CloudNewChatFixture(refusal: nil, launch: nil))
    case "duo-cloud-new-chat-setup":
      return AnyView(CloudNewChatFixture(refusal: nil, launch: "waiting"))
    case "duo-cloud-new-chat-refused":
      return AnyView(CloudNewChatFixture(refusal: "This account has no ADE Cloud hours left this period. Your lanes and chats stay readable.", launch: nil))
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

  static func launch(_ state: String) -> AccountCloudLaunchStore.Entry {
    let stages = #"[{"id":"computer","status":"done"},{"id":"join","status":"done"},{"id":"clone","status":"done"}]"#
    let record = #"{"launchId":"l_wait","state":"waiting_for_sign_in","projectOrigin":"github.com/octocat/hello-world","laneName":"Fix the README typo","instanceId":"i_wait","stages":\#(stages),"signIn":{"provider":"claude","label":"Claude","kind":"url_paste","jobId":"j1","url":"https://claude.ai/oauth/authorize","needsPastedCode":true,"reason":"Open the sign-in page, approve, then paste the code it shows."},"request":{"chat":{"provider":"claude","modelId":"anthropic/claude-sonnet-4-5","prompt":"Fix the README typo"}}}"#
    return AccountCloudLaunchStore.Entry(
      launchId: state,
      origin: "github.com/octocat/hello-world",
      prompt: "Fix the README typo",
      provider: "claude",
      modelId: "anthropic/claude-sonnet-4-5",
      record: decode(record),
      startError: nil,
      body: nil
    )
  }
}

/// A cloud lane's chat: the state lines at the top, stand-in transcript rows,
/// the messages ADE Cloud holds, and a stand-in composer.
private struct CloudChatFixture: View {
  let state: CloudLaneState
  var deletingDays: Int?
  var queued: [CloudChatQueuedMessage] = []

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
        CloudLaneStateLinesContent(state: state, deletingDays: deletingDays)
      }
      .safeAreaInset(edge: .bottom, spacing: 0) {
        VStack(spacing: 0) {
          CloudQueuedMessagesView(accountMachineKey: "mk-cloud", chatId: "chat-1")
          composer
        }
      }
      .navigationTitle("Fix flaky upload test")
      .navigationBarTitleDisplayMode(.inline)
      .background(ADEColor.pageBackground.ignoresSafeArea())
    }
    .task {
      AccountCloudStore.shared.seedPreview(
        access: nil,
        account: nil,
        queued: queued.isEmpty ? [:] : [AccountCloudStore.chatKey(machineKey: "mk-cloud", chatId: "chat-1"): queued]
      )
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
/// the person's own), its footnote, and the setup card of a started chat.
private struct CloudNewChatFixture: View {
  let refusal: String?
  let launch: String?

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
          if let launch {
            WorkCloudLaunchCard(entry: CloudNoComputerFixtureData.launch(launch))
              .padding(.horizontal, 12)
          }
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
        entries: launch.map { [CloudNoComputerFixtureData.launch($0)] } ?? []
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
#endif
