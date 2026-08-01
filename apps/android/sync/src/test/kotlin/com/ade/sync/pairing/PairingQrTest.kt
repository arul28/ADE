package com.ade.sync.pairing

import com.ade.sync.model.AddressCandidate
import com.ade.sync.model.PairingHostIdentity
import com.ade.sync.model.PairingQrPayload
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

class PairingQrTest {
    private val payload = PairingQrPayload(
        version = 3,
        hostIdentity = PairingHostIdentity("host-1", "site-1", "Arul's Mac", "macOS", "desktop"),
        port = 8787,
        addressCandidates = listOf(AddressCandidate("192.168.1.4", "lan")),
        relayUrl = "wss://relay.example/connect/key",
        pinConfigured = true,
    )

    @Test
    fun `parses v3 smart URL and defensive bare forms`() {
        val smart = PairingQr.encode(payload)
        assertEquals(payload, PairingQr.parse(smart))
        assertEquals(payload, PairingQr.parse(smart.substringAfter('#')))
        assertEquals(payload, PairingQr.parse(Json.encodeToString(payload)))
    }

    @Test
    fun `rejects stale malformed and oversized payloads`() {
        assertNull(PairingQr.parse("https://ade-app.dev/not-pair#abc"))
        assertNull(PairingQr.parse("A".repeat(9 * 1024)))
        assertNull(PairingQr.parse(PairingQr.encode(payload.copy(version = 2))))
        assertNull(PairingQr.parse(PairingQr.encode(payload.copy(port = 70_000))))
    }
}
