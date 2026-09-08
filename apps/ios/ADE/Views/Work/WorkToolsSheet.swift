import SwiftUI
import UIKit

/// Read-only view of the Work tools pane running on the user's Mac.
///
/// Three cards, in the order a user actually asks about them: what the desktop
/// has open right now (with the last frame it captured), what the browser has
/// in it, and what App Control is driving. There are no controls anywhere in
/// this sheet — the browser is a `WebContentsView` in ADE Desktop and App
/// Control is a CDP socket to a local process; neither can be reached from a
/// phone, so offering a button would be a lie.
///
/// Refresh is a poll, not a subscription. The brain has no generic named-event
/// channel to the phone — its push surface is cr-sqlite changesets and this
/// state is deliberately not table-backed (see `workToolsStateService`) — so
/// the sheet polls while it is open and stops the moment it closes.
struct WorkToolsSheet: View {
  let laneId: String

  /// Poll cadence while the sheet is visible. Slow enough to be free on a
  /// cellular link, fast enough that switching tools on the Mac reads as live.
  private static let refreshInterval: Duration = .seconds(3)

  @EnvironmentObject private var syncService: SyncService
  @Environment(\.dismiss) private var dismiss

  @State private var state: WorkToolsLaneState?
  @State private var loaded = false
  @State private var frame: UIImage?
  @State private var loadedFramePath: String?

  var body: some View {
    NavigationStack {
      Group {
        if !loaded {
          loadingState
        } else if state == nil {
          noDesktopState
        } else {
          content
        }
      }
      .adeScreenBackground()
      .navigationTitle("Tools")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done") { dismiss() }
        }
      }
    }
    .task(id: laneId) { await refresh() }
    .task(id: laneId) {
      // The poll lives beside the initial load rather than inside it so a slow
      // first response cannot delay the cadence, and cancellation on dismiss
      // stops both.
      while !Task.isCancelled {
        try? await Task.sleep(for: Self.refreshInterval)
        guard !Task.isCancelled else { return }
        await refresh()
      }
    }
  }

  private var content: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        activeToolCard
        browserCard
        appControlCard
        Text("Control from the desktop")
          .font(.caption)
          .foregroundStyle(ADEColor.textMuted)
          .frame(maxWidth: .infinity, alignment: .center)
          .padding(.top, 2)
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 16)
    }
    .refreshable { await refresh() }
  }

  // MARK: - Cards

  @ViewBuilder
  private var activeToolCard: some View {
    let toolLabel = workToolsDisplayName(state?.activeTool)
    ADEGlassSection(
      title: toolLabel.map { "\($0) is open" } ?? "No tool is open",
      subtitle: latestObservation?.caption
    ) {
      if let frame, loadedFramePath == latestObservation?.path {
        Image(uiImage: frame)
          .resizable()
          .scaledToFit()
          .frame(maxWidth: .infinity)
          .background(Color.black.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
          .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
          .accessibilityLabel(latestObservation?.caption ?? "Latest captured frame")
      } else if latestObservation != nil {
        HStack(spacing: 10) {
          ProgressView()
          Text("Loading the last frame…")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      } else {
        Text("Nothing has been captured in this lane yet.")
          .font(.footnote)
          .foregroundStyle(ADEColor.textSecondary)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
  }

  @ViewBuilder
  private var browserCard: some View {
    ADEGlassSection(title: "Browser", subtitle: browserSubtitle) {
      if let reason = handoffReason {
        // The lane is not stuck, it is waiting on a person. Say so first —
        // read-only, because the sign-in has to happen in the desktop browser.
        HStack(alignment: .top, spacing: 8) {
          Image(systemName: "hand.raised.fill")
            .font(.caption)
            .foregroundStyle(ADEColor.warning)
          VStack(alignment: .leading, spacing: 2) {
            Text("Agent is waiting for you to sign in on the desktop")
              .font(.footnote.weight(.medium))
              .foregroundStyle(ADEColor.textPrimary)
            Text(reason)
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.bottom, 8)
      }
      if let tabs = state?.browser?.tabs, !tabs.isEmpty {
        VStack(alignment: .leading, spacing: 10) {
          ForEach(tabs) { tab in
            WorkToolsTabRow(tab: tab)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      } else {
        Text(state?.browser == nil ? browserUnavailableMessage : "No tabs are open in this lane.")
          .font(.footnote)
          .foregroundStyle(ADEColor.textSecondary)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
  }

  @ViewBuilder
  private var appControlCard: some View {
    ADEGlassSection(title: "App Control") {
      if let appControl = state?.appControl {
        VStack(alignment: .leading, spacing: 3) {
          Text(appControl.appName)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
          Text("\(appControl.status) · \(appControl.driver)")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      } else {
        Text("No app is attached in this lane.")
          .font(.footnote)
          .foregroundStyle(ADEColor.textSecondary)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
  }

  private var loadingState: some View {
    VStack(spacing: 12) {
      ProgressView()
      Text("Reading your Mac…")
        .font(.footnote)
        .foregroundStyle(ADEColor.textSecondary)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private var noDesktopState: some View {
    VStack(spacing: 12) {
      Image(systemName: "desktopcomputer")
        .font(.title3.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
      Text("Tools run on the desktop. Open ADE on your Mac to see them here.")
        .font(.footnote)
        .foregroundStyle(ADEColor.textSecondary)
        .multilineTextAlignment(.center)
        .padding(.horizontal, 28)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  // MARK: - Data

  /// The first open login handoff in this lane, if any.
  private var handoffReason: String? {
    state?.browser?.tabs.compactMap(\.handoffReason).first
  }

  /// Why there is no browser to show. The desktop distinguishes five cases
  /// (`WorkToolsUnavailableReason`) and only one of them is "open ADE on your
  /// Mac" — telling a user to open an app that is already open, because the
  /// read failed, sends them chasing the wrong thing. An unknown or absent
  /// reason falls back to the common case rather than inventing a diagnosis.
  ///
  /// Keep these sentences byte-identical to `workToolsUnavailableMessage` in
  /// `apps/desktop/src/shared/types/workTools.ts`: this switch cannot import
  /// it, so a reason worded there and not here silently reads as the default.
  private var browserUnavailableMessage: String {
    switch state?.browserUnavailable {
    case "unsupported":
      return "The browser isn't available on this machine."
    case "error":
      return "Couldn't read the browser's state."
    case "desktop_not_attached_for_project":
      // Distinct from the default on purpose: ADE Desktop *is* running, it
      // just doesn't have this project open, so "open ADE on your Mac" would
      // send the user to look at an app that is already in front of them.
      return "ADE Desktop doesn't have this project open. Open it on your Mac to see its tabs."
    case "browser_pane_not_opened":
      // Narrower still: the project IS open on the desktop, only the Browser
      // pane is unused, so the instruction is one click — not "open the
      // project", which would be a lie about something already in front of them.
      return "Open the Browser tool on the desktop to see tabs here."
    default:
      return "The browser runs in ADE Desktop. Open ADE on your Mac to see its tabs."
    }
  }

  private var browserSubtitle: String? {
    guard let tabs = state?.browser?.tabs, !tabs.isEmpty else { return nil }
    return tabs.count == 1 ? "1 tab" : "\(tabs.count) tabs"
  }

  /// The frame to show above the fold: the pane the desktop has open wins, and
  /// otherwise whichever tool captured something.
  private var latestObservation: WorkToolsObservation? {
    guard let state else { return nil }
    if state.activeTool == "app-control" {
      return state.appControl?.latestObservation ?? state.browser?.latestObservation
    }
    return state.browser?.latestObservation ?? state.appControl?.latestObservation
  }

  private func refresh() async {
    let next = try? await syncService.fetchWorkToolsLaneState(laneId: laneId)
    guard !Task.isCancelled else { return }
    state = next
    loaded = true
    await loadFrameIfNeeded()
  }

  private func loadFrameIfNeeded() async {
    guard let path = latestObservation?.path else {
      frame = nil
      loadedFramePath = nil
      return
    }
    guard loadedFramePath != path else { return }
    let cacheKey = "work-tools-observation::\(path)"
    if let cached = ADEImageCache.shared.cachedImage(for: cacheKey) {
      frame = cached
      loadedFramePath = path
      return
    }
    guard let preview = try? await syncService.readWorkToolsObservationPreview(path: path) else { return }
    guard !Task.isCancelled else { return }
    guard let data = Self.decodeDataUrl(preview.dataUrl), let image = UIImage(data: data) else { return }
    ADEImageCache.shared.store(data, for: cacheKey)
    frame = image
    loadedFramePath = path
  }

  /// Ceiling on a decoded observation frame. These are desktop-resolution PNG
  /// screenshots, so a real one lands well under this; 8 MiB clears even a
  /// Retina full-screen capture while bounding what a malformed or oversized
  /// payload can make the phone allocate. This decode runs on every poll while
  /// the sheet is open, so an unbounded one is a repeatable allocation.
  private static let observationPreviewMaxBytes = 8 * 1024 * 1024

  /// Splits a `data:<mime>;base64,<payload>` URL. The host only ever sends this
  /// shape, but a malformed one must produce no image rather than a crash — and
  /// the size is checked before the bytes are allocated.
  static func decodeDataUrl(_ dataUrl: String) -> Data? {
    guard dataUrl.hasPrefix("data:"), let commaIndex = dataUrl.firstIndex(of: ",") else { return nil }
    let payload = String(dataUrl[dataUrl.index(after: commaIndex)...])
    return WorkChatAttachmentImagePreview.base64DecodedImageData(
      payload,
      maxBytes: observationPreviewMaxBytes
    )
  }
}

private struct WorkToolsTabRow: View {
  let tab: WorkToolsBrowserTab

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      HStack(spacing: 6) {
        Text(displayTitle)
          .font(.subheadline.weight(.medium))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
        if tab.active {
          ADEGlassStatusBadge(text: "Active", tint: ADEColor.accent)
        }
        if tab.recording {
          ADEGlassStatusBadge(text: "Recording", tint: ADEColor.danger)
        }
        Spacer(minLength: 0)
      }
      if let url = tab.url, !url.isEmpty {
        Text(url)
          .font(.caption)
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(1)
          .truncationMode(.middle)
      }
      if tab.ownerChatSessionId?.isEmpty == false {
        Text("Claimed by a chat in this lane")
          .font(.caption2)
          .foregroundStyle(ADEColor.textMuted)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .combine)
  }

  private var displayTitle: String {
    if let title = tab.title, !title.isEmpty { return title }
    return "Untitled tab"
  }
}
