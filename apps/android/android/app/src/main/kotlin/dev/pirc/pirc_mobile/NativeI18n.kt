package dev.pirc.pirc_mobile

import android.app.Application
import android.content.Context
import android.content.SharedPreferences
import org.json.JSONObject

/** Shares the Flutter language preference even in a background-only process. */
object NativeI18n {
    private var preferences: SharedPreferences? = null
    private var english: Map<String, String> = emptyMap()
    private var traditionalChinese: Map<String, String> = emptyMap()
    private val parameter = Regex("\\{(\\d+)\\}")

    fun initialize(context: Context) {
        val app = context.applicationContext
        fun catalog(language: String): Map<String, String> {
            val json = app.assets.open("locales/$language.json").bufferedReader().use { JSONObject(it.readText()) }
            return json.keys().asSequence().associateWith { json.getString(it) }
        }
        english = catalog("en")
        traditionalChinese = catalog("zh-TW")
        preferences = app.getSharedPreferences("notification_preferences", Context.MODE_PRIVATE)
    }

    fun text(source: String, vararg values: Any?): String {
        val fallback = english[source] ?: source
        val template = if (preferences?.getString("language", "en") == "zh-TW")
            traditionalChinese[source] ?: fallback else fallback
        return parameter.replace(template) { match ->
            val index = match.groupValues[1].toIntOrNull()
            if (index != null && index < values.size) values[index]?.toString().orEmpty() else match.value
        }
    }
}

class PircApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        NativeI18n.initialize(this)
    }
}
