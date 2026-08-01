package com.ade.sync.auth

import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlinx.serialization.json.Json
import org.bouncycastle.crypto.agreement.X25519Agreement
import org.bouncycastle.crypto.digests.SHA256Digest
import org.bouncycastle.crypto.generators.HKDFBytesGenerator
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.params.HKDFParameters
import org.bouncycastle.crypto.params.X25519PrivateKeyParameters
import org.bouncycastle.crypto.params.X25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer

class SealedAdoptionTest {
    @Test
    fun `negotiates each supported AEAD and binds it into the signed challenge`() {
        AdoptionAead.entries.forEach(::exercise)
    }

    private fun exercise(aead: AdoptionAead) {
        val random = SecureRandom()
        val client = SealedAdoption.create(random)
        val signing = Ed25519PrivateKeyParameters(random)
        val hostEphemeral = X25519PrivateKeyParameters(random)
        val hostPublic = Base64.getEncoder().encodeToString(hostEphemeral.generatePublicKey().encoded)
        val timestamp = System.currentTimeMillis()
        val canonical = listOf(
            SealedAdoption.CONTEXT,
            "host-device",
            client.challenge.nonce,
            client.challenge.clientEphemeralPublicKey,
            hostPublic,
            timestamp.toString(),
            aead.wireValue,
        ).joinToString("|")
        val signer = Ed25519Signer().apply {
            init(true, signing)
            update(canonical.toByteArray(), 0, canonical.toByteArray().size)
        }
        val response = AccountChallengeOk(
            v = 1,
            hostDeviceId = "host-device",
            ts = timestamp,
            hostEphemeralPublicKey = hostPublic,
            signature = Base64.getEncoder().encodeToString(signer.generateSignature()),
            aead = aead.wireValue,
        )
        val session = client.verifyAndDerive(
            response,
            expectedHostDeviceId = "host-device",
            directorySigningPublicKeyBase64 = Base64.getEncoder().encodeToString(signing.generatePublicKey().encoded),
            clientDeviceId = "android-device",
            nowMillis = timestamp,
        )
        assertEquals(aead, session.aead)

        val hostKey = deriveHostKey(hostEphemeral, client.challenge)
        assertContentEquals(hostKey, session.key)
        val hello = "{\"accountToken\":\"short-lived\"}".toByteArray()
        val sealedHello = session.sealHello(hello)
        assertContentEquals(
            hello,
            open(hostKey, "${SealedAdoption.CONTEXT}|host-device|android-device".toByteArray(), sealedHello, aead),
        )
        val helloOk = "{\"accountPairing\":{\"deviceId\":\"android-device\",\"secret\":\"paired\"}}".toByteArray()
        assertContentEquals(
            helloOk,
            session.openHelloOk(seal(
                hostKey,
                "${SealedAdoption.HELLO_OK_CONTEXT}|host-device|android-device".toByteArray(),
                helloOk,
                aead,
            )),
        )
    }

    private fun deriveHostKey(host: X25519PrivateKeyParameters, challenge: AccountChallenge): ByteArray {
        val agreement = X25519Agreement().apply { init(host) }
        val shared = ByteArray(agreement.agreementSize)
        agreement.calculateAgreement(
            X25519PublicKeyParameters(Base64.getDecoder().decode(challenge.clientEphemeralPublicKey), 0),
            shared,
            0,
        )
        return ByteArray(32).also { output ->
            HKDFBytesGenerator(SHA256Digest()).apply {
                init(HKDFParameters(
                    shared,
                    Base64.getDecoder().decode(challenge.nonce),
                    SealedAdoption.CONTEXT.toByteArray(),
                ))
                generateBytes(output, 0, output.size)
            }
        }
    }

    private fun seal(key: ByteArray, aad: ByteArray, plaintext: ByteArray, aead: AdoptionAead): String {
        val nonce = ByteArray(12).also(SecureRandom()::nextBytes)
        val cipher = cipher(Cipher.ENCRYPT_MODE, key, nonce, aead).apply { updateAAD(aad) }
        return Base64.getEncoder().encodeToString(nonce + cipher.doFinal(plaintext))
    }

    private fun open(key: ByteArray, aad: ByteArray, value: String, aead: AdoptionAead): ByteArray {
        val blob = Base64.getDecoder().decode(value)
        val cipher = cipher(Cipher.DECRYPT_MODE, key, blob.copyOfRange(0, 12), aead).apply { updateAAD(aad) }
        return cipher.doFinal(blob.copyOfRange(12, blob.size))
    }

    private fun cipher(mode: Int, key: ByteArray, nonce: ByteArray, aead: AdoptionAead): Cipher =
        Cipher.getInstance(aead.transformation).apply {
            init(
                mode,
                SecretKeySpec(key, if (aead == AdoptionAead.AES_256_GCM) "AES" else "ChaCha20"),
                if (aead == AdoptionAead.AES_256_GCM) GCMParameterSpec(128, nonce) else IvParameterSpec(nonce),
            )
        }
}
