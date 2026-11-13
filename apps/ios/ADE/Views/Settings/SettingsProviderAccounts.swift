import SwiftUI

// MARK: - Presentation helpers

/// The quota windows the usage snapshot holds for one account, short window first.
func providerAccountWindows(_ account: ProviderAccount, snapshot: MobileUsageQuotaSnapshot?) -> [MobileUsageQuotaWindow] {
  guard let snapshot else { return [] }
  let usageIds = Set((snapshot.accounts ?? []).filter { $0.instanceId == account.id }.map(\.id))
  let windows = snapshot.windows.filter { window in
    guard window.provider == account.provider, let accountId = window.accountId else { return false }
    return usageIds.contains(accountId) || accountId == account.id
  }
  var seen = Set<String>()
  return windows
    .sorted { adeUsageWindowRank(adeUsageWindowLabel($0)) < adeUsageWindowRank(adeUsageWindowLabel($1)) }
    .filter { seen.insert(adeUsageWindowLabel($0)).inserted }
}

/// The one-line state under an account's name. The name is the email; the
/// internal id is never shown.
func providerAccountDetailLine(_ account: ProviderAccount) -> String? {
  if account.loginBroken == true { return "Sign in again" }
  guard account.signedIn else { return "Sign in to use it for chats" }
  return account.plan.map { $0.capitalized }
}

/// The other machine whose fresher reading this account's bars are, when the
/// host borrowed one (`UsageAccount.readingFrom`). Nil for the host's own.
func providerAccountReadingFrom(_ account: ProviderAccount, snapshot: MobileUsageQuotaSnapshot?) -> String? {
  let usage = snapshot?.accounts?.first { $0.provider == account.provider && $0.instanceId == account.id }
  let label = usage?.readingFrom?.label.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  return label.isEmpty ? nil : label
}

/// How many distinct logins the accounts hold: a copy (`sameLoginAs`) adds no
/// quota, so it is not another account. Desktop `countProviderLogins`.
func providerAccountLoginCount(_ accounts: [ProviderAccount]) -> Int {
  accounts.filter { $0.sameLoginAs == nil }.count
}

/// The provider's name, for an account of either provider.
func providerAccountProviderTitle(_ account: ProviderAccount) -> String {
  ProviderAccountProvider(rawValue: account.provider)?.title ?? account.provider.capitalized
}

/// What removing an account does, for both places that offer it.
func providerAccountRemoveMessage(hostName: String?) -> String {
  "ADE signs this account out on \(hostName ?? "the machine") and stops using it. Adding it back starts with a fresh sign-in."
}

/// What signing an account out does. The machine's own login is the one the
/// terminal's CLI uses, so that is said (desktop `onAction` "signOut").
func providerAccountSignOutMessage(_ account: ProviderAccount, hostName: String?) -> String {
  let provider = providerAccountProviderTitle(account)
  if account.isMachineLogin {
    return "This is \(hostName ?? "the machine")'s own \(provider) login, so \(provider) in its terminal is signed out too."
  }
  return "The account stays. Sign in puts a login back."
}

/// An account's tags: where new chats go, a broken login, a copy of another
/// login, and Claude's long subagent cache (desktop `AccountCard` header).
struct ProviderAccountBadges: View {
  let account: ProviderAccount
  var routingBadge: String?

  var body: some View {
    HStack(spacing: 6) {
      if let routingBadge { ADEKitTag(text: routingBadge, tone: .accent) }
      if account.loginBroken == true { ADEKitTag(text: "Signed out", tone: .warn) }
      if account.sameLoginAs != nil, account.loginBroken != true { ADEKitTag(text: "Copy") }
      if account.subagentPromptCacheTtl == "1h" { ADEKitTag(text: "1h cache") }
      // The detail page says what happened and offers to sign it back in.
      if account.replacedAccount != nil { ADEKitTag(text: "Login replaced", tone: .warn) }
    }
  }
}

// MARK: - Page

/// A machine the AI accounts page can show.
struct ProviderAccountsMachineOption: Identifiable, Equatable {
  let id: String
  let name: String
}

/// Settings → AI accounts: the Claude and Codex logins of each connected
/// machine. Logins live on the machine, so each machine has its own accounts,
/// default and smart balance; the picker switches between them without
/// changing which machine is primary.
struct SettingsProviderAccountsPage: View {
  let syncService: SyncService
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  @EnvironmentObject private var fleet: MachineFleet
  @State private var provider: ProviderAccountProvider
  @State private var selectedMachineId: String?
  @StateObject private var directory = ProviderAccountsMachineDirectory()

  /// `machineKey` opens on that machine (from its machine page); nil opens on
  /// the primary machine.
  init(syncService: SyncService, provider: ProviderAccountProvider = .claude, machineKey: String? = nil) {
    self.syncService = syncService
    _provider = State(initialValue: provider)
    _selectedMachineId = State(initialValue: machineKey)
  }

  private var primaryId: String { syncService.focusedMachineKey ?? "primary" }

  /// The primary machine, then every live machine on the phone's fleet that
  /// can manage its accounts from here.
  private var choices: [(option: ProviderAccountsMachineOption, host: ProviderAccountsHost)] {
    var result: [(ProviderAccountsMachineOption, ProviderAccountsHost)] = [(
      ProviderAccountsMachineOption(id: primaryId, name: syncService.hostName ?? "Connected computer"),
      syncService
    )]
    for machine in fleet.machines where machine.state == .live && machine.machineKey != primaryId {
      guard let connection = fleet.connection(for: machine.machineKey), connection.supportsProviderAccounts else { continue }
      result.append((ProviderAccountsMachineOption(id: machine.machineKey, name: machine.name), connection))
    }
    return result
  }

  var body: some View {
    let choices = self.choices
    let wantedId = selectedMachineId ?? primaryId
    let selected = choices.first { $0.option.id == wantedId } ?? choices[0]
    Group {
      if selected.option.id != wantedId {
        // The machine picked here dropped off the fleet. Say so rather than
        // quietly showing the primary's accounts, where the next tap would
        // change a different machine than the one the user chose.
        ProviderAccountsMachineGoneView(
          machineName: fleet.machine(for: wantedId)?.name ?? "That machine",
          primaryName: choices[0].option.name
        ) { selectedMachineId = nil }
      } else if !selected.host.supportsProviderAccounts {
        ProviderAccountsUnavailableView(hostName: selected.option.name, connected: selected.host.providerAccountsConnected)
      } else {
        let machine = directory.machine(id: selected.option.id, name: selected.option.name, host: selected.host)
        ProviderAccountsScreen(
          provider: $provider,
          machine: machine,
          store: machine.store(for: provider),
          canChange: selected.host.canChangeProviderAccounts,
          machines: choices.map(\.option),
          selectedMachineId: Binding(get: { selected.option.id }, set: { selectedMachineId = $0 })
        )
        .id(machine.id)
      }
    }
    .navigationTitle("AI accounts")
    .navigationBarTitleDisplayMode(.inline)
    .settingsPageClose()
  }
}

/// Which machine's accounts are on screen, and a menu to switch when there
/// is more than one.
struct ProviderAccountsMachinePicker: View {
  let machines: [ProviderAccountsMachineOption]
  @Binding var selectedId: String

  private var selected: ProviderAccountsMachineOption? { machines.first { $0.id == selectedId } }

  var body: some View {
    if machines.count > 1 {
      Menu {
        ForEach(machines) { machine in
          Button {
            selectedId = machine.id
          } label: {
            // Two texts make an iOS menu row a title and a subtitle.
            Text(machine.name)
            Text("Connected")
            Image(systemName: machine.id == selectedId ? "checkmark" : "desktopcomputer")
          }
        }
      } label: { label(showsChevron: true) }
      .accessibilityLabel("Machine: \(selected?.name ?? "")")
    } else {
      label(showsChevron: false)
    }
  }

  private func label(showsChevron: Bool) -> some View {
    HStack(spacing: 12) {
      ADESettingsIconTile(symbol: "desktopcomputer", tint: .accent, size: 32)
      VStack(alignment: .leading, spacing: 1) {
        Text(selected?.name ?? "Connected computer")
          .font(.system(size: 15, weight: .medium))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
        Text(showsChevron ? "\(machines.count) machines" : "Connected")
          .font(.system(size: 12.5))
          .foregroundStyle(ADEColor.textSecondary)
      }
      Spacer(minLength: 8)
      if showsChevron {
        Image(systemName: "chevron.up.chevron.down")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(ADEColor.textMuted)
      }
    }
    .contentShape(Rectangle())
  }
}

/// The page body, with no host of its own: the live page and the fixture
/// screens both render it.
struct ProviderAccountsScreen: View {
  @Binding var provider: ProviderAccountProvider
  @ObservedObject var machine: ProviderAccountsMachine
  @ObservedObject var store: ProviderAccountsStore
  var canChange = true
  var machines: [ProviderAccountsMachineOption] = []
  var selectedMachineId: Binding<String>?
  @State private var adding = false
  @State private var signIn: ProviderAccountSignInRoute?
  @State private var removing: ProviderAccount?
  @State private var signingOut: ProviderAccount?
  @State private var toast: ADEToastMessage?

  var body: some View {
    List {
      Section {
        ProviderAccountsProviderPicker(selection: $provider)
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
      }

      Section {
        if let selectedMachineId {
          ProviderAccountsMachinePicker(machines: machines, selectedId: selectedMachineId)
            .adeSettingsListRow()
        }
        if showsSmartBalance {
          routingRow(
            "Smart balance",
            symbol: "arrow.triangle.branch",
            tint: .teal,
            detail: balanceDetail(enabled: store.settings?.smartBalance ?? false),
            isOn: store.settings?.smartBalance ?? false
          ) { value in Task { await store.setSmartBalance(value) } }
          .adeSettingsListRow()
        }
        if providerAccountOffersAutoStart(provider, snapshot: machine.quota) {
          routingRow(
            "Auto-start 5-hour windows",
            symbol: "timer",
            tint: .amber,
            detail: ProviderAccountRoutingCopy.autoStart,
            isOn: store.settings?.autoStartWindows ?? false
          ) { value in Task { await store.setAutoStartWindows(value) } }
          .adeSettingsListRow()
        }
      }

      if let error = store.errorMessage {
        Section {
          ADEFlatInlineNotice(message: error, tint: ADEColor.danger) {
            Task { await store.load(refresh: true) }
          }
          .adeSettingsListRow()
        }
      }

      Section {
        if !store.loaded {
          HStack { ProgressView(); Spacer() }.adeSettingsListRow()
        }
        ForEach(store.accounts) { account in
          NavigationLink {
            ProviderAccountDetailPage(
              machine: machine,
              store: store,
              accountId: account.id,
              canChange: canChange,
              routingBadge: routingBadge(account),
              onSignIn: { signIn = ProviderAccountSignInRoute(account: $0) },
              onRestoreReplaced: { restoreReplaced(account) }
            )
          } label: {
            ProviderAccountRow(
              account: account,
              ownerLabel: ownerLabel(account),
              windows: providerAccountWindows(account, snapshot: machine.quota),
              readingFrom: providerAccountReadingFrom(account, snapshot: machine.quota),
              routingBadge: routingBadge(account),
              busy: store.busyAccountId == account.id
            )
          }
          .adeSettingsListRow(insets: EdgeInsets(top: 12, leading: ADEKit.inset, bottom: 12, trailing: ADEKit.inset))
          .swipeActions(edge: .leading, allowsFullSwipe: true) {
            if canChange, canUse(account) {
              Button { useForNewChats(account) } label: { Label("Use", systemImage: "checkmark.circle.fill") }
                .tint(ADEColor.accent)
            }
          }
          .swipeActions(edge: .trailing) {
            if canChange, !account.isDefault, !account.isMachineLogin {
              Button(role: .destructive) { removing = account } label: { Label("Remove", systemImage: "trash") }
            }
            if canChange, !account.isDefault, account.hasLogin {
              Button { signingOut = account } label: { Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right") }
                .tint(ADEColor.warning)
            }
          }
          .contextMenu { contextMenu(account) }
        }
        if canChange, store.loaded {
          // No name to type: the account shows as the email it signs in with.
          Button { addAccount() } label: {
            HStack(spacing: 8) {
              Label("Add \(provider.title) account", systemImage: "plus")
                .font(.system(size: 15))
                .foregroundStyle(ADEColor.accent)
              if adding { ProgressView().controlSize(.mini) }
            }
          }
          .buttonStyle(.plain)
          .disabled(adding)
          .adeSettingsListRow()
        }
      } header: {
        ADESettingsHeader(
          store.accounts.isEmpty ? "Accounts" : "Accounts · \(providerAccountLoginCount(store.accounts))",
          hint: footerText
        )
      }
    }
    .adeSettingsList()
    .refreshable {
      await store.load(refresh: true)
      await machine.loadQuota(refresh: true)
    }
    .task(id: provider) {
      if !store.loaded { await store.load() }
      if machine.quota == nil { await machine.loadQuota() }
    }
    .animation(.snappy, value: store.accounts)
    .adeToast($toast)
    .sheet(item: $signIn) { route in
      ProviderAccountSignInSheet(account: route.account, host: machine.host) { email in
        signIn = nil
        toast = ADEToastMessage(text: email.map { "Signed in as \($0)" } ?? "Signed in")
        Task { await store.refreshAfterSignIn(id: route.account.id) }
      }
      .presentationDetents([.large])
    }
    .confirmationDialog(
      "Remove \(removing?.displayName ?? "account")?",
      isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
      titleVisibility: .visible
    ) {
      Button("Remove", role: .destructive) {
        guard let account = removing else { return }
        removing = nil
        Task {
          if await store.remove(id: account.id) {
            toast = ADEToastMessage(text: "\(account.displayName) removed")
          }
        }
      }
      Button("Cancel", role: .cancel) { removing = nil }
    } message: {
      Text(providerAccountRemoveMessage(hostName: machine.name))
    }
    .confirmationDialog(
      "Sign out \(signingOut?.displayName ?? "account")?",
      isPresented: Binding(get: { signingOut != nil }, set: { if !$0 { signingOut = nil } }),
      titleVisibility: .visible
    ) {
      Button("Sign out", role: .destructive) {
        guard let account = signingOut else { return }
        signingOut = nil
        Task {
          if await store.signOut(id: account.id) {
            toast = ADEToastMessage(text: "\(account.displayName) signed out")
          }
        }
      }
      Button("Cancel", role: .cancel) { signingOut = nil }
    } message: {
      Text(signingOut.map { providerAccountSignOutMessage($0, hostName: machine.name) } ?? "")
    }
  }

  /// Smart balance means something with two logins to spread chats over. It
  /// stays while on, so it can be turned off (desktop `showSmartBalance`).
  private var showsSmartBalance: Bool {
    providerAccountLoginCount(store.accounts) >= 2 || store.settings?.smartBalance == true
  }

  /// One machine-wide switch for this provider's accounts: what it does, then
  /// the switch.
  private func routingRow(
    _ title: String,
    symbol: String,
    tint: ADESettingsTint,
    detail: String,
    isOn: Bool,
    set: @escaping (Bool) -> Void
  ) -> some View {
    HStack(alignment: .center, spacing: 12) {
      ADESettingsIconTile(symbol: symbol, tint: tint, size: 32)
      VStack(alignment: .leading, spacing: 2) {
        Text(title)
          .font(.system(size: 15))
          .foregroundStyle(ADEColor.textPrimary)
        Text(detail)
          .font(.system(size: 12.5))
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      .layoutPriority(1)
      Spacer(minLength: 8)
      Toggle(title, isOn: Binding(get: { isOn }, set: set))
        .labelsHidden()
        .tint(ADEColor.accent)
        .disabled(!canChange || store.settings == nil)
    }
    .accessibilityElement(children: .combine)
  }

  private func balanceDetail(enabled: Bool) -> String {
    if enabled {
      if store.accounts.filter(\.canTakeChats).count < 2 {
        return "Add a second signed-in account to spread chats across them."
      }
      let next = store.accounts.first(where: isBalanceNext).map { " Next: \($0.displayName)." } ?? ""
      return ProviderAccountRoutingCopy.smartBalanceOn + next
    }
    let fallback = store.accounts.first(where: \.isDefault)?.displayName ?? "the account marked New chats"
    return "New chats use \(fallback). Swipe right on an account to use it instead."
  }

  private var footerText: String {
    "Running chats keep their account. Tap an account for its limits and settings."
  }

  @ViewBuilder
  private func contextMenu(_ account: ProviderAccount) -> some View {
    if canChange {
      if canUse(account) {
        Button { useForNewChats(account) } label: { Label("Use for new chats", systemImage: "checkmark.circle") }
      }
      Button { signIn = ProviderAccountSignInRoute(account: account) } label: {
        Label(account.hasLogin ? "Sign in again" : "Sign in", systemImage: "person.badge.key")
      }
      // The host refuses both on the default, and Remove on the machine's own login.
      if !account.isDefault {
        Divider()
        if account.hasLogin {
          Button(role: .destructive) { signingOut = account } label: {
            Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right")
          }
        }
        if !account.isMachineLogin {
          Button(role: .destructive) { removing = account } label: { Label("Remove", systemImage: "trash") }
        }
      }
    }
  }

  private func addAccount() {
    guard !adding else { return }
    adding = true
    Task {
      let created = await store.create()
      adding = false
      if let created { signIn = ProviderAccountSignInRoute(account: created) }
    }
  }

  /// The account can become where new chats go, and is not already.
  private func canUse(_ account: ProviderAccount) -> Bool {
    account.canTakeChats && (store.settings?.smartBalance == true || !account.isDefault)
  }

  private func useForNewChats(_ account: ProviderAccount) {
    Task {
      if await store.useForNewChats(id: account.id) {
        ADEHaptics.success()
        toast = ADEToastMessage(text: "New chats use \(account.displayName)")
      }
    }
  }

  private func routingBadge(_ account: ProviderAccount) -> String? {
    providerAccountRoutingBadge(account, smartBalance: store.settings?.smartBalance == true, isNext: isBalanceNext(account))
  }

  /// Brings a replaced login back (desktop `restoreReplaced`). A copy of this
  /// account is the natural slot: signing it in to the replaced email makes
  /// two accounts again. Without one, a new account is added for it.
  private func restoreReplaced(_ account: ProviderAccount) {
    if let slot = store.accounts.first(where: { $0.sameLoginAs == account.id && !$0.isMachineLogin }) {
      signIn = ProviderAccountSignInRoute(account: slot)
    } else {
      addAccount()
    }
  }

  private func isBalanceNext(_ account: ProviderAccount) -> Bool {
    guard store.settings?.smartBalance == true else { return false }
    return machine.quota?.balanceNext?.contains { $0.provider == account.provider && $0.instanceId == account.id } == true
  }

  private func ownerLabel(_ account: ProviderAccount) -> String? {
    guard let owner = account.sameLoginAs else { return nil }
    return store.account(id: owner)?.displayName ?? owner
  }
}

struct ProviderAccountSignInRoute: Identifiable {
  let account: ProviderAccount
  var id: String { account.id }
}

// MARK: - Row

struct ProviderAccountRow: View {
  let account: ProviderAccount
  var ownerLabel: String?
  var windows: [MobileUsageQuotaWindow] = []
  /// The machine whose fresher reading `windows` are; nil for the host's own.
  var readingFrom: String? = nil
  /// "New chats" or "Next chat"; see `providerAccountRoutingBadge`.
  var routingBadge: String? = nil
  var busy = false

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      ADEBrandTile(brand: .provider(account.provider), size: 32, dimmed: !account.signedIn)
      rowBody
    }
    .accessibilityElement(children: .combine)
  }

  private var rowBody: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 6) {
        Text(account.displayName)
          .font(.system(size: 15, weight: .semibold))
          // No email is a state, not a name: it reads quieter than one.
          .foregroundStyle(account.email == nil ? ADEColor.textSecondary : ADEColor.textPrimary)
          .lineLimit(1)
        badges
        Spacer(minLength: 4)
        if busy { ProgressView().controlSize(.mini) }
      }
      if let detailLine {
        Text(detailLine)
          .font(.system(size: 12.5))
          .foregroundStyle(account.loginBroken == true ? ADEColor.warning : ADEColor.textSecondary)
          .lineLimit(1)
          .truncationMode(.middle)
      }
      if account.signedIn, !windows.isEmpty, ownerLabel == nil {
        HStack(spacing: 14) {
          ForEach(windows.prefix(2)) { window in
            ProviderAccountQuotaMeter(window: window, tint: ADEColor.providerBrand(for: account.provider))
          }
          if let readingFrom {
            // These bars are another machine's fresher reading of this login.
            ADEKitTag(text: "via \(readingFrom)", keepsCase: true)
              .accessibilityLabel("Read on \(readingFrom)")
          }
        }
        .padding(.top, 4)
      }
    }
  }

  private var detailLine: String? {
    // A broken login shares nothing; its own line says why, like desktop.
    if let ownerLabel, account.loginBroken != true { return "Same login as \(ownerLabel) · shares its limits" }
    return providerAccountDetailLine(account)
  }

  @ViewBuilder
  private var badges: some View {
    ProviderAccountBadges(account: account, routingBadge: routingBadge)
  }
}

/// One window's headroom: label, a thin bar, and the percent left.
struct ProviderAccountQuotaMeter: View {
  let window: MobileUsageQuotaWindow
  let tint: Color
  var wide = false

  var body: some View {
    let left = adeUsageDisplayPercentLeft(window)
    let tone = ADEUsagePressure.tone(percentLeft: left)
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 4) {
        Text(adeUsageWindowLabel(window))
          .font(.system(size: 11.5))
          .foregroundStyle(ADEColor.textMuted)
        Spacer(minLength: 4)
        Text("\(Int(left.rounded()))% left")
          .font(.adeMono(10.5, weight: .medium))
          .foregroundStyle(tone == .neutral ? ADEColor.textSecondary : tone.color)
      }
      ADEKitMeter(fraction: left / 100, color: ADEUsagePressure.color(percentLeft: left, fallback: tint))
      if wide {
        Text(resetLine(window))
          .font(.system(size: 11.5))
          .foregroundStyle(ADEColor.textMuted)
      }
    }
    .frame(maxWidth: wide ? .infinity : 130)
  }

  private func resetLine(_ window: MobileUsageQuotaWindow) -> String {
    let ms = adeUsageResetsInMs(window)
    guard ms > 0 else { return "Full" }
    return "Resets in \(adeUsageDurationLabel(milliseconds: ms))"
  }
}

// MARK: - Detail

struct ProviderAccountDetailPage: View {
  @ObservedObject var machine: ProviderAccountsMachine
  @ObservedObject var store: ProviderAccountsStore
  let accountId: String
  var canChange = true
  var routingBadge: String? = nil
  var onSignIn: (ProviderAccount) -> Void = { _ in }
  var onRestoreReplaced: () -> Void = {}
  @Environment(\.dismiss) private var dismiss
  @State private var confirmRemove = false
  @State private var confirmSignOut = false

  var body: some View {
    Group {
      if let account = store.account(id: accountId) {
        content(account)
      } else {
        ADEEmptyStateView(symbol: "person.crop.circle.badge.xmark", title: "Account removed", message: "This account is no longer on the machine.") {
          EmptyView()
        }
      }
    }
    .navigationTitle("")
    .navigationBarTitleDisplayMode(.inline)
    .settingsPageClose()
  }

  private func content(_ account: ProviderAccount) -> some View {
    let windows = providerAccountWindows(account, snapshot: machine.quota)
    return ScrollView {
      VStack(alignment: .leading, spacing: ADEKit.sectionGap) {
        VStack(alignment: .leading, spacing: 14) {
          HStack(spacing: 12) {
            ADEBrandTile(brand: .provider(account.provider), size: 44)
            VStack(alignment: .leading, spacing: 3) {
              HStack(spacing: 6) {
                Text(account.displayName)
                  .font(.system(size: 18, weight: .semibold))
                  .foregroundStyle(ADEColor.textPrimary)
                  .lineLimit(1)
                  .truncationMode(.middle)
              }
              ProviderAccountBadges(account: account, routingBadge: routingBadge)
              if let detail = providerAccountDetailLine(account) {
                Text(detail)
                  .font(.system(size: 12.5))
                  .foregroundStyle(account.loginBroken == true ? ADEColor.warning : ADEColor.textSecondary)
              }
            }
            Spacer(minLength: 0)
          }
          actionBar(account)
        }
        .adeKitCard()

        if let error = store.errorMessage {
          ADESettingsNotice(message: error, tone: .crit)
        }

        if let owner = account.sameLoginAs, account.loginBroken != true {
          let ownerName = store.account(id: owner)?.displayName ?? "another account"
          ADESettingsNotice(
            message: "Same login as \(ownerName), so this adds no quota. Smart balance skips it.",
            tone: .neutral,
            actionTitle: canChange ? "Sign in to another account" : nil,
            action: canChange ? { onSignIn(account) } : nil
          )
        }

        if let replaced = account.replacedAccount {
          ADESettingsNotice(
            message: "\(replaced.email) was replaced. A sign-in outside ADE put another login in this account.",
            tone: .warn,
            actionTitle: canChange ? "Sign it back in" : nil,
            action: canChange ? onRestoreReplaced : nil,
            dismiss: canChange ? { Task { await store.dismissReplaced(id: account.id) } } : nil
          )
        }

        if account.signedIn, !windows.isEmpty {
          ADESettingsSection("Limits") {
            VStack(spacing: 14) {
              ForEach(windows) { window in
                ProviderAccountQuotaMeter(window: window, tint: ADEColor.providerBrand(for: account.provider), wide: true)
              }
            }
            .adeKitCard()
          }
        }

        if canChange {
          ProviderAccountSettingsSection(account: account, store: store, showsCompaction: store.accounts.count > 1)
        }

        ADESettingsSection("Details") {
          ADESettingsRows {
            if let plan = account.plan { ADESettingsValueRow(title: "Plan", value: plan.capitalized) }
            ADESettingsValueRow(title: "Provider", value: providerAccountProviderTitle(account))
            ADESettingsValueRow(title: "Machine", value: machine.name)
            // A path is too long to share the row with its title.
            ADESettingsRow("Folder", hint: account.configHome)
              .textSelection(.enabled)
          }
        }

        // The host refuses both on the default, and Remove on the machine's own login.
        if canChange, !account.isDefault, account.hasLogin || !account.isMachineLogin {
          ADESettingsRows {
            if account.hasLogin {
              ADESettingsActionRow(title: "Sign out", destructive: true) { confirmSignOut = true }
            }
            if !account.isMachineLogin {
              ADESettingsActionRow(title: "Remove account", destructive: true) { confirmRemove = true }
            }
          }
        }
      }
      .padding(.horizontal, 16)
      .padding(.top, 8)
      .padding(.bottom, 36)
    }
    .background(ADEColor.pageBackground.ignoresSafeArea())
    .confirmationDialog("Remove \(account.displayName)?", isPresented: $confirmRemove, titleVisibility: .visible) {
      Button("Remove", role: .destructive) {
        Task {
          if await store.remove(id: account.id) { dismiss() }
        }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text(providerAccountRemoveMessage(hostName: machine.name))
    }
    .confirmationDialog("Sign out \(account.displayName)?", isPresented: $confirmSignOut, titleVisibility: .visible) {
      Button("Sign out", role: .destructive) {
        Task { await store.signOut(id: account.id) }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text(providerAccountSignOutMessage(account, hostName: machine.name))
    }
  }

  @ViewBuilder
  private func actionBar(_ account: ProviderAccount) -> some View {
    if canChange {
      HStack(spacing: 8) {
        // Already where new chats go: the default with smart balance off.
        if account.canTakeChats, store.settings?.smartBalance == true || !account.isDefault {
          Button("Use for new chats") {
            Task {
              if await store.useForNewChats(id: account.id) { ADEHaptics.success() }
            }
          }
          .buttonStyle(ADEKitButtonStyle(prominent: true))
        }
        Button(account.signedIn ? "Sign in again" : "Sign in") { onSignIn(account) }
          .buttonStyle(ADEKitButtonStyle(prominent: !account.signedIn))
        Spacer(minLength: 0)
      }
      .disabled(store.busyAccountId == account.id)
    }
  }
}

// MARK: - Unavailable

/// The machine the page was showing is no longer connected.
struct ProviderAccountsMachineGoneView: View {
  let machineName: String
  let primaryName: String
  let showPrimary: () -> Void

  var body: some View {
    ADEEmptyStateView(
      symbol: "desktopcomputer.trianglebadge.exclamationmark",
      title: "\(machineName) is not connected",
      message: "Its accounts show here again when it reconnects."
    ) {
      Button("Show \(primaryName)", action: showPrimary)
        .buttonStyle(ADEKitButtonStyle(prominent: true))
    }
  }
}

struct ProviderAccountsUnavailableView: View {
  var hostName: String?
  var connected: Bool

  var body: some View {
    ADEEmptyStateView(
      symbol: connected ? "arrow.down.circle" : "desktopcomputer.trianglebadge.exclamationmark",
      title: connected ? "Update ADE to manage accounts" : "Connect a machine",
      message: connected
        ? "\(hostName ?? "Your primary machine") runs an ADE that cannot manage accounts from the phone yet. Update ADE there, then reconnect."
        : "AI accounts live on your computer. Connect to it from Settings to manage them here."
    ) {
      EmptyView()
    }
  }
}

/// Claude or Codex, each as its maker's tile and name; the picked one is
/// raised on the track, as a segmented control.
struct ProviderAccountsProviderPicker: View {
  @Binding var selection: ProviderAccountProvider

  var body: some View {
    HStack(spacing: 4) {
      ForEach(ProviderAccountProvider.allCases) { provider in
        let selected = provider == selection
        Button {
          withAnimation(.snappy(duration: 0.18)) { selection = provider }
        } label: {
          HStack(spacing: 8) {
            ADEBrandTile(brand: .provider(provider.rawValue), size: 24, dimmed: !selected)
            Text(provider.title)
              .font(.system(size: 14.5, weight: selected ? .semibold : .medium))
              .foregroundStyle(selected ? ADEColor.textPrimary : ADEColor.textSecondary)
          }
          .frame(maxWidth: .infinity, minHeight: 42)
          .background {
            if selected { ADEKitSegmentThumb(radius: 9) }
          }
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(provider.title)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
      }
    }
    .adeKitSegmentTrack()
  }
}
