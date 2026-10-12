import AuthenticationServices
import SwiftUI
import UIKit

/// Drives one approval of a sign-in for another computer: read what the
/// computer is called, approve, open Clerk's one-time sign-in in a web sheet,
/// and close the sheet when the computer has its session.
@MainActor
final class DeviceSignInApprovalModel: NSObject, ObservableObject, ASWebAuthenticationPresentationContextProviding {
  enum Problem: Equatable {
    case signedOut
    case notFound
    case expired
    case alreadyUsed
    /// The directory cannot approve from an app. The browser page still can.
    case unavailable
    /// The web sheet closed before the computer was signed in.
    case unfinished
    case failed
  }

  enum Phase: Equatable {
    case loading
    case ready(machineName: String?)
    case approving(machineName: String?)
    case signedIn(machineName: String?)
    case problem(Problem)
  }

  @Published private(set) var phase: Phase = .loading

  /// Retained for the lifetime of the presentation.
  private var webSession: ASWebAuthenticationSession?
  private var statusPoll: Task<Void, Never>?

  private static let statusPollInterval: Duration = .seconds(2)

  deinit {
    statusPoll?.cancel()
  }

  private var client: DeviceSignInApprovalClient? {
    AccountConfig.directoryBaseURL.map { DeviceSignInApprovalClient(baseURL: $0) }
  }

  /// The browser page for this code, for the cases this phone cannot finish.
  func browserPageURL(for request: DeviceSignInRequest) -> URL? {
    client?.browserPageURL(userCode: request.userCode)
  }

  func load(_ request: DeviceSignInRequest, account: AccountService) async {
    phase = .loading
    guard let client else {
      phase = .problem(.unavailable)
      return
    }
    guard let token = await account.sessionToken() else {
      phase = .problem(.signedOut)
      return
    }
    do {
      let preview = try await client.preview(userCode: request.userCode, token: token)
      switch preview.status {
      case .pending: phase = .ready(machineName: preview.machineName)
      case .approved: phase = .signedIn(machineName: nil)
      case .started, .failed: phase = .problem(.alreadyUsed)
      }
    } catch {
      phase = .problem(Self.problem(for: error))
    }
  }

  func approve(_ request: DeviceSignInRequest, account: AccountService) async {
    guard case .ready(let machineName) = phase, let client else { return }
    phase = .approving(machineName: machineName)
    guard let token = await account.sessionToken() else {
      phase = .problem(.signedOut)
      return
    }
    let signInURL: URL
    do {
      signInURL = try await client.approve(userCode: request.userCode, token: token)
    } catch {
      phase = .problem(Self.problem(for: error))
      return
    }

    // The sheet has no callback to wait on: the sign-in ends on a page of the
    // directory. So the directory is asked whether the computer is signed in,
    // and the sheet is closed when it says yes.
    statusPoll = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: Self.statusPollInterval)
        guard let self, !Task.isCancelled else { return }
        if await self.isApproved(request, client: client, account: account) {
          self.phase = .signedIn(machineName: machineName)
          self.webSession?.cancel()
          return
        }
      }
    }
    await presentWebSheet(url: signInURL)
    statusPoll?.cancel()
    statusPoll = nil
    webSession = nil
    if case .signedIn = phase { return }
    // The person closed the sheet. They may have finished first.
    phase = await isApproved(request, client: client, account: account)
      ? .signedIn(machineName: machineName)
      : .problem(.unfinished)
  }

  private func isApproved(
    _ request: DeviceSignInRequest,
    client: DeviceSignInApprovalClient,
    account: AccountService
  ) async -> Bool {
    guard let token = await account.sessionToken() else { return false }
    return (try? await client.preview(userCode: request.userCode, token: token))?.status == .approved
  }

  /// Returns when the sheet closes, whoever closed it.
  private func presentWebSheet(url: URL) async {
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      // No page of this sign-in redirects to the callback scheme, so the
      // completion fires only when the sheet is closed.
      let session = ASWebAuthenticationSession(url: url, callbackURLScheme: "ade") { _, _ in
        continuation.resume()
      }
      // The one-time ticket signs the account in, so nothing is reused, and
      // nothing of this sign-in stays in the browser afterwards.
      session.prefersEphemeralWebBrowserSession = true
      session.presentationContextProvider = self
      webSession = session
      if !session.start() {
        webSession = nil
        continuation.resume()
      }
    }
  }

  private static func problem(for error: Error) -> Problem {
    switch error as? DeviceSignInApprovalError {
    case .signedOut: return .signedOut
    case .notFound: return .notFound
    case .expired: return .expired
    case .alreadyUsed: return .alreadyUsed
    case .unavailable: return .unavailable
    case .rateLimited, .failed, .none: return .failed
    }
  }

  nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    MainActor.assumeIsolated {
      let scene = UIApplication.shared.connectedScenes
        .compactMap { $0 as? UIWindowScene }
        .first { $0.activationState == .foregroundActive }
        ?? UIApplication.shared.connectedScenes
          .compactMap { $0 as? UIWindowScene }
          .first
      let window = scene?.keyWindow ?? scene?.windows.first
      return window ?? ASPresentationAnchor()
    }
  }
}

/// Sheet shown when this phone opens the sign-in link of another computer (the
/// QR code that `ade connect` and the desktop sign-in card show). The phone
/// already has the account, so the person approves here and types no password
/// on the other computer.
struct DeviceSignInApprovalSheet: View {
  let request: DeviceSignInRequest
  let onDismiss: () -> Void

  @EnvironmentObject private var accountService: AccountService
  @Environment(\.openURL) private var openURL
  @StateObject private var model = DeviceSignInApprovalModel()

  var body: some View {
    VStack(spacing: 20) {
      header
      content
    }
    .padding(.horizontal, 20)
    .padding(.top, 22)
    .padding(.bottom, 24)
    // Fill the sheet, so the page color covers it in every state. The short
    // states (signed in, a problem) are otherwise a band in a grey sheet.
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    .background(ADEColor.pageBackground)
    .presentationDetents([.medium])
    .presentationDragIndicator(.visible)
    .task(id: request.id) {
      await model.load(request, account: accountService)
    }
  }

  private var header: some View {
    VStack(spacing: 6) {
      Image(systemName: headerSymbol)
        .font(.system(size: 26, weight: .regular))
        .foregroundStyle(ADEColor.textSecondary)
        .padding(.bottom, 4)

      Text(title)
        .font(.system(.title3, design: .rounded).weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
        .multilineTextAlignment(.center)

      Text(detail)
        .font(.system(.footnote, design: .rounded))
        .foregroundStyle(ADEColor.textSecondary)
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private var headerSymbol: String {
    switch model.phase {
    case .signedIn: return "checkmark.circle"
    case .problem: return "exclamationmark.triangle"
    case .loading, .ready, .approving: return "desktopcomputer"
    }
  }

  private var title: String {
    switch model.phase {
    case .loading: return "Checking this sign-in…"
    case .ready, .approving: return "Sign in on another computer?"
    case .signedIn: return "Signed in"
    case .problem(.signedOut): return "Sign in on this phone first"
    case .problem: return "This sign-in did not work"
    }
  }

  private var detail: String {
    switch model.phase {
    case .loading:
      return "Code \(request.userCode)"
    case .ready, .approving:
      return "Approve only if you started this on that computer. It gets access to your ADE account."
    case .signedIn(let machineName):
      return "\(machineName ?? "That computer") is now on your ADE account."
    case .problem(let problem):
      switch problem {
      case .signedOut:
        return "Sign in to ADE on this phone, then scan the code again. You can also continue in the browser."
      case .notFound:
        return "ADE did not find this code. Start the sign-in again on the computer."
      case .expired:
        return "This code expired. Start the sign-in again on the computer."
      case .alreadyUsed:
        return "This code was already used. Start the sign-in again on the computer."
      case .unavailable:
        return "ADE cannot approve this here right now. Continue in the browser."
      case .unfinished:
        return "The sign-in was not finished. Start it again on the computer."
      case .failed:
        return "ADE could not reach your account. Check the connection, then try again."
      }
    }
  }

  @ViewBuilder
  private var content: some View {
    switch model.phase {
    case .loading:
      ProgressView()
        .controlSize(.regular)
        .padding(.vertical, 8)
      closeButton("Cancel")
    case .ready(let machineName):
      computerCard(machineName)
      approveButton(busy: false)
      closeButton("Cancel")
    case .approving(let machineName):
      computerCard(machineName)
      approveButton(busy: true)
      closeButton("Cancel")
    case .signedIn:
      closeButton("Done", prominent: true)
    case .problem(let problem):
      if problem == .failed {
        Button("Try again") {
          Task { await model.load(request, account: accountService) }
        }
        .buttonStyle(ADEKitButtonStyle(prominent: true, wide: true))
      }
      if problem == .signedOut || problem == .unavailable,
         let browserPage = model.browserPageURL(for: request) {
        Button("Continue in the browser") {
          openURL(browserPage)
          onDismiss()
        }
        .buttonStyle(ADEKitButtonStyle(prominent: true, wide: true))
      }
      closeButton("Close")
    }
  }

  private func computerCard(_ machineName: String?) -> some View {
    HStack(alignment: .top, spacing: 12) {
      Image(systemName: "desktopcomputer")
        .font(.system(size: 16, weight: .regular))
        .foregroundStyle(ADEColor.textSecondary)
        .frame(width: 34, height: 34)
        .background(ADEKit.track, in: RoundedRectangle(cornerRadius: 8, style: .continuous))

      VStack(alignment: .leading, spacing: 4) {
        Text(machineName ?? "A computer")
          .font(.system(.subheadline, design: .rounded).weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(2)
        Text("Code \(request.userCode)")
          .font(.system(.footnote, design: .monospaced))
          .foregroundStyle(ADEColor.textSecondary)
      }
      Spacer(minLength: 0)
    }
    .adeKitCard(padding: 12)
  }

  private func approveButton(busy: Bool) -> some View {
    Button {
      Task { await model.approve(request, account: accountService) }
    } label: {
      HStack(spacing: 8) {
        if busy {
          ProgressView()
            .progressViewStyle(.circular)
            .controlSize(.small)
            .tint(.white)
        }
        Text("Approve")
      }
    }
    .buttonStyle(ADEKitButtonStyle(prominent: true, wide: true))
    .disabled(busy)
  }

  private func closeButton(_ title: String, prominent: Bool = false) -> some View {
    Button(action: onDismiss) {
      Text(title)
    }
    .buttonStyle(ADEKitButtonStyle(prominent: prominent, wide: true))
  }
}
