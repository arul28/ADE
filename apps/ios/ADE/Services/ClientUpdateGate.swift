import Combine
import Foundation
import OSLog
import os
import SwiftUI
import UIKit

private let clientUpdateGateLog = Logger(subsystem: "com.ade.ios", category: "ClientUpdateGate")

// The launch update gate on the phone. The account server says, per kind of
// install, the oldest ADE build that may still run (`GET /client/minimum`,
// `apps/account-directory/src/clientMinimumContract.ts`). The phone judges
// two things with it:
// - itself: below its install's minimum, with an update really available,
//   the whole app is covered by "Update ADE to keep working";
// - the computer it works on (a desktop brain or an ADE Cloud computer): the
//   desktop's own rule (`desktopUpdateRequirement` in
//   `apps/desktop/src/shared/clientUpdateGate.ts`), ported below, so a
//   machine never reads "update required" on the phone and "fine" on the
//   desktop.
//
// Nothing here ever blocks on a doubt: a failed read, an answer older than
// 12 hours, a minimum ahead of what is published, a Debug or simulator build,
// or a version the phone can't read all leave everything open.

// MARK: - The server's answer

/// `ClientMinimumResponse`. Null fields are "no minimum".
struct ClientMinimum: Equatable {
  struct Desktop: Equatable {
    var stable: String?
    var beta: String?
  }

  struct Phone: Equatable {
    /// The App Store install compares its marketing version.
    var appStoreVersion: String?
    /// TestFlight installs of `com.ade.ios` and the ADE Beta app compare builds.
    var testFlightBuild: Int?
    var betaAppBuild: Int?
  }

  struct Links: Equatable {
    var appStore: URL
    var testFlight: URL
    var betaAppTestFlight: URL
  }

  var desktop: Desktop
  var ios: Phone
  var links: Links

  /// `CLIENT_MINIMUM_LINKS`, for an answer that leaves a link out.
  static let defaultLinks = Links(
    appStore: URL(string: "https://apps.apple.com/app/id6762759870")!,
    testFlight: URL(string: "https://testflight.apple.com/join/ZSdJGKPy")!,
    betaAppTestFlight: URL(string: "https://testflight.apple.com/join/SsxDjqbF")!
  )

  static let none = ClientMinimum(desktop: Desktop(), ios: Phone(), links: defaultLinks)

  init(desktop: Desktop, ios: Phone, links: Links) {
    self.desktop = desktop
    self.ios = ios
    self.links = links
  }

  /// Lenient: a field that is missing or the wrong type is "no minimum".
  /// Nil only when the body is not an object at all.
  init?(json: Any) {
    guard let record = json as? [String: Any] else { return nil }
    let desktop = record["desktop"] as? [String: Any]
    let ios = record["ios"] as? [String: Any]
    let links = record["links"] as? [String: Any]
    func build(_ key: String) -> Int? {
      guard let entry = ios?[key] as? [String: Any], let number = entry["build"] as? NSNumber else { return nil }
      let value = number.doubleValue
      guard value.isFinite, value >= 1, value == value.rounded(), value < Double(Int.max) else { return nil }
      return Int(value)
    }
    func link(_ key: String, _ fallback: URL) -> URL {
      guard let raw = nonEmptyTrimmed(links?[key] as? String),
            let url = URL(string: raw), url.scheme?.lowercased() == "https" else { return fallback }
      return url
    }
    self.desktop = Desktop(
      stable: nonEmptyTrimmed(desktop?["stable"] as? String),
      beta: nonEmptyTrimmed(desktop?["beta"] as? String)
    )
    self.ios = Phone(
      appStoreVersion: nonEmptyTrimmed((ios?["appStore"] as? [String: Any])?["version"] as? String),
      testFlightBuild: build("testFlight"),
      betaAppBuild: build("betaApp")
    )
    self.links = Links(
      appStore: link("appStore", Self.defaultLinks.appStore),
      testFlight: link("testFlight", Self.defaultLinks.testFlight),
      betaAppTestFlight: link("betaAppTestFlight", Self.defaultLinks.betaAppTestFlight)
    )
  }
}

// MARK: - Other machines: the desktop's rule

/// A desktop build (another machine's ADE seen from the phone) that has to
/// update before it keeps working.
struct DesktopUpdateRequirement: Equatable {
  let isBetaTrack: Bool
  let currentVersion: String
  let minimumVersion: String
  /// The newest published build on the track, which meets the minimum.
  let targetVersion: String
}

/// `shippedVersionOrNull` (`updateTrack.ts`): nil for a dev or test build.
func adeShippedVersion(_ version: String?) -> String? {
  let trimmed = version?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  if trimmed.isEmpty || trimmed == "0.0.0" || trimmed == "1.0.0-beta.1" { return nil }
  return trimmed
}

/// `isGateExemptVersion`: Alpha builds, previews and dev builds never have a minimum.
func adeVersionIsGateExempt(_ version: String?) -> Bool {
  guard var text = adeShippedVersion(version) else { return true }
  if text.first == "v" || text.first == "V" { text.removeFirst() }
  let beforeBuild = text.split(separator: "+", omittingEmptySubsequences: false).first ?? ""
  let prerelease = beforeBuild
    .split(separator: "-", omittingEmptySubsequences: false)
    .dropFirst()
    .joined(separator: "-")
    .lowercased()
  return prerelease.range(of: #"(^|\.)(alpha|preview|dev|rc)(\.|$)"#, options: .regularExpression) != nil
    || prerelease.contains("alpha")
}

/// `desktopUpdateRequirement`: nil unless the build is a released Stable or
/// Beta build below its track's minimum AND a build that meets the minimum is
/// published on that track, so Update can actually finish.
func desktopUpdateRequirement(
  currentVersion: String?,
  minimum: ClientMinimum.Desktop?,
  latestStable: String?,
  latestBeta: String?
) -> DesktopUpdateRequirement? {
  let current = currentVersion?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  guard !current.isEmpty, !adeVersionIsGateExempt(current) else { return nil }
  let beta = adeVersionIsBetaTrack(current)
  guard let minimumVersion = nonEmptyTrimmed(beta ? minimum?.beta : minimum?.stable),
        compareAdeVersions(current, minimumVersion) < 0 else { return nil }
  // No published build meets the minimum yet: Update could not finish.
  guard let targetVersion = nonEmptyTrimmed(beta ? latestBeta : latestStable),
        adeVersionIsBetaTrack(targetVersion) == beta,
        compareAdeVersions(targetVersion, minimumVersion) >= 0 else { return nil }
  return DesktopUpdateRequirement(
    isBetaTrack: beta,
    currentVersion: current,
    minimumVersion: minimumVersion,
    targetVersion: targetVersion
  )
}

// MARK: - The phone itself

/// Where this iPhone build came from (`IosInstallSource`); each has its own minimum.
enum PhoneInstallSource: String, Equatable {
  case appStore
  case testFlight
  case betaApp

  /// Nil for Debug and simulator builds, and for any bundle that is not one
  /// of ADE's two apps: none of those has a minimum.
  static var current: PhoneInstallSource? {
    #if DEBUG
    return nil
    #elseif targetEnvironment(simulator)
    return nil
    #else
    return of(
      bundleId: Bundle.main.bundleIdentifier,
      receiptName: Bundle.main.appStoreReceiptURL?.lastPathComponent
    )
    #endif
  }

  static func of(bundleId: String?, receiptName: String?) -> PhoneInstallSource? {
    switch bundleId {
    case "com.ade.ios.beta": return .betaApp
    case "com.ade.ios": return receiptName == "sandboxReceipt" ? .testFlight : .appStore
    default: return nil
    }
  }
}

/// This phone is below its install's minimum and the update is out.
struct PhoneUpdateRequirement: Equatable {
  let source: PhoneInstallSource
  /// "1.2.129", or "Build 10063".
  let currentLabel: String
  /// "1.2.130", or "Build 10070".
  let requiredLabel: String
  let updateURL: URL

  var buttonTitle: String { source == .appStore ? "Update in the App Store" : "Update in TestFlight" }
}

/// Nil unless this install is below its minimum and an update that meets it
/// is really available. App Store: the store's own version (iTunes lookup)
/// must meet the minimum. TestFlight: the minimum is trusted (the owner's
/// script checks the build is in TestFlight before it sets one).
func phoneUpdateRequirement(
  source: PhoneInstallSource?,
  marketingVersion: String?,
  build: String?,
  minimum: ClientMinimum?,
  storeVersion: String?
) -> PhoneUpdateRequirement? {
  guard let source, let minimum else { return nil }
  switch source {
  case .appStore:
    guard let required = minimum.ios.appStoreVersion,
          let current = nonEmptyTrimmed(marketingVersion),
          compareAppVersions(current, required) == .orderedAscending,
          let storeVersion = nonEmptyTrimmed(storeVersion) else { return nil }
    // The minimum is ahead of the store, or the store's answer is unreadable: nothing to update to.
    let store = compareAppVersions(storeVersion, required)
    guard store == .orderedSame || store == .orderedDescending else { return nil }
    return PhoneUpdateRequirement(source: source, currentLabel: current, requiredLabel: required, updateURL: minimum.links.appStore)
  case .testFlight, .betaApp:
    let required = source == .testFlight ? minimum.ios.testFlightBuild : minimum.ios.betaAppBuild
    guard let required,
          let raw = nonEmptyTrimmed(build), let current = Int(raw),
          current < required else { return nil }
    return PhoneUpdateRequirement(
      source: source,
      currentLabel: "Build \(current)",
      requiredLabel: "Build \(required)",
      updateURL: source == .testFlight ? minimum.links.testFlight : minimum.links.betaAppTestFlight
    )
  }
}

/// Whether the phone is blocked, readable from any thread: Sentry's
/// `beforeSend` drops the phone's own events while it is (a build that is no
/// longer supported reports nothing anyone will fix).
enum PhoneUpdateGateFlag {
  private static let state = OSAllocatedUnfairLock(initialState: false)
  static var isBlocked: Bool { state.withLock { $0 } }
  fileprivate static func set(_ blocked: Bool) { state.withLock { $0 = blocked } }
}

// MARK: - Store

@MainActor
final class ClientUpdateGateStore: ObservableObject {
  static let shared = ClientUpdateGateStore()

  /// The last answer the server gave, and when. Kept in memory only: a launch
  /// with no answer yet blocks nothing.
  @Published private(set) var minimum: ClientMinimum?
  @Published private(set) var minimumReadAt: Date?
  /// The App Store's version of ADE, read only when this App Store install is
  /// below its minimum.
  @Published private(set) var storeVersion: String?
  /// Set while this phone must update. The whole app is covered meanwhile.
  @Published private(set) var phoneRequirement: PhoneUpdateRequirement? {
    didSet { PhoneUpdateGateFlag.set(phoneRequirement != nil) }
  }

  var isPhoneBlocked: Bool { phoneRequirement != nil }

  /// `CLIENT_MINIMUM_FRESH_MS`: an older answer decides nothing.
  static let freshness: TimeInterval = 12 * 60 * 60
  /// Back in front after this long, the phone reads again.
  static let foregroundRereadAfter: TimeInterval = 30 * 60
  /// While in front, it reads this often.
  static let pollInterval: TimeInterval = 3 * 60 * 60

  private let session: URLSession
  private let installSource: PhoneInstallSource?
  private let marketingVersion: String?
  private let build: String?
  private var readTask: Task<Void, Never>?
  private var pollTask: Task<Void, Never>?

  init(
    session: URLSession = .adeAccount,
    installSource: PhoneInstallSource? = PhoneInstallSource.current,
    marketingVersion: String? = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
    build: String? = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String
  ) {
    self.session = session
    self.installSource = installSource
    self.marketingVersion = marketingVersion
    self.build = build
  }

  /// The answer, while it is fresh enough to decide anything.
  func freshMinimum(now: Date = Date()) -> ClientMinimum? {
    guard let minimum, let minimumReadAt, now.timeIntervalSince(minimumReadAt) < Self.freshness else { return nil }
    return minimum
  }

  /// The desktop rule for another machine's ADE version, against the newest
  /// builds `MachineUpdateStore` knows. Nil when it may keep working.
  func desktopRequirement(forMachineVersion version: String?) -> DesktopUpdateRequirement? {
    let updates = MachineUpdateStore.shared
    return desktopUpdateRequirement(
      currentVersion: version,
      minimum: freshMinimum()?.desktop,
      latestStable: updates.latestStable,
      latestBeta: updates.latestBeta
    )
  }

  // MARK: When to read

  /// Launch and every move to the front: reads when it never has or the last
  /// read is over 30 minutes old, and reads every 3 hours while in front.
  func appBecameActive() {
    if minimumReadAt.map({ Date().timeIntervalSince($0) >= Self.foregroundRereadAfter }) ?? true {
      Task { await refresh() }
    } else {
      // An answer that went stale while the app was away opens the gate now.
      recompute()
    }
    guard pollTask == nil else { return }
    pollTask = Task { @MainActor [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(nanoseconds: UInt64(Self.pollInterval * 1_000_000_000))
        guard !Task.isCancelled, let self else { return }
        await self.refresh()
      }
    }
  }

  func appEnteredBackground() {
    pollTask?.cancel()
    pollTask = nil
  }

  /// One read of the minimum (and, when it matters, the App Store's version
  /// and the newest desktop builds). Concurrent callers share one read.
  func refresh() async {
    if let readTask {
      await readTask.value
      return
    }
    let task = Task { @MainActor [weak self] in
      guard let self else { return }
      if let answer = await self.readMinimum() {
        self.minimum = answer
        self.minimumReadAt = Date()
        if self.appStoreInstallBelowMinimum(answer) {
          // Only a phone that would be blocked asks the store; a failed
          // lookup keeps it open.
          self.storeVersion = await self.readStoreVersion()
        }
        if answer.desktop.stable != nil || answer.desktop.beta != nil {
          // The other machines' rule needs the newest build on each track.
          await MachineUpdateStore.shared.refreshLatestBuilds()
        }
      }
      // A failed read keeps the last answer only while it is fresh.
      self.recompute()
    }
    readTask = task
    await task.value
    readTask = nil
  }

  private func recompute() {
    let next = phoneUpdateRequirement(
      source: installSource,
      marketingVersion: marketingVersion,
      build: build,
      minimum: freshMinimum(),
      storeVersion: storeVersion
    )
    if next != phoneRequirement {
      clientUpdateGateLog.notice("phone gate blocked=\(next != nil) source=\(self.installSource?.rawValue ?? "exempt", privacy: .public)")
      CrashReporting.breadcrumb("update_gate", message: next == nil ? "phone gate open" : "phone gate blocked")
      phoneRequirement = next
    }
  }

  private func appStoreInstallBelowMinimum(_ answer: ClientMinimum) -> Bool {
    guard installSource == .appStore,
          let required = answer.ios.appStoreVersion,
          let current = nonEmptyTrimmed(marketingVersion) else { return false }
    return compareAppVersions(current, required) == .orderedAscending
  }

  // MARK: Reads

  /// `GET /client/minimum`, public: no bearer, so a signed-out phone reads it too.
  private func readMinimum() async -> ClientMinimum? {
    guard let baseURL = AccountConfig.directoryBaseURL else { return nil }
    var request = URLRequest(url: baseURL.appendingPathComponent("client/minimum"))
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.timeoutInterval = 10
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    do {
      let (data, response) = try await session.data(for: request)
      guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
        clientUpdateGateLog.notice("minimum read refused status=\((response as? HTTPURLResponse)?.statusCode ?? -1)")
        return nil
      }
      return ClientMinimum(json: try JSONSerialization.jsonObject(with: data))
    } catch {
      clientUpdateGateLog.notice("minimum read failed error=\(error.localizedDescription, privacy: .public)")
      return nil
    }
  }

  /// The App Store's current version of ADE (`com.ade.ios`), or nil.
  private func readStoreVersion() async -> String? {
    guard let url = URL(string: "https://itunes.apple.com/lookup?bundleId=com.ade.ios") else { return nil }
    var request = URLRequest(url: url)
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.timeoutInterval = 10
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    do {
      let (data, response) = try await session.data(for: request)
      guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
            let record = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            let first = (record["results"] as? [[String: Any]])?.first else { return nil }
      return nonEmptyTrimmed(first["version"] as? String)
    } catch {
      clientUpdateGateLog.notice("store lookup failed error=\(error.localizedDescription, privacy: .public)")
      return nil
    }
  }
}

// MARK: - The cover over the whole app

/// Covers every window of the app with the blocked screen while the phone
/// must update. Its own window above alerts, so nothing under it (a sheet, an
/// alert, a chat with the keyboard up) can be reached, and nothing under it
/// is torn down: when the minimum is lowered or the answer goes stale, the
/// cover lifts and the app is where it was.
@MainActor
final class PhoneUpdateGateWindows {
  static let shared = PhoneUpdateGateWindows()

  private var windows: [ObjectIdentifier: UIWindow] = [:]
  private var requirement: PhoneUpdateRequirement?
  private var subscription: AnyCancellable?
  private var sceneObservers: [NSObjectProtocol] = []

  func start(store: ClientUpdateGateStore = .shared) {
    guard subscription == nil else { return }
    subscription = store.$phoneRequirement
      .removeDuplicates()
      .sink { [weak self] next in
        Task { @MainActor in self?.show(next) }
      }
    // A scene that connects or comes back while blocked is covered too.
    for name in [UIScene.willConnectNotification, UIScene.didActivateNotification, UIScene.willEnterForegroundNotification] {
      sceneObservers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        Task { @MainActor in
          guard let self else { return }
          self.show(self.requirement)
        }
      })
    }
    sceneObservers.append(NotificationCenter.default.addObserver(forName: UIScene.didDisconnectNotification, object: nil, queue: .main) { [weak self] note in
      guard let scene = note.object as? UIScene else { return }
      let key = ObjectIdentifier(scene)
      Task { @MainActor in self?.windows.removeValue(forKey: key)?.isHidden = true }
    })
  }

  /// Covers (or uncovers) every window scene for `requirement`.
  func show(_ requirement: PhoneUpdateRequirement?) {
    self.requirement = requirement
    guard let requirement else {
      guard !windows.isEmpty else { return }
      for window in windows.values { window.isHidden = true }
      windows.removeAll()
      // The app's own window takes the keyboard and focus back.
      for scene in UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }) {
        scene.windows.first { $0.windowLevel == .normal }?.makeKey()
      }
      return
    }
    // A chat's keyboard under the cover would stay up over it.
    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    for scene in UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }) {
      let key = ObjectIdentifier(scene)
      if let window = windows[key],
         let host = window.rootViewController as? UIHostingController<PhoneUpdateBlockedScreen> {
        host.rootView = PhoneUpdateBlockedScreen(requirement: requirement)
        continue
      }
      let window = UIWindow(windowScene: scene)
      window.windowLevel = .alert + 1
      let host = UIHostingController(rootView: PhoneUpdateBlockedScreen(requirement: requirement))
      host.view.backgroundColor = .clear
      window.rootViewController = host
      window.accessibilityViewIsModal = true
      window.makeKeyAndVisible()
      windows[key] = window
    }
  }
}
