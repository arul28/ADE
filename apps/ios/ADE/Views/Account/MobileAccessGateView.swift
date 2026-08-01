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
  @State private var pinPreset: PinPreset?
  @State private var pinSetupRoute: PinSetupRoute?

  var body: some View {
    NavigationStack {
      GeometryReader { geometry in
        ScrollView {
          VStack(spacing: 0) {
            Spacer(minLength: 44)

            // Hero: the real ADE wordmark, big and centered, over a single line of
            // device-neutral copy. No explanatory paragraphs (M1).
            Image("BrandMark")
              .resizable()
              .renderingMode(.original)
              .interpolation(.high)
              .aspectRatio(contentMode: .fit)
              .frame(maxWidth: 260)
              .frame(height: 132)
              .frame(maxWidth: .infinity)
              .shadow(color: ADEColor.purpleAccent.opacity(0.45), radius: 24)
              .accessibilityLabel("ADE")
              .padding(.bottom, 24)

            Text("Your agents, anywhere.")
              .font(.system(.title3, design: .rounded).weight(.semibold))
              .foregroundStyle(ADEColor.textSecondary)
              .multilineTextAlignment(.center)

            Spacer()

            VStack(spacing: 14) {
              Button {
                accountConnectionError = nil
                presentedSheet = .signIn
              } label: {
                Group {
                  if accountLoading {
                    HStack(spacing: 8) {
                      ProgressView()
                        .controlSize(.small)
                      Text("Checking account…")
                    }
                  } else {
                    Text(accountSignedIn ? "View your computers" : "Sign in")
                  }
                }
                .font(.headline)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 15)
              }
              .buttonStyle(.glassProminent)
              .tint(ADEColor.accent)
              .disabled(!accountConfigured || accountLoading)

              if !accountConfigured && !accountLoading {
                Text("Account sign-in is not configured on this device.")
                  .font(.footnote)
                  .foregroundStyle(ADEColor.textMuted)
                  .multilineTextAlignment(.center)
              }

              Button {
                if hasPairedHost {
                  onContinue()
                } else {
                  presentedSheet = .pairMachine
                }
              } label: {
                Text("Continue without an account")
                  .font(.subheadline.weight(.semibold))
                  .foregroundStyle(ADEColor.textSecondary)
                  .frame(minHeight: 44)
                  .frame(maxWidth: .infinity)
                  .contentShape(Rectangle())
              }
              .buttonStyle(.plain)

              if syncService.connectionState == .connecting,
                 let stage = syncService.accountConnectStageLabel {
                Text(stage)
                  .font(.footnote.weight(.medium))
                  .foregroundStyle(ADEColor.textSecondary)
                  .multilineTextAlignment(.center)
                  .transition(.opacity)
              }

              if let accountConnectionError {
                VStack(spacing: 8) {
                  Text(accountConnectionError)
                    .font(.footnote)
                    .foregroundStyle(ADEColor.danger)
                    .multilineTextAlignment(.center)
                  if let fallbackHost = syncService.accountPairingPinFallbackHost {
                    Button("Pair with PIN instead") {
                      pinPreset = .discover(fallbackHost)
                    }
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(ADEColor.accent)
                    .frame(minHeight: 44)
                    .buttonStyle(.plain)
                  }
                }
              }
            }
            .frame(maxWidth: 420)
            .padding(.horizontal, 28)
            .padding(.bottom, 40)
          }
          .frame(maxWidth: .infinity, minHeight: geometry.size.height)
        }
        .scrollIndicators(.hidden)
        .background(AccountAuroraBackground().ignoresSafeArea())
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
    .sheet(item: $pinPreset) { preset in
      SettingsPinSheet(
        preset: preset,
        syncService: syncService,
        onNeedsPinSetup: { route in
          pinPreset = nil
          pinSetupRoute = route
        }
      )
      .presentationDetents([.large])
    }
    .sheet(item: $pinSetupRoute) { route in
      SettingsPinSetupSheet(
        route: route,
        onTryAgain: { preset in
          pinSetupRoute = nil
          pinPreset = preset
        }
      )
      .presentationDetents([.large])
    }
    .onChange(of: syncService.requestedPairingQrNavigation?.id) { _, requestId in
      guard requestId != nil else { return }
      presentedSheet = .pairMachine
    }
    .onChange(of: syncService.hasPairedHost) { _, isPaired in
      guard isPaired else { return }
      if presentedSheet == .pairMachine {
        presentedSheet = nil
        onContinue()
      } else if pinPreset != nil {
        pinPreset = nil
        onContinue()
      }
    }
  }

  private func connectToAccountMachine(_ machine: AccountMachine) {
    Task { @MainActor in
      accountConnectionError = nil
      guard let authorization = AccountService.shared.currentPairingAuthorization else {
        accountConnectionError = "Your account session ended. Sign in again, then choose your computer."
        return
      }
      let connected = await syncService.pairWithAccountMachine(
        machine,
        authorization: authorization
      )
      if connected {
        ADEHaptics.medium()
        onContinue()
      } else {
        accountConnectionError = syncService.lastError ?? "ADE could not connect to that computer. Try again."
      }
    }
  }
}
