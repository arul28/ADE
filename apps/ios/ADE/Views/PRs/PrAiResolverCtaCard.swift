import SwiftUI

struct PrAiResolverCtaCard: View {
  enum Variant {
    case inline
    case prominent
  }

  let variant: Variant
  let title: String
  let subtitle: String
  let isBusy: Bool
  let isRunning: Bool
  let isLive: Bool
  let onLaunch: () -> Void
  let onStop: (() -> Void)?

  init(
    variant: Variant = .inline,
    title: String = "Resolve threads with a worker",
    subtitle: String = "Spins up pr-resolver · auto-pushes fixes",
    isBusy: Bool = false,
    isRunning: Bool = false,
    isLive: Bool = true,
    onLaunch: @escaping () -> Void,
    onStop: (() -> Void)? = nil
  ) {
    self.variant = variant
    self.title = title
    self.subtitle = subtitle
    self.isBusy = isBusy
    self.isRunning = isRunning
    self.isLive = isLive
    self.onLaunch = onLaunch
    self.onStop = onStop
  }

  var body: some View {
    HStack(alignment: .center, spacing: 10) {
      ZStack {
        RoundedRectangle(cornerRadius: 9, style: .continuous)
          .fill(ADEColor.tintPRs.opacity(0.2))
          .overlay(
            RoundedRectangle(cornerRadius: 9, style: .continuous)
              .strokeBorder(ADEColor.tintPRs.opacity(0.4), lineWidth: 0.5)
          )
        Image(systemName: "sparkles")
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(ADEColor.tintPRs)
      }
      .frame(width: 32, height: 32)

      VStack(alignment: .leading, spacing: 2) {
        Text(title)
          .font(.subheadline.weight(.bold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
        Text(isRunning ? "Worker running · auto-pushing fixes" : subtitle)
          .font(.system(.caption2, design: .monospaced))
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(2)
      }

      Spacer(minLength: 8)

      launchButton
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
    .background(gradientBackground)
    .overlay(
      RoundedRectangle(cornerRadius: 16, style: .continuous)
        .strokeBorder(ADEColor.tintPRs.opacity(0.3), lineWidth: 0.5)
    )
    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
  }

  @ViewBuilder
  private var launchButton: some View {
    if isRunning, let onStop {
      Button {
        onStop()
      } label: {
        HStack(spacing: 4) {
          if isBusy {
            ProgressView().controlSize(.mini).tint(ADEColor.danger)
          } else {
            Image(systemName: "stop.fill").font(.system(size: 10, weight: .bold))
          }
          Text("Stop")
            .font(.caption.weight(.bold))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(ADEColor.danger.opacity(0.18), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
        .foregroundStyle(ADEColor.danger)
      }
      .buttonStyle(.plain)
      .disabled(!isLive && !isBusy)
    } else {
      Button {
        onLaunch()
      } label: {
        HStack(spacing: 4) {
          if isBusy {
            ProgressView().controlSize(.mini).tint(.black)
          } else {
            Image(systemName: "sparkles").font(.system(size: 10, weight: .bold))
          }
          Text(isBusy ? "Starting" : "Launch")
            .font(.caption.weight(.bold))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(ADEColor.tintPRs, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
        .foregroundStyle(Color.black)
      }
      .buttonStyle(.plain)
      .disabled(isBusy || !isLive)
    }
  }

  private var gradientBackground: LinearGradient {
    LinearGradient(
      colors: [
        ADEColor.tintPRs.opacity(0.18),
        ADEColor.tintPRs.opacity(0.04),
      ],
      startPoint: .topLeading,
      endPoint: .bottomTrailing
    )
  }
}

struct PrAiResolverSheet: View {
  @Environment(\.dismiss) private var dismiss
  let prNumber: Int
  let isBusy: Bool
  let isRunning: Bool
  let lastError: String?
  let onLaunch: (_ model: String?, _ reasoningEffort: String?) -> Void
  let onStop: () -> Void

  @State private var reasoningEffort: String = "medium"
  @State private var model: String = ""

  private let efforts: [(String, String)] = [
    ("low", "Low"),
    ("medium", "Medium"),
    ("high", "High"),
  ]

  var body: some View {
    NavigationStack {
      Form {
        Section {
          PrAiResolverCtaCard(
            variant: .prominent,
            title: "Fix PR #\(prNumber) with AI",
            subtitle: "Worker will analyze failing checks and push a fix commit",
            isBusy: isBusy,
            isRunning: isRunning,
            isLive: true,
            onLaunch: {
              onLaunch(model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : model, reasoningEffort)
            },
            onStop: onStop
          )
          .listRowBackground(Color.clear)
          .listRowInsets(EdgeInsets())
        }

        Section("Reasoning effort") {
          Picker("Effort", selection: $reasoningEffort) {
            ForEach(efforts, id: \.0) { pair in
              Text(pair.1).tag(pair.0)
            }
          }
          .pickerStyle(.segmented)
        }

        Section("Model (optional)") {
          TextField("e.g. anthropic/claude-sonnet-4-6", text: $model)
            .autocorrectionDisabled()
            .textInputAutocapitalization(.never)
            .font(.system(.body, design: .monospaced))
        }

        if let lastError, !lastError.isEmpty {
          Section("Last error") {
            Text(lastError)
              .font(.system(.caption, design: .monospaced))
              .foregroundStyle(ADEColor.danger)
          }
        }

        Section {
          Text("The resolver reads failing checks and unresolved review threads, drafts fixes, and pushes commits to this branch.")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }
      }
      .navigationTitle("AI Resolver")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Close") { dismiss() }
        }
      }
    }
  }
}
