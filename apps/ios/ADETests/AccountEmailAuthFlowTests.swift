import ClerkKit
import Foundation
import XCTest
@testable import ADE

@MainActor
final class AccountEmailAuthFlowTests: XCTestCase {
  private enum TestError: Error {
    case unavailable
  }

  private func clerkError(code: String) throws -> ClerkAPIError {
    let data = Data(#"{"code":"\#(code)","message":"Test error"}"#.utf8)
    return try JSONDecoder().decode(ClerkAPIError.self, from: data)
  }

  private final class ActionsSpy {
    var signInError: Error?
    private(set) var calls: [String] = []

    func actions() -> AccountEmailAuthActions {
      AccountEmailAuthActions(
        startSignIn: { [self] email in
          calls.append("startSignIn:\(email)")
          if let signInError { throw signInError }
        },
        startSignUp: { [self] email in
          calls.append("startSignUp:\(email)")
        },
        verifySignIn: { [self] code in
          calls.append("verifySignIn:\(code)")
        },
        verifySignUp: { [self] code in
          calls.append("verifySignUp:\(code)")
        }
      )
    }
  }

  func testReturningEmailStartsSignInAndVerifiesExistingAccount() async throws {
    let spy = ActionsSpy()

    let kind = try await AccountEmailAuthFlow.sendCode(
      to: "returning@example.com",
      actions: spy.actions()
    )

    XCTAssertEqual(kind, .signIn)
    XCTAssertEqual(spy.calls, ["startSignIn:returning@example.com"])
    try await AccountEmailAuthFlow.verifyCode("654321", kind: kind, actions: spy.actions())
    XCTAssertEqual(spy.calls, [
      "startSignIn:returning@example.com",
      "verifySignIn:654321",
    ])
  }

  func testNewEmailFallsBackToSignUpAndVerifiesSignUpCode() async throws {
    let spy = ActionsSpy()
    spy.signInError = try clerkError(code: "form_identifier_not_found")

    let kind = try await AccountEmailAuthFlow.sendCode(
      to: "new@example.com",
      actions: spy.actions()
    )

    XCTAssertEqual(kind, .signUp)
    XCTAssertEqual(spy.calls, [
      "startSignIn:new@example.com",
      "startSignUp:new@example.com",
    ])
    try await AccountEmailAuthFlow.verifyCode("123456", kind: kind, actions: spy.actions())
    XCTAssertEqual(spy.calls, [
      "startSignIn:new@example.com",
      "startSignUp:new@example.com",
      "verifySignUp:123456",
    ])
  }

  func testBothClerkAccountNotFoundCodesAllowSignUpFallback() async throws {
    for code in ["form_identifier_not_found", "invitation_account_not_exists"] {
      let spy = ActionsSpy()
      spy.signInError = try clerkError(code: code)

      let kind = try await AccountEmailAuthFlow.sendCode(
        to: "new@example.com",
        actions: spy.actions()
      )

      XCTAssertEqual(kind, .signUp)
      XCTAssertEqual(spy.calls, [
        "startSignIn:new@example.com",
        "startSignUp:new@example.com",
      ])
    }
  }

  func testUnrelatedClerkErrorDoesNotStartSignUp() async throws {
    let spy = ActionsSpy()
    spy.signInError = try clerkError(code: "too_many_requests")

    do {
      _ = try await AccountEmailAuthFlow.sendCode(
        to: "existing@example.com",
        actions: spy.actions()
      )
      XCTFail("Expected the unrelated Clerk error to be preserved")
    } catch let error as ClerkAPIError {
      XCTAssertEqual(error.code, "too_many_requests")
      XCTAssertEqual(spy.calls, ["startSignIn:existing@example.com"])
      XCTAssertFalse(spy.calls.contains { $0.hasPrefix("startSignUp:") })
    } catch {
      XCTFail("Expected ClerkAPIError, got \(error)")
    }
  }

  func testNonClerkErrorDoesNotStartSignUp() async {
    let spy = ActionsSpy()
    spy.signInError = TestError.unavailable

    do {
      _ = try await AccountEmailAuthFlow.sendCode(
        to: "existing@example.com",
        actions: spy.actions()
      )
      XCTFail("Expected the original non-Clerk error to be preserved")
    } catch TestError.unavailable {
      XCTAssertEqual(spy.calls, ["startSignIn:existing@example.com"])
      XCTAssertEqual(spy.calls.count, 1)
      XCTAssertFalse(spy.calls.contains { $0.hasPrefix("startSignUp:") })
    } catch {
      XCTFail("Expected TestError.unavailable, got \(error)")
    }
  }
}
