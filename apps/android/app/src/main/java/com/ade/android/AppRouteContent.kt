package com.ade.android

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import com.ade.android.pairing.CompanionAssociation
import com.ade.android.ui.AccessGateScreen
import com.ade.android.ui.BusyOverlay
import com.ade.android.ui.ErrorBanner
import com.ade.android.ui.HubScreen
import com.ade.android.ui.MachinesScreen
import com.ade.android.ui.NearbyScreen
import com.ade.android.ui.PairingEntryScreen
import com.ade.android.ui.PinScreen
import com.ade.android.ui.PersonalChatsScreen
import com.ade.android.ui.QrScannerScreen
import com.ade.android.ui.SessionScreen
import com.ade.android.ui.SettingsScreen
import com.ade.android.ui.SignInCodeScreen
import com.ade.android.ui.SignInEmailScreen
import com.ade.android.ui.WorkspaceScreen
import kotlinx.coroutines.launch

@Composable
fun AppRouteContent(
    route: AppRoute,
    viewModel: MainViewModel,
    activity: ComponentActivity,
    navigate: (AppRoute) -> Unit,
    replaceAll: (AppRoute) -> Unit,
    back: () -> Unit,
) {
    val state by viewModel.ui.collectAsStateWithLifecycle()
    val catalog by viewModel.catalog.collectAsStateWithLifecycle()
    LaunchedEffect(route) {
        viewModel.captureScreen(
            when (route) {
                AppRoute.Access, AppRoute.SignInEmail, is AppRoute.SignInCode,
                AppRoute.Machines, AppRoute.Pairing, AppRoute.Scanner, AppRoute.Nearby, AppRoute.Pin -> "onboarding"
                AppRoute.Hub -> "hub"
                AppRoute.PersonalChats -> "personal_chats"
                is AppRoute.Workspace -> "project"
                is AppRoute.Session -> "chat"
                AppRoute.Settings -> "settings"
            },
        )
    }
    Box(Modifier.fillMaxSize()) {
        when (route) {
            AppRoute.Access -> AccessGateScreen(
                onSignIn = { navigate(AppRoute.SignInEmail) },
                onContinue = { navigate(AppRoute.Pairing) },
            )
            AppRoute.SignInEmail -> SignInEmailScreen(viewModel, back) { navigate(AppRoute.SignInCode(it)) }
            is AppRoute.SignInCode -> SignInCodeScreen(viewModel, route.email, back) { navigate(AppRoute.Machines) }
            AppRoute.Machines -> MachinesScreen(
                state,
                viewModel,
                back,
                { navigate(AppRoute.Pairing) },
                { replaceAll(AppRoute.Hub) },
                { replaceAll(AppRoute.Hub) },
            )
            AppRoute.Pairing -> PairingEntryScreen(back, { navigate(AppRoute.Scanner) }, { navigate(AppRoute.Nearby) })
            AppRoute.Scanner -> QrScannerScreen(back) { raw ->
                if (viewModel.setPairingText(raw)) navigate(AppRoute.Pin)
            }
            AppRoute.Nearby -> NearbyScreen(viewModel, back) { navigate(AppRoute.Pin) }
            AppRoute.Pin -> PinScreen(state, viewModel, back) {
                val host = state.pairingPayload?.hostIdentity?.name ?: "ADE machine"
                activity.lifecycleScope.launch { CompanionAssociation.request(activity, host) }
                replaceAll(AppRoute.Hub)
            }
            AppRoute.Hub -> HubScreen(
                viewModel = viewModel,
                onSettings = { navigate(AppRoute.Settings) },
                onPair = { navigate(AppRoute.Pairing) },
                onOpenProject = { navigate(AppRoute.Workspace(it.id, it.rootPath)) },
                onOpenSession = { navigate(AppRoute.Session(it.id)) },
                onPersonalChats = { navigate(AppRoute.PersonalChats) },
            )
            AppRoute.PersonalChats -> PersonalChatsScreen(
                viewModel = viewModel,
                onBack = back,
                onSession = { navigate(AppRoute.Session(it.id)) },
            )
            is AppRoute.Workspace -> {
                val project = catalog.projects.firstOrNull { it.id == route.projectId }
                WorkspaceScreen(
                    viewModel,
                    project,
                    onBack = { replaceAll(AppRoute.Hub) },
                    onSettings = { navigate(AppRoute.Settings) },
                    onSession = { navigate(AppRoute.Session(it.id)) },
                )
            }
            is AppRoute.Session -> SessionScreen(viewModel, route.sessionId, back)
            AppRoute.Settings -> SettingsScreen(
                viewModel = viewModel,
                activity = activity,
                onBack = back,
                onPair = { navigate(AppRoute.Pairing) },
                onSignedOut = { replaceAll(AppRoute.Access) },
                onForgot = { replaceAll(AppRoute.Access) },
            )
        }
        state.error?.let {
            ErrorBanner(
                it,
                viewModel::clearError,
                Modifier.align(Alignment.BottomCenter).padding(bottom = 92.dp),
            )
        }
        BusyOverlay(state.loading)
    }
}
