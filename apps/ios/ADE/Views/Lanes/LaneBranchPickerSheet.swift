import SwiftUI

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

  var body: some View {
    NavigationStack {
      content
        .adeScreenBackground()
        .adeNavigationGlass()
        .navigationTitle("Checkout branch")
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
          "Checkout branch",
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
          Button("Checkout") {
            Task { await performCheckout(branch: branch) }
          }
        } message: { branch in
          Text("Check out '\(branch.name)'? This will switch the working tree.")
        }
    }
  }

  @ViewBuilder
  private var content: some View {
    ScrollView {
      VStack(spacing: 14) {
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
      .padding(EdgeInsets(top: 14, leading: 16, bottom: 14, trailing: 16))
    }
  }

  private var searchField: some View {
    HStack(spacing: 8) {
      Image(systemName: "magnifyingglass")
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(ADEColor.textMuted)
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
      }
    }
    .adeInsetField(cornerRadius: 12, padding: 12)
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
        GlassSection(title: "Local", subtitle: "\(filteredLocal.count) branch\(filteredLocal.count == 1 ? "" : "es")") {
          VStack(alignment: .leading, spacing: 10) {
            ForEach(filteredLocal) { branch in
              branchRow(branch)
            }
          }
        }
      }
      if !filteredRemote.isEmpty {
        GlassSection(title: "Remote", subtitle: "\(filteredRemote.count) branch\(filteredRemote.count == 1 ? "" : "es")") {
          VStack(alignment: .leading, spacing: 10) {
            ForEach(filteredRemote) { branch in
              branchRow(branch)
            }
          }
        }
      }
    }
  }

  private func branchRow(_ branch: GitBranchSummary) -> some View {
    Button {
      guard !checkingOut else { return }
      pendingBranch = branch
    } label: {
      HStack(spacing: 10) {
        Image(systemName: "arrow.triangle.branch")
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(ADEColor.tintLanes)
          .frame(width: 22)
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
          }
        }
        Spacer(minLength: 8)
        if isCurrent(branch) {
          LaneMicroChip(icon: "checkmark", text: "Current", tint: ADEColor.success)
        }
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(checkingOut || isCurrent(branch))
    .adeGlassCard(cornerRadius: 12, padding: 12)
    .opacity(isCurrent(branch) ? 0.7 : 1.0)
  }

  private func errorCard(_ message: String) -> some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: "exclamationmark.triangle.fill")
        .font(.system(size: 14, weight: .semibold))
        .foregroundStyle(ADEColor.danger)
      Text(message)
        .font(.footnote)
        .foregroundStyle(ADEColor.textPrimary)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .adeGlassCard(cornerRadius: 12, padding: 12)
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

  @MainActor
  private func loadBranches() async {
    loading = true
    errorMessage = nil
    do {
      let result = try await syncService.listBranches(laneId: laneId)
      branches = result
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
    loading = false
  }

  @MainActor
  private func performCheckout(branch: GitBranchSummary) async {
    pendingBranch = nil
    checkingOut = true
    errorMessage = nil
    do {
      try await syncService.checkoutPrimaryBranch(laneId: laneId, branchName: branch.name)
      await onComplete()
      dismiss()
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
    checkingOut = false
  }
}
