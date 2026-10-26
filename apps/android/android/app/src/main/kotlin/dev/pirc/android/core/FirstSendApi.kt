package dev.pirc.android.core

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import okhttp3.RequestBody
import okio.BufferedSink
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody

/** Fixed authenticated Gateway API; no browser, redirects or mutation replay. */
internal class FirstSendApi(private val api: PircApi) {
    private val client = api.client.newBuilder().retryOnConnectionFailure(false)
        .followRedirects(false).followSslRedirects(false).build()
    private val submission = Regex("^/api/conversation-submissions/[A-Za-z0-9_%.-]+(?:/(?:receipt|accept|materialize|dispatch|attachments/[A-Za-z0-9_%.-]+))?$")
    private val pending = Regex("^/api/conversation-submissions/session/[A-Za-z0-9_%.-]+$")
    private val session = Regex("^/api/sessions/[A-Za-z0-9_%.-]+(?:/(?:control/acquire|commands(?:/[A-Za-z0-9_%.-]+)?))?$")
    suspend fun request(method: String, path: String, owner: String? = null, body: JsonElement? = null, bytes: ByteArray? = null): JsonElement? = withContext(Dispatchers.IO) {
        require(method in setOf("GET", "POST", "DELETE", "PUT"))
        require(submission.matches(path) || pending.matches(path) || session.matches(path)) { "Invalid first-send API path" }
        require(owner != null || (method == "GET" && path == "/api/conversation-submissions/capabilities"))
        require(bytes == null || (method == "PUT" && path.contains("/attachments/") && body == null))
        val payload = when {
            method == "GET" -> null
            bytes != null -> bytes.toRequestBody("application/octet-stream".toMediaType())
            else -> (body ?: JsonObject(emptyMap())).toString().toRequestBody("application/json".toMediaType())
        }
        val once = payload?.let { original -> object : RequestBody() {
            override fun contentType() = original.contentType()
            override fun contentLength() = original.contentLength()
            override fun isOneShot() = true
            override fun writeTo(sink: BufferedSink) = original.writeTo(sink)
        } }
        val builder = api.request(path).header("Accept", "application/json").method(method, once)
        require(builder.build().url.encodedPath == path) { "First-send API path was normalized" }
        if (owner != null) builder.header("x-pirc-account", owner.urlSegment().replace("%7E", "~").replace("%21", "!").replace("%27", "'").replace("%28", "(").replace("%29", ")"))
        client.newCall(builder.build()).execute().use { response ->
            val text = response.body.string()
            if (!response.isSuccessful) throw api.failure(response, text)
            if (response.code == 204) null else try { PircJson.parseToJsonElement(text) }
            catch (error: Exception) { throw ApiException(502, "bad_reply", "Invalid first-send response", error) }
        }
    }
}
