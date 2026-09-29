package dev.pirc.android.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.pirc.android.SchedulesViewModel
import dev.pirc.android.core.CRON_PRESETS
import dev.pirc.android.core.NOTIFY_CHOICES
import dev.pirc.android.core.ModelRef
import dev.pirc.android.core.SCHEDULE_THINKING_LEVELS
import dev.pirc.android.core.Schedule
import dev.pirc.android.core.ScheduleInput
import dev.pirc.android.core.ScheduleRun
import dev.pirc.android.core.describeWhen
import dev.pirc.android.core.formatWall
import dev.pirc.android.core.parseWall
import dev.pirc.android.core.runLabel
import dev.pirc.android.core.statusLine
import dev.pirc.android.core.validTimezone
import dev.pirc.android.core.wallInput
import dev.pirc.android.core.where
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZoneOffset

/** Marks the form for a new schedule (else it edits the schedule with that id). */
private const val NEW = "new"

/**
 * Scheduled tasks (plans/cron.md): the list, one schedule with its runs, and
 * the form, as one screen (Back steps out of the form, then the detail).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SchedulesScreen(
    viewModel: SchedulesViewModel,
    onOpenSession: (id: String, name: String) -> Unit,
    onBack: () -> Unit,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val message by viewModel.message.collectAsStateWithLifecycle()
    var editing by rememberSaveable { mutableStateOf<String?>(null) }
    val snackbar = remember { SnackbarHostState() }
    val open = state.open

    LifecycleResumeEffect(Unit) {
        viewModel.watch()
        onPauseOrDispose { viewModel.unwatch() }
    }
    LaunchedEffect(message) {
        message?.let {
            snackbar.showSnackbar(it)
            viewModel.dismissMessage()
        }
    }
    LaunchedEffect(editing) { if (editing != null) viewModel.loadFormOptions() }
    BackHandler(enabled = editing != null || open != null) {
        if (editing != null) editing = null else viewModel.close()
    }
    val back = {
        when {
            editing != null -> editing = null
            open != null -> viewModel.close()
            else -> onBack()
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        when {
                            editing == NEW -> "New schedule"
                            editing != null -> "Edit schedule"
                            open != null -> open.title
                            else -> "Schedules"
                        },
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                },
                navigationIcon = { IconButton(onClick = back) { Icon(PircIcons.Back, contentDescription = "Back") } },
            )
        },
        floatingActionButton = {
            if (editing == null && open == null) ExtendedFloatingActionButton(
                onClick = { editing = NEW },
                icon = { Icon(PircIcons.Plus, contentDescription = null) },
                text = { Text("New schedule") },
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        val modifier = Modifier.fillMaxSize().padding(padding)
        val edited = editing
        when {
            edited != null -> ScheduleForm(
                viewModel = viewModel,
                schedule = state.schedules.firstOrNull { it.id == edited },
                modifier = modifier,
                onDone = { saved ->
                    editing = null
                    viewModel.open(saved.id)
                },
                onCancel = { editing = null },
            )
            open != null -> ScheduleDetail(
                viewModel = viewModel,
                schedule = open,
                runs = state.runs,
                busy = state.busy != null,
                modifier = modifier,
                onEdit = { editing = open.id },
                onOpenSession = onOpenSession,
            )
            else -> ScheduleList(viewModel, modifier)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ScheduleList(viewModel: SchedulesViewModel, modifier: Modifier) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    PullToRefreshBox(isRefreshing = state.loading, onRefresh = viewModel::refresh, modifier = modifier) {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 96.dp)) {
            state.error?.let { error ->
                item(key = "error") {
                    Surface(
                        color = MaterialTheme.colorScheme.errorContainer,
                        contentColor = MaterialTheme.colorScheme.onErrorContainer,
                        shape = MaterialTheme.shapes.medium,
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
                    ) { Text(error, modifier = Modifier.padding(16.dp)) }
                }
            }
            if (!state.loading && state.schedules.isEmpty()) item(key = "empty") {
                Text(
                    "No schedules yet. A schedule runs a prompt by itself at set times, each run in a new session. " +
                        "Make one here, or ask your assistant: it asks you before it adds one.",
                    style = MaterialTheme.typography.bodyLarge,
                    modifier = Modifier.padding(24.dp),
                )
            }
            items(state.schedules, key = { it.id }) { schedule ->
                Column(Modifier.animateItem()) {
                    ListItem(
                        modifier = Modifier.clickable { viewModel.open(schedule.id) },
                        headlineContent = { Text(schedule.title, maxLines = 2, overflow = TextOverflow.Ellipsis) },
                        supportingContent = {
                            Column {
                                Text(describeWhen(schedule.cron, schedule.runAt, schedule.timezone))
                                Text(schedule.where(), color = MaterialTheme.colorScheme.onSurfaceVariant)
                                Text(schedule.statusLine(), color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        },
                        trailingContent = {
                            when {
                                schedule.attention > 0 -> Badge("${schedule.attention} waiting", MaterialTheme.colorScheme.tertiaryContainer, MaterialTheme.colorScheme.onTertiaryContainer)
                                schedule.paused -> Badge("Paused", MaterialTheme.colorScheme.surfaceVariant, MaterialTheme.colorScheme.onSurfaceVariant)
                                schedule.status == "done" -> Badge("Done", MaterialTheme.colorScheme.surfaceVariant, MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        },
                    )
                    HorizontalDivider(Modifier.padding(start = 16.dp))
                }
            }
        }
    }
}

@Composable
private fun Badge(text: String, color: androidx.compose.ui.graphics.Color, content: androidx.compose.ui.graphics.Color) {
    Surface(shape = MaterialTheme.shapes.small, color = color, contentColor = content) {
        Text(text, style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp))
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ScheduleDetail(
    viewModel: SchedulesViewModel,
    schedule: Schedule,
    runs: List<ScheduleRun>,
    busy: Boolean,
    modifier: Modifier,
    onEdit: () -> Unit,
    onOpenSession: (id: String, name: String) -> Unit,
) {
    var deleting by remember { mutableStateOf(false) }
    if (deleting) AlertDialog(
        onDismissRequest = { deleting = false },
        title = { Text("Delete “${schedule.title}”?") },
        text = { Text("It stops running and its run history goes. Sessions it started stay.") },
        confirmButton = {
            TextButton(onClick = {
                deleting = false
                viewModel.delete(schedule.id) {}
            }) { Text("Delete") }
        },
        dismissButton = { TextButton(onClick = { deleting = false }) { Text("Cancel") } },
    )

    LazyColumn(modifier, contentPadding = PaddingValues(16.dp, 8.dp, 16.dp, 32.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item(key = "summary") {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(describeWhen(schedule.cron, schedule.runAt, schedule.timezone), style = MaterialTheme.typography.titleMedium)
                Text(schedule.where(), color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(schedule.statusLine(), color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (schedule.paused) Text("Paused", color = MaterialTheme.colorScheme.tertiary)
            }
        }
        item(key = "actions") {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Button(onClick = { viewModel.runNow(schedule.id) }, enabled = !busy && schedule.workspace.online) { Text("Run now") }
                if (schedule.active) OutlinedButton(onClick = { viewModel.pause(schedule.id) }, enabled = !busy) { Text("Pause") }
                if (schedule.paused) OutlinedButton(onClick = { viewModel.resume(schedule.id) }, enabled = !busy) { Text("Resume") }
                OutlinedButton(onClick = onEdit, enabled = !busy) { Text("Edit") }
                TextButton(onClick = { deleting = true }, enabled = !busy) { Text("Delete", color = MaterialTheme.colorScheme.error) }
            }
            if (!schedule.workspace.online)
                Text("${schedule.workspace.node ?: "Its node"} is offline.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        item(key = "prompt") {
            Surface(color = MaterialTheme.colorScheme.surfaceContainer, shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("Prompt", style = MaterialTheme.typography.labelLarge)
                    SelectionContainer { Text(schedule.prompt) }
                }
            }
        }
        item(key = "runs-title") { Text("Runs", style = MaterialTheme.typography.titleSmall) }
        if (runs.isEmpty()) item(key = "no-runs") {
            Text("No runs yet.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        items(runs, key = { it.id }) { run ->
            RunRow(
                run = run,
                timezone = schedule.timezone,
                busy = busy,
                online = schedule.workspace.online,
                onAllow = { viewModel.allow(schedule.id, run.id) },
                onDismiss = { viewModel.dismiss(schedule.id, run.id) },
                onOpen = { onOpenSession(run.sessionId!!, run.session ?: schedule.title) },
            )
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun RunRow(
    run: ScheduleRun,
    timezone: String,
    busy: Boolean,
    online: Boolean,
    onAllow: () -> Unit,
    onDismiss: () -> Unit,
    onOpen: () -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val tone = when (run.status) {
        "completed" -> colors.primary
        "failed" -> colors.error
        "missed", "waiting_input" -> colors.tertiary
        else -> colors.onSurfaceVariant
    }
    Surface(color = colors.surfaceContainerLow, shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(runLabel(run.status), color = tone, fontWeight = FontWeight.SemiBold)
                Text("due ${formatWall(run.dueAt, timezone)}", style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant)
            }
            run.result?.let { SelectionContainer { Text(it, style = MaterialTheme.typography.bodyMedium, maxLines = 12, overflow = TextOverflow.Ellipsis) } }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (run.missed) {
                    Button(onClick = onAllow, enabled = !busy && online) { Text("Allow and run now") }
                    TextButton(onClick = onDismiss, enabled = !busy) { Text("Dismiss") }
                }
                if (run.sessionId != null && run.session != null) TextButton(onClick = onOpen) { Text("Open session") }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun ScheduleForm(
    viewModel: SchedulesViewModel,
    schedule: Schedule?,
    modifier: Modifier,
    onDone: (Schedule) -> Unit,
    onCancel: () -> Unit,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val device = remember { ZoneId.systemDefault().id }
    var workspaceId by rememberSaveable { mutableStateOf(schedule?.workspaceId.orEmpty()) }
    var title by rememberSaveable { mutableStateOf(schedule?.title.orEmpty()) }
    var prompt by rememberSaveable { mutableStateOf(schedule?.prompt.orEmpty()) }
    var repeat by rememberSaveable { mutableStateOf(schedule?.runAt == null) }
    var cron by rememberSaveable { mutableStateOf(schedule?.cron ?: "0 9 * * *") }
    var timezone by rememberSaveable { mutableStateOf(schedule?.timezone ?: device) }
    var at by rememberSaveable {
        mutableStateOf(wallInput(schedule?.runAt ?: (System.currentTimeMillis() + 3_600_000), schedule?.timezone ?: device))
    }
    /** `provider/id`, or "" for the default. */
    var model by rememberSaveable { mutableStateOf(schedule?.model?.let { "${it.provider}/${it.id}" }.orEmpty()) }
    var thinking by rememberSaveable { mutableStateOf(schedule?.thinking.orEmpty()) }
    var notify by rememberSaveable { mutableStateOf(schedule?.notify ?: "all") }
    var error by rememberSaveable { mutableStateOf<String?>(null) }
    var picking by remember { mutableStateOf<String?>(null) }

    // New: the first node workspace once they are listed.
    LaunchedEffect(state.workspaces) {
        if (workspaceId.isEmpty()) state.workspaces.firstOrNull()?.let { workspaceId = it.id }
    }
    val wall = parseWall(at)
    val zoneOk = validTimezone(timezone)
    val ready = workspaceId.isNotEmpty() && prompt.isNotBlank() && zoneOk &&
        (if (repeat) cron.trim().split(Regex("\\s+")).size == 5 else wall != null) && state.busy == null

    fun submit() {
        val chosen = state.models.firstOrNull { it.key == model }
        val input = ScheduleInput(
            workspaceId = workspaceId,
            title = title.trim(),
            prompt = prompt,
            cron = if (repeat) cron.trim() else null,
            at = if (repeat) null else at.trim(),
            timezone = timezone.trim(),
            // Keep a model the list no longer offers rather than silently dropping it.
            model = when {
                model.isEmpty() -> null
                chosen != null -> ModelRef(chosen.provider, chosen.id)
                else -> schedule?.model
            },
            thinking = thinking.ifEmpty { null },
            notify = notify,
        )
        error = null
        viewModel.save(schedule?.id, input, onError = { error = it }, onDone = onDone)
    }

    Column(
        modifier.verticalScroll(rememberScrollState()).imePadding().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Workspace", style = MaterialTheme.typography.labelLarge)
        if (state.workspaces.isEmpty()) Text("Loading workspaces…", color = MaterialTheme.colorScheme.onSurfaceVariant)
        for (workspace in state.workspaces) Row(
            Modifier.fillMaxWidth().heightIn(min = 44.dp).selectable(workspaceId == workspace.id, role = Role.RadioButton) { workspaceId = workspace.id },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            RadioButton(selected = workspaceId == workspace.id, onClick = null)
            Text("${workspace.displayName} · ${workspace.hostId}", modifier = Modifier.padding(start = 12.dp))
        }
        OutlinedTextField(
            value = title,
            onValueChange = { title = it.take(80) },
            label = { Text("Title") },
            placeholder = { Text("Named after the prompt's first line") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = prompt,
            onValueChange = { prompt = it },
            label = { Text("Prompt") },
            supportingText = { Text("Each run starts fresh with only this.") },
            minLines = 4,
            modifier = Modifier.fillMaxWidth(),
        )
        Text("When", style = MaterialTheme.typography.labelLarge)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(selected = repeat, onClick = { repeat = true }, label = { Text("Repeat") })
            FilterChip(selected = !repeat, onClick = { repeat = false }, label = { Text("Once") })
        }
        if (repeat) {
            OutlinedTextField(
                value = cron,
                onValueChange = { cron = it },
                label = { Text("Cron") },
                supportingText = { Text("minute hour day-of-month month day-of-week") },
                singleLine = true,
                textStyle = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii),
                modifier = Modifier.fillMaxWidth(),
            )
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for ((label, expression) in CRON_PRESETS)
                    FilterChip(selected = cron.trim() == expression, onClick = { cron = expression }, label = { Text(label) })
            }
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                OutlinedButton(onClick = { picking = "date" }) { Text(wall?.toLocalDate()?.toString() ?: "Pick a date") }
                OutlinedButton(onClick = { picking = "time" }) { Text(wall?.toLocalTime()?.toString() ?: "Pick a time") }
            }
        }
        OutlinedTextField(
            value = timezone,
            onValueChange = { timezone = it },
            label = { Text("Time zone") },
            isError = !zoneOk,
            supportingText = { Text(if (zoneOk) "IANA name, like Asia/Taipei" else "Unknown time zone") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Choice(
            label = "Model",
            value = state.models.firstOrNull { it.key == model }?.let { "${it.displayName} · ${it.provider}" }
                ?: model.ifEmpty { "Workspace default" },
            options = listOf("" to "Workspace default") + state.models.map { it.key to "${it.displayName} · ${it.provider}" },
            onChoose = { model = it },
        )
        Choice(
            label = "Thinking",
            value = thinking.ifEmpty { "Default" },
            options = listOf("" to "Default") + SCHEDULE_THINKING_LEVELS.map { it to it },
            onChoose = { thinking = it },
        )
        Choice(
            label = "Notifications",
            value = NOTIFY_CHOICES.firstOrNull { it.first == notify }?.second ?: notify,
            options = NOTIFY_CHOICES,
            onChoose = { notify = it },
        )
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            TextButton(onClick = onCancel) { Text("Cancel") }
            Button(onClick = ::submit, enabled = ready) { Text(if (schedule == null) "Create" else "Save") }
        }
    }

    val current = wall ?: parseWall(wallInput(System.currentTimeMillis() + 3_600_000, device))!!
    when (picking) {
        "date" -> {
            val picker = rememberDatePickerState(
                initialSelectedDateMillis = current.toLocalDate().atStartOfDay().toInstant(ZoneOffset.UTC).toEpochMilli(),
            )
            DatePickerDialog(
                onDismissRequest = { picking = null },
                confirmButton = {
                    TextButton(onClick = {
                        picker.selectedDateMillis?.let {
                            val date = LocalDate.ofEpochDay(it / 86_400_000)
                            at = current.with(date).toString().take(16)
                        }
                        picking = null
                    }) { Text("OK") }
                },
                dismissButton = { TextButton(onClick = { picking = null }) { Text("Cancel") } },
            ) { DatePicker(picker) }
        }
        "time" -> {
            val picker = rememberTimePickerState(current.hour, current.minute, is24Hour = true)
            AlertDialog(
                onDismissRequest = { picking = null },
                title = { Text("Time in $timezone") },
                text = { TimePicker(picker) },
                confirmButton = {
                    TextButton(onClick = {
                        at = current.with(LocalTime.of(picker.hour, picker.minute)).toString().take(16)
                        picking = null
                    }) { Text("OK") }
                },
                dismissButton = { TextButton(onClick = { picking = null }) { Text("Cancel") } },
            )
        }
    }
}

/** A labelled value that opens a menu of [options] (value to label). */
@Composable
private fun Choice(label: String, value: String, options: List<Pair<String, String>>, onChoose: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Column {
        Text(label, style = MaterialTheme.typography.labelLarge)
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedButton(onClick = { open = true }) {
                Text(value, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Icon(PircIcons.ChevronDown, contentDescription = null, modifier = Modifier.padding(start = 4.dp))
            }
            DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                for ((key, text) in options) DropdownMenuItem(text = { Text(text) }, onClick = {
                    open = false
                    onChoose(key)
                })
            }
        }
    }
}
