package dev.pirc.android.core

import android.content.Context
import java.util.UUID

/**
 * Small per-install state: this client's ID (the control lease names its
 * holder by it) and unsent drafts per session.
 */
interface Drafts {
    fun draft(sessionId: String): String
    fun saveDraft(sessionId: String, text: String)
}

data class LastSession(val id: String, val name: String)

class LocalStore(context: Context) : Drafts {
    private val prefs = context.getSharedPreferences("local", Context.MODE_PRIVATE)

    val clientId: String = prefs.getString(CLIENT_ID, null)
        ?: "android-${UUID.randomUUID()}".also { prefs.edit().putString(CLIENT_ID, it).apply() }

    override fun draft(sessionId: String): String = prefs.getString(DRAFT + sessionId, "") ?: ""

    override fun saveDraft(sessionId: String, text: String) {
        prefs.edit().apply { if (text.isEmpty()) remove(DRAFT + sessionId) else putString(DRAFT + sessionId, text) }.apply()
    }

    /** Drop the drafts of sessions that no longer exist. */
    fun pruneDrafts(sessionIds: Collection<String>) {
        val known = sessionIds.mapTo(HashSet()) { DRAFT + it }
        val stale = prefs.all.keys.filter { it.startsWith(DRAFT) && it !in known }
        if (stale.isNotEmpty()) prefs.edit().apply { stale.forEach(::remove) }.apply()
    }

    /** Unpairing: the drafts belong to the old gateway's sessions. */
    fun clearDrafts() = pruneDrafts(emptyList())

    /** The terminal's text size, as last pinched. */
    var terminalFontSize: Float
        get() = prefs.getFloat(TERMINAL_FONT, 13f)
        set(value) = prefs.edit().putFloat(TERMINAL_FONT, value).apply()

    /** The session on screen, reopened at the next launch; null once back on the list. */
    var lastSession: LastSession?
        get() {
            val id = prefs.getString(LAST_SESSION_ID, null) ?: return null
            return LastSession(id, prefs.getString(LAST_SESSION_NAME, null) ?: "")
        }
        set(value) = prefs.edit().apply {
            if (value == null) remove(LAST_SESSION_ID).remove(LAST_SESSION_NAME)
            else putString(LAST_SESSION_ID, value.id).putString(LAST_SESSION_NAME, value.name)
        }.apply()

    private companion object {
        const val LAST_SESSION_ID = "last_session_id"
        const val LAST_SESSION_NAME = "last_session_name"
        const val TERMINAL_FONT = "terminal_font_size"
        const val CLIENT_ID = "client_id"
        const val DRAFT = "draft:"
    }
}
