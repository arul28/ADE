import SwiftUI

/// Presented as a `medium`/`large` sheet from any root screen when the user
/// taps `AttentionDrawerButton`. Groups every pending attention item by
/// kind and offers the same action chips as the lock-screen card.
@available(iOS 17.0, *)
struct AttentionDrawerSheet: View {
    @EnvironmentObject private var syncService: SyncService
    @EnvironmentObject private var drawer: AttentionDrawerModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    // Sections are rendered in this fixed priority order so the UI feels
    // consistent even as counts shift.
    private static let sectionOrder: [AttentionKind] = [
        .awaitingInput, .failed, .ciFailing, .reviewRequested, .mergeReady,
    ]

    var body: some View {
        NavigationStack {
            Group {
                if drawer.items.isEmpty {
                    emptyState
                } else {
                    list
                }
            }
            .navigationTitle("Attention")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Clear all") {
                        drawer.markAllSeen()
                    }
                    .disabled(drawer.unreadCount == 0)
                }
            }
            .adeScreenBackground()
            .adeNavigationGlass()
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .onAppear { drawer.markAllSeen() }
    }

    // MARK: - Empty state

    private var emptyState: some View {
        VStack(spacing: 16) {
            Spacer()
            ZStack {
                // Radial purple bloom behind the disc — signals the "PRs / attention" surface.
                Circle()
                    .fill(
                        RadialGradient(
                            colors: [
                                PrGlassPalette.purple.opacity(0.30),
                                PrGlassPalette.purple.opacity(0.0),
                            ],
                            center: .center,
                            startRadius: 0,
                            endRadius: 56
                        )
                    )
                    .frame(width: 120, height: 120)
                    .blur(radius: 10)

                Circle()
                    .fill(.ultraThinMaterial)
                    .frame(width: 64, height: 64)
                    .overlay(
                        Circle()
                            .strokeBorder(
                                PrGlassPalette.accentGradient,
                                lineWidth: 1
                            )
                            .opacity(0.6)
                    )
                    .shadow(color: PrGlassPalette.purple.opacity(0.25), radius: 10, x: 0, y: 4)

                Image(systemName: "sparkles")
                    .font(.system(size: 28, weight: .regular))
                    .foregroundStyle(PrGlassPalette.purple.opacity(0.95))
                    .modifier(DrawerPulseEffect(active: !reduceMotion))
            }

            VStack(spacing: 6) {
                Text("No pending items")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(ADEColor.textPrimary)
                Text("All agents are running smoothly.")
                    .font(.subheadline)
                    .foregroundStyle(ADEColor.textSecondary)
                    .multilineTextAlignment(.center)
            }
            Spacer()
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.horizontal, 32)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("No pending attention items. All agents are running smoothly.")
    }

    // MARK: - List

    private var list: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18) {
                ForEach(Self.sectionOrder, id: \.self) { kind in
                    let subset = drawer.items.filter { $0.kind == kind }
                    if !subset.isEmpty {
                        section(kind: kind, items: subset)
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .padding(.bottom, 24)
        }
        .scrollBounceBehavior(.basedOnSize)
    }

    private func section(kind: AttentionKind, items: [AttentionItem]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                AttentionBadge(kind: kind, size: 20, pulse: false)
                Text(Self.label(for: kind))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(ADEColor.textPrimary)
                Text("\(items.count)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(ADEColor.textSecondary)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 2)
                    .background(
                        Capsule().fill(.ultraThinMaterial)
                    )
                    .overlay(
                        Capsule()
                            .strokeBorder(Color.white.opacity(0.10), lineWidth: 0.5)
                    )
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 4)

            VStack(spacing: 10) {
                ForEach(items) { item in
                    AttentionDrawerCard(item: item) {
                        follow(item)
                    }
                }
            }
        }
    }

    // MARK: - Deep-link

    private func follow(_ item: AttentionItem) {
        guard let url = item.deepLink else { return }
        drawer.markAllSeen()
        dismiss()
        // Small delay so the sheet finishes dismissing before the tab
        // switch animation fires — otherwise the system cross-fades the
        // two transitions and the destination push feels jittery.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            DeepLinkRouter.shared.handle(url)
        }
    }

    private static func label(for kind: AttentionKind) -> String {
        switch kind {
        case .awaitingInput:   return "Awaiting input"
        case .failed:          return "Failed"
        case .ciFailing:       return "CI failing"
        case .reviewRequested: return "Review requested"
        case .mergeReady:      return "Merge ready"
        }
    }
}

/// Lightweight attention card used inside the drawer. Shares the visual
/// language of the lock-screen `AttentionCard` (tinted bg, thin border,
/// badge + copy + action row) but lives inline here so the drawer is
/// self-contained and doesn't drag the widget target's card into the app.
@available(iOS 17.0, *)
private struct AttentionDrawerCard: View {
    let item: AttentionItem
    let onTap: () -> Void

    var body: some View {
        let tint = AttentionIcon.tint(for: item.kind)

        Button(action: onTap) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .top, spacing: 12) {
                    AttentionBadge(kind: item.kind, size: 30, pulse: item.kind == .awaitingInput)

                    VStack(alignment: .leading, spacing: 4) {
                        Text(item.title)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(ADEColor.textPrimary)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                        Text(item.subtitle)
                            .font(.caption)
                            .foregroundStyle(ADEColor.textSecondary)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                    }
                    Spacer(minLength: 0)

                    if let slug = item.providerSlug {
                        BrandDot(slug: slug, size: 10, pulse: false)
                            .padding(.top, 4)
                    }
                }

                AttentionActionRow(attention: item.attentionPayload)
            }
            .padding(14)
            .background(
                ZStack {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(.ultraThinMaterial)
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(tint.opacity(0.16))
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(
                            RadialGradient(
                                colors: [tint.opacity(0.22), tint.opacity(0.0)],
                                center: .topLeading,
                                startRadius: 0,
                                endRadius: 200
                            )
                        )
                }
            )
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [Color.white.opacity(0.08), .clear],
                            startPoint: .top,
                            endPoint: .center
                        )
                    )
                    .allowsHitTesting(false)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(
                        LinearGradient(
                            colors: [
                                tint.opacity(0.55),
                                tint.opacity(0.15),
                            ],
                            startPoint: .top,
                            endPoint: .bottom
                        ),
                        lineWidth: 0.75
                    )
            )
            .shadow(color: tint.opacity(0.35), radius: 8, x: 0, y: 4)
            .shadow(color: Color.black.opacity(0.25), radius: 5, x: 0, y: 2)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(item.title). \(item.subtitle)")
        .accessibilityHint(item.deepLink == nil ? "" : "Opens the related surface.")
    }
}

/// `.symbolEffect(.pulse)` is gated behind Reduce Motion — when the user has
/// that system setting on, the glyph renders statically.
@available(iOS 17.0, *)
private struct DrawerPulseEffect: ViewModifier {
    let active: Bool

    func body(content: Content) -> some View {
        if active {
            content.symbolEffect(.pulse, options: .repeating)
        } else {
            content
        }
    }
}
