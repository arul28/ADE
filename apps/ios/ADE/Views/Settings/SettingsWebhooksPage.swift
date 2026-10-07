import SwiftUI
import UIKit

/// Webhook automations, read-only. Automations run on the user's computer;
/// the phone shows each webhook's URL (to copy into a service), whether its
/// signing secret is saved, and every request that rang it, including the
/// ones ADE skipped and why. Mirrors the desktop/web `WebhookOverview`.

// MARK: - Wire models (`automations.webhook*` remote commands)

struct MobileWebhookLastDelivery: Decodable, Equatable {
  var id: String
  var outcome: String
  var receivedAt: String
  var eventLabel: String?
  var detail: String?
}

struct MobileWebhookAutomation: Decodable, Identifiable, Equatable {
  var ruleId: String
  var ruleName: String
  var enabled: Bool
  var hookId: String
  var preset: String
  var url: String?
  var route: String?
  var ownedHere: Bool
  var signatureRequired: Bool
  var secretName: String?
  var secretSaved: Bool
  var filters: [String]
  var chatSessionId: String?
  var lastDelivery: MobileWebhookLastDelivery?

  var id: String { hookId }
}

struct MobileWebhookDeliverySummary: Decodable, Identifiable, Equatable {
  var id: String
  var hookId: String
  var via: String
  var method: String
  var receivedAt: String
  var outcome: String
  var detail: String?
  var signature: String
  var eventLabel: String?
  var runId: String?
  var chatSessionId: String?
}

struct MobileWebhookDelivery: Decodable, Equatable {
  var id: String
  var via: String
  var method: String
  var receivedAt: String
  var outcome: String
  var detail: String?
  var signature: String
  var eventLabel: String?
  var headers: [String: String]
  var body: String
  var bodyTruncated: Bool
  var prompt: String?
}

// MARK: - Presentation helpers

enum WebhookPresentation {
  static func serviceName(_ preset: String) -> String {
    switch preset {
    case "github": return "GitHub"
    case "stripe": return "Stripe"
    case "linear": return "Linear"
    case "sentry": return "Sentry"
    default: return "Any service"
    }
  }

  /// Same words and colors as the desktop deliveries list.
  static func outcome(_ outcome: String) -> (label: String, tint: Color) {
    switch outcome {
    case "ran": return ("Ran", ADEColor.success)
    case "no_rule": return ("Not saved yet", ADEColor.info)
    case "disabled": return ("Paused", ADEColor.textMuted)
    case "filtered": return ("Skipped", ADEColor.textMuted)
    case "duplicate": return ("Duplicate", ADEColor.textMuted)
    case "expired": return ("Too old", ADEColor.warning)
    case "bad_signature": return ("Bad signature", ADEColor.danger)
    case "missing_signature": return ("No signature", ADEColor.danger)
    case "rate_limited": return ("Rate limited", ADEColor.warning)
    case "too_large": return ("Too large", ADEColor.warning)
    default: return ("Run failed", ADEColor.danger)
    }
  }

  static func relative(_ iso: String) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    guard let date = formatter.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return iso }
    return RelativeDateTimeFormatter().localizedString(for: date, relativeTo: Date())
  }
}

// MARK: - SyncService

extension SyncService {
  /// Feature-detected: a host from before webhook automations omits these.
  var supportsWebhookAutomations: Bool {
    supportsRemoteAction("automations.webhookList")
  }

  func fetchWebhookAutomations() async throws -> [MobileWebhookAutomation] {
    try decode(
      try await sendCommand(action: "automations.webhookList", args: [:], disconnectOnTimeout: false),
      as: [MobileWebhookAutomation].self
    )
  }

  func fetchWebhookDeliveries(hookId: String) async throws -> [MobileWebhookDeliverySummary] {
    try decode(
      try await sendCommand(
        action: "automations.webhookListDeliveries",
        args: ["hookId": hookId, "limit": 20],
        disconnectOnTimeout: false
      ),
      as: [MobileWebhookDeliverySummary].self
    )
  }

  func fetchWebhookDelivery(id: String) async throws -> MobileWebhookDelivery? {
    let raw = try await sendCommand(action: "automations.webhookGetDelivery", args: ["id": id], disconnectOnTimeout: false)
    if raw is NSNull { return nil }
    return try decode(raw, as: MobileWebhookDelivery.self)
  }
}

// MARK: - Views

struct SettingsWebhooksPage: View {
  @ObservedObject var syncService: SyncService
  @State private var automations: [MobileWebhookAutomation]?
  @State private var errorMessage: String?

  var body: some View {
    List {
      Section {
        Text("Automations run in ADE on your computer. Here you can see each webhook's URL and every request that rang it, including the ones ADE skipped and why.")
          .font(.footnote)
          .foregroundStyle(ADEColor.textSecondary)
          .adeFlatRow()
      }
      if let errorMessage {
        Section {
          Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
            .font(.footnote)
            .foregroundStyle(ADEColor.warning)
            .adeFlatRow()
        }
      }
      if let automations {
        if automations.isEmpty {
          Section {
            ADEEmptyStateView(
              symbol: "bell.badge",
              title: "No webhooks yet",
              message: "Make one in ADE on your computer: Automations → New → Webhook."
            )
            .frame(maxWidth: .infinity)
            .adeFlatRow()
          }
        } else {
          Section {
            ForEach(automations) { automation in
              NavigationLink {
                WebhookAutomationDetailPage(syncService: syncService, automation: automation)
              } label: {
                WebhookAutomationRow(automation: automation)
              }
              .adeFlatRow()
            }
          } header: {
            ADEFlatSectionHeader("Webhooks", detail: "\(automations.count)")
          }
        }
      } else if errorMessage == nil {
        Section {
          ProgressView().frame(maxWidth: .infinity).adeFlatRow()
        }
      }
    }
    .adeFlatList()
    .navigationTitle("Webhooks")
    .navigationBarTitleDisplayMode(.inline)
    .refreshable { await load() }
    .task { await load() }
  }

  private func load() async {
    guard syncService.supportsWebhookAutomations else {
      errorMessage = "Update ADE on your computer to see webhooks here."
      automations = []
      return
    }
    do {
      automations = try await syncService.fetchWebhookAutomations()
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
      if automations == nil { automations = [] }
    }
  }
}

struct WebhookAutomationRow: View {
  let automation: MobileWebhookAutomation

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 6) {
        Text(automation.ruleName)
          .font(.body.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
        if !automation.enabled {
          ADEStatusPill(text: "OFF", tint: ADEColor.textMuted)
        }
      }
      Text(WebhookPresentation.serviceName(automation.preset)
        + (automation.filters.isEmpty ? " · every request" : " · only when \(automation.filters.joined(separator: " and "))"))
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)
        .lineLimit(2)
      if let last = automation.lastDelivery {
        let outcome = WebhookPresentation.outcome(last.outcome)
        Text("\(outcome.label) · \(WebhookPresentation.relative(last.receivedAt))")
          .font(.caption2.weight(.semibold))
          .foregroundStyle(outcome.tint)
      } else {
        Text("No deliveries yet")
          .font(.caption2)
          .foregroundStyle(ADEColor.textMuted)
      }
    }
    .padding(.vertical, 2)
  }
}

struct WebhookAutomationDetailPage: View {
  @ObservedObject var syncService: SyncService
  let automation: MobileWebhookAutomation
  @State private var deliveries: [MobileWebhookDeliverySummary]?
  @State private var errorMessage: String?
  @State private var openDelivery: MobileWebhookDeliverySummary?
  @State private var copied = false

  var body: some View {
    List {
      Section {
        if let url = automation.url {
          Button {
            UIPasteboard.general.string = url
            copied = true
          } label: {
            VStack(alignment: .leading, spacing: 6) {
              Text(url)
                .font(.adeMono(11.5))
                .foregroundStyle(ADEColor.textPrimary)
                .lineLimit(2)
                .truncationMode(.middle)
              Label(copied ? "Copied" : "Tap to copy · treat it like a password", systemImage: copied ? "checkmark.circle.fill" : "doc.on.doc")
                .font(.caption)
                .foregroundStyle(copied ? ADEColor.success : ADEColor.accent)
            }
          }
          .adeFlatRow()
          if automation.route != "relay" && automation.route != "gateway" {
            Label("Reachable only from the computer it was made on until you sign in to ADE there.", systemImage: "exclamationmark.triangle")
              .font(.caption)
              .foregroundStyle(ADEColor.warning)
              .adeFlatRow()
          }
        } else {
          Text("This URL belongs to another machine.")
            .font(.footnote)
            .foregroundStyle(ADEColor.textSecondary)
            .adeFlatRow()
        }
        signatureRow.adeFlatRow()
      } header: {
        ADEFlatSectionHeader(WebhookPresentation.serviceName(automation.preset))
      }

      Section {
        if let errorMessage {
          Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
            .font(.footnote)
            .foregroundStyle(ADEColor.warning)
            .adeFlatRow()
        } else if let deliveries {
          if deliveries.isEmpty {
            Text("Nothing yet. Requests show up here the moment they arrive.")
              .font(.footnote)
              .foregroundStyle(ADEColor.textSecondary)
              .adeFlatRow()
          } else {
            ForEach(deliveries) { delivery in
              Button { openDelivery = delivery } label: { WebhookDeliveryRow(delivery: delivery) }
                .adeFlatRow()
            }
          }
        } else {
          ProgressView().frame(maxWidth: .infinity).adeFlatRow()
        }
      } header: {
        ADEFlatSectionHeader("Deliveries")
      }
    }
    .adeFlatList()
    .navigationTitle(automation.ruleName)
    .navigationBarTitleDisplayMode(.inline)
    .refreshable { await load() }
    .task { await load() }
    .sheet(item: $openDelivery) { delivery in
      NavigationStack {
        WebhookDeliveryDetailView(syncService: syncService, summary: delivery)
      }
      .presentationDetents([.medium, .large])
    }
  }

  @ViewBuilder
  private var signatureRow: some View {
    if automation.signatureRequired {
      if automation.secretSaved {
        Label("Signed · \(automation.secretName ?? "secret") saved", systemImage: "checkmark.shield.fill")
          .font(.footnote)
          .foregroundStyle(ADEColor.success)
      } else {
        Label("Signing secret \(automation.secretName ?? "") not saved yet", systemImage: "exclamationmark.shield.fill")
          .font(.footnote)
          .foregroundStyle(ADEColor.warning)
      }
    } else {
      Label("No signature required", systemImage: "shield")
        .font(.footnote)
        .foregroundStyle(ADEColor.textSecondary)
    }
  }

  private func load() async {
    do {
      deliveries = try await syncService.fetchWebhookDeliveries(hookId: automation.hookId)
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
      if deliveries == nil { deliveries = [] }
    }
  }
}

struct WebhookDeliveryRow: View {
  let delivery: MobileWebhookDeliverySummary

  var body: some View {
    let outcome = WebhookPresentation.outcome(delivery.outcome)
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      ADEStatusPill(text: outcome.label, tint: outcome.tint)
      VStack(alignment: .leading, spacing: 2) {
        Text(delivery.eventLabel ?? "\(delivery.method) request")
          .font(.subheadline)
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
        if let detail = delivery.detail, delivery.outcome != "ran" {
          Text(detail)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(2)
        }
      }
      Spacer(minLength: 4)
      Text(WebhookPresentation.relative(delivery.receivedAt))
        .font(.caption2)
        .foregroundStyle(ADEColor.textMuted)
    }
  }
}

struct WebhookDeliveryDetailView: View {
  @ObservedObject var syncService: SyncService
  let summary: MobileWebhookDeliverySummary
  @State private var delivery: MobileWebhookDelivery?
  @State private var loaded = false

  var body: some View {
    WebhookDeliveryDetailContent(summary: summary, delivery: delivery, loaded: loaded)
      .navigationTitle("Delivery")
      .navigationBarTitleDisplayMode(.inline)
      .task {
        delivery = try? await syncService.fetchWebhookDelivery(id: summary.id)
        loaded = true
      }
  }
}

/// The detail body, from data alone (also what the previews render).
struct WebhookDeliveryDetailContent: View {
  let summary: MobileWebhookDeliverySummary
  let delivery: MobileWebhookDelivery?
  let loaded: Bool

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        let outcome = WebhookPresentation.outcome(summary.outcome)
        HStack(spacing: 8) {
          ADEStatusPill(text: outcome.label, tint: outcome.tint)
          Text(summary.eventLabel ?? summary.method)
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
        }
        Text(summary.outcome == "ran" && summary.detail == nil ? "Passed every check and started a run." : (summary.detail ?? ""))
          .font(.footnote)
          .foregroundStyle(ADEColor.textSecondary)
        if let delivery {
          codeBlock("Prompt the agent got", delivery.prompt ?? "No run started, so no prompt was sent.")
          codeBlock("Body", delivery.body.isEmpty ? "(empty)" : delivery.body)
          codeBlock("Headers", delivery.headers.sorted { $0.key < $1.key }.map { "\($0.key): \($0.value)" }.joined(separator: "\n"))
        } else if loaded {
          Text("This delivery is no longer in the log.")
            .font(.footnote)
            .foregroundStyle(ADEColor.textMuted)
        } else {
          ProgressView().frame(maxWidth: .infinity)
        }
      }
      .padding(16)
    }
    .background(ADEColor.pageBackground)
  }

  private func codeBlock(_ title: String, _ text: String) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(title.uppercased())
        .font(.caption2.weight(.semibold))
        .tracking(0.6)
        .foregroundStyle(ADEColor.textMuted)
      Text(text)
        .font(.adeMono(11))
        .foregroundStyle(ADEColor.textPrimary)
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(ADEColor.recessedBackground, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(ADEColor.glassBorder, lineWidth: 0.5))
    }
  }
}

// MARK: - Previews

private enum WebhookPreviewData {
  static let automations: [MobileWebhookAutomation] = [
    MobileWebhookAutomation(
      ruleId: "triage", ruleName: "Triage new GitHub issues", enabled: true, hookId: "wh-ffe99b2a8d842cdca2", preset: "github",
      url: "https://relay.ade-app.dev/hooks/wh-ffe99b2a8d842cdca2/MCCHDkfi19pvg_FZR", route: "relay", ownedHere: true,
      signatureRequired: true, secretName: "GITHUB_WEBHOOK_SECRET", secretSaved: true,
      filters: ["headers.x-github-event is \"issues\"", "body.action is \"opened\""], chatSessionId: nil,
      lastDelivery: MobileWebhookLastDelivery(id: "whd_1", outcome: "ran", receivedAt: "2026-10-06T20:37:23.426Z", eventLabel: "issues.opened", detail: nil)
    ),
    MobileWebhookAutomation(
      ruleId: "payments", ruleName: "Failed payments", enabled: true, hookId: "wh-96906de3ae89b89f1c", preset: "stripe",
      url: "https://relay.ade-app.dev/hooks/wh-96906de3ae89b89f1c/9XBONn_Nqus3OSoa", route: "relay", ownedHere: true,
      signatureRequired: true, secretName: "STRIPE_WEBHOOK_SECRET", secretSaved: false,
      filters: ["body.type is \"invoice.payment_failed\""], chatSessionId: nil, lastDelivery: nil
    ),
  ]
  static let deliveries: [MobileWebhookDeliverySummary] = [
    MobileWebhookDeliverySummary(id: "whd_1", hookId: "wh", via: "relay", method: "POST", receivedAt: "2026-10-06T20:37:23.426Z", outcome: "ran", detail: nil, signature: "verified", eventLabel: "issues.opened", runId: "run", chatSessionId: "chat"),
    MobileWebhookDeliverySummary(id: "whd_2", hookId: "wh", via: "relay", method: "POST", receivedAt: "2026-10-06T20:15:23.426Z", outcome: "filtered", detail: "Skipped: needs body.action is \"opened\".", signature: "verified", eventLabel: "issues.closed", runId: nil, chatSessionId: nil),
    MobileWebhookDeliverySummary(id: "whd_3", hookId: "wh", via: "relay", method: "POST", receivedAt: "2026-10-06T20:15:20.426Z", outcome: "bad_signature", detail: "The x-hub-signature-256 signature did not match.", signature: "failed", eventLabel: "issues.opened", runId: nil, chatSessionId: nil),
  ]
  static let delivery = MobileWebhookDelivery(
    id: "whd_1", via: "relay", method: "POST", receivedAt: "2026-10-06T20:37:23.426Z", outcome: "ran", detail: nil, signature: "verified",
    eventLabel: "issues.opened", headers: ["content-type": "application/json", "x-github-event": "issues"],
    body: "{\n  \"action\": \"opened\",\n  \"issue\": { \"number\": 112, \"title\": \"Export to CSV drops the last row\" }\n}",
    bodyTruncated: false,
    prompt: "Triage GitHub issue #112 in acme/web: Export to CSV drops the last row\n\nReproduce it, find the cause, and propose a fix."
  )
}

#Preview("Webhooks list") {
  NavigationStack {
    List {
      Section {
        ForEach(WebhookPreviewData.automations) { automation in
          WebhookAutomationRow(automation: automation).adeFlatRow()
        }
      } header: {
        ADEFlatSectionHeader("Webhooks", detail: "2")
      }
      Section {
        ForEach(WebhookPreviewData.deliveries) { delivery in
          WebhookDeliveryRow(delivery: delivery).adeFlatRow()
        }
      } header: {
        ADEFlatSectionHeader("Deliveries")
      }
    }
    .adeFlatList()
    .navigationTitle("Webhooks")
    .navigationBarTitleDisplayMode(.inline)
  }
}

#Preview("Delivery detail") {
  NavigationStack {
    WebhookDeliveryDetailContent(summary: WebhookPreviewData.deliveries[0], delivery: WebhookPreviewData.delivery, loaded: true)
      .navigationTitle("Delivery")
      .navigationBarTitleDisplayMode(.inline)
  }
}
