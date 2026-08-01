plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = "com.ade.android"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.ade.android"
        minSdk = 26
        targetSdk = 36
        versionCode = providers.gradleProperty("ADE_ANDROID_VERSION_CODE")
            .orElse(providers.environmentVariable("ADE_ANDROID_VERSION_CODE"))
            .orElse("1").get().toInt()
        versionName = providers.gradleProperty("ADE_ANDROID_VERSION_NAME")
            .orElse(providers.environmentVariable("ADE_ANDROID_VERSION_NAME"))
            .orElse("1.0.0").get()

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        vectorDrawables.useSupportLibrary = true
        buildConfigField("String", "ACCOUNT_DIRECTORY_URL", "\"https://ade-account-directory-production.arulsharma1028.workers.dev\"")
        buildConfigField("String", "ATTENTION_RELAY_URL", "\"https://ade-push-relay.arulsharma1028.workers.dev\"")
        val clerkKey = providers.gradleProperty("ADE_CLERK_PUBLISHABLE_KEY")
            .orElse(providers.environmentVariable("ADE_CLERK_PUBLISHABLE_KEY"))
            .orElse("")
            .get()
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
        buildConfigField("String", "CLERK_PUBLISHABLE_KEY", "\"$clerkKey\"")
        fun secret(name: String): String = providers.gradleProperty(name)
            .orElse(providers.environmentVariable(name))
            .orElse("")
            .get()
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
        buildConfigField("String", "FCM_PROJECT_ID", "\"${secret("ADE_FCM_PROJECT_ID")}\"")
        buildConfigField("String", "FCM_APPLICATION_ID", "\"${secret("ADE_FCM_APPLICATION_ID")}\"")
        buildConfigField("String", "FCM_API_KEY", "\"${secret("ADE_FCM_API_KEY")}\"")
        buildConfigField("String", "FCM_SENDER_ID", "\"${secret("ADE_FCM_SENDER_ID")}\"")
    }

    val releaseStorePath = providers.gradleProperty("ADE_ANDROID_KEYSTORE_PATH")
        .orElse(providers.environmentVariable("ADE_ANDROID_KEYSTORE_PATH")).orNull
    val releaseStorePassword = providers.gradleProperty("ADE_ANDROID_KEYSTORE_PASSWORD")
        .orElse(providers.environmentVariable("ADE_ANDROID_KEYSTORE_PASSWORD")).orNull
    val releaseKeyAlias = providers.gradleProperty("ADE_ANDROID_KEY_ALIAS")
        .orElse(providers.environmentVariable("ADE_ANDROID_KEY_ALIAS")).orNull
    val releaseKeyPassword = providers.gradleProperty("ADE_ANDROID_KEY_PASSWORD")
        .orElse(providers.environmentVariable("ADE_ANDROID_KEY_PASSWORD")).orNull
    signingConfigs {
        if (listOf(releaseStorePath, releaseStorePassword, releaseKeyAlias, releaseKeyPassword).all { !it.isNullOrBlank() }) {
            create("release") {
                storeFile = file(releaseStorePath!!)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }
    buildTypes {
        getByName("release") {
            signingConfig = signingConfigs.findByName("release")
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources.excludes += setOf("META-INF/DEPENDENCIES", "META-INF/LICENSE.md", "META-INF/NOTICE.md")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    implementation(project(":sync"))

    implementation(platform("androidx.compose:compose-bom:2026.04.01"))
    implementation("androidx.activity:activity-compose:1.12.3")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    // Lifecycle 2.11 / Navigation 3 1.1 require compileSdk 37 + AGP 9.1.
    // ADE intentionally remains on the approved API-36 baseline until the
    // coordinated Compose 1.12 toolchain bump described in the feature spec.
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.10.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.10.0")
    implementation("androidx.navigation3:navigation3-runtime:1.0.0")
    implementation("androidx.navigation3:navigation3-ui:1.0.0")
    implementation("androidx.datastore:datastore-preferences:1.2.1")
    implementation("androidx.security:security-crypto:1.1.0")
    implementation("androidx.work:work-runtime-ktx:2.11.2")
    implementation("androidx.camera:camera-camera2:1.6.1")
    implementation("androidx.camera:camera-lifecycle:1.6.1")
    implementation("androidx.camera:camera-view:1.6.1")
    implementation("com.google.mlkit:barcode-scanning:17.3.0")

    implementation("com.clerk:clerk-android-api:1.0.39")
    implementation("org.connectbot:termlib:0.1.0")
    implementation(platform("com.google.firebase:firebase-bom:34.17.0"))
    implementation("com.google.firebase:firebase-messaging")

    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.9.0")
    implementation("com.squareup.okhttp3:okhttp:5.1.0")

    debugImplementation("androidx.compose.ui:ui-tooling")
    testImplementation(kotlin("test"))
    testImplementation("org.junit.jupiter:junit-jupiter:5.13.4")
    androidTestImplementation(platform("androidx.compose:compose-bom:2026.04.01"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test:runner:1.7.0")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
