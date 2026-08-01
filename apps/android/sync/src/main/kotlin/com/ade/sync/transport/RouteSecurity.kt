package com.ade.sync.transport

import java.net.Inet6Address
import java.net.InetAddress
import java.net.URI

/** Prevent credentials from crossing an attacker-controlled plaintext route. */
object RouteSecurity {
    fun requireSafe(candidate: RouteCandidate): RouteCandidate {
        val uri = runCatching { URI(candidate.url.trim()) }.getOrNull()
            ?: throw IllegalArgumentException("The ADE route is not a valid URL")
        val scheme = uri.scheme?.lowercase()
        val host = uri.host?.lowercase()?.trimEnd('.')
            ?: throw IllegalArgumentException("The ADE route has no host")
        require(uri.userInfo == null && uri.fragment == null) { "The ADE route contains unsupported credentials or fragments" }
        if (candidate.kind == RouteKind.RELAY) {
            require(scheme == "wss") { "ADE Relay connections require encrypted WebSockets" }
            return candidate.copy(url = candidate.url.trim())
        }
        require(scheme == "ws" || scheme == "wss") { "Direct ADE routes require WebSockets" }
        require(isTrustedDirectHost(host)) { "Refusing to send ADE credentials to a public direct route" }
        return candidate.copy(url = candidate.url.trim())
    }

    private fun isTrustedDirectHost(host: String): Boolean {
        if (host == "localhost" || host.endsWith(".local") || host.endsWith(".ts.net")) return true
        parseIpv4(host)?.let { octets ->
            val first = octets[0]
            val second = octets[1]
            return first == 10 || first == 127 ||
                (first == 172 && second in 16..31) ||
                (first == 192 && second == 168) ||
                (first == 169 && second == 254) ||
                (first == 100 && second in 64..127)
        }
        if (':' !in host) return false
        val address = runCatching { InetAddress.getByName(host) }.getOrNull() as? Inet6Address ?: return false
        val first = address.address[0].toInt() and 0xff
        val second = address.address[1].toInt() and 0xff
        return address.isLoopbackAddress || address.isLinkLocalAddress ||
            (first and 0xfe) == 0xfc || (first == 0xfe && (second and 0xc0) == 0x80)
    }

    private fun parseIpv4(host: String): IntArray? {
        val parts = host.split('.')
        if (parts.size != 4) return null
        val octets = parts.map { it.toIntOrNull()?.takeIf { value -> value in 0..255 } ?: return null }
        return octets.toIntArray()
    }
}
