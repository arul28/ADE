import SwiftUI

struct SettingsPairingSection: View {
  let snapshot: SettingsPairingSnapshot
  @Binding var presentedSheet: SettingsPairSheetRoute?

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      SettingsSectionHeader(
        label: "PAIR A MACHINE",
        hint: pairingHint
      )

      GlassEffectContainer(spacing: 8) {
        VStack(spacing: 8) {
          SettingsPairActionRow(
            icon: "dot.radiowaves.left.and.right",
            title: "Discover on network",
            subtitle: discoverSubtitle
          ) {
            presentedSheet = .discover
          }

          SettingsPairActionRow(
            icon: "keyboard",
            title: "Enter machine details",
            subtitle: "Machine address and port"
          ) {
            presentedSheet = .manual
          }
        }
      }
    }
  }

  private var discoverSubtitle: String? {
    let count = snapshot.discoveredHostCount
    let savedCount = snapshot.savedReconnectHostCount
    if count == 0, savedCount > 0 {
      return savedCount == 1 ? "1 saved machine" : "\(savedCount) saved machines"
    }
    if count == 0 {
      return "Looking nearby"
    }
    return count == 1 ? "1 nearby machine found" : "\(count) nearby machines found"
  }

  private var pairingHint: String? {
    guard snapshot.savedReconnectHostCount > 0 else {
      return "Pick how to reach your machine"
    }
    return "Add another machine or switch saved machines"
  }
}

struct SettingsSectionHeader: View {
  let label: String
  let hint: String?

  init(label: String, hint: String? = nil) {
    self.label = label
    self.hint = hint
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      HStack(spacing: 6) {
        Circle()
          .fill(ADEColor.purpleAccent.opacity(0.55))
          .frame(width: 4, height: 4)
        Text(label)
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.purpleAccent.opacity(0.85))
          .tracking(0.7)
      }
      if let hint {
        Text(hint)
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
          .padding(.leading, 10)
      }
    }
    .padding(.horizontal, 4)
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

struct SettingsPairActionRow: View {
  let icon: String
  let title: String
  let subtitle: String?
  let shimmerSubtitle: Bool
  let action: () -> Void

  init(
    icon: String,
    title: String,
    subtitle: String?,
    shimmerSubtitle: Bool = false,
    action: @escaping () -> Void
  ) {
    self.icon = icon
    self.title = title
    self.subtitle = subtitle
    self.shimmerSubtitle = shimmerSubtitle
    self.action = action
  }

  var body: some View {
    Button(action: action) {
      HStack(spacing: 14) {
        Image(systemName: icon)
          .font(.system(size: 18, weight: .semibold))
          .foregroundStyle(ADEColor.purpleAccent)
          .frame(width: 38, height: 38)
          .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
              .fill(
                LinearGradient(
                  colors: [
                    ADEColor.purpleAccent.opacity(0.30),
                    ADEColor.purpleAccent.opacity(0.10),
                  ],
                  startPoint: .top,
                  endPoint: .bottom
                )
              )
          )
          .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
              .strokeBorder(ADEColor.purpleAccent.opacity(0.35), lineWidth: 0.6)
          )
          .shadow(color: ADEColor.purpleGlow.opacity(0.25), radius: 6, y: 2)

        VStack(alignment: .leading, spacing: 2) {
          Text(title)
            .font(.body.weight(.medium))
            .foregroundStyle(ADEColor.textPrimary)
          if let subtitle {
            subtitleView(subtitle)
          }
        }

        Spacer(minLength: 8)

        Image(systemName: "chevron.right")
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(ADEColor.purpleAccent.opacity(0.55))
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 14)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(
        RoundedRectangle(cornerRadius: 16, style: .continuous)
          .fill(
            LinearGradient(
              colors: [
                ADEColor.purpleAccent.opacity(0.06),
                Color.clear,
              ],
              startPoint: .topLeading,
              endPoint: .bottomTrailing
            )
          )
      )
      .glassEffect(in: .rect(cornerRadius: 16))
      .overlay(
        RoundedRectangle(cornerRadius: 16, style: .continuous)
          .strokeBorder(
            LinearGradient(
              colors: [
                ADEColor.purpleAccent.opacity(0.32),
                ADEColor.border.opacity(0.10),
              ],
              startPoint: .topLeading,
              endPoint: .bottomTrailing
            ),
            lineWidth: 0.75
          )
      )
    }
    .buttonStyle(ADEScaleButtonStyle())
    .accessibilityLabel(subtitle.map { "\(title), \($0)" } ?? title)
  }

  @ViewBuilder
  private func subtitleView(_ text: String) -> some View {
    if shimmerSubtitle {
      HStack(spacing: 6) {
        Text(text)
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
        ADESkeletonView(width: 10, height: 10, cornerRadius: 5)
      }
    } else {
      Text(text)
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)
    }
  }
}

// MARK: - Discover hosts sheet

func syncDiscoveredHostsForDisplay(
  savedHosts: [DiscoveredSyncHost],
  liveHosts: [DiscoveredSyncHost]
) -> (savedHosts: [DiscoveredSyncHost], liveHosts: [DiscoveredSyncHost]) {
  let coalescedLiveHosts = syncCoalescedLiveDiscoveredHosts(liveHosts)
  let saved = savedHosts.map { savedHost in
    guard let liveHost = coalescedLiveHosts.first(where: { syncDiscoveredHostsReferToSameRuntime(savedHost, $0) }) else {
      return savedHost
    }
    return syncMergeSavedDiscoveredHost(savedHost, withLiveHost: liveHost)
  }
  let live = coalescedLiveHosts.filter { liveHost in
    !savedHosts.contains { savedHost in
      syncDiscoveredHostsReferToSameRuntime(savedHost, liveHost)
    }
  }
  return (savedHosts: saved, liveHosts: live)
}

func syncCoalescedLiveDiscoveredHosts(_ hosts: [DiscoveredSyncHost]) -> [DiscoveredSyncHost] {
  var byKey: [String: DiscoveredSyncHost] = [:]
  var orderedKeys: [String] = []

  for host in hosts {
    let key = syncExistingDiscoveredHostDisplayKey(for: host, in: orderedKeys, byKey: byKey)
      ?? syncDiscoveredHostDisplayKey(host)
    if let existing = byKey[key] {
      byKey[key] = syncMergeLiveDiscoveredHost(existing, with: host)
    } else {
      byKey[key] = host
      orderedKeys.append(key)
    }
  }

  return orderedKeys.compactMap { byKey[$0] }
}

/// Friendly, transport-free detail line for a machine row. Shows human facts —
/// the advertised brain/app label plus an availability/status word — and never
/// an IP, port, "LAN", or "Tailscale". `statusLabel` is the friendly word shown
/// last (e.g. "Available now" for a live row, "Saved" for a saved row); pass
/// `nil` to omit it.
func syncDiscoveredHostDetailText(host: DiscoveredSyncHost, detailPrefix statusLabel: String?) -> String {
  var parts: [String] = []
  // Lead with the machine's human label when one is advertised. When unnamed,
  // fall back to the brain/app kind. No project/IP/transport text here; the
  // pairing target is the computer, not a single project socket.
  if let name = syncTrimmedNonEmpty(host.runtimeName) {
    parts.append(name)
  } else if let runtimeText = syncRuntimeText(kind: host.runtimeKind, version: host.runtimeVersion) {
    parts.append(runtimeText)
  }
  if let status = syncTrimmedNonEmpty(statusLabel) {
    parts.append(status)
  }
  // Always leave the user with at least one human fact, even for a bare row.
  if parts.isEmpty {
    parts.append("ADE machine")
  }
  return parts.joined(separator: " · ")
}

private func syncDiscoveredHostsReferToSameRuntime(
  _ left: DiscoveredSyncHost,
  _ right: DiscoveredSyncHost
) -> Bool {
  if let leftIdentity = syncTrimmedNonEmpty(left.hostIdentity),
     let rightIdentity = syncTrimmedNonEmpty(right.hostIdentity) {
    return leftIdentity.caseInsensitiveCompare(rightIdentity) == .orderedSame
  }
  if left.id == right.id {
    return true
  }
  return syncMachineMergeKey(left) == syncMachineMergeKey(right)
}

/// A single normalized key identifying one ADE machine regardless of which
/// transport or project port currently reached it. Used to coalesce saved +
/// live rows into one row per computer.
private func syncMachineMergeKey(_ host: DiscoveredSyncHost) -> String {
  if let identity = syncTrimmedNonEmpty(host.hostIdentity) {
    return "machine:\(identity.lowercased())"
  }
  if let route = syncDiscoveredHostDisplayPrimaryRouteKey(host) {
    return "route:\(route)"
  }
  if let name = syncTrimmedNonEmpty(host.hostName)?.lowercased() {
    return "name:\(name)"
  }
  return "id:\(host.id)"
}

private func syncExistingDiscoveredHostDisplayKey(
  for host: DiscoveredSyncHost,
  in orderedKeys: [String],
  byKey: [String: DiscoveredSyncHost]
) -> String? {
  // Identified machines are keyed exactly by deviceId — never fuzzy-merge them
  // into a different identified computer that happens to share a route.
  if syncTrimmedNonEmpty(host.hostIdentity) != nil { return nil }
  guard let hostRoute = syncDiscoveredHostDisplayPrimaryRouteKey(host) else { return nil }
  return orderedKeys.first { key in
    guard let existing = byKey[key] else { return false }
    if syncTrimmedNonEmpty(existing.hostIdentity) != nil { return false }
    return syncDiscoveredHostDisplayPrimaryRouteKey(existing) == hostRoute
  }
}

private func syncDiscoveredHostDisplayKey(_ host: DiscoveredSyncHost) -> String {
  if let identity = syncTrimmedNonEmpty(host.hostIdentity) {
    return "machine:\(identity.lowercased())"
  }
  if let route = syncDiscoveredHostDisplayPrimaryRouteKey(host) {
    return "route:\(route)"
  }
  if let name = syncTrimmedNonEmpty(host.hostName)?.lowercased() {
    return "name:\(name)"
  }
  return "id:\(host.id)"
}

private func syncDiscoveredHostDisplayPrimaryRouteKey(_ host: DiscoveredSyncHost) -> String? {
  let lanRoute = host.addresses
    .map(syncNormalizedRouteHost)
    .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
    .first(where: { !$0.isEmpty && !syncIsLoopbackAddress($0) && !syncIsTailscaleRoute($0) && !$0.hasSuffix(".local") })
  if let lanRoute {
    return lanRoute
  }

  let bonjourRoute = host.addresses
    .map(syncNormalizedRouteHost)
    .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
    .first(where: { !$0.isEmpty && !syncIsLoopbackAddress($0) && !syncIsTailscaleRoute($0) })
  if let bonjourRoute {
    return bonjourRoute
  }

  return (host.tailscaleAddress.map { [$0] } ?? host.addresses)
    .map(syncNormalizedRouteHost)
    .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
    .first(where: { !$0.isEmpty && !syncIsLoopbackAddress($0) })
}

private func syncMergeLiveDiscoveredHost(
  _ left: DiscoveredSyncHost,
  with right: DiscoveredSyncHost
) -> DiscoveredSyncHost {
  let preferred = syncPreferDiscoveredHostForDisplay(right, over: left) ? right : left
  let fallback = preferred.id == right.id ? left : right
  return DiscoveredSyncHost(
    id: preferred.id,
    serviceName: syncTrimmedNonEmpty(preferred.serviceName) ?? fallback.serviceName,
    hostName: syncTrimmedNonEmpty(preferred.hostName) ?? fallback.hostName,
    hostIdentity: syncTrimmedNonEmpty(preferred.hostIdentity) ?? syncTrimmedNonEmpty(fallback.hostIdentity),
    siteId: syncTrimmedNonEmpty(preferred.siteId) ?? syncTrimmedNonEmpty(fallback.siteId),
    port: preferred.port > 0 ? preferred.port : fallback.port,
    addresses: syncUniqueNonEmptyStrings(preferred.addresses + fallback.addresses),
    tailscaleAddress: syncTrimmedNonEmpty(preferred.tailscaleAddress) ?? syncTrimmedNonEmpty(fallback.tailscaleAddress),
    runtimeName: syncTrimmedNonEmpty(preferred.runtimeName) ?? syncTrimmedNonEmpty(fallback.runtimeName),
    runtimeKind: syncTrimmedNonEmpty(preferred.runtimeKind) ?? syncTrimmedNonEmpty(fallback.runtimeKind),
    runtimeVersion: syncTrimmedNonEmpty(preferred.runtimeVersion) ?? syncTrimmedNonEmpty(fallback.runtimeVersion),
    projectIds: syncUniqueNonEmptyStrings(preferred.projectIds + fallback.projectIds),
    projectNames: syncUniqueNonEmptyStrings(preferred.projectNames + fallback.projectNames),
    projectCount: max(preferred.projectCount ?? 0, fallback.projectCount ?? 0) > 0
      ? max(preferred.projectCount ?? 0, fallback.projectCount ?? 0)
      : nil,
    pairingPinConfigured: preferred.pairingPinConfigured ?? fallback.pairingPinConfigured,
    lastResolvedAt: max(preferred.lastResolvedAt, fallback.lastResolvedAt)
  )
}

private func syncPreferDiscoveredHostForDisplay(
  _ candidate: DiscoveredSyncHost,
  over existing: DiscoveredSyncHost
) -> Bool {
  let candidateName = syncTrimmedNonEmpty(candidate.hostName) ?? ""
  let existingName = syncTrimmedNonEmpty(existing.hostName) ?? ""
  let candidateLooksLikeDeviceName = !candidateName.localizedCaseInsensitiveContains(".local")
  let existingLooksLikeDeviceName = !existingName.localizedCaseInsensitiveContains(".local")
  if candidateLooksLikeDeviceName != existingLooksLikeDeviceName {
    return candidateLooksLikeDeviceName
  }
  return candidate.lastResolvedAt >= existing.lastResolvedAt
}

private func syncMergeSavedDiscoveredHost(
  _ savedHost: DiscoveredSyncHost,
  withLiveHost liveHost: DiscoveredSyncHost
) -> DiscoveredSyncHost {
  DiscoveredSyncHost(
    id: savedHost.id,
    serviceName: syncTrimmedNonEmpty(savedHost.serviceName) ?? liveHost.serviceName,
    hostName: syncTrimmedNonEmpty(savedHost.hostName) ?? liveHost.hostName,
    hostIdentity: syncTrimmedNonEmpty(savedHost.hostIdentity) ?? syncTrimmedNonEmpty(liveHost.hostIdentity),
    siteId: syncTrimmedNonEmpty(savedHost.siteId) ?? syncTrimmedNonEmpty(liveHost.siteId),
    port: savedHost.port > 0 ? savedHost.port : liveHost.port,
    addresses: syncUniqueNonEmptyStrings(savedHost.addresses + liveHost.addresses),
    tailscaleAddress: syncTrimmedNonEmpty(savedHost.tailscaleAddress) ?? syncTrimmedNonEmpty(liveHost.tailscaleAddress),
    runtimeName: syncTrimmedNonEmpty(savedHost.runtimeName) ?? syncTrimmedNonEmpty(liveHost.runtimeName),
    runtimeKind: syncTrimmedNonEmpty(savedHost.runtimeKind) ?? syncTrimmedNonEmpty(liveHost.runtimeKind),
    runtimeVersion: syncTrimmedNonEmpty(savedHost.runtimeVersion) ?? syncTrimmedNonEmpty(liveHost.runtimeVersion),
    projectIds: syncUniqueNonEmptyStrings(savedHost.projectIds + liveHost.projectIds),
    projectNames: syncUniqueNonEmptyStrings(savedHost.projectNames + liveHost.projectNames),
    projectCount: savedHost.projectCount ?? liveHost.projectCount,
    pairingPinConfigured: savedHost.pairingPinConfigured ?? liveHost.pairingPinConfigured,
    lastResolvedAt: max(savedHost.lastResolvedAt, liveHost.lastResolvedAt)
  )
}

private func syncRuntimeText(kind: String?, version: String?) -> String? {
  guard let kind = syncTrimmedNonEmpty(kind) else { return nil }
  let label: String
  switch kind.lowercased() {
  case "daemon", "headless":
    label = "ADE brain"
  case "desktop", "desktop-embedded":
    label = "ADE app"
  default:
    label = "ADE brain"
  }
  guard let version = syncTrimmedNonEmpty(version) else { return label }
  return "\(label) \(version)"
}

private func syncTrimmedNonEmpty(_ value: String?) -> String? {
  guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
    return nil
  }
  return value
}

private func syncUniqueNonEmptyStrings(_ values: [String]) -> [String] {
  var seen = Set<String>()
  return values
    .compactMap(syncTrimmedNonEmpty)
    .filter { seen.insert($0).inserted }
}

private func syncIsLoopbackAddress(_ address: String) -> Bool {
  address == "127.0.0.1" || address == "::1"
}

struct DiscoverHostsSheet: View {
  @EnvironmentObject private var syncService: SyncService
  @Environment(\.dismiss) private var dismiss

  let onPick: (DiscoveredSyncHost) -> Void

  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(spacing: 10) {
          let displayedHosts = syncDiscoveredHostsForDisplay(
            savedHosts: syncService.savedReconnectHosts,
            liveHosts: syncService.discoveredHosts
          )
          let savedHosts = displayedHosts.savedHosts
          let liveHosts = displayedHosts.liveHosts

          if savedHosts.isEmpty && liveHosts.isEmpty {
            VStack(spacing: 14) {
              ADESkeletonView(height: 56, cornerRadius: 14)
              ADESkeletonView(height: 56, cornerRadius: 14)
              Text("Looking for ADE machines on your network...")
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
                .padding(.top, 4)
            }
            .padding(.top, 24)
          } else {
            ForEach(savedHosts) { savedHost in
              Button {
                dismiss()
                Task {
                  await syncService.reconnect(
                    toSavedHost: savedHost,
                    preferTailnet: savedHost.tailscaleAddress != nil
                  )
                }
              } label: {
                DiscoveredHostRow(
                  host: savedHost,
                  detailPrefix: savedHost.tailscaleAddress == nil ? "Saved" : "Saved Tailscale",
                  accessoryText: "Reconnect"
                )
              }
              .buttonStyle(ADEScaleButtonStyle())
            }

            ForEach(liveHosts) { host in
              Button {
                onPick(host)
              } label: {
                DiscoveredHostRow(host: host)
              }
              .buttonStyle(ADEScaleButtonStyle())
            }
          }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
      }
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("Nearby machines")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
      }
    }
  }
}

private struct DiscoveredHostRow: View {
  let host: DiscoveredSyncHost
  var detailPrefix: String?
  var accessoryText: String?

  var body: some View {
    HStack(spacing: 14) {
      Image(systemName: "desktopcomputer")
        .font(.system(size: 18, weight: .semibold))
        .foregroundStyle(ADEColor.purpleAccent)
        .frame(width: 36, height: 36)
        .background(
          RoundedRectangle(cornerRadius: 12, style: .continuous)
            .fill(ADEColor.purpleAccent.opacity(0.14))
        )

      VStack(alignment: .leading, spacing: 2) {
        Text(host.hostName)
          .font(.body.weight(.medium))
          .foregroundStyle(ADEColor.textPrimary)
        Text(detailText)
          .font(.caption.monospaced())
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
          .truncationMode(.middle)
      }

      Spacer(minLength: 8)

      if let accessoryText {
        Text(accessoryText)
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.purpleAccent)
      } else {
        Image(systemName: "chevron.right")
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(ADEColor.textMuted)
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .fill(ADEColor.surfaceBackground.opacity(0.08))
    )
    .glassEffect(in: .rect(cornerRadius: 14))
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .stroke(ADEColor.border.opacity(0.18), lineWidth: 0.75)
    )
  }

  private var detailText: String {
    syncDiscoveredHostDetailText(host: host, detailPrefix: detailPrefix)
  }
}

// MARK: - Manual entry sheet

struct ManualEntrySheet: View {
  @Environment(\.dismiss) private var dismiss

  @State private var host: String = ""
  @State private var port: String = String(SyncDirectHostPorts.defaultPort)

  let onConnect: (String, Int) -> Void

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          Text("Reach your machine directly")
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
          Text("Use a machine address from ADE Sync settings or Tailscale.")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)

          TextField("Machine address or IP", text: $host)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .keyboardType(.asciiCapable)
            .textFieldStyle(.plain)
            .manualEntryField()

          TextField("Port", text: $port)
            .keyboardType(.numberPad)
            .textFieldStyle(.plain)
            .manualEntryField()

          Button {
            let endpoint = syncParseRouteEndpoint(host)
            let parsedPort = Int(port.trimmingCharacters(in: .whitespacesAndNewlines)) ?? SyncDirectHostPorts.defaultPort
            guard let endpoint else { return }
            onConnect(endpoint.host, endpoint.port ?? parsedPort)
          } label: {
            Text("Continue")
              .font(.subheadline.weight(.semibold))
              .frame(maxWidth: .infinity)
              .padding(.vertical, 10)
          }
          .buttonStyle(.glassProminent)
          .tint(ADEColor.purpleAccent)
          .disabled(host.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          .padding(.top, 4)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 20)
      }
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("Enter machine details")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
      }
    }
  }
}

private struct ManualEntryFieldModifier: ViewModifier {
  func body(content: Content) -> some View {
    content
      .padding(12)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(ADEColor.recessedBackground.opacity(0.78), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .stroke(ADEColor.glassBorder, lineWidth: 0.5)
      )
  }
}

private extension View {
  func manualEntryField() -> some View {
    modifier(ManualEntryFieldModifier())
  }
}
