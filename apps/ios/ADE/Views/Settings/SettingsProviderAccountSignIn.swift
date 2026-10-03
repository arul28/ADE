import SwiftUI
import UIKit

/// Drives one sign-in the host runs for an account: start it, poll it, pass the
/// pasted code back. The provider's CLI runs on the machine, so the login lands
/// in that account's folder there; the phone only opens the page and relays.
@MainActor
final class ProviderAccountSignInController: ObservableObject {
  @Published private(set) var login: ProviderAccountLogin?
  @Published private(set) var starting = false
  @Published private(set) var submitting = false
  @Published var errorMessage: String?

  let account: ProviderAccount
  private let client: ProviderAccountsClient?
  private var pollTask: Task<Void, Never>?
  private var closed = false

  init(account: ProviderAccount, host: ProviderAccountsHost?) {
    self.account = account
    self.client = host.map(ProviderAccountsClient.init(host:))
  }

  #if DEBUG
  init(account: ProviderAccount, fixture: ProviderAccountLogin?) {
    self.account = account
    self.client = nil
    self.login = fixture
  }
  #endif

  var provider: ProviderAccountProvider { ProviderAccountProvider(rawValue: account.provider) ?? .claude }

  func start() async {
    guard let client, !starting else { return }
    starting = true
    closed = false
    errorMessage = nil
    defer { starting = false }
    do {
      let started = try await client.startLogin(id: account.id, provider: provider)
      login = started
      // The sheet closed while the host was starting: end this sign-in too.
      if closed { cancel(); return }
      poll()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func submit(code: String) async {
    guard let client, let loginId = login?.loginId else { return }
    submitting = true
    defer { submitting = false }
    do {
      login = try await client.submitLoginCode(loginId: loginId, code: code)
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func cancel() {
    closed = true
    pollTask?.cancel()
    guard let client, let login, login.isLive else { return }
    let loginId = login.loginId
    Task { _ = try? await client.cancelLogin(loginId: loginId) }
  }

  private func poll() {
    pollTask?.cancel()
    pollTask = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .milliseconds(1200))
        guard let self, !Task.isCancelled, let client = self.client,
              let current = self.login, current.isLive else { return }
        do {
          let status = try await client.loginStatus(loginId: current.loginId)
          // A retry may have started a new sign-in while this reply was in
          // flight; a reply for the replaced one must not overwrite it.
          guard !Task.isCancelled, self.login?.loginId == current.loginId else { return }
          self.login = status
        } catch {
          guard !Task.isCancelled, self.login?.loginId == current.loginId else { return }
          // A dropped connection is retried on the next tick. A connected host
          // that refuses (it restarted and lost the sign-in) is final: say so
          // rather than spinning on a sign-in that no longer exists.
          guard client.host.providerAccountsConnected else { continue }
          self.errorMessage = error.localizedDescription
          return
        }
      }
    }
  }

  deinit { pollTask?.cancel() }
}

struct ProviderAccountSignInSheet: View {
  @StateObject private var controller: ProviderAccountSignInController
  let onDone: (String?) -> Void
  @Environment(\.dismiss) private var dismiss
  @Environment(\.openURL) private var openURL
  @State private var code = ""
  @State private var copied = false
  @State private var openedPage = false
  @State private var reportedDone = false
  @FocusState private var codeFocused: Bool

  init(account: ProviderAccount, host: ProviderAccountsHost?, onDone: @escaping (String?) -> Void) {
    _controller = StateObject(wrappedValue: ProviderAccountSignInController(account: account, host: host))
    self.onDone = onDone
  }

  #if DEBUG
  init(controller: ProviderAccountSignInController) {
    _controller = StateObject(wrappedValue: controller)
    self.onDone = { _ in }
  }
  #endif

  private var login: ProviderAccountLogin? { controller.login }
  private var account: ProviderAccount { controller.account }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: 22) {
          header
          stepList
          content
          if let error = controller.errorMessage ?? failureMessage {
            ADEFlatInlineNotice(message: error, tint: ADEColor.danger) {
              Task { await controller.start() }
            }
            .padding(.horizontal, 4)
          }
        }
        .padding(.horizontal, 20)
        .padding(.top, 12)
        .padding(.bottom, 32)
      }
      .background(ADEColor.pageBackground.ignoresSafeArea())
      .navigationTitle("Sign in")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button(login?.state == "succeeded" ? "Close" : "Cancel") { dismiss() }
        }
      }
      .task {
        if controller.login == nil { await controller.start() }
      }
      .onChange(of: login?.awaitingCode ?? false) { _, awaiting in
        if awaiting { codeFocused = true }
      }
      .onChange(of: login?.state) { _, state in
        if state == "succeeded" { ADEHaptics.success() }
      }
      .animation(.snappy, value: login)
    }
    // Every way out (Cancel, a swipe down, Done) ends a sign-in still running
    // on the host, so its login CLI does not linger until the timeout, and a
    // sign-in that succeeded is reported however the sheet closed.
    .onDisappear {
      controller.cancel()
      if login?.state == "succeeded" { reportDone() }
    }
  }

  // MARK: Pieces

  private var header: some View {
    VStack(spacing: 10) {
      VStack(spacing: 6) {
        Text(account.label)
          .font(.title3.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        HStack(spacing: 5) {
          WorkProviderBareLogo(provider: account.provider, fallbackSymbol: "sparkles", tint: ADEColor.textSecondary, size: 12)
          Text(controller.provider.title)
            .font(.caption.weight(.medium))
            .foregroundStyle(ADEColor.textSecondary)
        }
      }
      Text(controller.provider.signInSubtitle)
        .font(.footnote)
        .foregroundStyle(ADEColor.textSecondary)
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
    }
    .frame(maxWidth: .infinity)
  }


  private enum Step: Int { case open, approve, finish }

  private var currentStep: Step {
    guard let login else { return .open }
    if login.state == "verifying" || login.state == "succeeded" { return .finish }
    // The page is step one until it has been opened.
    if openedPage { return .approve }
    return .open
  }

  private var stepList: some View {
    let titles = controller.provider.signInSteps
    return HStack(alignment: .top, spacing: 0) {
      ForEach(Array(titles.enumerated()), id: \.offset) { index, title in
        let state = stepState(index)
        VStack(spacing: 6) {
          ZStack {
            Circle()
              .fill(state == .done ? ADEColor.accent : state == .active ? ADEColor.accent.opacity(0.16) : ADEColor.textPrimary.opacity(0.06))
              .frame(width: 26, height: 26)
            if state == .done {
              Image(systemName: "checkmark").font(.system(size: 11, weight: .bold)).foregroundStyle(.white)
            } else {
              Text("\(index + 1)")
                .font(.system(size: 12, weight: .semibold, design: .rounded))
                .foregroundStyle(state == .active ? ADEColor.accent : ADEColor.textMuted)
            }
          }
          Text(title)
            .font(.caption2.weight(state == .active ? .semibold : .regular))
            .foregroundStyle(state == .upcoming ? ADEColor.textMuted : ADEColor.textPrimary)
            .multilineTextAlignment(.center)
            .lineLimit(2)
            .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity)
      }
    }
  }

  private enum StepState { case done, active, upcoming }

  private func stepState(_ index: Int) -> StepState {
    if login?.state == "succeeded" { return .done }
    let current = currentStep.rawValue
    if index < current { return .done }
    return index == current ? .active : .upcoming
  }

  @ViewBuilder
  private var content: some View {
    if login?.state == "succeeded" {
      successCard
    } else if login?.state == "verifying" {
      progressCard("Checking the new login on your computer…")
    } else if let login, login.isLive {
      VStack(spacing: 14) {
        if let deviceCode = login.deviceCode {
          deviceCodeCard(deviceCode)
        }
        if let url = login.url.flatMap(URL.init(string:)) {
          if openedPage {
            Button {
              openURL(url)
            } label: {
              Label("Open sign-in page again", systemImage: "safari")
                .font(.subheadline.weight(.semibold))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 4)
            }
            .buttonStyle(.glass)
            .tint(ADEColor.accent)
          } else {
            Button {
              if let deviceCode = login.deviceCode {
                UIPasteboard.general.string = deviceCode
                copied = true
              }
              openedPage = true
              openURL(url)
            } label: {
              Label(login.deviceCode == nil ? "Open sign-in page" : "Copy code & open sign-in page", systemImage: "safari")
                .font(.body.weight(.semibold))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
            }
            .buttonStyle(.glassProminent)
            .tint(ADEColor.accent)
          }
        } else {
          progressCard("Starting sign-in on your computer…")
        }
        if login.awaitingCode {
          codeEntry
        } else if openedPage {
          HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text(login.deviceCode == nil ? "Waiting for you to approve in the browser…" : "Paste the code on the page and approve. This finishes by itself.")
              .font(.footnote)
              .foregroundStyle(ADEColor.textSecondary)
          }
          .padding(.top, 2)
        } else if login.url != nil, !controller.provider.usesDeviceCode {
          Text("After you approve, the page shows a code. Come back here to paste it.")
            .font(.footnote)
            .foregroundStyle(ADEColor.textMuted)
            .multilineTextAlignment(.center)
        }
      }
    } else if controller.starting || login == nil, controller.errorMessage == nil {
      progressCard("Starting sign-in on your computer…")
    } else if login?.state == "failed" || login?.state == "cancelled" {
      Button {
        Task { await controller.start() }
      } label: {
        Label("Try again", systemImage: "arrow.clockwise")
          .font(.body.weight(.semibold))
          .frame(maxWidth: .infinity)
          .padding(.vertical, 6)
      }
      .buttonStyle(.glassProminent)
      .tint(ADEColor.accent)
    }
  }


  private func deviceCodeCard(_ deviceCode: String) -> some View {
    VStack(spacing: 10) {
      Text("YOUR CODE")
        .font(.caption2.weight(.semibold))
        .tracking(0.8)
        .foregroundStyle(ADEColor.textMuted)
      Text(deviceCode)
        .font(.system(size: 34, weight: .semibold, design: .monospaced))
        .tracking(3)
        .foregroundStyle(ADEColor.textPrimary)
        .textSelection(.enabled)
        .minimumScaleFactor(0.6)
        .lineLimit(1)
      Button {
        UIPasteboard.general.string = deviceCode
        ADEHaptics.light()
        copied = true
      } label: {
        Label(copied ? "Copied" : "Copy code", systemImage: copied ? "checkmark" : "doc.on.doc")
          .font(.footnote.weight(.semibold))
      }
      .buttonStyle(.glass)
      .controlSize(.small)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 18)
    .background(ADEColor.textPrimary.opacity(0.04), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(ADEColor.border.opacity(0.6), lineWidth: 0.75))
  }

  private var codeEntry: some View {
    let hasCode = !code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    return VStack(alignment: .leading, spacing: 10) {
      Text("Paste the code from the browser")
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
      HStack(spacing: 8) {
        TextField("Code", text: $code)
          .font(.adeMono(15))
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .focused($codeFocused)
          .submitLabel(.go)
          .onSubmit(submit)
        Button {
          if let pasted = UIPasteboard.general.string { code = pasted.trimmingCharacters(in: .whitespacesAndNewlines) }
          ADEHaptics.light()
        } label: {
          Label("Paste", systemImage: "doc.on.clipboard")
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(ADEColor.accent.opacity(0.12), in: Capsule())
            .foregroundStyle(ADEColor.accent)
        }
        .buttonStyle(.plain)
      }
      .padding(.leading, 14)
      .padding(.trailing, 8)
      .padding(.vertical, 8)
      .background(ADEColor.textPrimary.opacity(0.05), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .stroke(codeFocused ? ADEColor.accent.opacity(0.6) : Color.clear, lineWidth: 1)
      )
      Button(action: submit) {
        Group {
          if controller.submitting { ProgressView().tint(.white) } else { Text("Finish sign-in") }
        }
        .font(.body.weight(.semibold))
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
      }
      .buttonStyle(.glassProminent)
      .tint(ADEColor.accent)
      .disabled(!hasCode || controller.submitting)
      .opacity(hasCode ? 1 : 0.45)
      .padding(.top, 4)
    }
  }

  private var successCard: some View {
    VStack(spacing: 12) {
      Image(systemName: "checkmark.circle.fill")
        .font(.system(size: 46, weight: .semibold))
        .foregroundStyle(ADEColor.success)
        .symbolEffect(.bounce, value: login?.state)
      Text("Signed in")
        .font(.headline)
        .foregroundStyle(ADEColor.textPrimary)
      if let email = login?.email {
        Text(email)
          .font(.subheadline)
          .foregroundStyle(ADEColor.textSecondary)
      }
      Button {
        reportDone()
      } label: {
        Text("Done")
          .font(.body.weight(.semibold))
          .frame(maxWidth: .infinity)
          .padding(.vertical, 6)
      }
      .buttonStyle(.glassProminent)
      .tint(ADEColor.accent)
      .padding(.top, 6)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 8)
  }

  private func progressCard(_ text: String) -> some View {
    HStack(spacing: 10) {
      ProgressView()
      Text(text)
        .font(.subheadline)
        .foregroundStyle(ADEColor.textSecondary)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 18)
  }

  private var failureMessage: String? {
    guard let login else { return nil }
    if login.state == "failed" { return login.message ?? "The sign-in did not finish. Try again." }
    if login.state == "cancelled" { return "The sign-in was cancelled." }
    return nil
  }

  /// Tells the caller the sign-in finished, once, from Done or from closing.
  private func reportDone() {
    guard !reportedDone else { return }
    reportedDone = true
    onDone(login?.email)
  }

  private func submit() {
    let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    Task { await controller.submit(code: trimmed) }
  }
}
