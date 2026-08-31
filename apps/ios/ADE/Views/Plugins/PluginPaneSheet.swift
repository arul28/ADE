import SwiftUI

/// A plugin's pane: a full-screen sheet hosting one panel at a time.
///
/// Presented from the root the way the Linear pane is, and for the same reason
/// it is not a tab: `RootTab` is wired into analytics, tab persistence and
/// badges, and a plugin installed at runtime must not be able to add itself to
/// that set. A sheet is also the honest shape for something that can disappear
/// — uninstall the plugin and the entry point is simply gone.
struct PluginPaneSheet: View {
  let request: PluginPaneRequest

  @EnvironmentObject private var syncService: SyncService
  @StateObject private var store: PluginPaneStore

  init(request: PluginPaneRequest, syncService: SyncService) {
    self.request = request
    _store = StateObject(wrappedValue: PluginPaneStore(
      pluginId: request.pluginId,
      panelId: request.panelId,
      context: request.context,
      sync: syncService,
      // The one surface allowed to go and get what the mirror is missing. The
      // pane is a screen the user asked for, so an empty one is the entire
      // answer — and the machine's copy of the panel is the only thing that can
      // tell "the replica is behind" apart from "the plugin published nothing".
      fetchesMissingRows: true
    ))
  }

  var body: some View {
    NavigationStack {
      content
        .scrollContentBackground(.hidden)
        .background(ADEColor.pageBackground)
        .navigationTitle(store.phase == .loaded ? store.displayName : request.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .topBarLeading) {
            Button { close() } label: {
              Image(systemName: "xmark").font(.system(size: 13, weight: .semibold))
            }
            .accessibilityLabel("Close \(store.displayName)")
          }
        }
    }
    // Accent-only theming (design D15). The plugin's manifest colour tints its
    // own controls; every surface outside this sheet keeps the app palette,
    // which is compile-time and not something a plugin can reach.
    .tint(store.accent)
    .task(id: syncService.pluginsProjectionRevision) {
      store.load()
    }
    .alert(
      "Confirm",
      isPresented: Binding(
        get: { store.pendingConfirmation != nil },
        set: { if !$0 { store.pendingConfirmation = nil } }
      ),
      presenting: store.pendingConfirmation
    ) { _ in
      Button("Cancel", role: .cancel) { store.pendingConfirmation = nil }
      Button("Continue") { store.confirmPending() }
    } message: { pending in
      Text(pending.message)
    }
    // The `{prompt}` verb, asked inside the pane the button was pressed in.
    .pluginPromptAlert(store: store)
  }

  @ViewBuilder
  private var content: some View {
    // Pull-to-refresh whenever the pull has something to do: a panel whose
    // manifest declared a refresh action, or any pane that may ask the machine
    // for rows — which is what makes the gesture answer a mirror that is behind
    // rather than redraw the same stale list. A pane with neither keeps no
    // spinner, because a `.refreshable` that is present and does nothing is the
    // empty promise this avoids.
    if store.canRefresh {
      scrollingContent.refreshable { await store.refresh() }
    } else {
      scrollingContent
    }
  }

  @ViewBuilder
  private var scrollingContent: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        if store.panels.count > 1 {
          panelPicker
        }
        if !store.canInvoke {
          PluginReadOnlyNotice()
        }
        // Said before the list, not after it: a reader who takes the rows at
        // face value has already been misled by the time a footnote arrives.
        if store.collectionsMayBeStale {
          PluginStaleListNotice()
        }
        panelBody
        if let message = store.actionMessage {
          PluginActionMessageView(message: message)
        }
      }
      .padding(20)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .animation(.easeOut(duration: 0.18), value: store.actionMessage)
  }

  @ViewBuilder
  private var panelBody: some View {
    switch store.presentation {
    case let .panel(schema):
      VStack(alignment: .leading, spacing: 16) {
        if let title = schema.title {
          Text(title)
            .font(.title3.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
        }
        ForEach(Array(schema.body.enumerated()), id: \.offset) { _, node in
          PluginVocabularyNodeView(node: node, store: store)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)

    case let .updateRequired(fallback):
      PluginPanelFallbackCard(
        symbol: "arrow.up.circle",
        title: fallback?.title ?? "Update ADE to view this panel",
        message: fallback?.text
          ?? "This plugin uses a newer panel format than this version of ADE can read. Everything else keeps working.",
        deeplink: fallback?.deeplink
      )

    case let .damaged(fallback):
      PluginPanelFallbackCard(
        symbol: "exclamationmark.triangle",
        title: fallback?.title ?? "This panel could not be read",
        message: fallback?.text
          ?? "\(store.displayName) sent a panel ADE could not make sense of. The plugin's author can fix this.",
        deeplink: fallback?.deeplink
      )

    // Reached only when the machine itself answered that it has no such panel,
    // or that the panel it has is not one the phone shows. That answer is the
    // licence for this sentence: before the live read existed, a replica that
    // was simply behind rendered here and told users a working plugin was
    // empty.
    case .missing:
      ADEEmptyStateView(
        symbol: "puzzlepiece.extension",
        title: "No panels yet",
        message: "\(store.displayName) has not published anything to show here."
      )

    case .notReceived(.fetching):
      HStack(spacing: 10) {
        ProgressView()
        Text("Getting this from your computer.")
          .font(.subheadline)
          .foregroundStyle(ADEColor.textSecondary)
      }
      .frame(maxWidth: .infinity, alignment: .center)
      .padding(.vertical, 32)

    // Offline, a dropped socket, or a computer running an ADE too old to be
    // asked. One sentence because they are one situation to the reader and one
    // gesture to fix.
    case .notReceived(.unavailable):
      ADEEmptyStateView(
        symbol: "wifi.exclamationmark",
        title: "This panel hasn't arrived yet",
        message: "ADE couldn't get it from your computer just now."
      ) {
        Button("Try again") {
          ADEHaptics.light()
          store.retryFetch()
        }
        .buttonStyle(.borderedProminent)
      }
    }
  }

  private var panelPicker: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        ForEach(store.panels) { panel in
          Button {
            ADEHaptics.light()
            store.selectPanel(panel.panelId)
          } label: {
            Text(panel.displayTitle)
              .font(.caption.weight(.semibold))
              .foregroundStyle(panel.panelId == store.selectedPanelId ? store.accent : ADEColor.textSecondary)
              .padding(.horizontal, 12)
              .padding(.vertical, 7)
              .background(
                (panel.panelId == store.selectedPanelId ? store.accent.opacity(0.14) : ADEColor.surfaceBackground.opacity(0.5)),
                in: Capsule()
              )
              .glassEffect()
          }
          .buttonStyle(.plain)
        }
      }
    }
  }

  private func close() {
    syncService.presentedPluginPane = nil
  }
}

/// Shown when the attached machine cannot take plugin actions — an older host,
/// or an offline phone. The panel still renders: reading what a plugin last
/// published is useful on its own, and hiding it would make a temporary
/// condition look like an uninstall.
/// Shown when the pane drew the mirror's rows but could not check them against
/// the machine. The list is real; its currency is not, and saying so is the
/// difference between a stale list and a lying one.
struct PluginStaleListNotice: View {
  var body: some View {
    HStack(spacing: 8) {
      Image(systemName: "clock.arrow.circlepath")
        .font(.system(size: 11, weight: .semibold))
      Text("Showing what reached this phone. ADE couldn't check with your computer.")
        .font(.caption)
        .fixedSize(horizontal: false, vertical: true)
    }
    .foregroundStyle(ADEColor.textSecondary)
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(12)
    .background(ADEColor.surfaceBackground.opacity(0.5), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
  }
}

struct PluginReadOnlyNotice: View {
  var body: some View {
    HStack(spacing: 8) {
      Image(systemName: "hand.raised")
        .font(.system(size: 11, weight: .semibold))
      Text("Actions are unavailable until your computer is reachable.")
        .font(.caption)
        .fixedSize(horizontal: false, vertical: true)
    }
    .foregroundStyle(ADEColor.textSecondary)
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(12)
    .background(ADEColor.surfaceBackground.opacity(0.5), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
  }
}

/// The floor of the degradation ladder: a panel that could not render at all
/// still shows the plugin's own title and sentence, plus a way into the full
/// version. Never blank.
struct PluginPanelFallbackCard: View {
  let symbol: String
  let title: String
  let message: String
  let deeplink: String?

  @Environment(\.openURL) private var openURL

  var body: some View {
    ADEEmptyStateView(symbol: symbol, title: title, message: message) {
      if let url = PluginDeeplinkURL.resolve(deeplink) {
        // An `ade://` link routes back through `DeepLinkRouter` and lands on
        // the nearest thing the phone CAN show; `https` leaves the app.
        ADEGlassActionButton(title: "Open", symbol: "arrow.up.forward", tint: ADEColor.accent) {
          openURL(url)
        }
      }
    }
  }
}

struct PluginActionMessageView: View {
  let message: PluginActionMessage

  var body: some View {
    HStack(spacing: 8) {
      Image(systemName: message.isFailure ? "exclamationmark.circle" : "checkmark.circle")
        .font(.system(size: 12, weight: .semibold))
      Text(message.text)
        .font(.caption)
        .fixedSize(horizontal: false, vertical: true)
    }
    .foregroundStyle(message.isFailure ? ADEColor.warning : ADEColor.success)
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(12)
    .background(
      (message.isFailure ? ADEColor.warning : ADEColor.success).opacity(0.1),
      in: RoundedRectangle(cornerRadius: 12, style: .continuous)
    )
    .transition(.opacity)
  }
}
