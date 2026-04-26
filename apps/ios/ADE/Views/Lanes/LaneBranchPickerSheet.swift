import SwiftUI

private struct PendingBranchSwitch: Identifiable {
  let id = UUID()
  let branchName: String
  let mode: String
  let startPoint: String?
  let baseRef: String?
  let activeWork: [LaneBranchActiveWorkItem]
}

private struct StartPointOption: Identifiable, Hashable {
  enum Kind { case currentLane, local, remote }
  let id: String
  let value: String
  let label: String
  let detail: String?
  let kind: Kind
}

struct LaneBranchPickerSheet: View {
  @Environment(\.dismiss) private var dismiss
  @EnvironmentObject private var syncService: SyncService

  let laneId: String
  let branchRef: String
  let onComplete: @MainActor () async -> Void

  @State private var branches: [GitBranchSummary] = []
  @State private var query: String = ""
  @State private var loading = true
  @State private var errorMessage: String?
  @State private var pendingBranch: GitBranchSummary?
  @State private var checkingOut = false
  @State private var createBranchName = ""
  @State private var createStartPoint = ""
  @State private var createBaseRef = ""
  @State private var confirmingCreateBranch = false
  @State private var pendingActiveWorkSwitch: PendingBranchSwitch?

  var body: some View {
    NavigationStack {
      content
        .adeScreenBackground()
        .adeNavigationGlass()
        .navigationTitle("Switch branch")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("Cancel") { dismiss() }
              .disabled(checkingOut)
          }
        }
        .task {
          await loadBranches()
        }
        .alert(
          "Switch branch",
          isPresented: Binding(
            get: { pendingBranch != nil },
            set: { newValue in
              if !newValue { pendingBranch = nil }
            }
          ),
          presenting: pendingBranch
        ) { branch in
          Button("Cancel", role: .cancel) {
            pendingBranch = nil
          }
          Button("Switch") {
            Task { await prepareCheckout(branch: branch) }
          }
        } message: { branch in
          Text("Switch this lane to '\(branch.name)'? Running terminals and processes stay attached to this lane and continue on the new branch's worktree.")
        }
        .alert("Create branch", isPresented: $confirmingCreateBranch) {
          Button("Cancel", role: .cancel) {}
          Button("Create") {
            Task { await prepareCreateBranch() }
          }
        } message: {
          Text("Create '\(normalizedCreateName)' from '\(selectedCreateStartPoint)'. ADE will compare this lane against '\(selectedCreateBaseRef)' for rebase and merge readiness.")
        }
        .alert(
          "Active work in this lane",
          isPresented: Binding(
            get: { pendingActiveWorkSwitch != nil },
            set: { newValue in
              if !newValue { pendingActiveWorkSwitch = nil }
            }
          ),
          presenting: pendingActiveWorkSwitch
        ) { pending in
          Button("Cancel", role: .cancel) {
            pendingActiveWorkSwitch = nil
          }
          Button("Switch") {
            Task { await executeSwitch(pending, acknowledgeActiveWork: true) }
          }
        } message: { pending in
          Text("These will keep running on '\(pending.branchName)':\n\(activeWorkSummary(pending.activeWork))")
        }
    }
  }

  @ViewBuilder
  private var content: some View {
    ScrollView {
      VStack(spacing: 14) {
        currentBranchCard
        createBranchCard
        searchField
        if let errorMessage {
          errorCard(errorMessage)
        }
        if loading {
          ProgressView()
            .progressViewStyle(.circular)
            .padding(.top, 24)
            .frame(maxWidth: .infinity)
        } else {
          branchSections
        }
      }
      .padding(EdgeInsets(top: 14, leading: 16, bottom: 24, trailing: 16))
    }
  }

  private var currentBranchCard: some View {
    HStack(spacing: 10) {
      Image(systemName: "arrow.triangle.branch")
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(ADEColor.tintLanes)
        .frame(width: 22)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 2) {
        Text("On this lane")
          .font(.caption2.weight(.semibold))
          .foregroundStyle(ADEColor.textMuted)
          .textCase(.uppercase)
        Text(branchRef)
          .font(.system(.body, design: .monospaced))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
          .truncationMode(.middle)
      }
      Spacer(minLength: 8)
    }
    .adeGlassCard(cornerRadius: 12, padding: 12)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Currently on \(branchRef)")
  }

  private var searchField: some View {
    HStack(spacing: 8) {
      Image(systemName: "magnifyingglass")
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(ADEColor.textMuted)
        .accessibilityHidden(true)
      TextField("Filter branches", text: $query)
        .textFieldStyle(.plain)
        .autocorrectionDisabled(true)
        .textInputAutocapitalization(.never)
        .font(.system(.body, design: .monospaced))
      if !query.isEmpty {
        Button {
          query = ""
        } label: {
          Image(systemName: "xmark.circle.fill")
            .font(.system(size: 14))
            .foregroundStyle(ADEColor.textMuted)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Clear filter")
      }
    }
    .adeInsetField(cornerRadius: 12, padding: 12)
  }

  private var createBranchCard: some View {
    GlassSection(title: "New branch", subtitle: "Create a branch and switch this lane to it.") {
      VStack(alignment: .leading, spacing: 12) {
        HStack(spacing: 8) {
          Image(systemName: "plus")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(ADEColor.tintLanes)
            .accessibilityHidden(true)
          TextField("feature/short-name", text: $createBranchName)
            .textFieldStyle(.plain)
            .autocorrectionDisabled(true)
            .textInputAutocapitalization(.never)
            .font(.system(.body, design: .monospaced))
        }
        .adeInsetField(cornerRadius: 12, padding: 12)
        .overlay(
          RoundedRectangle(cornerRadius: 12, style: .continuous)
            .stroke(branchNameValidationReason == nil ? Color.clear : ADEColor.danger.opacity(0.55), lineWidth: 0.75)
        )

        if let reason = branchNameValidationReason {
          HStack(spacing: 6) {
            Image(systemName: "exclamationmark.circle.fill")
              .font(.system(size: 11, weight: .semibold))
              .foregroundStyle(ADEColor.danger)
              .accessibilityHidden(true)
            Text(reason)
              .font(.caption)
              .foregroundStyle(ADEColor.danger)
          }
          .accessibilityElement(children: .combine)
        }

        VStack(alignment: .leading, spacing: 10) {
          startPointPickerRow(
            title: "Start from",
            subtitle: "The commit your new branch is forked from.",
            selection: Binding(
              get: { selectedCreateStartPoint },
              set: { createStartPoint = $0 }
            )
          )
          baseRefPickerRow(
            title: "Rebase base",
            subtitle: "What ADE compares this lane against for rebase and merge readiness.",
            selection: Binding(
              get: { selectedCreateBaseRef },
              set: { createBaseRef = $0 }
            )
          )
        }

        Button {
          guard !checkingOut, branchNameValidationReason == nil, !normalizedCreateName.isEmpty else { return }
          confirmingCreateBranch = true
        } label: {
          HStack(spacing: 8) {
            Image(systemName: "plus")
              .font(.system(size: 12, weight: .semibold))
            Text("Create in this lane")
              .font(.subheadline.weight(.semibold))
            Spacer()
          }
          .foregroundStyle(ADEColor.textPrimary)
          .padding(EdgeInsets(top: 12, leading: 12, bottom: 12, trailing: 12))
          .background(ADEColor.tintLanes.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
          .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
              .stroke(ADEColor.tintLanes.opacity(0.24), lineWidth: 0.5)
          )
        }
        .buttonStyle(.plain)
        .disabled(checkingOut || normalizedCreateName.isEmpty || branchNameValidationReason != nil)
        .opacity(canCreateBranch ? 1 : 0.5)
      }
    }
  }

  private func startPointPickerRow(title: String, subtitle: String, selection: Binding<String>) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 10) {
        Text(title)
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textSecondary)
        Spacer(minLength: 8)
        Picker(title, selection: selection) {
          ForEach(startPointOptions) { option in
            Text(option.label).tag(option.value)
          }
        }
        .pickerStyle(.menu)
        .tint(ADEColor.textPrimary)
        .labelsHidden()
        .frame(maxWidth: 220, alignment: .trailing)
      }
      Text(subtitle)
        .font(.caption2)
        .foregroundStyle(ADEColor.textMuted)
    }
    .padding(EdgeInsets(top: 10, leading: 12, bottom: 10, trailing: 12))
    .background(ADEColor.surfaceBackground.opacity(0.22), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .stroke(ADEColor.border.opacity(0.12), lineWidth: 0.5)
    )
  }

  private func baseRefPickerRow(title: String, subtitle: String, selection: Binding<String>) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 10) {
        Text(title)
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textSecondary)
        Spacer(minLength: 8)
        Picker(title, selection: selection) {
          ForEach(baseRefOptions, id: \.self) { name in
            Text(name).tag(name)
          }
        }
        .pickerStyle(.menu)
        .tint(ADEColor.textPrimary)
        .labelsHidden()
        .frame(maxWidth: 220, alignment: .trailing)
      }
      Text(subtitle)
        .font(.caption2)
        .foregroundStyle(ADEColor.textMuted)
    }
    .padding(EdgeInsets(top: 10, leading: 12, bottom: 10, trailing: 12))
    .background(ADEColor.surfaceBackground.opacity(0.22), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .stroke(ADEColor.border.opacity(0.12), lineWidth: 0.5)
    )
  }

  @ViewBuilder
  private var branchSections: some View {
    let filteredLocal = filtered(branches.filter { isLocal($0) })
    let filteredRemote = filtered(branches.filter { !isLocal($0) })

    if branches.isEmpty {
      ADEEmptyStateView(
        symbol: "arrow.triangle.branch",
        title: "No branches",
        message: "This lane has no branches to choose from."
      )
    } else if filteredLocal.isEmpty && filteredRemote.isEmpty {
      Text("No branches match '\(query)'")
        .font(.footnote)
        .foregroundStyle(ADEColor.textMuted)
        .frame(maxWidth: .infinity, alignment: .center)
        .padding(.vertical, 18)
    } else {
      if !filteredLocal.isEmpty {
        GlassSection(title: "Local", subtitle: branchSectionSubtitle(filteredLocal.count)) {
          VStack(alignment: .leading, spacing: 8) {
            ForEach(filteredLocal) { branch in
              branchRow(branch)
            }
          }
        }
      }
      if !filteredRemote.isEmpty {
        GlassSection(title: "Remote", subtitle: branchSectionSubtitle(filteredRemote.count)) {
          VStack(alignment: .leading, spacing: 8) {
            ForEach(filteredRemote) { branch in
              branchRow(branch)
            }
          }
        }
      }
    }
  }

  private func branchSectionSubtitle(_ count: Int) -> String {
    "\(count) branch\(count == 1 ? "" : "es")"
  }

  private func branchRow(_ branch: GitBranchSummary) -> some View {
    let owner = (branch.ownedByLaneName ?? "").isEmpty ? nil : branch.ownedByLaneName
    let isOwned = owner != nil
    let current = isCurrent(branch)
    let isDisabled = checkingOut || current || isOwned
    return Button {
      guard !checkingOut else { return }
      if let owner {
        errorMessage = "Branch '\(branch.name)' is already active in \(owner). Switch to that lane instead."
        return
      }
      pendingBranch = branch
    } label: {
      HStack(spacing: 10) {
        Image(systemName: branch.isRemote ? "arrow.down.circle" : "arrow.triangle.branch")
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(branch.isRemote ? ADEColor.info : ADEColor.tintLanes)
          .frame(width: 22)
          .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 2) {
          Text(branch.name)
            .font(.system(.body, design: .monospaced))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
            .truncationMode(.middle)
          if let upstream = branch.upstream, !upstream.isEmpty {
            Text(upstream)
              .font(.caption2)
              .foregroundStyle(ADEColor.textMuted)
              .lineLimit(1)
              .truncationMode(.middle)
          } else if branch.isRemote {
            Text("Will create local copy on switch")
              .font(.caption2)
              .foregroundStyle(ADEColor.textMuted.opacity(0.7))
          }
        }
        Spacer(minLength: 8)
        if current {
          LaneMicroChip(icon: "checkmark", text: "Current", tint: ADEColor.success)
        } else if let owner {
          LaneMicroChip(icon: "lock", text: owner, tint: ADEColor.warning)
        } else if branch.profiledInCurrentLane == true {
          LaneMicroChip(icon: "clock", text: "Used here", tint: ADEColor.textMuted)
        }
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(isDisabled)
    .adeGlassCard(cornerRadius: 12, padding: 12)
    .opacity(current ? 0.7 : (isOwned ? 0.55 : 1.0))
    .accessibilityElement(children: .combine)
    .accessibilityLabel(accessibilityLabel(for: branch, owner: owner, current: current))
    .accessibilityHint(accessibilityHint(for: branch, owner: owner, current: current))
  }

  private func errorCard(_ message: String) -> some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: "exclamationmark.triangle.fill")
        .font(.system(size: 14, weight: .semibold))
        .foregroundStyle(ADEColor.danger)
        .accessibilityHidden(true)
      Text(message)
        .font(.footnote)
        .foregroundStyle(ADEColor.textPrimary)
        .frame(maxWidth: .infinity, alignment: .leading)
      Button {
        errorMessage = nil
      } label: {
        Image(systemName: "xmark")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(ADEColor.textMuted)
          .padding(6)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Dismiss error")
    }
    .adeGlassCard(cornerRadius: 12, padding: 12)
  }

  private func accessibilityLabel(for branch: GitBranchSummary, owner: String?, current: Bool) -> String {
    var parts: [String] = [branch.name]
    parts.append(branch.isRemote ? "remote branch" : "local branch")
    if current { parts.append("current") }
    if let owner { parts.append("owned by \(owner)") }
    return parts.joined(separator: ", ")
  }

  private func accessibilityHint(for branch: GitBranchSummary, owner: String?, current: Bool) -> String {
    if current { return "This is the lane's current branch." }
    if let owner { return "Already active in \(owner)." }
    return "Switch this lane to \(branch.name)."
  }

  private func isLocal(_ branch: GitBranchSummary) -> Bool {
    if branch.isRemote { return false }
    if branch.name.hasPrefix("origin/") || branch.name.hasPrefix("refs/remotes/") {
      return false
    }
    return true
  }

  private func isCurrent(_ branch: GitBranchSummary) -> Bool {
    branch.isCurrent || branch.name == branchRef
  }

  private func filtered(_ list: [GitBranchSummary]) -> [GitBranchSummary] {
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return list }
    let needle = trimmed.lowercased()
    return list.filter { $0.name.lowercased().contains(needle) }
  }

  private static func stripRemotePrefix(_ name: String) -> String {
    if name.hasPrefix("refs/remotes/") {
      let rest = String(name.dropFirst("refs/remotes/".count))
      if let slash = rest.firstIndex(of: "/") {
        return String(rest[rest.index(after: slash)...])
      }
      return rest
    }
    if let slash = name.firstIndex(of: "/"), slash != name.startIndex, name.index(after: slash) != name.endIndex {
      return String(name[name.index(after: slash)...])
    }
    return name
  }

  private var startPointOptions: [StartPointOption] {
    var seenValues = Set<String>()
    var seenLocalNames = Set<String>()
    var options: [StartPointOption] = []

    let currentOption = StartPointOption(
      id: "lane:\(branchRef)",
      value: branchRef,
      label: branchRef,
      detail: "current",
      kind: .currentLane
    )
    options.append(currentOption)
    seenValues.insert(branchRef)
    seenLocalNames.insert(branchRef)

    for branch in branches where isLocal(branch) {
      if seenValues.contains(branch.name) { continue }
      seenValues.insert(branch.name)
      seenLocalNames.insert(branch.name)
      options.append(StartPointOption(id: "local:\(branch.name)", value: branch.name, label: branch.name, detail: nil, kind: .local))
    }
    for branch in branches where !isLocal(branch) {
      let stripped = Self.stripRemotePrefix(branch.name)
      if seenLocalNames.contains(stripped) { continue }
      if seenValues.contains(branch.name) { continue }
      seenValues.insert(branch.name)
      options.append(StartPointOption(id: "remote:\(branch.name)", value: branch.name, label: "\(stripped) (remote)", detail: branch.name, kind: .remote))
    }
    return options.sorted { $0.label.localizedCaseInsensitiveCompare($1.label) == .orderedAscending }
  }

  private var baseRefOptions: [String] {
    var names = Set<String>()
    names.insert(branchRef)
    for branch in branches where isLocal(branch) { names.insert(branch.name) }
    return names.sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
  }

  private var normalizedCreateName: String {
    createBranchName.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private var branchNameValidationReason: String? {
    let name = normalizedCreateName
    guard !name.isEmpty else { return nil }
    return Self.validateBranchName(name)
  }

  private var canCreateBranch: Bool {
    !checkingOut && !normalizedCreateName.isEmpty && branchNameValidationReason == nil
  }

  private var selectedCreateStartPoint: String {
    if !createStartPoint.isEmpty { return createStartPoint }
    return branchRef
  }

  private var selectedCreateBaseRef: String {
    if !createBaseRef.isEmpty { return createBaseRef }
    return branchRef
  }

  static func validateBranchName(_ name: String) -> String? {
    if name.isEmpty { return "Branch name is required." }
    if name.count > 200 { return "Branch name is too long." }
    if name.hasPrefix("-") { return "Cannot start with '-'." }
    if name.hasPrefix("/") || name.hasSuffix("/") { return "Cannot start or end with '/'." }
    if name.hasSuffix(".") { return "Cannot end with '.'." }
    if name.hasSuffix(".lock") { return "Cannot end with '.lock'." }
    if name.contains("..") { return "Cannot contain '..'." }
    if name.contains("//") { return "Cannot contain '//'." }
    if name.contains("@{") { return "Cannot contain '@{'." }
    let illegal: Set<Character> = ["~", "^", ":", "?", "*", "[", "\\", " ", "\t", "\n"]
    if name.contains(where: { illegal.contains($0) }) {
      return "Cannot contain spaces or any of: ~ ^ : ? * [ \\."
    }
    if name.contains(where: { $0.asciiValue.map { $0 < 0x20 || $0 == 0x7f } ?? false }) {
      return "Cannot contain control characters."
    }
    for segment in name.split(separator: "/", omittingEmptySubsequences: false) {
      if segment.isEmpty { return "Cannot contain empty path segments." }
      if segment.hasPrefix(".") { return "Path segments cannot start with '.'." }
      if segment.hasSuffix(".lock") { return "Path segments cannot end with '.lock'." }
    }
    return nil
  }

  @MainActor
  private func loadBranches() async {
    loading = true
    errorMessage = nil
    do {
      let result = try await syncService.listBranches(laneId: laneId)
      branches = result
      if createStartPoint.isEmpty { createStartPoint = branchRef }
      if createBaseRef.isEmpty { createBaseRef = branchRef }
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
    loading = false
  }

  @MainActor
  private func prepareCheckout(branch: GitBranchSummary) async {
    pendingBranch = nil
    await prepareSwitch(
      branchName: branch.name,
      mode: "existing",
      startPoint: nil,
      baseRef: nil
    )
  }

  @MainActor
  private func prepareCreateBranch() async {
    confirmingCreateBranch = false
    let branchName = normalizedCreateName
    guard !branchName.isEmpty else { return }
    if let reason = Self.validateBranchName(branchName) {
      errorMessage = reason
      return
    }
    await prepareSwitch(
      branchName: branchName,
      mode: "create",
      startPoint: selectedCreateStartPoint,
      baseRef: selectedCreateBaseRef
    )
  }

  @MainActor
  private func prepareSwitch(branchName: String, mode: String, startPoint: String?, baseRef: String?) async {
    checkingOut = true
    errorMessage = nil
    do {
      let preview = try await syncService.previewBranchSwitch(
        laneId: laneId,
        branchName: branchName,
        mode: mode,
        startPoint: startPoint,
        baseRef: baseRef
      )
      if let duplicateLaneName = preview.duplicateLaneName {
        errorMessage = "Branch '\(preview.targetBranchRef)' is already active in \(duplicateLaneName)."
        checkingOut = false
        return
      }
      if preview.dirty {
        errorMessage = "This lane has uncommitted changes. Commit or stash them before switching branches."
        checkingOut = false
        return
      }
      if !preview.activeWork.isEmpty {
        pendingActiveWorkSwitch = PendingBranchSwitch(
          branchName: branchName,
          mode: mode,
          startPoint: startPoint,
          baseRef: baseRef,
          activeWork: preview.activeWork
        )
        checkingOut = false
        return
      }
      await executeSwitch(
        PendingBranchSwitch(branchName: branchName, mode: mode, startPoint: startPoint, baseRef: baseRef, activeWork: []),
        acknowledgeActiveWork: false
      )
      return
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
    checkingOut = false
  }

  @MainActor
  private func executeSwitch(_ pending: PendingBranchSwitch, acknowledgeActiveWork: Bool) async {
    pendingActiveWorkSwitch = nil
    checkingOut = true
    errorMessage = nil
    do {
      try await syncService.checkoutPrimaryBranch(
        laneId: laneId,
        branchName: pending.branchName,
        mode: pending.mode,
        startPoint: pending.startPoint,
        baseRef: pending.baseRef,
        acknowledgeActiveWork: acknowledgeActiveWork
      )
      await onComplete()
      dismiss()
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
    checkingOut = false
  }

  private func activeWorkSummary(_ activeWork: [LaneBranchActiveWorkItem]) -> String {
    let visible = activeWork.prefix(4)
    var lines = visible.map { item -> String in
      let label = item.kind == "terminal" ? "Terminal" : "Process"
      return "\(label): \(item.title)"
    }
    let extra = activeWork.count - visible.count
    if extra > 0 {
      lines.append("+ \(extra) more")
    }
    return lines.joined(separator: "\n")
  }
}
