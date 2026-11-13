import SwiftUI

// The Hub's select mode, "Hide on this iPhone" and Remove…, and where each
// card's folders are: the computer each folder is on and the link a removal
// is sent on. The sheet and the pure parts live in `HubRemoveProjects.swift`.

extension HubScreen {
  /// The folders folded into a project's tile: the copies other computers
  /// show (the fleet merge's `projectLocations`), and for an account project
  /// its second folders (duplicate cards) with their own copies. The tile's
  /// long-press menu opens each on its own computer; the list has one row
  /// per project.
  func otherFolders(ofCard cardId: String, accountProject accountId: String?) -> [HubTileFolder] {
    // The tile's own folder is the tile; never list it.
    let own = cardComputer(cardId)
    var seen: Set<String> = ["\(own.key)|\(own.project.id)"]
    var folders: [HubTileFolder] = []
    // `opens`: what the tap opens; a duplicate card opens as a card, so
    // `openHubProject` finds the machine that owns it.
    func add(_ computer: HubCardComputer, machineKey: String?, opens: MobileProjectSummary) {
      let id = "\(computer.key)|\(computer.project.id)"
      guard seen.insert(id).inserted else { return }
      let name = hubFolderName(computer.project.rootPath) ?? computer.project.displayName
      folders.append(HubTileFolder(id: id, label: "\(name) on \(computer.name)", machineKey: machineKey, project: opens))
    }
    func addLocations(of id: String) {
      for location in fleetMerge.projectLocations[id] ?? [] {
        add(hubCardComputer(phoneKey: location.machineKey, project: location.project), machineKey: location.machineKey, opens: location.project)
      }
    }
    addLocations(of: cardId)
    if let accountId {
      for duplicate in duplicatePresentations where accountJoin.duplicateCardIds[duplicate.project.id] == accountId {
        add(cardComputer(duplicate.project.id), machineKey: nil, opens: duplicate.project)
        addLocations(of: duplicate.project.id)
      }
    }
    return folders
  }

  /// The cards the list shows now, under the status filter: the projects,
  /// then the local folders. Select mode ticks and acts on these only, never
  /// on a card the filter hides.
  var visibleSelectablePresentations: [HubProjectPresentation] {
    filteredHubProjectPresentations + filteredLocalSections.flatMap(\.presentations)
  }

  var selectableIds: [String] {
    visibleSelectablePresentations.map(\.project.id)
  }

  func toggleSelecting() {
    withAnimation(.easeOut(duration: 0.18)) {
      selecting.toggle()
      selectedIds = []
      if selecting { composerExpanded = false }
    }
  }

  func toggleSelection(_ id: String) {
    ADEHaptics.light()
    if selectedIds.contains(id) { selectedIds.remove(id) } else { selectedIds.insert(id) }
  }

  /// A tick the status filter now hides does not count: Select all and the
  /// bar act on the cards in view only.
  func toggleSelectAll() {
    let all = Set(selectableIds)
    selectedIds = all.isSubset(of: selectedIds) ? [] : all
  }

  /// The header's count. With the account list, the account's count: a
  /// project hidden on this phone still counts. Without it, what the
  /// computers show, hidden folders included.
  var hubListCount: Int {
    if accountProjects.governsHub { return accountProjects.liveProjects.count }
    return hubProjectPresentations.count + hiddenEntries.filter { $0.computerKey == nil }.count
  }

  var selectedPresentations: [HubProjectPresentation] {
    visibleSelectablePresentations.filter { selectedIds.contains($0.project.id) }
  }

  func removeSelected() {
    let picked = selectedPresentations
    guard !picked.isEmpty else { return }
    presentRemoval(picked)
  }

  func hideSelected() {
    let picked = selectedPresentations
    guard !picked.isEmpty else { return }
    hideOnPhone(picked)
  }

  func presentRemoval(_ presentations: [HubProjectPresentation]) {
    removalTarget = HubRemovalSheetTarget(items: presentations.map(removalItem))
  }

  /// "Hide on this iPhone": only this phone stops showing them. Nothing
  /// changes on a computer or the account. Undo or "N hidden" shows them.
  func hideOnPhone(_ presentations: [HubProjectPresentation]) {
    let items = presentations.map(removalItem)
    let keys = Set(items.map(\.hideKey))
    guard !keys.isEmpty else { return }
    hiddenList.hide(keys)
    projectOpenFailureToast = ADEToastMessage(
      text: items.count == 1 ? "Hid \(items[0].name) on this iPhone" : "Hid \(items.count) projects on this iPhone",
      kind: .success,
      action: ADEToastAction(title: "Undo") { HubPhoneHiddenList.shared.show(keys) }
    )
    endSelecting()
  }

  func handleRemovalFinish(_ text: String) {
    projectOpenFailureToast = ADEToastMessage(text: text, kind: .info)
    endSelecting()
  }

  func endSelecting() {
    guard selecting else { return }
    withAnimation(.easeOut(duration: 0.18)) {
      selecting = false
      selectedIds = []
    }
  }

  /// The computer a card's folder is on: the machine that owns an extra
  /// card, else the focused machine.
  func cardComputer(_ cardId: String, merge: HubFleetMerge? = nil) -> HubCardComputer {
    if let owner = (merge ?? fleetMerge).projectOwners[cardId] {
      return hubCardComputer(phoneKey: owner.machineKey, project: owner.project)
    }
    let focused = syncService.focusedMachineKey
    let project = syncService.projects.first { $0.id == cardId }
      ?? hubProjectPresentations.first { $0.project.id == cardId }?.project
      ?? MobileProjectSummary(id: cardId, displayName: "", laneCount: 0, isAvailable: false, isCached: false)
    return hubCardComputer(phoneKey: focused, project: project)
  }

  /// "Only on <computers>": the folders that are no account project, grouped
  /// by the reachable computers that hold them. The fleet merge folds one
  /// repository (or folder name) on two computers into one card, so that
  /// card goes under both names, never under one. A folder shows while any
  /// computer that holds it is reachable.
  func hubLocalSections(_ local: [HubProjectPresentation], merge: HubFleetMerge) -> [HubLocalSectionModel] {
    var byComputer: [String: (name: String, presentations: [HubProjectPresentation])] = [:]
    for presentation in local {
      var holders = reachableHolders(presentation.project.id, merge: merge).map { (key: $0.key, name: $0.name) }
      guard !holders.isEmpty else { continue }
      holders.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
      let key = holders.map(\.key).joined(separator: "+")
      byComputer[key, default: (hubRemovalNames(holders.map(\.name)), [])].presentations.append(presentation)
    }
    return byComputer
      .map { key, entry in
        HubLocalSectionModel(
          computerKey: key,
          computerName: entry.name,
          presentations: entry.presentations.sorted {
            $0.project.displayName.localizedCaseInsensitiveCompare($1.project.displayName) == .orderedAscending
          }
        )
      }
      .sorted { $0.computerName.localizedCaseInsensitiveCompare($1.computerName) == .orderedAscending }
  }

  /// The reachable computers that hold a card's folder: its owner first,
  /// then the other copies the fleet merge folded into it.
  func reachableHolders(_ cardId: String, merge: HubFleetMerge? = nil) -> [HubCardComputer] {
    let merge = merge ?? fleetMerge
    var holders: [HubCardComputer] = []
    let owner = cardComputer(cardId, merge: merge)
    if owner.reachable { holders.append(owner) }
    for location in merge.projectLocations[cardId] ?? [] {
      let other = hubCardComputer(phoneKey: location.machineKey, project: location.project)
      if other.reachable, !holders.contains(where: { $0.key == other.key }) {
        holders.append(other)
      }
    }
    return holders
  }

  /// The key "Hide on this iPhone" stores for a local folder. It names the
  /// computer by the phone's own key for it, which stays the same before and
  /// after the account's computer list loads.
  func hubFolderHideKey(_ computer: HubCardComputer) -> String {
    hubHiddenFolderKey(computerKey: computer.phoneKey ?? computer.key, projectId: computer.project.id)
  }

  /// Every key a hidden folder may be stored under: the stable one, and the
  /// account computer key that earlier builds stored.
  func hubFolderHideKeys(_ computer: HubCardComputer) -> [String] {
    let stable = hubFolderHideKey(computer)
    let account = hubHiddenFolderKey(computerKey: computer.key, projectId: computer.project.id)
    return stable == account ? [stable] : [stable, account]
  }

  func hubCardComputer(phoneKey: String?, project: MobileProjectSummary) -> HubCardComputer {
    let accountMachine = phoneKey.flatMap { account.machine(forFleetKey: $0) }
    let isFocused = phoneKey != nil && phoneKey == syncService.focusedMachineKey
    let name = accountMachine?.displayName
      ?? (isFocused ? syncService.focusedMachineDisplayName : phoneKey.flatMap { machineFleet.machine(for: $0)?.name })
      ?? "Another computer"
    return HubCardComputer(
      key: accountMachine?.machineKey ?? phoneKey ?? "focused",
      name: name,
      phoneKey: phoneKey,
      reachable: phoneKey.map { syncService.startOnIsLive($0) } ?? false,
      project: project
    )
  }

  func removalCopy(_ computer: HubCardComputer) -> HubRemovalCopy {
    HubRemovalCopy(
      computerKey: computer.key,
      computerName: computer.name,
      phoneKey: computer.phoneKey,
      projectId: computer.project.id,
      rootPath: computer.project.rootPath
    )
  }

  /// What Remove… acts on for one card: its folders on every computer the
  /// phone knows (the card's own, other machines' copies, second folders on
  /// the same computer, and the account's copies), each with the link it
  /// is sent on.
  func removalItem(_ presentation: HubProjectPresentation) -> HubRemovalItem {
    let cardId = presentation.project.id
    let accountOnly = accountOnlyProjects[cardId]
    let accountId = accountJoin.accountIdByCardId[cardId] ?? accountOnly?.id
    let accountProject = accountId.flatMap { accountProjectById[$0] } ?? accountOnly
    var copies: [HubRemovalCopy] = []
    var seen = Set<String>()
    func add(_ copy: HubRemovalCopy) {
      if seen.insert(copy.id).inserted { copies.append(copy) }
    }
    func addCard(_ id: String) {
      add(removalCopy(cardComputer(id)))
      for location in fleetMerge.projectLocations[id] ?? [] {
        add(removalCopy(hubCardComputer(phoneKey: location.machineKey, project: location.project)))
      }
    }
    // The folder the card shows, on a computer the phone reaches it on
    // (desktop: the tab's copy). An account-only card shows none.
    // Its owner when reachable, else another reachable computer that holds it.
    let current: HubRemovalCopy? = accountOnly == nil
      ? reachableHolders(cardId).first.map(removalCopy)
      : nil
    if accountOnly == nil { addCard(cardId) }
    if let accountId {
      for duplicate in duplicatePresentations where accountJoin.duplicateCardIds[duplicate.project.id] == accountId {
        addCard(duplicate.project.id)
      }
    }
    for copy in accountProject?.copies ?? [] {
      let machine = account.machines.first { $0.machineKey == copy.machineKey }
      add(HubRemovalCopy(
        computerKey: copy.machineKey,
        computerName: machine?.displayName ?? "A computer that left your account",
        phoneKey: machine.flatMap { syncService.startOnPhoneKey(for: $0) },
        projectId: copy.checkoutId,
        rootPath: copy.rootPath
      ))
    }
    let hideKey = accountId.map(hubHiddenAccountKey)
      ?? (accountOnly == nil ? hubFolderHideKey(cardComputer(cardId)) : nil)
      ?? "card:\(cardId)"
    return HubRemovalItem(
      id: cardId,
      name: accountProject?.name ?? presentation.project.displayName,
      accountProject: accountProject,
      current: current,
      copies: copies,
      hasRepository: accountProject != nil || gitHubIdentityByCard[cardId] != nil,
      hideKey: hideKey
    )
  }

  /// The agent page's cards: the projects, the second folders of a project,
  /// and the local folders, so every working chat shows there.
  var hubOverviewPresentations: [HubProjectPresentation] {
    hubProjectPresentations + duplicatePresentations + localSections.flatMap(\.presentations)
  }

  /// Whose hidden list loads: the account, else the machine. The account
  /// list can show before Clerk restores the session, so its owner comes
  /// first.
  var hiddenListScope: String? {
    if let userId = accountProjects.activeUserId ?? account.identity?.userId { return "account|\(userId)" }
    return syncService.focusedMachineKey.map { "machine|\($0)" }
  }
}
