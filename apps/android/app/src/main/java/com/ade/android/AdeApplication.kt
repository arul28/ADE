package com.ade.android

import android.app.Application
import android.util.Log
import com.ade.android.account.AccountDirectoryClient
import com.ade.android.account.AuthRepository
import com.ade.android.account.AttentionRepository
import com.ade.android.data.AppPreferences
import com.ade.android.pairing.PairingRepository
import com.ade.android.security.SecureMachineStore
import com.ade.sync.client.AdeSyncClient
import com.ade.sync.client.SyncLog
import com.clerk.api.Clerk
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import kotlinx.coroutines.sync.Mutex
import okhttp3.OkHttpClient

class AdeApplication : Application() {
    lateinit var graph: AppGraph
        private set

    override fun onCreate() {
        super.onCreate()
        // Local operational diagnostics only: protocol action names, opaque
        // request ids, elapsed millis. Never frame payloads. See docs/logging.md.
        SyncLog.sink = { line -> Log.i("AdeSync", line) }
        if (BuildConfig.CLERK_PUBLISHABLE_KEY.isNotBlank()) {
            Clerk.initialize(this, BuildConfig.CLERK_PUBLISHABLE_KEY)
        }
        if (
            BuildConfig.FCM_PROJECT_ID.isNotBlank() &&
            BuildConfig.FCM_APPLICATION_ID.isNotBlank() &&
            BuildConfig.FCM_API_KEY.isNotBlank() &&
            BuildConfig.FCM_SENDER_ID.isNotBlank()
        ) {
            FirebaseApp.initializeApp(
                this,
                FirebaseOptions.Builder()
                    .setProjectId(BuildConfig.FCM_PROJECT_ID)
                    .setApplicationId(BuildConfig.FCM_APPLICATION_ID)
                    .setApiKey(BuildConfig.FCM_API_KEY)
                    .setGcmSenderId(BuildConfig.FCM_SENDER_ID)
                    .build(),
            )
        }
        graph = AppGraph(this)
    }
}

class AppGraph(application: Application) {
    val attentionActionMutex = Mutex()
    val httpClient = OkHttpClient.Builder().build()
    val preferences = AppPreferences(application)
    val machineStore = SecureMachineStore(application)
    val auth = AuthRepository()
    val directory = AccountDirectoryClient(BuildConfig.ACCOUNT_DIRECTORY_URL, httpClient, auth::freshToken)
    val attention = AttentionRepository(
        BuildConfig.ATTENTION_RELAY_URL,
        httpClient,
        auth::freshToken,
        machineStore.localDeviceId(),
        machineStore,
    )
    val sync = AdeSyncClient(httpClient = httpClient)
    val pairing = PairingRepository(application, machineStore, auth, httpClient, sync)
}
