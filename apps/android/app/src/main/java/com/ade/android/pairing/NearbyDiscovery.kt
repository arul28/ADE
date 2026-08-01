package com.ade.android.pairing

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.os.ext.SdkExtensions
import java.net.InetAddress
import java.util.concurrent.Executor
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class NearbyMachine(
    val serviceName: String,
    val hosts: List<String>,
    val port: Int,
    val deviceId: String? = null,
    val siteId: String = "",
    val deviceName: String? = null,
    val pinConfigured: Boolean? = null,
)

class NearbyDiscovery(
    context: Context,
    private val scope: CoroutineScope,
) : AutoCloseable {
    private val manager = context.getSystemService(NsdManager::class.java)
    private val executor = Executor(Runnable::run)
    private val _machines = MutableStateFlow<List<NearbyMachine>>(emptyList())
    private val pendingRemoval = mutableMapOf<String, Job>()
    private var discovering = false

    val machines: StateFlow<List<NearbyMachine>> = _machines.asStateFlow()

    private val listener = object : NsdManager.DiscoveryListener {
        override fun onDiscoveryStarted(serviceType: String) { discovering = true }
        override fun onDiscoveryStopped(serviceType: String) { discovering = false }
        override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) { discovering = false }
        override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) { discovering = false }

        override fun onServiceFound(serviceInfo: NsdServiceInfo) {
            pendingRemoval.remove(serviceInfo.serviceName)?.cancel()
            resolve(serviceInfo)
        }

        override fun onServiceLost(serviceInfo: NsdServiceInfo) {
            pendingRemoval.remove(serviceInfo.serviceName)?.cancel()
            pendingRemoval[serviceInfo.serviceName] = scope.launch {
                // mDNS found/lost flaps during address updates; keep the row
                // stable unless it remains absent beyond the debounce window.
                delay(1_500)
                _machines.value = _machines.value.filterNot { it.serviceName == serviceInfo.serviceName }
            }
        }
    }

    fun start(showSystemPicker: Boolean = true) {
        if (discovering) return
        if (showSystemPicker && supportsPicker() && startPickerReflectively()) return
        manager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
    }

    override fun close() {
        if (discovering) runCatching { manager.stopServiceDiscovery(listener) }
        pendingRemoval.values.forEach(Job::cancel)
        pendingRemoval.clear()
    }

    @Suppress("DEPRECATION")
    private fun resolve(service: NsdServiceInfo) {
        manager.resolveService(service, executor, object : NsdManager.ResolveListener {
            override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) = Unit
            override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
                val addresses = if (Build.VERSION.SDK_INT >= 34) {
                    serviceInfo.hostAddresses
                } else {
                    listOfNotNull(serviceInfo.host)
                }.map(InetAddress::getHostAddress).filterNotNull().distinct()
                if (addresses.isEmpty() || serviceInfo.port !in 1..65_535) return
                val txt = serviceInfo.attributes.mapValues { (_, bytes) -> bytes.toString(Charsets.UTF_8).trim() }
                val deviceId = txt["deviceId"]?.takeIf(String::isNotBlank)
                val item = NearbyMachine(
                    serviceName = serviceInfo.serviceName,
                    hosts = addresses,
                    port = serviceInfo.port,
                    deviceId = deviceId,
                    siteId = txt["siteId"].orEmpty(),
                    deviceName = txt["deviceName"]?.takeIf(String::isNotBlank),
                    pinConfigured = txt["pairingPinConfigured"]?.toBooleanStrictOrNull(),
                )
                _machines.value = (_machines.value.filterNot { it.serviceName == item.serviceName } + item)
                    .sortedBy(NearbyMachine::serviceName)
            }
        })
    }

    private fun supportsPicker(): Boolean = Build.VERSION.SDK_INT >= 37 ||
        (Build.VERSION.SDK_INT >= 33 && SdkExtensions.getExtensionVersion(Build.VERSION_CODES.TIRAMISU) >= 22)

    /** compileSdk remains 36; API-37 DiscoveryRequest is reached reflectively. */
    private fun startPickerReflectively(): Boolean = runCatching {
        val requestClass = Class.forName("android.net.nsd.DiscoveryRequest")
        val builderClass = Class.forName("android.net.nsd.DiscoveryRequest\$Builder")
        val builder = builderClass.getConstructor(String::class.java).newInstance(SERVICE_TYPE)
        val flag = requestClass.getField("FLAG_SHOW_PICKER").getLong(null)
        builderClass.getMethod("setFlags", Long::class.javaPrimitiveType).invoke(builder, flag)
        val request = builderClass.getMethod("build").invoke(builder)
        manager.javaClass.getMethod(
            "discoverServices",
            requestClass,
            Executor::class.java,
            NsdManager.DiscoveryListener::class.java,
        ).invoke(manager, request, executor, listener)
        true
    }.getOrDefault(false)

    companion object {
        const val SERVICE_TYPE = "_ade-sync._tcp."
    }
}
