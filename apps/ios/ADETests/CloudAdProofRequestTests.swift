import XCTest
@testable import ADE

/// Pricing v3's proofs from the phone (`CloudAdSentRequest`,
/// `CloudSponsoredAdRequest` in the account server's `contract.ts`). Both apps
/// ignore the answer, so a body the server can't read fails with nothing on
/// screen and the computer or the cloud iPhone stays at the full price. This
/// pins the JSON the server reads, through the public client calls.
final class CloudAdProofRequestTests: XCTestCase {
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

  func testProofBodiesMatchTheServerContract() async throws {
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
    ]

    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [CloudAdProofStubProtocol.self]
    var client = CloudServerClient(baseURL: URL(string: "https://account.test")!, token: "token")
    client.session = URLSession(configuration: configuration)
    defer { CloudAdProofStubProtocol.reset() }

    for item in cases {
      CloudAdProofStubProtocol.reset()
      CloudAdProofStubProtocol.answer = Data(item.answer.utf8)
      try await item.call(client)

      let request = try XCTUnwrap(CloudAdProofStubProtocol.request, item.name)
      XCTAssertEqual(request.httpMethod, "POST", item.name)
      XCTAssertEqual(request.url?.path, item.path, item.name)
      XCTAssertEqual(request.value(forHTTPHeaderField: "X-ADE-Pricing"), "3", item.name)
      let body = try XCTUnwrap(CloudAdProofStubProtocol.body, item.name)
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

/// Records the one request and answers 200 with the case's body.
private final class CloudAdProofStubProtocol: URLProtocol {
  nonisolated(unsafe) static var request: URLRequest?
  nonisolated(unsafe) static var body: Data?
  nonisolated(unsafe) static var answer = Data("{}".utf8)

  static func reset() {
    request = nil
    body = nil
    answer = Data("{}".utf8)
  }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    Self.request = request
    Self.body = request.httpBody ?? request.httpBodyStream.map(Self.read)
    let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
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
