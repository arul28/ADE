import SwiftUI

/// Linear connection management screen, pushed from the pane's gear button.
/// When connected, shows the workspace (logo + name + viewer + auth/expiry
/// status) with Reconnect and Disconnect. When disconnected, offers the same
/// inline connect actions as the pane's empty state so the gear is never a
/// dead end.
struct LinearConnectionScreen: View {
  @ObservedObject var store: LinearPaneStore
  @EnvironmentObject private var syncService: SyncService
  @Environment(\.dismiss) private var dismiss

  @StateObject private var runner = LinearOAuthRunner()
  @State private var showDisconnectConfirm = false
  @State private var disconnecting = false
  @State private var actionError: String?
  @State private var confirmation: String?

  private var status: LinearConnectionStatus? {
    syncService.linearConnectionStatus ?? store.quickView?.connection
  }

  private var isConnected: Bool { status?.connected == true }

  private var orgName: String {
    store.quickView?.organization?.name
      ?? status?.organizationName
      ?? "Linear"
  }

  private var orgLogoUrl: String? {
    store.quickView?.organization?.logoUrl ?? status?.organizationLogoUrl
  }

  private var viewerName: String? {
    store.viewerLabel ?? status?.viewerName
  }

  private var supportsReconnect: Bool {
    syncService.supportsRemoteAction("cto.startLinearMobileOAuth")
  }

  private var supportsDisconnect: Bool {
    syncService.supportsViewerRemoteAction("cto.clearLinearToken")
  }

  var body: some View {
    ScrollView {
      VStack(spacing: 20) {
        if isConnected {
          connectedCard
        } else {
          disconnectedCard
        }

        if let confirmation {
          Label(confirmation, systemImage: "checkmark.circle.fill")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.success)
            .frame(maxWidth: .infinity, alignment: .leading)
            .transition(.opacity)
        }

        if let actionError {
          Text(actionError)
            .font(.footnote)
            .foregroundStyle(ADEColor.danger)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
      }
      .padding(20)
    }
    .scrollContentBackground(.hidden)
    .background(ADEColor.pageBackground)
    .navigationTitle("Linear")
    .navigationBarTitleDisplayMode(.inline)
    .confirmationDialog(
      "Disconnect Linear?",
      isPresented: $showDisconnectConfirm,
      titleVisibility: .visible
    ) {
      Button("Disconnect Linear", role: .destructive) {
        Task { await disconnect() }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("This clears Linear for the whole machine (\(machineName)). Every ADE surface on it will need to reconnect.")
    }
  }

  // MARK: Connected

  private var connectedCard: some View {
    VStack(alignment: .leading, spacing: 18) {
      HStack(spacing: 14) {
        LinearOrgAvatar(logoUrl: orgLogoUrl, name: orgName, size: 46)
        VStack(alignment: .leading, spacing: 3) {
          Text(orgName)
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
          if let viewerName {
            Text(viewerName)
              .font(.subheadline)
              .foregroundStyle(ADEColor.textSecondary)
          }
        }
        Spacer(minLength: 0)
      }

      HStack(spacing: 7) {
        Circle()
          .fill(ADEColor.success)
          .frame(width: 8, height: 8)
        Text(statusLine)
          .font(.footnote.weight(.medium))
          .foregroundStyle(ADEColor.textSecondary)
      }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("Linear \(statusLine), workspace \(orgName)")

      VStack(spacing: 10) {
        if supportsReconnect {
          Button {
            Task { await reconnect() }
          } label: {
            HStack(spacing: 8) {
              if runner.isRunning {
                ProgressView().controlSize(.small).tint(.white)
              } else {
                Image(systemName: "arrow.triangle.2.circlepath")
              }
              Text(runner.isRunning ? "Reconnecting\u{2026}" : "Reconnect")
                .fontWeight(.semibold)
            }
            .frame(maxWidth: .infinity)
          }
          .buttonStyle(.glassProminent)
          .tint(LinearBrand.primary)
          .disabled(runner.isRunning || disconnecting)
        }

        if supportsDisconnect {
          Button(role: .destructive) {
            showDisconnectConfirm = true
          } label: {
            HStack(spacing: 8) {
              if disconnecting {
                ProgressView().controlSize(.small)
              } else {
                Image(systemName: "link.badge.minus")
              }
              Text("Disconnect")
                .fontWeight(.semibold)
            }
            .frame(maxWidth: .infinity)
          }
          .buttonStyle(.glass)
          .tint(ADEColor.danger)
          .disabled(runner.isRunning || disconnecting)
        }

        if !supportsReconnect && !supportsDisconnect {
          Text("Update ADE on your computer to manage Linear connections from your phone.")
            .font(.footnote)
            .foregroundStyle(ADEColor.textSecondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
    }
    .adeGlassCard(cornerRadius: 20, padding: 20)
  }

  // MARK: Disconnected

  private var disconnectedCard: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack(spacing: 12) {
        LinearMark(size: 26)
          .foregroundStyle(LinearBrand.primaryBright)
        VStack(alignment: .leading, spacing: 3) {
          Text("Connect Linear")
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
          Text("Sign in to browse and launch Linear issues from \(machineName).")
            .font(.subheadline)
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        Spacer(minLength: 0)
      }

      LinearConnectActions(store: store) { status in
        ADEHaptics.success()
        withAnimation { confirmation = "Connected to \(status.organizationName ?? orgName)" }
      }
    }
    .adeGlassCard(cornerRadius: 20, padding: 20)
  }

  // MARK: Derived copy

  private var machineName: String { syncService.machineDisplayName }

  private var statusLine: String {
    guard let status, status.connected else { return "Not connected" }
    switch status.authMode {
    case "oauth":
      if let expiry = linearTokenExpiryText(status.tokenExpiresAt) {
        return "Connected \u{00B7} OAuth \u{00B7} \(expiry)"
      }
      return "Connected \u{00B7} OAuth"
    case "manual":
      return "Connected \u{00B7} API key"
    default:
      return "Connected"
    }
  }

  // MARK: Actions

  private func reconnect() async {
    actionError = nil
    let outcome = await runner.connect(using: syncService)
    switch outcome {
    case let .connected(status):
      ADEHaptics.success()
      withAnimation { confirmation = "Connected to \(status.organizationName ?? orgName)" }
      await store.start()
    case .canceled:
      break
    case let .failed(message):
      ADEHaptics.warning()
      actionError = message
    }
  }

  private func disconnect() async {
    actionError = nil
    disconnecting = true
    defer { disconnecting = false }
    do {
      _ = try await syncService.clearLinearToken()
      ADEHaptics.success()
      await store.start()
      dismiss()
    } catch {
      ADEHaptics.warning()
      actionError = SyncUserFacingError.message(for: error)
    }
  }
}

// MARK: - Connect actions (shared by the connection screen + disconnected pane)

/// The two connect affordances: "Sign in with Linear" (worker-bounce OAuth) and
/// an expandable "Use an API key" path. Owns its own OAuth runner and reloads
/// the pane store on success before calling `onConnected`.
struct LinearConnectActions: View {
  @ObservedObject var store: LinearPaneStore
  var onConnected: (LinearConnectionStatus) -> Void = { _ in }

  @EnvironmentObject private var syncService: SyncService
  @StateObject private var runner = LinearOAuthRunner()
  @State private var showApiKey = false
  @State private var apiKey = ""
  @State private var submitting = false
  @State private var errorMessage: String?
  @FocusState private var apiKeyFocused: Bool

  private var busy: Bool { runner.isRunning || submitting }

  private var supportsOAuth: Bool {
    syncService.supportsRemoteAction("cto.startLinearMobileOAuth")
  }

  private var supportsApiKey: Bool {
    syncService.supportsViewerRemoteAction("cto.setLinearToken")
  }

  var body: some View {
    VStack(spacing: 12) {
      if supportsOAuth {
        Button {
          Task { await runOAuth() }
        } label: {
          HStack(spacing: 8) {
            if runner.isRunning {
              ProgressView().controlSize(.small).tint(.white)
            } else {
              LinearMark(size: 16).foregroundStyle(.white)
            }
            Text(runner.isRunning ? "Signing in\u{2026}" : "Sign in with Linear")
              .fontWeight(.semibold)
          }
          .frame(maxWidth: .infinity)
        }
        .buttonStyle(.glassProminent)
        .tint(LinearBrand.primary)
        .disabled(busy)
      }

      if supportsApiKey {
        Button {
          withAnimation { showApiKey.toggle() }
          if showApiKey {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { apiKeyFocused = true }
          }
        } label: {
          HStack(spacing: 6) {
            Image(systemName: "key.horizontal")
            Text("Use an API key")
            Spacer()
            Image(systemName: showApiKey ? "chevron.up" : "chevron.down")
              .font(.caption.weight(.semibold))
          }
          .foregroundStyle(ADEColor.textSecondary)
        }
        .buttonStyle(.glass)
        .disabled(busy)
      }

      if supportsApiKey && showApiKey {
        apiKeyForm
      }

      if !supportsOAuth && !supportsApiKey {
        Text("Update ADE on your computer to manage Linear connections from your phone.")
          .font(.footnote)
          .foregroundStyle(ADEColor.textSecondary)
          .frame(maxWidth: .infinity, alignment: .leading)
          .fixedSize(horizontal: false, vertical: true)
      }

      if let errorMessage {
        Text(errorMessage)
          .font(.footnote)
          .foregroundStyle(ADEColor.danger)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
  }

  private var apiKeyForm: some View {
    VStack(alignment: .leading, spacing: 10) {
      SecureField("Linear API key", text: $apiKey)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled(true)
        .focused($apiKeyFocused)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(ADEColor.surfaceBackground, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(ADEColor.glassBorder, lineWidth: 1))

      HStack {
        if let url = URL(string: "https://linear.app/settings/api") {
          Link(destination: url) {
            HStack(spacing: 4) {
              Text("Create a key")
              Image(systemName: "arrow.up.right")
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(LinearBrand.primaryBright)
          }
        }
        Spacer()
        Button {
          Task { await submitApiKey() }
        } label: {
          HStack(spacing: 6) {
            if submitting { ProgressView().controlSize(.small).tint(.white) }
            Text("Connect").fontWeight(.semibold)
          }
        }
        .buttonStyle(.glassProminent)
        .tint(LinearBrand.primary)
        .controlSize(.small)
        .disabled(apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || busy)
      }
    }
    .transition(.opacity.combined(with: .move(edge: .top)))
  }

  private func runOAuth() async {
    errorMessage = nil
    let outcome = await runner.connect(using: syncService)
    switch outcome {
    case let .connected(status):
      await store.start()
      onConnected(status)
    case .canceled:
      break
    case let .failed(message):
      ADEHaptics.warning()
      errorMessage = message
      // Graceful fallback: surface Linear's message and expose the API-key path.
      if supportsApiKey {
        withAnimation { showApiKey = true }
      }
    }
  }

  private func submitApiKey() async {
    let trimmed = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    errorMessage = nil
    submitting = true
    defer { submitting = false }
    apiKeyFocused = false
    do {
      let status = try await syncService.setLinearToken(trimmed)
      if status.connected {
        apiKey = ""
        await store.start()
        onConnected(status)
      } else {
        ADEHaptics.warning()
        errorMessage = status.message ?? "That API key didn\u{2019}t work. Check it and try again."
      }
    } catch {
      ADEHaptics.warning()
      errorMessage = SyncUserFacingError.message(for: error)
    }
  }
}

// MARK: - Org avatar

/// Workspace logo as a small rounded avatar, with a letter-monogram fallback
/// (first letter of the org name) when no logo URL is present or it fails to
/// load. Used everywhere connection status is shown.
struct LinearOrgAvatar: View {
  let logoUrl: String?
  let name: String
  var size: CGFloat = 40

  private var cornerRadius: CGFloat { size * 0.28 }

  var body: some View {
    Group {
      if let logoUrl, let url = URL(string: logoUrl) {
        AsyncImage(url: url) { phase in
          switch phase {
          case let .success(image):
            image.resizable().scaledToFill()
          case .failure:
            monogram
          case .empty:
            ZStack { LinearBrand.surface; ProgressView().controlSize(.small) }
          @unknown default:
            monogram
          }
        }
      } else {
        monogram
      }
    }
    .frame(width: size, height: size)
    .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        .stroke(LinearBrand.border, lineWidth: 1)
    )
    .accessibilityHidden(true)
  }

  private var monogram: some View {
    ZStack {
      LinearBrand.surface
      Text(monogramLetter)
        .font(.system(size: size * 0.42, weight: .bold))
        .foregroundStyle(LinearBrand.primaryBright)
    }
  }

  private var monogramLetter: String {
    let first = name.trimmingCharacters(in: .whitespaces).first
    return String(first ?? "L").uppercased()
  }
}

// MARK: - Expiry helpers

/// "expires in N days" / "expires today" / "expired" for an OAuth token expiry
/// ISO timestamp; nil when there's no parseable expiry.
func linearTokenExpiryText(_ iso: String?) -> String? {
  guard let date = linearParseISODate(iso) else { return nil }
  let seconds = date.timeIntervalSinceNow
  if seconds <= 0 { return "expired" }
  let days = Int(seconds / 86_400)
  switch days {
  case 0: return "expires today"
  case 1: return "expires in 1 day"
  default: return "expires in \(days) days"
  }
}

func linearParseISODate(_ iso: String?) -> Date? {
  guard let iso, !iso.isEmpty else { return nil }
  let withFraction = ISO8601DateFormatter()
  withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  if let date = withFraction.date(from: iso) { return date }
  let plain = ISO8601DateFormatter()
  plain.formatOptions = [.withInternetDateTime]
  return plain.date(from: iso)
}
