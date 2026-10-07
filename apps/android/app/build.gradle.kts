plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "dev.pirc.android"
    compileSdk = 37

    defaultConfig {
        applicationId = "dev.pirc.android"
        minSdk = 29
        targetSdk = 37
        versionCode = 3
        versionName = "0.3.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions {
        // android.util.Log in view models under test is a no-op instead of throwing.
        unitTests.isReturnDefaultValues = true
    }

    buildFeatures {
        compose = true
        // BuildConfig.DEBUG gates development-only behaviour (plain-HTTP pairing, diagnostics).
        buildConfig = true
    }
}

kotlin {
    jvmToolchain(21)
}

/**
 * xterm.js for the terminal screen, taken from the web client's pinned
 * dependencies (run `bun install` first) instead of a second copy in git.
 */
abstract class VendorXterm : DefaultTask() {
    @get:InputDirectory
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val modules: DirectoryProperty

    @get:OutputDirectory
    abstract val output: DirectoryProperty

    @TaskAction
    fun copy() {
        val from = modules.get().asFile
        val into = output.get().asFile.resolve("terminal").apply { deleteRecursively(); mkdirs() }
        for (file in listOf("xterm/lib/xterm.js", "xterm/css/xterm.css", "addon-fit/lib/addon-fit.js", "xterm/LICENSE")) {
            val source = from.resolve(file)
            check(source.isFile) { "$source is missing: run bun install in the repository first" }
            source.copyTo(into.resolve(if (file.endsWith("LICENSE")) "xterm-LICENSE.txt" else source.name), overwrite = true)
        }
    }
}

val vendorXterm = tasks.register<VendorXterm>("vendorXterm") {
    modules.set(rootProject.layout.projectDirectory.dir("../web/node_modules/@xterm"))
    output.set(layout.buildDirectory.dir("generated/xterm"))
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(vendorXterm, VendorXterm::output)
    }
}

// Golden timeline cases shared with the web client.
val sharedFixtures = rootProject.layout.projectDirectory.dir("../../fixtures")
tasks.withType<Test>().configureEach {
    inputs.dir(sharedFixtures).withPathSensitivity(PathSensitivity.RELATIVE)
    systemProperty("pirc.fixtures", sharedFixtures.asFile.absolutePath)
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.navigation.compose)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    implementation(libs.okhttp)
    // Push notifications through the user's own distributor (ntfy, ...): no Google services.
    implementation(libs.unifiedpush.connector)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.play.services.code.scanner)
    implementation(libs.markdown.m3)
    implementation(libs.markdown.code)
    debugImplementation(libs.compose.ui.tooling)

    testImplementation(libs.junit)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.kotlinx.coroutines.test)
}
