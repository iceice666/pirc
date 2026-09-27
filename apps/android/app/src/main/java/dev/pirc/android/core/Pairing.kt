package dev.pirc.android.core

import java.net.URI
import java.net.URLDecoder

/** A gateway this phone is paired with: its origin and the device token. */
data class Pairing(val baseUrl: String, val token: String) {
    override fun toString() = "Pairing(baseUrl=$baseUrl, token=<redacted>)"
}

class InvalidPairingLink(message: String) : IllegalArgumentException(message)

/**
 * Parses the `pirc://pair?url=<origin>&token=<token>` link the web shows as a QR code.
 * Only HTTPS gateways are accepted, except loopback and the emulator's host alias for development.
 */
object PairingLink {
    private val TOKEN = Regex("^pirc_dev_[A-Za-z0-9_-]{43}$")
    private val DEV_HOSTS = setOf("localhost", "127.0.0.1", "10.0.2.2")

    fun parse(text: String): Pairing {
        val link = try {
            URI(text.trim())
        } catch (_: Exception) {
            throw InvalidPairingLink("This is not a pirc pairing link.")
        }
        if (link.scheme != "pirc" || link.host != "pair") throw InvalidPairingLink("This is not a pirc pairing link.")
        val params = (link.rawQuery ?: "").split('&').filter { it.isNotEmpty() }.associate { part ->
            val (key, value) = part.split('=', limit = 2).let { it[0] to it.getOrElse(1) { "" } }
            decode(key) to decode(value)
        }
        val token = params["token"].orEmpty()
        if (!TOKEN.matches(token)) throw InvalidPairingLink("The pairing link has no valid device token.")
        return Pairing(origin(params["url"].orEmpty()), token)
    }

    /** The gateway origin (`scheme://host[:port]`), refusing paths, credentials and plain HTTP. */
    fun origin(text: String): String {
        val url = try {
            URI(text.trim())
        } catch (_: Exception) {
            throw InvalidPairingLink("The gateway address is not a valid URL.")
        }
        val host = url.host ?: throw InvalidPairingLink("The gateway address has no host.")
        val secure = url.scheme == "https"
        if (!secure && !(url.scheme == "http" && host in DEV_HOSTS))
            throw InvalidPairingLink("The gateway must use HTTPS.")
        if (url.rawUserInfo != null || url.rawQuery != null || url.rawFragment != null || (url.rawPath ?: "") !in setOf("", "/"))
            throw InvalidPairingLink("The gateway address must be an origin, without a path.")
        val port = if (url.port == -1) "" else ":${url.port}"
        return "${url.scheme}://$host$port"
    }

    private fun decode(value: String) = URLDecoder.decode(value, Charsets.UTF_8)
}
