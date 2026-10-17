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
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.ByteArrayOutputStream
import java.io.File
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Account-owned encrypted localStorage. sessionStorage and anonymous data never reach disk. */
internal class NativeDocumentStorageStore(context: Context) {
    private data class Owner(val stamp: String?, val storage: NativeDocumentStorage)
    private val lock = Any()
    private val directory = File(context.filesDir, "native-document-storage-v1")
    private val changes = Channel<Owner>(Channel.CONFLATED)
    private val worker = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var owner: Owner? = null
    private var closed = false
    @Volatile var persistenceError: String? = null
        private set

    init {
        worker.launch {
            for (captured in changes) {
                try { persist(captured) }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Exception) { synchronized(lock) {
                    if (!closed && owner === captured) persistenceError = "Browser storage could not be saved on this device."
                } }
            }
        }
    }

    /** Runtime calls this on IO under its account lock. */
    fun bind(stamp: String?): NativeDocumentStorage = synchronized(lock) {
        check(!closed) { "Browser storage is closed" }
        owner?.takeIf { it.stamp == stamp }?.let { return@synchronized it.storage }
        val previous = owner
        owner = null
        previous?.storage?.retire()
        persistenceError = null
        if (stamp == null) directory.deleteRecursively()
        var captured: Owner? = null
        val storage = NativeDocumentStorage(onLocalChanged = {
            if (stamp != null) captured?.let { changes.trySend(it) }
        })
        val next = Owner(stamp, storage)
        captured = next
        if (stamp != null) storage.importLocalPersistence(load(stamp))
        owner = next
        if (stamp != null) changes.trySend(next)
        storage
    }

    fun close() {
        synchronized(lock) {
            if (closed) return
            closed = true
            val previous = owner
            owner = null
            previous?.storage?.retire()
            changes.close()
        }
        worker.cancel()
    }

    private fun load(stamp: String): List<Map<String, Any?>> {
        if (!directory.isDirectory) return emptyList()
        val names = directory.listFiles().orEmpty().mapNotNull { file ->
            file.name.removeSuffix(".bak").takeIf { FILE_NAME.matches(it) }
        }.distinct()
        require(names.size <= MAX_ORIGINS) { "Too many stored browser origins" }
        return names.mapNotNull { name ->
            val file = AtomicFile(File(directory, name))
            try {
                val text = file.openRead().use { input ->
                    val output = ByteArrayOutputStream()
                    val bytes = ByteArray(8192)
                    while (true) {
                        val count = input.read(bytes)
                        if (count < 0) break
                        require(output.size().toLong() + count <= MAX_SEALED_BYTES)
                        output.write(bytes, 0, count)
                    }
                    output.toString("UTF-8")
                }
                val envelope = PircJson.parseToJsonElement(text) as JsonObject
                require(envelope["scope"]?.jsonPrimitive?.content == stamp)
                val cipher = Cipher.getInstance(TRANSFORMATION)
                cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128,
                    Base64.decode(envelope["iv"]!!.jsonPrimitive.content, Base64.NO_WRAP)))
                cipher.updateAAD(aad(stamp, name))
                val clear = cipher.doFinal(Base64.decode(envelope["sealed"]!!.jsonPrimitive.content, Base64.NO_WRAP))
                require(clear.size <= MAX_CLEAR_BYTES)
                @Suppress("UNCHECKED_CAST")
                val record = (PircJson.parseToJsonElement(clear.toString(Charsets.UTF_8)).wire() as? Map<String, Any?>)
                    ?: error("Invalid browser storage record")
                require(fileName(record["origin"] as String) == name)
                record
            } catch (_: Exception) {
                file.delete()
                null
            }
        }
    }

    private fun persist(captured: Owner) {
        val stamp = captured.stamp ?: return
        if (synchronized(lock) { owner !== captured }) return
        // One origin per envelope bounds encryption/JSON peak memory independently
        // from the account's total quota and keeps durable origins separately recoverable.
        val records = captured.storage.exportLocalPersistence()
        require(records.size <= MAX_ORIGINS)
        val wanted = mutableSetOf<String>()
        for (record in records) {
            val name = fileName(record["origin"] as String)
            wanted += name
            val clear = record.json().toString().toByteArray(Charsets.UTF_8)
            require(clear.size <= MAX_CLEAR_BYTES)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, key())
            cipher.updateAAD(aad(stamp, name))
            val envelope = mapOf("scope" to stamp,
                "iv" to Base64.encodeToString(cipher.iv, Base64.NO_WRAP),
                "sealed" to Base64.encodeToString(cipher.doFinal(clear), Base64.NO_WRAP))
                .json().toString().toByteArray(Charsets.UTF_8)
            synchronized(lock) {
                if (owner !== captured) return
                check(directory.isDirectory || directory.mkdirs()) { "Browser storage directory is unavailable" }
                val file = AtomicFile(File(directory, name))
                val stream = file.startWrite()
                try { stream.write(envelope); file.finishWrite(stream) }
                catch (error: Exception) { file.failWrite(stream); throw error }
            }
        }
        synchronized(lock) {
            if (owner !== captured) return
            for (file in directory.listFiles().orEmpty()) {
                val name = file.name.removeSuffix(".bak")
                if (FILE_NAME.matches(name) && name !in wanted) AtomicFile(File(directory, name)).delete()
            }
            persistenceError = null
        }
    }

    private fun key(): SecretKey = synchronized(lock) {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return@synchronized it }
        KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }

    private fun fileName(origin: String) = MessageDigest.getInstance("SHA-256")
        .digest(origin.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) } + ".enc"
    private fun aad(stamp: String, name: String) = "$stamp\n$name".toByteArray(Charsets.UTF_8)

    companion object {
        private const val ALIAS = "pirc-native-document-storage-v1"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val MAX_CLEAR_BYTES = 40 * 1024 * 1024
        private const val MAX_SEALED_BYTES = 64L * 1024 * 1024
        private const val MAX_ORIGINS = 256
        private val FILE_NAME = Regex("[a-f0-9]{64}\\.enc")
    }
}
