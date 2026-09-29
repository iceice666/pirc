package dev.pirc.android.ui

import android.text.format.DateUtils
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.pirc.android.AppViewModel
import dev.pirc.android.core.Connectivity
import dev.pirc.android.core.MemoryProposal
import dev.pirc.android.core.MissedRun
import dev.pirc.android.core.Session
import dev.pirc.android.core.describe
import dev.pirc.android.core.formatWall

internal fun relativeTime(at: Long): CharSequence =
    DateUtils.getRelativeTimeSpanString(at, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS)

/**
 * One session in a list. A schedule's run has a clock and the schedule's title,
 * a delegated task an arrow; with [showLease], a lock marks the session that
 * holds its workspace's write lease (and only that one).
 */
@Composable
internal fun SessionRow(
    session: Session,
    modifier: Modifier = Modifier,
    showLease: Boolean = true,
    indent: Boolean = false,
    trailing: (@Composable () -> Unit)? = null,
    onLongClick: () -> Unit,
    onClick: () -> Unit,
) {
    val haptics = LocalHapticFeedback.current
    val origin = session.origin
    Column(modifier) {
        ListItem(
            modifier = Modifier
                .combinedClickable(
                    onClick = onClick,
                    onLongClick = {
                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                        onLongClick()
                    },
                    onLongClickLabel = "Session actions",
                )
                .padding(start = if (indent) 16.dp else 0.dp),
            leadingContent = when {
                origin?.schedule == true -> ({ Icon(PircIcons.Clock, contentDescription = "Scheduled run", modifier = Modifier.size(20.dp)) })
                origin?.delegation == true -> ({ Icon(PircIcons.Forward, contentDescription = "Delegated task", modifier = Modifier.size(20.dp)) })
                else -> null
            },
            headlineContent = { Text(session.name, maxLines = 2, overflow = TextOverflow.Ellipsis) },
            supportingContent = {
                Text(
                    buildString {
                        if (session.pinned) append("Pinned · ")
                        if (origin != null && origin.title.isNotEmpty() && origin.title != session.name) append(origin.title).append(" · ")
                        append(relativeTime(session.updatedAt))
                    },
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            },
            trailingContent = {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (showLease && session.writeLease)
                        Icon(PircIcons.Lock, contentDescription = "Holds the write lease", tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
                    status(session)?.let { StatusLabel(it) }
                    trailing?.invoke()
                }
            },
        )
        HorizontalDivider(Modifier.padding(start = 16.dp))
    }
}

internal enum class Tone { Neutral, Waiting, Error }

internal data class Status(val label: String, val tone: Tone)

internal fun status(session: Session): Status? = when (session.runStatus) {
    "queued", "running" -> Status("Running", Tone.Neutral)
    "stopping" -> Status("Stopping", Tone.Neutral)
    // Waiting for the user is not a failure (the web shows it amber, not red).
    "waiting_input" -> Status("Needs input", Tone.Waiting)
    "failed" -> Status("Failed", Tone.Error)
    else -> if (session.runnerState == "failed") Status("Offline", Tone.Error) else null
}

@Composable
internal fun StatusLabel(status: Status) {
    val colors = MaterialTheme.colorScheme
    Surface(
        shape = MaterialTheme.shapes.small,
        color = when (status.tone) {
            Tone.Neutral -> colors.secondaryContainer
            Tone.Waiting -> colors.tertiaryContainer
            Tone.Error -> colors.errorContainer
        },
        contentColor = when (status.tone) {
            Tone.Neutral -> colors.onSecondaryContainer
            Tone.Waiting -> colors.onTertiaryContainer
            Tone.Error -> colors.onErrorContainer
        },
    ) {
        Text(status.label, style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp))
    }
}

@Composable
internal fun SectionHeader(title: String, modifier: Modifier = Modifier, count: Int? = null) {
    Surface(color = MaterialTheme.colorScheme.surface, modifier = modifier.fillMaxWidth()) {
        Text(
            if (count != null && count > 0) "$title · $count" else title,
            style = MaterialTheme.typography.titleSmall,
            color = MaterialTheme.colorScheme.primary,
            modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 6.dp),
        )
    }
}

/** The screen's title and the gateway it talks to. */
@Composable
internal fun HomeTitle(title: String, viewModel: AppViewModel) {
    val pairing by viewModel.pairing.collectAsStateWithLifecycle()
    val online by Connectivity.online.collectAsStateWithLifecycle()
    Column {
        Text(title)
        pairing?.let {
            Text(
                it.baseUrl.substringAfter("://") + if (online) "" else " · Offline",
                style = MaterialTheme.typography.labelMedium,
                color = if (online) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error,
            )
        }
    }
}

/** A card of Needs you: what waits, and its actions inline. */
@Composable
private fun InboxCard(modifier: Modifier, icon: @Composable (() -> Unit)?, title: String, detail: String?, actions: @Composable () -> Unit) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        shape = MaterialTheme.shapes.medium,
        modifier = modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
    ) {
        Column(Modifier.padding(start = 14.dp, top = 12.dp, end = 8.dp, bottom = 4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                icon?.invoke()
                Text(title, style = MaterialTheme.typography.titleSmall, maxLines = 3, overflow = TextOverflow.Ellipsis)
            }
            detail?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 3, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp, Alignment.End)) { actions() }
        }
    }
}

@Composable
internal fun WaitingCard(session: Session, modifier: Modifier = Modifier, onReply: () -> Unit) = InboxCard(
    modifier,
    icon = { Icon(PircIcons.Chat, contentDescription = null, modifier = Modifier.size(18.dp)) },
    title = session.name,
    detail = listOfNotNull("Waiting for your answer", session.origin?.title?.takeIf { it.isNotEmpty() && it != session.name }, relativeTime(session.updatedAt).toString()).joinToString(" · "),
) { OutlinedButton(onClick = onReply) { Text("Reply") } }

@Composable
internal fun MissedRunCard(missed: MissedRun, busy: Boolean, modifier: Modifier = Modifier, onAllow: () -> Unit, onDismiss: () -> Unit) = InboxCard(
    modifier,
    icon = { Icon(PircIcons.Clock, contentDescription = null, modifier = Modifier.size(18.dp)) },
    title = missed.schedule.title,
    detail = listOfNotNull("Missed ${formatWall(missed.run.dueAt, missed.schedule.timezone)}", missed.run.result).joinToString(" · "),
) {
    TextButton(onClick = onDismiss, enabled = !busy) { Text("Dismiss") }
    OutlinedButton(onClick = onAllow, enabled = !busy) { Text("Allow & run") }
}

@Composable
internal fun ProposalCard(proposal: MemoryProposal, source: String?, busy: Boolean, modifier: Modifier = Modifier, onApprove: () -> Unit, onReject: () -> Unit) = InboxCard(
    modifier,
    icon = null,
    title = proposal.describe(),
    detail = listOfNotNull(
        "Memory proposal",
        proposal.quote.takeIf { it.isNotBlank() }?.let { "“$it”" },
        source?.let { "from $it" },
    ).joinToString(" · "),
) {
    TextButton(onClick = onReject, enabled = !busy) { Text("Reject") }
    OutlinedButton(onClick = onApprove, enabled = !busy) { Text("Approve") }
}
