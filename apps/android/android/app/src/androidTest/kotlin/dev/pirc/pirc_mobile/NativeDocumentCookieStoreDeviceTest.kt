package dev.pirc.pirc_mobile

import android.content.ContextWrapper
import android.util.Base64
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import androidx.test.platform.app.InstrumentationRegistry
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.UUID

/** Uses Android's real Keystore, AndroidX Startup PSL assets, and encrypted disk IO. */
class NativeDocumentCookieStoreDeviceTest {
    @Test fun durableCookiesRestoreEncryptedWhileSessionAndHttpOnlyStayScoped() {
        val app = InstrumentationRegistry.getInstrumentation().targetContext
        val directory = File(app.cacheDir, "cookie-device-${UUID.randomUUID()}").apply { mkdirs() }
        val context = object : ContextWrapper(app) { override fun getFilesDir() = directory }
        val file = File(directory, "native-document-cookies-v1.enc")
        val page = "https://docs.example.co.uk/nested/page".toHttpUrl()
        val facts = CookieRequestContext(initiatorUrl = page, topLevelUrl = page)
        val first = NativeDocumentCookieStore(context)
        var restored: NativeDocumentCookieStore? = null
        try {
            val jar = first.bind("synthetic-owner")!!
            assertEquals(3, jar.receive(page, listOf(
                "visible=durable; Domain=example.co.uk; Path=/; Max-Age=600",
                "secret=synthetic-http-only-value; HttpOnly; Path=/; Max-Age=600",
                "session=ephemeral; Path=/",
            ), facts))
            await("encrypted durable state") {
                runCatching {
                    val contents = decrypt(file, "synthetic-owner")
                    contents.contains("synthetic-http-only-value") && contents.contains("durable") && !contents.contains("ephemeral")
                }.getOrDefault(false)
            }
            assertFalse(file.readText().contains("synthetic-http-only-value"))
            assertFalse(file.readText().contains("durable"))
            first.close()
            restored = NativeDocumentCookieStore(context)
            val loaded = restored.bind("synthetic-owner")!!
            assertEquals("visible=durable; secret=synthetic-http-only-value", loaded.requestHeader(page, facts))
            assertEquals("visible=durable", loaded.documentCookie(page))
            assertEquals("visible=durable", loaded.requestHeader("https://api.example.co.uk/".toHttpUrl(), facts))
            assertFalse(loaded.exportScriptState(page).toString().contains("synthetic-http-only-value"))
            assertFalse(jar.setDocumentCookie(page, "late=old-owner"))
        } finally {
            first.close()
            restored?.close()
            directory.deleteRecursively()
        }
    }

    @Test fun accountSwitchAndUnpairFenceDelayedWritesAndRemoveDurableFile() {
        val app = InstrumentationRegistry.getInstrumentation().targetContext
        val directory = File(app.cacheDir, "cookie-account-${UUID.randomUUID()}").apply { mkdirs() }
        val context = object : ContextWrapper(app) { override fun getFilesDir() = directory }
        val store = NativeDocumentCookieStore(context)
        val page = "https://example.com/".toHttpUrl()
        try {
            val old = store.bind("old-account")!!
            assertTrue(old.setDocumentCookie(page, "old=secret; Max-Age=600"))
            val replacement = store.bind("new-account")!!
            assertEquals("", replacement.documentCookie(page))
            assertFalse(old.setDocumentCookie(page, "late=secret; Max-Age=600"))
            assertTrue(replacement.setDocumentCookie(page, "current=live; Max-Age=600"))
            val anonymous = store.bind(null)!!
            assertTrue(anonymous.setDocumentCookie(page, "anonymous=memory-only; Max-Age=600"))
            assertSame(anonymous, store.bind(null))
            Thread.sleep(200)
            assertFalse(File(directory, "native-document-cookies-v1.enc").exists())
            assertFalse(replacement.setDocumentCookie(page, "late=new-account"))
        } finally {
            store.close()
            directory.deleteRecursively()
        }
    }

    private fun decrypt(file: File, stamp: String): String {
        val envelope = JSONObject(file.readText())
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val key = store.getKey("pirc-native-document-cookies-v1", null) as SecretKey
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key,
            GCMParameterSpec(128, Base64.decode(envelope.getString("iv"), Base64.NO_WRAP)))
        cipher.updateAAD(stamp.toByteArray(Charsets.UTF_8))
        return cipher.doFinal(Base64.decode(envelope.getString("sealed"), Base64.NO_WRAP)).toString(Charsets.UTF_8)
    }

    private fun await(label: String, ready: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 5000
        while (!ready() && System.currentTimeMillis() < deadline) Thread.sleep(25)
        assertTrue(label, ready())
    }
}
