import SwiftUI

/// The Browser sheet's "Dev servers" card: the lane's running dev servers,
/// each with Open (or Watch, when the lane already has a tab on it). Opening
/// one puts the page in a background tab of the desktop browser on the lane's
/// machine, and the sheet then watches that tab. A desktop on another computer
/// may take it instead (no desktop on the lane's machine); then the card can
/// only say where it opened.
struct WorkToolsDevServersCard: View {
  let laneId: String
  let servers: [WorkToolsDevServer]
  /// The lane's open tabs, to tell Open from Watch.
  let tabs: [WorkToolsBrowserTab]
  /// The last fresh read failed (the list may be empty only because of it).
  let loadFailed: Bool
  /// False for a read-only viewer: the rows show no Open.
  let canOpen: Bool
  /// A DEBUG fixture: Open watches the fixture's tab on that port instead.
  let isFixture: Bool
  let open: @MainActor (WorkToolsDevServer) async throws -> WorkToolsOpenedBrowserTab
  /// Watches a tab in the sheet's live picture.
  let watch: @MainActor (String) async -> Void

  /// The server whose Open is on its way to the desktop.
  @State private var openingId: String?
  /// One line under the list after an open the phone cannot watch.
  @State private var notice: String?
  @State private var openError: String?

  var body: some View {
    ADEKitCard(title: "Dev servers", count: servers.isEmpty ? nil : "\(servers.count)") {
      VStack(alignment: .leading, spacing: 10) {
        if servers.isEmpty {
          Text(loadFailed
            ? "Couldn't load this lane's dev servers. Pull down to try again."
            : "No dev servers are running in this lane.")
            .font(.footnote)
            .foregroundStyle(ADEColor.textSecondary)
            .frame(maxWidth: .infinity, alignment: .leading)
        } else {
          ForEach(servers) { server in
            WorkToolsDevServerRow(
              server: server,
              hasTab: tab(on: server) != nil,
              isOpening: openingId == server.id,
              onOpen: canOpen ? { openServer(server) } : nil
            )
            .disabled(openingId != nil && openingId != server.id)
          }
        }
        if let notice {
          Text(notice)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
      }
    }
    .alert(
      "Couldn't open the page",
      isPresented: Binding(get: { openError != nil }, set: { if !$0 { openError = nil } }),
      actions: { Button("OK", role: .cancel) { openError = nil } },
      message: { Text(openError ?? "") }
    )
  }

  private func tab(on server: WorkToolsDevServer) -> WorkToolsBrowserTab? {
    tabs.first { workToolsLoopbackPort($0.url) == server.port }
  }

  private func openServer(_ server: WorkToolsDevServer) {
    guard openingId == nil else { return }
    ADEHaptics.light()
    notice = nil
    if isFixture {
      if let tab = tab(on: server) { Task { await watch(tab.id) } }
      return
    }
    openingId = server.id
    let laneId = laneId
    Task { @MainActor in
      defer { openingId = nil }
      do {
        let opened = try await open(server)
        guard laneId == self.laneId else { return }
        if let tabId = opened.tabId {
          await watch(tabId)
        } else if let desktop = opened.openedOn {
          notice = opened.awaitingApproval == true
            ? "Sent to ADE on \(desktop). Allow it there to load the page."
            : "Opened in ADE on \(desktop). Watch it from there."
        } else {
          notice = "Opened in ADE on another computer."
        }
      } catch {
        guard laneId == self.laneId else { return }
        openError = error.localizedDescription
      }
    }
  }
}

/// One dev server: its port, its address, and Open (or Watch, when the lane
/// already has a tab on it). The address truncates in the middle so the port
/// and path both stay readable on a narrow phone.
private struct WorkToolsDevServerRow: View {
  let server: WorkToolsDevServer
  var hasTab = false
  var isOpening = false
  /// Nil when this phone may not open pages (a read-only viewer).
  var onOpen: (() -> Void)?

  var body: some View {
    HStack(alignment: .center, spacing: 10) {
      Text(verbatim: ":\(server.port)")
        .font(.adeMono(12, weight: .semibold))
        .foregroundStyle(ADEColor.textPrimary)
        .padding(.horizontal, 7)
        .padding(.vertical, 4)
        .background(ADEKit.track, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        .fixedSize()
      Text(server.url)
        .font(.subheadline)
        .foregroundStyle(ADEColor.textSecondary)
        .lineLimit(1)
        .truncationMode(.middle)
        .frame(maxWidth: .infinity, alignment: .leading)
      if let onOpen {
        if isOpening {
          ProgressView()
            .controlSize(.small)
            .frame(minWidth: 56, minHeight: 30)
            .accessibilityLabel("Opening \(server.url)")
        } else {
          Button(hasTab ? "Watch" : "Open", action: onOpen)
            .buttonStyle(ADEKitButtonStyle(tone: .accent))
            .fixedSize()
            .accessibilityLabel(hasTab ? "Watch \(server.url)" : "Open \(server.url) in the desktop browser")
        }
      }
    }
    .frame(maxWidth: .infinity, minHeight: 34, alignment: .leading)
    .contextMenu {
      Button {
        UIPasteboard.general.string = server.url
      } label: {
        Label("Copy link", systemImage: "link")
      }
    }
  }
}

/// The loopback port a page address points at (`localhost`, `127.0.0.1`,
/// `[::1]`), or nil for any other address. Matches a dev server to the lane's
/// tab on it the way the host does.
func workToolsLoopbackPort(_ address: String?) -> Int? {
  guard let address,
        let components = URLComponents(string: address),
        let scheme = components.scheme?.lowercased(),
        scheme == "http" || scheme == "https",
        let host = components.host?.lowercased(),
        ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)
  else { return nil }
  return components.port ?? (scheme == "https" ? 443 : 80)
}

