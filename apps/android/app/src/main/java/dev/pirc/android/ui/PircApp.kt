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
import dev.pirc.android.ui.files.FileScreen
import dev.pirc.android.ui.files.FilesScreen
import kotlinx.serialization.Serializable

@Serializable
data object SessionsRoute

@Serializable
data class SessionRoute(val id: String, val name: String)

@Serializable
data class FilesRoute(val sessionId: String)

/** [line]/[endLine] 0: no line to mark. */
@Serializable
data class FileRoute(val sessionId: String, val path: String, val line: Int = 0, val endLine: Int = 0)

@Composable
fun PircApp(viewModel: AppViewModel) {
    val pairing by viewModel.pairing.collectAsStateWithLifecycle()
    val pendingLink by viewModel.pendingLink.collectAsStateWithLifecycle()

    AnimatedContent(
        targetState = pairing != null,
        transitionSpec = { fadeIn() togetherWith fadeOut() },
        label = "paired",
    ) { paired ->
        if (!paired) {
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
                        SessionViewModel(api, route.id, viewModel.local.clientId, viewModel.local, onUnauthorized = { viewModel.handle(it) })
                    }
                    SessionScreen(
                        session,
                        fallbackName = route.name,
                        onBack = { nav.popBackStack() },
                        onOpenFiles = { nav.navigate(FilesRoute(route.id)) },
                        onOpenFile = { nav.navigate(FileRoute(route.id, it.path, it.line ?: 0, it.endLine ?: 0)) },
                    )
                }
                composable<FilesRoute> { entry ->
                    val route = entry.toRoute<FilesRoute>()
                    val api = viewModel.api() ?: return@composable
                    val files = viewModel<FilesViewModel>(key = "files|${api.pairing.baseUrl}|${route.sessionId}") {
                        FilesViewModel(api, route.sessionId, onUnauthorized = { viewModel.handle(it) })
                    }
                    FilesScreen(
                        files,
                        onOpenFile = { nav.navigate(FileRoute(route.sessionId, it)) },
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
