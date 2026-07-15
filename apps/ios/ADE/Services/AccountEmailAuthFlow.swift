import ClerkKit
import Foundation

enum AccountEmailVerificationKind: Equatable {
  case signIn
  case signUp
}

struct AccountEmailAuthActions {
  var startSignIn: @MainActor (String) async throws -> Void
  var startSignUp: @MainActor (String) async throws -> Void
  var verifySignIn: @MainActor (String) async throws -> Void
  var verifySignUp: @MainActor (String) async throws -> Void
}

@MainActor
enum AccountEmailAuthFlow {
  private static let accountNotFoundCodes: Set<String> = [
    "form_identifier_not_found",
    "invitation_account_not_exists",
  ]

  static func shouldBeginSignUp(after error: Error) -> Bool {
    guard let clerkError = error as? ClerkAPIError else { return false }
    return isAccountNotFoundCode(clerkError.code)
  }

  static func isAccountNotFoundCode(_ code: String) -> Bool {
    accountNotFoundCodes.contains(code)
  }

  static func sendCode(
    to email: String,
    actions: AccountEmailAuthActions,
    shouldBeginSignUp: @MainActor (Error) -> Bool = AccountEmailAuthFlow.shouldBeginSignUp(after:)
  ) async throws -> AccountEmailVerificationKind {
    do {
      try await actions.startSignIn(email)
      return .signIn
    } catch {
      guard shouldBeginSignUp(error) else { throw error }
      try await actions.startSignUp(email)
      return .signUp
    }
  }

  static func verifyCode(
    _ code: String,
    kind: AccountEmailVerificationKind,
    actions: AccountEmailAuthActions
  ) async throws {
    switch kind {
    case .signIn:
      try await actions.verifySignIn(code)
    case .signUp:
      try await actions.verifySignUp(code)
    }
  }
}
