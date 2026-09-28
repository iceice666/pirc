package dev.pirc.android

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.pirc.android.core.ApiException
import dev.pirc.android.core.DirListing
import dev.pirc.android.core.FileContent
import dev.pirc.android.core.PircApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.io.IOException

sealed interface Loadable<out T> {
    data object Loading : Loadable<Nothing>
    data class Ready<T>(val value: T) : Loadable<T>
    data class Failed(val message: String) : Loadable<Nothing>
}

/** Browse a session's workspace one directory at a time; visited directories are cached. */
class FilesViewModel(
    private val api: PircApi,
    private val sessionId: String,
    private val onUnauthorized: (ApiException) -> Unit,
) : ViewModel() {
    private val cache = HashMap<String, DirListing>()
    private var loading: Job? = null

    private val _path = MutableStateFlow("")
    val path: StateFlow<String> = _path.asStateFlow()

    private val _listing = MutableStateFlow<Loadable<DirListing>>(Loadable.Loading)
    val listing: StateFlow<Loadable<DirListing>> = _listing.asStateFlow()

    init {
        open("")
    }

    /** Show [path] ("" is the workspace root); [refresh] skips the cache. */
    fun open(path: String, refresh: Boolean = false) {
        _path.value = path
        loading?.cancel()
        val cached = cache[path]
        _listing.value = if (cached != null && !refresh) Loadable.Ready(cached) else Loadable.Loading
        if (cached != null && !refresh) return
        loading = viewModelScope.launch {
            _listing.value = try {
                api.files(sessionId, path).also { cache[path] = it; cache[it.path] = it }.let { Loadable.Ready(it) }
            } catch (error: IOException) {
                if (error is ApiException && error.unauthorized) onUnauthorized(error)
                Loadable.Failed(error.message ?: "Could not list this folder.")
            }
        }
    }

    /** The parent folder, or null at the root. */
    fun parent(): String? = _path.value.takeIf { it.isNotEmpty() }?.substringBeforeLast('/', "")
}

class FileViewModel(
    private val api: PircApi,
    private val sessionId: String,
    val path: String,
    private val onUnauthorized: (ApiException) -> Unit,
) : ViewModel() {
    private val _file = MutableStateFlow<Loadable<FileContent>>(Loadable.Loading)
    val file: StateFlow<Loadable<FileContent>> = _file.asStateFlow()

    init {
        load()
    }

    fun load() {
        _file.value = Loadable.Loading
        viewModelScope.launch {
            _file.value = try {
                Loadable.Ready(api.file(sessionId, path))
            } catch (error: IOException) {
                if (error is ApiException && error.unauthorized) onUnauthorized(error)
                Loadable.Failed(error.message ?: "Could not open this file.")
            }
        }
    }
}
