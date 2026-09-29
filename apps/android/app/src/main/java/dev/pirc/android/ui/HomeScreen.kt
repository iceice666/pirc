package dev.pirc.android.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.pirc.android.AppViewModel
import dev.pirc.android.HomeTab
import dev.pirc.android.SchedulesViewModel
import dev.pirc.android.core.Session

/** Long-press actions on a session row, shared by the tabs. */
internal class SessionActions(val open: (Session) -> Unit, val act: (Session) -> Unit)

/**
 * The phone's home (plans/ui-redesign.md): bottom tabs Chat / Work /
 * Schedules / Settings. Work's badge counts what waits on the user.
 */
@Composable
fun HomeScreen(
    viewModel: AppViewModel,
    schedules: SchedulesViewModel?,
    onOpen: (Session) -> Unit,
    onOpenSession: (id: String, name: String) -> Unit,
) {
    val inbox by viewModel.inbox.collectAsStateWithLifecycle()
    val actionError by viewModel.actionError.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }
    var acting by remember { mutableStateOf<Session?>(null) }
    var renaming by remember { mutableStateOf<Session?>(null) }
    val actions = remember(onOpen) { SessionActions(onOpen) { acting = it } }

    // Also the first load, and back from a session: its name, pin or activity
    // may have changed. While shown, the lists keep themselves current.
    LifecycleResumeEffect(Unit) {
        // Back on the list: the next launch starts here too.
        viewModel.local.lastSession = null
        viewModel.watchSessions()
        onPauseOrDispose { viewModel.unwatchSessions() }
    }
    LaunchedEffect(actionError) {
        actionError?.let {
            snackbar.showSnackbar(it)
            viewModel.dismissActionError()
        }
    }
    // Back from another tab returns to Chat, where the app opens.
    BackHandler(enabled = viewModel.tab != HomeTab.Chat) { viewModel.tab = HomeTab.Chat }

    Scaffold(
        bottomBar = {
            NavigationBar {
                for (tab in HomeTab.entries) {
                    val badge = if (tab == HomeTab.Work) inbox.count else 0
                    NavigationBarItem(
                        selected = viewModel.tab == tab,
                        onClick = { viewModel.tab = tab },
                        icon = {
                            if (badge > 0) BadgedBox(badge = { Badge { Text(badge.toString()) } }) { Icon(tab.icon(), contentDescription = null) }
                            else Icon(tab.icon(), contentDescription = null)
                        },
                        label = { Text(tab.label) },
                        modifier = Modifier.semantics { if (badge > 0) stateDescription = "$badge waiting for you" },
                    )
                }
            }
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding)) {
            when (viewModel.tab) {
                HomeTab.Chat -> ChatTab(viewModel, actions)
                HomeTab.Work -> WorkTab(viewModel, actions)
                HomeTab.Schedules -> if (schedules != null) SchedulesScreen(schedules, onOpenSession = onOpenSession, onBack = null)
                HomeTab.Settings -> SettingsTab(viewModel)
            }
        }
    }

    acting?.let { session ->
        SessionActionsSheet(
            session = session,
            onRename = {
                acting = null
                renaming = session
            },
            onPin = {
                acting = null
                viewModel.updateSession(session, pinned = it)
            },
            onSettle = {
                acting = null
                viewModel.updateSession(session, settled = it)
            },
            onDismiss = { acting = null },
        )
    }
    renaming?.let { session ->
        RenameDialog(
            name = session.name,
            onRename = {
                renaming = null
                viewModel.updateSession(session, name = it)
            },
            onDismiss = { renaming = null },
        )
    }
}

private fun HomeTab.icon(): ImageVector = when (this) {
    HomeTab.Chat -> PircIcons.Chat
    HomeTab.Work -> PircIcons.Work
    HomeTab.Schedules -> PircIcons.Calendar
    HomeTab.Settings -> PircIcons.Settings
}
