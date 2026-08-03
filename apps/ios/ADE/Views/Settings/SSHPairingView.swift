import SwiftUI
import UniformTypeIdentifiers

struct SSHPairingView: View {
  @Environment(\.dismiss) private var dismiss
  @EnvironmentObject private var syncService: SyncService
  @StateObject private var model: SSHPairingViewModel
  @State private var host = ""
  @State private var port = 22
  @State private var username = ""
  @State private var privateKey = ""
  @State private var passphrase = ""
  @State private var retainCredential = false
  @State private var importsKey = false
  @State private var importError: String?
  @State private var selectedNearbyHostId: String?
  @State private var pairingTask: Task<Void, Never>?

  init(syncService: SyncService) {
    _model = StateObject(wrappedValue: SSHPairingViewModel(syncService: syncService))
  }

  var body: some View {
    NavigationStack {
      Form {
        destinationSection
        credentialSection
        generatedKeySection
        securitySection
        statusSection
      }
      .navigationTitle("SSH (advanced)")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel", action: dismiss.callAsFunction)
        }
      }
      .safeAreaInset(edge: .bottom) {
        Button("Connect", systemImage: "lock.shield", action: beginPairing)
          .buttonStyle(.borderedProminent)
          .controlSize(.large)
          .disabled(model.state.isBusy || host.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || username.isEmpty || privateKey.isEmpty)
          .padding()
          .frame(maxWidth: .infinity)
          .background(.bar)
      }
      .fileImporter(
        isPresented: $importsKey,
        allowedContentTypes: [.plainText, .data],
        allowsMultipleSelection: false,
        onCompletion: importKey
      )
      .alert("Confirm SSH fingerprint", isPresented: fingerprintConfirmationPresented) {
        Button("Cancel", role: .cancel, action: model.cancelConfirmation)
        Button("This matches") {
          guard case .needsHostConfirmation(let fingerprint) = model.state else { return }
          Task { await model.confirmHostFingerprint(fingerprint) }
        }
      } message: {
        if case .needsHostConfirmation(let fingerprint) = model.state {
          Text("Before continuing, compare this fingerprint with the one shown on your computer:\n\n\(fingerprint)")
        }
      }
      .onChange(of: model.state) { _, state in
        if case .paired = state {
          privateKey = ""
          passphrase = ""
          model.clearEphemeralCredential()
          ADEHaptics.medium()
        }
      }
      .onDisappear {
        pairingTask?.cancel()
        pairingTask = nil
      }
    }
  }

  private var destinationSection: some View {
    Section("Machine") {
      if !syncService.discoveredHosts.isEmpty {
        Picker("Nearby", selection: $selectedNearbyHostId) {
          Text("Enter manually").tag(String?.none)
          ForEach(syncService.discoveredHosts) { machine in
            Text(machine.hostName).tag(String?.some(machine.id))
          }
        }
        .onChange(of: selectedNearbyHostId) { _, identifier in
          guard let identifier,
                let machine = syncService.discoveredHosts.first(where: { $0.id == identifier }) else { return }
          host = machine.addresses.first ?? machine.hostName
        }
      }
      TextField("Host or Tailscale address", text: $host)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
      TextField("SSH port", value: $port, format: .number)
        .keyboardType(.numberPad)
      TextField("Computer username", text: $username)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
    }
  }

  private var credentialSection: some View {
    Section {
      TextField("Paste an Ed25519 or ECDSA OpenSSH private key", text: $privateKey, axis: .vertical)
        .lineLimit(5...12)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .font(.system(.footnote, design: .monospaced))
        .privacySensitive()
      SecureField("Passphrase, if needed", text: $passphrase)
        .textContentType(.password)
      Button("Import key file", systemImage: "doc.badge.plus") {
        importError = nil
        importsKey = true
      }
      if let importError {
        Text(importError)
          .font(.footnote)
          .foregroundStyle(.red)
      }
      Button("Use saved key", systemImage: "faceid") {
        Task {
          guard let saved = await model.loadRetainedCredential(host: host, port: port, username: username) else { return }
          privateKey = saved.privateKey
          passphrase = saved.passphrase
        }
      }
      Toggle("Save key on this iPhone", isOn: $retainCredential)
      Text(retainCredential
        ? "Face ID or Touch ID is required before ADE can use it again."
        : "The key is used only for this setup, then removed.")
        .font(.footnote)
        .foregroundStyle(.secondary)
    } header: {
      Text("Private key")
    } footer: {
      Text("Supported: Ed25519 with or without a passphrase, and unencrypted ECDSA P-256, P-384, or P-521. Encrypted ECDSA and RSA keys are not accepted. For encrypted ECDSA, use an unencrypted copy or create an Ed25519 key.")
    }
  }

  @ViewBuilder
  private var generatedKeySection: some View {
    Section("No private key?") {
      Button("Create a key for ADE", systemImage: "key") {
        let generated = model.generateKey()
        privateKey = generated.privateKey
        passphrase = ""
      }
      if let generated = model.generatedKey {
        Text("Run this once on the computer, then return here and pair:")
          .font(.footnote)
          .foregroundStyle(.secondary)
        Text(generated.authorizationCommand)
          .font(.system(.footnote, design: .monospaced))
          .textSelection(.enabled)
        ShareLink(item: generated.authorizationCommand) {
          Label("Share setup command", systemImage: "square.and.arrow.up")
        }
      }
    }
  }

  private var securitySection: some View {
    Section("Security") {
      Label("ADE asks you to compare the computer's fingerprint before trusting it.", systemImage: "checkmark.shield")
        .font(.footnote)
      Label("SSH is used only for setup. ADE reconnects normally after that.", systemImage: "link.badge.plus")
        .font(.footnote)
    }
  }

  @ViewBuilder
  private var statusSection: some View {
    switch model.state {
    case .checkingHost:
      Section { ProgressView("Checking the computer…") }
    case .pairing:
      Section { ProgressView("Connecting to ADE…") }
    case .paired(let machine, let warning):
      Section {
        Label("Paired with \(machine)", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
        if let warning { Text(warning).font(.footnote).foregroundStyle(.orange) }
      }
    case .failed(let message):
      Section { Label(message, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red) }
    case .idle, .needsHostConfirmation:
      EmptyView()
    }
  }

  private var fingerprintConfirmationPresented: Binding<Bool> {
    Binding(
      get: {
        if case .needsHostConfirmation = model.state { return true }
        return false
      },
      set: { isPresented in
        if !isPresented, case .needsHostConfirmation = model.state {
          model.cancelConfirmation()
        }
      }
    )
  }

  private func beginPairing() {
    let input = SSHConnectionInput(
      host: host,
      port: port,
      username: username,
      privateKey: privateKey,
      passphrase: passphrase
    )
    pairingTask?.cancel()
    pairingTask = Task { await model.begin(input: input, retainCredential: retainCredential) }
  }

  private func importKey(_ result: Result<[URL], Error>) {
    do {
      guard let url = try result.get().first else { return }
      guard url.startAccessingSecurityScopedResource() else {
        importError = "ADE could not open that key file. Choose it again, or paste the key instead."
        return
      }
      defer { url.stopAccessingSecurityScopedResource() }
      privateKey = try String(contentsOf: url, encoding: .utf8)
      importError = nil
    } catch {
      importError = "ADE could not read that key file. Choose a text key file, or paste the key instead."
    }
  }
}
