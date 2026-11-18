import OSLog
import SwiftUI

private let accountDeleteLog = Logger(subsystem: "com.ade.ios", category: "AccountDelete")

// Settings › Account › Delete account (App Store guideline 5.1.1(v)). The
// person deletes their own ADE account from the phone: `POST /account/delete`
// with `{ "confirm": "delete" }` (`clientMinimumContract.ts`). The server asks
// Clerk to delete the user, and Clerk's `user.deleted` webhook removes
// everything ADE holds for it. After the 200 the phone signs out.

/// Why a deletion did not go through, in words for the person.
enum AccountDeletionError: LocalizedError, Equatable {
  case notSignedIn
  /// The server did not accept the sign-in. Also what a retry gets after a
  /// deletion that went through but whose answer was lost.
  case unauthorized
  case refused(String)
  case transport

  var errorDescription: String? {
    switch self {
    case .notSignedIn:
      return "Sign in to ADE again to delete your account."
    case .unauthorized:
      return "ADE couldn’t confirm your sign-in. If your account is already deleted, sign out."
    case .refused(let message):
      return message
    case .transport:
      return "ADE couldn’t reach the account server. Check the connection, then try again."
    }
  }
}

/// One `POST /account/delete`, retried once with a fresh token on a 401.
struct AccountDeletionClient {
  var baseURL: URL
  var session: URLSession = .adeAccount

  func delete(token: String, refreshToken: () async -> String?) async throws {
    var (data, status) = try await send(token)
    if status == 401, let fresh = await refreshToken().flatMap({ nonEmptyTrimmed($0) }) {
      (data, status) = try await send(fresh)
    }
    switch status {
    case 200..<300:
      return
    case 401:
      throw AccountDeletionError.unauthorized
    default:
      // `{ error: { code, message } }`: the server's sentence, as it is.
      let message = ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])
        .flatMap { $0["error"] as? [String: Any] }
        .flatMap { nonEmptyTrimmed($0["message"] as? String) }
      throw AccountDeletionError.refused(message ?? "ADE couldn’t delete your account (\(status)). Try again in a minute.")
    }
  }

  private func send(_ token: String) async throws -> (Data, Int) {
    var request = URLRequest(url: baseURL.appendingPathComponent("account/delete"))
    request.httpMethod = "POST"
    request.httpBody = Data(#"{"confirm":"delete"}"#.utf8)
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue(UUID().uuidString.lowercased(), forHTTPHeaderField: "X-ADE-Correlation-ID")
    request.cachePolicy = .reloadIgnoringLocalCacheData
    // Clerk's delete has 15 seconds on the server.
    request.timeoutInterval = 30
    do {
      let (data, response) = try await session.data(for: request)
      guard let http = response as? HTTPURLResponse else { throw AccountDeletionError.transport }
      return (data, http.statusCode)
    } catch let error as AccountDeletionError {
      throw error
    } catch {
      throw AccountDeletionError.transport
    }
  }
}

extension AccountService {
  /// Deletes the signed-in account on the server, then signs this phone out.
  func deleteAccount() async throws {
    guard isSignedIn,
          let baseURL = AccountConfig.directoryBaseURL,
          let session = await pairingSession() else { throw AccountDeletionError.notSignedIn }
    try await AccountDeletionClient(baseURL: baseURL).delete(token: session.token) { [weak self] in
      guard let self, self.isPairingCommitAuthorized(session.authorization) else { return nil }
      return try? await self.freshRelaySession(expectedAuthorization: session.authorization).token
    }
    accountDeleteLog.notice("account deleted; signing out")
    ProductAnalytics.shared.flush()
    await signOut()
  }
}

// MARK: - Sheet

struct AccountDeleteSheet: View {
  @ObservedObject private var account = AccountService.shared
  @Environment(\.dismiss) private var dismiss
  @State private var typed = ""
  @State private var deleting = false
  @State private var error: AccountDeletionError?
  @FocusState private var fieldFocused: Bool

  private var confirmed: Bool {
    typed.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "delete"
  }

  private static let goes = [
    "Your ADE Cloud computers and the work saved on them",
    "Your saved chats",
    "Your passwords vault",
    "Your project list",
  ]

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          Text("This deletes your ADE account for good. It can’t be undone.")
            .font(.body)
            .foregroundStyle(ADEColor.textPrimary)
            .fixedSize(horizontal: false, vertical: true)

          VStack(alignment: .leading, spacing: 10) {
            Text("What goes")
              .font(.footnote.weight(.semibold))
              .foregroundStyle(ADEColor.textMuted)
            ForEach(Self.goes, id: \.self) { line in
              Label {
                Text(line).foregroundStyle(ADEColor.textPrimary)
              } icon: {
                Image(systemName: "xmark.circle.fill").foregroundStyle(ADEColor.danger)
              }
              .font(.subheadline)
            }
            Label {
              Text("Projects on your computers stay. ADE doesn’t delete any files there.")
                .foregroundStyle(ADEColor.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            } icon: {
              Image(systemName: "checkmark.circle.fill").foregroundStyle(ADEColor.success)
            }
            .font(.subheadline)
          }
          .adeKitCard()

          VStack(alignment: .leading, spacing: 8) {
            Text("Type delete to confirm")
              .font(.footnote.weight(.semibold))
              .foregroundStyle(ADEColor.textMuted)
            TextField("delete", text: $typed)
              .textInputAutocapitalization(.never)
              .autocorrectionDisabled()
              .submitLabel(.done)
              .focused($fieldFocused)
              .font(.body)
              .padding(.horizontal, 12)
              .padding(.vertical, 10)
              .background(ADEKit.track, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
              .disabled(deleting)
              .accessibilityIdentifier("account-delete-confirm-field")
          }

          if let error {
            VStack(alignment: .leading, spacing: 10) {
              ADESettingsNotice(message: error.localizedDescription, tone: .crit)
              HStack(spacing: 12) {
                Button("Retry") { Task { await run() } }
                  .buttonStyle(ADEKitButtonStyle(prominent: true))
                if error == .unauthorized || error == .notSignedIn {
                  Button("Sign out") {
                    Task {
                      await account.signOut()
                      dismiss()
                    }
                  }
                  .buttonStyle(ADEKitButtonStyle())
                }
              }
            }
          }

          Button {
            Task { await run() }
          } label: {
            HStack(spacing: 8) {
              if deleting { ProgressView().controlSize(.small).tint(.white) }
              Text(deleting ? "Deleting your account…" : "Delete account")
            }
          }
          .buttonStyle(ADEKitButtonStyle(prominent: true, wide: true, brand: ADEColor.danger))
          .disabled(!confirmed || deleting)
          .accessibilityIdentifier("account-delete-confirm-button")
        }
        .padding(20)
      }
      .scrollDismissesKeyboard(.interactively)
      .background(ADEColor.pageBackground.ignoresSafeArea())
      .navigationTitle("Delete account")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
            .disabled(deleting)
        }
      }
    }
    .interactiveDismissDisabled(deleting)
  }

  private func run() async {
    guard confirmed, !deleting else { return }
    fieldFocused = false
    deleting = true
    error = nil
    do {
      try await account.deleteAccount()
      deleting = false
      dismiss()
    } catch let failure as AccountDeletionError {
      deleting = false
      error = failure
    } catch {
      deleting = false
      self.error = .transport
    }
  }
}
