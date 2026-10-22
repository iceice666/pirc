package dev.pirc.pirc_mobile

import android.content.Context
import java.util.Calendar

/** Preferences apply on this phone, including while Flutter is not running. */
class NotificationPreferences(context: Context) {
    private val prefs = context.getSharedPreferences("notification_preferences", Context.MODE_PRIVATE)
    private val defaults = mapOf("rooms" to true, "q" to true, "deleg" to true,
        "done" to false, "live" to true, "quiet" to false)
    private val layoutKeys = setOf("goalExpanded", "todoExpanded", "showSettled", "detailsOpen", "sidebarCollapsed")
    fun enabled(key: String) = prefs.getBoolean(key, defaults[key] ?: false)
    val lock get() = prefs.getString("lock", "hide")!!
    fun read(): Map<String, Any> = defaults.mapValues { enabled(it.key) } + layoutKeys.associateWith { prefs.getBoolean(it, false) } + mapOf(
        "panelWidth" to prefs.getInt("panelWidth", 360), "mode" to prefs.getString("mode", "chat")!!, "lock" to lock, "start" to prefs.getInt("start", 23 * 60), "end" to prefs.getInt("end", 450),
        "muted" to prefs.getStringSet("muted", emptySet())!!.toList(), "appearance" to prefs.getString("appearance", "system")!!)
    fun save(values: Map<*, *>) {
        val edit = prefs.edit()
        for ((key, value) in values) when {
            (key in defaults || key in layoutKeys) && value is Boolean -> edit.putBoolean(key as String, value)
            key == "panelWidth" && value is Number -> edit.putInt("panelWidth", value.toInt().coerceAtLeast(280))
            key in listOf("start", "end") && value is Number -> edit.putInt(key as String, value.toInt().coerceIn(0, 1439))
            key == "lock" && value in listOf("hide", "summary", "all") -> edit.putString("lock", value as String)
            key == "mode" && value in listOf("chat", "work") -> edit.putString("mode", value as String)
            key == "appearance" && value in listOf("system", "light", "dark") -> edit.putString("appearance", value as String)
            key == "muted" && value is List<*> -> edit.putStringSet("muted", value.filterIsInstance<String>().toSet())
        }
        check(edit.commit()) { "無法儲存設定" }
    }
    fun allows(category: String, workspace: String? = null, minute: Int = Calendar.getInstance().let { it.get(Calendar.HOUR_OF_DAY)*60+it.get(Calendar.MINUTE) }): Boolean {
        if (!enabled(category)) return false
        if (workspace != null && prefs.getStringSet("muted", emptySet())!!.contains(workspace)) return false
        if (!enabled("quiet") || category == "q") return true
        return !inQuietHours(minute, prefs.getInt("start",1380), prefs.getInt("end",450))
    }
}
internal fun inQuietHours(minute: Int, start: Int, end: Int): Boolean = when {
    start == end -> true
    start < end -> minute >= start && minute < end
    else -> minute >= start || minute < end
}
