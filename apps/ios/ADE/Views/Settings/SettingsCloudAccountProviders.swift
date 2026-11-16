import SwiftUI

/// Settings › Providers for a person with no computer of their own: what
/// each coding agent needs on ADE Cloud, from the account server
/// (`GET /cloud/models`, `GET /cloud/sign-ins`). API keys save to the account
/// vault (`PUT /cloud/sign-ins/:id`), and every later cloud computer reads
/// them. The web shows the same list (`AccountCloudProvidersPanel.tsx`).
struct SettingsCloudAccountProviders: View {
  let syncService: SyncService
  @ObservedObject private var launches = AccountCloudLaunchStore.shared
  @State private var signIns: CloudAccountSignIns?
  @State private var signInsError: String?

  var body: some View {
    ADESettingsSection("Providers on ADE Cloud", hint: "What each coding agent needs before it runs a chat on ADE Cloud. Keys save to your account, so every cloud computer can use them.") {
      if let error = launches.catalogError, launches.catalog == nil {
        ADESettingsNotice(message: "Couldn't load the providers. \(error)", tone: .crit, actionTitle: "Try again") {
          Task { await launches.loadCatalogIfNeeded(using: syncService) }
        }
      }
      if let signInsError {
        ADESettingsNotice(message: "Couldn't read your saved keys. \(signInsError)", tone: .crit, actionTitle: "Try again") {
          Task { await loadSignIns() }
        }
      }
      if let catalog = launches.catalog {
        ADESettingsRows {
          ForEach(catalog.providers, id: \.provider) { provider in
            SettingsCloudProviderRow(
              syncService: syncService,
              provider: provider,
              signIn: signIns?.signIns.first { $0.providers.contains(provider.provider) },
              vaultUnknown: signIns?.unknown == true,
              onChanged: { signIns = $0 }
            )
          }
        }
      } else if launches.catalogError == nil {
        ADESettingsRows {
          ADESettingsLoadingRow(title: "Loading the providers…")
        }
      }
    }
    .task {
      async let catalog: Void = launches.loadCatalogIfNeeded(using: syncService)
      async let keys: Void = loadSignIns()
      _ = await (catalog, keys)
    }
  }

  private func loadSignIns() async {
    guard let client = await syncService.cloudServerClient() else { return }
    do {
      signIns = try await client.accountSignIns()
      signInsError = nil
    } catch {
      signInsError = cloudServerFailureMessage(error)
    }
  }
}

private struct SettingsCloudProviderRow: View {
  let syncService: SyncService
  let provider: CloudCatalogProvider
  let signIn: CloudAccountSignIn?
  let vaultUnknown: Bool
  let onChanged: (CloudAccountSignIns) -> Void
  @Environment(\.openURL) private var openURL
  @State private var editing = false
  @State private var value = ""
  @State private var busy = false
  @State private var error: String?
  /// Dropped on save: the keyboard would hide the answer under the field.
  @FocusState private var fieldFocused: Bool

  private var saved: Bool { signIn?.saved == true }

  private var status: (text: String, tone: ADEKitTone) {
    switch provider.remoteSignIn {
    case "desktop": return ("Sign in from ADE desktop", .neutral)
    case "api_key":
      if saved { return ("Key saved", .ok) }
      return vaultUnknown ? ("Couldn't check", .neutral) : ("Needs a key", .warn)
    case "url_paste": return saved ? ("Pass saved", .ok) : ("Signs in at your first chat", .neutral)
    default: return ("Signs in at your first chat", .neutral)
    }
  }

  private var line: String {
    switch provider.remoteSignIn {
    case "desktop": return "This provider signs in only in ADE desktop. Sign in there, and cloud chats can use it."
    case "api_key": return "\(signIn?.keyName ?? "An API key"), saved to your account."
    case "url_paste": return "The cloud computer opens a sign-in page. Paste the code it shows, and ADE keeps the pass for later computers."
    default: return "The cloud computer shows a code. Enter it on the provider's page."
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .center, spacing: 8) {
        Text(provider.label)
          .font(.system(size: 15, weight: .medium))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
        Spacer(minLength: 6)
        ADEKitTag(text: status.text, tone: status.tone, keepsCase: true)
      }
      Text(line)
        .font(.system(size: 12.5))
        .foregroundStyle(ADEColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
      if provider.remoteSignIn == "api_key", let signIn {
        if editing {
          HStack(spacing: 8) {
            SecureField(signIn.keyName, text: $value)
              .textInputAutocapitalization(.never)
              .autocorrectionDisabled()
              .font(.system(size: 14))
              .padding(.horizontal, 10)
              .frame(minHeight: 36)
              .background(ADEColor.recessedBackground, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
              .accessibilityLabel("\(signIn.keyName) for \(provider.label)")
              .focused($fieldFocused)
              .onSubmit(save)
            Button(busy ? "Saving…" : "Save", action: save)
              .buttonStyle(ADEKitButtonStyle(prominent: true))
              .disabled(busy || value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          }
          HStack(spacing: 8) {
            Button("Cancel") {
              editing = false
              value = ""
            }
            .buttonStyle(ADEKitButtonStyle())
            if let link = signIn.keyUrl.flatMap(URL.init(string:)) {
              Button("Get a key") { openURL(link) }
                .buttonStyle(ADEKitButtonStyle())
            }
          }
        } else {
          HStack(spacing: 8) {
            Button(saved ? "Replace" : "Add key") { editing = true }
              .buttonStyle(ADEKitButtonStyle())
            if saved {
              Button("Remove", action: remove)
                .buttonStyle(ADEKitButtonStyle(tone: .crit))
            }
          }
          .disabled(busy)
        }
      }
      if let error {
        Text("Couldn't save the key for \(provider.label). \(error)")
          .font(.system(size: 12.5))
          .foregroundStyle(ADEColor.danger)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .padding(.vertical, 10)
    .padding(.horizontal, 14)
  }

  private func save() {
    let key = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let signIn, !key.isEmpty, !busy else { return }
    run {
      try await $0.saveAccountSignIn(signIn.id, key: key)
    } then: {
      value = ""
      editing = false
    }
  }

  private func remove() {
    guard let signIn, !busy else { return }
    run { try await $0.removeAccountSignIn(signIn.id) } then: {}
  }

  private func run(_ call: @escaping (CloudServerClient) async throws -> CloudAccountSignIns, then done: @escaping () -> Void) {
    busy = true
    error = nil
    fieldFocused = false
    Task {
      defer { busy = false }
      guard let client = await syncService.cloudServerClient() else {
        error = "Sign in to ADE again, then try again."
        return
      }
      do {
        onChanged(try await call(client))
        done()
      } catch {
        self.error = cloudServerFailureMessage(error)
      }
    }
  }
}
