package com.ade.android.ui

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
fun AdeAuroraBackground(modifier: Modifier = Modifier, stronger: Boolean = false) {
    val dark = MaterialTheme.colorScheme.background == AdePageDark
    val base = if (dark) AdePageDark else AdePageLight
    val purpleAlpha = if (stronger) 0.30f else 0.18f
    val greenAlpha = if (stronger) 0.20f else 0.10f
    Box(
        modifier.fillMaxSize().background(
            Brush.radialGradient(
                0f to AdePurple.copy(alpha = purpleAlpha),
                0.42f to AdePurple.copy(alpha = purpleAlpha * 0.28f),
                1f to Color.Transparent,
                radius = 920f,
            ),
        ).background(
            Brush.radialGradient(
                0f to MaterialTheme.colorScheme.primary.copy(alpha = greenAlpha),
                1f to Color.Transparent,
                center = androidx.compose.ui.geometry.Offset(110f, 80f),
                radius = 720f,
            ),
        ).background(base.copy(alpha = if (dark) 0.84f else 0.74f)),
    )
}

@Composable
fun AdeWordmark(compact: Boolean = false, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val image = remember {
        runCatching { context.assets.open("logo.png").use(BitmapFactory::decodeStream)?.asImageBitmap() }.getOrNull()
    }
    // The BrandMark asset is a deliberate "glitch" lockup with an offset dark
    // ghost behind each letter. That reads as a rendering artifact once it is
    // scaled down to top-bar height, so — as on iOS — chrome gets a clean
    // wordmark and only the large empty state uses the glitch artwork.
    if (image != null && !compact) {
        Image(
            bitmap = image,
            contentDescription = "ADE",
            modifier = modifier.height(132.dp).aspectRatio(2.04f),
            contentScale = ContentScale.Fit,
        )
    } else {
        Text(
            "ADE",
            modifier = modifier,
            style = TextStyle(
                brush = Brush.linearGradient(listOf(Color(0xFF4C1D95), AdePurpleDeep, Color(0xFF8B5CF6))),
                fontSize = if (compact) 19.sp else 72.sp,
                lineHeight = if (compact) 22.sp else 76.sp,
                fontWeight = FontWeight.Black,
                letterSpacing = if (compact) (-0.5).sp else (-4).sp,
            ),
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
fun StatusDot(color: Color, size: Dp = 7.dp) {
    Surface(Modifier.size(size), shape = CircleShape, color = color) {}
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AdeScreen(
    title: String,
    onBack: (() -> Unit)? = null,
    actions: @Composable () -> Unit = {},
    content: @Composable () -> Unit,
) {
    Box(Modifier.fillMaxSize()) {
        AdeAuroraBackground()
        Column(Modifier.fillMaxSize()) {
            TopAppBar(
                title = { Text(title, fontWeight = FontWeight.SemiBold) },
                navigationIcon = {
                    if (onBack != null) IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = { actions() },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent),
            )
            content()
        }
    }
}

@Composable
fun AdeCard(
    modifier: Modifier = Modifier,
    color: Color = MaterialTheme.colorScheme.surface.copy(alpha = 0.78f),
    padding: Dp = 14.dp,
    content: @Composable () -> Unit,
) {
    val shape = RoundedCornerShape(14.dp)
    Surface(
        modifier = modifier.fillMaxWidth().border(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.72f), shape),
        shape = shape,
        shadowElevation = 0.dp,
        color = color,
    ) { Column(Modifier.padding(padding)) { content() } }
}

@Composable
fun GlassIconButton(onClick: () -> Unit, contentDescription: String, content: @Composable () -> Unit) {
    Surface(
        modifier = Modifier.size(38.dp).border(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.72f), CircleShape),
        color = MaterialTheme.colorScheme.surface.copy(alpha = 0.72f),
        shape = CircleShape,
    ) {
        IconButton(onClick = onClick) { content() }
    }
}

@Composable
fun ErrorBanner(message: String, onDismiss: () -> Unit, modifier: Modifier = Modifier) {
    Surface(
        modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp).shadow(8.dp, RoundedCornerShape(12.dp)),
        color = MaterialTheme.colorScheme.errorContainer,
        shape = RoundedCornerShape(12.dp),
    ) {
        Row(Modifier.padding(start = 16.dp, top = 8.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(message, Modifier.weight(1f), color = MaterialTheme.colorScheme.onErrorContainer)
            IconButton(onClick = onDismiss) { Icon(Icons.Rounded.Close, "Dismiss") }
        }
    }
}

@Composable
fun BusyOverlay(show: Boolean) {
    if (!show) return
    // Non-blocking and top-anchored. A centred modal spinner sat on top of the
    // Hub's lane rows and hid live content while a refresh was in flight; the
    // work is never blocking, so it gets an unobtrusive status pill instead.
    Box(
        // Sits in the top-bar gutter, where nothing else is drawn — at 54dp it
        // landed on the section subtitle instead.
        Modifier.fillMaxSize().statusBarsPadding().padding(top = 6.dp),
        contentAlignment = Alignment.TopCenter,
    ) {
        Surface(
            shape = RoundedCornerShape(999.dp),
            shadowElevation = 4.dp,
            color = MaterialTheme.colorScheme.surface.copy(alpha = 0.92f),
            border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.6f)),
        ) {
            Row(
                Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                CircularProgressIndicator(Modifier.size(13.dp), strokeWidth = 2.dp)
                Spacer(Modifier.size(8.dp))
                Text("Working…", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
fun SectionTitle(title: String, subtitle: String? = null, modifier: Modifier = Modifier) {
    // Must own a Column: callers place this inside a Row, and without its own
    // layout the title and subtitle became horizontal siblings — which is why
    // the Hub rendered "ProjectsLive work across this machine".
    Column(modifier) {
        Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        if (subtitle != null) {
            Spacer(Modifier.height(3.dp))
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
