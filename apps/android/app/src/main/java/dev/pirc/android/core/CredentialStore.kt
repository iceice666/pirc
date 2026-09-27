package dev.pirc.android.core

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

interface CredentialStore {
    fun load(): Pairing?
    fun save(pairing: Pairing)
    fun clear()
}

/**
 * Keeps the device token encrypted with a non-exportable AES-GCM key in the Android Keystore.
 * The app opts out of backups, so the ciphertext never leaves the phone either.
 */
class KeystoreCredentialStore(context: Context) : CredentialStore {
    private val prefs = context.getSharedPreferences("credentials", Context.MODE_PRIVATE)

    private fun key(): SecretKey {
        val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build(),
        )
        return generator.generateKey()
    }

    override fun load(): Pairing? {
        val url = prefs.getString(URL, null) ?: return null
        val iv = prefs.getString(IV, null) ?: return null
        val sealed = prefs.getString(TOKEN, null) ?: return null
        return runCatching {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)))
            Pairing(url, String(cipher.doFinal(Base64.decode(sealed, Base64.NO_WRAP)), Charsets.UTF_8))
        }.getOrElse {
            // A lost or invalidated key cannot be recovered; pair again.
            clear()
            null
        }
    }

    override fun save(pairing: Pairing) {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val sealed = cipher.doFinal(pairing.token.toByteArray(Charsets.UTF_8))
        prefs.edit()
            .putString(URL, pairing.baseUrl)
            .putString(IV, Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .putString(TOKEN, Base64.encodeToString(sealed, Base64.NO_WRAP))
            .commit()
    }

    override fun clear() {
        prefs.edit().clear().commit()
    }

    private companion object {
        const val KEYSTORE = "AndroidKeyStore"
        const val ALIAS = "pirc-device-token"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val URL = "url"
        const val IV = "iv"
        const val TOKEN = "token"
    }
}
