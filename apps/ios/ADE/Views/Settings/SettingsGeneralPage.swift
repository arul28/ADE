import OSLog
import SwiftUI

private let settingsGeneralLog = Logger(subsystem: "com.ade.ios", category: "SettingsGeneral")

// Settings › General, where Settings opens. The desktop's General page
// (`GeneralPage.tsx`) on the phone, in the same order: what needs attention,
// then "You" and "Machines" (the desktop's "This machine": on the
// phone that name reads as the phone; side by side where the window is wide
// enough), then ADE itself with every machine's version. Each block is one
// panel of rows, as on every other Settings page: a lead row that says who or
// what, then one row per fact, each opening the page that owns it.

/// The page. `ConnectionSettingsView` owns the connection state and the pages
/// the rows open, and hands them in.
struct SettingsGeneralPage: View {
  let syncService: SyncService
  let machines: [SettingsMachine]
  let onSignIn: () -> Void
  let accountPage: () -> AnyView
  let usagePage: () -> AnyView
  let providersPage: () -> AnyView
  let machinesPage: () -> AnyView
  let advancedPage: () -> AnyView
  /// The connection's status and its one action (Disconnect, Reconnect, Wake),
  /// drawn as a row under the machine. Given whether the row above names the
  /// machine, so the status line names it only when that row cannot.
  let connection: (_ machineShownAbove: Bool) -> AnyView

  @ObservedObject private var account = AccountService.shared
  @EnvironmentObject private var appUpdateAdvisor: AppUpdateAdvisor
  @State private var aiStatus: SettingsAiStatus?
  @State private var aiLoading = false
  @State private var weekTotals: [Int]?

  private var connected: Bool { syncService.connectionState == .connected }
  private var primary: SettingsMachine? { machines.first(where: \.isPrimary) }

  var body: some View {
    ADESettingsPage(route: .general) {
      if !attentionItems.isEmpty {
        SettingsAttentionStrip(items: attentionItems)
      }
      ViewThatFits(in: .horizontal) {
        HStack(alignment: .top, spacing: 18) {
          youSection.frame(minWidth: 300)
          machineSection.frame(minWidth: 300)
        }
        VStack(alignment: .leading, spacing: ADEKit.sectionGap) {
          youSection
          machineSection
        }
      }
      SettingsAdeHeroCard(
        machines: machines,
        compatibility: syncService.hostCompatibilityMode,
        advancedPage: advancedPage
      )
    }
    .task(id: "\(syncService.connectionState.rawValue):\(primary?.id ?? "-")") {
      await load()
    }
  }

  // MARK: You

  private var youSection: some View {
    ADESettingsSection("You") {
      ADESettingsRows {
        accountRow
        ADESettingsPageLink(title: SettingsRoute.providers.title, destination: providersPage) { _, pushes in
          ADESettingsRow(title: "Providers", symbol: SettingsRoute.providers.symbol, tint: .violet) {
            SettingsGeneralTrailing(pushes: pushes) {
              providerValue
            }
          }
        }
        ADESettingsPageLink(title: SettingsRoute.usage.title, destination: usagePage) { _, pushes in
          ADESettingsRow(title: "This week", symbol: SettingsRoute.usage.symbol, tint: .teal) {
            SettingsGeneralTrailing(pushes: pushes) {
              weekValue
            }
          }
        }
      }
    }
  }

  /// Who is signed in, opening Account; or, signed out, one row that says so
  /// with the one button that fixes it.
  @ViewBuilder
  private var accountRow: some View {
    switch account.phase {
    case .signedIn:
      if let identity = account.identity {
        ADESettingsPageLink(title: SettingsRoute.account.title, destination: accountPage) { _, pushes in
          SettingsGeneralLeadRow(title: identity.displayName, subtitle: identity.email) {
            AccountAvatar(identity: identity)
          } trailing: {
            if pushes { ADESettingsChevron() }
          }
        }
      }
    case .loading:
      ADESettingsLoadingRow(title: "Checking your account…")
    default:
      SettingsGeneralLeadRow(
        title: "Not signed in",
        subtitle: account.isConfigured
          ? "Reach your machines from any network."
          : "Pair a computer with a code instead."
      ) {
        SettingsGeneralPlaceholderAvatar()
      } trailing: {
        if account.isConfigured {
          Button("Sign in", action: onSignIn)
            .buttonStyle(ADEKitButtonStyle(prominent: true))
            .accessibilityLabel("Sign in to ADE")
        }
      }
    }
  }

  @ViewBuilder
  private var providerValue: some View {
    if let summary = providerSummary {
      ADESettingsStatus(text: summary.text, tone: summary.tone)
    } else {
      ProgressView().controlSize(.small)
    }
  }

  @ViewBuilder
  private var weekValue: some View {
    HStack(spacing: 10) {
      if let weekTotals, weekTotals.count >= 2 {
        SettingsSparkline(values: weekTotals.map(Double.init), height: 20)
          .frame(width: 56)
          .accessibilityHidden(true)
      }
      Text(weekTotals.map { adeUsageCompact($0.reduce(0, +)) } ?? "—")
        .font(.adeMono(13))
        .foregroundStyle(ADEColor.textSecondary)
        .lineLimit(1)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(weekTotals.map { "\(adeUsageCompact($0.reduce(0, +))) tokens" } ?? "No usage yet")
  }

  // MARK: Machines

  private var machineSection: some View {
    ADESettingsSection("Machines") {
      ADESettingsRows {
        ADESettingsPageLink(title: SettingsRoute.machines.title, destination: machinesPage) { _, pushes in
          SettingsGeneralLeadRow(title: primary?.name ?? "No machine yet", subtitle: machineSubtitle) {
            ADESettingsIconTile(
              symbol: primary?.symbol ?? "desktopcomputer",
              tint: primary == nil ? .slate : .accent,
              size: 44
            )
          } trailing: {
            if pushes { ADESettingsChevron() }
          }
        }
        connection(primary != nil)
          .padding(.horizontal, ADEKit.inset)
          .padding(.vertical, 12)
      }
    }
  }

  private var machineSubtitle: String {
    guard let primary else { return "The computer this phone works on." }
    return [primary.appVersion.map(adeVersionDisplayLabel), primary.detail]
      .compactMap { $0 }
      .joined(separator: " · ")
  }

  // MARK: Providers

  private var providerCounts: (detected: Int, signedIn: Int)? { aiStatus?.signInCounts }

  /// The machine's providers in a few words; nil while the first check runs.
  private var providerSummary: (text: String, tone: ADEKitTone)? {
    guard connected else { return ("Not connected", .neutral) }
    if aiLoading && aiStatus == nil { return nil }
    guard let counts = providerCounts else { return ("Unknown", .neutral) }
    if counts.detected == 0 { return ("None found", .neutral) }
    let needSignIn = counts.detected - counts.signedIn
    if needSignIn > 0 { return ("\(needSignIn) need\(needSignIn == 1 ? "s" : "") sign-in", .warn) }
    return ("\(counts.signedIn) ready", .ok)
  }

  // MARK: Needs attention

  private var attentionItems: [SettingsAttentionItem] {
    var items: [SettingsAttentionItem] = []
    if let version = appUpdateAdvisor.availableVersion {
      items.append(.init(text: "ADE \(version) is out for this \(UIDevice.current.model)", tone: .warn))
    }
    if !connected, let primary {
      items.append(.init(text: "Not connected to \(primary.name)", tone: .crit))
    }
    if connected, syncService.hostCompatibilityMode == .limited, let name = primary?.name {
      items.append(.init(text: "\(name) runs an older ADE", tone: .warn))
    }
    if let counts = providerCounts, counts.detected > counts.signedIn {
      let count = counts.detected - counts.signedIn
      items.append(.init(text: "\(count) \(count == 1 ? "provider needs" : "providers need") sign-in", tone: .warn))
    }
    for machine in machines where !machine.isPrimary && machine.isConnectedSet && machine.subtitleIsProblem {
      // Two machines can share a name, so the machine's id keeps each row its own.
      items.append(.init(id: "machine:\(machine.id)", text: "\(machine.name): \(machine.subtitle)", tone: .warn))
    }
    return items
  }

  // MARK: Data

  /// This week's tokens and the machine's providers, both from the machine the
  /// phone works on. Each is optional: an older machine answers neither.
  private func load() async {
    // Another machine's numbers never stay up while this one's load.
    aiStatus = nil
    weekTotals = nil
    aiLoading = false
    guard connected else { return }
    // Tokens first: they answer at once, the provider check can take 30 s.
    if syncService.supportsRemoteAction("usage.getAdeStats") {
      do {
        let week = try await syncService.fetchAdeUsageStats(preset: "7d")
        guard !Task.isCancelled else { return }
        weekTotals = week.daily.map { $0.totalTokens ?? 0 }
      } catch {
        guard !Task.isCancelled else { return }
        settingsGeneralLog.warning("This week's usage read failed: \(error.localizedDescription, privacy: .public)")
      }
    }
    if syncService.supportsRemoteAction("ai.getStatus") {
      aiLoading = true
      do {
        let status = try await syncService.fetchAiSettingsStatus()
        guard !Task.isCancelled else { return }
        aiStatus = status
      } catch {
        guard !Task.isCancelled else { return }
        settingsGeneralLog.warning("Provider status read failed: \(error.localizedDescription, privacy: .public)")
      }
      aiLoading = false
    }
  }
}

// MARK: - Row pieces

/// The lead row of a General panel: a 44pt picture, a name, one quiet line,
/// then a chevron or the one button the row needs.
struct SettingsGeneralLeadRow<Leading: View, Trailing: View>: View {
  let title: String
  var subtitle: String?
  @ViewBuilder var leading: () -> Leading
  @ViewBuilder var trailing: () -> Trailing

  var body: some View {
    HStack(spacing: 14) {
      leading()
      VStack(alignment: .leading, spacing: 3) {
        Text(title)
          .font(.system(size: 17, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
        if let subtitle, !subtitle.isEmpty {
          Text(subtitle)
            .font(.system(size: 13))
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(2)
            .truncationMode(.middle)
        }
      }
      .layoutPriority(1)
      Spacer(minLength: 8)
      // The button keeps its full label; the text wraps instead.
      trailing()
        .fixedSize()
        .layoutPriority(2)
    }
    .padding(.horizontal, ADEKit.inset)
    .padding(.vertical, 14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .combine)
  }
}

/// A row's value, then the chevron when the row pushes its page.
struct SettingsGeneralTrailing<Value: View>: View {
  let pushes: Bool
  @ViewBuilder var value: () -> Value

  var body: some View {
    HStack(spacing: 8) {
      value()
      if pushes { ADESettingsChevron() }
    }
  }
}

/// The signed-out picture: an empty person in a soft circle, the same size
/// and shape as the avatar that replaces it.
struct SettingsGeneralPlaceholderAvatar: View {
  var body: some View {
    Image(systemName: "person.fill")
      .font(.system(size: 19, weight: .medium))
      .foregroundStyle(ADEColor.textMuted)
      .frame(width: 44, height: 44)
      .background(ADEKit.track, in: Circle())
      .overlay(Circle().strokeBorder(ADEKit.rule, lineWidth: 1))
      .accessibilityHidden(true)
  }
}

/// A small line chart with a soft fill under it and a dot on the last value.
struct SettingsSparkline: View {
  let values: [Double]
  var height: CGFloat = 26

  var body: some View {
    GeometryReader { proxy in
      let points = Self.points(values, in: proxy.size)
      ZStack {
        Path { path in
          guard let first = points.first, let last = points.last else { return }
          path.move(to: CGPoint(x: first.x, y: proxy.size.height))
          points.forEach { path.addLine(to: $0) }
          path.addLine(to: CGPoint(x: last.x, y: proxy.size.height))
          path.closeSubpath()
        }
        .fill(LinearGradient(colors: [ADEColor.textPrimary.opacity(0.13), .clear], startPoint: .top, endPoint: .bottom))
        Path { path in
          guard let first = points.first else { return }
          path.move(to: first)
          points.dropFirst().forEach { path.addLine(to: $0) }
        }
        .stroke(ADEColor.textSecondary, style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
        if let last = points.last {
          Circle()
            .fill(ADEColor.textPrimary)
            .frame(width: 5, height: 5)
            .position(last)
        }
      }
    }
    .frame(height: height)
  }

  private static func points(_ values: [Double], in size: CGSize) -> [CGPoint] {
    guard values.count >= 2, let high = values.max() else { return [] }
    let low = min(values.min() ?? 0, high)
    let span = max(high - low, 1)
    let step = size.width / CGFloat(values.count - 1)
    // A 3pt margin top and bottom keeps the line and its dot inside the frame.
    let usable = max(size.height - 6, 1)
    return values.enumerated().map { index, value in
      CGPoint(x: CGFloat(index) * step, y: 3 + usable * (1 - CGFloat((value - low) / span)))
    }
  }
}

// MARK: - Needs attention

struct SettingsAttentionItem: Identifiable, Equatable {
  let id: String
  let text: String
  let tone: ADEKitTone

  /// `id` defaults to the text, which is unique for every reason but a machine's.
  init(id: String? = nil, text: String, tone: ADEKitTone) {
    self.id = id ?? text
    self.text = text
    self.tone = tone
  }
}

/// The desktop's "N things need attention" strip: one line with the reasons,
/// opening to the full list.
struct SettingsAttentionStrip: View {
  let items: [SettingsAttentionItem]
  @State private var expanded = false

  private var tone: ADEKitTone { items.contains { $0.tone == .crit } ? .crit : .warn }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Button {
        withAnimation(.snappy(duration: 0.2)) { expanded.toggle() }
      } label: {
        HStack(spacing: 10) {
          ADEKitDot(tone: tone, size: 7)
          VStack(alignment: .leading, spacing: 2) {
            Text(items.count == 1 ? "1 thing needs attention" : "\(items.count) things need attention")
              .font(.system(size: 14, weight: .semibold))
              .foregroundStyle(ADEColor.textPrimary)
            if !expanded {
              Text(items.prefix(2).map(\.text).joined(separator: " · "))
                .font(.system(size: 12.5))
                .foregroundStyle(ADEColor.textSecondary)
                .lineLimit(1)
            }
          }
          Spacer(minLength: 8)
          Image(systemName: "chevron.down")
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(ADEColor.textMuted)
            .rotationEffect(.degrees(expanded ? 180 : 0))
        }
        .padding(.horizontal, ADEKit.inset)
        .padding(.vertical, 12)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityHint(expanded ? "Hides the list." : "Shows the list.")
      if expanded {
        VStack(alignment: .leading, spacing: 8) {
          ForEach(items) { item in
            HStack(alignment: .firstTextBaseline, spacing: 8) {
              ADEKitDot(tone: item.tone, size: 6)
              Text(item.text)
                .font(.system(size: 13))
                .foregroundStyle(ADEColor.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            }
          }
        }
        .padding(.horizontal, ADEKit.inset)
        .padding(.bottom, 12)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(tone.color.opacity(0.07), in: RoundedRectangle(cornerRadius: ADEKit.radius, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: ADEKit.radius, style: .continuous).strokeBorder(tone.color.opacity(0.35), lineWidth: 0.75))
  }
}

// MARK: - ADE

/// "ADE": the build on this phone over the desktop's hero wash, with its one
/// action, then every machine's ADE version, then Advanced.
struct SettingsAdeHeroCard: View {
  let machines: [SettingsMachine]
  let compatibility: SyncHostCompatibilityMode
  let advancedPage: () -> AnyView
  @EnvironmentObject private var appUpdateAdvisor: AppUpdateAdvisor
  @Environment(\.openURL) private var openURL

  private var state: String {
    if appUpdateAdvisor.isChecking { return "Checking for updates…" }
    if let version = appUpdateAdvisor.availableVersion { return "ADE \(version) is ready to install" }
    return appUpdateAdvisor.hasChecked ? "Up to date" : "Not checked yet"
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      hero
      if !machines.isEmpty {
        VStack(alignment: .leading, spacing: 0) {
          ADEEyebrow("Every machine")
            .padding(.horizontal, ADEKit.inset)
            .padding(.top, 14)
            .padding(.bottom, 6)
          ForEach(Array(machines.enumerated()), id: \.element.id) { index, machine in
            if index > 0 {
              Rectangle().fill(ADEKit.rule).frame(height: 0.75).padding(.leading, ADEKit.inset)
            }
            machineRow(machine)
          }
        }
        Rectangle().fill(ADEKit.rule).frame(height: 0.75)
      }
      if compatibility == .limited, let name = machines.first(where: \.isPrimary)?.name {
        ADESettingsNotice(message: "\(name) runs an older ADE, so some things here stay read-only. Update ADE on it to use everything.")
          .padding(ADEKit.inset)
        Rectangle().fill(ADEKit.rule).frame(height: 0.75)
      }
      NavigationLink {
        advancedPage()
      } label: {
        HStack(spacing: 10) {
          Image(systemName: SettingsRoute.advanced.symbol)
            .font(.system(size: 14))
            .foregroundStyle(ADEColor.textSecondary)
          (Text("Advanced").foregroundStyle(ADEColor.textPrimary)
            + Text("  connection, delivery, this build").foregroundStyle(ADEColor.textMuted))
            .font(.system(size: 14))
            .lineLimit(1)
          Spacer(minLength: 8)
          ADESettingsChevron()
        }
        .padding(.horizontal, ADEKit.inset)
        .frame(minHeight: 48)
      }
      .buttonStyle(ADEKitRowButtonStyle())
    }
    .adeKitCard(padding: nil)
  }

  private var hero: some View {
    HStack(alignment: .center, spacing: 16) {
      Image("BrandMark")
        .resizable()
        .scaledToFit()
        .frame(height: 30)
        .accessibilityLabel("ADE")
      VStack(alignment: .leading, spacing: 4) {
        Text(Self.appVersion)
          .font(.system(size: 22, weight: .medium, design: .monospaced))
          .foregroundStyle(.white)
          .lineLimit(1)
          .minimumScaleFactor(0.7)
        Text(state)
          .font(.system(size: 13))
          .foregroundStyle(.white.opacity(0.82))
          .lineLimit(2)
      }
      Spacer(minLength: 8)
      heroButton
    }
    .padding(.horizontal, 18)
    .padding(.vertical, 22)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background { SettingsAdeHeroWash() }
    .environment(\.colorScheme, .dark)
  }

  @ViewBuilder
  private var heroButton: some View {
    if appUpdateAdvisor.availableVersion != nil, let url = appUpdateAdvisor.storeURL {
      Button("Update") { openURL(url) }
        .buttonStyle(SettingsHeroButtonStyle(prominent: true))
    } else {
      Button {
        Task { await appUpdateAdvisor.checkForUpdates(force: true) }
      } label: {
        if appUpdateAdvisor.isChecking {
          ProgressView().controlSize(.small)
        } else {
          Text("Check")
        }
      }
      .buttonStyle(SettingsHeroButtonStyle(prominent: false))
      .disabled(appUpdateAdvisor.isChecking)
      .accessibilityLabel("Check for updates")
    }
  }

  private func machineRow(_ machine: SettingsMachine) -> some View {
    HStack(spacing: 10) {
      ADESettingsIconTile(symbol: machine.symbol, tint: machine.isLive ? .accent : .slate, size: 28)
      Text(machine.name)
        .font(.system(size: 14.5, weight: .medium))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)
      // Stable is the default and needs no tag; Beta does.
      if machine.runsBeta {
        ADEKitTag(text: "Beta", tone: .warn)
      }
      Spacer(minLength: 8)
      Text(machine.appVersion.map(adeVersionValue) ?? "—")
        .font(.adeMono(12))
        .foregroundStyle(ADEColor.textSecondary)
        .lineLimit(1)
      if let status = status(machine) {
        ADESettingsStatus(text: status.text, tone: status.tone)
      }
    }
    .padding(.horizontal, ADEKit.inset)
    .frame(minHeight: 46)
    .accessibilityElement(children: .combine)
  }

  private func status(_ machine: SettingsMachine) -> (text: String, tone: ADEKitTone)? {
    if machine.isPrimary, compatibility == .limited { return ("Update", .warn) }
    if case .connected(.needsUpdate, _) = machine.link { return ("Update", .warn) }
    if machine.isLive { return ("Live", .ok) }
    if machine.isAsleep { return ("Asleep", .neutral) }
    return machine.online ? nil : ("Offline", .neutral)
  }

  private static var appVersion: String {
    let info = Bundle.main.infoDictionary
    return info?["CFBundleShortVersionString"] as? String ?? "–"
  }
}

/// The desktop hero's wash (`.ade-gen-hero-wash`): violet, sky and pink glows
/// on a deep base, darkened at the edges so white text reads on it.
struct SettingsAdeHeroWash: View {
  var body: some View {
    ZStack {
      LinearGradient(
        colors: [Color(red: 0.11, green: 0.06, blue: 0.20), Color(red: 0.07, green: 0.05, blue: 0.14), Color(red: 0.05, green: 0.07, blue: 0.15)],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
      )
      RadialGradient(colors: [Color(red: 0.66, green: 0.33, blue: 0.97).opacity(0.85), .clear], center: UnitPoint(x: 0.08, y: 0.1), startRadius: 0, endRadius: 220)
      RadialGradient(colors: [Color(red: 0.22, green: 0.74, blue: 0.97).opacity(0.55), .clear], center: UnitPoint(x: 0.92, y: 0), startRadius: 0, endRadius: 200)
      RadialGradient(colors: [Color(red: 0.93, green: 0.28, blue: 0.60).opacity(0.45), .clear], center: UnitPoint(x: 0.7, y: 1.1), startRadius: 0, endRadius: 220)
      LinearGradient(colors: [.black.opacity(0.30), .black.opacity(0.05), .black.opacity(0.25)], startPoint: .leading, endPoint: .trailing)
    }
    .accessibilityHidden(true)
  }
}

/// The hero's button: a glassy white plane, or solid white for the one that
/// installs an update (`.ade-gen-hero-btn`).
struct SettingsHeroButtonStyle: ButtonStyle {
  let prominent: Bool
  @Environment(\.isEnabled) private var isEnabled

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 13.5, weight: .semibold))
      .foregroundStyle(prominent ? Color.black : Color.white)
      .padding(.horizontal, 14)
      .frame(minHeight: 34)
      .background(prominent ? Color.white : Color.white.opacity(configuration.isPressed ? 0.24 : 0.14), in: Capsule())
      .overlay(Capsule().strokeBorder(Color.white.opacity(prominent ? 0 : 0.22), lineWidth: 0.75))
      .opacity(isEnabled ? 1 : 0.6)
  }
}
