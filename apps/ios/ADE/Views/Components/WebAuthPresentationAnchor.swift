import AuthenticationServices
import UIKit

/// The window an `ASWebAuthenticationSession` presents over: the key window of
/// the scene in front. Every web sign-in sheet in the app anchors here.
@MainActor
func adeWebAuthPresentationAnchor() -> ASPresentationAnchor {
  let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
  let scene = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
  return scene?.keyWindow ?? scene?.windows.first ?? ASPresentationAnchor()
}

/// Resumes a web sign-in sheet's continuation once. The sheet's completion
/// handler and a failed `start()` can both report the end of the same sheet
/// (the completion can still fire after `start()` returned false), and a
/// second `resume` on a checked continuation traps. The first caller wins;
/// later calls do nothing.
final class WebAuthResumeOnce<T, Failure: Error>: @unchecked Sendable {
  private let lock = NSLock()
  private var continuation: CheckedContinuation<T, Failure>?

  init(_ continuation: CheckedContinuation<T, Failure>) {
    self.continuation = continuation
  }

  func resume(with result: Result<T, Failure>) {
    lock.lock()
    let continuation = self.continuation
    self.continuation = nil
    lock.unlock()
    continuation?.resume(with: result)
  }
}

extension WebAuthResumeOnce where T == Void, Failure == Never {
  func resume() { resume(with: .success(())) }
}
