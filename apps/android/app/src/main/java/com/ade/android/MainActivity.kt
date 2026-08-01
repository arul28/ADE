package com.ade.android

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.runtime.getValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation3.runtime.NavEntry
import androidx.navigation3.ui.NavDisplay
import com.ade.android.data.Appearance
import com.ade.android.ui.AdeTheme

sealed interface AppRoute {
    data object Access : AppRoute
    data object SignInEmail : AppRoute
    data class SignInCode(val email: String) : AppRoute
    data object Machines : AppRoute
    data object Pairing : AppRoute
    data object Scanner : AppRoute
    data object Nearby : AppRoute
    data object Pin : AppRoute
    data object Hub : AppRoute
    data object PersonalChats : AppRoute
    data class Workspace(val projectId: String, val rootPath: String?) : AppRoute
    data class Session(val sessionId: String) : AppRoute
    data object Settings : AppRoute
}

class MainActivity : ComponentActivity() {
    private val viewModel: MainViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        handleIntent(intent)
        setContent {
            val graph = (application as AdeApplication).graph
            val appearance by graph.preferences.appearance.collectAsStateWithLifecycle(Appearance.SYSTEM)
            val dark = when (appearance) {
                Appearance.SYSTEM -> androidx.compose.foundation.isSystemInDarkTheme()
                Appearance.LIGHT -> false
                Appearance.DARK -> true
            }
            AdeTheme(dark) {
                val state by viewModel.ui.collectAsStateWithLifecycle()
                val initial = when {
                    state.pairingPayload != null -> AppRoute.Pin
                    graph.machineStore.current() != null -> AppRoute.Hub
                    else -> AppRoute.Access
                }
                val backStack = remember { mutableStateListOf<AppRoute>(initial) }
                LaunchedEffect(state.signedIn) {
                    if (state.signedIn && backStack.size == 1 && backStack.first() == AppRoute.Access) {
                        backStack.apply { clear(); add(AppRoute.Machines) }
                    }
                }
                LaunchedEffect(state.deepLinkSequence) {
                    if (state.deepLinkSequence > 0) {
                        val sessionId = state.deepLinkSessionId
                        if (sessionId == null) {
                            backStack.apply { clear(); add(AppRoute.Pin) }
                        } else {
                            viewModel.openDeepLinkSession(sessionId, state.deepLinkMachineKey) { session ->
                                backStack.apply { clear(); add(AppRoute.Session(session.id)) }
                            }
                        }
                    }
                }
                NavDisplay(
                    backStack = backStack,
                    modifier = Modifier,
                    onBack = { if (backStack.size > 1) backStack.removeAt(backStack.lastIndex) },
                    entryProvider = { route ->
                        NavEntry(route) {
                            AppRouteContent(
                                route = route,
                                viewModel = viewModel,
                                activity = this,
                                navigate = { next -> backStack.add(next) },
                                replaceAll = { next -> backStack.apply { clear(); add(next) } },
                                back = { if (backStack.size > 1) backStack.removeAt(backStack.lastIndex) },
                            )
                        }
                    },
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    override fun onStart() {
        super.onStart()
        viewModel.setAppForeground(true)
    }

    override fun onStop() {
        viewModel.setAppForeground(false)
        super.onStop()
    }

    private fun handleIntent(intent: Intent?) {
        val deepLink = intent?.data ?: intent?.getStringExtra("ade_deep_link")?.let(android.net.Uri::parse)
        viewModel.handleDeepLink(deepLink)
    }
}
