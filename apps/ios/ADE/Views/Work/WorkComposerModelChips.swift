import SwiftUI
import UIKit

// The composer's model chip on iOS, the twin of the desktop's
// `composerModelChip.ts`: `[logo Name │ High │ shield]`. The name part is
// fixed; the thinking and permission parts are edited one at a time, each in
// its own picker. This file holds what a chip looks like (style, parts, the
// pill image) and the picker; the composer (`WorkComposerTypedTriggers.swift`)
// owns where chips sit in the draft and which one is being edited.

// MARK: - Model chip parts

/// The parts of a model chip the user edits in place, as on the desktop
/// (`composerModelChip.ts`): `[logo Name │ High │ shield]`. The name is fixed;
/// thinking and permission each open their own short list.
enum WorkModelChipSegment: String, Equatable, CaseIterable {
  case effort
  case perm

  var title: String {
    switch self {
    case .effort: return "Thinking"
    case .perm: return "Permissions"
    }
  }
}

/// How a model chip looks: the maker's mark, the footer's colour for its
/// thinking level, and the footer picker's icon and tone for its permission.
enum WorkModelChipStyle {
  /// `modelChipSegments`: a model with no thinking levels skips thinking.
  static func segments(tiers: [String]) -> [WorkModelChipSegment] {
    tiers.isEmpty ? [.perm] : [.effort, .perm]
  }

  /// `reasoningEffortToneColor`: where a level sits on this model's own ladder
  /// picks the colour, so "High" reads hotter on a three-step model than on a
  /// six-step one.
  static func effortTint(_ effort: String?, tiers: [String]) -> UIColor {
    guard let effort, let index = tiers.firstIndex(of: effort) else { return .systemGray }
    guard tiers.count > 1 else { return .systemPurple }
    let ratio = Double(index) / Double(tiers.count - 1)
    if ratio <= 0.12 { return .systemGreen }
    if ratio <= 0.38 { return .systemTeal }
    if ratio <= 0.52 { return .systemBlue }
    if ratio < 1 { return .systemIndigo }
    return .systemPurple
  }

  struct PermissionGlyph: Equatable {
    let symbol: String
    let tint: UIColor
  }

  /// The option a chip's stored mode names, from the one permission table.
  static func permissionOption(provider: String?, value: String) -> WorkModelMentionDetector.PermissionOption? {
    WorkModelMentionDetector.permissionOptions(provider: provider).first { $0.value == value }
  }

  /// The footer picker's icon and tone for a mode; a mode the table does not
  /// list draws as the safe default.
  static func permissionGlyph(provider: String?, value: String) -> PermissionGlyph {
    let option = permissionOption(provider: provider, value: value)
    return PermissionGlyph(
      symbol: option?.symbol ?? "checkmark.shield.fill",
      tint: tint(for: option?.tone ?? .green)
    )
  }

  static func tint(for tone: WorkModelMentionDetector.PermissionOption.Tone) -> UIColor {
    switch tone {
    case .green: return UIColor(ADEColor.success)
    case .amber: return UIColor(ADEColor.warning)
    case .purple: return UIColor(ADEColor.purpleAccent)
    case .red: return UIColor(ADEColor.danger)
    case .slate: return UIColor(ADEColor.textSecondary)
    }
  }

  /// A thinking level's word for a segment of the picker.
  static func effortShortLabel(_ effort: String) -> String {
    switch effort {
    case "minimal": return "Min"
    case "medium": return "Med"
    case "xhigh": return "X-High"
    case "ultracode": return "Ultra"
    default: return WorkModelMentionDetector.effortLabel(effort)
    }
  }

  /// The maker's bundled mark for a model, or nil when none is bundled.
  static func logoAssetName(modelId: String) -> String? {
    guard let entry = WorkModelMentionDirectory.shared.entry(for: modelId) else { return nil }
    return providerAssetName(entry.brandKey) ?? providerAssetName(entry.provider)
  }
}

/// Everything an inline model pill draws, read off its token and the catalog.
struct WorkModelPillParts: Equatable {
  var logoAssetName: String?
  var name: String
  /// Nil when the model has no thinking levels, so the pill has no such part.
  var effortLabel: String?
  var effortTint: UIColor
  var permissionLabel: String
  var permission: WorkModelChipStyle.PermissionGlyph
  /// The part lit while its list is open, as the desktop chip does.
  var active: WorkModelChipSegment?

  init(mention: WorkModelMention, active: WorkModelChipSegment? = nil) {
    let entry = WorkModelMentionDirectory.shared.entry(for: mention.modelId)
    let tiers = entry?.reasoningTiers ?? []
    let provider = entry?.provider
    let permissionValue = mention.permission ?? WorkModelMentionDetector.defaultPermission(provider: provider)
    logoAssetName = WorkModelChipStyle.logoAssetName(modelId: mention.modelId)
    name = mention.displayName
    effortLabel = tiers.isEmpty && mention.effort == nil
      ? nil
      : WorkModelMentionDetector.effortLabel(mention.effort)
    effortTint = WorkModelChipStyle.effortTint(mention.effort, tiers: tiers)
    permissionLabel = WorkModelMentionDetector.permissionLabel(mention.permission, provider: provider)
    permission = WorkModelChipStyle.permissionGlyph(provider: provider, value: permissionValue)
    self.active = active
  }

  init?(token: String, active: WorkModelChipSegment? = nil) {
    guard let mention = WorkModelMentionDetector.mentions(in: token as NSString).first else { return nil }
    self.init(mention: mention, active: active)
  }

  var accessibilityLabel: String {
    [name, effortLabel.map { "\($0) thinking" }, permissionLabel].compactMap { $0 }.joined(separator: ", ")
  }
}

/// Where each part of a drawn model pill sits, in the pill image's own
/// horizontal coordinates, so a tap can tell which part it landed on. A nil
/// segment is the fixed name part.
struct WorkModelPillSpan: Equatable {
  let segment: WorkModelChipSegment?
  let minX: CGFloat
  let maxX: CGFloat
}

// MARK: - Model pill image

extension WorkComposerPillRenderer {
  /// A model pill, drawn like the desktop chip: the maker's mark and the
  /// model's name, then a thinking part and a permission part divided by
  /// hairlines. Each part reports where it sits so a tap can open its list.
  static func renderModel(
    _ parts: WorkModelPillParts,
    font: UIFont,
    traits: UITraitCollection
  ) -> (image: UIImage, bounds: CGRect, spans: [WorkModelPillSpan]) {
    let labelSize = max(11, font.pointSize - 2)
    let nameFont = UIFont.systemFont(ofSize: labelSize, weight: .semibold)
    let segmentFont = UIFont.systemFont(ofSize: labelSize - 1, weight: .semibold)
    let chipTint = UIColor(ADEColor.warning).resolvedColor(with: traits)
    let isDark = traits.userInterfaceStyle == .dark
    let textColor = UIColor(ADEColor.textPrimary).resolvedColor(with: traits)

    let paragraph = NSMutableParagraphStyle()
    paragraph.lineBreakMode = .byTruncatingTail
    let nameText = parts.name as NSString
    let nameAttributes: [NSAttributedString.Key: Any] = [
      .font: nameFont, .foregroundColor: textColor, .paragraphStyle: paragraph,
    ]
    let nameWidth = min(ceil(nameText.size(withAttributes: nameAttributes).width), 150)
    let effortText = parts.effortLabel as NSString?
    let effortAttributes: [NSAttributedString.Key: Any] = [
      .font: segmentFont, .foregroundColor: parts.effortTint.resolvedColor(with: traits),
    ]
    let effortWidth = effortText.map { ceil($0.size(withAttributes: effortAttributes).width) } ?? 0

    let pad: CGFloat = 6
    let gap: CGFloat = 4
    let margin: CGFloat = 1.5
    let logoSide: CGFloat = iconSide
    let height = ceil(nameFont.lineHeight) + 7
    let nameSpanWidth = pad + logoSide + gap + nameWidth + pad
    let effortSpanWidth = effortText == nil ? 0 : pad + effortWidth + pad
    let permSpanWidth = pad + 12 + pad
    let pillWidth = nameSpanWidth + effortSpanWidth + permSpanWidth
    let size = CGSize(width: pillWidth + margin * 2, height: height)

    var spans: [WorkModelPillSpan] = []
    var x = margin
    spans.append(WorkModelPillSpan(segment: nil, minX: x, maxX: x + nameSpanWidth))
    x += nameSpanWidth
    if effortText != nil {
      spans.append(WorkModelPillSpan(segment: .effort, minX: x, maxX: x + effortSpanWidth))
      x += effortSpanWidth
    }
    spans.append(WorkModelPillSpan(segment: .perm, minX: x, maxX: x + permSpanWidth))

    let format = UIGraphicsImageRendererFormat(for: traits)
    format.opaque = false
    let image = UIGraphicsImageRenderer(size: size, format: format).image { context in
      let pillRect = CGRect(x: margin, y: 0.5, width: pillWidth, height: height - 1)
      let radius = min(7, pillRect.height / 2)
      let shape = UIBezierPath(roundedRect: pillRect, cornerRadius: radius)
      chipTint.withAlphaComponent(isDark ? 0.14 : 0.10).setFill()
      shape.fill()

      // The open part is lit, clipped to the pill's rounded outline.
      if let active = parts.active, let span = spans.first(where: { $0.segment == active }) {
        context.cgContext.saveGState()
        shape.addClip()
        chipTint.withAlphaComponent(isDark ? 0.32 : 0.24).setFill()
        UIRectFill(CGRect(x: span.minX, y: pillRect.minY, width: span.maxX - span.minX, height: pillRect.height))
        context.cgContext.restoreGState()
      }

      chipTint.withAlphaComponent(isDark ? 0.40 : 0.32).setStroke()
      shape.lineWidth = 0.75
      shape.stroke()

      // Hairlines between parts.
      chipTint.withAlphaComponent(isDark ? 0.30 : 0.24).setFill()
      for span in spans.dropFirst() {
        UIRectFill(CGRect(x: span.minX, y: pillRect.minY + 3, width: 0.75, height: pillRect.height - 6))
      }

      let logoRect = CGRect(x: margin + pad, y: (height - logoSide) / 2, width: logoSide, height: logoSide)
      if let asset = parts.logoAssetName,
         let logo = UIImage(named: asset, in: nil, compatibleWith: traits) {
        logo.draw(in: aspectFit(logo.size, in: logoRect))
      } else {
        let configuration = UIImage.SymbolConfiguration(pointSize: labelSize - 3, weight: .semibold)
        if let symbol = UIImage(systemName: "cpu", withConfiguration: configuration)?
          .withTintColor(chipTint, renderingMode: .alwaysOriginal) {
          symbol.draw(in: aspectFit(symbol.size, in: logoRect))
        }
      }

      nameText.draw(
        with: CGRect(
          x: logoRect.maxX + gap,
          y: (height - nameFont.lineHeight) / 2,
          width: nameWidth,
          height: ceil(nameFont.lineHeight)
        ),
        options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine],
        attributes: nameAttributes,
        context: nil
      )

      if let effortText, let span = spans.first(where: { $0.segment == .effort }) {
        effortText.draw(
          at: CGPoint(x: span.minX + pad, y: (height - segmentFont.lineHeight) / 2),
          withAttributes: effortAttributes
        )
      }

      if let span = spans.first(where: { $0.segment == .perm }) {
        let configuration = UIImage.SymbolConfiguration(pointSize: labelSize - 3, weight: .bold)
        if let glyph = UIImage(systemName: parts.permission.symbol, withConfiguration: configuration)?
          .withTintColor(parts.permission.tint.resolvedColor(with: traits), renderingMode: .alwaysOriginal) {
          let box = CGRect(x: span.minX + pad, y: (height - 12) / 2, width: 12, height: 12)
          glyph.draw(in: aspectFit(glyph.size, in: box))
        }
      }
    }
    let center = font.capHeight / 2
    let bounds = CGRect(x: 0, y: (center - size.height / 2).rounded(), width: size.width, height: size.height)
    return (image, bounds, spans)
  }

  fileprivate static func aspectFit(_ size: CGSize, in box: CGRect) -> CGRect {
    guard size.width > 0, size.height > 0 else { return box }
    let scale = min(box.width / size.width, box.height / size.height)
    let drawn = CGSize(width: size.width * scale, height: size.height * scale)
    return CGRect(x: box.midX - drawn.width / 2, y: box.midY - drawn.height / 2, width: drawn.width, height: drawn.height)
  }
}

// MARK: - Part picker

/// The picker for the one part of a model chip that is open — thinking or
/// permissions, never both, and never the model's name. It opens on its own
/// right after a model is picked (thinking first), and on a tap of that part
/// of the chip in the draft. A pick rewrites the chip and moves on: thinking
/// hands over to permissions, permissions closes. Mirrors the desktop chip.
///
/// Both parts share one shape: a segmented track in the part's own order
/// (low → high thinking, safe → open permissions) with a sliding highlight in
/// the picked option's colour, so it reads as a scale rather than a heap.
struct WorkModelChipEditorBar: View {
  @ObservedObject var controller: WorkComposerSuggestionController
  let chip: WorkModelMention
  let segment: WorkModelChipSegment

  @Namespace private var highlight
  /// The option just tapped, lit before the chip rewrite lands.
  @State private var pending: String?

  private var entry: WorkModelMentionDirectory.Entry? {
    WorkModelMentionDirectory.shared.entry(for: chip.modelId)
  }

  private var tiers: [String] { entry?.reasoningTiers ?? [] }
  private var provider: String { entry?.provider ?? "" }

  private var currentPermission: String {
    chip.permission ?? WorkModelMentionDetector.defaultPermission(provider: provider)
  }

  private var steps: [WorkModelChipSegment] { WorkModelChipStyle.segments(tiers: tiers) }

  private struct Option: Identifiable {
    let id: String
    let label: String
    let shortLabel: String
    let symbol: String?
    let tint: Color
  }

  private var options: [Option] {
    switch segment {
    case .effort:
      return tiers.map { tier in
        Option(
          id: tier,
          label: WorkModelMentionDetector.effortLabel(tier),
          shortLabel: WorkModelChipStyle.effortShortLabel(tier),
          symbol: nil,
          tint: Color(uiColor: WorkModelChipStyle.effortTint(tier, tiers: tiers))
        )
      }
    case .perm:
      return WorkModelMentionDetector.permissionOptions(provider: provider).map { option in
        Option(
          id: option.value,
          label: option.label,
          shortLabel: option.shortLabel,
          symbol: option.symbol,
          tint: Color(uiColor: WorkModelChipStyle.tint(for: option.tone))
        )
      }
    }
  }

  private var selectedId: String? {
    pending ?? (segment == .effort ? chip.effort : currentPermission)
  }

  private var selected: Option? { options.first { $0.id == selectedId } }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      header
      track
      if segment == .perm, let detail = WorkModelChipStyle.permissionOption(provider: provider, value: selectedId ?? "")?.detail {
        Text(detail)
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
          .minimumScaleFactor(0.85)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal, 2)
          .contentTransition(.opacity)
      }
    }
    .padding(.horizontal, 12)
    .padding(.top, 8)
    .padding(.bottom, 12)
    .background(
      RoundedRectangle(cornerRadius: 18, style: .continuous)
        .fill(ADEColor.glassBackground)
    )
    .glassEffect(in: .rect(cornerRadius: 18))
    .overlay(
      RoundedRectangle(cornerRadius: 18, style: .continuous)
        .stroke(ADEColor.glassBorder, lineWidth: 0.75)
    )
    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    .shadow(color: Color.black.opacity(0.12), radius: 14, y: 4)
    .id(segment)
    .transition(.opacity.combined(with: .move(edge: .bottom)))
    // A pick of the value already set rewrites nothing, so the step change is
    // what clears it; otherwise the next part would light an id it lacks.
    .onChange(of: chip) { _, _ in pending = nil }
    .onChange(of: segment) { _, _ in pending = nil }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("Work.Chat.Composer.ModelChipEditor.\(segment.rawValue)")
  }

  /// `THINKING · Medium`, the step it is on when a pick walks both parts, and
  /// a close button.
  private var header: some View {
    HStack(spacing: 6) {
      Image(systemName: segment == .effort ? "brain" : "checkmark.shield")
        .font(.caption2.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
      Text(segment.title.uppercased())
        .font(.caption2.weight(.bold))
        .tracking(0.6)
        .foregroundStyle(ADEColor.textMuted)
      if let selected {
        Text("·")
          .font(.caption2.weight(.bold))
          .foregroundStyle(ADEColor.textMuted)
        Text(selected.label)
          .font(.caption.weight(.semibold))
          .foregroundStyle(selected.tint)
          .contentTransition(.opacity)
      }
      Spacer(minLength: 4)
      if steps.count > 1 {
        HStack(spacing: 4) {
          ForEach(steps, id: \.self) { step in
            Capsule(style: .continuous)
              .fill(step == segment ? ADEColor.textSecondary : ADEColor.textMuted.opacity(0.35))
              .frame(width: step == segment ? 14 : 6, height: 6)
          }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Step \((steps.firstIndex(of: segment) ?? 0) + 1) of \(steps.count)")
      }
      Button {
        withAnimation(.snappy(duration: 0.2)) { controller.setEditingSegment(nil) }
      } label: {
        Image(systemName: "xmark")
          .font(.caption2.weight(.bold))
          .foregroundStyle(ADEColor.textMuted)
          .frame(width: 30, height: 30)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Close")
    }
    .frame(height: 30)
  }

  /// One row of equal segments in a recessed track; the picked one sits on a
  /// raised, tinted pill that slides to the next pick.
  private var track: some View {
    HStack(spacing: 0) {
      ForEach(options) { option in
        let isSelected = option.id == selectedId
        Button {
          pick(option.id)
        } label: {
          VStack(spacing: 3) {
            if let symbol = option.symbol {
              Image(systemName: symbol)
                .font(.footnote.weight(.semibold))
            }
            Text(option.shortLabel)
              .font(.caption.weight(.semibold))
              .lineLimit(1)
              .minimumScaleFactor(0.7)
          }
          .foregroundStyle(isSelected ? option.tint : ADEColor.textSecondary)
          .frame(maxWidth: .infinity)
          .frame(height: option.symbol == nil ? 36 : 50)
          .background {
            if isSelected {
              RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(option.tint.opacity(0.18))
                .overlay(
                  RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(option.tint.opacity(0.55), lineWidth: 1)
                )
                .matchedGeometryEffect(id: "highlight", in: highlight)
            }
          }
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(option.label)
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
        .accessibilityIdentifier("Work.Chat.Composer.ModelChipOption.\(option.id)")
      }
    }
    .padding(3)
    .background(
      RoundedRectangle(cornerRadius: 13, style: .continuous)
        .fill(ADEColor.textPrimary.opacity(0.06))
    )
    .overlay(
      RoundedRectangle(cornerRadius: 13, style: .continuous)
        .stroke(ADEColor.glassBorder, lineWidth: 0.75)
    )
  }

  /// Slides the highlight to the pick and rewrites the chip, then moves on to
  /// the next part once the slide has been seen.
  private func pick(_ value: String) {
    withAnimation(.snappy(duration: 0.22)) { pending = value }
    switch segment {
    case .effort:
      controller.rewriteEditingModelChip(effort: value, permission: chip.permission)
    case .perm:
      controller.rewriteEditingModelChip(effort: chip.effort, permission: value)
    }
    let picked = segment
    let chipLocation = chip.range.location
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.28) {
      // Only if the user is still on this part of this chip.
      guard controller.editingSegment == picked,
            controller.editingModelChip?.range.location == chipLocation else { return }
      withAnimation(.snappy(duration: 0.24)) {
        controller.advanceEditingSegment()
      }
    }
  }
}
