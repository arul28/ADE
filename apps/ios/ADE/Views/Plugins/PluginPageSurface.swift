import SwiftUI
import UIKit

/// Where a plugin page gets drawn on the phone, and what happens when there is
/// no page to draw.
///
/// One view answers both questions, because they are the same question: a
/// placement is only a placement if it has something to put in it, and the
/// fallback has to live at the same level as the page or the two would disagree
/// about what the surface's title and chrome are.
///
/// ## The fallback is the vocabulary panel
///
/// Never an "open this on your Mac" card. A phone that has not cached a
/// plugin's page still holds the plugin's `plugin_panels` rows, and those rows
/// are a complete, drawable panel — the tier the phone has drawn since the
/// vocabulary shipped. Falling back to it means a page that has not downloaded
/// yet, a plugin that ships no page at all, and a phone that has never reached
/// the machine all land on something the user can actually use.
///
/// ## Placements
///
/// - **Tab**: the existing plugin sheet draws the page instead of the panel
///   when the plugin declares a `webview` surface for that tab.
/// - **Socket press answering `openWebview`**: a popover on a regular-width
///   screen (iPad), a sheet on a compact one (iPhone). A popover on a phone is
///   a sheet anyway; asking for one and getting the other silently is how a
///   layout ends up depending on the device.
/// - **Settings section and composer picker**: sheets, because neither has an
///   anchor on this phone — the phone draws no settings surface of its own, and
///   the composer's own accessory rail is where the picker was pressed from.

/// One request to draw a plugin's page.
///
/// `Identifiable` on the composite of plugin, surface and instance so two
/// presses on the same button re-present rather than being folded into one by
/// SwiftUI's item-sheet identity.
struct PluginPageRequest: Identifiable, Equatable {
    enum Placement: Equatable {
        case tab
        case popover
        case settingsSection
        case composerPicker

        var webviewPlacement: PluginPagePlacement {
            switch self {
            case .tab: return .tab
            case .popover: return .popover
            case .settingsSection: return .settingsSection
            case .composerPicker: return .composerPicker
            }
        }
    }

    var id: String { "\(pluginId)|\(surfaceId)|\(instance)" }
    var pluginId: String
    var surfaceId: String
    var title: String
    var placement: Placement
    /// The panel to fall back to when no page is cached. Nil means the sheet
    /// falls back to whatever panel the plugin published first.
    var fallbackPanelId: String?
    var subject: [String: PluginPageJSON]?
    var pointer: [String: PluginPageJSON]?
    /// Distinguishes two presses of the same button. Never read by the page.
    var instance: String = UUID().uuidString

    /// The placement a `{openWebview}` answer asked for, narrowed to what this
    /// device can actually draw.
    static func placement(
        requested: String?,
        horizontalSizeClass: UserInterfaceSizeClass?
    ) -> Placement {
        guard requested == PluginPagePlacement.popover.rawValue else {
            switch requested {
            case PluginPagePlacement.settingsSection.rawValue: return .settingsSection
            case PluginPagePlacement.composerPicker.rawValue: return .composerPicker
            default: return .tab
            }
        }
        // A popover on a compact screen is a sheet in every meaningful sense, so
        // the phone says sheet rather than pretending otherwise.
        return horizontalSizeClass == .regular ? .popover : .tab
    }
}

/// What the surface decided to draw.
enum PluginPageSurfaceState: Equatable {
    /// A cached page, ready now.
    case page(PluginPageCacheEntry)
    /// No page cached; the vocabulary panel is the surface.
    case vocabulary
}

/// The decision, as a pure function of the cache.
///
/// Separated from the view so "no page yet means the vocabulary panel, never a
/// dead end" is a testable claim rather than a branch buried in a `body`.
enum PluginPageSurfaceResolver {
    static func state(pluginId: String, store: PluginPageAssetStore) -> PluginPageSurfaceState {
        guard let entry = store.resolve(pluginId: pluginId) else { return .vocabulary }
        // A manifest that lists no entry file is an entry that did not finish
        // downloading, or a build that shipped an empty directory. Either way it
        // is not a page, and drawing a blank guest is worse than the panel.
        guard entry.manifest.file(at: entry.entry) != nil else { return .vocabulary }
        return .page(entry)
    }
}

// MARK: - The surface

struct PluginPageSurface: View {
    let request: PluginPageRequest
    @ObservedObject var syncService: SyncService
    let store: PluginPageAssetStore

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @StateObject private var coordinator = PluginPageSurfaceCoordinator()

    var body: some View {
        content.modifier(PluginPageSurfaceChrome(coordinator: coordinator))
    }

    /// The page or the vocabulary fallback, with the load lifecycle. Kept apart
    /// from the prompt, confirm and toast chrome so no single expression is
    /// long enough to stall the type checker.
    private var content: some View {
        Group {
            switch coordinator.state {
            case .page(let entry):
                PluginPageHostView(
                    pluginId: request.pluginId,
                    entry: entry,
                    context: pageContext,
                    store: store,
                    dataSource: syncService,
                    host: coordinator,
                    changeRevision: syncService.pluginsProjectionRevision,
                    colorScheme: colorScheme
                )
                .ignoresSafeArea(.container, edges: .bottom)
            case .vocabulary:
                PluginPaneSheet(
                    request: PluginPaneRequest(
                        pluginId: request.pluginId,
                        panelId: request.fallbackPanelId,
                        title: request.title,
                        context: [:]
                    ),
                    syncService: syncService
                )
            }
        }
        .task(id: request.id) {
            coordinator.bind(request: request, syncService: syncService, store: store)
            coordinator.sizeClass = horizontalSizeClass
            await coordinator.load()
        }
        .onChange(of: horizontalSizeClass) { _, updated in
            coordinator.sizeClass = updated
        }
    }

    /// The context the host injects. Every field is the HOST's own word.
    private var pageContext: PluginPageContext {
        PluginPageContext(
            subject: request.subject,
            pointer: request.pointer,
            surfaceId: request.surfaceId,
            placement: request.placement.webviewPlacement,
            project: PluginPageProjectContext(
                projectId: syncService.activeProjectId,
                root: syncService.activeProjectRootPath,
                // A phone is always looking at a checkout that lives on another
                // machine. Saying `local` would invite a page to offer "reveal in
                // Finder" for a path this device cannot open.
                binding: PluginPageProjectContext.remoteBinding
            )
        )
    }
}

/// The prompt, confirmation dialog, confirm alert and toast a page can raise.
/// Four small modifiers with their bindings and titles precomputed, because one
/// long chain of alerts stalls the type checker on a real build.
private struct PluginPageSurfaceChrome: ViewModifier {
    @ObservedObject var coordinator: PluginPageSurfaceCoordinator

    func body(content: Content) -> some View {
        content
            .modifier(PluginPagePromptAlert(coordinator: coordinator))
            .modifier(PluginPagePromptChoices(coordinator: coordinator))
            .modifier(PluginPageConfirmAlert(coordinator: coordinator))
            .modifier(PluginPageToastOverlay(coordinator: coordinator))
    }
}

/// A free-text prompt: an alert with one text field.
private struct PluginPagePromptAlert: ViewModifier {
    @ObservedObject var coordinator: PluginPageSurfaceCoordinator

    private var title: String { coordinator.pendingPrompt?.title ?? "" }

    private var isPresented: Binding<Bool> {
        Binding(
            get: {
                guard let prompt = coordinator.pendingPrompt else { return false }
                return prompt.options.isEmpty
            },
            set: { shown in if !shown { coordinator.answerPrompt(nil) } }
        )
    }

    func body(content: Content) -> some View {
        content.alert(title, isPresented: isPresented, presenting: coordinator.pendingPrompt) { prompt in
            promptFields(prompt)
        } message: { prompt in
            promptMessage(prompt)
        }
    }

    @ViewBuilder
    private func promptFields(_ prompt: PluginActionPrompt) -> some View {
        TextField(prompt.placeholder ?? "", text: $coordinator.promptDraft)
        Button("Cancel", role: .cancel) { coordinator.answerPrompt(nil) }
        Button(prompt.submitLabel ?? "Submit") { coordinator.answerPrompt(coordinator.promptDraft) }
    }

    @ViewBuilder
    private func promptMessage(_ prompt: PluginActionPrompt) -> some View {
        if let context = prompt.context, !context.isEmpty { Text(context) }
    }
}

/// A closed-choice prompt: a confirmation dialog with one button per option.
private struct PluginPagePromptChoices: ViewModifier {
    @ObservedObject var coordinator: PluginPageSurfaceCoordinator

    private var title: String { coordinator.pendingPrompt?.title ?? "" }

    private var isPresented: Binding<Bool> {
        Binding(
            get: {
                guard let prompt = coordinator.pendingPrompt else { return false }
                return !prompt.options.isEmpty
            },
            set: { shown in if !shown { coordinator.answerPrompt(nil) } }
        )
    }

    func body(content: Content) -> some View {
        content.confirmationDialog(
            title,
            isPresented: isPresented,
            titleVisibility: .visible,
            presenting: coordinator.pendingPrompt
        ) { prompt in
            choiceButtons(prompt)
        }
    }

    @ViewBuilder
    private func choiceButtons(_ prompt: PluginActionPrompt) -> some View {
        ForEach(prompt.options, id: \.value) { option in
            Button(option.label) { coordinator.answerPrompt(option.value) }
        }
        Button("Cancel", role: .cancel) { coordinator.answerPrompt(nil) }
    }
}

/// A yes/no confirmation raised by the page.
private struct PluginPageConfirmAlert: ViewModifier {
    @ObservedObject var coordinator: PluginPageSurfaceCoordinator

    private var title: String { coordinator.confirmation?.title ?? "" }

    private var isPresented: Binding<Bool> {
        Binding(
            get: { coordinator.confirmation != nil },
            set: { shown in if !shown { coordinator.answerConfirm(false) } }
        )
    }

    func body(content: Content) -> some View {
        content.alert(title, isPresented: isPresented, presenting: coordinator.confirmation) { pending in
            confirmButtons(pending)
        } message: { pending in
            confirmMessage(pending)
        }
    }

    @ViewBuilder
    private func confirmButtons(_ pending: PluginPageConfirm) -> some View {
        Button("Cancel", role: .cancel) { coordinator.answerConfirm(false) }
        Button(pending.confirmLabel, role: pending.destructive ? .destructive : nil) {
            coordinator.answerConfirm(true)
        }
    }

    @ViewBuilder
    private func confirmMessage(_ pending: PluginPageConfirm) -> some View {
        if !pending.body.isEmpty { Text(pending.body) }
    }
}

/// The toast a page raised, drawn at the bottom of the surface.
private struct PluginPageToastOverlay: ViewModifier {
    @ObservedObject var coordinator: PluginPageSurfaceCoordinator

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .bottom) { toastView }
            .animation(.easeOut(duration: 0.18), value: coordinator.toast)
    }

    @ViewBuilder
    private var toastView: some View {
        if let toast = coordinator.toast {
            PluginPageToastView(toast: toast)
                .padding(.horizontal, 16)
                .padding(.bottom, 24)
                .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }
}

/// A toast a plugin page raised, drawn in ADE's own chrome.
struct PluginPageToastView: View {
    let toast: PluginPageToast

    var body: some View {
        HStack(spacing: 10) {
            Circle().fill(tint).frame(width: 7, height: 7)
            Text(toast.message)
                .font(.footnote)
                .foregroundStyle(ADEColor.textPrimary)
                .multilineTextAlignment(.leading)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(ADEColor.cardBackground)
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(ADEColor.border, lineWidth: 1)
                )
        )
    }

    private var tint: Color {
        switch toast.level {
        case .info: return ADEColor.info
        case .success: return ADEColor.success
        case .warning: return ADEColor.warning
        case .error: return ADEColor.danger
        }
    }
}

// MARK: - The coordinator

/// The surface's state, and the host half of the bridge.
///
/// An `ObservableObject` rather than view state because the bridge holds it
/// weakly across an async hop: a verb that presents a confirm has to survive the
/// `body` re-evaluation its own published change causes.
@MainActor
final class PluginPageSurfaceCoordinator: ObservableObject, PluginPageBridgeHosting {
    @Published private(set) var state: PluginPageSurfaceState = .vocabulary
    @Published private(set) var toast: PluginPageToast?
    @Published private(set) var confirmation: PluginPageConfirm?
    @Published private(set) var pendingPrompt: PluginActionPrompt?
    @Published var promptDraft: String = ""

    private var request: PluginPageRequest?
    private weak var syncService: SyncService?
    private var store: PluginPageAssetStore?
    private var toastId: String?
    private var confirmContinuation: CheckedContinuation<Bool, Never>?
    private var promptContinuation: CheckedContinuation<String?, Never>?
    private var refreshTask: Task<Void, Never>?
    private var authRunner: PluginAuthSessionRunner?
    /// The size class the surface last drew at, so a `{openWebview}` answer can
    /// choose a popover on iPad and a sheet on iPhone.
    var sizeClass: UserInterfaceSizeClass?

    func bind(request: PluginPageRequest, syncService: SyncService, store: PluginPageAssetStore) {
        self.request = request
        self.syncService = syncService
        self.store = store
    }

    /// Draw whatever is already cached, THEN ask the machine for anything newer.
    ///
    /// That order is the offline promise: a phone with no machine in reach opens
    /// the page it has. A refresh that fails changes nothing on screen — the
    /// page the user is reading is still a page.
    func load() async {
        guard let request, let store else { return }
        state = PluginPageSurfaceResolver.state(pluginId: request.pluginId, store: store)

        refreshTask?.cancel()
        guard let syncService else { return }
        let pluginId = request.pluginId
        refreshTask = Task { [weak self] in
            guard let entry = try? await store.refresh(pluginId: pluginId, using: syncService) else { return }
            guard !Task.isCancelled else { return }
            await MainActor.run {
                guard let self, self.request?.pluginId == pluginId else { return }
                // Only when it is genuinely different: reassigning the same
                // entry recreates the guest, which throws away the page the user
                // is already looking at.
                if case .page(let current) = self.state, current == entry { return }
                if entry.manifest.file(at: entry.entry) != nil {
                    self.state = .page(entry)
                }
            }
        }
    }

    // MARK: PluginPageBridgeHosting

    func pluginPageCloseSurface() {
        // Every phone placement is a sheet or a popover presented off
        // `SyncService.presentedPluginPage`, so closing is one assignment. A tab
        // has nothing to close, and clearing a request that is not this one
        // would dismiss somebody else's surface.
        guard let syncService, syncService.presentedPluginPage?.id == request?.id else { return }
        syncService.presentedPluginPage = nil
    }

    func pluginPageComposerAttach(_ attach: PluginPageComposerAttach) {
        // Handed on whole, never flattened to a line of text. The composer is
        // where this is applied because the composer is the only thing that
        // knows which session the page was opened over, and applying it means
        // writing ADE's own session issue link — the same row the Linear attach
        // row writes, which is what a lane badge and a PR body read back.
        syncService?.pluginPageComposerAttach = attach
    }

    func pluginPageComposerInsert(_ text: String) {
        syncService?.pluginPageComposerEdit = .insert(text)
    }

    func pluginPageShowToast(_ toast: PluginPageToast) -> String {
        let id = UUID().uuidString
        toastId = id
        self.toast = toast
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            await MainActor.run {
                guard let self, self.toastId == id else { return }
                self.toast = nil
                self.toastId = nil
            }
        }
        return id
    }

    func pluginPageDismissToast(id: String) {
        guard toastId == id else { return }
        toast = nil
        toastId = nil
    }

    func pluginPagePrompt(_ prompt: PluginActionPrompt) async -> String? {
        // A second question while one is open answers the first as "dismissed":
        // two stacked alerts is a phone the user cannot get out of.
        answerPrompt(nil)
        return await withCheckedContinuation { continuation in
            promptContinuation = continuation
            pendingPrompt = prompt
        }
    }

    func answerPrompt(_ answer: String?) {
        guard let continuation = promptContinuation else { return }
        promptContinuation = nil
        pendingPrompt = nil
        promptDraft = ""
        continuation.resume(returning: answer)
    }

    func pluginPageConfirm(_ confirm: PluginPageConfirm) async -> Bool {
        // A second confirm while one is open answers the first as "no": two
        // stacked alerts is a phone the user cannot get out of.
        answerConfirm(false)
        return await withCheckedContinuation { continuation in
            confirmContinuation = continuation
            confirmation = confirm
        }
    }

    func answerConfirm(_ answer: Bool) {
        guard let continuation = confirmContinuation else { return }
        confirmContinuation = nil
        confirmation = nil
        continuation.resume(returning: answer)
    }

    func pluginPageOpenSettings(entryId: String?, socketId: String?) {
        guard let syncService, let request else { return }
        let label = syncService.pluginPresenceCatalog().label(for: request.pluginId)
        if let entryId, PluginInvokeResult.allowedOpenSettingsEntryIds.contains(entryId) {
            syncService.pluginSettingsNotice = PluginSettingsNotice(entryId: entryId, pluginLabel: label)
        } else if socketId != nil {
            syncService.pluginSettingsNotice = PluginSettingsNotice.ownSection(pluginLabel: label)
        }
    }

    /// The control-flow half of an `invoke` answer.
    ///
    /// The SAME six behaviours a socket press applies on this phone today, in
    /// the same order and with the same suppression rule: a link opens, a
    /// settings page is named unless a navigation already answered where the
    /// reader is going, and the navigation itself lands last. A page that calls
    /// `invoke` therefore gets exactly what a button that calls the same action
    /// gets — which is the whole reason the desktop bridge had to stop returning
    /// the raw result and ignoring it.
    func pluginPageApply(_ result: PluginInvokeResult, pluginId: String) async {
        guard let syncService else { return }
        let label = syncService.pluginPresenceCatalog().label(for: pluginId)

        if let url = result.openURL {
            _ = await UIApplication.shared.open(url)
        }

        let navigates = result.navigate != nil || result.openWebview != nil
        if navigates {
            // Nothing to say: the surface below is the answer.
        } else if let entryId = result.openSettings {
            syncService.pluginSettingsNotice = PluginSettingsNotice(entryId: entryId, pluginLabel: label)
        } else if result.openSettingsSectionId != nil {
            syncService.pluginSettingsNotice = PluginSettingsNotice.ownSection(pluginLabel: label)
        }

        // A page beats a panel when an action names both: the plugin shipped a
        // page for a reason, and the panel is the fallback tier.
        if let page = result.openWebview {
            syncService.presentedPluginPage = PluginPageRequest(
                pluginId: pluginId,
                surfaceId: page.surfaceId,
                title: label,
                placement: PluginPageRequest.placement(requested: page.placement, horizontalSizeClass: sizeClass),
                fallbackPanelId: nil,
                subject: nil,
                pointer: page.pointer?.mapValues { PluginPageJSON.from($0.anyValue) }
            )
        } else if let navigation = result.navigate {
            switch PluginPaneOpening.forTarget(navigation.target) {
            case .sheet:
                syncService.presentedPluginPane = PluginPaneRequest(
                    pluginId: pluginId,
                    panelId: navigation.panelId,
                    title: label,
                    context: navigation.context ?? [:]
                )
            }
        }

        if let session = result.authSession {
            // The same in-app sign-in the pane store runs. `PluginAuthSessionRunner`
            // owns the presentation context, so a page cannot point the sheet at
            // an origin the plugin's manifest never declared: the URL was stamped
            // by the machine, not by the page.
            let runner = PluginAuthSessionRunner()
            authRunner = runner
            _ = await runner.run(
                url: session.url,
                callbackScheme: session.callbackScheme ?? "",
                using: syncService
            )
            authRunner = nil
        }
    }

    func pluginPageOpenDeeplink(_ url: URL) {
        guard let scheme = url.scheme?.lowercased() else { return }
        if scheme == "https" {
            UIApplication.shared.open(url)
            return
        }
        // `ade:` goes through the app's own router, which applies the
        // installed-and-enabled gate a page must not be able to skip.
        UIApplication.shared.open(url)
    }

    func pluginPageTheme() -> PluginPageThemeSnapshot {
        PluginPageTheme.snapshot(scheme: currentScheme)
    }

    private var currentScheme: ColorScheme {
        UITraitCollection.current.userInterfaceStyle == .light ? .light : .dark
    }
}
