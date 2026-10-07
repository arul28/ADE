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

/// The one-line state under an account's name.
func providerAccountDetailLine(_ account: ProviderAccount) -> String {
  if account.loginBroken == true { return [account.email, "sign in again"].compactMap { $0 }.joined(separator: " · ") }
  guard account.signedIn else { return "Not signed in yet" }
  return [account.email, account.plan.map { $0.capitalized }].compactMap { $0 }.joined(separator: " · ")
}

/// The provider's name, for an account of either provider.
func providerAccountProviderTitle(_ account: ProviderAccount) -> String {
  ProviderAccountProvider(rawValue: account.provider)?.title ?? account.provider.capitalized
}

/// What removing an account does, for both places that offer it.
func providerAccountRemoveMessage(hostName: String?) -> String {
  "ADE stops using this account. Its login stays on \(hostName ?? "the machine"), so you can add it back later."
}

// MARK: - Page

/// A machine the AI accounts page can show.
struct ProviderAccountsMachineOption: Identifiable, Equatable {
  let id: String
  let name: String
  let isPrimary: Bool
}

/// Settings → AI accounts: the Claude and Codex logins of each connected
/// machine. Logins live on the machine, so each machine has its own accounts,
/// default and smart balance; the picker switches between them without
/// changing which machine is primary.
struct SettingsProviderAccountsPage: View {
  @ObservedObject var syncService: SyncService
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
      ProviderAccountsMachineOption(id: primaryId, name: syncService.hostName ?? "This machine", isPrimary: true),
      syncService
    )]
    for machine in fleet.machines where machine.state == .live && machine.machineKey != primaryId {
      guard let connection = fleet.connection(for: machine.machineKey), connection.supportsProviderAccounts else { continue }
      result.append((ProviderAccountsMachineOption(id: machine.machineKey, name: machine.name, isPrimary: false), connection))
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
            Text(machine.isPrimary ? "Primary connection" : "Connected")
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
    HStack(spacing: 10) {
      Image(systemName: "desktopcomputer")
        .font(.system(size: 15))
        .foregroundStyle(ADEColor.textSecondary)
        .frame(width: 22)
      VStack(alignment: .leading, spacing: 1) {
        Text(selected?.name ?? "This machine")
          .font(.system(size: 15, weight: .medium))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
        Text(showsChevron ? "\(machines.count) machines" : "Accounts on this computer")
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
  @State private var addPresented = false
  @State private var signIn: ProviderAccountSignInRoute?
  @State private var renaming: ProviderAccount?
  @State private var renameText = ""
  @State private var removing: ProviderAccount?
  @State private var toast: ADEToastMessage?

  var body: some View {
    List {
      Section {
        ADEKitSegmented(
          selection: $provider,
          options: ProviderAccountProvider.allCases.map { (value: $0, title: $0.title) }
        )
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
      }

      Section {
        if let selectedMachineId {
          ProviderAccountsMachinePicker(machines: machines, selectedId: selectedMachineId)
            .adeSettingsListRow()
        }
        balanceRow
          .adeSettingsListRow()
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
              onSignIn: { signIn = ProviderAccountSignInRoute(account: $0) }
            )
          } label: {
            ProviderAccountRow(
              account: account,
              ownerLabel: ownerLabel(account),
              windows: providerAccountWindows(account, snapshot: machine.quota),
              isNext: isBalanceNext(account),
              busy: store.busyAccountId == account.id
            )
          }
          .adeSettingsListRow(insets: EdgeInsets(top: 12, leading: ADEKit.inset, bottom: 12, trailing: ADEKit.inset))
          .swipeActions(edge: .leading, allowsFullSwipe: true) {
            if canChange, !account.isDefault, account.hasLogin {
              Button { makeDefault(account) } label: { Label("Default", systemImage: "star.fill") }
                .tint(ADEColor.accent)
            }
          }
          .swipeActions(edge: .trailing) {
            if canChange, !account.isDefault {
              Button(role: .destructive) { removing = account } label: { Label("Remove", systemImage: "trash") }
            }
          }
          .contextMenu { contextMenu(account) }
        }
        if canChange, store.loaded {
          Button { addPresented = true } label: {
            Label("Add \(provider.title) account", systemImage: "plus")
              .font(.system(size: 15))
              .foregroundStyle(ADEColor.accent)
          }
          .buttonStyle(.plain)
          .adeSettingsListRow()
        }
      } header: {
        ADESettingsHeader(
          store.accounts.isEmpty ? "Accounts" : "Accounts · \(store.accounts.count)",
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
    .sheet(isPresented: $addPresented) {
      ProviderAccountAddSheet(provider: provider) { label in
        guard let created = await store.create(label: label) else {
          return store.errorMessage ?? "ADE could not add the account."
        }
        addPresented = false
        try? await Task.sleep(for: .milliseconds(350))
        signIn = ProviderAccountSignInRoute(account: created)
        return nil
      }
      .presentationDetents([.medium, .large])
    }
    .sheet(item: $signIn) { route in
      ProviderAccountSignInSheet(account: route.account, host: machine.host) { email in
        signIn = nil
        toast = ADEToastMessage(text: email.map { "Signed in as \($0)" } ?? "Signed in")
        Task { await store.refreshAfterSignIn(id: route.account.id) }
      }
      .presentationDetents([.large])
    }
    .alert("Rename account", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
      TextField("Name", text: $renameText)
      Button("Cancel", role: .cancel) { renaming = nil }
      Button("Save") {
        guard let account = renaming else { return }
        let label = renameText.trimmingCharacters(in: .whitespacesAndNewlines)
        renaming = nil
        guard !label.isEmpty else { return }
        Task { await store.rename(id: account.id, label: label) }
      }
    }
    .confirmationDialog(
      "Remove \(removing?.label ?? "account")?",
      isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
      titleVisibility: .visible
    ) {
      Button("Remove", role: .destructive) {
        guard let account = removing else { return }
        removing = nil
        Task {
          if await store.remove(id: account.id) {
            toast = ADEToastMessage(text: "\(account.label) removed")
          }
        }
      }
      Button("Cancel", role: .cancel) { removing = nil }
    } message: {
      Text(providerAccountRemoveMessage(hostName: machine.name))
    }
  }

  private var balanceRow: some View {
    let enabled = store.settings?.smartBalance ?? false
    return HStack(alignment: .center, spacing: 10) {
      Image(systemName: "arrow.triangle.branch")
        .font(.system(size: 15))
        .foregroundStyle(ADEColor.textSecondary)
        .frame(width: 22)
      VStack(alignment: .leading, spacing: 2) {
        Text("Smart balance")
          .font(.system(size: 15))
          .foregroundStyle(ADEColor.textPrimary)
        Text(balanceDetail(enabled: enabled))
          .font(.system(size: 12.5))
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      Spacer(minLength: 8)
      Toggle("Smart balance", isOn: Binding(
        get: { enabled },
        set: { value in Task { await store.setSmartBalance(value) } }
      ))
      .labelsHidden()
      .tint(ADEColor.accent)
      .disabled(!canChange || store.settings == nil)
    }
    .accessibilityElement(children: .combine)
  }

  private func balanceDetail(enabled: Bool) -> String {
    let signedIn = store.accounts.filter { $0.signedIn && $0.sameLoginAs == nil }
    if enabled {
      if signedIn.count < 2 { return "Add a second signed-in account to spread chats across them." }
      if let next = store.accounts.first(where: isBalanceNext) {
        return "New chats go to the account whose weekly limit resets soonest. Next: \(next.label)."
      }
      return "New chats go to the account whose weekly limit resets soonest."
    }
    let fallback = store.accounts.first(where: \.isDefault)?.label ?? "the default"
    return "New chats use \(fallback). Running chats always keep their account."
  }

  private var footerText: String {
    "The default only changes new chats."
  }

  @ViewBuilder
  private func contextMenu(_ account: ProviderAccount) -> some View {
    if canChange {
      if !account.isDefault, account.hasLogin {
        Button { makeDefault(account) } label: { Label("Make default", systemImage: "star") }
      }
      Button { signIn = ProviderAccountSignInRoute(account: account) } label: {
        Label(account.hasLogin ? "Sign in again" : "Sign in", systemImage: "person.badge.key")
      }
      Button {
        renameText = account.label
        renaming = account
      } label: { Label("Rename", systemImage: "pencil") }
      if !account.isDefault {
        Divider()
        Button(role: .destructive) { removing = account } label: { Label("Remove", systemImage: "trash") }
      }
    }
  }

  private func makeDefault(_ account: ProviderAccount) {
    Task {
      if await store.makeDefault(id: account.id) {
        ADEHaptics.success()
        toast = ADEToastMessage(text: "\(account.label) is now the default")
      }
    }
  }

  private func isBalanceNext(_ account: ProviderAccount) -> Bool {
    guard store.settings?.smartBalance == true else { return false }
    return machine.quota?.balanceNext?.contains { $0.provider == account.provider && $0.instanceId == account.id } == true
  }

  private func ownerLabel(_ account: ProviderAccount) -> String? {
    guard let owner = account.sameLoginAs else { return nil }
    return store.account(id: owner)?.label ?? owner
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
  var isNext = false
  var busy = false

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 6) {
        if let asset = providerAssetName(account.provider) {
          ADEProviderMark(assetName: asset, size: 14)
        }
        Text(account.label)
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
        badges
        Spacer(minLength: 4)
        if busy { ProgressView().controlSize(.mini) }
      }
      Text(detailLine)
        .font(.system(size: 12.5))
        .foregroundStyle(account.loginBroken == true ? ADEColor.warning : ADEColor.textSecondary)
        .lineLimit(1)
        .truncationMode(.middle)
      if account.signedIn, !windows.isEmpty, ownerLabel == nil {
        HStack(spacing: 14) {
          ForEach(windows.prefix(2)) { window in
            ProviderAccountQuotaMeter(window: window, tint: ADEColor.providerBrand(for: account.provider))
          }
        }
        .padding(.top, 4)
      }
    }
    .accessibilityElement(children: .combine)
  }

  private var detailLine: String {
    if let ownerLabel { return "Same login as \(ownerLabel) · shares its limits" }
    return providerAccountDetailLine(account)
  }

  @ViewBuilder
  private var badges: some View {
    if account.isDefault { ADEKitTag(text: "Default", tone: .accent) }
    if isNext { ADEKitTag(text: "Next") }
    if account.loginBroken == true { ADEKitTag(text: "Signed out", tone: .warn) }
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
  var onSignIn: (ProviderAccount) -> Void = { _ in }
  @Environment(\.dismiss) private var dismiss
  @State private var renameText = ""
  @State private var renamePresented = false
  @State private var confirmRemove = false

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
  }

  private func content(_ account: ProviderAccount) -> some View {
    let windows = providerAccountWindows(account, snapshot: machine.quota)
    return ScrollView {
      VStack(alignment: .leading, spacing: ADEKit.sectionGap) {
        VStack(alignment: .leading, spacing: 14) {
          HStack(spacing: 12) {
            if let asset = providerAssetName(account.provider) {
              ADEProviderMark(assetName: asset, size: 28)
            }
            VStack(alignment: .leading, spacing: 3) {
              HStack(spacing: 6) {
                Text(account.label)
                  .font(.system(size: 18, weight: .semibold))
                  .foregroundStyle(ADEColor.textPrimary)
                if account.isDefault { ADEKitTag(text: "Default", tone: .accent) }
              }
              Text(providerAccountDetailLine(account))
                .font(.system(size: 12.5))
                .foregroundStyle(account.loginBroken == true ? ADEColor.warning : ADEColor.textSecondary)
            }
            Spacer(minLength: 0)
          }
          actionBar(account)
        }
        .adeKitCard()

        if let replaced = account.replacedAccount {
          ADESettingsNotice(
            message: "\(replaced.email) was replaced by another login outside ADE. Add it back as its own account to keep both.",
            tone: .warn,
            actionTitle: canChange ? "Dismiss" : nil,
            action: canChange ? { Task { await store.dismissReplaced(id: account.id) } } : nil
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

        ADESettingsSection("Details") {
          ADESettingsRows {
            if let plan = account.plan { ADESettingsValueRow(title: "Plan", value: plan.capitalized) }
            ADESettingsValueRow(title: "Provider", value: providerAccountProviderTitle(account))
            ADESettingsValueRow(title: "Machine", value: machine.name)
            ADESettingsValueRow(title: "Folder", value: account.configHome, mono: true)
              .textSelection(.enabled)
          }
        }

        if canChange, !account.isDefault {
          ADESettingsRows {
            ADESettingsActionRow(title: "Remove account", destructive: true) { confirmRemove = true }
          }
        }
      }
      .padding(.horizontal, 16)
      .padding(.top, 8)
      .padding(.bottom, 36)
    }
    .background(ADEColor.pageBackground.ignoresSafeArea())
    .alert("Rename account", isPresented: $renamePresented) {
      TextField("Name", text: $renameText)
      Button("Cancel", role: .cancel) {}
      Button("Save") {
        let label = renameText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !label.isEmpty else { return }
        Task { await store.rename(id: account.id, label: label) }
      }
    }
    .confirmationDialog("Remove \(account.label)?", isPresented: $confirmRemove, titleVisibility: .visible) {
      Button("Remove", role: .destructive) {
        Task {
          if await store.remove(id: account.id) { dismiss() }
        }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text(providerAccountRemoveMessage(hostName: machine.name))
    }
  }

  @ViewBuilder
  private func actionBar(_ account: ProviderAccount) -> some View {
    if canChange {
      HStack(spacing: 8) {
        if account.signedIn, !account.isDefault {
          Button("Make default") {
            Task {
              if await store.makeDefault(id: account.id) { ADEHaptics.success() }
            }
          }
          .buttonStyle(ADEKitButtonStyle(prominent: true))
        }
        Button(account.signedIn ? "Sign in again" : "Sign in") { onSignIn(account) }
          .buttonStyle(ADEKitButtonStyle(prominent: !account.signedIn))
        Button("Rename") {
          renameText = account.label
          renamePresented = true
        }
        .buttonStyle(ADEKitButtonStyle())
        Spacer(minLength: 0)
      }
      .disabled(store.busyAccountId == account.id)
    }
  }
}

// MARK: - Add

struct ProviderAccountAddSheet: View {
  let provider: ProviderAccountProvider
  /// Creates the account; returns an error message, or nil when it worked.
  let onCreate: (String) async -> String?
  @Environment(\.dismiss) private var dismiss
  @State private var label = ""
  @State private var working = false
  @State private var error: String?
  @FocusState private var focused: Bool

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          ADESettingsSection("Name", hint: "Like Work or Personal. You sign in next.") {
            TextField("Account name", text: $label)
              .font(.system(size: 15))
              .focused($focused)
              .submitLabel(.next)
              .onSubmit(create)
              .padding(.horizontal, ADEKit.inset)
              .frame(minHeight: 48)
              .adeKitCard(padding: nil)
          }
          if let error {
            ADESettingsNotice(message: error, tone: .crit)
          }
        }
        .padding(16)
      }
      .background(ADEColor.pageBackground.ignoresSafeArea())
      .navigationTitle("New \(provider.title) account")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
        ToolbarItem(placement: .confirmationAction) {
          if working {
            ProgressView()
          } else {
            Button("Next", action: create)
              .fontWeight(.semibold)
              .disabled(trimmed.isEmpty)
          }
        }
      }
      .onAppear { focused = true }
    }
  }

  private var trimmed: String { label.trimmingCharacters(in: .whitespacesAndNewlines) }

  private func create() {
    guard !trimmed.isEmpty, !working else { return }
    working = true
    error = nil
    Task {
      error = await onCreate(trimmed)
      working = false
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
        ? "\(hostName ?? "This machine") runs an ADE that cannot manage accounts from the phone yet. Update ADE there, then reconnect."
        : "AI accounts live on your computer. Connect to it from Settings to manage them here."
    ) {
      EmptyView()
    }
  }
}
