package dev.pirc.android.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import dev.pirc.android.SessionsState
import dev.pirc.android.core.Session
import dev.pirc.android.core.Workspace

/** Pick a workspace for a new session; offline ones are listed but disabled. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NewSessionSheet(state: SessionsState, onCreate: (Workspace) -> Unit, onAddWorkspace: () -> Unit, onDismiss: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.navigationBarsPadding()) {
            Text("New session", style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp))
            Text(
                "Choose the workspace it works in.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 24.dp),
            )
            val workspaces = state.workspaces.sortedWith(compareByDescending<Workspace> { state.online(it) }.thenBy { it.displayName.lowercase() })
            LazyColumn(Modifier.padding(top = 8.dp)) {
                items(workspaces, key = { it.id }) { workspace ->
                    val online = state.online(workspace)
                    ListItem(
                        headlineContent = { Text(workspace.displayName) },
                        supportingContent = { Text(if (online) workspace.hostId else "${workspace.hostId} · offline") },
                        modifier = Modifier.clickable(enabled = online) { onCreate(workspace) },
                        colors = androidx.compose.material3.ListItemDefaults.colors(
                            headlineColor = if (online) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.outline,
                        ),
                    )
                }
                if (workspaces.isEmpty()) item { Text("No workspaces yet.", modifier = Modifier.padding(24.dp)) }
                item {
                    HorizontalDivider()
                    ListItem(
                        headlineContent = { Text("Add a workspace…") },
                        supportingContent = { Text("A folder on one of your nodes") },
                        modifier = Modifier.clickable(onClick = onAddWorkspace),
                    )
                }
            }
        }
    }
}

/** Register a folder of an online node as a workspace. */
@Composable
fun AddWorkspaceDialog(state: SessionsState, onAdd: (nodeId: String, path: String, name: String) -> Unit, onDismiss: () -> Unit) {
    var node by rememberSaveable { mutableStateOf(state.nodes.firstOrNull()?.id.orEmpty()) }
    var path by rememberSaveable { mutableStateOf("~/") }
    var name by rememberSaveable { mutableStateOf("") }
    val suggested = path.trimEnd('/').substringAfterLast('/').takeIf { it.isNotEmpty() && it != "~" }.orEmpty()
    val ready = node.isNotEmpty() && path.trim().length > 2 && (name.isNotBlank() || suggested.isNotEmpty())
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Add a workspace") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                if (state.nodes.isEmpty()) Text("No node is online.")
                for (candidate in state.nodes) Row(
                    Modifier.fillMaxWidth().heightIn(min = 48.dp).selectable(node == candidate.id, role = Role.RadioButton) { node = candidate.id },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RadioButton(selected = node == candidate.id, onClick = null)
                    Text(candidate.id, modifier = Modifier.padding(start = 12.dp))
                }
                OutlinedTextField(
                    value = path,
                    onValueChange = { path = it },
                    label = { Text("Folder") },
                    supportingText = { Text("Must exist inside the node's home folder") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                )
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text("Name") },
                    placeholder = { Text(suggested) },
                    singleLine = true,
                )
            }
        },
        confirmButton = {
            TextButton(onClick = { onAdd(node, path.trim(), name.trim().ifEmpty { suggested }) }, enabled = ready) { Text("Add") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

/** Rename, pin and settle one session. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionActionsSheet(
    session: Session,
    onRename: () -> Unit,
    onPin: (Boolean) -> Unit,
    onSettle: (Boolean) -> Unit,
    onDismiss: () -> Unit,
) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.navigationBarsPadding().padding(bottom = 8.dp)) {
            Text(session.name, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp))
            ListItem(headlineContent = { Text("Rename") }, modifier = Modifier.clickable(onClick = onRename))
            ListItem(
                headlineContent = { Text(if (session.pinned) "Unpin" else "Pin to the top") },
                modifier = Modifier.clickable { onPin(!session.pinned) },
            )
            ListItem(
                headlineContent = { Text(if (session.settled) "Reopen" else "Mark as settled") },
                supportingContent = { if (!session.settled) Text("Tucks it away at the bottom of its workspace") },
                modifier = Modifier.clickable { onSettle(!session.settled) },
            )
        }
    }
}

@Composable
fun RenameDialog(name: String, onRename: (String) -> Unit, onDismiss: () -> Unit) {
    var value by remember { mutableStateOf(TextFieldValue(name, TextRange(0, name.length))) }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }
    val submit = { value.text.trim().takeIf { it.isNotEmpty() && it != name }?.let(onRename) ?: onDismiss() }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Rename session") },
        text = {
            OutlinedTextField(
                value = value,
                onValueChange = { if (it.text.length <= 200) value = it },
                singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                // Done with a blank name must not act as Cancel; like the button, it does nothing.
                keyboardActions = KeyboardActions(onDone = { if (value.text.isNotBlank()) submit() }),
                modifier = Modifier.focusRequester(focus),
            )
        },
        confirmButton = { TextButton(onClick = { submit() }, enabled = value.text.isNotBlank()) { Text("Rename") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
