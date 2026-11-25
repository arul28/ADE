import SwiftUI

#if DEBUG
/// Fixture screens for screenshots on any device and fold, with no machine:
///
/// - `-adePreviewScreen duo-cloud`: the ADE Cloud page (the dashboard), for
///   an iPhone tester: the credits bar split Computers / iPhone, and the
///   tester provider pick (Debug and Beta builds only);
/// - `duo-cloud-plans`: the same page scrolled to the plans and sizes;
/// - `duo-cloud-upgraded`: the page a moment after a checkout from Free ("You're on Plus");
/// - `duo-cloud-invite`: the invite card (link, Copy, Share, counts, the code box);
/// - `duo-cloud-limits`: what agents may do alone;
/// - `duo-cloud-machine`: one computer (what uses its disk);
/// - `duo-providers-cloud`: Settings › Providers with ADE Cloud as the place;
/// - `duo-provider-signin`: the sign-in sheet at its approve step.
enum CloudPreviews {
  static let names: Set<String> = [
    "duo-cloud", "duo-cloud-plans", "duo-cloud-sizes", "duo-cloud-upgraded", "duo-cloud-invite", "duo-cloud-limits", "duo-cloud-computer-limit", "duo-cloud-machine", "duo-providers-cloud", "duo-provider-signin",
    "duo-cloud-sponsored-consent", "duo-cloud-sponsored-small", "duo-cloud-sponsored-ad", "duo-cloud-sponsored-pick", "duo-cloud-sponsored-settings",
    "duo-cloud-sponsored-ad-below", "duo-cloud-sponsored-ad-above-prompt", "duo-cloud-sponsored-ad-inline",
  ]

  /// The three sponsored formats, each in the real chat screen (transcript,
  /// turn-end line, prompt box) over the same fixture turn and ad.
  private static let sponsoredFormatScreens: [String: CloudSponsoredFormat] = [
    "duo-cloud-sponsored-ad-below": .belowReply,
    "duo-cloud-sponsored-ad-above-prompt": .abovePrompt,
    "duo-cloud-sponsored-ad-inline": .inline,
  ]

  @MainActor static func view(_ name: String) -> AnyView? {
    guard names.contains(name) else { return nil }
    let sync = SyncService.shared ?? SyncService()
    switch name {
    case "duo-providers-cloud":
      guard let status = signInsFixture() else { return nil }
      return AnyView(ProvidersCloudFixture(syncService: sync, status: status))
    case "duo-provider-signin":
      let controller = WorkProviderSignInController(
        fixtureProvider: "codex",
        phase: .waiting,
        url: "https://auth.openai.com/codex/device",
        deviceCode: "WXYZ-1234"
      )
      return AnyView(ProviderSignInSheet(fixture: controller, machineName: "Mac Studio", expected: "arul@example.com"))
    default:
      break
    }
    guard let list = try? JSONDecoder().decode(CloudPhoneList.self, from: Data(listJSON().utf8)) else { return nil }
    let limits = CloudPhoneLimits(unattendedSpend: true, machinesPerDay: 3, maxShape: "4x16", preset: "balanced", extraDiskMonthCents: nil)
    // `duo-cloud-upgraded`: this phone last saw the account on Free, a period ago, with 79.1 hours left.
    // Only the fixture account's entry changes: every other account's record on this device stays.
    if name == "duo-cloud-upgraded", let code = list.account?.referral?.code {
      var all = UserDefaults.standard.dictionary(forKey: CloudPlanSeenStore.defaultsKey) ?? [:]
      all[code] = ["planId": "free", "periodStart": 1_790_812_800_000.0, "leftMilli": 79_100]
      UserDefaults.standard.set(all, forKey: CloudPlanSeenStore.defaultsKey)
    }
    let store = CloudPaneStore(syncService: sync, fixtureList: list, limits: limits, signIns: signInsFixture(), now: fixtureNow)
    if name.hasPrefix("duo-cloud-sponsored-") {
      // A Free account the switch reaches: the question unanswered, or answered yes.
      // `duo-cloud-sponsored-small`: unanswered while the server's `smallNeedsCards` rule is on.
      var account = list.account
      let unanswered = name == "duo-cloud-sponsored-consent" || name == "duo-cloud-sponsored-small"
      let format = sponsoredFormatScreens[name]
      account?.sponsored = CloudSponsoredState(
        ads: true,
        consent: unanswered ? nil : CloudSponsoredState.granted,
        test: true,
        smallNeedsCards: name == "duo-cloud-sponsored-small" ? true : nil,
        format: format ?? .belowReply
      )
      AccountCloudStore.shared.seedPreview(access: nil, account: account)
      if format != nil { return AnyView(CloudSponsoredFormatChatFixture()) }
      if name == "duo-cloud-sponsored-settings" {
        return AnyView(NavigationStack {
          ScrollView { CloudSponsoredCard(pageAccount: account).padding(16) }
            .background(ADEColor.pageBackground.ignoresSafeArea())
            .navigationTitle("ADE Cloud")
            .navigationBarTitleDisplayMode(.inline)
        })
      }
      return AnyView(CloudSponsoredChatFixture(kind: name))
    }
    switch name {
    case "duo-cloud-limits":
      return AnyView(NavigationStack { CloudLimitsScreen(store: store) })
    case "duo-cloud-computer-limit":
      // A new lane refused at Plus's 3 computers (sample data, as a refusal sends it).
      return AnyView(CloudComputerLimitSheet(limit: CloudComputerLimit(
        message: CloudComputerLimit.headline(limit: 3),
        planId: "plus",
        limit: 3,
        total: 3,
        lanes: [
          .init(instanceId: "q1w2e3r4t5", laneName: "supabase-stack", awake: false, lastAwakeAt: nowMs - 21 * 86_400_000, hasLane: false),
          .init(instanceId: "k2p8a1b2c3", laneName: "android-emulator-suite", awake: false, lastAwakeAt: nowMs - 3 * 3_600_000),
          .init(instanceId: "zodqsue74s", laneName: "fix-login-redirect", awake: true, lastAwakeAt: nowMs - 0.2 * 3_600_000),
        ],
        nextPlan: .init(planId: "pro", computerLimit: 10)
      )))
    case "duo-cloud-machine":
      return AnyView(NavigationStack { CloudMachineScreen(store: store, instanceId: "k2p8a1b2c3") })
    case "duo-cloud-invite":
      return AnyView(NavigationStack {
        ScrollView {
          if let referral = store.account?.referral {
            CloudInviteCard(referral: referral, syncService: sync, words: CloudBalanceWords(store.account), onChanged: {}).padding(16)
          }
        }
        .background(ADEColor.pageBackground.ignoresSafeArea())
        .navigationTitle("ADE Cloud")
        .navigationBarTitleDisplayMode(.inline)
      })
    case "duo-cloud-plans":
      return AnyView(NavigationStack {
        ScrollView {
          VStack(spacing: 16) {
            if let account = store.account {
              CloudPlansCard(account: account, tiers: store.tiers)
              CloudSizesCard(account: account, tiers: store.tiers)
            }
          }
          .padding(16)
        }
        .background(ADEColor.pageBackground.ignoresSafeArea())
        .navigationTitle("ADE Cloud")
        .navigationBarTitleDisplayMode(.inline)
      })
    case "duo-cloud-sizes":
      return AnyView(NavigationStack {
        ScrollView {
          if let account = store.account {
            CloudSizesCard(account: account, tiers: store.tiers).padding(16)
          }
        }
        .background(ADEColor.pageBackground.ignoresSafeArea())
        .navigationTitle("ADE Cloud")
        .navigationBarTitleDisplayMode(.inline)
      })
    default:
      return AnyView(CloudPaneSheet(store: store))
    }
  }

  /// Nov 11 2026, 15:00 UTC.
  static let fixtureNow = Date(timeIntervalSince1970: 1_794_409_200)

  private static var nowMs: Double { fixtureNow.timeIntervalSince1970 * 1000 }

  /// The fixture's computers and account: the ADE Cloud iPhone on, 15 of
  /// its 117.5 used credits spent on the iPhone, and the account on the
  /// iPhone's tester list.
  private static func listJSON() -> String {
    let hour = 3_600_000.0
    let day = 86_400_000.0
    let phone = #"{"access":"on","creditsUsedMilli":15000,"providerChoice":"auto"},"credits":{"phoneMilliPerMinute":1000}"#
    return """
    {"state":"ok","runningCount":1,"machines":[
      {"instanceId":"zodqsue74s","name":"ADE Cloud computer","machineKey":"mk1","state":"running","type":"box",
       "resources":{"cpu":2,"memoryGb":4,"diskGb":6.2},"shapeId":"2x4","hoursRate":1,"sleep":{"state":"auto"},"pastDue":false,
       "lane":{"laneId":"l1","laneName":"fix-login-redirect","projectOrigin":"github.com/arul/ade"},
       "lastActiveAtMs":\(nowMs - 0.2 * hour),"createdAtMs":\(nowMs - 3 * day)},
      {"instanceId":"k2p8a1b2c3","name":"ADE Cloud computer","machineKey":"mk2","state":"asleep","type":"vm",
       "resources":{"cpu":4,"memoryGb":8,"diskGb":18.4},"shapeId":"4x8","hoursRate":5,"sleep":{"state":"auto"},"pastDue":false,
       "lane":{"laneId":"l2","laneName":"android-emulator-suite","projectOrigin":"github.com/arul/ade"},
       "lastActiveAtMs":\(nowMs - 3 * hour),"createdAtMs":\(nowMs - 6 * day),
       "diskUsage":{"totalGb":14.1,"measuredAt":\(nowMs - 4 * hour),"items":[
         {"kind":"repo","label":"Repository and lanes","gb":5.2},
         {"kind":"deps","label":"Dependencies","gb":3.9},
         {"kind":"android","label":"Android emulator","gb":3.1},
         {"kind":"cache","label":"Package and build caches","gb":1.9,"clearable":true}]},
       "laneWork":{"unpushed":false,"prState":"open"}},
      {"instanceId":"a9x7c6v5b4","name":"ADE Cloud computer","machineKey":"mk3","state":"asleep","type":"box",
       "resources":{"cpu":4,"memoryGb":8,"diskGb":9.0},"shapeId":"4x8","hoursRate":2,"sleep":{"state":"auto"},"pastDue":false,
       "lane":{"laneId":"l3","laneName":"perf-pass-lanes-tab","projectOrigin":"github.com/arul/ade"},
       "lastActiveAtMs":\(nowMs - 2 * day),"createdAtMs":\(nowMs - 9 * day),
       "laneWork":{"unpushed":false,"prState":"merged"}},
      {"instanceId":"q1w2e3r4t5","name":"supabase-stack","machineKey":"mk4","state":"asleep","type":"box",
       "resources":{"cpu":2,"memoryGb":4,"diskGb":4.0},"shapeId":"2x4","hoursRate":1,"sleep":{"state":"auto"},"pastDue":false,
       "lastActiveAtMs":\(nowMs - 21 * day),"createdAtMs":\(nowMs - 40 * day)}
    ],
    "account":{"plan":"paid","planId":"pro","rules":"paid",
      "hours":{"includedMilli":600000,"usedMilli":117500,"leftMilli":482500,"percentUsed":19.6,"state":"none"},
      "extraHours":{"available":true,"enabled":false,"usedMilli":0},
      "disk":{"usedGb":17.6,"limitGb":null},
      "computers":{"total":4,"awake":1,"limit":10},
      "phone":\(phone),
      "recentUse":{"days":7,"usedMilli":63000},
      "billing":{"periodStart":1793491200000,"periodEnd":1796083200000,"cancelAtPeriodEnd":false,"nextPlanId":null,"notice":null},
      "earnedHours":{"leftMilli":40000,"usedThisPeriodMilli":0,"grantedMilli":40000},
      "freePlan":{"state":"claimed","sentence":null},
      "referral":{"code":"K7Q2M9XD","link":"https://ade-app.dev/invite/K7Q2M9XD","friendsJoined":3,"rewardsPaid":2,"rewardsLeft":8,
        "rewardLimit":10,"rewardMilli":20000,"hoursEarnedMilli":40000,"canEnterCode":true,"enterCodeUntil":1795651200000,
        "hasReferrer":false,"referredState":null},
      "dueForDeletion":[],"deletedInstanceIds":[],
      "catalog":{
        "plans":{
          "free":{"includedMilli":50000,"diskGb":24,"priceUsd":0,"extraHourCents":null,"computerLimit":2,"outsideAgents":false},
          "paid":{"includedMilli":100000,"diskGb":36,"priceUsd":5,"extraHourCents":2,"computerLimit":3,"outsideAgents":true},
          "plus":{"includedMilli":100000,"diskGb":36,"priceUsd":5,"extraHourCents":2,"computerLimit":3,"outsideAgents":true},
          "pro":{"includedMilli":600000,"diskGb":120,"priceUsd":20,"extraHourCents":2,"computerLimit":10,"outsideAgents":true},
          "max":{"includedMilli":1500000,"diskGb":240,"priceUsd":50,"extraHourCents":2,"computerLimit":20,"outsideAgents":true}},
        "sizes":[
          {"type":"default","cpu":2,"memoryGb":4,"multiplierMilli":0,"tier":"small","label":"Small","diskMaxGb":12},
          {"type":"default","cpu":4,"memoryGb":8,"multiplierMilli":1000,"tier":"medium","label":"Medium","diskMaxGb":20},
          {"type":"vm","cpu":4,"memoryGb":8,"multiplierMilli":2500,"tier":"large","label":"Large","diskMaxGb":50},
          {"type":"vm","cpu":4,"memoryGb":16,"multiplierMilli":4000,"tier":"xlarge","label":"X-Large","diskMaxGb":100}],
        "diskStepGb":10,"paidPriceUsd":5,"extraHourCents":2}}}
    """
  }

  static func signInsFixture() -> ProviderLoginsPhoneStatus? {
    let json = """
    {"thisComputer":{"capture":"on","reason":null,"message":null,"label":"Mac Studio","cloudComputer":false,"lastPassAt":null},
     "cloud":{"enabled":true,"inUse":{},"claude":{"smartBalance":false}},
     "signIns":[
       {"key":"codex/mac-studio.default","provider":"codex","slot":"default","class":"renewing",
        "origin":{"label":"Mac Studio","platform":"darwin","thisComputer":true},
        "account":{"email":"arul@example.com","id":null},"capturedAt":"2026-11-10T18:00:00Z",
        "renewedAt":"2026-11-11T14:10:00Z","renewedBy":"Mac Studio","onForCloud":true,"inUseOnCloud":true},
       {"key":"grok/macbook.default","provider":"grok","slot":"default","class":"renewing",
        "origin":{"label":"MacBook","platform":"darwin","thisComputer":false},
        "account":{"email":"arul@x.ai","id":null},"capturedAt":"2026-11-09T12:00:00Z",
        "renewedAt":null,"renewedBy":null,"onForCloud":true,"inUseOnCloud":true},
       {"key":"cursor/mac-studio.default","provider":"cursor","slot":"default","class":"fixed",
        "origin":{"label":"Mac Studio","platform":"darwin","thisComputer":true},
        "account":null,"capturedAt":"2026-11-08T09:00:00Z",
        "renewedAt":null,"renewedBy":null,"onForCloud":true,"inUseOnCloud":true}
     ],
     "providers":[
       {"provider":"codex","carry":"carried","message":"","local":{"state":"captured","key":"codex/mac-studio.default"}},
       {"provider":"grok","carry":"carried","message":"","local":{"state":"not_signed_in","key":null}},
       {"provider":"cursor","carry":"carried","message":"","local":{"state":"captured","key":"cursor/mac-studio.default"}},
       {"provider":"muse","carry":"fallback","message":"","local":{"state":"not_checked","key":null}},
       {"provider":"claude","carry":"never","message":"","local":{"state":"not_checked","key":null}}
     ],
     "applied":null,
     "claudePasses":[{"key":"claude-pass/0123456789ab","unreadable":false,"label":"Claude pass","email":"arul@work.com","on":true,"newChats":true,"endsInDays":200}]}
    """
    return try? JSONDecoder().decode(ProviderLoginsPhoneStatus.self, from: Data(json.utf8))
  }
}

/// A finished reply in an ADE Cloud chat with what can show under it: the
/// one-time question, a sponsored card, or the agent's Sponsored pick. The
/// real slot and cards over fixture data (sample text, Gravity's test host).
private struct CloudSponsoredChatFixture: View {
  let kind: String
  @State private var slot = WorkSponsoredSlotModel()

  private let sessionId = "fixture-chat"
  private var turn: CloudSponsoredTurn {
    CloudSponsoredTurn(turnId: "turn-1", finishedAt: Date().addingTimeInterval(-60), messages: [
      CloudSponsoredMessage(role: "user", content: "Add sign-in with email links to the web app."),
      CloudSponsoredMessage(role: "assistant", content: "Done. Sign-in now sends a one-time link."),
    ])
  }

  private var pickCard: WorkAdeCardModel {
    workAdeCardModel(from: [
      "cardId": "sponsored-pick:fixture-1",
      "variant": "sponsored_pick",
      "state": "live",
      "title": "Sendwell",
      "subtitle": "Email API",
      "rows": [
        ["key": "sponsored_need", "icon": "info", "text": "sending sign-in emails from the Next.js app"],
        ["key": "sponsored_description", "icon": "info", "text": "An email API for developers. Send sign-in links and receipts with a few lines of code."],
        ["key": "sponsored_url", "icon": "info", "text": "Sendwell", "detail": "https://trygravity.ai/c/fixture"],
        ["key": "sponsored_step", "icon": "info", "text": "npm install sendwell"],
        ["key": "sponsored_step", "icon": "info", "text": "Add SENDWELL_API_KEY to .env.local"],
      ],
      "actions": [],
      "fallbackText": "Sponsored: Sendwell. An email API for developers.",
    ], sessionId: sessionId, timestamp: "2026-11-22T10:00:00Z", sequence: 1, turnId: "turn-1")
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          Text("Add sign-in with email links to the web app.")
            .font(.system(size: 15))
            .foregroundStyle(ADEColor.textPrimary)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(ADEColor.accent.opacity(0.14), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .frame(maxWidth: .infinity, alignment: .trailing)
          Text("Done. Sign-in now sends a one-time link to the address the person enters. The link expires after 15 minutes, and `/auth/verify` signs them in. I added tests for an expired and a reused link.")
            .font(.system(size: 15))
            .foregroundStyle(ADEColor.textPrimary)
            .fixedSize(horizontal: false, vertical: true)
          if kind == "duo-cloud-sponsored-pick" {
            Text("For sending those emails, here is one service that fits.")
              .font(.system(size: 15))
              .foregroundStyle(ADEColor.textPrimary)
            WorkAdeCardView(card: pickCard)
          } else {
            WorkSponsoredReplySlot(instanceId: "zodqsue74s", sessionId: sessionId, turn: turn, slot: slot)
          }
        }
        .padding(16)
      }
      .background(ADEColor.pageBackground.ignoresSafeArea())
      .navigationTitle("fix-login-redirect")
      .navigationBarTitleDisplayMode(.inline)
    }
    .environment(\.workSceneBridge, {
      let bridge = WorkSceneChatBridge()
      bridge.sessionId = sessionId
      bridge.canReply = true
      return bridge
    }())
    .onAppear {
      slot.seedPreviewOnScreen()
      CloudSponsoredStore.shared.seedPreview(
        turnKey: CloudSponsoredStore.turnKey(chatId: sessionId, turnId: "turn-1"),
        ad: CloudSponsoredAd(
          id: "fixture-ad",
          brand: "Keyway",
          title: "Drop-in sign-in for Next.js",
          text: "Email links, passkeys and social sign-in, with user management built in.",
          cta: nil,
          clickUrl: "https://trygravity.ai/c/fixture-ad",
          impUrl: nil,
          test: true
        )
      )
    }
  }
}

/// One finished turn in the real chat screen of an ADE Cloud chat, with the
/// account's format (`CloudSponsoredState.format`) drawing the turn's card:
/// under the reply, docked above the prompt box, or as the reply's last line.
/// The real slot, transcript and prompt box; the card is a Gravity test ad.
private struct CloudSponsoredFormatChatFixture: View {
  private static let turnId = "turn-db"

  private static var transcript: [WorkChatEnvelope] {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    func at(_ secondsAgo: Int, _ sequence: Int, _ event: WorkChatEvent) -> WorkChatEnvelope {
      WorkChatEnvelope(
        sessionId: workPreviewChatSessionId,
        timestamp: formatter.string(from: Date().addingTimeInterval(TimeInterval(-secondsAgo))),
        sequence: sequence,
        event: event
      )
    }
    return [
      at(260, 1, .userMessage(
        text: "Give every preview deploy its own Postgres database, so a PR never touches shared data.",
        attachments: nil, turnId: turnId, steerId: nil, deliveryState: "delivered", processed: true
      )),
      at(200, 2, .fileChange(
        path: "scripts/preview-db.ts",
        diff: "+ await createDatabase(`preview_${branch}`)\n+ await migrate(url)",
        kind: "added", status: .completed, itemId: "file-db-1", turnId: turnId
      )),
      at(150, 3, .fileChange(
        path: ".github/workflows/preview.yml",
        diff: "+ DATABASE_URL: ${{ steps.db.outputs.url }}",
        kind: "modified", status: .completed, itemId: "file-db-2", turnId: turnId
      )),
      at(60, 4, .assistantText(
        text: "Done. Each preview deploy now gets its own database:\n\n- `scripts/preview-db.ts` creates one named after the branch and runs the migrations.\n- The preview workflow passes its `DATABASE_URL` to the deploy.\n- Closing the PR drops it.\n\nI ran it on this branch, and the preview came up with its own seeded data.",
        turnId: turnId, itemId: "msg-db"
      )),
      at(58, 5, .done(
        status: "completed",
        summary: "Preview databases per PR.",
        usage: WorkUsageSummary(turnCount: 1, inputTokens: 21_300, outputTokens: 2_480, cacheReadTokens: 11_200, cacheCreationTokens: 640, costUsd: 0.071),
        turnId: turnId,
        model: "claude-sonnet-5",
        modelId: "anthropic/claude-sonnet-5"
      )),
    ]
  }

  @State private var chat: WorkChatSessionView = {
    var view = workPreviewChatSessionView(transcript: CloudSponsoredFormatChatFixture.transcript)
    view.sponsoredInstanceId = "zodqsue74s"
    return view
  }()

  var body: some View {
    NavigationStack { chat }
      .onAppear {
        CloudSponsoredStore.shared.seedPreview(
          turnKey: CloudSponsoredStore.turnKey(chatId: workPreviewChatSessionId, turnId: Self.turnId),
          ad: CloudSponsoredAd(
            id: "fixture-neon",
            brand: "Neon",
            title: "Serverless Postgres with branching",
            text: "Spin up a database branch for every pull request.",
            cta: "Try Neon",
            clickUrl: "https://trygravity.ai/c/fixture-neon",
            impUrl: nil,
            test: true
          )
        )
      }
  }
}

/// Settings › Providers with ADE Cloud picked, from fixtures.
private struct ProvidersCloudFixture: View {
  let syncService: SyncService
  @StateObject private var model: ProviderLoginsModel

  init(syncService: SyncService, status: ProviderLoginsPhoneStatus) {
    self.syncService = syncService
    _model = StateObject(wrappedValue: ProviderLoginsModel(fixture: status))
  }

  var body: some View {
    NavigationStack {
      ADESettingsPage(route: .providers) {
        ADEKitSegmented(
          selection: .constant(SettingsProvidersPage.ProvidersPlace.cloud),
          options: [(SettingsProvidersPage.ProvidersPlace.machine, "Mac Studio"), (SettingsProvidersPage.ProvidersPlace.cloud, "ADE Cloud")]
        )
        ProviderCloudPlace(syncService: syncService, model: model)
      }
    }
  }
}
#endif
