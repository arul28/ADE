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
