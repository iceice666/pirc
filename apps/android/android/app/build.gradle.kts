plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
    id("org.jetbrains.kotlin.plugin.serialization")
}

val releaseKeystore = System.getenv("PIRC_ANDROID_KEYSTORE")
val requireReleaseSigning = System.getenv("PIRC_ANDROID_REQUIRE_SIGNING") == "1"
if (requireReleaseSigning && releaseKeystore.isNullOrBlank()) {
    error("CI release builds require PIRC_ANDROID_KEYSTORE; run Release setup first")
}
fun signingEnvironment(name: String): String = System.getenv(name)
    ?.takeIf { it.isNotBlank() } ?: error("Missing release signing setting: $name")

android {
    buildFeatures { buildConfig = true }
    namespace = "dev.pirc.pirc_mobile"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "dev.pirc.mobile.preview"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = 29
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        if (!releaseKeystore.isNullOrBlank()) {
            create("ciRelease") {
                storeFile = file(releaseKeystore)
                storePassword = signingEnvironment("PIRC_ANDROID_STORE_PASSWORD")
                keyAlias = signingEnvironment("PIRC_ANDROID_KEY_ALIAS")
                keyPassword = signingEnvironment("PIRC_ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            // Local preview installs retain their existing identity. CI requires
            // the explicitly configured persistent key instead of generating one.
            signingConfig = signingConfigs.getByName(
                if (!releaseKeystore.isNullOrBlank()) "ciRelease" else "debug"
            )
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}

dependencies {
    implementation("androidx.javascriptengine:javascriptengine:1.1.1")
    implementation("com.squareup.okhttp3:okhttp:5.1.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.9.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("org.unifiedpush.android:connector:3.3.5")
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
    testImplementation("junit:junit:4.13.2")
    implementation("androidx.core:core-ktx:1.17.0")
    androidTestImplementation("androidx.test:runner:1.3.0")
}

tasks.withType<Test>().configureEach {
    systemProperty("pirc.fixtures", System.getenv("PIRC_FIXTURES") ?: file("../../../../fixtures").absolutePath)
}
dependencies {
    testImplementation("com.squareup.okhttp3:mockwebserver3:5.1.0")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
}

// Android assets are unavailable in local JVM tests. Use OkHttp's published JVM
// runtime (including its genuine PSL), while production retains okhttp-android.
configurations.matching { it.name.endsWith("UnitTestCompileClasspath") || it.name.endsWith("UnitTestRuntimeClasspath") }.configureEach {
    resolutionStrategy.dependencySubstitution {
        substitute(module("com.squareup.okhttp3:okhttp")).using(module("com.squareup.okhttp3:okhttp-jvm:5.1.0"))
    }
}
