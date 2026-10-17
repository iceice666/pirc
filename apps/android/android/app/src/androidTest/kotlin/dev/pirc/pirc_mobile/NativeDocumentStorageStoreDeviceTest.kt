package dev.pirc.pirc_mobile

import android.content.ContextWrapper
import android.util.Base64
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class NativeDocumentStorageStoreDeviceTest {
    private val origin = "https://storage.example"
    private fun change(storage: NativeDocumentStorage, area: String, key: String, value: String) =
        storage.apply(origin,"window","$origin/page",listOf(mapOf("area" to area,"type" to "set",
            "key" to key,"value" to value,"generation" to storage.generation)),storage.generation)

    @Test fun encryptedLocalRestoresButSessionDoesNotAndOriginsRemainSeparate() {
        val app=InstrumentationRegistry.getInstrumentation().targetContext
        val directory=File(app.cacheDir,"storage-device-${UUID.randomUUID()}").apply { mkdirs() }
        val context=object:ContextWrapper(app){override fun getFilesDir()=directory}
        val first=NativeDocumentStorageStore(context)
        var restored:NativeDocumentStorageStore?=null
        try {
            val engine=first.bind("synthetic-account")
            change(engine,"local","draft","private-猫😀-saved")
            change(engine,"session","draft","ephemeral-session")
            val folder=File(directory,"native-document-storage-v1")
            await("encrypted storage") { folder.listFiles().orEmpty().any { file ->
                file.name.endsWith(".enc") && runCatching { decrypt(file,"synthetic-account").contains("private-猫😀-saved") }.getOrDefault(false)
            } }
            val file=folder.listFiles()!!.single { it.name.endsWith(".enc") }
            assertFalse(file.readText().contains("private-"));assertFalse(decrypt(file,"synthetic-account").contains("ephemeral-session"))
            first.close()
            restored=NativeDocumentStorageStore(context)
            val loaded=restored.bind("synthetic-account")
            assertEquals(listOf(listOf("draft","private-猫😀-saved")),loaded.snapshot(origin,"window")["local"])
            assertEquals(emptyList<Any>(),loaded.snapshot(origin,"window")["session"])
            assertEquals(emptyList<Any>(),loaded.snapshot("https://other.example","window")["local"])
            assertRetired { change(engine,"local","late","old") }
        } finally {first.close();restored?.close();directory.deleteRecursively()}
    }

    @Test fun accountSwitchAndUnpairFenceDelayedWritesAndNeverPersistAnonymousStorage() {
        val app=InstrumentationRegistry.getInstrumentation().targetContext
        val directory=File(app.cacheDir,"storage-account-${UUID.randomUUID()}").apply { mkdirs() }
        val context=object:ContextWrapper(app){override fun getFilesDir()=directory}
        val store=NativeDocumentStorageStore(context)
        try {
            val old=store.bind("old-account");change(old,"local","old","secret")
            val replacement=store.bind("new-account")
            assertEquals(emptyList<Any>(),replacement.snapshot(origin,"window")["local"])
            assertRetired {change(old,"local","late","old")}
            change(replacement,"local","current","live")
            val anonymous=store.bind(null);change(anonymous,"local","anonymous","memory-only")
            assertSame(anonymous,store.bind(null));Thread.sleep(200)
            assertFalse(File(directory,"native-document-storage-v1").exists())
            assertRetired {change(replacement,"local","late","new")}
        } finally {store.close();directory.deleteRecursively()}
    }

    private fun assertRetired(action: () -> Unit) {
        var rejected = false
        try { action() } catch (_: IllegalStateException) { rejected = true }
        assertTrue("A retired storage instance must reject writes", rejected)
    }

    private fun decrypt(file:File,stamp:String):String {
        val envelope=JSONObject(file.readText())
        val keyStore=KeyStore.getInstance("AndroidKeyStore").apply {load(null)}
        val cipher=Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE,keyStore.getKey("pirc-native-document-storage-v1",null) as SecretKey,
            GCMParameterSpec(128,Base64.decode(envelope.getString("iv"),Base64.NO_WRAP)))
        cipher.updateAAD("$stamp\n${file.name}".toByteArray(Charsets.UTF_8))
        return cipher.doFinal(Base64.decode(envelope.getString("sealed"),Base64.NO_WRAP)).toString(Charsets.UTF_8)
    }
    private fun await(label:String,ready:()->Boolean) {
        val deadline=System.currentTimeMillis()+5000
        while(!ready()&&System.currentTimeMillis()<deadline) Thread.sleep(25)
        assertTrue(label,ready())
    }
}
