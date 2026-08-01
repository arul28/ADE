package com.ade.sync.auth

import java.security.KeyFactory
import java.security.Signature
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import java.security.spec.ECGenParameterSpec
import java.security.AlgorithmParameters
import java.util.Base64
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class DpopTest {
    @Test
    fun `canonical challenge matches host contract and signature verifies`() {
        val key = JvmDpopKey.generate()
        val proof = Dpop.proof(key, "device-1", "paired-secret", 1_700_000_000, "nonce-1")
        val challenge = "ade-dpop-v1\ndevice-1\n" + Dpop.sha256Hex("paired-secret") + "\n1700000000\nnonce-1"
        assertEquals(challenge, Dpop.challenge("device-1", "paired-secret", 1_700_000_000, "nonce-1"))

        val raw = Base64.getDecoder().decode(proof.publicKey)
        val params = AlgorithmParameters.getInstance("EC").apply { init(ECGenParameterSpec("secp256r1")) }
            .getParameterSpec(java.security.spec.ECParameterSpec::class.java)
        val x = java.math.BigInteger(1, raw.copyOfRange(1, 33))
        val y = java.math.BigInteger(1, raw.copyOfRange(33, 65))
        val publicKey = KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(ECPoint(x, y), params))
        val verifier = Signature.getInstance("SHA256withECDSA").apply {
            initVerify(publicKey)
            update(challenge.toByteArray())
        }
        assertTrue(verifier.verify(Base64.getDecoder().decode(proof.signature)))
    }
}
