import OSLog
import SwiftUI

private let settingsGeneralLog = Logger(subsystem: "com.ade.ios", category: "SettingsGeneral")

// Settings › General, where Settings opens. The desktop's General page
// (`GeneralPage.tsx`) on the phone, in the same order: what needs attention,
// then a "You" card and a "This machine" card (side by side where the window
// is wide enough), then ADE itself with every machine's version.

/// The page. `ConnectionSettingsView` owns the connection state and the pages
/// the cards' head links open, and hands them in.
struct SettingsGeneralPage: View {
  let syncService: SyncService
  let machines: [SettingsMachine]
  let onSignIn: () -> Void
  let accountPage: () -> AnyView
  let machinesPage: () -> AnyView
  let advancedPage: () -> AnyView
  /// The connection's status and its one action (Disconnect, Reconnect, Wake),
  /// drawn without its own card.
  let connection: () -> AnyView

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
        HStack(alignment: .top, spacing: 14) {
          youCard.frame(minWidth: 290)
          machineCard.frame(minWidth: 290)
        }
        VStack(spacing: 14) {
          youCard
          machineCard
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

  // MARK: Cards

  private var youCard: some View {
    ADEKitCard(title: "You", symbol: "person.crop.circle", action: {
      SettingsCardHeadLink(title: SettingsRoute.account.title, destination: accountPage)
    }) {
      VStack(alignment: .leading, spacing: 14) {
        youIdentity
        statusLine(tone: providerTone, text: providerLine)
        SettingsCardMeter(
          label: "This week",
          value: weekTotals.map { "\(adeUsageCompact($0.reduce(0, +))) tokens" } ?? "—"
        ) {
          if let weekTotals, weekTotals.count >= 2 {
            SettingsSparkline(values: weekTotals.map(Double.init))
              .accessibilityLabel("Tokens per day this week, \(adeUsageCompact(weekTotals.reduce(0, +))) in all")
          }
        }
      }
    }
    .frame(maxHeight: .infinity, alignment: .top)
  }

  @ViewBuilder
  private var youIdentity: some View {
    switch account.phase {
    case .signedIn:
      if let identity = account.identity {
        SettingsCardIdentity(title: identity.displayName, subtitle: identity.email) {
          AccountAvatar(identity: identity)
        }
      }
    case .loading:
      ProgressView().frame(maxWidth: .infinity, minHeight: 44)
    default:
      SettingsCardIdentity(
        title: "Not signed in",
        subtitle: account.isConfigured ? nil : "Pair a computer with a code instead."
      ) {
        ADESettingsIconTile(symbol: "person.crop.circle", tint: .slate, size: 40)
      }
      if account.isConfigured {
        Button("Sign in to ADE", action: onSignIn)
          .buttonStyle(ADEKitButtonStyle(prominent: true))
      }
    }
  }

  private var machineCard: some View {
    ADEKitCard(title: "This machine", symbol: "desktopcomputer", action: {
      SettingsCardHeadLink(title: SettingsRoute.machines.title, destination: machinesPage)
    }) {
      VStack(alignment: .leading, spacing: 14) {
        SettingsCardIdentity(
          title: primary?.name ?? "No machine yet",
          subtitle: primary.map { machine in
            [machine.appVersion.map { "ADE \($0)" }, machine.detail].compactMap { $0 }.joined(separator: " · ")
          } ?? "The computer this phone works on."
        ) {
          ADESettingsIconTile(symbol: primary?.symbol ?? "desktopcomputer", tint: primary == nil ? .slate : .accent, size: 40)
        }
        connection()
      }
    }
    .frame(maxHeight: .infinity, alignment: .top)
  }

  private func statusLine(tone: ADEKitTone, text: String) -> some View {
    HStack(spacing: 8) {
      ADEKitDot(tone: tone, size: 7)
      Text(text)
        .font(.system(size: 13.5))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(2)
    }
    .accessibilityElement(children: .combine)
  }

  // MARK: Providers

  private var providerCounts: (detected: Int, signedIn: Int)? { aiStatus?.signInCounts }

  /// The desktop's line, word for word, about the machine's providers.
  private var providerLine: String {
    guard connected else { return "Connect a machine to see its providers" }
    if aiLoading && aiStatus == nil { return "Checking providers…" }
    guard let counts = providerCounts else { return "Providers unknown on this machine" }
    if counts.detected == 0 { return "No AI provider found here" }
    let needSignIn = counts.detected - counts.signedIn
    if needSignIn > 0 {
      return "\(counts.signedIn) signed in — \(needSignIn) need\(needSignIn == 1 ? "s" : "") sign-in"
    }
    return "\(counts.signedIn) \(counts.signedIn == 1 ? "provider" : "providers") signed in"
  }

  private var providerTone: ADEKitTone {
    guard let counts = providerCounts, counts.detected > 0 else { return .neutral }
    return counts.detected > counts.signedIn ? .warn : .ok
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
      items.append(.init(text: "\(machine.name): \(machine.subtitle)", tone: .warn))
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

// MARK: - Card pieces

/// A card head's action: the page it opens, then an arrow ("Account →").
struct SettingsCardHeadLink: View {
  let title: String
  let destination: () -> AnyView

  var body: some View {
    NavigationLink {
      destination()
    } label: {
      HStack(spacing: 4) {
        Text(title)
        Image(systemName: "arrow.right")
          .font(.system(size: 10, weight: .semibold))
      }
      .padding(.vertical, 8)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Open \(title)")
  }
}

/// The 40pt picture, a name and one quiet line under it.
struct SettingsCardIdentity<Leading: View>: View {
  let title: String
  var subtitle: String?
  @ViewBuilder var leading: () -> Leading

  var body: some View {
    HStack(spacing: 12) {
      leading()
      VStack(alignment: .leading, spacing: 2) {
        Text(title)
          .font(.system(size: 16, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
        if let subtitle, !subtitle.isEmpty {
          Text(subtitle)
            .font(.system(size: 12.5))
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(1)
            .truncationMode(.middle)
        }
      }
      Spacer(minLength: 0)
    }
    .accessibilityElement(children: .combine)
  }
}

/// A label and a mono figure over a small chart or meter ("This week  9.7M tokens").
struct SettingsCardMeter<Chart: View>: View {
  let label: String
  let value: String
  @ViewBuilder var chart: () -> Chart

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Text(label)
          .font(.system(size: 12.5))
          .foregroundStyle(ADEColor.textSecondary)
        Spacer(minLength: 8)
        Text(value)
          .font(.adeMono(12))
          .foregroundStyle(ADEColor.textSecondary)
      }
      chart()
    }
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
  var id: String { text }
  let text: String
  let tone: ADEKitTone
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
      if machine.appVersion != nil {
        ADEKitTag(text: machine.runsBeta ? "Beta" : "Stable", tone: machine.runsBeta ? .warn : .neutral)
      }
      Spacer(minLength: 8)
      Text(machine.appVersion ?? "—")
        .font(.adeMono(12))
        .foregroundStyle(ADEColor.textSecondary)
        .lineLimit(1)
      if let status = status(machine) {
        ADEKitTag(text: status.text, tone: status.tone)
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
