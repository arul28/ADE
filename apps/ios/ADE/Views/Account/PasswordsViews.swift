import LocalAuthentication
import SwiftUI
import UIKit
import UniformTypeIdentifiers

// Settings › Account › Passwords: the account's saved logins and secrets,
// to view and copy. Read only on the phone; they are added and changed in
// ADE on a computer.

// MARK: - Account page entry

/// The Account page's Passwords row. The page shows it only while signed in.
struct SettingsPasswordsSection: View {
  var body: some View {
    ADESettingsSection(
      "Passwords",
      hint: "Your saved logins and API secrets. View and copy them here; add or change them in ADE on a computer.",
      symbol: "key",
      tint: .amber
    ) {
      ADESettingsRows {
        ADESettingsLink(title: "Passwords", symbol: "key.fill", tint: .amber) {
          PasswordsListPage()
        }
      }
    }
  }
}

// MARK: - List

struct PasswordsListPage: View {
  @ObservedObject private var vault = PasswordsVault.shared
  @ObservedObject private var account = AccountService.shared
  @State private var query = ""

  var body: some View {
    ADESettingsPage(title: "Passwords") {
      content
    }
    .searchable(text: $query, prompt: "Search passwords")
    .refreshable { await vault.refresh() }
    .task(id: account.identity?.userId) {
      if account.phase == .signedIn { await vault.refresh() }
    }
  }

  @ViewBuilder
  private var content: some View {
    switch vault.phase {
    case .inactive:
      ADESettingsRows { ADESettingsLoadingRow(title: "Opening your passwords…") }
    case .loading where vault.items.isEmpty:
      ADESettingsRows { ADESettingsLoadingRow(title: "Opening your passwords…") }
    case .notSetUp:
      PasswordsEmptyState(
        title: "Passwords isn't set up",
        message: "Turn on Passwords in ADE on a computer (Settings › Passwords). Logins and secrets you save there show here."
      )
    case .failed(let message) where vault.items.isEmpty:
      PasswordsEmptyState(title: "Couldn't open your passwords", message: message, retry: { Task { await vault.refresh() } })
    default:
      lists
    }
  }

  @ViewBuilder
  private var lists: some View {
    let logins = vault.logins.filter { matches(login: $0.login) }
    let secrets = vault.secrets.filter { matches(secret: $0.secret) }
    if case .failed(let message) = vault.phase {
      ADESettingsNotice(message: message, tone: .warn)
    }
    if logins.isEmpty && secrets.isEmpty {
      PasswordsEmptyState(title: "No results", message: "Nothing saved matches “\(query)”.")
    }
    if !logins.isEmpty {
      ADESettingsSection("Logins") {
        ADESettingsRows {
          ForEach(logins, id: \.id) { entry in
            NavigationLink {
              PasswordDetailPage(itemId: entry.id)
            } label: {
              ADESettingsRow(
                title: PasswordsDisplay.title(entry.login),
                hint: PasswordsDisplay.loginHint(entry.login),
                symbol: "globe",
                tint: .blue
              ) {
                HStack(spacing: 6) {
                  if entry.login.totpUri.flatMap(PasswordTotp.parse) != nil {
                    Image(systemName: "clock.badge.checkmark")
                      .font(.system(size: 12, weight: .semibold))
                      .foregroundStyle(ADEColor.textMuted)
                      .accessibilityLabel("Has authenticator codes")
                  }
                  ADESettingsChevron()
                }
              }
            }
            .buttonStyle(ADEKitRowButtonStyle())
          }
        }
      }
    }
    if !secrets.isEmpty {
      ADESettingsSection("Secrets") {
        ADESettingsRows {
          ForEach(secrets, id: \.id) { entry in
            NavigationLink {
              PasswordDetailPage(itemId: entry.id)
            } label: {
              ADESettingsRow(
                title: entry.secret.name,
                hint: PasswordsDisplay.projectLabel(entry.secret.projectScope),
                symbol: "curlybraces",
                tint: .violet
              ) {
                ADESettingsChevron()
              }
            }
            .buttonStyle(ADEKitRowButtonStyle())
          }
        }
      }
    }
    if vault.unopenableCount > 0 {
      Text(vault.unopenableCount == 1
        ? "1 saved item couldn't be opened on this \(UIDevice.current.model)."
        : "\(vault.unopenableCount) saved items couldn't be opened on this \(UIDevice.current.model).")
        .font(.system(size: 12.5))
        .foregroundStyle(ADEColor.textMuted)
    }
    Text("Read only on this \(UIDevice.current.model). Add or change passwords in ADE on a computer.")
      .font(.system(size: 12.5))
      .foregroundStyle(ADEColor.textMuted)
      .fixedSize(horizontal: false, vertical: true)
  }

  private func matches(login: PasswordItemSecret.PasswordLogin) -> Bool {
    let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !needle.isEmpty else { return true }
    return ([login.title, login.username] + login.origins.map(PasswordsDisplay.site))
      .contains { $0.localizedCaseInsensitiveContains(needle) }
  }

  private func matches(secret: PasswordItemSecret.PasswordSecret) -> Bool {
    let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !needle.isEmpty else { return true }
    return [secret.name, secret.projectScope ?? ""].contains { $0.localizedCaseInsensitiveContains(needle) }
  }
}

private struct PasswordsEmptyState: View {
  let title: String
  let message: String
  var retry: (() -> Void)?

  var body: some View {
    VStack(spacing: 10) {
      Image(systemName: "key")
        .font(.system(size: 24, weight: .medium))
        .foregroundStyle(ADEColor.textMuted)
        .frame(width: 56, height: 56)
        .background(ADEKit.track, in: Circle())
        .accessibilityHidden(true)
      Text(title)
        .font(.system(size: 17, weight: .semibold))
        .foregroundStyle(ADEColor.textPrimary)
      Text(message)
        .font(.system(size: 14))
        .foregroundStyle(ADEColor.textSecondary)
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
      if let retry {
        Button("Try again", action: retry)
          .buttonStyle(ADEKitButtonStyle())
          .padding(.top, 2)
      }
    }
    .padding(.horizontal, 22)
    .padding(.vertical, 24)
    .frame(maxWidth: .infinity)
    .adeKitCard(padding: nil)
  }
}

enum PasswordsDisplay {
  /// `https://github.com` reads as `github.com`.
  static func site(_ origin: String) -> String {
    URL(string: origin)?.host ?? origin
  }

  static func title(_ login: PasswordItemSecret.PasswordLogin) -> String {
    if !login.title.isEmpty { return login.title }
    return login.origins.first.map(site) ?? "Login"
  }

  static func loginHint(_ login: PasswordItemSecret.PasswordLogin) -> String {
    let sites = login.origins.map(site)
    let shownSites = sites.prefix(2).joined(separator: ", ") + (sites.count > 2 ? " +\(sites.count - 2)" : "")
    return [login.username, shownSites].filter { !$0.isEmpty }.joined(separator: " · ")
  }

  static func projectLabel(_ scope: String?) -> String {
    guard let scope, !scope.isEmpty else { return "All projects" }
    return scope
  }
}

// MARK: - Detail

struct PasswordDetailPage: View {
  let itemId: String
  @ObservedObject private var vault = PasswordsVault.shared
  @Environment(\.scenePhase) private var scenePhase
  /// Face ID / passcode passed once for this appearance of the page.
  @State private var unlocked = false
  @State private var revealed = false
  @State private var copied: String?
  @State private var unlockProblem: String?

  private var item: PasswordsVaultItem? { vault.items.first { $0.id == itemId } }

  var body: some View {
    Group {
      if let item {
        switch item.secret {
        case .login(let login):
          ADESettingsPage(title: PasswordsDisplay.title(login)) { loginContent(login) }
        case .secret(let secret):
          ADESettingsPage(title: secret.name) { secretContent(secret) }
        }
      } else {
        ADESettingsPage(title: "Passwords") {
          PasswordsEmptyState(title: "Not available", message: "This item is no longer on this \(UIDevice.current.model).")
        }
      }
    }
    .onAppear { lock() }
    .onDisappear { lock() }
    // The app switcher's snapshot never shows a revealed value. Not on
    // `.inactive`: the Face ID sheet itself makes the scene inactive.
    .onChange(of: scenePhase) { _, phase in
      if phase == .background { lock() }
    }
  }

  private func lock() {
    unlocked = false
    revealed = false
    unlockProblem = nil
  }

  // MARK: Login

  @ViewBuilder
  private func loginContent(_ login: PasswordItemSecret.PasswordLogin) -> some View {
    ADESettingsSection("Sign-in", symbol: "person.badge.key", tint: .blue) {
      ADESettingsRows {
        ADESettingsRow(title: "Username", hint: login.username.isEmpty ? "None saved" : nil, sizesControlFirst: false) {
          if !login.username.isEmpty {
            HStack(spacing: 10) {
              Text(login.username)
                .font(.system(size: 14))
                .foregroundStyle(ADEColor.textSecondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .textSelection(.enabled)
              copyButton(field: "username", label: "Copy username", needsUnlock: false) { login.username }
            }
          }
        }
        secretValueRow(title: "Password", field: "password", value: login.password)
        if let params = login.totpUri.flatMap(PasswordTotp.parse) {
          authenticatorRow(params)
        }
      }
    }
    if let unlockProblem {
      ADESettingsNotice(message: unlockProblem, tone: .warn)
    }
    if !login.origins.isEmpty {
      ADESettingsSection("Sites", symbol: "globe", tint: .slate) {
        ADESettingsRows {
          ForEach(login.origins, id: \.self) { origin in
            ADESettingsRow(PasswordsDisplay.site(origin), hint: origin == "https://\(PasswordsDisplay.site(origin))" ? nil : origin)
          }
        }
      }
    }
    notesSection(login.notes)
    readOnlyFooter
  }

  // MARK: Secret

  @ViewBuilder
  private func secretContent(_ secret: PasswordItemSecret.PasswordSecret) -> some View {
    ADESettingsSection("Secret", symbol: "curlybraces", tint: .violet) {
      ADESettingsRows {
        ADESettingsRow(title: "Name", sizesControlFirst: false) {
          HStack(spacing: 10) {
            Text(secret.name)
              .font(.adeMono(12.5))
              .foregroundStyle(ADEColor.textSecondary)
              .lineLimit(1)
              .truncationMode(.middle)
            copyButton(field: "name", label: "Copy name", needsUnlock: false) { secret.name }
          }
        }
        secretValueRow(title: "Value", field: "value", value: secret.value)
        ADESettingsValueRow(title: "Project", value: PasswordsDisplay.projectLabel(secret.projectScope))
      }
    }
    if let unlockProblem {
      ADESettingsNotice(message: unlockProblem, tone: .warn)
    }
    notesSection(secret.notes)
    readOnlyFooter
  }

  // MARK: Pieces

  /// A hidden value shows dots beside its title; revealed, it gets its own
  /// line under the row, so a long value never squeezes the title.
  private func secretValueRow(title: String, field: String, value: String) -> some View {
    let shown = revealed && unlocked
    return VStack(alignment: .leading, spacing: 0) {
      ADESettingsRow(title: title, hint: value.isEmpty ? "None saved" : nil, sizesControlFirst: false) {
        if !value.isEmpty {
          HStack(spacing: 10) {
            if !shown {
              Text(String(repeating: "•", count: 10))
                .font(.adeMono(13))
                .foregroundStyle(ADEColor.textSecondary)
                .lineLimit(1)
                .accessibilityLabel("\(title) hidden")
            }
            Button {
              if revealed {
                revealed = false
              } else {
                Task { if await unlock() { revealed = true } }
              }
            } label: {
              Image(systemName: shown ? "eye.slash" : "eye")
                .font(.system(size: 13, weight: .semibold))
                .frame(width: 28, height: 28)
                .contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(shown ? "Hide \(title.lowercased())" : "Reveal \(title.lowercased())")
            copyButton(field: field, label: "Copy \(title.lowercased())", needsUnlock: true) { value }
          }
        }
      }
      if shown {
        Text(value)
          .font(.adeMono(14))
          .foregroundStyle(ADEColor.textPrimary)
          .textSelection(.enabled)
          .fixedSize(horizontal: false, vertical: true)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal, ADEKit.inset)
          .padding(.bottom, 12)
      }
    }
  }

  @ViewBuilder
  private func authenticatorRow(_ params: PasswordTotpParams) -> some View {
    ADESettingsRow(title: "Authenticator code", sizesControlFirst: false) {
      HStack(spacing: 10) {
        if unlocked {
          // Ticks only while a code is on screen.
          TimelineView(.periodic(from: .now, by: 1)) { context in
            let current = PasswordTotp.code(params, at: context.date)
            HStack(spacing: 8) {
              Text(PasswordsDisplay.groupedCode(current.code))
                .font(.adeMono(16, weight: .semibold))
                .foregroundStyle(ADEColor.textPrimary)
                .monospacedDigit()
              Text("\(current.secondsLeft)s")
                .font(.system(size: 12, weight: .medium).monospacedDigit())
                .foregroundStyle(current.secondsLeft <= 5 ? ADEColor.warning : ADEColor.textMuted)
                .frame(minWidth: 26, alignment: .trailing)
                .accessibilityLabel("\(current.secondsLeft) seconds left")
            }
          }
        } else {
          Button {
            Task { _ = await unlock() }
          } label: {
            Text("Show")
          }
          .buttonStyle(ADEKitButtonStyle())
        }
        copyButton(field: "code", label: "Copy code", needsUnlock: true) {
          PasswordTotp.code(params).code
        }
      }
    }
  }

  @ViewBuilder
  private func notesSection(_ notes: String) -> some View {
    let trimmed = notes.trimmingCharacters(in: .whitespacesAndNewlines)
    if !trimmed.isEmpty {
      ADESettingsSection("Notes", symbol: "note.text", tint: .slate) {
        ADESettingsRows {
          if unlocked {
            Text(trimmed)
              .font(.system(size: 14))
              .foregroundStyle(ADEColor.textSecondary)
              .textSelection(.enabled)
              .frame(maxWidth: .infinity, alignment: .leading)
              .padding(.horizontal, ADEKit.inset)
              .padding(.vertical, 12)
          } else {
            ADESettingsRow(title: "Hidden", hint: "Reveal the password or code to show notes.") {
              Button("Show") { Task { _ = await unlock() } }
                .buttonStyle(ADEKitButtonStyle())
            }
          }
        }
      }
    }
  }

  private var readOnlyFooter: some View {
    Text("Read only on this \(UIDevice.current.model). Change it in ADE on a computer.")
      .font(.system(size: 12.5))
      .foregroundStyle(ADEColor.textMuted)
  }

  private func copyButton(field: String, label: String, needsUnlock: Bool, value: @escaping () -> String) -> some View {
    Button {
      Task {
        if needsUnlock, !(await unlock()) { return }
        PasswordsPasteboard.copy(value())
        copied = field
        try? await Task.sleep(nanoseconds: 1_500_000_000)
        if copied == field { copied = nil }
      }
    } label: {
      Image(systemName: copied == field ? "checkmark" : "doc.on.doc")
        .font(.system(size: 13, weight: .semibold))
        .frame(width: 28, height: 28)
        .contentShape(Rectangle())
    }
    .buttonStyle(.borderless)
    .accessibilityLabel(copied == field ? "Copied. Clears in 90 seconds." : label)
  }

  /// Face ID, Touch ID or the passcode, once per appearance of the page.
  private func unlock() async -> Bool {
    if unlocked { return true }
    switch await PasswordsUnlock.authenticate(reason: "Show and copy your saved passwords.") {
    case .passed:
      unlocked = true
      unlockProblem = nil
      return true
    case .cancelled:
      return false
    case .unavailable:
      unlockProblem = "Set a passcode on this \(UIDevice.current.model) to reveal and copy passwords."
      return false
    }
  }
}

extension PasswordsDisplay {
  /// `123456` reads as `123 456`.
  static func groupedCode(_ code: String) -> String {
    guard code.count == 6 || code.count == 8 else { return code }
    let half = code.index(code.startIndex, offsetBy: code.count / 2)
    return "\(code[..<half]) \(code[half...])"
  }
}

// MARK: - Device owner check and pasteboard

@MainActor
enum PasswordsUnlock {
  enum Outcome { case passed, cancelled, unavailable }

  static func authenticate(reason: String) async -> Outcome {
#if DEBUG
    if PasswordsVault.shared.isPreviewSeeded { return .passed }
#endif
    let context = LAContext()
    var error: NSError?
    guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else { return .unavailable }
    do {
      return try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) ? .passed : .cancelled
    } catch {
      return .cancelled
    }
  }
}

enum PasswordsPasteboard {
  /// This device only (never Handoff's universal clipboard), gone after 90 s.
  static func copy(_ value: String) {
    UIPasteboard.general.setItems(
      [[UTType.utf8PlainText.identifier: value]],
      options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(90)]
    )
  }
}

// MARK: - Fixture screens

#if DEBUG
/// `-adePreviewScreen passwords | password-detail`: the list and a login's
/// detail over made-up items. No relay, no Keychain; Reveal needs no Face ID.
struct PasswordsPreviewHost: View {
  let detail: Bool
  @State private var seeded = false

  var body: some View {
    NavigationStack {
      if seeded {
        if detail {
          PasswordDetailPage(itemId: "preview-github")
        } else {
          PasswordsListPage()
        }
      } else {
        ADEColor.pageBackground.ignoresSafeArea()
      }
    }
    .task {
      PasswordsVault.shared.seedPreview(PasswordsPreviewData.items)
      seeded = true
    }
  }
}

enum PasswordsPreviewData {
  static let items: [PasswordsVaultItem] = [
    PasswordsVaultItem(id: "preview-github", secret: .login(.init(
      title: "GitHub",
      origins: ["https://github.com"],
      username: "sam-rivera",
      password: "fixture-Pa55word-not-real",
      notes: "Recovery codes are in the safe.",
      totpUri: "otpauth://totp/GitHub:sam-rivera?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=GitHub"
    ))),
    PasswordsVaultItem(id: "preview-vercel", secret: .login(.init(
      title: "Vercel",
      origins: ["https://vercel.com", "https://vercel.app"],
      username: "sam.rivera@example.com",
      password: "fixture-vercel-not-real",
      notes: "",
      totpUri: nil
    ))),
    PasswordsVaultItem(id: "preview-staging", secret: .login(.init(
      title: "",
      origins: ["http://localhost:3000"],
      username: "admin",
      password: "fixture-local-not-real",
      notes: "",
      totpUri: nil
    ))),
    PasswordsVaultItem(id: "preview-openai", secret: .secret(.init(
      name: "OPENAI_API_KEY",
      value: "sk-fixture-not-a-real-key",
      projectScope: nil,
      notes: ""
    ))),
    PasswordsVaultItem(id: "preview-stripe", secret: .secret(.init(
      name: "STRIPE_SECRET_KEY",
      value: "sk_test_fixture_not_real",
      projectScope: "github.com/sam-rivera/storefront",
      notes: "Test mode only."
    ))),
  ]
}
#endif
