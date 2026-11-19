import Foundation
import SwiftUI
import UIKit
import WebKit

// The ADE Cloud iPhone on the phone: the iOS Simulator ADE runs at NoMac for
// the account, opened from the chat's Tools menu. The chat's machine brokers
// every command (`cloudPhone.*`); the live picture is NoMac's own page in a
// web view that can go nowhere else.

/// The sheet: minutes left, start, stop, a screenshot, and the phone itself
/// once it is ready.
struct CloudIphoneSheet: View {
  @StateObject private var model: CloudIphoneModel
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase
  /// Bumped by Try again, and after Start or Stop, to restart the read loop.
  @State private var pollGeneration = 0

  init(sessionId: String, syncService: SyncService) {
    _model = StateObject(wrappedValue: CloudIphoneModel(sessionId: sessionId, syncService: syncService))
  }

  var body: some View {
    NavigationStack {
      content
        .adeScreenBackground()
        .navigationTitle("ADE Cloud iPhone")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .topBarTrailing) {
            Button(role: .close) { dismiss() }
              .accessibilityLabel("Close")
          }
        }
    }
    .task(id: pollKey) {
      guard scenePhase == .active else { return }
      await model.run()
    }
    .adeToast($model.toast)
  }

  /// Read while the sheet is up and the app is in front: a phone that starts
  /// keeps its progress moving, and one that is off notices access changes.
  private var pollKey: String { "\(scenePhase == .active)-\(pollGeneration)" }

  @ViewBuilder
  private var content: some View {
    if !model.supported {
      noticeContent("The machine this chat runs on needs a newer ADE to show the ADE Cloud iPhone.")
    } else if let status = model.status {
      if !status.isOn {
        accessContent(status)
      } else if status.isReady {
        readyContent(status)
      } else if status.isStarting || model.starting {
        startingContent(status)
      } else {
        offContent(status)
      }
    } else if let message = model.loadError {
      failedContent(message)
    } else {
      ProgressView("Loading the ADE Cloud iPhone…")
        .font(.system(size: 13))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
  }

  // MARK: - Not on this account

  private func accessContent(_ status: CloudIphoneStatus) -> some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        VStack(alignment: .leading, spacing: 10) {
          ADEKitTag(text: status.access == "soon" ? "Coming soon" : "Not available")
          Text(status.reason ?? cloudIphoneAccessFallback(status.access))
            .font(.system(size: 13.5))
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        .adeKitCard()
        Spacer(minLength: 0)
      }
      .padding(16)
    }
  }

  // MARK: - Starting

  private func startingContent(_ status: CloudIphoneStatus) -> some View {
    VStack(alignment: .leading, spacing: 14) {
      header(status)
      VStack(alignment: .leading, spacing: 10) {
        HStack(spacing: 10) {
          ProgressView()
          Text(cloudIphoneStartingLine(status))
            .font(.system(size: 14, weight: .medium))
            .foregroundStyle(ADEColor.textPrimary)
            .fixedSize(horizontal: false, vertical: true)
        }
        Text("The chat's agents can use it as soon as it's ready.")
          .font(.system(size: 12.5))
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      .adeKitCard()
      Spacer(minLength: 0)
    }
    .padding(16)
  }

  // MARK: - Off

  private func offContent(_ status: CloudIphoneStatus) -> some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        header(status)
        if let error = model.actionError {
          ADESettingsNotice(message: error, tone: .warn)
        }
        VStack(alignment: .leading, spacing: 12) {
          if let line = cloudIphoneEndLine(status.phone) {
            Text(line)
              .font(.system(size: 13.5))
              .foregroundStyle(ADEColor.textSecondary)
              .fixedSize(horizontal: false, vertical: true)
          }
          Button {
            ADEHaptics.light()
            Task {
              await model.start()
              pollGeneration += 1
            }
          } label: {
            if model.starting {
              HStack(spacing: 8) {
                ProgressView().tint(.white)
                Text("Starting…")
              }
            } else {
              Label("Start phone", systemImage: "play.fill")
            }
          }
          .buttonStyle(ADEKitButtonStyle(prominent: true, wide: true))
          .disabled(model.starting)
          Text("Starts an \(cloudIphoneDeviceName("iphone")) simulator in the cloud. Time on it comes out of the plan's iPhone minutes.")
            .font(.system(size: 12))
            .foregroundStyle(ADEColor.textMuted)
            .fixedSize(horizontal: false, vertical: true)
        }
        .adeKitCard()
        Spacer(minLength: 0)
      }
      .padding(16)
    }
  }

  // MARK: - Ready

  private func readyContent(_ status: CloudIphoneStatus) -> some View {
    VStack(spacing: 10) {
      header(status)
        .padding(.horizontal, 16)
      if let notice = cloudIphoneStopNotice(status) {
        Text(notice)
          .font(.system(size: 12))
          .foregroundStyle(ADEColor.warning)
          .fixedSize(horizontal: false, vertical: true)
          .padding(.horizontal, 16)
      }
      if let error = model.actionError {
        ADESettingsNotice(message: error, tone: .warn)
          .padding(.horizontal, 16)
      }
      GeometryReader { proxy in
        phoneFrame(proxy: proxy, device: status.phone?.device)
      }
      .padding(.horizontal, 16)
      controls
    }
    .padding(.top, 4)
  }

  private func phoneFrame(proxy: GeometryProxy, device: String?) -> some View {
    let points = cloudIphonePointSize(device)
    let aspect = points.width / points.height
    let width = max(1, min(proxy.size.width, proxy.size.height * aspect))
    let height = width / aspect
    return ZStack {
      RoundedRectangle(cornerRadius: 24, style: .continuous)
        .fill(Color.black)
      if let link = model.link, let url = cloudIphoneViewURL(link.url), model.linkError == nil {
        CloudIphoneWebView(url: url, loadError: $model.linkError)
      } else if model.linkLoading {
        ProgressView().tint(.white)
      } else if let error = model.linkError {
        VStack(spacing: 10) {
          Text(error)
            .font(.system(size: 12.5))
            .foregroundStyle(.white.opacity(0.8))
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
          Button("Try again", action: retry)
            .buttonStyle(ADEKitButtonStyle())
        }
        .padding(20)
      } else {
        ProgressView().tint(.white)
      }
    }
    .frame(width: width, height: height)
    .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("\(cloudIphoneDeviceName(device)) screen")
  }

  private var controls: some View {
    HStack(spacing: 8) {
      Button {
        ADEHaptics.light()
        Task { await model.screenshot() }
      } label: {
        if model.screenshotting {
          ProgressView()
        } else {
          Label("Screenshot", systemImage: "camera")
        }
      }
      .buttonStyle(ADEKitButtonStyle())
      .disabled(model.screenshotting || model.stopping)

      Spacer(minLength: 8)

      Button {
        ADEHaptics.light()
        Task {
          await model.stop()
          pollGeneration += 1
        }
      } label: {
        if model.stopping {
          ProgressView()
        } else {
          Label("Stop", systemImage: "stop.fill")
        }
      }
      .buttonStyle(ADEKitButtonStyle(tone: .crit))
      .disabled(model.stopping || model.screenshotting)
      .accessibilityHint("Ends the cloud iPhone. Its apps and their data go; the project stays.")
    }
    .padding(.horizontal, 16)
    .padding(.bottom, 10)
  }

  // MARK: - Shared pieces

  private func header(_ status: CloudIphoneStatus) -> some View {
    HStack(spacing: 8) {
      ADEKitDot(tone: status.isReady ? .ok : (status.isStarting ? .warn : .neutral), size: 7)
      Text(cloudIphoneDeviceName(status.phone?.device))
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)
      Spacer(minLength: 8)
      if let minutes = status.minutes {
        Text("\(minutes.left) min left")
          .font(.adeMono(12.5))
          .foregroundStyle(minutes.left > 0 ? ADEColor.textSecondary : ADEColor.danger)
          .lineLimit(1)
          .accessibilityLabel("\(minutes.left) minutes left of \(minutes.included) this period")
      }
    }
  }

  private func failedContent(_ message: String) -> some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        ADESettingsNotice(message: message, tone: .warn, actionTitle: "Try again", action: retry)
      }
      .padding(16)
    }
  }

  private func noticeContent(_ message: String) -> some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        ADESettingsNotice(message: message, tone: .neutral)
      }
      .padding(16)
    }
  }

  private func retry() {
    model.prepareToRetry()
    pollGeneration += 1
  }
}

// MARK: - Model

/// The sheet's state: the status, the live link and the three actions. The
/// read loop runs only while the sheet is on screen.
@MainActor
final class CloudIphoneModel: ObservableObject {
  @Published private(set) var status: CloudIphoneStatus?
  /// The first status read's failure, with Try again. Kept off when a later
  /// poll fails, so the phone on screen is not replaced by a notice.
  @Published private(set) var loadError: String?
  @Published private(set) var link: CloudIphoneViewLink?
  /// A failed link read, or the page's own failure. The web view writes it.
  @Published var linkError: String?
  @Published private(set) var linkLoading = false
  @Published private(set) var starting = false
  @Published private(set) var stopping = false
  @Published private(set) var screenshotting = false
  @Published private(set) var actionError: String?
  @Published var toast: ADEToastMessage?

  let sessionId: String
  private let service: SyncService
  /// Only the newest read lands.
  private var statusRequest = 0
  private var linkRequest = 0
  /// When the link is replaced (ms): a minute before it expires.
  private var linkDueAt: Double = 0

  /// While it starts, or waits in line for a free phone.
  static let startingPollNanoseconds: UInt64 = 3_000_000_000
  /// While it is off: access can change on the account.
  static let offPollNanoseconds: UInt64 = 20_000_000_000
  /// While it is ready: the page sends no news when the phone stops on its
  /// own (idle, its time limit), so the status is read this often.
  static let livePollMilliseconds: Double = 30_000
  /// A link is replaced this long before it stops working.
  static let linkRefreshLeadMilliseconds: Double = 60_000
  /// An answer that names no expiry is asked for again this often, never in
  /// a tight loop.
  static let linkRetryWithoutExpiryMilliseconds: Double = 60_000

  init(sessionId: String, syncService: SyncService) {
    self.sessionId = sessionId
    self.service = syncService
  }

  var supported: Bool { service.supportsCloudIphone(sessionId: sessionId) }

  /// Read while the sheet is up: every 3 s while it starts, every 20 s while
  /// it is off, and every 30 s while it is ready, so a phone that stopped on
  /// its own shows Start again. While ready the link is also kept alive.
  func run() async {
    guard supported else { return }
    if status == nil { await refreshStatus() }
    while !Task.isCancelled {
      if status?.isReady == true {
        if link == nil, linkError == nil { await refreshLink() }
        guard link != nil, linkError == nil else { return }
        let untilLinkDue = linkDueAt - Date().timeIntervalSince1970 * 1000
        if untilLinkDue > 0 {
          let wait = min(untilLinkDue, Self.livePollMilliseconds)
          do { try await Task.sleep(nanoseconds: UInt64(wait * 1_000_000)) } catch { return }
          guard !Task.isCancelled else { return }
          await refreshStatus()
          // Ended: the off state reads on. Still on: the link waits its turn.
          if status?.isReady != true || linkDueAt > Date().timeIntervalSince1970 * 1000 { continue }
        }
        await refreshLink()
        guard link != nil, linkError == nil else { return }
        continue
      }
      let startingNow = status?.isStarting == true || starting
      let wait = startingNow ? Self.startingPollNanoseconds : Self.offPollNanoseconds
      do { try await Task.sleep(nanoseconds: wait) } catch { return }
      guard !Task.isCancelled else { return }
      await refreshStatus()
    }
  }

  func refreshStatus() async {
    guard supported else { return }
    statusRequest += 1
    let request = statusRequest
    do {
      let next = try await service.fetchCloudIphoneStatus(sessionId: sessionId)
      guard request == statusRequest else { return }
      status = next
      loadError = nil
      if !next.isReady {
        link = nil
        linkError = nil
      }
    } catch {
      guard request == statusRequest else { return }
      if status == nil { loadError = Self.message(for: error) }
    }
  }

  func refreshLink() async {
    guard supported else { return }
    linkRequest += 1
    let request = linkRequest
    linkLoading = true
    linkError = nil
    defer { if request == linkRequest { linkLoading = false } }
    do {
      let next = try await service.fetchCloudIphoneView(sessionId: sessionId, control: true)
      guard request == linkRequest else { return }
      guard cloudIphoneViewURL(next.url) != nil else {
        // The brain's answer was fine, so only the phone sees this: it reports it.
        CrashReporting.capture(
          NSError(domain: "ADE.CloudIphone", code: 1, userInfo: [NSLocalizedDescriptionKey: "The view link isn't one the sheet can open."]),
          context: ["area": "cloud_iphone.view_link"]
        )
        linkError = "The cloud answered with a link ADE can't open."
        return
      }
      link = next
      // A minute before it expires; an answer that names no expiry is asked
      // for again after a minute, never in a tight loop.
      let now = Date().timeIntervalSince1970 * 1000
      linkDueAt = next.expiresAt > 0
        ? min(max(next.expiresAt - Self.linkRefreshLeadMilliseconds, now + Self.linkRetryWithoutExpiryMilliseconds), now + 86_400_000)
        : now + Self.linkRetryWithoutExpiryMilliseconds
    } catch {
      guard request == linkRequest else { return }
      linkError = Self.message(for: error)
    }
  }

  func start() async {
    guard !starting else { return }
    starting = true
    actionError = nil
    defer { starting = false }
    do {
      try await service.startCloudIphone(sessionId: sessionId)
      await refreshStatus()
    } catch {
      actionError = Self.message(for: error)
      ADEHaptics.error()
    }
  }

  func stop() async {
    guard !stopping else { return }
    stopping = true
    actionError = nil
    defer { stopping = false }
    do {
      _ = try await service.stopCloudIphone(sessionId: sessionId)
      link = nil
      linkError = nil
      ADEHaptics.success()
    } catch {
      actionError = Self.message(for: error)
      ADEHaptics.error()
    }
    await refreshStatus()
  }

  func screenshot() async {
    guard !screenshotting else { return }
    screenshotting = true
    actionError = nil
    defer { screenshotting = false }
    do {
      let artifactId = try await service.captureCloudIphoneScreenshot(sessionId: sessionId)
      ADEHaptics.success()
      toast = ADEToastMessage(
        text: artifactId == nil
          ? "Screenshot taken, but it couldn't be added to Proof."
          : "Screenshot saved to Proof.",
        kind: artifactId == nil ? .info : .success
      )
    } catch {
      actionError = Self.message(for: error)
      ADEHaptics.error()
    }
  }

  /// Try again drops a failed page or link so the loop reads a fresh one.
  func prepareToRetry() {
    actionError = nil
    loadError = nil
    if linkError != nil {
      linkError = nil
      link = nil
    }
  }

  private static func message(for error: Error) -> String {
    cloudPhoneWords(SyncUserFacingError.message(for: error))
      ?? "The ADE Cloud iPhone couldn't do that."
  }
}

// MARK: - The page

/// NoMac's control page in a web view that can go nowhere else: no new
/// windows, no link previews, no page it did not come from.
private struct CloudIphoneWebView: UIViewRepresentable {
  let url: URL
  @Binding var loadError: String?

  func makeCoordinator() -> Coordinator { Coordinator(loadError: $loadError) }

  func makeUIView(context: Context) -> WKWebView {
    let webView = WorkSandboxedWebView.make(
      frame: .zero,
      configuration: WorkSandboxedWebView.configuration(),
      navigationDelegate: context.coordinator
    )
    context.coordinator.loadedURL = url
    webView.load(URLRequest(url: url))
    return webView
  }

  func updateUIView(_ webView: WKWebView, context: Context) {
    guard context.coordinator.loadedURL != url else { return }
    context.coordinator.loadedURL = url
    webView.load(URLRequest(url: url))
  }

  static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
    webView.stopLoading()
    webView.navigationDelegate = nil
    webView.uiDelegate = nil
  }

  @MainActor
  final class Coordinator: NSObject, WKNavigationDelegate {
    var loadedURL: URL?
    private let loadError: Binding<String?>

    init(loadError: Binding<String?>) {
      self.loadError = loadError
    }

    func webView(
      _ webView: WKWebView,
      decidePolicyFor navigationAction: WKNavigationAction,
      decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
    ) {
      // A frame of the page's own is not the viewer navigating.
      if navigationAction.targetFrame?.isMainFrame == false {
        decisionHandler(.allow)
        return
      }
      guard let url = navigationAction.request.url, cloudIphoneAllowsNavigation(url) else {
        decisionHandler(.cancel)
        return
      }
      decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
      loadError.wrappedValue = nil
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
      pageFailed(error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
      pageFailed(error)
    }

    /// The live page failing to load is seen only here, so the phone reports
    /// it (`capture` drops offline and other benign network states). The
    /// brain reports every failed call it answers, so those are not sent twice.
    private func pageFailed(_ error: Error) {
      let message = cloudIphonePageError(error)
      if message != nil { CrashReporting.capture(error, context: ["area": "cloud_iphone.page"]) }
      loadError.wrappedValue = message
    }
  }
}

// MARK: - Words and sizes

/// The phone's model, from the status's device id.
func cloudIphoneDeviceName(_ device: String?) -> String {
  switch device {
  case "ipad": return "iPad Pro 11-inch (M5)"
  case "iphone-pro-max": return "iPhone 17 Pro Max"
  default: return "iPhone 17 Pro"
  }
}

/// The phone's own points, the same shape the desktop's body draws.
func cloudIphonePointSize(_ device: String?) -> CGSize {
  switch device {
  case "ipad": return CGSize(width: 834, height: 1210)
  case "iphone-pro-max": return CGSize(width: 440, height: 956)
  default: return CGSize(width: 402, height: 874)
  }
}

/// NoMac's viewer page, and nothing else.
func cloudIphoneViewURL(_ raw: String) -> URL? {
  guard let url = URL(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
        url.scheme?.lowercased() == "https",
        url.host?.lowercased() == "nomac.app",
        url.path.hasPrefix("/simulator-use/view/")
  else { return nil }
  return url
}

/// A page the viewer may navigate to: NoMac's own site only.
func cloudIphoneAllowsNavigation(_ url: URL) -> Bool {
  url.scheme?.lowercased() == "https" && url.host?.lowercased() == "nomac.app"
}

/// Why the phone ended, in the phone's words.
func cloudIphoneEndLine(_ phone: CloudIphoneStatus.Phone?) -> String? {
  guard let phone, phone.state == "ended" else { return nil }
  switch phone.endReason {
  case "stopped": return "You stopped it."
  case "idle": return "It stopped after 5 minutes with no use."
  case "time_limit": return "It reached its 2-hour limit."
  case "spend_cap": return "It used the minutes this plan includes."
  default: return "It ended."
  }
}

/// The line under the header while the phone starts.
func cloudIphoneStartingLine(_ status: CloudIphoneStatus, now: Date = Date()) -> String {
  if let queueUntil = status.phone?.queueUntil, queueUntil > now.timeIntervalSince1970 * 1000 {
    return "Waiting for a free phone. It starts by \(cloudIphoneTime(queueUntil))."
  }
  return "Starting the \(cloudIphoneDeviceName(status.phone?.device))…"
}

/// A sentence about the phone's coming stop, while one is up.
func cloudIphoneStopNotice(_ status: CloudIphoneStatus) -> String? {
  guard status.isReady,
        let notice = status.phone?.stopNotice?.trimmingCharacters(in: .whitespacesAndNewlines),
        !notice.isEmpty
  else { return nil }
  return notice
}

/// "3:42 PM" in the phone's own clock.
func cloudIphoneTime(_ ms: Double) -> String {
  let formatter = DateFormatter()
  formatter.locale = Locale.current
  formatter.timeStyle = .short
  formatter.dateStyle = .none
  return formatter.string(from: Date(timeIntervalSince1970: ms / 1000))
}

/// Why the phone cannot be shown, when the host sends no sentence.
func cloudIphoneAccessFallback(_ access: String) -> String {
  access == "soon"
    ? "The ADE Cloud iPhone is coming soon. It isn't on this account yet."
    : "The ADE Cloud iPhone isn't available right now."
}

/// A page failure a person can read; a cancelled navigation is not one.
func cloudIphonePageError(_ error: Error) -> String? {
  let ns = error as NSError
  if ns.domain == NSURLErrorDomain, ns.code == NSURLErrorCancelled { return nil }
  return "The phone's page couldn't load. \(ns.localizedDescription)"
}
