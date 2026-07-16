import ClerkKit
import Foundation

/// Identifies which Clerk flow owns the pending email verification code.
enum AccountEmailVerificationKind: Equatable {
  case signIn
  case signUp
}

/// Clerk operations used to start and finish either email authentication path.
struct AccountEmailAuthActions {
  var startSignIn: @MainActor (String) async throws -> Void
  var startSignUp: @MainActor (String) async throws -> Void
  var verifySignIn: @MainActor (String) async throws -> Void
  var verifySignUp: @MainActor (String) async throws -> Void
}

/// Routes email authentication between returning-user sign-in and precise new-user fallback.
@MainActor
enum AccountEmailAuthFlow {
  private static let accountNotFoundCodes: Set<String> = [
    "form_identifier_not_found",
    "invitation_account_not_exists",
  ]

  /// Returns true only for Clerk errors that explicitly mean the identifier has no account.
  static func shouldBeginSignUp(after error: Error) -> Bool {
    guard let clerkError = error as? ClerkAPIError else { return false }
    return isAccountNotFoundCode(clerkError.code)
  }

  /// Classifies Clerk's exact account-not-found error codes without broadening the fallback.
  static func isAccountNotFoundCode(_ code: String) -> Bool {
    accountNotFoundCodes.contains(code)
  }

  /// Starts sign-in first, falling back to sign-up only when the supplied classifier allows it.
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

  /// Verifies the code against the same Clerk flow that issued it.
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
