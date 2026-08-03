import SwiftUI

struct SettingsPairingSection: View {
  let snapshot: SettingsPairingSnapshot
  @Binding var presentedSheet: SettingsPairSheetRoute?
  @State private var showsAddMachine: Bool
  @ObservedObject private var accountService = AccountService.shared

  init(
    snapshot: SettingsPairingSnapshot,
    presentedSheet: Binding<SettingsPairSheetRoute?>,
    initiallyExpanded: Bool = false
  ) {
    self.snapshot = snapshot
    self._presentedSheet = presentedSheet
    self._showsAddMachine = State(initialValue: initiallyExpanded)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      DisclosureGroup(isExpanded: $showsAddMachine) {
        VStack(spacing: 8) {
          SettingsPairActionRow(
            icon: "qrcode.viewfinder",
            title: "Scan a pairing code",
            subtitle: "Scan the code shown in ADE on your computer"
          ) {
            presentedSheet = .scan
          }

          SettingsPairActionRow(
            icon: "dot.radiowaves.left.and.right",
            title: "Find a nearby computer",
            subtitle: discoverSubtitle
          ) {
            presentedSheet = .discover
          }

          SettingsPairActionRow(
            icon: "terminal",
            title: "Set up with SSH",
            subtitle: "Advanced · macOS or Linux only"
          ) {
            presentedSheet = .ssh
          }
        }
        .padding(.top, 8)
      } label: {
        Label("Add new machine", systemImage: "plus.circle")
          .font(.subheadline)
          .foregroundStyle(ADEColor.textSecondary)
          .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
      }
      .tint(ADEColor.textSecondary)

      Label(
        awayFromComputerHelp,
        systemImage: "network"
      )
      .font(.footnote)
      .foregroundStyle(ADEColor.textSecondary)
      .fixedSize(horizontal: false, vertical: true)
    }
  }

  private var awayFromComputerHelp: String {
    if accountService.identity != nil {
      return "You're signed in, so your computers stay reachable from any network."
    }
    return "Sign in to reach your computers from any network."
  }

  private var discoverSubtitle: String? {
    let count = snapshot.discoveredHostCount
    let savedCount = snapshot.savedReconnectHostCount
    if count == 0, savedCount > 0 {
      return savedCount == 1 ? "1 saved computer" : "\(savedCount) saved computers"
    }
    if count == 0 {
      return "Choose your computer, then enter its ADE PIN"
    }
    return count == 1 ? "1 nearby computer found · enter its ADE PIN" : "\(count) nearby computers found"
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
          .font(.body)
          .foregroundStyle(ADEColor.purpleAccent)
          .frame(width: 28)

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
      .padding(.vertical, 12)
      .frame(minHeight: 60)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(
        RoundedRectangle(cornerRadius: 12)
          .fill(ADEColor.surfaceBackground.opacity(0.55))
      )
      .overlay(RoundedRectangle(cornerRadius: 12).stroke(ADEColor.border.opacity(0.45), lineWidth: 0.75))
    }
    .buttonStyle(.plain)
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

/// Whether two discovered hosts refer to the same machine, matching first on a
/// stable host identity, then on any shared address. Display names are not
/// identities because multiple Macs can advertise the same default name. Shared
/// by the settings MACHINES list and the hub quick-connect home to decide when a
/// saved/paired host is currently reachable on the local network.
func sameSyncHost(_ lhs: DiscoveredSyncHost, _ rhs: DiscoveredSyncHost) -> Bool {
  if let lid = lhs.hostIdentity?.trimmingCharacters(in: .whitespacesAndNewlines), !lid.isEmpty,
     let rid = rhs.hostIdentity?.trimmingCharacters(in: .whitespacesAndNewlines), !rid.isEmpty {
    return lid.caseInsensitiveCompare(rid) == .orderedSame
  }
  if !Set(lhs.addresses).isDisjoint(with: Set(rhs.addresses)) { return true }
  return false
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
              Text("Looking for computers running ADE nearby…")
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
                  await syncService.reconnect(toSavedHost: savedHost)
                }
              } label: {
                DiscoveredHostRow(
                  host: savedHost,
                  detailPrefix: "Saved",
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
      .navigationTitle("Nearby computers")
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
