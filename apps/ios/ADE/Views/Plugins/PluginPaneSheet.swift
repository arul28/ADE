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
  /// The scroll view's own position, so a return can put the reader back where
  /// they were. The store holds the VALUE — see ``PluginPaneStore/scrollOffset``
  /// — because a snapshot has to be takeable at the moment a plugin navigates,
  /// which is not a moment this view is involved in.
  @State private var scrollPosition = ScrollPosition()
  /// Whether the nav-bar search field is open. Dismissing it commits `onChange`,
  /// the same way blurring the desktop field does.
  @State private var searchPresented = false
  /// Selectable lists report here so one bulk bar can sit in the sheet chrome.
  @State private var bulkReports: [PluginVocabBulkReport] = []

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
      chromeWrapped(content)
        .scrollContentBackground(.hidden)
        .background(ADEColor.pageBackground)
        // The panel on top, not the plugin: once a plugin can send the reader
        // two screens deep, a bar that always said "Linear" stopped telling them
        // where they were. The plugin's own name is still the fallback for a
        // panel the mirror has no row for.
        .navigationTitle(store.phase == .loaded ? store.currentTitle : request.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .topBarLeading) {
            if store.canGoBack {
              backButton
            } else {
              closeButton
            }
          }
          ToolbarItemGroup(placement: .topBarTrailing) {
            ForEach(Array((panelChrome?.navActions ?? []).enumerated()), id: \.offset) { _, nav in
              Button {
                ADEHaptics.light()
                store.perform(nav.action, label: nav.label)
              } label: {
                if PluginSymbol.drawsIcon(nav.icon, shipped: store.brandIcons) {
                  PluginSymbol.glyph(nav.icon, fallback: "puzzlepiece.extension", pointSize: 17, shipped: store.brandIcons)
                } else {
                  Text(nav.label).font(.subheadline)
                }
              }
              .accessibilityLabel(nav.label)
            }
            // Close moves to the trailing edge only while Back owns the leading
            // one. Both gestures stay reachable at every depth, and neither ever
            // sits where the other was a moment ago.
            if store.canGoBack {
              closeButton
            }
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

  private var closeButton: some View {
    Button { close() } label: {
      Image(systemName: "xmark").font(.system(size: 13, weight: .semibold))
    }
    .accessibilityLabel("Close \(store.displayName)")
  }

  /// The chevron back to the panel beneath this one.
  ///
  /// It names the destination rather than saying "Back", which is what the
  /// system bar does for a real push and what tells the reader whether the way
  /// back is the list they came from or something else.
  @ViewBuilder
  private var backButton: some View {
    let title = store.backTitle ?? "Back"
    Button {
      ADEHaptics.light()
      store.goBack()
    } label: {
      HStack(spacing: 3) {
        Image(systemName: "chevron.left").font(.system(size: 13, weight: .semibold))
        Text(title).font(.subheadline).lineLimit(1)
      }
    }
    .accessibilityLabel("Back to \(title)")
  }

  private var panelChrome: PluginVocabPanelChrome? {
    if case let .panel(schema) = store.presentation { return schema.chrome }
    return nil
  }

  /// Nav-bar search and a sticky footer sit outside the scrolling body, the
  /// same split desktop draws. Search types locally; submitting or dismissing
  /// the field is the commit that may dispatch `onChange`.
  @ViewBuilder
  private func chromeWrapped<Content: View>(_ inner: Content) -> some View {
    if let search = panelChrome?.search {
      footerWrapped(
        inner
          .searchable(
            text: Binding(
              get: { store.searchQuery(for: search) },
              set: { store.setSearch($0, in: search) }
            ),
            isPresented: $searchPresented,
            prompt: Text(search.placeholder ?? "Search")
          )
          .onSubmit(of: .search) { store.commitSearch(search) }
          .onChange(of: searchPresented) { _, presented in
            if !presented { store.commitSearch(search) }
          }
      )
    } else {
      footerWrapped(inner)
    }
  }

  @ViewBuilder
  private func footerWrapped<Content: View>(_ inner: Content) -> some View {
    let footer = panelChrome?.footer ?? []
    inner
      .onPreferenceChange(PluginVocabBulkPreferenceKey.self) { bulkReports = $0 }
      .safeAreaInset(edge: .bottom, spacing: 0) {
        chromeBottom(footer: footer)
      }
  }

  @ViewBuilder
  private func chromeBottom(footer: [PluginVocabNode]) -> some View {
    let showBulk = PluginVocabBulk.unioned(bulkReports).contains { report in
      !store.selectedKeys(in: report.selectable, visibleRowKeys: report.visibleRowKeys).isEmpty
    }
    if showBulk || !footer.isEmpty {
      VStack(alignment: .leading, spacing: 10) {
        PluginVocabActiveBulkBar(reports: bulkReports, store: store)
        ForEach(Array(footer.enumerated()), id: \.offset) { _, node in
          PluginVocabularyNodeView(node: node, store: store)
        }
      }
      .padding(.horizontal, 20)
      .padding(.vertical, 12)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(.ultraThinMaterial)
    }
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
    .scrollPosition($scrollPosition)
    // Reported continuously so the store always holds a current offset: a
    // plugin's `navigate` can land at any moment, and a snapshot taken then must
    // carry where the reader actually was, not where they were when they last
    // pressed something.
    .onScrollGeometryChange(for: CGFloat.self) { geometry in
      geometry.contentOffset.y
    } action: { _, offset in
      store.scrollOffset = offset
    }
    // The other half of a return. Honoured once and then cleared, so an
    // ordinary redraw — a poll, a filter, an action's banner — never yanks the
    // reader back to an offset from a screen they have already left.
    .onChange(of: store.pendingScrollOffset) { _, pending in
      guard let pending else { return }
      scrollPosition.scrollTo(y: pending)
      store.pendingScrollOffset = nil
    }
    // The swipe back, approximated.
    //
    // A real interactive pop belongs to `NavigationStack`, and this pane is not
    // one: the store holds ONE panel at a time and the sheet draws it, so there
    // is no second destination view for the system to drag in from the edge.
    // What is reproducible without that is the gesture itself — a drag that
    // starts at the left edge and travels right pops the stack — which is the
    // part a reader's hand already knows. Simultaneous, so it costs the scroll
    // view nothing: a vertical drag never satisfies the horizontal test.
    .simultaneousGesture(
      DragGesture(minimumDistance: 20)
        .onEnded { value in
          guard store.canGoBack,
                value.startLocation.x <= PluginPaneSheet.backSwipeEdge,
                value.translation.width >= PluginPaneSheet.backSwipeDistance,
                abs(value.translation.height) <= abs(value.translation.width) else { return }
          ADEHaptics.light()
          store.goBack()
        }
    )
  }

  /// How far from the left edge a back swipe must start, in points. The system's
  /// own edge-pop region is about this wide.
  private static let backSwipeEdge: CGFloat = 32
  /// How far it must travel before it counts as a pop rather than a stray drag.
  private static let backSwipeDistance: CGFloat = 64

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
