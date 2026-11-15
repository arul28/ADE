import SwiftUI

#if DEBUG
/// Fixture screens for screenshots on any device and fold, with no machine:
///
/// - `-adePreviewScreen duo-cloud`: the ADE Cloud page (the dashboard);
/// - `duo-cloud-plans`: the same page scrolled to the plans and sizes;
/// - `duo-cloud-upgraded`: the page a moment after a checkout from Free ("You're on Plus");
/// - `duo-cloud-invite`: the invite card (link, Copy, Share, counts, the code box);
/// - `duo-cloud-limits`: what agents may do alone;
/// - `duo-cloud-machine`: one computer (what uses its disk);
/// - `duo-providers-cloud`: Settings › Providers with ADE Cloud as the place;
/// - `duo-provider-signin`: the sign-in sheet at its approve step.
enum CloudPreviews {
  static let names: Set<String> = [
    "duo-cloud", "duo-cloud-plans", "duo-cloud-sizes", "duo-cloud-upgraded", "duo-cloud-invite", "duo-cloud-limits", "duo-cloud-machine", "duo-providers-cloud", "duo-provider-signin",
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
    guard let list = try? JSONDecoder().decode(CloudPhoneList.self, from: Data(listJSON.utf8)) else { return nil }
    let limits = CloudPhoneLimits(unattendedSpend: true, machinesPerDay: 3, maxShape: "4x16", preset: "balanced")
    // `duo-cloud-upgraded`: this phone last saw the account on Free, a period ago, with 79.1 hours left.
    // Only the fixture account's entry changes: every other account's record on this device stays.
    if name == "duo-cloud-upgraded", let code = list.account?.referral?.code {
      var all = UserDefaults.standard.dictionary(forKey: CloudPlanSeenStore.defaultsKey) ?? [:]
      all[code] = ["planId": "free", "periodStart": 1_790_812_800_000.0, "leftMilli": 79_100]
      UserDefaults.standard.set(all, forKey: CloudPlanSeenStore.defaultsKey)
    }
    let store = CloudPaneStore(syncService: sync, fixtureList: list, limits: limits, signIns: signInsFixture(), now: fixtureNow)
    switch name {
    case "duo-cloud-limits":
      return AnyView(NavigationStack { CloudLimitsScreen(store: store) })
    case "duo-cloud-machine":
      return AnyView(NavigationStack { CloudMachineScreen(store: store, instanceId: "k2p8a1b2c3") })
    case "duo-cloud-invite":
      return AnyView(NavigationStack {
        ScrollView {
          if let referral = store.account?.referral {
            CloudInviteCard(referral: referral, syncService: sync, onChanged: {}).padding(16)
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
              CloudPlansCard(account: account)
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

  private static var listJSON: String {
    let hour = 3_600_000.0
    let day = 86_400_000.0
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
    "account":{"plan":"paid","planId":"plus","rules":"paid",
      "hours":{"includedMilli":500000,"usedMilli":117500,"leftMilli":382500,"percentUsed":23.5,"state":"none"},
      "extraHours":{"available":true,"enabled":false,"usedMilli":0},
      "disk":{"usedGb":17.6,"limitGb":30},
      "computers":{"total":4,"awake":1,"limit":25},
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
          "free":{"includedMilli":100000,"diskGb":12,"priceUsd":0,"phoneMinutes":20,"extraHourCents":null},
          "paid":{"includedMilli":300000,"diskGb":30,"priceUsd":5,"phoneMinutes":30,"extraHourCents":2},
          "plus":{"includedMilli":300000,"diskGb":30,"priceUsd":5,"phoneMinutes":30,"extraHourCents":2},
          "pro":{"includedMilli":1600000,"diskGb":80,"priceUsd":20,"phoneMinutes":160,"extraHourCents":1.5},
          "max":{"includedMilli":5000000,"diskGb":175,"priceUsd":50,"phoneMinutes":500,"extraHourCents":1.2}},
        "sizes":[
          {"type":"default","cpu":2,"memoryGb":4,"multiplierMilli":1000,"tier":"small","label":"Small","diskMaxGb":20},
          {"type":"default","cpu":4,"memoryGb":8,"multiplierMilli":2000,"tier":"medium","label":"Medium","diskMaxGb":40},
          {"type":"vm","cpu":4,"memoryGb":8,"multiplierMilli":5000,"tier":"large","label":"Large","diskMaxGb":60},
          {"type":"vm","cpu":4,"memoryGb":16,"multiplierMilli":7000,"tier":"xlarge","label":"X-Large","diskMaxGb":100}],
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
