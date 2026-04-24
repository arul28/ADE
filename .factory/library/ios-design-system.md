# iOS 26 Design System Reference

Design patterns, Liquid Glass APIs, and SwiftUI best practices for this mission.

---

## Liquid Glass APIs

### Basic Usage
```swift
// Apply glass effect to any view
Text("Label").padding().glassEffect()

// Custom shape with corner radius
Text("Label").padding().glassEffect(in: .rect(cornerRadius: 16.0))

// Tinted glass
Text("Label").padding().glassEffect(.regular.tint(.purple).interactive())
```

### Glass Variants
- `Glass.regular` — Default, blurs/adjusts luminosity. Use for navigation, cards, pills.
- `Glass.clear` — Highly translucent. Use over media backgrounds.
- `.tint(_:)` — Color tint like stained glass.
- `.interactive(_:)` — Touch response animation.

### Multiple Glass Effects
```swift
GlassEffectContainer(spacing: 20.0) {
    HStack(spacing: 20.0) {
        Button("A") { }.glassEffect()
        Button("B") { }.glassEffect()
    }
}
```

### Glass Button Styles
```swift
Button("Action") { }.buttonStyle(.glass)
Button("Primary") { }.buttonStyle(.glassProminent)
```

### Morphing Transitions
```swift
@Namespace private var ns
// Source:
Image(systemName: "star").glassEffect().glassEffectID("item", in: ns)
// Destination:
Image(systemName: "star").glassEffect().glassEffectID("item", in: ns)
```

### Navigation matched transitions
```swift
@Namespace private var ns

// Source row or card
rowView
    .matchedTransitionSource(id: item.id, in: ns)

// Destination screen
DetailView(item: item)
    .navigationTransition(.zoom(sourceID: item.id, in: ns))
```

- Use `matchedTransitionSource(id:in:)` on the list/grid source and `.navigationTransition(.zoom(sourceID:in:))` on the pushed destination for iOS 26 list-to-detail continuity.
- When a flow also supports Reduce Motion, keep a simpler fallback path available instead of forcing spring-heavy motion on every transition.

## Shared ADE mobile primitives

- Reuse `apps/ios/ADE/Views/Components/ADEMobilePrimitives.swift` before adding tab-local glass wrappers.
- `ADEGlassSection` is the shared section shell for grouped mobile content with consistent spacing and glass treatment.
- `ADEGlassChip` and `ADEGlassActionButton` are the standard compact status/action controls for list, header, and sheet surfaces.
- `ADEMatchedTransitionScope` is the shared namespace wrapper for new list-to-detail zoom transitions; existing screens may still use the older helper modifiers while adoption catches up.

### Tab Bar Minimization
```swift
TabView { ... }.tabBarMinimizeBehavior(.onScrollDown)
```

## Spring Animations

```swift
withAnimation(.smooth) { }          // Default — most transitions
withAnimation(.snappy) { }          // Quick interactions (toggles, selections)
withAnimation(.bouncy) { }          // Playful (use sparingly)
```

## Haptic Feedback

```swift
.sensoryFeedback(.selection, trigger: selectedTab)
.sensoryFeedback(.success, trigger: isCompleted)
.sensoryFeedback(.impact, trigger: buttonTapped)
.sensoryFeedback(.warning, trigger: destructiveAction)
```

## System Semantic Colors

Replace all ADEPalette usage:
- `.pageBackground` → `Color(.systemBackground)`
- `.surfaceBackground` → `Color(.secondarySystemBackground)`
- `.recessedBackground` → `Color(.tertiarySystemBackground)`
- `.textPrimary` → `.primary`
- `.textSecondary` → `.secondary`
- `.textMuted` → `Color(.tertiaryLabel)`
- `.accent` → `.tint` or `.accentColor` (set project accent to purple #7C3AED)
- `.border` → `Color(.separator)`
- `.success` → `Color.green`
- `.warning` → `Color.orange`
- `.danger` → `Color.red`

## Typography
- SF Pro is automatic (system font)
- Use `.font(.body)`, `.font(.headline)`, `.font(.caption)` etc.
- Monospace for code: `.font(.system(.body, design: .monospaced))`
- Support Dynamic Type — never hardcode sizes

## SF Symbols
- Always use `Image(systemName:)` for icons
- Match weight with text: `.font(.body)` on both
- Use `.symbolRenderingMode(.hierarchical)` for depth
- Use `.symbolEffect(.bounce, value:)` for attention
