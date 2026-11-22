import SwiftUI

/// The dashboard's "Sign-ins on ADE Cloud" (`CloudSignIns.tsx`): one row per
/// provider ADE Cloud signs in with, in plain words, the rest as one line of
/// names, and the one switch.
struct CloudSignInsCard: View {
  @ObservedObject var store: CloudPaneStore

  var body: some View {
    let tiles = store.signIns.map(providerCloudTiles) ?? []
    let ready = tiles.filter { $0.state == .signedIn }
    let rest = tiles.filter { $0.state != .signedIn }
    ADEKitCard(title: "Sign-ins on ADE Cloud", symbol: "key", count: ready.isEmpty ? nil : "\(ready.count)", flush: true) {
      VStack(alignment: .leading, spacing: 0) {
        if let status = store.signIns {
          if !status.cloud.enabled {
            note("Your sign-ins aren't shared with ADE Cloud. Each cloud computer asks you to sign in on it.")
          } else {
            note(ready.isEmpty
              ? "No sign-in reaches ADE Cloud yet. Sign in to a provider on any of your computers and it reaches your cloud computers."
              : "Your cloud computers sign in with these accounts. A sign-in on any of your computers reaches them in about a minute.")
            ForEach(ready) { tile in
              ADESettingsHairline()
              HStack(spacing: 12) {
                ADEBrandTile(brand: .provider(tile.provider), size: 28)
                VStack(alignment: .leading, spacing: 2) {
                  Text(tile.label)
                    .font(.system(size: 14.5, weight: .medium))
                    .foregroundStyle(ADEColor.textPrimary)
                  Text([tile.account, tile.source].compactMap { $0 }.joined(separator: ". "))
                    .font(.system(size: 12.5))
                    .foregroundStyle(ADEColor.textSecondary)
                    .lineLimit(2)
                }
                Spacer(minLength: 6)
                ADEKitDot(tone: .ok)
              }
              .padding(.horizontal, ADEKit.inset)
              .padding(.vertical, 10)
              .accessibilityElement(children: .combine)
            }
            if !rest.isEmpty {
              ADESettingsHairline()
              VStack(alignment: .leading, spacing: 4) {
                ADEEyebrow("Not signed in")
                Text(rest.map(\.label).joined(separator: ", "))
                  .font(.system(size: 12.5))
                  .foregroundStyle(ADEColor.textSecondary)
                  .fixedSize(horizontal: false, vertical: true)
              }
              .padding(.horizontal, ADEKit.inset)
              .padding(.vertical, 10)
            }
          }
          ADESettingsHairline()
          ADESettingsRow(
            title: "Share my sign-ins with ADE Cloud",
            hint: status.cloud.enabled ? "Cloud computers use the accounts you're signed in to on your computers." : "Off: you sign in on each cloud computer yourself."
          ) {
            Toggle("", isOn: Binding(
              get: { status.cloud.enabled },
              set: { next in Task { await store.setSignInsShared(next) } }
            ))
            .labelsHidden()
            .tint(ADEColor.accent)
            .disabled(store.signInsSaving || !store.syncService.canInvokeRemoteAction("providerLogins.setCloudAll"))
          }
        } else if store.signInsUnreadable {
          note("ADE couldn't read your sign-ins. Pull to read them again.")
        } else if !store.syncService.supportsRemoteAction("providerLogins.status") {
          note("Update ADE on \(store.syncService.machineDisplayName) to see them here.")
        } else {
          note("Reading your sign-ins…")
        }
      }
    }
  }

  private func note(_ text: String) -> some View {
    Text(text)
      .font(.system(size: 13))
      .foregroundStyle(ADEColor.textSecondary)
      .fixedSize(horizontal: false, vertical: true)
      .padding(.horizontal, ADEKit.inset)
      .padding(.bottom, 12)
  }
}
