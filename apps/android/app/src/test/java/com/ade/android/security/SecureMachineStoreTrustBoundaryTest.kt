package com.ade.android.security

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * SPEC.md §5.3: signing out of the Clerk account revokes account-scoped state
 * (relay routes, directory visibility, push registration) but must never delete
 * the paired secret, the DPoP key, or the machine profile. Only an explicit
 * "Forget machine" crosses that trust-deletion boundary.
 */
class SecureMachineStoreTrustBoundaryTest {
    private val deletedDpopAliases = mutableListOf<String>()
    private val preferences = FakeSharedPreferences()
    private val store = SecureMachineStore(preferences) { alias -> deletedDpopAliases += alias }

    private val profile = MachineProfile(
        machineKey = "machine-1",
        hostDeviceId = "host-device-1",
        accountMachineKey = "account-machine-1",
        name = "Studio",
        pairedDeviceId = "android-1",
        siteId = "site-1",
        secret = "paired-secret",
        endpoints = listOf(SavedEndpoint("ws://192.168.1.4:8787", "lan")),
    )

    private fun pair() {
        store.put(profile)
        store.setCurrent(profile.machineKey)
    }

    /** Everything MainViewModel.signOut touches that reaches persistent storage. */
    private fun signOutStoreEffects(ownerId: String) {
        val epoch = store.beginAttentionRevocation()
        store.completeAttentionRevocation(epoch)
        assertFalse(store.isAttentionRegistrationConfirmed(ownerId))
    }

    @Test
    fun `sign out preserves the paired secret, machine profile and DPoP key`() {
        pair()
        val ownerId = "user_123"
        store.confirmAttentionRegistration(ownerId, store.attentionEpochForOwner(ownerId))
        assertTrue(store.isAttentionRegistrationConfirmed(ownerId))
        val localDeviceId = store.localDeviceId()

        signOutStoreEffects(ownerId)

        val survived = assertNotNull(store.get(profile.machineKey), "machine profile must survive sign-out")
        assertEquals(profile.secret, survived.secret, "paired secret must survive sign-out")
        assertEquals(profile, survived)
        assertEquals(listOf(profile), store.list())
        assertEquals(profile.machineKey, store.current()?.machineKey, "current machine must survive sign-out")
        assertEquals(emptyList(), deletedDpopAliases, "sign-out must not delete the DPoP key")
        assertEquals(localDeviceId, store.localDeviceId(), "device identity must be stable across sign-out")
        // The LAN route the device reconnects over is still available without re-pairing.
        assertEquals(1, survived.routeCandidates().size)
    }

    @Test
    fun `forget machine deletes the profile and the DPoP key`() {
        pair()

        store.forget(profile.machineKey)

        assertNull(store.get(profile.machineKey), "forget must delete the machine profile")
        assertEquals(emptyList(), store.list())
        assertNull(store.current(), "forget must clear the current machine")
        assertEquals(
            listOf(SecureMachineStore.dpopAlias(profile.machineKey)),
            deletedDpopAliases,
            "forget must delete the DPoP key",
        )
    }

    @Test
    fun `forget only removes the named machine`() {
        pair()
        val other = profile.copy(machineKey = "machine-2", name = "Laptop", accountMachineKey = null)
        store.put(other)

        store.forget(profile.machineKey)

        assertEquals(listOf(other.machineKey), store.list().map { it.machineKey })
        assertEquals(listOf(SecureMachineStore.dpopAlias(profile.machineKey)), deletedDpopAliases)
    }

    @Test
    fun `re-pairing is required only after forget`() {
        pair()
        signOutStoreEffects("user_123")
        assertTrue(store.list().isNotEmpty(), "sign-out must not force re-pairing")

        store.forget(profile.machineKey)
        assertTrue(store.list().isEmpty(), "forget must force re-pairing")
    }
}
