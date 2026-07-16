import SwiftUI

struct MobileAccessGateView: View {
  let accountConfigured: Bool
  let accountLoading: Bool
  let accountSignedIn: Bool
  let hasPairedHost: Bool
  let onContinue: () -> Void

  @EnvironmentObject private var syncService: SyncService
  @State private var presentedSheet: MobileAccessGateSheet?
  @State private var accountConnectionError: String?

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: 24) {
          Spacer(minLength: 36)

          Image("BrandMark")
            .resizable()
            .scaledToFit()
            .frame(width: 72, height: 72)
            .accessibilityHidden(true)

          VStack(spacing: 8) {
            Text(accountSignedIn ? "Choose your Mac" : "Connect your Mac")
              .font(.largeTitle)
              .bold()
              .multilineTextAlignment(.center)
            Text(accountSignedIn
              ? "Choose a Mac on your ADE account, or pair one directly."
              : "ADE Mobile works with ADE on a Mac. Sign in to find your Macs and connect from anywhere, or pair one directly without an account.")
              .font(.body)
              .foregroundStyle(.secondary)
              .multilineTextAlignment(.center)
          }

          VStack(spacing: 12) {
            Button(accountSignedIn ? "View your Macs" : "Sign in to find your Macs", systemImage: "person.crop.circle") {
              accountConnectionError = nil
              presentedSheet = .signIn
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(!accountConfigured || accountLoading)

            Button("Continue without an account", systemImage: "arrow.right") {
              if hasPairedHost {
                onContinue()
              } else {
                presentedSheet = .pairMachine
              }
            }
            .buttonStyle(.bordered)
            .controlSize(.large)

            Text(hasPairedHost
              ? "Use your saved Mac now. You can connect another Mac from Settings."
              : "Next, choose a simple way to connect your Mac on the same Wi-Fi. An account is not required; Tailscale can connect it from elsewhere.")
              .font(.footnote)
              .foregroundStyle(.secondary)
              .multilineTextAlignment(.center)

            if accountLoading {
              ProgressView("Checking account…")
                .font(.subheadline)
            } else if !accountConfigured {
              Text("Sign-in is unavailable in this build. You can still connect to a Mac without an account.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            }

            if let accountConnectionError {
              Text(accountConnectionError)
                .font(.footnote)
                .foregroundStyle(.red)
                .multilineTextAlignment(.center)
            }
          }
          .frame(maxWidth: 420)

          Spacer(minLength: 24)
        }
        .padding()
        .frame(maxWidth: .infinity)
      }
      .navigationTitle("")
      .navigationBarTitleDisplayMode(.inline)
    }
    .sheet(item: $presentedSheet) { sheet in
      switch sheet {
      case .signIn:
        AccountSignInView(
          onConnect: connectToAccountMachine,
          onFinish: onContinue
        )
      case .pairMachine:
        ConnectionSettingsView(syncService: syncService, pairingOnly: true)
      }
    }
    .onChange(of: syncService.requestedPairingQrNavigation?.id) { _, requestId in
      guard requestId != nil else { return }
      presentedSheet = .pairMachine
    }
    .onChange(of: syncService.hasPairedHost) { _, isPaired in
      guard isPaired, presentedSheet == .pairMachine else { return }
      presentedSheet = nil
      onContinue()
    }
  }

  private func connectToAccountMachine(_ machine: AccountMachine) {
    Task { @MainActor in
      guard let session = await AccountService.shared.pairingSession() else {
        accountConnectionError = "Your account session ended. Sign in again, then choose your Mac."
        return
      }
      let connected = await syncService.pairWithAccountMachine(
        machine,
        accountToken: session.token,
        authorization: session.authorization
      )
      if connected {
        onContinue()
      } else {
        accountConnectionError = syncService.lastError ?? "ADE could not connect to that Mac. Try again."
      }
    }
  }
}
