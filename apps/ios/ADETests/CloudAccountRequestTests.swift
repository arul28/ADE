import XCTest
@testable import ADE

/// Account server request bodies the phone must get exactly right, through
/// the public client calls:
/// - Pricing v3's proofs (`CloudAdSentRequest`, `CloudSponsoredAdRequest` in
///   the account server's `contract.ts`). Both apps ignore the answer, so a
///   body the server can't read fails with nothing on screen and the computer
///   or the cloud iPhone stays at the full price.
/// - The first provider sign-in of a cloud start: the code and "Start with …
///   instead" are account calls by the launch's ids, with no pin, so they
///   reach the launch whichever machine the phone is bound to. A refused code
///   must read as refused, never "Code sent".
/// - "Delete anyway" on a computer the idle cleanup kept (ADE-223): it must
///   keep the lane (the server takes its branch from its own row), or the
///   lane and its chats are lost with the computer.
final class CloudAccountRequestTests: XCTestCase {
  private struct Case {
    let name: String
    let path: String
    let answer: String
    let call: (CloudServerClient) async throws -> Void
    /// The keys the server reads, as JSON values (`NSNull` is an explicit null).
    let expected: [String: Any]
    /// Keys that must not be sent at all (an absent optional, not a null).
    let absent: [String]
  }

  private static let turn = CloudSponsoredTurn(
    turnId: "turn-1",
    finishedAt: nil,
    messages: [CloudSponsoredMessage(role: "user", content: "fix the build"), CloudSponsoredMessage(role: "assistant", content: "done")]
  )
  private static let device = CloudSponsoredDevice(type: "mobile", os: "ios", osVersion: "27.0", ua: "DAEX-iOS/1", tracking: nil)

  func testAccountCallBodiesMatchTheServerContract() async throws {
    let cases: [Case] = [
      Case(
        name: "sent: a chat on a cloud computer",
        path: "/cloud/sponsored/sent",
        answer: #"{"counted":true}"#,
        call: { try await $0.sponsoredSent(instanceId: "inst-1", phoneId: nil, chatId: "chat-1", messageId: "msg-1") },
        expected: ["instanceId": "inst-1", "chatId": "chat-1", "messageId": "msg-1"],
        absent: ["phoneId"]
      ),
      Case(
        name: "sent: a chat on the person's own computer holding the cloud iPhone",
        path: "/cloud/sponsored/sent",
        answer: #"{"counted":true}"#,
        call: { try await $0.sponsoredSent(instanceId: nil, phoneId: "phone-1", chatId: "chat-2", messageId: "msg-2") },
        expected: ["instanceId": NSNull(), "phoneId": "phone-1", "chatId": "chat-2", "messageId": "msg-2"],
        absent: []
      ),
      Case(
        name: "ad: a chat holding the cloud iPhone",
        path: "/cloud/sponsored/ad",
        answer: #"{"ad":null,"reason":"no_fill"}"#,
        call: { _ = try await $0.sponsoredAd(instanceId: nil, phoneId: "phone-1", chatId: "chat-2", turn: Self.turn, device: Self.device, format: .belowReply) },
        expected: [
          "instanceId": NSNull(), "phoneId": "phone-1", "chatId": "chat-2", "turnId": "turn-1", "format": "below_reply",
          "messages": [["role": "user", "content": "fix the build"], ["role": "assistant", "content": "done"]],
        ],
        absent: []
      ),
      Case(
        name: "sign-in: a code for the launch's computer and job, refused",
        path: "/cloud/instances/inst-4/sign-ins/job-7/code",
        answer: #"{"state":"pending","verdict":"refused","reason":"That code didn't work. Open sign-in again and paste the new code."}"#,
        call: {
          let outcome = try await $0.sendSignInCode(instanceId: "inst-4", jobId: "job-7", code: "FAKE-CODE")
          XCTAssertEqual(outcome, .refused("That code didn't work. Open sign-in again and paste the new code."))
        },
        expected: ["code": "FAKE-CODE"],
        absent: []
      ),
      Case(
        name: "sign-in: start with the free model instead",
        path: "/cloud/launches/launch-3/free-model",
        answer: #"{"launchId":"launch-3","state":"waiting_for_sign_in"}"#,
        call: { _ = try await $0.startLaunchOnFreeModel("launch-3") },
        expected: [:],
        absent: ["pin", "machineKey"]
      ),
    ]

    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [CloudAccountStubProtocol.self]
    var client = CloudServerClient(baseURL: URL(string: "https://account.test")!, token: "token")
    client.session = URLSession(configuration: configuration)
    defer { CloudAccountStubProtocol.reset() }

    for item in cases {
      CloudAccountStubProtocol.reset()
      CloudAccountStubProtocol.answer = Data(item.answer.utf8)
      try await item.call(client)

      let request = try XCTUnwrap(CloudAccountStubProtocol.request, item.name)
      XCTAssertEqual(request.httpMethod, "POST", item.name)
      XCTAssertEqual(request.url?.host, "account.test", item.name)
      XCTAssertEqual(request.url?.path, item.path, item.name)
      XCTAssertEqual(request.value(forHTTPHeaderField: "X-ADE-Pricing"), "3", item.name)
      let body = try XCTUnwrap(CloudAccountStubProtocol.body, item.name)
      let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any], item.name)
      for (key, value) in item.expected {
        let sent = try XCTUnwrap(json[key], "\(item.name): \(key) missing")
        XCTAssertEqual(sent as? NSObject, value as? NSObject, "\(item.name): \(key)")
      }
      for key in item.absent {
        XCTAssertNil(json[key], "\(item.name): \(key) must be left out")
      }
    }
  }
}

extension CloudAccountRequestTests {
  func testDeleteAnywayKeepsTheLaneWithNoBranch() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [CloudAccountStubProtocol.self]
    var client = CloudServerClient(baseURL: URL(string: "https://account.test")!, token: "token")
    client.session = URLSession(configuration: configuration)
    CloudAccountStubProtocol.reset()
    defer { CloudAccountStubProtocol.reset() }
    // The delete answers 200; the read after it answers 404: the computer is gone.
    CloudAccountStubProtocol.goneOnRead = true

    let gone = try await client.deleteInstanceConfirmed("inst-9", keepLane: true)

    XCTAssertTrue(gone)
    let request = try XCTUnwrap(CloudAccountStubProtocol.deleteRequest)
    XCTAssertEqual(request.httpMethod, "DELETE")
    XCTAssertEqual(request.url?.path, "/cloud/instances/inst-9")
    let body = try XCTUnwrap(CloudAccountStubProtocol.deleteBody)
    let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? NSDictionary)
    XCTAssertEqual(json, ["reason": "freed", "keepLane": ["branchRef": NSNull()]] as NSDictionary)
  }
}

/// Records the one request and answers 200 with the case's body.
private final class CloudAccountStubProtocol: URLProtocol {
  nonisolated(unsafe) static var request: URLRequest?
  nonisolated(unsafe) static var body: Data?
  nonisolated(unsafe) static var answer = Data("{}".utf8)
  /// A GET answers 404 (a deleted computer); the DELETE before it is kept apart.
  nonisolated(unsafe) static var goneOnRead = false
  nonisolated(unsafe) static var deleteRequest: URLRequest?
  nonisolated(unsafe) static var deleteBody: Data?

  static func reset() {
    request = nil
    body = nil
    answer = Data("{}".utf8)
    goneOnRead = false
    deleteRequest = nil
    deleteBody = nil
  }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    let body = request.httpBody ?? request.httpBodyStream.map(Self.read)
    if request.httpMethod == "DELETE" {
      Self.deleteRequest = request
      Self.deleteBody = body
    } else {
      Self.request = request
      Self.body = body
    }
    let status = Self.goneOnRead && request.httpMethod == "GET" ? 404 : 200
    let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Self.answer)
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() {}

  private static func read(_ stream: InputStream) -> Data {
    stream.open()
    defer { stream.close() }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)
    while stream.hasBytesAvailable {
      let count = stream.read(&buffer, maxLength: buffer.count)
      guard count > 0 else { break }
      data.append(buffer, count: count)
    }
    return data
  }
}
