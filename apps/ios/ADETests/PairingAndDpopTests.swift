import CryptoKit
import XCTest
import Security
@testable import ADE

private func pairingTestData(hex: String) -> Data {
  var data = Data()
  var index = hex.startIndex
  while index < hex.endIndex {
    let next = hex.index(index, offsetBy: 2)
    data.append(UInt8(hex[index..<next], radix: 16)!)
    index = next
  }
  return data
}

private func requestBodyData(_ request: URLRequest) throws -> Data {
  if let body = request.httpBody {
    return body
  }
  let stream = try XCTUnwrap(request.httpBodyStream)
  stream.open()
  defer { stream.close() }

  var data = Data()
  var buffer = [UInt8](repeating: 0, count: 4_096)
  while true {
    let count = stream.read(&buffer, maxLength: buffer.count)
    if count > 0 {
      data.append(contentsOf: buffer[..<count])
    } else if count == 0 {
      return data
    } else {
      throw stream.streamError ?? URLError(.cannotDecodeRawData)
    }
  }
}

private final class AccountDirectoryURLProtocolStub: URLProtocol {
  private static let lock = NSLock()
  private static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

  static func install(_ nextHandler: @escaping (URLRequest) throws -> (HTTPURLResponse, Data)) {
    lock.lock()
    handler = nextHandler
    lock.unlock()
  }

  static func reset() {
    lock.lock()
    handler = nil
    lock.unlock()
  }

  override class func canInit(with request: URLRequest) -> Bool { true }

  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    Self.lock.lock()
    let handler = Self.handler
    Self.lock.unlock()

    guard let handler else {
      client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
      return
    }
    do {
      let (response, data) = try handler(request)
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: data)
      client?.urlProtocolDidFinishLoading(self)
    } catch {
      client?.urlProtocol(self, didFailWithError: error)
    }
  }

  override func stopLoading() {}
}

private final class AccountDirectoryRequestRecorder: @unchecked Sendable {
  private let lock = NSLock()
  private var authorizationValues: [String] = []

  func append(_ value: String) -> Int {
    lock.lock()
    defer { lock.unlock() }
    authorizationValues.append(value)
    return authorizationValues.count
  }

  func snapshot() -> [String] {
    lock.lock()
    defer { lock.unlock() }
    return authorizationValues
  }
}

private actor AccountDirectoryRefreshRecorder {
  private(set) var count = 0

  func refresh() -> String {
    count += 1
    return "fresh-token"
  }
}

/// Covers the pairing-QR codec (parity with `apps/desktop/src/shared/pairingQr.ts`)
/// and the DPoP challenge/signature contract (parity with
/// `apps/ade-cli/src/services/sync/syncDpop.ts`).
final class PairingAndDpopTests: XCTestCase {
  func testBackgroundPresenceHidesVisibleAttentionUntilForegrounded() {
    var state = AccountAttentionPresenceState()
    state.updateSurface(
      centerVisible: true,
      visibleItemIds: ["approval-1", "question-2"]
    )

    XCTAssertTrue(state.appForeground)
    XCTAssertTrue(state.reportedCenterVisible)
    XCTAssertEqual(state.reportedVisibleItemIds, ["approval-1", "question-2"])

    state.updateAppForeground(false)
    XCTAssertFalse(state.appForeground)
    XCTAssertFalse(state.reportedCenterVisible)
    XCTAssertEqual(state.reportedVisibleItemIds, [])

    state.updateAppForeground(true)
    XCTAssertTrue(state.reportedCenterVisible)
    XCTAssertEqual(state.reportedVisibleItemIds, ["approval-1", "question-2"])
  }

  // A canonical smart URL produced by the TS `encodePairingQrUrl` (includes an
  // unknown extra field to prove lenient forward-compat parsing).
  private let canonicalPairingUrl = "https://ade-app.dev/pair#eyJ2ZXJzaW9uIjozLCJob3N0SWRlbnRpdHkiOnsiZGV2aWNlSWQiOiJkZXYtYWJjMTIzIiwic2l0ZUlkIjoic2l0ZS14eXoiLCJuYW1lIjoiQXJ1bCBNYWNCb29rIiwicGxhdGZvcm0iOiJtYWNPUyIsImRldmljZVR5cGUiOiJkZXNrdG9wIn0sInBvcnQiOjg3ODcsImFkZHJlc3NDYW5kaWRhdGVzIjpbeyJob3N0IjoiMTkyLjE2OC4xLjQyIiwia2luZCI6ImxhbiJ9LHsiaG9zdCI6IjEwMC4xMDEuMTAyLjEwMyIsImtpbmQiOiJ0YWlsc2NhbGUifSx7Imhvc3QiOiJ3c3M6Ly9yZWxheS5hZGUtYXBwLmRldi9jb25uZWN0L21hY2hpbmVrZXkxMjMiLCJraW5kIjoicmVsYXkifV0sInJlbGF5VXJsIjoid3NzOi8vcmVsYXkuYWRlLWFwcC5kZXYvY29ubmVjdC9tYWNoaW5la2V5MTIzIiwiZXh0cmFGdXR1cmVGaWVsZCI6Imlnbm9yZWQifQ"

  // MARK: - Account directory

  func testMachineDirectoryRetriesOnceWithFreshTokenAfterUnauthorized() async throws {
    let requests = AccountDirectoryRequestRecorder()
    let refreshes = AccountDirectoryRefreshRecorder()
    AccountDirectoryURLProtocolStub.install { request in
      let attempt = requests.append(request.value(forHTTPHeaderField: "Authorization") ?? "")
      let status = attempt == 1 ? 401 : 200
      let response = try XCTUnwrap(HTTPURLResponse(
        url: request.url ?? URL(string: "https://directory.example")!,
        statusCode: status,
        httpVersion: nil,
        headerFields: ["Content-Type": "application/json"]
      ))
      let data = status == 200 ? Data(#"{"machines":[]}"#.utf8) : Data()
      return (response, data)
    }
    defer { AccountDirectoryURLProtocolStub.reset() }

    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [AccountDirectoryURLProtocolStub.self]
    let directory = AccountDirectoryClient(session: URLSession(configuration: configuration))

    let machines = try await directory.fetchMachines(
      baseURL: try XCTUnwrap(URL(string: "https://directory.example")),
      token: "stale-token",
      refreshToken: { await refreshes.refresh() }
    )

    let refreshCount = await refreshes.count
    XCTAssertTrue(machines.isEmpty)
    XCTAssertEqual(requests.snapshot(), ["Bearer stale-token", "Bearer fresh-token"])
    XCTAssertEqual(refreshCount, 1)
  }

  func testAccountAttentionRelayFetchesDeltaWithClerkBearer() async throws {
    AccountDirectoryURLProtocolStub.install { request in
      XCTAssertEqual(request.url?.path, "/attention/account/snapshot")
      XCTAssertEqual(request.url?.query, "since=41")
      XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer clerk-token")
      let response = try XCTUnwrap(HTTPURLResponse(
        url: request.url ?? URL(string: "https://relay.example")!,
        statusCode: 200,
        httpVersion: nil,
        headerFields: ["Content-Type": "application/json"]
      ))
      let body = #"""
      {
        "ok": true,
        "contractVersion": 1,
        "revision": 42,
        "generatedAt": "2026-07-28T15:04:05.123Z",
        "items": [{
          "contractVersion": 1,
          "id": "run-1",
          "revision": 3,
          "fingerprint": "run-1:3",
          "kind": "agent",
          "eventKind": "agent_running",
          "phase": "running",
          "machine": {
            "machineKey": "machine-1",
            "name": "Studio Mac",
            "online": true,
            "lastSeenAt": "2026-07-28T15:04:04.999Z"
          },
          "project": {"projectId": "ade", "name": "ADE"},
          "laneId": null,
          "laneName": "Primary",
          "provider": "codex",
          "model": "gpt-5",
          "title": "Polish mobile Activity",
          "preview": "Type checking widgets",
          "privacyPreview": "Agent working",
          "detail": null,
          "recentActivity": [],
          "planProgress": null,
          "destination": {
            "kind": "session",
            "sessionId": "session-1",
            "itemId": null,
            "eventId": "event-2"
          },
          "actions": [{
            "id": "open",
            "kind": "open",
            "label": "Open",
            "payload": {"offset": 12, "exact": true}
          }],
          "occurredAt": "2026-07-28T15:04:00.000Z",
          "updatedAt": "2026-07-28T15:04:05.123Z",
          "seenAt": null,
          "dismissedAt": null,
          "expiresAt": null
        }],
        "tombstones": []
      }
      """#
      return (response, Data(body.utf8))
    }
    defer { AccountDirectoryURLProtocolStub.reset() }

    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [AccountDirectoryURLProtocolStub.self]
    let client = AccountAttentionRelayClient(
      session: URLSession(configuration: configuration)
    )

    let snapshot = try await client.fetchSnapshot(
      baseURL: try XCTUnwrap(URL(string: "https://relay.example")),
      token: "clerk-token",
      since: 41
    )

    XCTAssertEqual(snapshot.revision, 42)
    XCTAssertEqual(snapshot.items.first?.eventKind, .agentRunning)
    XCTAssertEqual(snapshot.items.first?.machine.name, "Studio Mac")
    XCTAssertEqual(
      snapshot.items.first?.destination.deepLinkURL,
      URL(string: "ade://session/session-1?event=event-2")
    )
    XCTAssertNil(snapshot.streamId)
  }

  func testAccountAttentionRelayPropagatesSnapshotStreamIdentity() async throws {
    AccountDirectoryURLProtocolStub.install { request in
      XCTAssertEqual(request.url?.path, "/attention/account/snapshot")
      XCTAssertEqual(request.url?.query, "since=12&streamId=account-stream-a")
      let response = try XCTUnwrap(HTTPURLResponse(
        url: request.url ?? URL(string: "https://relay.example")!,
        statusCode: 200,
        httpVersion: nil,
        headerFields: ["Content-Type": "application/json"]
      ))
      return (
        response,
        Data(
          #"""
          {
            "contractVersion": 1,
            "streamId": "account-stream-a",
            "revision": 13,
            "generatedAt": "2026-07-28T15:04:05.123Z",
            "items": [],
            "tombstones": []
          }
          """#.utf8
        )
      )
    }
    defer { AccountDirectoryURLProtocolStub.reset() }

    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [AccountDirectoryURLProtocolStub.self]
    let client = AccountAttentionRelayClient(
      session: URLSession(configuration: configuration)
    )
    let snapshot = try await client.fetchSnapshot(
      baseURL: try XCTUnwrap(URL(string: "https://relay.example")),
      token: "clerk-token",
      since: 12,
      streamId: "account-stream-a"
    )

    XCTAssertEqual(snapshot.streamId, "account-stream-a")
    XCTAssertEqual(snapshot.revision, 13)
  }

  func testAccountAttentionAcknowledgmentUsesExactItemIds() async throws {
    AccountDirectoryURLProtocolStub.install { request in
      XCTAssertEqual(request.url?.path, "/attention/account/ack")
      XCTAssertEqual(request.httpMethod, "POST")
      XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer clerk-token")
      let body = try requestBodyData(request)
      let payload = try XCTUnwrap(
        try JSONSerialization.jsonObject(with: body) as? [String: Any]
      )
      XCTAssertEqual(payload["itemIds"] as? [String], ["item-a", "item-b"])
      XCTAssertNotNil(payload["seenAt"] as? String)
      XCTAssertNotNil(payload["dismissedAt"] as? String)
      XCTAssertEqual(
        payload["sourceRevisions"] as? [String: Int],
        ["item-a": 7, "item-b": 11]
      )
      XCTAssertEqual(payload["expectedAccountOwnerId"] as? String, "account-a")
      let response = try XCTUnwrap(HTTPURLResponse(
        url: request.url ?? URL(string: "https://relay.example")!,
        statusCode: 200,
        httpVersion: nil,
        headerFields: ["Content-Type": "application/json"]
      ))
      return (
        response,
        Data(
          #"{"ok":true,"revision":9,"applied":["item-a"],"stale":["item-b"]}"#.utf8
        )
      )
    }
    defer { AccountDirectoryURLProtocolStub.reset() }

    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [AccountDirectoryURLProtocolStub.self]
    let client = AccountAttentionRelayClient(
      session: URLSession(configuration: configuration)
    )

    let result = try await client.acknowledge(
      baseURL: try XCTUnwrap(URL(string: "https://relay.example")),
      token: "clerk-token",
      itemIds: ["item-a", "item-b"],
      seenAt: Date(timeIntervalSince1970: 100),
      dismissedAt: Date(timeIntervalSince1970: 101),
      sourceRevisions: ["item-a": 7, "item-b": 11],
      expectedAccountOwnerId: "account-a"
    )
    XCTAssertEqual(result.applied, ["item-a"])
    XCTAssertEqual(result.stale, ["item-b"])
  }

  func testAccountAttentionDevicePreferencesUseScopedPatch() async throws {
    AccountDirectoryURLProtocolStub.install { request in
      XCTAssertEqual(
        request.url?.path,
        "/attention/account/preferences/devices/ios-device"
      )
      XCTAssertEqual(request.httpMethod, "PATCH")
      XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer clerk-token")
      let payload = try XCTUnwrap(
        try JSONSerialization.jsonObject(with: requestBodyData(request)) as? [String: Any]
      )
      XCTAssertEqual(payload["notificationsEnabled"] as? Bool, true)
      XCTAssertEqual(payload["mutedSessionIds"] as? [String], ["session-a"])
      let response = try XCTUnwrap(HTTPURLResponse(
        url: request.url ?? URL(string: "https://relay.example")!,
        statusCode: 200,
        httpVersion: nil,
        headerFields: ["Content-Type": "application/json"]
      ))
      return (response, Data(#"{"ok":true}"#.utf8))
    }
    defer { AccountDirectoryURLProtocolStub.reset() }

    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [AccountDirectoryURLProtocolStub.self]
    let client = AccountAttentionRelayClient(
      session: URLSession(configuration: configuration)
    )
    try await client.updateDevicePreferences(
      baseURL: try XCTUnwrap(URL(string: "https://relay.example")),
      token: "clerk-token",
      deviceId: "ios-device",
      devicePreferences: [
        "notificationsEnabled": true,
        "mutedSessionIds": ["session-a"],
      ]
    )
  }

  func testAccountAttentionActivityTokenUsesAccountScopedRoute() async throws {
    AccountDirectoryURLProtocolStub.install { request in
      XCTAssertEqual(
        request.url?.path,
        "/attention/account/devices/ios-device/activities/agent-runs"
      )
      XCTAssertEqual(request.httpMethod, "PUT")
      XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer clerk-token")
      let body = try requestBodyData(request)
      let payload = try XCTUnwrap(
        try JSONSerialization.jsonObject(with: body) as? [String: String]
      )
      XCTAssertEqual(payload, ["token": "activity-token"])
      let response = try XCTUnwrap(HTTPURLResponse(
        url: request.url ?? URL(string: "https://relay.example")!,
        statusCode: 204,
        httpVersion: nil,
        headerFields: nil
      ))
      return (response, Data())
    }
    defer { AccountDirectoryURLProtocolStub.reset() }

    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [AccountDirectoryURLProtocolStub.self]
    let client = AccountAttentionRelayClient(
      session: URLSession(configuration: configuration)
    )

    try await client.reportActivityToken(
      baseURL: try XCTUnwrap(URL(string: "https://relay.example")),
      token: "clerk-token",
      deviceId: "ios-device",
      activityId: "agent-runs",
      activityToken: "activity-token"
    )
  }

  func testAccountAttentionEmptyActivityTokenDeletesAccountTarget() async throws {
    AccountDirectoryURLProtocolStub.install { request in
      XCTAssertEqual(
        request.url?.path,
        "/attention/account/devices/ios-device/activities/agent-runs"
      )
      XCTAssertEqual(request.httpMethod, "DELETE")
      XCTAssertNil(request.httpBody)
      let response = try XCTUnwrap(HTTPURLResponse(
        url: request.url ?? URL(string: "https://relay.example")!,
        statusCode: 204,
        httpVersion: nil,
        headerFields: nil
      ))
      return (response, Data())
    }
    defer { AccountDirectoryURLProtocolStub.reset() }

    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [AccountDirectoryURLProtocolStub.self]
    let client = AccountAttentionRelayClient(
      session: URLSession(configuration: configuration)
    )

    try await client.reportActivityToken(
      baseURL: try XCTUnwrap(URL(string: "https://relay.example")),
      token: "clerk-token",
      deviceId: "ios-device",
      activityId: "agent-runs",
      activityToken: "  "
    )
  }

  func testAccountAttentionUnregisterDeletesOnlyCurrentDevice() async throws {
    AccountDirectoryURLProtocolStub.install { request in
      XCTAssertEqual(
        request.url?.path,
        "/attention/account/devices/ios-device"
      )
      XCTAssertEqual(request.httpMethod, "DELETE")
      XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer clerk-token")
      XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
      let body = try requestBodyData(request)
      let payload = try XCTUnwrap(
        JSONSerialization.jsonObject(with: body) as? [String: Any]
      )
      XCTAssertEqual(payload["ownershipEpoch"] as? Int, 17)
      let response = try XCTUnwrap(HTTPURLResponse(
        url: request.url ?? URL(string: "https://relay.example")!,
        statusCode: 204,
        httpVersion: nil,
        headerFields: nil
      ))
      return (response, Data())
    }
    defer { AccountDirectoryURLProtocolStub.reset() }

    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [AccountDirectoryURLProtocolStub.self]
    let client = AccountAttentionRelayClient(
      session: URLSession(configuration: configuration)
    )

    try await client.unregisterDevice(
      baseURL: try XCTUnwrap(URL(string: "https://relay.example")),
      token: "clerk-token",
      deviceId: "ios-device",
      ownershipEpoch: 17
    )
  }

  func testAccountAttentionRegistrationIncludesOwnershipEpoch() async throws {
    AccountDirectoryURLProtocolStub.install { request in
      XCTAssertEqual(
        request.url?.path,
        "/attention/account/devices/ios-device"
      )
      XCTAssertEqual(request.httpMethod, "PUT")
      let body = try requestBodyData(request)
      let payload = try XCTUnwrap(
        JSONSerialization.jsonObject(with: body) as? [String: Any]
      )
      XCTAssertEqual(payload["ownershipEpoch"] as? Int, 23)
      XCTAssertEqual(payload["apnsToken"] as? String, "apns-token")
      XCTAssertNil(payload["pushToStartToken"])
      XCTAssertNil(payload["clearPushToStartToken"])
      let response = try XCTUnwrap(HTTPURLResponse(
        url: request.url ?? URL(string: "https://relay.example")!,
        statusCode: 204,
        httpVersion: nil,
        headerFields: nil
      ))
      return (response, Data())
    }
    defer { AccountDirectoryURLProtocolStub.reset() }

    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [AccountDirectoryURLProtocolStub.self]
    let client = AccountAttentionRelayClient(
      session: URLSession(configuration: configuration)
    )

    try await client.registerDevice(
      baseURL: try XCTUnwrap(URL(string: "https://relay.example")),
      token: "clerk-token",
      deviceId: "ios-device",
      ownershipEpoch: 23,
      apnsToken: "apns-token",
      pushToStartToken: nil,
      bundleId: "com.ade.ios",
      apsEnvironment: "development",
      deviceName: "iPhone",
      preferences: [:]
    )
  }

  func testAccountAttentionRegistrationSerializesExplicitPushToStartClear() async throws {
    AccountDirectoryURLProtocolStub.install { request in
      let body = try requestBodyData(request)
      let payload = try XCTUnwrap(
        JSONSerialization.jsonObject(with: body) as? [String: Any]
      )
      XCTAssertEqual(payload["clearPushToStartToken"] as? Bool, true)
      XCTAssertNil(payload["pushToStartToken"])
      let response = try XCTUnwrap(HTTPURLResponse(
        url: request.url ?? URL(string: "https://relay.example")!,
        statusCode: 204,
        httpVersion: nil,
        headerFields: nil
      ))
      return (response, Data())
    }
    defer { AccountDirectoryURLProtocolStub.reset() }

    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [AccountDirectoryURLProtocolStub.self]
    let client = AccountAttentionRelayClient(
      session: URLSession(configuration: configuration)
    )

    try await client.registerDevice(
      baseURL: try XCTUnwrap(URL(string: "https://relay.example")),
      token: "clerk-token",
      deviceId: "ios-device",
      ownershipEpoch: 23,
      apnsToken: nil,
      pushToStartToken: nil,
      clearPushToStartToken: true,
      bundleId: "com.ade.ios",
      apsEnvironment: "development",
      deviceName: "iPhone",
      preferences: [:]
    )
  }

  func testAccountAttentionRegistrationRejectsPushToStartSetAndClearConflict() async throws {
    let client = AccountAttentionRelayClient()
    do {
      try await client.registerDevice(
        baseURL: try XCTUnwrap(URL(string: "https://relay.example")),
        token: "clerk-token",
        deviceId: "ios-device",
        ownershipEpoch: 23,
        apnsToken: nil,
        pushToStartToken: "ab",
        clearPushToStartToken: true,
        bundleId: "com.ade.ios",
        apsEnvironment: "development",
        deviceName: "iPhone",
        preferences: [:]
      )
      XCTFail("Expected conflicting push-to-start mutation to be rejected")
    } catch let error as AccountAttentionRelayClient.RelayError {
      XCTAssertEqual(error, .transport)
    }
  }

  func testAccountAttentionDeviceMutationsRejectInvalidOwnershipEpochs() async throws {
    let requests = AccountDirectoryRequestRecorder()
    AccountDirectoryURLProtocolStub.install { request in
      _ = requests.append(request.httpMethod ?? "")
      let response = try XCTUnwrap(HTTPURLResponse(
        url: request.url ?? URL(string: "https://relay.example")!,
        statusCode: 500,
        httpVersion: nil,
        headerFields: nil
      ))
      return (response, Data())
    }
    defer { AccountDirectoryURLProtocolStub.reset() }

    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [AccountDirectoryURLProtocolStub.self]
    let client = AccountAttentionRelayClient(
      session: URLSession(configuration: configuration)
    )
    let baseURL = try XCTUnwrap(URL(string: "https://relay.example"))
    let invalidEpochs = [
      0,
      -1,
      AccountDeviceOwnershipState.maximumSafeEpoch + 1,
    ]

    for ownershipEpoch in invalidEpochs {
      do {
        try await client.registerDevice(
          baseURL: baseURL,
          token: "clerk-token",
          deviceId: "ios-device",
          ownershipEpoch: ownershipEpoch,
          apnsToken: "apns-token",
          pushToStartToken: nil,
          bundleId: "com.ade.ios",
          apsEnvironment: "development",
          deviceName: "iPhone",
          preferences: [:]
        )
        XCTFail("Expected invalid registration ownership epoch \(ownershipEpoch)")
      } catch let error as AccountAttentionRelayClient.RelayError {
        XCTAssertEqual(error, .transport)
      }

      do {
        try await client.unregisterDevice(
          baseURL: baseURL,
          token: "clerk-token",
          deviceId: "ios-device",
          ownershipEpoch: ownershipEpoch
        )
        XCTFail("Expected invalid deletion ownership epoch \(ownershipEpoch)")
      } catch let error as AccountAttentionRelayClient.RelayError {
        XCTAssertEqual(error, .transport)
      }
    }

    XCTAssertEqual(requests.snapshot(), [], "invalid epochs must fail before network I/O")
  }

  func testAccountAttentionConflictIsNonRetryableStaleOwnership() async throws {
    AccountDirectoryURLProtocolStub.install { request in
      let response = try XCTUnwrap(HTTPURLResponse(
        url: request.url ?? URL(string: "https://relay.example")!,
        statusCode: 409,
        httpVersion: nil,
        headerFields: nil
      ))
      return (response, Data())
    }
    defer { AccountDirectoryURLProtocolStub.reset() }

    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [AccountDirectoryURLProtocolStub.self]
    let client = AccountAttentionRelayClient(
      session: URLSession(configuration: configuration)
    )

    do {
      try await client.unregisterDevice(
        baseURL: try XCTUnwrap(URL(string: "https://relay.example")),
        token: "clerk-token",
        deviceId: "ios-device",
        ownershipEpoch: 4
      )
      XCTFail("Expected stale ownership")
    } catch let error as AccountAttentionRelayClient.RelayError {
      XCTAssertEqual(error, .staleOwnership)
    }
  }

  func testPendingAccountDeviceRevocationPersistsUntilMatchingSuccess() throws {
    let suiteName = "PairingAndDpopTests.revocation.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let key = "pending-revocation"
    let store = AccountDeviceRevocationStore(defaults: defaults, key: key)
    let createdAt = Date(timeIntervalSince1970: 1_700_000_000)

    let pending = try XCTUnwrap(
      store.mark(
        ownerId: "user-a",
        deviceId: "ios-device",
        ownershipEpoch: 2,
        now: createdAt
      )
    )
    XCTAssertEqual(
      AccountDeviceRevocationStore(defaults: defaults, key: key).pending,
      pending
    )
    XCTAssertEqual(
      store.mark(ownerId: "user-a", deviceId: "ios-device", ownershipEpoch: 1),
      pending,
      "An older boundary must not replace a newer pending revocation"
    )

    let different = PendingAccountDeviceRevocation(
      ownerId: "user-b",
      deviceId: "ios-device",
      ownershipEpoch: 3,
      createdAt: createdAt
    )
    store.clear(ifMatching: different)
    XCTAssertEqual(store.pending, pending)
    store.clear(ifMatching: pending)
    XCTAssertNil(store.pending)
  }

  func testAccountDeviceOwnershipEpochPersistsAcrossSignOutAndAccountSwitch() throws {
    let suiteName = "PairingAndDpopTests.ownership.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let key = "ownership"
    let store = AccountDeviceOwnershipStore(defaults: defaults, key: key)

    let accountA = store.transition(to: "user-a")
    XCTAssertEqual(accountA, AccountDeviceOwnershipState(ownershipEpoch: 2, ownerId: "user-a"))
    XCTAssertEqual(store.transition(to: "user-a"), accountA)

    let signedOut = store.transition(to: nil)
    XCTAssertEqual(signedOut.ownershipEpoch, 3)
    XCTAssertNil(signedOut.ownerId)

    let accountB = store.transition(to: "user-b")
    XCTAssertEqual(accountB.ownershipEpoch, 4)
    XCTAssertEqual(accountB.ownerId, "user-b")
    XCTAssertEqual(
      AccountDeviceOwnershipStore(defaults: defaults, key: key).state,
      accountB
    )
    XCTAssertLessThanOrEqual(
      accountB.ownershipEpoch,
      AccountDeviceOwnershipState.maximumSafeEpoch
    )
    XCTAssertFalse(
      accountDeviceMutationMatchesCurrentOwnership(
        ownerId: accountA.ownerId ?? "",
        ownershipEpoch: accountA.ownershipEpoch,
        state: accountB
      ),
      "A delayed account-A request cannot become effective after sign-out and account-B login"
    )
    XCTAssertTrue(
      accountDeviceMutationMatchesCurrentOwnership(
        ownerId: "user-b",
        ownershipEpoch: accountB.ownershipEpoch,
        state: accountB
      )
    )
  }

  func testAccountDeviceOwnershipEpochRecoversAfterAppGroupReset() throws {
    let suiteName = "PairingAndDpopTests.ownership-reinstall.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let key = "ownership"
    let deviceId = "durable-device"
    var durableEpochs: [String: Int] = [:]
    let makeStore = {
      AccountDeviceOwnershipStore(
        defaults: defaults,
        key: key,
        durableDeviceId: { deviceId },
        loadDurableEpoch: { durableEpochs[$0] },
        saveDurableEpoch: { durableEpochs[$1] = $0 }
      )
    }

    let original = makeStore()
    XCTAssertEqual(original.transition(to: "user-a").ownershipEpoch, 2)
    XCTAssertEqual(original.transition(to: nil).ownershipEpoch, 3)
    XCTAssertEqual(durableEpochs[deviceId], 3)

    defaults.removeObject(forKey: key)
    let reinstalled = makeStore()
    XCTAssertEqual(
      reinstalled.state,
      AccountDeviceOwnershipState(ownershipEpoch: 3, ownerId: nil),
      "A reset App Group must recover the high-water mark without restoring a stale owner"
    )
    XCTAssertEqual(
      reinstalled.transition(to: "user-a"),
      AccountDeviceOwnershipState(ownershipEpoch: 4, ownerId: "user-a"),
      "The surviving device identity must advance past Relay's prior ownership epoch"
    )
  }

  @MainActor
  func testAccountRegistrationSerializesDelayedAThenRunsLatestB() async {
    let queue = LatestAccountRegistrationQueue<String>()
    var starts: [String] = []
    var activeCount = 0
    var maximumActiveCount = 0
    var releaseAccountA: CheckedContinuation<Void, Never>?

    let perform: @MainActor (String) async -> Bool = { owner in
      starts.append(owner)
      activeCount += 1
      maximumActiveCount = max(maximumActiveCount, activeCount)
      if owner == "account-a" {
        await withCheckedContinuation { continuation in
          releaseAccountA = continuation
        }
      }
      activeCount -= 1
      return true
    }

    let accountA = Task { @MainActor in
      await queue.submit("account-a", perform: perform)
    }
    while starts.isEmpty {
      await Task.yield()
    }
    let staleAccountBRefresh = Task { @MainActor in
      await queue.submit("account-b-stale-refresh", perform: perform)
    }
    await Task.yield()
    let accountB = Task { @MainActor in
      await queue.submit("account-b", perform: perform)
    }
    for _ in 0..<8 {
      await Task.yield()
    }

    XCTAssertEqual(starts, ["account-a"])
    XCTAssertEqual(maximumActiveCount, 1)
    releaseAccountA?.resume()
    _ = await (accountA.value, staleAccountBRefresh.value, accountB.value)

    XCTAssertEqual(starts, ["account-a", "account-b"])
    XCTAssertEqual(maximumActiveCount, 1)
  }

  func testAccountActivityTokenRetryPreservesAccountOnlyIdentityAndEmptyDelete() throws {
    let suiteName = "PairingAndDpopTests.activity-token.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let key = "pending-account-token"
    let store = AccountActivityTokenRegistrationStore(defaults: defaults, key: key)

    let pending = try XCTUnwrap(
      store.persist(
        deviceId: "ios-device",
        activityId: "agent-runs",
        token: "  "
      )
    )

    XCTAssertTrue(pending.accountWide)
    XCTAssertEqual(pending.token, "")
    XCTAssertEqual(
      AccountActivityTokenRegistrationStore(defaults: defaults, key: key).pending,
      pending
    )
    XCTAssertEqual(liveActivityTokenRoute(accountWide: true), .accountOnly)
    XCTAssertEqual(liveActivityTokenRoute(accountWide: false), .pairedMachine)
  }

  func testAccountWideLiveActivityWaitsForClerkBeforeChoosingPrivacyBoundary() {
    XCTAssertEqual(
      accountWideActivityObservationAction(
        phase: .loading,
        accountObserversSuspended: false
      ),
      .waitForAccount,
      "A push-to-start wake must survive cached Clerk session restoration"
    )
    XCTAssertEqual(
      accountWideActivityObservationAction(
        phase: .signedIn,
        accountObserversSuspended: false
      ),
      .observe
    )
    for phase in [AccountService.Phase.signedOut, .unconfigured] {
      XCTAssertEqual(
        accountWideActivityObservationAction(
          phase: phase,
          accountObserversSuspended: false
        ),
        .end
      )
    }
    XCTAssertEqual(
      accountWideActivityObservationAction(
        phase: .loading,
        accountObserversSuspended: true
      ),
      .end,
      "An explicit sign-out or account switch remains an immediate privacy boundary"
    )
  }

  func testAccountWideLiveActivityRejectsStaleOwnershipEpochs() {
    let firstOwner = AccountDeviceOwnershipState(
      ownershipEpoch: 2,
      ownerId: "user-a"
    )
    XCTAssertTrue(
      accountWideActivityMatchesCurrentOwnership(
        attributesEpoch: nil,
        contentEpoch: nil,
        currentOwnership: firstOwner
      ),
      "The first owner remains compatible with a legacy relay during rollout"
    )

    let switchedOwner = AccountDeviceOwnershipState(
      ownershipEpoch: 4,
      ownerId: "user-b"
    )
    XCTAssertTrue(
      accountWideActivityMatchesCurrentOwnership(
        attributesEpoch: 4,
        contentEpoch: 4,
        currentOwnership: switchedOwner
      )
    )
    for epochs in [
      (attributes: Int?.none, content: Int?.none),
      (attributes: 2, content: 2),
      (attributes: 4, content: Int?.none),
      (attributes: Int?.none, content: 4),
      (attributes: 4, content: 5),
    ] {
      XCTAssertFalse(
        accountWideActivityMatchesCurrentOwnership(
          attributesEpoch: epochs.attributes,
          contentEpoch: epochs.content,
          currentOwnership: switchedOwner
        ),
        "Accepted stale or partially fenced ownership \(String(describing: epochs))"
      )
    }
    XCTAssertFalse(
      accountWideActivityMatchesCurrentOwnership(
        attributesEpoch: 4,
        contentEpoch: 4,
        currentOwnership: AccountDeviceOwnershipState(
          ownershipEpoch: 4,
          ownerId: nil
        )
      ),
      "An unowned installation cannot display account activity"
    )
  }

  func testAccountWideLiveActivityKeepsFreshestDuplicateDeterministically() {
    XCTAssertEqual(
      preferredAccountWideActivityId([
        AccountWideActivityCandidate(id: "old", updatedAt: 100),
        AccountWideActivityCandidate(id: "fresh", updatedAt: 200),
      ]),
      "fresh"
    )
    XCTAssertEqual(
      preferredAccountWideActivityId([
        AccountWideActivityCandidate(id: "activity-a", updatedAt: 200),
        AccountWideActivityCandidate(id: "activity-b", updatedAt: 200),
      ]),
      "activity-b",
      "Equal timestamps still need one stable target"
    )
    XCTAssertNil(preferredAccountWideActivityId([]))
  }

  func testPushToStartRegistrationDoesNotRequireNotificationApnsToken() {
    XCTAssertTrue(
      pushRegistrationRequiredAfterLiveActivityTokenChange(
        hasApnsToken: false,
        hasSignedInAccount: true,
        hasPairedHost: false
      ),
      "An account device must register ActivityKit independently of notification alerts"
    )
    XCTAssertTrue(
      pushRegistrationRequiredAfterLiveActivityTokenChange(
        hasApnsToken: false,
        hasSignedInAccount: false,
        hasPairedHost: true
      ),
      "A paired device must register ActivityKit independently of notification alerts"
    )
    XCTAssertFalse(
      pushRegistrationRequiredAfterLiveActivityTokenChange(
        hasApnsToken: false,
        hasSignedInAccount: false,
        hasPairedHost: false
      )
    )
  }

  func testFreshPushToStartTokenWinsOverPendingClearMutation() {
    XCTAssertEqual(
      pushToStartTokenRegistrationMutation(
        token: "fresh-token",
        clearPending: true
      ),
      PushToStartTokenRegistrationMutation(
        token: "fresh-token",
        clear: false
      )
    )
    XCTAssertEqual(
      pushToStartTokenRegistrationMutation(
        token: nil,
        clearPending: true
      ),
      PushToStartTokenRegistrationMutation(
        token: nil,
        clear: true
      )
    )
  }

  @MainActor
  func testPushPreferenceSyncRetriesUntilSuccessWithBoundedBackoff() async {
    var attempts = 0
    var delays: [UInt64] = []
    let retrier = PushPreferenceSyncRetrier { nanoseconds in
      delays.append(nanoseconds)
    }

    let task = retrier.start {
      attempts += 1
      return attempts == 3
    }
    await task.value

    XCTAssertEqual(attempts, 3)
    XCTAssertEqual(delays, [5_000_000_000, 10_000_000_000])
  }

  @MainActor
  func testPushPreferenceSyncCancellationStopsFurtherAttempts() async {
    var attempts = 0
    let retrier = PushPreferenceSyncRetrier { _ in
      try? await Task.sleep(nanoseconds: 1_000_000_000)
    }
    let task = retrier.start {
      attempts += 1
      return false
    }
    while attempts == 0 {
      await Task.yield()
    }

    retrier.cancel()
    await task.value
    XCTAssertEqual(attempts, 1)
  }

  func testAgentRunsActivityRecognizesAccountWideAndLegacyMarkers() {
    let fenced = ADEAgentRunsAttributes(
      machineName: "Studio Mac",
      accountWide: true,
      ownershipEpoch: 7
    )
    XCTAssertTrue(fenced.isAccountWide)
    XCTAssertEqual(fenced.ownershipEpoch, 7)
    XCTAssertEqual(
      ADEAgentRunsAttributes.ContentState(
        updatedAt: 100,
        activeCount: 1,
        runs: [],
        ownershipEpoch: 7
      ).ownershipEpoch,
      7
    )
    XCTAssertTrue(
      ADEAgentRunsAttributes(machineName: "All machines").isAccountWide
    )
    for legacyMarker in ["All machines", "account"] {
      XCTAssertFalse(
        ADEAgentRunsAttributes(
          machineName: legacyMarker,
          accountWide: false
        ).isAccountWide
      )
    }
  }

  // MARK: - Sealed account adoption

  func testAdoptChannelMatchesTypeScriptChaChaPolyVector() throws {
    // Fixed vector from
    // apps/desktop/src/shared/sync/adoptChannelCrypto.test.ts.
    let clientPrivateKey = try Curve25519.KeyAgreement.PrivateKey(
      rawRepresentation: pairingTestData(
        hex: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
      )
    )
    XCTAssertEqual(
      clientPrivateKey.publicKey.rawRepresentation,
      pairingTestData(
        hex: "8f40c5adb68f25624ae5b214ea767a6ec94d829d3d7b5e1ad1ba6f3e2138285f"
      )
    )
    let hostPublicKey = pairingTestData(
      hex: "358072d6365880d1aeea329adf9121383851ed21a28e3b75e965d0d2cd166254"
    )
    let nonce = pairingTestData(
      hex: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
    )
    let sessionKey = try AdoptChannelCrypto.deriveSessionKey(
      clientPrivateKey: clientPrivateKey,
      hostPublicKeyRaw: hostPublicKey,
      nonce: nonce
    )
    let sessionKeyData = sessionKey.withUnsafeBytes { Data($0) }
    XCTAssertEqual(
      sessionKeyData,
      pairingTestData(
        hex: "73dd8c3462d2bd6af30580cd4147d5049e6b96d6e0caad0abb512e47ea9c056e"
      )
    )

    let sealed =
      "AAECAwQFBgcICQoL2ZbKNSOix6tRlgt6GSfO7OGy0Pp8/04VMGCtmGI+2K5fKpJv27j0R8un/fPj0v1aEAizUH3l7uZ6nwS6WM8f+GJfCvAcH6bo1KfPq04vbY2jLUSXuYo="
    let plaintext = try AdoptChannelCrypto.unseal(
      sealed,
      key: sessionKey,
      aad: Data("ade-adopt-v1|host-vector|client-vector".utf8)
    )
    XCTAssertEqual(
      String(decoding: plaintext, as: UTF8.self),
      #"{"deviceId":"client-vector","accountToken":"token-vector","dpop":null}"#
    )

    XCTAssertEqual(
      AdoptChannelCrypto.challengeSignatureInput(
        hostDeviceId: "host-device",
        nonce: "bm9uY2U=",
        clientEphemeralPublicKey: "Y2xpZW50",
        hostEphemeralPublicKey: "aG9zdA==",
        timestampMilliseconds: 1_783_500_123_456
      ),
      "ade-adopt-v1|host-device|bm9uY2U=|Y2xpZW50|aG9zdA==|1783500123456"
    )
  }

  func testAdoptChannelMatchesTypeScriptAESGCMVectorAndNegotiatedSignature() throws {
    XCTAssertEqual(
      AdoptChannelCrypto.supportedAeads,
      [.chacha20Poly1305, .aes256Gcm]
    )
    let sessionKey = SymmetricKey(
      data: pairingTestData(
        hex: "73dd8c3462d2bd6af30580cd4147d5049e6b96d6e0caad0abb512e47ea9c056e"
      )
    )
    let sealed =
      "AAECAwQFBgcICQoL3y2dKj5Mf5T1oCPmxekaK7cism6xBa4nVL2OXy7fjrsrUJkqDISXnL4xejxcZFKlg0QtQ3ojlneNBDLJJAvf/QBwppTjKydmgm8J65KHSjtbCdNoJFo="
    let plaintext = try AdoptChannelCrypto.unseal(
      sealed,
      key: sessionKey,
      aad: Data("ade-adopt-v1|host-vector|client-vector".utf8),
      aead: .aes256Gcm
    )
    XCTAssertEqual(
      String(decoding: plaintext, as: UTF8.self),
      #"{"deviceId":"client-vector","accountToken":"token-vector","dpop":null}"#
    )
    XCTAssertEqual(
      AdoptChannelCrypto.challengeSignatureInput(
        hostDeviceId: "host-device",
        nonce: "bm9uY2U=",
        clientEphemeralPublicKey: "Y2xpZW50",
        hostEphemeralPublicKey: "aG9zdA==",
        timestampMilliseconds: 1_783_500_123_456,
        aead: .aes256Gcm
      ),
      "ade-adopt-v1|host-device|bm9uY2U=|Y2xpZW50|aG9zdA==|1783500123456|aes-256-gcm"
    )
  }

  func testAdoptChannelAcceptsNegotiatedAndLegacyHostCipherSelections() throws {
    XCTAssertEqual(
      try AdoptChannelCrypto.resolveHostAead(nil),
      .chacha20Poly1305
    )
    XCTAssertEqual(
      try AdoptChannelCrypto.resolveHostAead("aes-256-gcm"),
      .aes256Gcm
    )
    XCTAssertThrowsError(
      try AdoptChannelCrypto.resolveHostAead("future-aead")
    )
    XCTAssertThrowsError(
      try AdoptChannelCrypto.resolveHostAead(NSNull())
    )
  }

  func testAdoptChannelRejectsPresentMalformedDirectorySigningKey() throws {
    XCTAssertNil(
      try AdoptChannelCrypto.signingPublicKey(fromOptionalDirectoryValue: nil)
    )
    XCTAssertThrowsError(
      try AdoptChannelCrypto.signingPublicKey(fromOptionalDirectoryValue: "")
    )
    XCTAssertThrowsError(
      try AdoptChannelCrypto.signingPublicKey(fromOptionalDirectoryValue: "   ")
    )
    XCTAssertThrowsError(
      try AdoptChannelCrypto.signingPublicKey(
        fromOptionalDirectoryValue: "ed25519:not-canonical-base64"
      )
    )
  }

  // MARK: - Pairing QR codec

  func testParsesCanonicalSmartUrl() throws {
    let payload = try XCTUnwrap(PairingQrPayload.parse(canonicalPairingUrl))
    XCTAssertEqual(payload.version, 3)
    XCTAssertEqual(payload.hostIdentity.deviceId, "dev-abc123")
    XCTAssertEqual(payload.hostIdentity.siteId, "site-xyz")
    XCTAssertEqual(payload.hostIdentity.name, "Arul MacBook")
    XCTAssertEqual(payload.hostIdentity.platform, "macOS")
    XCTAssertEqual(payload.hostIdentity.deviceType, "desktop")
    XCTAssertEqual(payload.port, 8787)
    XCTAssertEqual(payload.addressCandidates.count, 3)
    XCTAssertEqual(payload.addressCandidates[0], PairingQrAddressCandidate(host: "192.168.1.42", kind: "lan"))
    XCTAssertEqual(payload.addressCandidates[1], PairingQrAddressCandidate(host: "100.101.102.103", kind: "tailscale"))
    // Relay candidate carries a full wss:// URL in `host`.
    XCTAssertEqual(payload.addressCandidates[2], PairingQrAddressCandidate(host: "wss://relay.ade-app.dev/connect/machinekey123", kind: "relay"))
    XCTAssertEqual(payload.relayUrl, "wss://relay.ade-app.dev/connect/machinekey123")
    XCTAssertNil(payload.pinConfigured)
  }

  func testParsesBareFragmentPayload() throws {
    // The base64url payload alone (no URL wrapper) must also parse.
    let fragment = try XCTUnwrap(canonicalPairingUrl.split(separator: "#").last).description
    let payload = try XCTUnwrap(PairingQrPayload.parse(fragment))
    XCTAssertEqual(payload.hostIdentity.deviceId, "dev-abc123")
  }

  func testParsesRawJson() throws {
    let json = #"{"version":3,"hostIdentity":{"deviceId":"d1","name":"Box","platform":"linux","deviceType":"vps"},"port":9000,"addressCandidates":[]}"#
    let payload = try XCTUnwrap(PairingQrPayload.parse(json))
    XCTAssertEqual(payload.hostIdentity.deviceId, "d1")
    XCTAssertEqual(payload.port, 9000)
    XCTAssertNil(payload.relayUrl)
  }

  func testDropsNonWssRelayUrl() throws {
    let json = #"{"version":3,"hostIdentity":{"deviceId":"d1","name":"Box"},"port":8787,"addressCandidates":[],"relayUrl":"ws://relay.ade-app.dev/x"}"#
    let payload = try XCTUnwrap(PairingQrPayload.parse(json))
    XCTAssertNil(payload.relayUrl)
  }

  func testParsesOptionalLiteralPinConfiguredHint() throws {
    let configured = #"{"version":3,"hostIdentity":{"deviceId":"d1","name":"Box"},"port":8787,"addressCandidates":[],"pinConfigured":true}"#
    let notConfigured = #"{"version":3,"hostIdentity":{"deviceId":"d1","name":"Box"},"port":8787,"addressCandidates":[],"pinConfigured":false}"#
    let absent = #"{"version":3,"hostIdentity":{"deviceId":"d1","name":"Box"},"port":8787,"addressCandidates":[]}"#
    let invalid = #"{"version":3,"hostIdentity":{"deviceId":"d1","name":"Box"},"port":8787,"addressCandidates":[],"pinConfigured":"false"}"#
    let numeric = #"{"version":3,"hostIdentity":{"deviceId":"d1","name":"Box"},"port":8787,"addressCandidates":[],"pinConfigured":1}"#

    XCTAssertEqual(try XCTUnwrap(PairingQrPayload.parse(configured)).pinConfigured, true)
    XCTAssertEqual(try XCTUnwrap(PairingQrPayload.parse(notConfigured)).pinConfigured, false)
    XCTAssertNil(try XCTUnwrap(PairingQrPayload.parse(absent)).pinConfigured)
    XCTAssertNil(try XCTUnwrap(PairingQrPayload.parse(invalid)).pinConfigured)
    XCTAssertNil(try XCTUnwrap(PairingQrPayload.parse(numeric)).pinConfigured)
  }

  func testRejectsOlderVersion() {
    let json = #"{"version":2,"hostIdentity":{"deviceId":"d1","name":"Box"},"port":8787,"addressCandidates":[]}"#
    XCTAssertNil(PairingQrPayload.parse(json))
  }

  func testRejectsMissingDeviceId() {
    let json = #"{"version":3,"hostIdentity":{"name":"Box"},"port":8787,"addressCandidates":[]}"#
    XCTAssertNil(PairingQrPayload.parse(json))
  }

  func testRejectsInvalidPort() {
    let json = #"{"version":3,"hostIdentity":{"deviceId":"d1","name":"Box"},"port":0,"addressCandidates":[]}"#
    XCTAssertNil(PairingQrPayload.parse(json))
  }

  func testRejectsGarbage() {
    XCTAssertNil(PairingQrPayload.parse("not a code"))
    XCTAssertNil(PairingQrPayload.parse(""))
    XCTAssertNil(PairingQrPayload.parse("https://ade-app.dev/pair"))
  }

  func testNormalizesUnknownPlatformAndDeviceType() throws {
    let json = #"{"version":3,"hostIdentity":{"deviceId":"d1","name":"Box","platform":"beos","deviceType":"toaster"},"port":8787,"addressCandidates":[]}"#
    let payload = try XCTUnwrap(PairingQrPayload.parse(json))
    XCTAssertEqual(payload.hostIdentity.platform, "unknown")
    XCTAssertEqual(payload.hostIdentity.deviceType, "unknown")
  }

  func testPairingFailureCodesMapPinNotSetToTypedState() {
    XCTAssertEqual(SyncPairingFailureCode(hostCode: "pin_not_set"), .pinNotSet)
    XCTAssertEqual(SyncPairingFailureCode(hostCode: "invalid_pin"), .invalidPin)
    XCTAssertEqual(SyncPairingFailureCode(hostCode: "new_host_code"), .other("new_host_code"))
    XCTAssertNil(SyncPairingFailureCode(hostCode: nil))
    XCTAssertEqual(SyncPairingFailureCode.pinNotSet.hostCode, "pin_not_set")
  }

  // MARK: - DPoP challenge + signature

  func testChallengeBuilderMatchesRuntimeFormat() {
    let secretSha256Hex = "33e29618af5c636e782cfadefb698192ef7b2d8e5567d3c8cf560f61697cc6f5" // gitleaks:allow — test fixture
    let challenge = DpopKeyService.buildChallenge(
      deviceId: "dev-abc123",
      secretSha256Hex: secretSha256Hex,
      timestamp: 1_700_000_000,
      nonce: "nonce-1"
    )
    XCTAssertEqual(
      challenge,
      "ade-dpop-v1\ndev-abc123\n\(secretSha256Hex)\n1700000000\nnonce-1"
    )
  }

  func testSha256HexMatchesRuntime() {
    XCTAssertEqual(
      DpopKeyService.sha256Hex("test-secret-123"),
      "33e29618af5c636e782cfadefb698192ef7b2d8e5567d3c8cf560f61697cc6f5"
    )
  }

  func testProofSignsAndVerifies() throws {
    let deviceId = "dev-roundtrip"
    let secret = "paired-secret-value"
    let proof = try XCTUnwrap(DpopKeyService.shared.buildProof(deviceId: deviceId, secret: secret))

    let publicKeyB64 = try XCTUnwrap(proof["publicKey"] as? String)
    let signatureB64 = try XCTUnwrap(proof["signature"] as? String)
    let timestamp = try XCTUnwrap(proof["timestamp"] as? Int)
    let nonce = try XCTUnwrap(proof["nonce"] as? String)

    // Public key is X9.63 uncompressed P-256 (65 bytes, 0x04 prefix).
    let publicKeyData = try XCTUnwrap(Data(base64Encoded: publicKeyB64))
    XCTAssertEqual(publicKeyData.count, 65)
    XCTAssertEqual(publicKeyData.first, 0x04)

    let signatureData = try XCTUnwrap(Data(base64Encoded: signatureB64))
    let challenge = DpopKeyService.buildChallenge(
      deviceId: deviceId,
      secretSha256Hex: DpopKeyService.sha256Hex(secret),
      timestamp: timestamp,
      nonce: nonce
    )

    let attributes: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeyClass as String: kSecAttrKeyClassPublic,
      kSecAttrKeySizeInBits as String: 256,
    ]
    var error: Unmanaged<CFError>?
    let publicKey = try XCTUnwrap(
      SecKeyCreateWithData(publicKeyData as CFData, attributes as CFDictionary, &error)
    )
    let verified = SecKeyVerifySignature(
      publicKey,
      .ecdsaSignatureMessageX962SHA256,
      Data(challenge.utf8) as CFData,
      signatureData as CFData,
      &error
    )
    XCTAssertTrue(verified, "DPoP signature must verify against the advertised public key")

    // A tampered challenge must not verify.
    let tampered = SecKeyVerifySignature(
      publicKey,
      .ecdsaSignatureMessageX962SHA256,
      Data((challenge + "x").utf8) as CFData,
      signatureData as CFData,
      &error
    )
    XCTAssertFalse(tampered)
  }

  func testRelayReauthorizationChallengeMatchesSharedCanonicalContext() {
    let tokenHash = DpopKeyService.sha256Hex("exact-token-bytes")
    XCTAssertEqual(
      DpopKeyService.buildRelayReauthorizationChallenge(
        deviceId: "phone-1",
        relayAccountTokenSha256Hex: tokenHash,
        challenge: "connection-challenge",
        timestamp: 1_700_000_001,
        nonce: "nonce-reauth"
      ),
      "ade-relay-reauth-v1\nphone-1\n\(tokenHash)\nconnection-challenge\n1700000001\nnonce-reauth"
    )
  }

  func testRelayReauthorizationProofUsesFreshCryptographicallyBoundAttempt() throws {
    let deviceId = "phone-1"
    let token = "token-1"
    let relayChallenge = "challenge-1"
    let first = try XCTUnwrap(DpopKeyService.shared.buildRelayReauthorizationProof(
      deviceId: deviceId,
      relayAccountToken: token,
      challenge: relayChallenge
    ))
    let second = try XCTUnwrap(DpopKeyService.shared.buildRelayReauthorizationProof(
      deviceId: deviceId,
      relayAccountToken: token,
      challenge: relayChallenge
    ))
    XCTAssertNotEqual(first["nonce"] as? String, second["nonce"] as? String)
    XCTAssertNotEqual(first["signature"] as? String, second["signature"] as? String)

    let publicKeyBase64 = try XCTUnwrap(DpopKeyService.shared.publicKeyX963Base64())
    let publicKeyData = try XCTUnwrap(Data(base64Encoded: publicKeyBase64))
    let attributes: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeyClass as String: kSecAttrKeyClassPublic,
      kSecAttrKeySizeInBits as String: 256,
    ]
    var keyError: Unmanaged<CFError>?
    let publicKey = try XCTUnwrap(
      SecKeyCreateWithData(publicKeyData as CFData, attributes as CFDictionary, &keyError)
    )

    for proof in [first, second] {
      let timestamp = try XCTUnwrap(proof["timestamp"] as? Int)
      let nonce = try XCTUnwrap(proof["nonce"] as? String)
      let signature = try XCTUnwrap(
        Data(base64Encoded: try XCTUnwrap(proof["signature"] as? String))
      )
      let canonical = DpopKeyService.buildRelayReauthorizationChallenge(
        deviceId: deviceId,
        relayAccountTokenSha256Hex: DpopKeyService.sha256Hex(token),
        challenge: relayChallenge,
        timestamp: timestamp,
        nonce: nonce
      )
      func verifies(_ canonicalChallenge: String) -> Bool {
        var verificationError: Unmanaged<CFError>?
        return SecKeyVerifySignature(
          publicKey,
          .ecdsaSignatureMessageX962SHA256,
          Data(canonicalChallenge.utf8) as CFData,
          signature as CFData,
          &verificationError
        )
      }
      XCTAssertTrue(verifies(canonical))

      let wrongTokenCanonical = DpopKeyService.buildRelayReauthorizationChallenge(
        deviceId: deviceId,
        relayAccountTokenSha256Hex: DpopKeyService.sha256Hex("different-token"),
        challenge: relayChallenge,
        timestamp: timestamp,
        nonce: nonce
      )
      XCTAssertFalse(verifies(wrongTokenCanonical))

      let wrongChallengeCanonical = DpopKeyService.buildRelayReauthorizationChallenge(
        deviceId: deviceId,
        relayAccountTokenSha256Hex: DpopKeyService.sha256Hex(token),
        challenge: "different-challenge",
        timestamp: timestamp,
        nonce: nonce
      )
      XCTAssertFalse(verifies(wrongChallengeCanonical))
    }
  }

  func testPushPreferencesDecodeLegacyPayloadAndPublishPrivacyChoice() throws {
    let legacy = Data("""
    {
      "enabled": true,
      "liveActivitiesEnabled": false,
      "mutedSessionIds": ["session-1"],
      "quietHoursEnabled": true,
      "quietHoursStart": "21:30",
      "quietHoursEnd": "07:15",
      "quietHoursTimezone": "America/New_York"
    }
    """.utf8)

    var preferences = try JSONDecoder().decode(PushPrefs.self, from: legacy)
    XCTAssertFalse(preferences.hideDetails)
    XCTAssertEqual(preferences.mutedSessionIds, ["session-1"])

    preferences.hideDetails = true
    XCTAssertEqual(preferences.commandPayload["hideDetails"] as? Bool, true)
    let accountOverride = preferences.accountDeviceOverride
    XCTAssertEqual(accountOverride["notificationsEnabled"] as? Bool, true)
    XCTAssertEqual(accountOverride["liveActivitiesEnabled"] as? Bool, false)
    XCTAssertEqual(accountOverride["hideDetails"] as? Bool, true)
    XCTAssertEqual(accountOverride["mutedSessionIds"] as? [String], ["session-1"])
    let quietHours = try XCTUnwrap(accountOverride["quietHours"] as? [String: Any])
    XCTAssertEqual(quietHours["enabled"] as? Bool, true)
    XCTAssertEqual(quietHours["startMinute"] as? Int, 21 * 60 + 30)
    XCTAssertEqual(quietHours["endMinute"] as? Int, 7 * 60 + 15)
    XCTAssertEqual(quietHours["timeZone"] as? String, "America/New_York")

    let roundTrip = try JSONDecoder().decode(
      PushPrefs.self,
      from: JSONEncoder().encode(preferences)
    )
    XCTAssertTrue(roundTrip.hideDetails)
    XCTAssertEqual(roundTrip.quietHoursStart, "21:30")
    XCTAssertEqual(roundTrip.quietHoursEnd, "07:15")
  }
}
