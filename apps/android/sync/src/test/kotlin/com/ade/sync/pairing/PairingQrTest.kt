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
    fun `newer payload versions and unknown fields parse leniently`() {
        // Forward compatibility: an old app scanning a newer desktop's QR must
        // still pair as long as the fields this build understands are present.
        val future = """
            {"version":4,"hostIdentity":{"deviceId":"host-1","siteId":"site-1","name":"Arul's Mac",
            "platform":"macOS","deviceType":"desktop","futureField":"ignored"},"port":8787,
            "addressCandidates":[{"host":"192.168.1.4","kind":"lan"},{"host":"192.168.1.4","kind":"saved"},
            {"host":"100.75.20.63","kind":"unknown-kind"}],"relayUrl":"wss://relay.example/connect/key",
            "pinConfigured":true,"somethingNew":{"nested":true}}
        """.trimIndent().replace("\n", "")

        val parsed = PairingQr.parse(future)
        assertEquals(3, parsed?.version, "the payload is normalized to the version this build speaks")
        assertEquals(payload.hostIdentity, parsed?.hostIdentity)
        assertEquals(8787, parsed?.port)
        // Duplicate hosts collapse and an unknown candidate kind falls back to LAN.
        assertEquals(
            listOf(AddressCandidate("192.168.1.4", "lan"), AddressCandidate("100.75.20.63", "lan")),
            parsed?.addressCandidates,
        )
        assertEquals("wss://relay.example/connect/key", parsed?.relayUrl)
        assertEquals(true, parsed?.pinConfigured)
    }

    @Test
    fun `rejects insecure relay urls and identity-less payloads`() {
        assertNull(PairingQr.parse("""{"version":3,"port":8787}"""))
        assertNull(
            PairingQr.parse("""{"version":3,"hostIdentity":{"siteId":"s"},"port":8787}"""),
            "a QR without a device id and name cannot identify a machine",
        )
        assertEquals(
            null,
            PairingQr.parse(PairingQr.encode(payload.copy(relayUrl = "ws://relay.example/connect/key")))?.relayUrl,
            "a cleartext relay URL must be dropped rather than trusted",
        )
    }

    @Test
    fun `rejects stale malformed and oversized payloads`() {
        assertNull(PairingQr.parse("https://ade-app.dev/not-pair#abc"))
        assertNull(PairingQr.parse("A".repeat(9 * 1024)))
        assertNull(PairingQr.parse(PairingQr.encode(payload.copy(version = 2))))
        assertNull(PairingQr.parse(PairingQr.encode(payload.copy(port = 70_000))))
    }
}
