import XCTest
@testable import ADE

/// What an `approval_request` is actually asking for, when the envelope and the
/// payload it carries disagree.
///
/// Two sources are on the wire: the top-level `requestKind` a current host
/// sends, and the embedded `detail.request.kind` hosts before it sent. The
/// canonical reader — `approvalRequestKind()` in
/// apps/desktop/src/shared/pendingInputAnswers.ts — prefers the first and falls
/// back to the second, and the phone must resolve it the same way or the same
/// blocked run gets Approve/Deny on one surface and Answer on another.
///
/// The precedence is applied at the decode boundary
/// (`agentChatApprovalDetail`) and at the transcript-parse boundary
/// (`workApprovalRequestDetail`), because both feed the same classifiers.
final class ApprovalRequestKindPrecedenceTests: XCTestCase {

  /// A Pi-shaped gate — `kind: "approval"`, one option-less question — that a
  /// current host has labelled a question at the envelope level. Classified
  /// from the embedded kind alone it is an approval card with no way to reply;
  /// the top-level word is the one the host means.
  private let disagreeingDetail = """
  {
    "request": {
      "requestId": "ask-1",
      "itemId": "ask-1",
      "source": "claude",
      "kind": "approval",
      "title": "Question from Claude",
      "questions": [
        {"id": "answer", "header": "Which database?", "question": "Which database?", "allowsFreeform": true}
      ]
    }
  }
  """

  func testEmbeddedKindAloneReadsTheDisagreeingPayloadAsAnApproval() {
    XCTAssertNil(
      pendingWorkQuestionFromApproval(
        description: "Which database?",
        detail: disagreeingDetail,
        itemId: "ask-1"
      ),
      "Baseline: `kind: approval` with nothing selectable is a verdict, not a question."
    )
  }

  func testTopLevelRequestKindWinsOverTheEmbeddedKind() throws {
    let json = """
    {
      "sessionId": "chat-1",
      "events": [
        {
          "sessionId": "chat-1",
          "timestamp": "2026-08-25T00:00:00.000Z",
          "sequence": 1,
          "event": {
            "type": "approval_request",
            "itemId": "ask-1",
            "kind": "tool_call",
            "requestKind": "question",
            "description": "Which database?",
            "turnId": "turn-1",
            "detail": \(disagreeingDetail)
          }
        }
      ],
      "truncated": false
    }
    """

    let snapshot = try JSONDecoder().decode(AgentChatEventHistorySnapshot.self, from: Data(json.utf8))
    let pendingInputs = derivePendingWorkInputs(from: makeWorkChatTranscript(from: snapshot.events))

    guard case .question(let model)? = pendingInputs.first else {
      return XCTFail("Expected the envelope's `requestKind` to claim this gate for the question card.")
    }
    XCTAssertEqual(model.id, "ask-1")
    XCTAssertEqual(model.questions.count, 1)
  }

  func testAgreeingKindLeavesThePayloadByteForByte() {
    let detail = RemoteJSONValue.object([
      "request": .object(["kind": .string("question"), "source": .string("claude")]),
    ])

    XCTAssertEqual(agentChatApprovalDetail(applying: "question", to: detail), detail)
  }

  func testAbsentOrBlankRequestKindChangesNothing() {
    let detail = RemoteJSONValue.object([
      "request": .object(["kind": .string("approval")]),
    ])

    XCTAssertEqual(agentChatApprovalDetail(applying: nil, to: detail), detail)
    XCTAssertEqual(agentChatApprovalDetail(applying: "   ", to: detail), detail)
    XCTAssertNil(agentChatApprovalDetail(applying: "question", to: nil))
  }

  /// Unknown must mean approval. Writing a word the classifiers do not branch
  /// on into `request.kind` would ERASE the one they do — and a Pi tool gate
  /// whose kind stops saying "approval" reclassifies as a freeform question
  /// card, where every submission goes out as `accept`.
  func testUnrecognisedRequestKindLeavesTheEmbeddedKindAlone() throws {
    let detail = RemoteJSONValue.object([
      "request": .object(["kind": .string("approval")]),
    ])
    XCTAssertEqual(agentChatApprovalDetail(applying: "some_future_kind", to: detail), detail)

    let gate = try JSONDecoder().decode(RemoteJSONValue.self, from: Data(disagreeingDetail.utf8))
    XCTAssertNil(
      pendingWorkQuestionFromApproval(
        description: "rm -rf build",
        detail: prettyPrintedRemoteJSONValue(
          agentChatApprovalDetail(applying: "some_future_kind", to: gate)
        ),
        itemId: "ask-1"
      ),
      "An unknown kind must not promote a tool gate into a question card."
    )
  }

  /// A `requestKind` with no `request` object to write into must not synthesise
  /// one: an envelope with no payload has no questions to render, and inventing
  /// a request would turn an approval into an empty question card.
  func testRequestKindWithoutAnEmbeddedRequestSynthesisesNothing() {
    let detail = RemoteJSONValue.object(["tool": .string("bash")])

    XCTAssertEqual(agentChatApprovalDetail(applying: "question", to: detail), detail)
  }

  // MARK: - The persisted-transcript twin

  func testTranscriptParserAppliesTheSamePrecedence() throws {
    let raw = try XCTUnwrap(
      JSONSerialization.jsonObject(with: Data(disagreeingDetail.utf8)) as? [String: Any]
    )

    let applied = try XCTUnwrap(
      workApprovalRequestDetail(applying: "question", to: raw) as? [String: Any]
    )
    let request = try XCTUnwrap(applied["request"] as? [String: Any])
    XCTAssertEqual(request["kind"] as? String, "question")

    let untouched = try XCTUnwrap(
      workApprovalRequestDetail(applying: "some_future_kind", to: raw) as? [String: Any]
    )
    XCTAssertEqual(
      (untouched["request"] as? [String: Any])?["kind"] as? String,
      "approval",
      "An unknown kind must leave the fallback in place."
    )
    XCTAssertNil(workApprovalRequestDetail(applying: "question", to: nil))
  }
}
