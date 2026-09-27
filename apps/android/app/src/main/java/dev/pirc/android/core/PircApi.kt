package dev.pirc.android.core

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit

/** A failed gateway request. `unauthorized` means the device token is dead: pair again. */
class ApiException(val status: Int, val code: String?, message: String) : IOException(message) {
    val unauthorized get() = status == 401
}

val PircJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
}

fun defaultHttpClient(): OkHttpClient = OkHttpClient.Builder()
    .connectTimeout(15, TimeUnit.SECONDS)
    .readTimeout(30, TimeUnit.SECONDS)
    // Tokens must never follow a redirect to another origin.
    .followRedirects(false)
    .followSslRedirects(false)
    .build()

/** The gateway's browser API, authenticated with this phone's device token. */
class PircApi(private val pairing: Pairing, private val client: OkHttpClient = defaultHttpClient()) {

    suspend fun sessions(): List<Session> = get<SessionsResponse>("/api/sessions").sessions

    suspend fun workspaces(): List<Workspace> = get<WorkspacesResponse>("/api/workspaces").workspaces

    suspend fun nodes(): List<NodeSummary> = get<NodesResponse>("/api/nodes").nodes

    private suspend inline fun <reified T> get(path: String): T = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url(pairing.baseUrl + path)
            .header("Authorization", "Bearer ${pairing.token}")
            .header("Accept", "application/json")
            .build()
        client.newCall(request).execute().use { response ->
            val body = response.body.string()
            if (!response.isSuccessful) throw failure(response, body)
            PircJson.decodeFromString<T>(body)
        }
    }

    private fun failure(response: Response, body: String): ApiException {
        val detail = runCatching { PircJson.decodeFromString<ErrorBody>(body).error }.getOrNull()
        val message = when {
            response.code == 401 -> "This phone's device token is invalid, expired or revoked. Pair it again."
            response.isRedirect -> "The gateway redirected the request; check the proxy routes device tokens to pirc."
            else -> detail?.message ?: "Request failed (${response.code})"
        }
        return ApiException(response.code, detail?.code, message)
    }
}
