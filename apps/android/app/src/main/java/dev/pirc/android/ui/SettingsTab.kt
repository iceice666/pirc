package dev.pirc.android.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.pirc.android.AppViewModel
import dev.pirc.android.core.Connectivity

/** What the old list's More menu held: the gateway, notifications, memory proposals, unpairing. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SettingsTab(viewModel: AppViewModel) {
    val pairing by viewModel.pairing.collectAsStateWithLifecycle()
    val online by Connectivity.online.collectAsStateWithLifecycle()
    val inbox by viewModel.inbox.collectAsStateWithLifecycle()
    val busy by viewModel.inboxBusy.collectAsStateWithLifecycle()
    val sources by viewModel.proposalSources.collectAsStateWithLifecycle()
    var notifications by remember { mutableStateOf(false) }
    var unpairing by remember { mutableStateOf(false) }

    if (notifications) NotificationsDialog(viewModel.api()) { notifications = false }
    if (unpairing) AlertDialog(
        onDismissRequest = { unpairing = false },
        title = { Text("Unpair this phone?") },
        text = { Text("This phone forgets its device token. To use it again, create a new pairing link on the web.") },
        confirmButton = {
            TextButton(onClick = {
                unpairing = false
                viewModel.unpair()
            }) { Text("Unpair") }
        },
        dismissButton = { TextButton(onClick = { unpairing = false }) { Text("Cancel") } },
    )

    Scaffold(topBar = { TopAppBar(title = { Text("Settings") }) }) { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding), contentPadding = PaddingValues(bottom = 24.dp)) {
            item(key = "h:gateway") { SectionHeader("Gateway") }
            item(key = "gateway") {
                ListItem(
                    headlineContent = { Text(pairing?.baseUrl?.substringAfter("://") ?: "Not paired") },
                    supportingContent = { Text(if (online) "Paired with a device token" else "You're offline") },
                )
            }
            item(key = "notifications") {
                ListItem(
                    modifier = Modifier.clickable { notifications = true },
                    headlineContent = { Text("Notifications") },
                    supportingContent = { Text("Push through your UnifiedPush distributor") },
                )
                HorizontalDivider(Modifier.padding(start = 16.dp))
            }
            item(key = "h:memory") { SectionHeader("Memory proposals", count = inbox.proposals.size) }
            if (inbox.proposals.isEmpty()) item(key = "memory:none") {
                Text(
                    "Nothing to review. When your assistant wants to remember something about you, it waits here and under Work.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                )
            }
            items(inbox.proposals, key = { "p:" + it.id }) { proposal ->
                ProposalCard(
                    proposal,
                    source = sources[proposal.sessionId],
                    busy = "proposal:${proposal.id}" in busy,
                    modifier = Modifier.animateItem(),
                    onApprove = { viewModel.approveProposal(proposal) },
                    onReject = { viewModel.rejectProposal(proposal) },
                )
            }
            item(key = "h:phone") { SectionHeader("This phone") }
            item(key = "unpair") {
                ListItem(
                    modifier = Modifier.clickable { unpairing = true },
                    headlineContent = { Text("Unpair this phone") },
                    colors = ListItemDefaults.colors(headlineColor = MaterialTheme.colorScheme.error),
                )
            }
        }
    }
}
