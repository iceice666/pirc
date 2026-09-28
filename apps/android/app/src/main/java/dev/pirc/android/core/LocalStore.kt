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

    private companion object {
        const val TERMINAL_FONT = "terminal_font_size"
        const val CLIENT_ID = "client_id"
        const val DRAFT = "draft:"
    }
}
