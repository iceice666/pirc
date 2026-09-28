package dev.pirc.android.core

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import dev.pirc.android.core.timeline.get
import dev.pirc.android.core.timeline.number
import dev.pirc.android.core.timeline.text
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

/** A failed gateway request. `unauthorized` means the device token is dead: pair again. */
class ApiException(val status: Int, val code: String?, message: String) : IOException(message) {
    val unauthorized get() = status == 401
}

internal fun String.urlSegment(): String = URLEncoder.encode(this, Charsets.UTF_8).replace("+", "%20")

private val JSON = "application/json".toMediaType()

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
class PircApi(val pairing: Pairing, internal val client: OkHttpClient = defaultHttpClient()) {

    suspend fun sessions(): List<Session> = get<SessionsResponse>("/api/sessions").sessions

    suspend fun workspaces(): List<Workspace> = get<WorkspacesResponse>("/api/workspaces").workspaces

    suspend fun nodes(): List<NodeSummary> = get<NodesResponse>("/api/nodes").nodes

    /** The raw snapshot; see `snapshotState` in `core.timeline`. */
    suspend fun snapshot(sessionId: String): JsonElement =
        get<JsonElement>("/api/sessions/${sessionId.urlSegment()}/snapshot")

    /** The live event stream of one session; see [EventStream]. */
    fun events(sessionId: String, cursor: String?) = EventStream(this).open(sessionId, cursor)

    // ---- sessions and workspaces ----

    /** A new session in [workspaceId]; the agent titles it from the first message. */
    suspend fun createSession(workspaceId: String): Session =
        decodeSession(send("POST", "/api/sessions", buildJsonObject { put("workspaceId", workspaceId) }))

    /** Rename, pin or settle a session (any combination). */
    suspend fun updateSession(sessionId: String, name: String? = null, pinned: Boolean? = null, settled: Boolean? = null): Session =
        decodeSession(
            send("PATCH", session(sessionId), buildJsonObject {
                name?.let { put("name", it) }
                pinned?.let { put("pinned", it) }
                settled?.let { put("settled", it) }
            }),
        )

    /** Register a folder on an online node; it must exist inside that account's home. */
    suspend fun createWorkspace(nodeId: String, path: String, displayName: String): Workspace {
        val reply = send("POST", "/api/workspaces", buildJsonObject {
            put("nodeId", nodeId)
            put("path", path)
            put("displayName", displayName)
        })
        return PircJson.decodeFromJsonElement(Workspace.serializer(), reply["workspace"] ?: error("no workspace in the reply"))
    }

    private fun decodeSession(reply: JsonElement?) =
        PircJson.decodeFromJsonElement(Session.serializer(), reply["session"] ?: error("no session in the reply"))

    // ---- workspace files (read-only, confined to the session's workspace) ----

    suspend fun files(sessionId: String, path: String): DirListing =
        get<DirListing>("${session(sessionId)}/files?path=${path.urlSegment()}")

    suspend fun file(sessionId: String, path: String): FileContent =
        get<FileContent>("${session(sessionId)}/files/content?path=${path.urlSegment()}")

    // ---- side panels ----

    suspend fun gitStatus(sessionId: String): GitStatus = get("${session(sessionId)}/git/status")

    suspend fun gitDiff(sessionId: String, path: String, staged: Boolean, untracked: Boolean): Diff =
        get("${session(sessionId)}/git/diff?path=${path.urlSegment()}" + (if (staged) "&staged=1" else "") + (if (untracked) "&untracked=1" else ""))

    suspend fun gitLog(sessionId: String, skip: Int, limit: Int = 50): CommitPage =
        get("${session(sessionId)}/git/log?skip=$skip&limit=$limit")

    suspend fun gitShow(sessionId: String, sha: String): CommitDetail =
        get("${session(sessionId)}/git/commits/${sha.urlSegment()}")

    suspend fun panelState(sessionId: String): PanelState = get("${session(sessionId)}/panel/state")

    suspend fun backgroundOutput(sessionId: String, taskId: String, lines: Int = 400): BackgroundOutput =
        get("${session(sessionId)}/panel/background/${taskId.urlSegment()}?lines=$lines")

    /** Needs the control lease; returns once the stop is requested (status `stopping`). */
    suspend fun stopBackground(sessionId: String, taskId: String, clientId: String, generation: Long): BackgroundTask =
        PircJson.decodeFromJsonElement(
            TaskResponse.serializer(),
            send("POST", "${session(sessionId)}/panel/background/${taskId.urlSegment()}/stop", held(clientId, generation))!!,
        ).task

    suspend fun terminals(sessionId: String): List<TerminalInfo> = get<TerminalsResponse>("${session(sessionId)}/terminals").terminals

    /** Needs the control lease. */
    suspend fun createTerminal(sessionId: String, clientId: String, generation: Long, cols: Int, rows: Int): TerminalInfo =
        PircJson.decodeFromJsonElement(
            TerminalResponse.serializer(),
            send("POST", "${session(sessionId)}/terminals", buildJsonObject {
                put("clientId", clientId)
                put("generation", generation)
                put("cols", cols)
                put("rows", rows)
            })!!,
        ).terminal

    suspend fun closeTerminal(sessionId: String, terminalId: String, clientId: String, generation: Long) {
        send("POST", "${session(sessionId)}/terminals/${terminalId.urlSegment()}/close", held(clientId, generation))
    }

    /** The terminal's WebSocket request (bearer-authenticated, so the app owns the socket). */
    internal fun terminalRequest(sessionId: String, terminalId: String) =
        request("${session(sessionId)}/terminals/${terminalId.urlSegment()}/stream").build()

    // ---- acting on a session (needs the control lease) ----

    suspend fun models(sessionId: String): List<ModelOption> =
        get<ModelsResponse>("/api/models?sessionId=${sessionId.urlSegment()}").models.map { it.option() }

    suspend fun control(sessionId: String, clientId: String): ControlLease =
        ControlLease.from(send("GET", "${session(sessionId)}/control"), clientId)

    /** Without [force], the node refuses while another client holds a live lease (409). */
    suspend fun acquireControl(sessionId: String, clientId: String, force: Boolean): ControlLease = ControlLease.from(
        send("POST", "${session(sessionId)}/control/acquire", buildJsonObject {
            put("clientId", clientId)
            put("force", force)
        }),
        clientId,
    )

    suspend fun heartbeatControl(sessionId: String, clientId: String, generation: Long): ControlLease = ControlLease.from(
        send("POST", "${session(sessionId)}/control/heartbeat", held(clientId, generation)),
        clientId,
    )

    suspend fun releaseControl(sessionId: String, clientId: String, generation: Long) {
        send("POST", "${session(sessionId)}/control/release", held(clientId, generation))
    }

    /**
     * Send one command. A command the node did not accept still comes back as a
     * receipt (with its reason), so only transport and lease errors throw.
     */
    suspend fun command(sessionId: String, clientId: String, generation: Long, commandId: String, payload: JsonObject): CommandReceipt {
        val body = buildJsonObject {
            put("commandId", commandId)
            put("clientId", clientId)
            put("generation", generation)
            put("payload", payload)
        }
        val reply = send("POST", "${session(sessionId)}/commands", body, acceptBody = { it["command"] != null })
        val command = reply["command"]
        return CommandReceipt(
            commandId = command["id"].text ?: commandId,
            status = command["status"].text ?: "outcome_unknown",
            message = command["error"].text,
        )
    }

    suspend fun answer(sessionId: String, interactionId: String, clientId: String, generation: Long, answer: InteractionAnswer) {
        send(
            "POST",
            "${session(sessionId)}/interactions/${interactionId.urlSegment()}/answer",
            buildJsonObject {
                put("clientId", clientId)
                put("generation", generation)
                put("answer", answer.rpc())
            },
        )
    }

    /** Store an image on the session's node, where its agent reads it. */
    suspend fun upload(sessionId: String, bytes: ByteArray, mimeType: String): Upload {
        val reply = send("POST", "${session(sessionId)}/uploads", bytes.toRequestBody(mimeType.toMediaType()))
        val upload = reply["upload"]
        return Upload(upload["id"].text ?: error("upload without an id"), upload["mimeType"].text ?: mimeType, upload["byteSize"].number ?: bytes.size.toLong())
    }

    private fun session(sessionId: String) = "/api/sessions/${sessionId.urlSegment()}"

    private fun held(clientId: String, generation: Long) = buildJsonObject {
        put("clientId", clientId)
        put("generation", generation)
    }

    private suspend fun send(method: String, path: String, json: JsonObject, acceptBody: (JsonElement?) -> Boolean = { false }): JsonElement? =
        send(method, path, PircJson.encodeToString(JsonObject.serializer(), json).toRequestBody(JSON), acceptBody)

    /** A JSON request; the reply body, or null for 204. */
    private suspend fun send(
        method: String,
        path: String,
        body: RequestBody? = null,
        acceptBody: (JsonElement?) -> Boolean = { false },
    ): JsonElement? = withContext(Dispatchers.IO) {
        val request = request(path).header("Accept", "application/json").method(method, body).build()
        client.newCall(request).execute().use { response ->
            val text = response.body.string()
            val parsed = runCatching { PircJson.parseToJsonElement(text) }.getOrNull()
            if (!response.isSuccessful && !(response.code != 401 && acceptBody(parsed))) throw failure(response, text)
            if (response.code == 204 || text.isBlank()) null else parsed
        }
    }

    internal fun request(path: String): Request.Builder = Request.Builder()
        .url(pairing.baseUrl + path)
        .header("Authorization", "Bearer ${pairing.token}")

    private suspend inline fun <reified T> get(path: String): T = withContext(Dispatchers.IO) {
        val request = request(path).header("Accept", "application/json").build()
        client.newCall(request).execute().use { response ->
            val body = response.body.string()
            if (!response.isSuccessful) throw failure(response, body)
            PircJson.decodeFromString<T>(body)
        }
    }

    internal fun failure(response: Response, body: String): ApiException {
        val detail = runCatching { PircJson.decodeFromString<ErrorBody>(body).error }.getOrNull()
        val message = when {
            response.code == 401 -> "This phone's device token is invalid, expired or revoked. Pair it again."
            response.isRedirect -> "The gateway redirected the request; check the proxy routes device tokens to pirc."
            else -> detail?.message ?: "Request failed (${response.code})"
        }
        return ApiException(response.code, detail?.code, message)
    }
}
