package dev.pirc.pirc_mobile

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import android.util.Base64
import dev.pirc.android.core.PircJson
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import java.io.ByteArrayOutputStream
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** One retired-on-account-change jar; only durable cookies reach encrypted local storage. */
internal class NativeDocumentCookieStore(context: Context) {
    private data class Owner(val stamp: String?, val jar: NativeDocumentCookies)
    private val lock = Any()
    private val file = AtomicFile(File(context.filesDir, "native-document-cookies-v1.enc"))
    private val changes = Channel<Owner>(Channel.CONFLATED)
    private var owner: Owner? = null
    private var closed = false
    private val worker = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    @Volatile var persistenceError: String? = null
        private set

    init {
        worker.launch {
            for (captured in changes) {
                try { persist(captured) }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Exception) {
                    synchronized(lock) {
                        if (owner === captured && !closed) persistenceError = "Cookies could not be saved on this device."
                    }
                }
            }
        }
    }

    /** Call under the runtime's pairing lock, on IO. */
    fun bind(stamp: String?): NativeDocumentCookies? = synchronized(lock) {
        check(!closed) { "Cookie storage is closed" }
        owner?.takeIf { it.stamp == stamp }?.let { return@synchronized it.jar }
        val previous = owner
        owner = null
        previous?.jar?.retire()
        if (stamp == null) {
            file.delete()
            persistenceError = null
        }
        var captured: Owner? = null
        val jar = NativeDocumentCookies(onChanged = { if (stamp != null) captured?.let { changes.trySend(it) } })
        val newOwner = Owner(stamp, jar)
        captured = newOwner
        val restored = if (stamp == null) emptyList() else load(stamp)
        jar.importPersistence(restored)
        owner = newOwner
        if (stamp != null) changes.trySend(newOwner)
        jar
    }

    /** End this owner without deleting durable state; pending older writes cannot save. */
    fun close() {
        synchronized(lock) {
            if (closed) return
            closed = true
            val previous = owner
            owner = null
            previous?.jar?.retire()
            changes.close()
        }
        worker.cancel()
    }

    private fun load(stamp: String): List<Map<String, Any?>> {
        if (!file.baseFile.exists() && !File(file.baseFile.path + ".bak").exists()) return emptyList()
        return try {
            require(file.baseFile.length() <= MAX_SEALED_BYTES)
            val envelope = file.openRead().use { input ->
                val output = ByteArrayOutputStream()
                val buffer = ByteArray(8192)
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    require(output.size().toLong() + read <= MAX_SEALED_BYTES)
                    output.write(buffer, 0, read)
                }
                output.toString("UTF-8")
            }
            val fields = PircJson.parseToJsonElement(envelope) as JsonObject
            require(fields["scope"]?.jsonPrimitive?.content == stamp)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128,
                Base64.decode(fields["iv"]!!.jsonPrimitive.content, Base64.NO_WRAP)))
            cipher.updateAAD(stamp.toByteArray(Charsets.UTF_8))
            val clear = cipher.doFinal(Base64.decode(fields["sealed"]!!.jsonPrimitive.content, Base64.NO_WRAP))
            require(clear.size <= MAX_CLEAR_BYTES)
            val records = PircJson.parseToJsonElement(clear.toString(Charsets.UTF_8)) as JsonArray
            records.take(3000).mapNotNull { record ->
                @Suppress("UNCHECKED_CAST")
                (record.wire() as? Map<String, Any?>)
            }
        } catch (_: Exception) {
            file.delete()
            emptyList()
        }
    }

    private fun persist(captured: Owner) {
        val stamp = captured.stamp ?: return
        if (synchronized(lock) { owner !== captured }) return
        val clear = captured.jar.snapshotPersistence().json().toString().toByteArray(Charsets.UTF_8)
        require(clear.size <= MAX_CLEAR_BYTES)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        cipher.updateAAD(stamp.toByteArray(Charsets.UTF_8))
        val envelope = mapOf("scope" to captured.stamp,
            "iv" to Base64.encodeToString(cipher.iv, Base64.NO_WRAP),
            "sealed" to Base64.encodeToString(cipher.doFinal(clear), Base64.NO_WRAP))
            .json().toString().toByteArray(Charsets.UTF_8)
        synchronized(lock) {
            if (owner !== captured) return
            val stream = file.startWrite()
            try { stream.write(envelope); file.finishWrite(stream); persistenceError = null }
            catch (error: Exception) { file.failWrite(stream); throw error }
        }
    }

    private fun key(): SecretKey = synchronized(lock) {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return@synchronized it }
        KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }

    companion object {
        private const val ALIAS = "pirc-native-document-cookies-v1"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val MAX_CLEAR_BYTES = 16 * 1024 * 1024
        private const val MAX_SEALED_BYTES = 24L * 1024 * 1024
    }
}
