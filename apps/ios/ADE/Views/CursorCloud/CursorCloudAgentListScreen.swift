import SwiftUI

/// Navigation targets inside the Cursor Cloud pane's stack.
enum CursorCloudRoute: Hashable {
  case agent(CursorCloudFleetEntry)
}

/// The Cursor Cloud pane's root screen: grouped fleet list with status/lane
/// filters, pull-to-refresh, and honest loading / failure / empty / connect
/// states. Mirrors `LinearIssueListScreen` structurally.
struct CursorCloudAgentListScreen: View {
  @ObservedObject var store: CursorCloudPaneStore
  var onClose: () -> Void = {}

  private enum ListContent { case skeletons, failure(String), connectPrompt, empty, agents }

  private var contentMode: ListContent {
    if store.keyMissing { return .connectPrompt }
    if !store.visibleEntries.isEmpty { return .agents }
    switch store.phase {
    case .idle, .loading: return .skeletons
    case .failed(let message): return .failure(message)
    case .loaded: return .empty
    }
  }

  var body: some View {
    List {
      switch contentMode {
      case .skeletons:
        skeletons
      case .failure(let message):
        failureCard(message)
      case .connectPrompt:
        connectPrompt
      case .empty:
        emptyState
      case .agents:
        agentSections
      }
    }
    .listStyle(.plain)
    .scrollContentBackground(.hidden)
    .safeAreaInset(edge: .top, spacing: 0) {
      CursorCloudFilterChipsBar(store: store)
    }
    .refreshable {
      await store.reload()
    }
    .task { await store.reload() }
    .navigationTitle("Cursor Cloud")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .topBarLeading) {
        Button { onClose() } label: {
          Image(systemName: "xmark").font(.system(size: 13, weight: .semibold))
        }
        .accessibilityLabel("Close Cursor Cloud")
      }
      ToolbarItem(placement: .topBarTrailing) {
        if !store.relayLive {
          Image(systemName: "clock.arrow.circlepath")
            .font(.system(size: 12))
            .foregroundStyle(.secondary)
            .accessibilityLabel("Live updates not configured; list shows last refresh")
        }
      }
    }
  }

  // MARK: Sections

  @ViewBuilder
  private var agentSections: some View {
    ForEach(store.groupedSections) { group in
      Section {
        ForEach(group.entries) { entry in
          NavigationLink(value: CursorCloudRoute.agent(entry)) {
            CursorCloudAgentRow(entry: entry)
          }
          .listRowBackground(Color.clear)
        }
      } header: {
        CursorCloudGroupHeader(group: group)
      }
    }
    if !store.relayLive {
      Section {
        Text("Live updates aren't configured on your machine yet — pull to refresh.")
          .font(.caption)
          .foregroundStyle(.secondary)
          .listRowBackground(Color.clear)
      }
    }
  }

  private var skeletons: some View {
    Section {
      ForEach(0..<4, id: \.self) { _ in
        VStack(alignment: .leading, spacing: 8) {
          RoundedRectangle(cornerRadius: 4)
            .fill(Color.white.opacity(0.08))
            .frame(width: 180, height: 12)
          RoundedRectangle(cornerRadius: 4)
            .fill(Color.white.opacity(0.05))
            .frame(width: 120, height: 10)
        }
        .listRowBackground(Color.clear)
      }
    }
  }

  private func failureCard(_ message: String) -> some View {
    Section {
      VStack(spacing: 12) {
        Image(systemName: "exclamationmark.triangle")
          .font(.system(size: 22))
          .foregroundStyle(.orange)
        Text("Couldn't load cloud agents")
          .font(.headline)
        Text(message)
          .font(.caption)
          .foregroundStyle(.secondary)
          .multilineTextAlignment(.center)
        Button("Retry") {
          Task { await store.reload() }
        }
        .buttonStyle(.borderedProminent)
        .tint(CursorCloudBrand.primary)
      }
      .frame(maxWidth: .infinity)
      .padding(.vertical, 24)
      .listRowBackground(Color.clear)
    }
  }

  private var connectPrompt: some View {
    Section {
      VStack(spacing: 12) {
        CursorCloudMark(size: 28)
        Text("Connect Cursor first")
          .font(.headline)
        Text("Add a Cursor API key or log in via Settings → AI connections on your machine, then come back.")
          .font(.caption)
          .foregroundStyle(.secondary)
          .multilineTextAlignment(.center)
      }
      .frame(maxWidth: .infinity)
      .padding(.vertical, 24)
      .listRowBackground(Color.clear)
    }
  }

  private var emptyState: some View {
    Section {
      VStack(spacing: 10) {
        CursorCloudMark(size: 26)
        Text("No cloud agents for this project")
          .font(.headline)
        Text("Agents launched from a chat composer with a Cursor model — and anything running for this repo on cursor.com — will appear here.")
          .font(.caption)
          .foregroundStyle(.secondary)
          .multilineTextAlignment(.center)
      }
      .frame(maxWidth: .infinity)
      .padding(.vertical, 24)
      .listRowBackground(Color.clear)
    }
  }
}

// MARK: - Rows & chrome

struct CursorCloudGroupHeader: View {
  let group: CursorCloudAgentGroup

  var body: some View {
    HStack(spacing: 6) {
      if group.id == "active" {
        Circle()
          .fill(CursorCloudBrand.primaryBright)
          .frame(width: 6, height: 6)
      }
      Text(group.title.uppercased())
        .font(.caption2.weight(.semibold))
        .foregroundStyle(.secondary)
      if let issue = group.issueIdentifier {
        Text(issue)
          .font(.caption2.weight(.medium))
          .foregroundStyle(CursorCloudBrand.primaryBright)
      }
      Text("\(group.entries.count)")
        .font(.caption2.monospacedDigit())
        .foregroundStyle(.tertiary)
    }
  }
}

struct CursorCloudStatusChip: View {
  let status: String

  private var tint: Color {
    switch status {
    case "running": return CursorCloudBrand.primaryBright
    case "creating": return Color(red: 0.49, green: 0.83, blue: 0.99)
    case "finished": return .green
    case "error", "expired": return .red
    default: return .secondary
    }
  }

  var body: some View {
    Text(status.uppercased())
      .font(.system(size: 9, weight: .bold, design: .monospaced))
      .tracking(1)
      .foregroundStyle(tint)
      .padding(.horizontal, 5)
      .padding(.vertical, 2)
      .overlay(
        Capsule().strokeBorder(tint.opacity(0.35), lineWidth: 1)
      )
  }
}

struct CursorCloudAgentRow: View {
  let entry: CursorCloudFleetEntry

  var body: some View {
    VStack(alignment: .leading, spacing: 5) {
      HStack(spacing: 8) {
        Text(entry.agent.name.isEmpty ? String(entry.agent.agentId.prefix(12)) : entry.agent.name)
          .font(.subheadline.weight(.semibold))
          .lineLimit(1)
        CursorCloudStatusChip(status: entry.displayStatus)
        Spacer(minLength: 4)
        if let age = cursorCloudRelativeAge(entry.agent.lastActivityDate) {
          Text(age)
            .font(.caption2.monospacedDigit())
            .foregroundStyle(.tertiary)
        }
      }
      HStack(spacing: 8) {
        if let branch = entry.branch {
          Label(branch, systemImage: "arrow.triangle.branch")
            .lineLimit(1)
        } else if let repo = entry.agent.repos?.first {
          Text(repo).lineLimit(1)
        }
        if let lane = entry.ownership.laneName {
          Text(lane)
            .lineLimit(1)
            .foregroundStyle(.secondary)
        }
        Spacer(minLength: 0)
      }
      .font(.caption2)
      .foregroundStyle(.secondary)
    }
    .padding(.vertical, 2)
  }
}

struct CursorCloudFilterChipsBar: View {
  @ObservedObject var store: CursorCloudPaneStore

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 6) {
        ForEach(CursorCloudStatusPreset.allCases) { preset in
          chip(title: preset.title, selected: store.statusPreset == preset) {
            store.statusPreset = preset
          }
        }
        Divider().frame(height: 14)
        chip(title: "All lanes", selected: store.laneFilterId == nil) {
          store.laneFilterId = nil
        }
        ForEach(store.laneOptions, id: \.id) { lane in
          chip(title: lane.name, selected: store.laneFilterId == lane.id) {
            store.laneFilterId = lane.id
          }
        }
        Divider().frame(height: 14)
        chip(title: store.showArchived ? "Archived ✓" : "Archived", selected: store.showArchived) {
          store.showArchived.toggle()
        }
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 7)
    }
    .background(.ultraThinMaterial)
  }

  private func chip(title: String, selected: Bool, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Text(title)
        .font(.caption.weight(selected ? .semibold : .regular))
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(
          Capsule().fill(selected ? CursorCloudBrand.primary.opacity(0.25) : Color.white.opacity(0.06))
        )
        .overlay(
          Capsule().strokeBorder(selected ? CursorCloudBrand.primaryBright.opacity(0.55) : Color.clear, lineWidth: 1)
        )
        .foregroundStyle(selected ? CursorCloudBrand.primaryBright : Color.secondary)
    }
    .buttonStyle(.plain)
  }
}
