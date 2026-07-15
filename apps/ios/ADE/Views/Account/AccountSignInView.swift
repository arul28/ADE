import ClerkKit
import SwiftUI

/// Native sign-in flow matching `ADEDesignSystem`. Covers email one-time-code,
/// Sign in with Apple, Google, and GitHub. On success it presents the first-run
/// "here are your machines" step so a fresh login lands directly on connect.
///
/// Structurally close to ClerkKit's `AuthView` (identifier-first, then a
/// dedicated code step) but rendered entirely with ADE's glass primitives.
struct AccountSignInView: View {
  /// Invoked when the user taps Connect on a machine in the first-run step. The
  /// presenter dismisses and routes into the existing pairing/connect flow.
  var onConnect: (AccountMachine) -> Void = { _ in }

  @ObservedObject private var account = AccountService.shared
  @Environment(\.dismiss) private var dismiss
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private enum Step: Equatable {
    case identifier
    case emailCode
    case machines
  }

  @State private var step: Step = .identifier
  @State private var email = ""
  @State private var code = ""
  @State private var busy: BusyKind?
  @State private var errorText: String?
  @FocusState private var focusedField: Field?

  private enum Field { case email, code }
  private enum BusyKind: Equatable { case email, apple, google, github, verify }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: 22) {
          header
          switch step {
          case .identifier: identifierStep
          case .emailCode: emailCodeStep
          case .machines: machinesStep
          }
        }
        .padding(.horizontal, 22)
        .padding(.top, 8)
        .padding(.bottom, 32)
        .frame(maxWidth: .infinity)
      }
      .background(AccountAuroraBackground().ignoresSafeArea())
      .adeNavigationGlass()
      .navigationTitle("")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button {
            dismiss()
          } label: {
            Image(systemName: "xmark")
              .font(.system(size: 13, weight: .semibold))
          }
          .accessibilityLabel(step == .machines ? "Done" : "Close sign in")
        }
      }
      .onChange(of: account.phase) { _, newValue in
        // A completed sign-in (from any provider) advances to the first-run
        // machines step.
        if newValue == .signedIn, step != .machines {
          step = .machines
          Task { await account.loadMachines() }
        }
      }
    }
  }

  // MARK: - Header

  private var header: some View {
    VStack(spacing: 14) {
      ZStack {
        Circle()
          .fill(ADEColor.accent.opacity(0.18))
          .frame(width: 74, height: 74)
          .glassEffect()
        Image("BrandMark")
          .resizable()
          .aspectRatio(contentMode: .fit)
          .frame(width: 40, height: 40)
      }
      .shadow(color: ADEColor.accent.opacity(0.25), radius: 12, y: 4)

      VStack(spacing: 5) {
        Text(headerTitle)
          .font(.system(size: 24, weight: .heavy, design: .rounded))
          .foregroundStyle(ADEColor.textPrimary)
          .multilineTextAlignment(.center)
        Text(headerSubtitle)
          .font(.subheadline)
          .foregroundStyle(ADEColor.textSecondary)
          .multilineTextAlignment(.center)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .padding(.top, 12)
  }

  private var headerTitle: String {
    switch step {
    case .identifier: return "Sign in to ADE"
    case .emailCode: return "Check your email"
    case .machines: return "You're in"
    }
  }

  private var headerSubtitle: String {
    switch step {
    case .identifier:
      return "Reach your machines from anywhere and keep them in one account."
    case .emailCode:
      return "Enter the 6-digit code we sent to \(email)."
    case .machines:
      if let name = account.identity?.displayName {
        return "Signed in as \(name). Here are your machines."
      }
      return "Here are your machines."
    }
  }

  // MARK: - Identifier step (email + social)

  private var identifierStep: some View {
    VStack(spacing: 16) {
      VStack(spacing: 10) {
        HStack(spacing: 10) {
          Image(systemName: "envelope.fill")
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(ADEColor.textSecondary)
          TextField("you@example.com", text: $email)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .keyboardType(.emailAddress)
            .textContentType(.emailAddress)
            .submitLabel(.continue)
            .focused($focusedField, equals: .email)
            .onSubmit { Task { await continueWithEmail() } }
        }
        .adeInsetField()

        primaryButton(
          title: "Continue with email",
          isBusy: busy == .email,
          disabled: !emailLooksValid
        ) {
          await continueWithEmail()
        }
      }

      dividerLabel

      VStack(spacing: 10) {
        AccountProviderButton(
          label: "Continue with Apple",
          system: "apple.logo",
          foreground: ADEColor.textPrimary,
          isBusy: busy == .apple
        ) {
          await signIn(.apple) { try await account.signInWithApple() }
        }

        AccountProviderButton(
          label: "Continue with Google",
          glyph: .google,
          foreground: ADEColor.textPrimary,
          isBusy: busy == .google
        ) {
          await signIn(.google) { try await account.signInWithOAuth(.google) }
        }

        AccountProviderButton(
          label: "Continue with GitHub",
          asset: "ProviderGitHub",
          foreground: ADEColor.textPrimary,
          isBusy: busy == .github
        ) {
          await signIn(.github) { try await account.signInWithOAuth(.github) }
        }
      }

      errorView
    }
    .disabled(busy != nil)
  }

  // MARK: - Email code step

  private var emailCodeStep: some View {
    VStack(spacing: 16) {
      HStack(spacing: 10) {
        Image(systemName: "number")
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(ADEColor.textSecondary)
        TextField("123456", text: $code)
          .keyboardType(.numberPad)
          .textContentType(.oneTimeCode)
          .font(.system(.title3, design: .monospaced).weight(.semibold))
          .focused($focusedField, equals: .code)
      }
      .adeInsetField()

      primaryButton(
        title: "Verify & sign in",
        isBusy: busy == .verify,
        disabled: code.trimmingCharacters(in: .whitespaces).count < 4
      ) {
        await verifyCode()
      }

      Button("Use a different email") {
        withAnimation(ADEMotion.standard(reduceMotion: reduceMotion)) {
          step = .identifier
          code = ""
          errorText = nil
        }
      }
      .font(.caption.weight(.medium))
      .foregroundStyle(ADEColor.textSecondary)

      errorView
    }
    .disabled(busy != nil)
    .onAppear { focusedField = .code }
  }

  // MARK: - Machines (first-run) step

  private var machinesStep: some View {
    VStack(spacing: 14) {
      if let identity = account.identity {
        AccountIdentityCard(identity: identity)
      }

      AccountMachinesList(
        onConnect: { machine in
          dismiss()
          onConnect(machine)
        }
      )

      Button {
        dismiss()
      } label: {
        Text("Done")
          .font(.subheadline.weight(.semibold))
          .frame(maxWidth: .infinity)
          .padding(.vertical, 12)
      }
      .buttonStyle(.glassProminent)
      .tint(ADEColor.accent)
      .padding(.top, 4)
    }
    .task { await account.loadMachines() }
  }

  // MARK: - Shared pieces

  private var dividerLabel: some View {
    HStack(spacing: 12) {
      line
      Text("or")
        .font(.caption.weight(.medium))
        .foregroundStyle(ADEColor.textMuted)
      line
    }
  }

  private var line: some View {
    Rectangle()
      .fill(ADEColor.border.opacity(0.4))
      .frame(height: 1)
      .frame(maxWidth: .infinity)
  }

  @ViewBuilder
  private var errorView: some View {
    if let errorText {
      Text(errorText)
        .font(.caption)
        .foregroundStyle(ADEColor.danger)
        .frame(maxWidth: .infinity, alignment: .leading)
        .transition(.opacity)
    }
  }

  private func primaryButton(
    title: String,
    isBusy: Bool,
    disabled: Bool,
    action: @escaping () async -> Void
  ) -> some View {
    Button {
      Task { await action() }
    } label: {
      HStack(spacing: 8) {
        if isBusy {
          ProgressView().controlSize(.small).tint(.white)
        }
        Text(title)
          .font(.subheadline.weight(.semibold))
      }
      .frame(maxWidth: .infinity)
      .padding(.vertical, 12)
    }
    .buttonStyle(.glassProminent)
    .tint(ADEColor.accent)
    .disabled(disabled || busy != nil)
    .opacity(disabled ? 0.55 : 1)
  }

  private var emailLooksValid: Bool {
    let trimmed = email.trimmingCharacters(in: .whitespaces)
    return trimmed.contains("@") && trimmed.contains(".")
  }

  // MARK: - Actions

  private func continueWithEmail() async {
    guard emailLooksValid, busy == nil else { return }
    busy = .email
    errorText = nil
    do {
      try await account.sendEmailCode(to: email)
      withAnimation(ADEMotion.standard(reduceMotion: reduceMotion)) {
        step = .emailCode
      }
    } catch {
      showError(error)
    }
    busy = nil
  }

  private func verifyCode() async {
    guard busy == nil else { return }
    busy = .verify
    errorText = nil
    do {
      try await account.verifyEmailCode(code)
      // Phase change to .signedIn advances to the machines step via onChange.
    } catch {
      showError(error)
    }
    busy = nil
  }

  private func signIn(_ kind: BusyKind, _ operation: @escaping () async throws -> Void) async {
    guard busy == nil else { return }
    busy = kind
    errorText = nil
    do {
      try await operation()
      ADEHaptics.success()
    } catch {
      showError(error)
    }
    busy = nil
  }

  private func showError(_ error: Error) {
    let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    withAnimation(ADEMotion.standard(reduceMotion: reduceMotion)) {
      errorText = message.isEmpty ? "Something went wrong. Try again." : message
    }
    ADEHaptics.error()
  }
}

/// A provider sign-in button (Apple / Google / GitHub) styled as a glass row
/// with a leading brand glyph, matching the design system.
struct AccountProviderButton: View {
  enum Glyph { case none, google }

  let label: String
  var system: String?
  var asset: String?
  var glyph: Glyph = .none
  let foreground: Color
  let isBusy: Bool
  let action: () async -> Void

  init(
    label: String,
    system: String? = nil,
    asset: String? = nil,
    glyph: Glyph = .none,
    foreground: Color,
    isBusy: Bool,
    action: @escaping () async -> Void
  ) {
    self.label = label
    self.system = system
    self.asset = asset
    self.glyph = glyph
    self.foreground = foreground
    self.isBusy = isBusy
    self.action = action
  }

  var body: some View {
    Button {
      Task { await action() }
    } label: {
      HStack(spacing: 10) {
        icon
          .frame(width: 22, height: 22)
        Text(label)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(foreground)
        Spacer(minLength: 0)
        if isBusy {
          ProgressView().controlSize(.small)
        }
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 13)
      .frame(maxWidth: .infinity)
      .background(ADEColor.surfaceBackground.opacity(0.5), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
      .glassEffect(in: .rect(cornerRadius: 14))
      .overlay(
        RoundedRectangle(cornerRadius: 14, style: .continuous)
          .stroke(ADEColor.glassBorder, lineWidth: 0.75)
      )
    }
    .buttonStyle(ADEScaleButtonStyle())
    .accessibilityLabel(label)
  }

  @ViewBuilder
  private var icon: some View {
    if let system {
      Image(systemName: system)
        .font(.system(size: 18, weight: .medium))
        .foregroundStyle(foreground)
    } else if let asset {
      Image(asset)
        .resizable()
        .aspectRatio(contentMode: .fit)
    } else if glyph == .google {
      GoogleGlyph()
    }
  }
}

/// A compact multi-color "G" mark for the Google button (no bundled asset).
private struct GoogleGlyph: View {
  var body: some View {
    Text("G")
      .font(.system(size: 15, weight: .bold, design: .rounded))
      .foregroundStyle(
        LinearGradient(
          colors: [
            Color(red: 0x42 / 255, green: 0x85 / 255, blue: 0xF4 / 255),
            Color(red: 0x34 / 255, green: 0xA8 / 255, blue: 0x53 / 255),
            Color(red: 0xFB / 255, green: 0xBC / 255, blue: 0x05 / 255),
            Color(red: 0xEA / 255, green: 0x43 / 255, blue: 0x35 / 255),
          ],
          startPoint: .topLeading,
          endPoint: .bottomTrailing
        )
      )
      .frame(width: 22, height: 22)
      .background(Color.white, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
  }
}

/// Warm, quiet aurora backdrop shared by the sign-in sheet, echoing the
/// settings screen's aurora so the two surfaces feel of a piece.
struct AccountAuroraBackground: View {
  var body: some View {
    ZStack {
      ADEColor.pageBackground
      RadialGradient(
        colors: [ADEColor.accent.opacity(0.28), .clear],
        center: UnitPoint(x: 0.5, y: -0.02),
        startRadius: 20,
        endRadius: 380
      )
      RadialGradient(
        colors: [ADEColor.purpleAccent.opacity(0.18), .clear],
        center: UnitPoint(x: 0.9, y: 0.12),
        startRadius: 8,
        endRadius: 260
      )
    }
  }
}
