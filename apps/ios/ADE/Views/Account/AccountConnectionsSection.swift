import SwiftUI

/// ACCOUNT subsection for the connection settings screen. Signed out, it shows a
/// quiet account prompt; signed in, it shows the identity card plus "Your
/// machines" from the directory Worker. It sits above the local MACHINE pairing
/// rows so the two ways to reach a machine — your account, or direct pairing —
/// read as one connections surface. Hidden entirely when no Clerk key is wired.
struct AccountConnectionsSection: View {
  /// Routes a chosen account machine into the existing pairing/connect flow.
  var onConnectMachine: (AccountMachine) -> Void

  @ObservedObject private var account = AccountService.shared
  @State private var signInPresented = false
  @State private var confirmSignOut = false

  var body: some View {
    Group {
      if account.isConfigured {
        VStack(alignment: .leading, spacing: 12) {
          SettingsSectionHeader(label: "ACCOUNT")

          switch account.phase {
          case .signedIn:
            if let identity = account.identity {
              AccountIdentityCard(identity: identity) {
                confirmSignOut = true
              }
            }
            // Machines now live in the dedicated CONNECTIONS section below, so
            // this card stays a pure "account identity" surface (M5).
          case .loading:
            ADESkeletonView(height: 64, cornerRadius: 16)
          default:
            AccountSignInPromptCard {
              signInPresented = true
            }
          }
        }
      }
    }
    .sheet(isPresented: $signInPresented) {
      AccountSignInView(onConnect: onConnectMachine)
    }
    .confirmationDialog(
      "Sign out of ADE?",
      isPresented: $confirmSignOut,
      titleVisibility: .visible
    ) {
      Button("Sign out", role: .destructive) {
        Task { await account.signOut() }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("Signing out removes this iPhone's access to your account and its account-connected machines. Devices paired directly with a code stay connected.")
    }
  }
}

// MARK: - Account prompt (signed out)

struct AccountSignInPromptCard: View {
  let onSignIn: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(alignment: .top, spacing: 12) {
        Image(systemName: "person.badge.key.fill")
          .font(.system(size: 16, weight: .semibold))
          .foregroundStyle(ADEColor.accent)
          .frame(width: 34, height: 34)
          .background(ADEColor.accent.opacity(0.16), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
          .glassEffect(in: .rect(cornerRadius: 11))

        VStack(alignment: .leading, spacing: 3) {
          Text("Continue to ADE")
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
          Text("Connect to a computer on another network. Use the same ADE account on your iPhone and computer.")
            .font(.subheadline)
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        Spacer(minLength: 0)
      }

      Button(action: onSignIn) {
        Text("Continue")
          .font(.subheadline.weight(.semibold))
          .frame(maxWidth: .infinity)
          .frame(minHeight: 44)
      }
      .buttonStyle(.glassProminent)
      .tint(ADEColor.accent)
    }
    .adeGlassCard()
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Continue to ADE to see your machines")
  }
}

// MARK: - Identity card (signed in)

struct AccountIdentityCard: View {
  let identity: AccountIdentity
  var onSignOut: (() -> Void)?

  var body: some View {
    VStack(spacing: 12) {
      HStack(spacing: 12) {
        AccountAvatar(identity: identity)

        VStack(alignment: .leading, spacing: 3) {
          Text(identity.displayName)
            .font(.system(.body, design: .rounded).weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
          if let email = identity.email {
            Text(email)
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
              .lineLimit(1)
              .truncationMode(.middle)
          }
        }

        Spacer(minLength: 6)

        ADEGlassStatusBadge(text: identity.providerLabel, tint: identity.accent)
      }

      if let onSignOut {
        Button(action: onSignOut) {
          HStack(spacing: 6) {
            Image(systemName: "rectangle.portrait.and.arrow.right")
              .font(.system(size: 12, weight: .semibold))
            Text("Sign out")
              .font(.caption.weight(.semibold))
          }
          .foregroundStyle(ADEColor.textSecondary)
          .frame(maxWidth: .infinity)
          .padding(.vertical, 9)
          .background(ADEColor.recessedBackground.opacity(0.6), in: Capsule())
          .glassEffect()
        }
        .buttonStyle(ADEScaleButtonStyle())
        .accessibilityLabel("Sign out")
      }
    }
    .adeGlassCard()
  }
}

private struct AccountAvatar: View {
  let identity: AccountIdentity

  private var initials: String {
    let parts = identity.displayName.split(separator: " ").prefix(2)
    let letters = parts.compactMap { $0.first }.map(String.init)
    return letters.joined().uppercased()
  }

  var body: some View {
    ZStack {
      Circle()
        .fill(identity.accent.opacity(0.18))
      if let url = identity.imageURL {
        AsyncImage(url: url) { phase in
          if let image = phase.image {
            image.resizable().aspectRatio(contentMode: .fill)
          } else {
            initialsView
          }
        }
      } else {
        initialsView
      }
    }
    .frame(width: 44, height: 44)
    .clipShape(Circle())
    .overlay(Circle().stroke(identity.accent.opacity(0.4), lineWidth: 1))
  }

  private var initialsView: some View {
    Text(initials.isEmpty ? "AD" : initials)
      .font(.system(size: 16, weight: .bold, design: .rounded))
      .foregroundStyle(identity.accent)
  }
}

// MARK: - Machines list

struct AccountMachinesList: View {
  var onConnect: (AccountMachine) -> Void

  @ObservedObject private var account = AccountService.shared

  var body: some View {
    VStack(spacing: 10) {
      content
    }
    .task { await account.loadMachines() }
  }

  @ViewBuilder
  private var content: some View {
    switch account.machinesState {
    case .idle, .loading:
      if account.machines.isEmpty {
        VStack(spacing: 10) {
          ADESkeletonView(height: 60, cornerRadius: 16)
          ADESkeletonView(height: 60, cornerRadius: 16)
        }
      } else {
        machineRows
      }
    case .loaded:
      if account.machines.isEmpty {
        AccountMachinesNote(
          icon: "desktopcomputer",
          text: "No computers are signed in to this account yet. Open ADE on your computer and sign in there too."
        )
      } else {
        machineRows
      }
    case .unconfigured:
      AccountMachinesNote(
        icon: "cloud",
        text: "Your machine directory isn't live yet — pair directly below to connect now."
      )
    case .unreachable(let message):
      AccountMachinesNote(
        icon: "wifi.exclamationmark",
        text: message,
        retry: { Task { await account.loadMachines() } }
      )
    }
  }

  private var machineRows: some View {
    ForEach(account.machines) { machine in
      AccountMachineRow(machine: machine, onConnect: onConnect)
    }
  }
}

private struct AccountMachinesNote: View {
  let icon: String
  let text: String
  var retry: (() -> Void)?

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: icon)
        .font(.system(size: 14, weight: .semibold))
        .foregroundStyle(ADEColor.textMuted)
      Text(text)
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 4)
      if let retry {
        Button("Retry", action: retry)
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.accent)
      }
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(ADEColor.surfaceBackground.opacity(0.4), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .stroke(ADEColor.glassBorder, lineWidth: 0.5)
    )
  }
}

struct AccountMachineRow: View {
  let machine: AccountMachine
  let onConnect: (AccountMachine) -> Void

  private var reachabilityText: String {
    machineReachabilityText(
      isConnected: false,
      directoryOnline: machine.online,
      lastSeenAt: machineLastSeenDate(epochMilliseconds: machine.lastSeenAt)
    )
  }

  var body: some View {
    Button {
      onConnect(machine)
    } label: {
      MachineRowView(
        deviceSymbol: machineDeviceSymbol(deviceType: machine.deviceType, platform: machine.platform),
        title: machine.displayName,
        // Keep the route kind (lan/tailnet/relay) out of the primary row —
        // presence is only a hint and route detail lives in Connection details.
        routeHint: reachabilityText,
        online: machine.online,
        statusPill: nil,
        affordance: .connect,
        surface: .row
      )
    }
    .buttonStyle(ADEScaleButtonStyle())
    .accessibilityLabel("\(machine.displayName), \(reachabilityText)")
    .accessibilityHint("Connect.")
  }
}
