import SwiftUI

struct ConnectionSettingsView: View {
  @EnvironmentObject private var syncService: SyncService

  @State private var presentedSheet: SettingsPairSheetRoute?
  @State private var pinPreset: PinPreset?

  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(spacing: 18) {
          SettingsConnectionHeader()
            .environmentObject(syncService)
            .padding(.horizontal, 16)
            .padding(.top, 4)

          SettingsPairingSection(presentedSheet: $presentedSheet)
            .environmentObject(syncService)
            .padding(.horizontal, 16)

          SettingsNotificationsSection(
            onPreferencesChanged: { prefs in
              SyncService.shared?.uploadNotificationPrefs(prefs)
            },
            onSendTestPush: {
              SyncService.shared?.sendTestPush()
            }
          )
          .padding(.horizontal, 16)

          SettingsAppearanceSection()
            .padding(.horizontal, 16)

          SettingsDiagnosticsSection()
            .environmentObject(syncService)
            .padding(.horizontal, 16)

          Spacer(minLength: 20)
        }
        .padding(.vertical, 12)
      }
      .background(SettingsAuroraBackground().ignoresSafeArea())
      .adeNavigationGlass()
      .navigationTitle("Settings")
      .sheet(item: $presentedSheet) { route in
        presentedPairingSheet(route)
      }
      .sheet(item: $pinPreset) { preset in
        SettingsPinSheet(preset: preset, syncService: syncService)
          .presentationDetents([.large])
      }
    }
  }

  @ViewBuilder
  private func presentedPairingSheet(_ route: SettingsPairSheetRoute) -> some View {
    switch route {
    case .discover:
      DiscoverHostsSheet { host in
        presentedSheet = nil
        pinPreset = .discover(host)
      }
      .environmentObject(syncService)
      .presentationDetents([.medium, .large])

    case .qr:
      ScanQRSheet { payload in
        presentedSheet = nil
        pinPreset = .qr(payload)
      }
      .environmentObject(syncService)
      .presentationDetents([.large])

    case .manual:
      ManualEntrySheet { host, port in
        presentedSheet = nil
        pinPreset = .manual(host: host, port: port)
      }
      .presentationDetents([.medium])
    }
  }
}

private struct SettingsAuroraBackground: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var driftPhase: CGFloat = 0

  var body: some View {
    ZStack {
      ADEColor.pageBackground

      RadialGradient(
        colors: [
          ADEColor.purpleAccent.opacity(0.35),
          ADEColor.purpleAccent.opacity(0.0),
        ],
        center: UnitPoint(x: 0.5, y: -0.05),
        startRadius: 30,
        endRadius: 420
      )

      RadialGradient(
        colors: [
          Color(red: 99.0 / 255.0, green: 102.0 / 255.0, blue: 241.0 / 255.0).opacity(0.22),
          .clear,
        ],
        center: UnitPoint(
          x: 0.92 + (reduceMotion ? 0 : sin(driftPhase) * 0.06),
          y: 0.18
        ),
        startRadius: 8,
        endRadius: 280
      )

      RadialGradient(
        colors: [
          Color(red: 236.0 / 255.0, green: 72.0 / 255.0, blue: 153.0 / 255.0).opacity(0.14),
          .clear,
        ],
        center: UnitPoint(
          x: 0.05 + (reduceMotion ? 0 : cos(driftPhase) * 0.05),
          y: 0.32
        ),
        startRadius: 6,
        endRadius: 240
      )
    }
    .onAppear {
      guard !reduceMotion else { return }
      withAnimation(.linear(duration: 18).repeatForever(autoreverses: true)) {
        driftPhase = .pi
      }
    }
  }
}
