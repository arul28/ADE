import AuthenticationServices
import SwiftUI
import UIKit

/// Outcome of a worker-bounce Linear OAuth attempt from the phone.
enum LinearOAuthOutcome {
  /// Token exchanged + stored on the desktop; carries the fresh status.
  case connected(LinearConnectionStatus)
  /// User dismissed the `ASWebAuthenticationSession` (`.canceledLogin`).
  case canceled
  /// A user-facing failure message (Linear error, transport error, or a
  /// disconnected status coming back from the desktop). Drives the "use an API
  /// key instead" fallback UX.
  case failed(String)
}

/// Drives the phone side of the worker-bounce OAuth flow:
///
///   `startLinearMobileOAuth()` (desktop mints PKCE session)
///     → open `authorizeUrl` in `ASWebAuthenticationSession(callbackURLScheme:"ade")`
///     → capture `ade://linear-oauth?code&state` in-session
///     → `completeLinearMobileOAuth(...)` (desktop exchanges + stores the token)
///
/// The authorization code is PKCE-bound to a verifier that never leaves the
/// desktop, so it is useless in transit. The callback is captured by the web
/// auth session itself, so it never reaches `DeepLinkRouter` (which ignores the
/// `linear-oauth` host anyway).
@MainActor
final class LinearOAuthRunner: NSObject, ObservableObject, ASWebAuthenticationPresentationContextProviding {
  @Published private(set) var isRunning = false

  /// Retained for the lifetime of the presentation so the callback fires.
  private var webSession: ASWebAuthenticationSession?

  func connect(using sync: SyncService) async -> LinearOAuthOutcome {
    guard !isRunning else { return .canceled }
    isRunning = true
    defer { isRunning = false }

    let session: LinearMobileOAuthSession
    do {
      session = try await sync.startLinearMobileOAuth()
    } catch {
      return .failed(SyncUserFacingError.message(for: error))
    }

    guard let authorizeUrl = URL(string: session.authorizeUrl) else {
      return .failed("Linear returned an invalid sign-in link.")
    }

    let callback: URL
    do {
      callback = try await presentWebAuth(url: authorizeUrl)
    } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
      return .canceled
    } catch {
      return .failed(SyncUserFacingError.message(for: error))
    }

    let params = LinearOAuthCallback(url: callback)
    if let errorMessage = params.errorMessage {
      return .failed(errorMessage)
    }
    guard let code = params.code, !code.isEmpty,
          let state = params.state, !state.isEmpty else {
      return .failed("Linear sign-in didn\u{2019}t return an authorization code.")
    }

    do {
      let status = try await sync.completeLinearMobileOAuth(
        sessionId: session.sessionId,
        code: code,
        state: state
      )
      if status.connected {
        return .connected(status)
      }
      return .failed(status.message ?? "Couldn\u{2019}t finish connecting to Linear.")
    } catch {
      return .failed(SyncUserFacingError.message(for: error))
    }
  }

  private func presentWebAuth(url: URL) async throws -> URL {
    try await withCheckedThrowingContinuation { continuation in
      let webSession = ASWebAuthenticationSession(
        url: url,
        callbackURLScheme: "ade"
      ) { callbackURL, error in
        if let error {
          continuation.resume(throwing: error)
        } else if let callbackURL {
          continuation.resume(returning: callbackURL)
        } else {
          continuation.resume(throwing: ASWebAuthenticationSessionError(.canceledLogin))
        }
      }
      // Reuse an existing Linear login when present rather than an ephemeral
      // session, so the user often lands straight on the authorize screen.
      webSession.prefersEphemeralWebBrowserSession = false
      webSession.presentationContextProvider = self
      self.webSession = webSession
      if !webSession.start() {
        continuation.resume(throwing: ASWebAuthenticationSessionError(.canceledLogin))
      }
    }
  }

  nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    MainActor.assumeIsolated {
      let scene = UIApplication.shared.connectedScenes
        .compactMap { $0 as? UIWindowScene }
        .first { $0.activationState == .foregroundActive }
        ?? UIApplication.shared.connectedScenes
          .compactMap { $0 as? UIWindowScene }
          .first
      let window = scene?.keyWindow ?? scene?.windows.first
      return window ?? ASPresentationAnchor()
    }
  }
}

/// Parses the `ade://linear-oauth?...` callback the Worker bounces back.
private struct LinearOAuthCallback {
  let code: String?
  let state: String?
  let error: String?
  let errorDescription: String?

  init(url: URL) {
    let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
    func value(_ name: String) -> String? {
      // URLComponents already percent-decodes query-item values; decoding again
      // would corrupt an opaque code/state that contains a literal %XX sequence.
      items.first(where: { $0.name == name })?.value
    }
    code = value("code")
    state = value("state")
    error = value("error")
    errorDescription = value("error_description")
  }

  /// A user-facing message when Linear reported an error, else nil.
  var errorMessage: String? {
    guard let error, !error.isEmpty else { return nil }
    if let description = errorDescription, !description.isEmpty {
      return description
    }
    return "Linear sign-in failed (\(error))."
  }
}
