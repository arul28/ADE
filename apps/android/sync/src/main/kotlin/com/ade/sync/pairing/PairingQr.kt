package com.ade.sync.pairing

import com.ade.sync.model.AddressCandidate
import com.ade.sync.model.PairingHostIdentity
import com.ade.sync.model.PairingQrPayload
import java.net.URI
import java.util.Base64
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

object PairingQr {
    const val URL_BASE = "https://ade-app.dev/pair"
    const val REQUIRED_VERSION = 3
    const val MAXIMUM_PAYLOAD_BYTES = 8 * 1024

    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }
    private val candidateKinds = setOf("lan", "saved", "tailscale", "loopback", "relay")

    fun encode(payload: PairingQrPayload): String {
        val bytes = json.encodeToString(PairingQrPayload.serializer(), payload).toByteArray()
        return "$URL_BASE#${Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)}"
    }

    fun parse(raw: String): PairingQrPayload? {
        val trimmed = raw.trim()
        if (trimmed.isEmpty() || trimmed.toByteArray().size > MAXIMUM_PAYLOAD_BYTES) return null
        val encoded = if (trimmed.startsWith("http://", true) || trimmed.startsWith("https://", true)) {
            val uri = runCatching { URI(trimmed) }.getOrNull() ?: return null
            if (uri.path != "/pair" && !uri.path.orEmpty().endsWith("/pair")) return null
            uri.rawFragment?.takeIf(String::isNotEmpty) ?: return null
        } else {
            trimmed
        }
        val decoded = if (encoded.startsWith("{")) {
            encoded
        } else {
            runCatching { Base64.getUrlDecoder().decode(padBase64(encoded)).toString(Charsets.UTF_8) }.getOrNull()
                ?: return null
        }
        val source = runCatching { json.parseToJsonElement(decoded).jsonObject }.getOrNull() ?: return null
        val version = source["version"]?.jsonPrimitive?.intOrNull ?: return null
        if (version < REQUIRED_VERSION) return null
        val host = parseHost(source["hostIdentity"] as? JsonObject ?: return null) ?: return null
        val port = source["port"]?.jsonPrimitive?.intOrNull ?: return null
        if (port !in 1..65_535) return null
        val candidates = source["addressCandidates"]?.let { element ->
            runCatching { element.jsonArray }.getOrNull()?.mapNotNull(::parseCandidate)
        }.orEmpty().distinctBy(AddressCandidate::host)
        val relayUrl = source.string("relayUrl")?.takeIf { it.startsWith("wss://", true) }
        return PairingQrPayload(
            version = REQUIRED_VERSION,
            hostIdentity = host,
            port = port,
            addressCandidates = candidates,
            relayUrl = relayUrl,
            claimToken = source.string("claimToken"),
            runtimeHostGrant = source.string("runtimeHostGrant"),
            pinConfigured = source["pinConfigured"]?.jsonPrimitive?.booleanOrNull,
        )
    }

    private fun parseHost(source: JsonObject): PairingHostIdentity? {
        val deviceId = source.string("deviceId") ?: return null
        val name = source.string("name") ?: return null
        val platform = source.string("platform")?.takeIf {
            it in setOf("macOS", "iOS", "linux", "windows", "android")
        } ?: "unknown"
        val type = source.string("deviceType")?.takeIf {
            it in setOf("desktop", "phone", "vps", "browser")
        } ?: "unknown"
        return PairingHostIdentity(
            deviceId = deviceId,
            siteId = source.string("siteId").orEmpty(),
            name = name,
            platform = platform,
            deviceType = type,
        )
    }

    private fun parseCandidate(element: kotlinx.serialization.json.JsonElement): AddressCandidate? {
        val source = element as? JsonObject ?: return null
        val host = source.string("host") ?: return null
        val kind = source.string("kind")?.takeIf(candidateKinds::contains) ?: "lan"
        return AddressCandidate(host, kind)
    }

    private fun JsonObject.string(key: String): String? = this[key]
        ?.jsonPrimitive
        ?.contentOrNull
        ?.trim()
        ?.takeIf(String::isNotEmpty)

    private fun padBase64(value: String): String = value + "=".repeat((4 - value.length % 4) % 4)
}
