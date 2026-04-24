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

  /// Running state picks up a danger accent (stop glyph); idle state uses
  /// the amber/warning tint matching the "something needs fixing" reading.
  private var accent: Color {
    isRunning ? PrGlassPalette.danger : PrGlassPalette.warning
  }

  var body: some View {
    HStack(alignment: .center, spacing: 12) {
      iconDisc

      VStack(alignment: .leading, spacing: 3) {
        PrsEyebrowLabel(text: "AI RESOLVER", tint: accent.opacity(0.95))
        Text(title)
          .font(.system(size: 14, weight: .bold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
        Text(isRunning ? "Worker running · auto-pushing fixes" : subtitle)
          .font(.system(size: 10.5, weight: .medium, design: .monospaced))
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(2)
      }

      Spacer(minLength: 8)

      launchButton
    }
    .padding(14)
    .prGlassCard(cornerRadius: 16, tint: accent)
  }

  /// Amber→orange (or danger) gradient tile matching the mock's rebase tile.
  private var iconDisc: some View {
    ZStack {
      RoundedRectangle(cornerRadius: 11, style: .continuous)
        .fill(accent.opacity(0.55))
        .frame(width: 38, height: 38)
        .blur(radius: 10)
        .opacity(0.6)

      RoundedRectangle(cornerRadius: 11, style: .continuous)
        .fill(
          LinearGradient(
            colors: [
              accent,
              accent.opacity(0.75),
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
          )
        )
        .frame(width: 34, height: 34)

      RoundedRectangle(cornerRadius: 11, style: .continuous)
        .strokeBorder(
          LinearGradient(
            colors: [Color.white.opacity(0.55), .clear],
            startPoint: .top,
            endPoint: .center
          ),
          lineWidth: 1
        )
        .frame(width: 34, height: 34)

      Image(systemName: "sparkles")
        .font(.system(size: 14, weight: .bold))
        .foregroundStyle(.white)
    }
  }

  @ViewBuilder
  private var launchButton: some View {
    if isRunning, let onStop {
      Button {
        onStop()
      } label: {
        HStack(spacing: 5) {
          if isBusy {
            ProgressView().controlSize(.mini).tint(.white)
          } else {
            Image(systemName: "stop.fill").font(.system(size: 10, weight: .bold))
          }
          Text("Stop")
            .font(.system(size: 12, weight: .bold))
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .foregroundStyle(.white)
        .background(
          Capsule(style: .continuous)
            .fill(
              LinearGradient(
                colors: [PrGlassPalette.danger, PrGlassPalette.danger.opacity(0.75)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
              )
            )
        )
        .overlay(
          Capsule(style: .continuous)
            .strokeBorder(Color.white.opacity(0.35), lineWidth: 0.5)
        )
        .shadow(color: PrGlassPalette.danger.opacity(0.55), radius: 10, x: 0, y: 3)
      }
      .buttonStyle(.plain)
      .disabled(!isLive && !isBusy)
    } else {
      Button {
        onLaunch()
      } label: {
        HStack(spacing: 5) {
          if isBusy {
            ProgressView().controlSize(.mini).tint(.white)
          } else {
            Image(systemName: "sparkles").font(.system(size: 10, weight: .bold))
          }
          Text(isBusy ? "Starting" : "Launch")
            .font(.system(size: 12, weight: .bold))
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .foregroundStyle(.white)
        .background(
          Capsule(style: .continuous)
            .fill(
              LinearGradient(
                colors: [
                  PrGlassPalette.warning,
                  Color(red: 0xD9 / 255, green: 0x77 / 255, blue: 0x06 / 255),
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
              )
            )
        )
        .overlay(
          Capsule(style: .continuous)
            .strokeBorder(Color.white.opacity(0.45), lineWidth: 0.5)
        )
        .shadow(color: PrGlassPalette.warning.opacity(0.55), radius: 10, x: 0, y: 3)
      }
      .buttonStyle(.plain)
      .disabled(isBusy || !isLive)
      .opacity(isLive ? 1 : 0.55)
    }
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
