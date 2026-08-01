package com.ade.android.pairing

import android.app.Activity
import android.companion.AssociationInfo
import android.companion.AssociationRequest
import android.companion.CompanionDeviceManager
import android.content.IntentSender
import android.content.pm.PackageManager
import android.os.Build
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine

object CompanionAssociation {
    suspend fun request(activity: Activity, displayName: String): Boolean {
        if (Build.VERSION.SDK_INT < 33) return false
        val hasFeature = activity.packageManager.hasSystemFeature(PackageManager.FEATURE_COMPANION_DEVICE_SETUP)
        val permissionGranted = activity.checkSelfPermission(REQUEST_SELF_MANAGED_PERMISSION) ==
            PackageManager.PERMISSION_GRANTED
        if (!canRequestSelfManagedAssociation(Build.VERSION.SDK_INT, hasFeature, permissionGranted)) {
            return false
        }
        val manager = activity.getSystemService(CompanionDeviceManager::class.java)
        val request = AssociationRequest.Builder()
            .setSelfManaged(true)
            .setDisplayName(displayName)
            .build()
        return suspendCancellableCoroutine { continuation ->
            try {
                manager.associate(request, activity.mainExecutor, object : CompanionDeviceManager.Callback() {
                    override fun onAssociationPending(intentSender: IntentSender) {
                        try {
                            activity.startIntentSenderForResult(intentSender, REQUEST_CODE, null, 0, 0, 0)
                        } catch (_: IntentSender.SendIntentException) {
                            if (continuation.isActive) continuation.resume(false)
                        }
                    }

                    override fun onAssociationCreated(associationInfo: AssociationInfo) {
                        if (continuation.isActive) continuation.resume(true)
                    }

                    override fun onFailure(error: CharSequence?) {
                        if (continuation.isActive) continuation.resume(false)
                    }
                })
            } catch (_: SecurityException) {
                if (continuation.isActive) continuation.resume(false)
            }
        }
    }

    private const val REQUEST_CODE = 7104
    private const val REQUEST_SELF_MANAGED_PERMISSION =
        "android.permission.REQUEST_COMPANION_SELF_MANAGED"
}

internal fun canRequestSelfManagedAssociation(
    sdkInt: Int,
    hasCompanionSetupFeature: Boolean,
    selfManagedPermissionGranted: Boolean,
): Boolean = sdkInt >= 33 && hasCompanionSetupFeature && selfManagedPermissionGranted
