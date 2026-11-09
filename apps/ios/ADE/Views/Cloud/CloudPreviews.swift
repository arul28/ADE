import SwiftUI

#if DEBUG
/// `-adePreviewScreen duo-cloud` (and `duo-cloud-limits`): the page from
/// fixtures, for screenshots on any device and fold.
enum CloudPreviews {
  @MainActor static func view(_ name: String) -> AnyView? {
    guard name == "duo-cloud" || name == "duo-cloud-limits" || name == "duo-cloud-making" else { return nil }
    let json = """
    {"machines":[
      {"instanceId":"zodqsue74s","name":"supabase-stack","machineKey":"mk1","state":"running","type":"vm","size":"Full computer · Medium · 4 CPU · 8 GB","shape":"4x8","hoursRate":5,"sleep":{"state":"auto"},"ready":null,"pastDue":false},
      {"instanceId":"k2p8a1b2c3","name":"lane box","machineKey":"mk2","state":"asleep","type":"box","size":"Small · 2 CPU · 4 GB","shape":"2x4","hoursRate":1,"sleep":{"state":"auto"},"ready":null,"pastDue":false},
      {"instanceId":"a9x7c6v5b4","name":"android vm","machineKey":"mk3","state":"starting","type":"vm","size":"Full computer · Medium · 4 CPU · 8 GB","shape":"4x8","hoursRate":5,"sleep":{"state":"auto"},"ready":{"projectName":"acme/app","state":"claimed"},"pastDue":false}
    ],"runningCount":2,
    "account":{"plan":"paid","hours":{"includedMilli":500000,"leftMilli":382500,"state":"none"}}}
    """
    guard let list = try? JSONDecoder().decode(CloudPhoneList.self, from: Data(json.utf8)) else { return nil }
    let limits = CloudPhoneLimits(unattendedSpend: true, machinesPerDay: 3, maxShape: "4x16", preset: "balanced")
    let ready = [CloudPhoneReadyPool.Entry(identity: "github.com/acme/app", projectName: "acme/app", keptReady: true, ready: 1, preparing: 0, inUse: 1, failed: 0, failure: nil)]
    let making = name == "duo-cloud-making"
      ? CloudPhoneMakeJob(requestId: "r1", kind: "create", stage: "approve_elsewhere", message: "Approve lane box 2 joining your account.", instanceId: "n3w4b0x5zz", approvalUrl: "https://ade-app.dev/device?user_code=ABCD-EFGH", done: false, error: nil)
      : nil
    let store = CloudPaneStore(syncService: SyncService.shared ?? SyncService(), fixtureList: list, limits: limits, ready: ready, makeJob: making)
    if name == "duo-cloud-limits" {
      return AnyView(NavigationStack { CloudLimitsScreen(store: store) })
    }
    return AnyView(CloudPaneSheet(store: store))
  }
}
#endif
