import SwiftUI

/// ADE App Clip — instant pairing from a scanned QR.
///
/// The clip is invoked with the smart pairing URL
/// (`https://ade-app.dev/pair#<base64url(JSON)>`); the payload rides the URL
/// fragment so it never reaches the web server. The clip parses the payload
/// with the same `PairingQrPayload` codec as the full app, performs the
/// PIN-gated pairing handshake, and stores the resulting credentials in the
/// shared App Group container for the full app to adopt on first launch.
@main
struct ADEClipApp: App {
  @StateObject private var model = ClipPairingModel()

  var body: some Scene {
    WindowGroup {
      ClipPairingView(model: model)
        .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
          guard let url = activity.webpageURL else { return }
          model.handleInvocation(url: url)
        }
    }
  }
}
