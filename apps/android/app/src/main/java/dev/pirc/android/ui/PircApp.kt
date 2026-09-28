package dev.pirc.android.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.toRoute
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.pirc.android.AppViewModel
import dev.pirc.android.FileViewModel
import dev.pirc.android.FilesViewModel
import dev.pirc.android.SessionViewModel
import dev.pirc.android.core.FileTarget
import dev.pirc.android.PanelTab
import dev.pirc.android.PanelsViewModel
import dev.pirc.android.TerminalViewModel
import dev.pirc.android.core.ApiException
import dev.pirc.android.ui.files.FileScreen
import dev.pirc.android.ui.panels.CommitScreen
import dev.pirc.android.ui.panels.DiffScreen
import dev.pirc.android.ui.panels.PanelsScreen
import dev.pirc.android.ui.panels.TerminalScreen
import kotlinx.serialization.Serializable

@Serializable
data object SessionsRoute

@Serializable
data class SessionRoute(val id: String, val name: String)

/** [tab]: a [PanelTab] name. */
@Serializable
data class PanelsRoute(val sessionId: String, val title: String, val tab: String = "Files")

@Serializable
data class DiffRoute(val sessionId: String, val path: String, val staged: Boolean, val untracked: Boolean)

@Serializable
data class CommitRoute(val sessionId: String, val sha: String)

@Serializable
data class TerminalRoute(val sessionId: String, val terminalId: String, val title: String)

/** [line]/[endLine] 0: no line to mark. */
@Serializable
data class FileRoute(val sessionId: String, val path: String, val line: Int = 0, val endLine: Int = 0)

@Composable
fun PircApp(viewModel: AppViewModel) {
    val pairing by viewModel.pairing.collectAsStateWithLifecycle()
    val loaded by viewModel.loaded.collectAsStateWithLifecycle()
    val pendingLink by viewModel.pendingLink.collectAsStateWithLifecycle()

    // Keyed by the pairing itself: pairing with another gateway (or a new
    // token) starts a fresh back stack, since the old session ids mean nothing there.
    if (loaded) AnimatedContent(
        targetState = pairing,
        transitionSpec = { fadeIn() togetherWith fadeOut() },
        label = "paired",
    ) { paired ->
        if (paired == null) {
            PairScreen(viewModel)
        } else {
            val nav = rememberNavController()
            NavHost(navController = nav, startDestination = SessionsRoute) {
                composable<SessionsRoute> {
                    SessionsScreen(viewModel, onOpen = { nav.navigate(SessionRoute(it.id, it.name)) })
                }
                composable<SessionRoute> { entry ->
                    val route = entry.toRoute<SessionRoute>()
                    val api = viewModel.api() ?: return@composable
                    val session = viewModel<SessionViewModel>(key = "${api.pairing.baseUrl}|${route.id}") {
                        SessionViewModel(api, route.id, viewModel.local.clientId, viewModel.local, onUnauthorized = { viewModel.handle(it) }, cursors = viewModel.cursors)
                    }
                    SessionScreen(
                        session,
                        fallbackName = route.name,
                        onBack = { nav.popBackStack() },
                        onOpenPanels = { title, tab -> nav.navigate(PanelsRoute(route.id, title, tab.name)) },
                        onOpenFile = { nav.navigate(FileRoute(route.id, it.path, it.line ?: 0, it.endLine ?: 0)) },
                        onChanged = viewModel::replaceSession,
                    )
                }
                composable<PanelsRoute> { entry ->
                    val route = entry.toRoute<PanelsRoute>()
                    val api = viewModel.api() ?: return@composable
                    val unauthorized = { error: ApiException -> viewModel.handle(error) }
                    val files = viewModel<FilesViewModel>(key = "files|${api.pairing.baseUrl}|${route.sessionId}") {
                        FilesViewModel(api, route.sessionId, unauthorized)
                    }
                    val panels = viewModel<PanelsViewModel>(key = "panels|${api.pairing.baseUrl}|${route.sessionId}") {
                        PanelsViewModel(api, route.sessionId, viewModel.local.clientId, PanelTab.valueOf(route.tab), unauthorized, cursor = { viewModel.cursors[route.sessionId] })
                    }
                    PanelsScreen(
                        panels,
                        files,
                        api,
                        title = route.title,
                        onUnauthorized = unauthorized,
                        onOpenFile = { nav.navigate(FileRoute(route.sessionId, it)) },
                        onOpenDiff = { file, staged -> nav.navigate(DiffRoute(route.sessionId, file.path, staged, file.untracked && !staged)) },
                        onOpenCommit = { nav.navigate(CommitRoute(route.sessionId, it.sha)) },
                        onOpenTerminal = { nav.navigate(TerminalRoute(route.sessionId, it.id, it.title.ifEmpty { "Terminal" })) },
                        onBack = { nav.popBackStack() },
                    )
                }
                composable<DiffRoute> { entry ->
                    val route = entry.toRoute<DiffRoute>()
                    val api = viewModel.api() ?: return@composable
                    DiffScreen(api, route.sessionId, route.path, route.staged, route.untracked, { viewModel.handle(it) }) { nav.popBackStack() }
                }
                composable<CommitRoute> { entry ->
                    val route = entry.toRoute<CommitRoute>()
                    val api = viewModel.api() ?: return@composable
                    CommitScreen(api, route.sessionId, route.sha, { viewModel.handle(it) }) { nav.popBackStack() }
                }
                composable<TerminalRoute> { entry ->
                    val route = entry.toRoute<TerminalRoute>()
                    val api = viewModel.api() ?: return@composable
                    val terminal = viewModel<TerminalViewModel>(key = "terminal|${api.pairing.baseUrl}|${route.sessionId}|${route.terminalId}") {
                        TerminalViewModel(api, route.sessionId, route.terminalId, viewModel.local.clientId) { viewModel.handle(it) }
                    }
                    TerminalScreen(
                        terminal,
                        title = route.title,
                        initialFontSize = viewModel.local.terminalFontSize,
                        onFontSize = { viewModel.local.terminalFontSize = it },
                        onClose = { terminal.close { nav.popBackStack() } },
                        onBack = { nav.popBackStack() },
                    )
                }
                composable<FileRoute> { entry ->
                    val route = entry.toRoute<FileRoute>()
                    val api = viewModel.api() ?: return@composable
                    val file = viewModel<FileViewModel>(key = "file|${api.pairing.baseUrl}|${route.sessionId}|${route.path}") {
                        FileViewModel(api, route.sessionId, route.path, onUnauthorized = { viewModel.handle(it) })
                    }
                    FileScreen(
                        file,
                        target = FileTarget(route.path, route.line.takeIf { it > 0 }, route.endLine.takeIf { it > 0 }),
                        onOpenFile = { nav.navigate(FileRoute(route.sessionId, it.path, it.line ?: 0, it.endLine ?: 0)) },
                        onBack = { nav.popBackStack() },
                    )
                }
            }
        }
    }

    pendingLink?.let { link ->
        AlertDialog(
            onDismissRequest = viewModel::dismissLink,
            title = { Text("Pair with this gateway?") },
            text = {
                Text(
                    "${link.baseUrl}\n\nOnly continue if you just created this link in your own pirc. " +
                        (if (pairing != null) "It replaces the current pairing." else ""),
                )
            },
            confirmButton = { TextButton(onClick = viewModel::confirmLink) { Text("Pair") } },
            dismissButton = { TextButton(onClick = viewModel::dismissLink) { Text("Cancel") } },
        )
    }
}
