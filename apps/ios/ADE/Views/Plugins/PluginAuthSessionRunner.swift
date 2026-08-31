import AuthenticationServices
import SwiftUI
import UIKit

/// Outcome of one host-brokered plugin sign-in attempt from the phone.
enum PluginAuthSessionOutcome {
  /// The callback reached the machine, which matched it to a live flow and gave
  /// it to the plugin. Not a claim that the provider said yes — a denial is
  /// routed just as correctly, and the plugin is the one that hears it.
  case delivered
  /// The reader dismissed the `ASWebAuthenticationSession` (`.canceledLogin`).
  /// Not a failure, and not reported as one.
  case canceled
  /// A user-facing sentence: a transport error, or a machine that refused the
  /// callback because the flow it belonged to is gone.
  case failed(String)
}

/// Drives the phone side of the host-brokered plugin sign-in:
///
///   plugin action returns `{authSession: {sessionId}}` (host stamps the URL)
///     → open it in `ASWebAuthenticationSession(callbackURLScheme: "ade")`
///     → capture `ade://plugin-auth?<the provider's query>` in-session
///     → `completePluginAuthSession(params:)` hands it back to the machine
///
/// This is `LinearOAuthRunner` made generic, and the generalization is the whole
/// point: the phone knows no provider, no plugin and no session. It carries
/// whatever came back and the machine routes it by the `state` IT minted, so a
/// phone can only ever finish a flow that machine started.
///
/// The callback is captured by the web auth session itself and never reaches
/// `DeepLinkRouter`, which ignores the `plugin-auth` host anyway.
@MainActor
final class PluginAuthSessionRunner: NSObject, ObservableObject, ASWebAuthenticationPresentationContextProviding {
  /// How many callback parameters are carried back to the machine.
  ///
  /// The relay already caps what it bounces; this is the same bound restated on
  /// the receiving side, because a cap that lives only in the sender is not a
  /// cap. Every real callback is a handful of short fields.
  static let maxCallbackParameters = 24

  @Published private(set) var isRunning = false

  /// Retained for the lifetime of the presentation so the callback fires.
  private var webSession: ASWebAuthenticationSession?

  func run(url: URL, callbackScheme: String, using sync: PluginPaneSyncing) async -> PluginAuthSessionOutcome {
    guard !isRunning else { return .canceled }
    isRunning = true
    defer { isRunning = false }

    let callback: URL
    do {
      callback = try await presentWebAuth(url: url, callbackScheme: callbackScheme)
    } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
      return .canceled
    } catch {
      return .failed(SyncUserFacingError.message(for: error))
    }

    let params = Self.callbackParameters(from: callback)
    // A callback with nothing in it cannot be routed: `state` is what the
    // machine matches on, and there is no flow to tell that this one arrived.
    guard !params.isEmpty else {
      return .failed("Sign-in didn\u{2019}t return anything ADE could use.")
    }

    do {
      try await sync.completePluginAuthSession(params: params)
      return .delivered
    } catch {
      return .failed(SyncUserFacingError.message(for: error))
    }
  }

  /// Every parameter the provider sent, decoded once.
  ///
  /// Nothing is filtered by name. The phone serves every plugin's every
  /// provider, so a field it has not heard of is a field it must still carry —
  /// dropping one would break a flow the machine knows how to finish.
  static func callbackParameters(from url: URL) -> [String: String] {
    let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
    var params: [String: String] = [:]
    for item in items {
      // URLComponents already percent-decodes query-item values; decoding again
      // would corrupt an opaque code/state that contains a literal %XX sequence.
      guard let value = item.value else { continue }
      // First value wins for a repeated name, matching what the relay emits and
      // what every other reader of this callback would have taken.
      guard params[item.name] == nil else { continue }
      guard params.count < maxCallbackParameters else { break }
      params[item.name] = value
    }
    return params
  }

  private func presentWebAuth(url: URL, callbackScheme: String) async throws -> URL {
    try await withCheckedThrowingContinuation { continuation in
      let webSession = ASWebAuthenticationSession(
        url: url,
        callbackURLScheme: callbackScheme
      ) { callbackURL, error in
        if let error {
          continuation.resume(throwing: error)
        } else if let callbackURL {
          continuation.resume(returning: callbackURL)
        } else {
          continuation.resume(throwing: ASWebAuthenticationSessionError(.canceledLogin))
        }
      }
      // Reuse an existing login with the provider when present rather than an
      // ephemeral session, so the reader often lands straight on the authorize
      // screen instead of typing a password they already gave this phone.
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
