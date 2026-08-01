package com.ade.android.ui

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ChevronRight
import androidx.compose.material.icons.rounded.Computer
import androidx.compose.material.icons.rounded.QrCodeScanner
import androidx.compose.material.icons.rounded.Radar
import androidx.compose.material.icons.rounded.Security
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.IntOffset
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.ui.unit.dp
import kotlin.math.roundToInt
import androidx.compose.foundation.layout.offset
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.ade.android.MainUiState
import com.ade.android.MainViewModel
import com.ade.sync.model.AddressCandidate
import com.ade.sync.model.PairingHostIdentity
import com.ade.sync.model.PairingQrPayload
import androidx.core.content.ContextCompat

@Composable
fun AccessGateScreen(onSignIn: () -> Unit, onContinue: () -> Unit) {
    Column(
        Modifier.fillMaxSize().padding(horizontal = 28.dp, vertical = 44.dp),
        verticalArrangement = Arrangement.SpaceBetween,
    ) {
        Column {
            Surface(Modifier.size(58.dp), shape = CircleShape, color = MaterialTheme.colorScheme.primaryContainer) {
                Box(contentAlignment = Alignment.Center) {
                    Text("A", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Black)
                }
            }
            Spacer(Modifier.height(34.dp))
            Text("Your agents, anywhere.", style = MaterialTheme.typography.displaySmall, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(14.dp))
            Text(
                "Follow live work, answer approvals, and start a new lane from your phone.",
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Button(onClick = onSignIn, modifier = Modifier.fillMaxWidth()) { Text("Sign in") }
            OutlinedButton(onClick = onContinue, modifier = Modifier.fillMaxWidth()) { Text("Continue without account") }
            Text(
                "Without an account, pair on the same network with your machine's six-digit PIN.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
fun SignInEmailScreen(viewModel: MainViewModel, onBack: () -> Unit, onCode: (String) -> Unit) {
    var email by remember { mutableStateOf("") }
    AdeScreen("Sign in", onBack) {
        Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            Text("Use the same ADE account as your machines.", style = MaterialTheme.typography.bodyLarge)
            OutlinedTextField(
                value = email,
                onValueChange = { email = it },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("Email") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
            )
            Button(
                onClick = { viewModel.sendEmailCode(email) { onCode(email) } },
                enabled = '@' in email,
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Send code") }
            OutlinedButton(onClick = {}, modifier = Modifier.fillMaxWidth(), enabled = false) { Text("Continue with Google — coming soon") }
            OutlinedButton(onClick = {}, modifier = Modifier.fillMaxWidth(), enabled = false) { Text("Continue with GitHub — coming soon") }
        }
    }
}

@Composable
fun SignInCodeScreen(viewModel: MainViewModel, email: String, onBack: () -> Unit, onDone: () -> Unit) {
    var code by remember { mutableStateOf("") }
    AdeScreen("Check your email", onBack) {
        Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            Text("Enter the six-digit code sent to $email.")
            OutlinedTextField(
                value = code,
                onValueChange = { code = it.filter(Char::isDigit).take(6) },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("Verification code") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
            )
            Button(
                onClick = { viewModel.verifyEmailCode(code, onDone) },
                enabled = code.length == 6,
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Verify") }
        }
    }
}

@Composable
fun MachinesScreen(
    state: MainUiState,
    viewModel: MainViewModel,
    onBack: () -> Unit,
    onPair: () -> Unit,
    onDone: () -> Unit,
    onConnected: () -> Unit,
) {
    LaunchedEffect(Unit) { if (state.signedIn) viewModel.refreshDirectory() }
    val savedByDirectoryKey = state.machines.associate { directory ->
        directory.machineKey to state.savedMachines.firstOrNull { it.matches(directory) }
    }
    val matchedSavedKeys = savedByDirectoryKey.values.filterNotNull().mapTo(mutableSetOf()) { it.machineKey }
    val unmatchedSavedMachines = state.savedMachines.filterNot { it.machineKey in matchedSavedKeys }
    AdeScreen("Your machines", onBack, actions = {
        IconButton(onClick = onPair) { Icon(Icons.Rounded.QrCodeScanner, "Pair a machine") }
        TextButton(onClick = onDone) { Text("Done") }
    }) {
        LazyColumn(
            Modifier.fillMaxSize().padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (state.machines.isNotEmpty()) {
                item { SectionTitle("Account machines", "Tap a machine to connect securely.") }
                items(state.machines, key = { it.machineKey }) { machine ->
                    val saved = savedByDirectoryKey[machine.machineKey]
                    MachineRow(
                        name = machine.customName ?: machine.name ?: "ADE machine",
                        detail = when {
                            machine.online -> "Online"
                            saved != null -> "Saved pairing"
                            else -> "Last seen offline"
                        },
                        enabled = saved != null || machine.reachableEndpoints.isNotEmpty(),
                        onClick = {
                            if (saved != null) viewModel.connect(saved, onConnected)
                            else viewModel.connectAccount(machine, onConnected)
                        },
                    )
                }
            }
            if (unmatchedSavedMachines.isNotEmpty()) {
                item { Spacer(Modifier.height(4.dp)); SectionTitle("Paired machines") }
                items(unmatchedSavedMachines, key = { it.machineKey }) { machine ->
                    MachineRow(machine.name, "Saved pairing", true) {
                        viewModel.connect(machine, onConnected)
                    }
                }
            }
            item {
                OutlinedButton(onClick = onPair, modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp)) {
                    Text("Add a machine")
                }
            }
        }
    }
}

@Composable
private fun MachineRow(name: String, detail: String, enabled: Boolean, onClick: () -> Unit) {
    AdeCard(Modifier.clickable(enabled = enabled, onClick = onClick)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Rounded.Computer, null, tint = MaterialTheme.colorScheme.primary)
            Column(Modifier.weight(1f).padding(horizontal = 14.dp)) {
                Text(name, fontWeight = FontWeight.SemiBold)
                Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Icon(Icons.Rounded.ChevronRight, null)
        }
    }
}

@Composable
fun PairingEntryScreen(onBack: () -> Unit, onQr: () -> Unit, onNearby: () -> Unit) {
    AdeScreen("Add a machine", onBack) {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            PairingChoice(Icons.Rounded.QrCodeScanner, "Scan QR code", "Fastest — open Connections on your machine.", onQr)
            PairingChoice(Icons.Rounded.Radar, "Find nearby", "Discover ADE machines on this network.", onNearby)
            PairingChoice(Icons.Rounded.Security, "SSH bootstrap", "Deferred from Android v1.", {}, enabled = false)
        }
    }
}

@Composable
private fun PairingChoice(icon: androidx.compose.ui.graphics.vector.ImageVector, title: String, detail: String, onClick: () -> Unit, enabled: Boolean = true) {
    AdeCard(Modifier.clickable(enabled = enabled, onClick = onClick)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, null, tint = MaterialTheme.colorScheme.primary)
            Column(Modifier.weight(1f).padding(horizontal = 14.dp)) {
                Text(title, fontWeight = FontWeight.SemiBold)
                Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Icon(Icons.Rounded.ChevronRight, null)
        }
    }
}

@Composable
fun NearbyScreen(viewModel: MainViewModel, onBack: () -> Unit, onSelected: () -> Unit) {
    val machines by viewModel.nearby.machines.collectAsStateWithLifecycle()
    val context = LocalContext.current
    var permissionGranted by remember {
        mutableStateOf(
            Build.VERSION.SDK_INT >= 37 ||
                ContextCompat.checkSelfPermission(context, Manifest.permission.NEARBY_WIFI_DEVICES) == PackageManager.PERMISSION_GRANTED ||
                (Build.VERSION.SDK_INT <= 32 && ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED),
        )
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        permissionGranted = granted
    }
    LaunchedEffect(permissionGranted) {
        if (permissionGranted) viewModel.nearby.start(showSystemPicker = true)
        else permission.launch(if (Build.VERSION.SDK_INT >= 33) Manifest.permission.NEARBY_WIFI_DEVICES else Manifest.permission.ACCESS_FINE_LOCATION)
    }
    AdeScreen("Nearby machines", onBack) {
        LazyColumn(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            item { Text("Choose the ADE machine you want to pair. Service addresses update automatically.") }
            if (!permissionGranted) item {
                Button(
                    onClick = { permission.launch(if (Build.VERSION.SDK_INT >= 33) Manifest.permission.NEARBY_WIFI_DEVICES else Manifest.permission.ACCESS_FINE_LOCATION) },
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("Allow nearby discovery") }
            }
            items(machines, key = { it.serviceName }) { machine ->
                MachineRow(machine.deviceName ?: machine.serviceName, machine.hosts.firstOrNull() ?: "Resolving…", true) {
                    val payload = PairingQrPayload(
                        version = 3,
                        hostIdentity = PairingHostIdentity(
                            // Android NSD can resolve a service while omitting
                            // TXT. The paired hello replaces this route-derived
                            // placeholder with the authenticated host identity.
                            deviceId = machine.deviceId ?: "nearby-${java.util.UUID.nameUUIDFromBytes(
                                "${machine.serviceName}|${machine.port}".toByteArray(),
                            )}",
                            siteId = machine.siteId,
                            name = machine.deviceName ?: machine.serviceName,
                            platform = "darwin",
                            deviceType = "desktop",
                        ),
                        port = machine.port,
                        addressCandidates = machine.hosts.map { AddressCandidate(it, "lan") },
                        pinConfigured = machine.pinConfigured,
                    )
                    if (viewModel.setPairingText(com.ade.sync.pairing.PairingQr.encode(payload))) onSelected()
                }
            }
            if (machines.isEmpty()) item { Text("Looking for ADE Sync…", color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
    }
}

@Composable
fun PinScreen(state: MainUiState, viewModel: MainViewModel, onBack: () -> Unit, onDone: () -> Unit) {
    var showHelp by remember { mutableStateOf(state.pairingPayload?.pinConfigured == false) }
    val shake = remember { Animatable(0f) }
    LaunchedEffect(state.error) {
        val error = state.error.orEmpty().lowercase()
        if ("pin" in error || "pair" in error) {
            if ("not set" in error || "pin_not_set" in error) showHelp = true
            listOf(-14f, 14f, -10f, 10f, 0f).forEach { target ->
                shake.animateTo(target, tween(55))
            }
        }
    }
    AdeScreen("Enter pairing PIN", onBack) {
        Column(
            Modifier.padding(24.dp).offset { IntOffset(shake.value.roundToInt(), 0) },
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            Text("Connecting to ${state.pairingPayload?.hostIdentity?.name ?: "your machine"}")
            BasicTextField(
                value = state.pairingPin,
                onValueChange = viewModel::setPairingPin,
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                decorationBox = { inner ->
                    Box {
                        Box(Modifier.size(1.dp)) { inner() }
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            repeat(6) { index ->
                                Surface(
                                    Modifier.weight(1f).height(56.dp),
                                    shape = MaterialTheme.shapes.small,
                                    color = MaterialTheme.colorScheme.surfaceVariant,
                                ) {
                                    Box(contentAlignment = Alignment.Center) {
                                        Text(
                                            state.pairingPin.getOrNull(index)?.toString().orEmpty(),
                                            style = MaterialTheme.typography.headlineSmall,
                                            fontWeight = FontWeight.Bold,
                                        )
                                    }
                                }
                            }
                        }
                    }
                },
            )
            Button(
                onClick = { viewModel.pair(onDone) },
                modifier = Modifier.fillMaxWidth(),
                enabled = state.pairingPin.length == 6 && state.pairingPayload?.pinConfigured != false,
            ) { Text("Pair and connect") }
            OutlinedButton(onClick = { showHelp = !showHelp }, modifier = Modifier.fillMaxWidth()) { Text("Where is the PIN?") }
            if (showHelp) AdeCard {
                Text("Set up a PIN on the machine", fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.height(8.dp))
                Text("Open ADE → Connections → This Mac, then generate or set a six-digit pairing PIN. The PIN is never embedded in the QR code.")
            }
        }
    }
}
