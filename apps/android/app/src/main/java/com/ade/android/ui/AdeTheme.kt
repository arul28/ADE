package com.ade.android.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Surface
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.Modifier
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

val AdePurple = Color(0xFFA78BFA)
val AdePurpleDeep = Color(0xFF7C3AED)
val AdeGreen = Color(0xFF049068)
val AdeSuccess = Color(0xFF16A34A)
val AdeWarning = Color(0xFFD97706)
val AdeDanger = Color(0xFFDC2626)
val AdePageLight = Color(0xFFF5F3F0)
val AdePageDark = Color(0xFF0C0B10)

private val Light = lightColorScheme(
    primary = AdeGreen,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFD8F3EA),
    onPrimaryContainer = Color(0xFF073D31),
    secondary = AdePurpleDeep,
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFEDE5FF),
    onSecondaryContainer = Color(0xFF2E1A62),
    tertiary = AdeWarning,
    error = AdeDanger,
    background = AdePageLight,
    onBackground = Color(0xFF1A1A1E),
    surface = Color.White,
    onSurface = Color(0xFF1A1A1E),
    surfaceVariant = Color(0xFFEAE7E2),
    onSurfaceVariant = Color(0xFF52525B),
    outline = Color(0xFFD6D3CE),
    outlineVariant = Color(0xFFE6E2DC),
)

private val Dark = darkColorScheme(
    primary = AdePurple,
    onPrimary = Color(0xFF25134A),
    primaryContainer = Color(0xFF38235F),
    onPrimaryContainer = Color(0xFFEDE5FF),
    secondary = Color(0xFFC4B5FD),
    onSecondary = Color(0xFF25134A),
    secondaryContainer = Color(0xFF30214C),
    onSecondaryContainer = Color(0xFFEDE5FF),
    tertiary = Color(0xFFF59E0B),
    error = Color(0xFFEF4444),
    background = AdePageDark,
    onBackground = Color(0xFFF0F0F2),
    surface = Color(0xFF1A1830),
    onSurface = Color(0xFFF0F0F2),
    surfaceVariant = Color(0xFF282535),
    onSurfaceVariant = Color(0xFFA8A8B4),
    outline = Color(0xFF302C42),
    outlineVariant = Color(0xFF252232),
)

/**
 * ADE design tokens, ported from apps/ios/ADE/Views/Components/ADEDesignSystem.swift:52-113.
 *
 * These are adaptive light/dark pairs. Note that `accent` is GREEN in light
 * mode and purple only in dark — never hardcode the purple.
 */
@androidx.compose.runtime.Immutable
data class AdeColors(
    val page: Color,
    val surface: Color,
    val card: Color,
    val raised: Color,
    val recessed: Color,
    val composer: Color,
    val glass: Color,
    val glassBorder: Color,
    val border: Color,
    val textPrimary: Color,
    val textSecondary: Color,
    val textMuted: Color,
    val accent: Color,
    val accentBright: Color,
    val accentDeep: Color,
    val success: Color,
    val warning: Color,
    val danger: Color,
    val info: Color,
    val onAccent: Color,
    val isDark: Boolean,
)

val AdeLightColors = AdeColors(
    page = Color(0xFFF5F3F0),
    surface = Color(0xFFFAF8F5),
    card = Color(0xFFFFFFFF),
    raised = Color(0xFFFFFFFF),
    recessed = Color(0xFFEAE7E2),
    composer = Color(0xFFFFFFFF).copy(alpha = 0.82f),
    glass = Color(0xFFFFFFFF).copy(alpha = 0.78f),
    glassBorder = Color(0xFF1A1A1E).copy(alpha = 0.10f),
    border = Color(0xFFD6D3CE),
    textPrimary = Color(0xFF1A1A1E),
    textSecondary = Color(0xFF52525B),
    textMuted = Color(0xFF636370),
    accent = Color(0xFF049068),
    accentBright = Color(0xFF049068),
    accentDeep = Color(0xFF047857),
    success = Color(0xFF16A34A),
    warning = Color(0xFFD97706),
    danger = Color(0xFFDC2626),
    info = Color(0xFF2563EB),
    onAccent = Color.White,
    isDark = false,
)

val AdeDarkColors = AdeColors(
    page = Color(0xFF0C0B10),
    surface = Color(0xFF16141E),
    card = Color(0xFF1A1830),
    raised = Color(0xFF1E1B2E),
    recessed = Color(0xFF0A090E),
    composer = Color(0xFF14121F).copy(alpha = 0.86f),
    glass = Color(0xFF141220).copy(alpha = 0.78f),
    glassBorder = Color(0xFFFFFFFF).copy(alpha = 0.10f),
    border = Color(0xFF302C42),
    textPrimary = Color(0xFFF0F0F2),
    textSecondary = Color(0xFFA8A8B4),
    textMuted = Color(0xFF908FA0),
    accent = Color(0xFFA78BFA),
    accentBright = Color(0xFFC4B5FD),
    accentDeep = Color(0xFF7C3AED),
    success = Color(0xFF22C55E),
    warning = Color(0xFFF59E0B),
    danger = Color(0xFFEF4444),
    info = Color(0xFF3B82F6),
    onAccent = Color(0xFF25134A),
    isDark = true,
)

val LocalAdeColors = androidx.compose.runtime.staticCompositionLocalOf { AdeDarkColors }

/** `AdeTokens.colors` reads the adaptive token set for the current theme. */
object AdeTokens {
    val colors: AdeColors
        @Composable get() = LocalAdeColors.current
}

private val AdeTypography = Typography(
    displaySmall = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Bold, fontSize = 36.sp, lineHeight = 40.sp),
    headlineMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Bold, fontSize = 28.sp, lineHeight = 34.sp),
    titleLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.SemiBold, fontSize = 22.sp, lineHeight = 28.sp),
    titleMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.SemiBold, fontSize = 16.sp, lineHeight = 22.sp),
    bodyLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontSize = 16.sp, lineHeight = 23.sp),
    bodyMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontSize = 14.sp, lineHeight = 20.sp),
    bodySmall = TextStyle(fontFamily = FontFamily.SansSerif, fontSize = 12.sp, lineHeight = 17.sp),
    labelLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, lineHeight = 20.sp),
    labelMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.SemiBold, fontSize = 12.sp, lineHeight = 16.sp),
)

private val AdeShapes = Shapes(
    extraSmall = androidx.compose.foundation.shape.RoundedCornerShape(8.dp),
    small = androidx.compose.foundation.shape.RoundedCornerShape(10.dp),
    medium = androidx.compose.foundation.shape.RoundedCornerShape(14.dp),
    large = androidx.compose.foundation.shape.RoundedCornerShape(20.dp),
    extraLarge = androidx.compose.foundation.shape.RoundedCornerShape(28.dp),
)

@Composable
fun AdeTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    androidx.compose.runtime.CompositionLocalProvider(
        LocalAdeColors provides if (dark) AdeDarkColors else AdeLightColors,
    ) {
        MaterialTheme(
            colorScheme = if (dark) Dark else Light,
            typography = AdeTypography,
            shapes = AdeShapes,
        ) {
            // MaterialTheme provides tokens but does not establish a root content
            // color. Most ADE screens intentionally paint their own aurora behind
            // a transparent layout, so without this surface unwrapped Text falls
            // back to black even in dark mode.
            Surface(
                modifier = Modifier.fillMaxSize(),
                color = MaterialTheme.colorScheme.background,
                contentColor = MaterialTheme.colorScheme.onBackground,
                content = content,
            )
        }
    }
}
