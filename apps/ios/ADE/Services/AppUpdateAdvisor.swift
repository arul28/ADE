import Combine
import Foundation

enum AppVersionComparison: Equatable {
  case orderedAscending
  case orderedSame
  case orderedDescending
  case invalid
}

/// Compares numeric dotted versions without treating "1.2.10" as older than
/// "1.2.9". Missing trailing components are zero, so "1.2" equals "1.2.0".
func compareAppVersions(_ lhs: String, _ rhs: String) -> AppVersionComparison {
  guard let left = numericAppVersionComponents(lhs),
        let right = numericAppVersionComponents(rhs) else {
    return .invalid
  }

  for index in 0..<max(left.count, right.count) {
    let leftComponent = index < left.count ? left[index] : 0
    let rightComponent = index < right.count ? right[index] : 0
    if leftComponent < rightComponent { return .orderedAscending }
    if leftComponent > rightComponent { return .orderedDescending }
  }
  return .orderedSame
}

private func numericAppVersionComponents(_ version: String) -> [Int]? {
  let trimmed = version.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmed.isEmpty else { return nil }
  let parts = trimmed.split(separator: ".", omittingEmptySubsequences: false)
  guard !parts.isEmpty else { return nil }

  var components: [Int] = []
  components.reserveCapacity(parts.count)
  for part in parts {
    guard let value = Int(part), value >= 0 else { return nil }
    components.append(value)
  }
  return components
}

@MainActor
final class AppUpdateAdvisor: ObservableObject {
  private struct LookupResponse: Decodable {
    let results: [LookupResult]
  }

  private struct LookupResult: Decodable {
    let version: String?
    let trackViewUrl: String?
    let trackId: Int?
  }

  static let lastCheckKey = "ade.appUpdateAdvisor.lastCheckAt"
  static let dismissedVersionKey = "ade.appUpdateAdvisor.dismissedVersion"

  private static let checkInterval: TimeInterval = 6 * 60 * 60

  @Published private(set) var availableVersion: String?
  @Published private(set) var storeURL: URL?
  @Published private(set) var isChecking = false
  @Published private(set) var hasChecked = false
  @Published private(set) var dismissedVersion: String?

  let currentVersion: String

  private let bundleIdentifier: String
  private let defaults: UserDefaults
  private let session: URLSession
  private let now: () -> Date
  private var trackId: Int?

  init(
    defaults: UserDefaults = .standard,
    session: URLSession = .shared,
    bundleIdentifier: String? = nil,
    currentVersion: String? = nil,
    now: @escaping () -> Date = Date.init
  ) {
    self.defaults = defaults
    self.session = session
    self.bundleIdentifier = bundleIdentifier ?? Bundle.main.bundleIdentifier ?? ""
    self.currentVersion = currentVersion
      ?? (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String)
      ?? "0.0.0"
    self.now = now
    self.dismissedVersion = defaults.string(forKey: Self.dismissedVersionKey)
  }

  /// The App Store URL when available, or the direct App Store scheme when the
  /// lookup response only provided its numeric track id.
  var updateURL: URL? {
    storeURL ?? trackId.flatMap { URL(string: "itms-apps://itunes.apple.com/app/id\($0)") }
  }

  var isAvailableUpdateDismissed: Bool {
    guard let availableVersion else { return false }
    return dismissedVersion == availableVersion
  }

  /// Checks in the background. A user-triggered check is subject to the same
  /// six-hour window as foreground checks so repeated taps cannot create a
  /// request storm.
  func checkForUpdates() async {
    guard !isChecking else { return }

    let checkDate = now()
    if let lastCheck = defaults.object(forKey: Self.lastCheckKey) as? Date,
       checkDate.timeIntervalSince(lastCheck) < Self.checkInterval {
      return
    }

    guard !bundleIdentifier.isEmpty,
          let lookupURL = makeLookupURL() else {
      return
    }

    // Record attempts, not just successes: a network failure stays silent and
    // gets another chance in the next window instead of retrying on every view.
    defaults.set(checkDate, forKey: Self.lastCheckKey)
    isChecking = true
    defer { isChecking = false }

    var request = URLRequest(url: lookupURL)
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.timeoutInterval = 10
    request.setValue("application/json", forHTTPHeaderField: "Accept")

    do {
      let (data, response) = try await session.data(for: request)
      guard let httpResponse = response as? HTTPURLResponse,
            (200..<300).contains(httpResponse.statusCode) else {
        return
      }
      let lookup = try JSONDecoder().decode(LookupResponse.self, from: data)
      hasChecked = true
      apply(lookup.results.first)
    } catch {
      // Update discovery is best-effort. Do not surface network or decoding
      // failures; the persisted attempt gate schedules the next retry.
    }
  }

  func dismissAvailableUpdate() {
    guard let availableVersion else { return }
    dismissedVersion = availableVersion
    defaults.set(availableVersion, forKey: Self.dismissedVersionKey)
  }

  private func makeLookupURL() -> URL? {
    guard var components = URLComponents(string: "https://itunes.apple.com/lookup") else {
      return nil
    }
    components.queryItems = [URLQueryItem(name: "bundleId", value: bundleIdentifier)]
    return components.url
  }

  private func apply(_ result: LookupResult?) {
    guard let result,
          let version = result.version?.trimmingCharacters(in: .whitespacesAndNewlines),
          !version.isEmpty,
          compareAppVersions(version, currentVersion) == .orderedDescending else {
      clearAvailableUpdate()
      return
    }

    availableVersion = version
    storeURL = result.trackViewUrl.flatMap(URL.init(string:))
    trackId = result.trackId
  }

  private func clearAvailableUpdate() {
    availableVersion = nil
    storeURL = nil
    trackId = nil
  }
}
