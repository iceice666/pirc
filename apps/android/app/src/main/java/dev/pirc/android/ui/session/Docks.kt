package dev.pirc.android.ui.session

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.pirc.android.Docks
import dev.pirc.android.core.GoalView
import dev.pirc.android.core.TodoItem
import dev.pirc.android.core.TodoList

private val Ongoing = Color(0xFF3B82F6)
private val Done = Color(0xFF3FA66B)

/**
 * The goal and the agent's task list, docked on top of the composer (as on
 * the web). Collapsed, one line each; tap to expand.
 */
@Composable
fun DockStack(docks: Docks, canAct: Boolean, onGoal: (String) -> Unit) {
    if (docks.goal == null && docks.todo == null) return
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        shape = MaterialTheme.shapes.large,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.animateContentSize()) {
            docks.goal?.let { GoalDock(it, canAct, onGoal) }
            if (docks.goal != null && docks.todo != null) HorizontalDivider(Modifier.padding(horizontal = 12.dp))
            docks.todo?.let { TodoDock(it) }
        }
    }
}

@Composable
private fun DockHeader(
    expanded: Boolean,
    label: String,
    onToggle: () -> Unit,
    lead: @Composable () -> Unit,
    title: String,
    active: Boolean,
    trailing: @Composable () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClickLabel = if (expanded) "Collapse $label" else "Expand $label", onClick = onToggle)
            .heightIn(min = 44.dp)
            .padding(start = 12.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(Modifier.width(16.dp), contentAlignment = Alignment.Center) { lead() }
        Text(
            title,
            style = MaterialTheme.typography.bodyMedium,
            color = if (active) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        trailing()
    }
}

@Composable
private fun Dot(color: Color, description: String? = null) {
    Box(
        Modifier
            .size(8.dp)
            .clip(CircleShape)
            .background(color)
            .then(if (description != null) Modifier.semantics { contentDescription = description } else Modifier),
    )
}

@Composable
private fun GoalDock(goal: GoalView, canAct: Boolean, onAction: (String) -> Unit) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    val colors = MaterialTheme.colorScheme
    val phaseColor = when {
        goal.running -> Ongoing
        goal.phase == "complete" -> Done
        goal.phase == "blocked" -> colors.error
        else -> colors.outline
    }
    Column {
        DockHeader(
            expanded = expanded,
            label = "goal",
            onToggle = { expanded = !expanded },
            lead = { Dot(phaseColor) },
            title = goal.objective.ifEmpty { "Goal" },
            active = goal.running,
            trailing = {
                Text(goal.phaseLabel, style = MaterialTheme.typography.labelMedium, color = phaseColor, maxLines = 1)
                Text(
                    goal.rounds.toString() + (goal.maxRounds?.let { "/$it" } ?: ""),
                    style = MaterialTheme.typography.labelMedium,
                    color = colors.onSurfaceVariant,
                    modifier = Modifier.semantics { contentDescription = "Continuation rounds" },
                )
                when {
                    goal.running -> TextButton(onClick = { onAction("pause") }, enabled = canAct) { Text("Pause") }
                    goal.canResume -> TextButton(onClick = { onAction("resume") }, enabled = canAct) { Text("Resume") }
                    else -> Box(Modifier.width(8.dp))
                }
            },
        )
        AnimatedVisibility(visible = expanded) {
            Column(Modifier.padding(start = 36.dp, end = 12.dp, bottom = 10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(goal.objective, style = MaterialTheme.typography.bodyMedium)
                goal.reason?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant) }
            }
        }
    }
}

@Composable
private fun TodoDock(list: TodoList) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    val colors = MaterialTheme.colorScheme
    val working = list.active.isNotEmpty()
    Column {
        DockHeader(
            expanded = expanded,
            label = "tasks",
            onToggle = { expanded = !expanded },
            lead = { Dot(if (working) Ongoing else if (list.done == list.total) Done else colors.outline) },
            title = list.headline,
            active = working,
            trailing = {
                LinearProgressIndicator(
                    progress = { if (list.total > 0) list.done.toFloat() / list.total else 0f },
                    modifier = Modifier.width(36.dp),
                    drawStopIndicator = {},
                )
                Text(
                    "${list.done}/${list.total}",
                    style = MaterialTheme.typography.labelMedium,
                    color = colors.onSurfaceVariant,
                    modifier = Modifier
                        .padding(end = 12.dp)
                        .semantics { contentDescription = "${list.done} of ${list.total} completed" },
                )
            },
        )
        AnimatedVisibility(visible = expanded) {
            // Long lists scroll inside the dock so the composer stays in reach.
            Column(
                Modifier.heightIn(max = 240.dp).verticalScroll(rememberScrollState()).padding(start = 12.dp, end = 12.dp, bottom = 10.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                for (item in list.items) TodoRow(item)
            }
        }
    }
}

@Composable
private fun TodoRow(item: TodoItem) {
    val colors = MaterialTheme.colorScheme
    val (color, label) = when (item.status) {
        "completed" -> Done to "Completed"
        "in_progress" -> Ongoing to "In progress"
        else -> colors.outline to "Pending"
    }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier.semantics(mergeDescendants = true) { stateDescription = label },
    ) {
        Box(Modifier.width(16.dp), contentAlignment = Alignment.Center) { Dot(color) }
        Text(
            item.text,
            style = MaterialTheme.typography.bodyMedium,
            color = if (item.status == "completed") colors.onSurfaceVariant else colors.onSurface,
            textDecoration = if (item.status == "completed") TextDecoration.LineThrough else null,
            modifier = Modifier.weight(1f),
        )
        item.category?.let { Tag(it, colors.secondaryContainer, colors.onSecondaryContainer) }
        if (item.blocked) Tag("blocked", colors.errorContainer, colors.onErrorContainer)
    }
}

@Composable
private fun Tag(text: String, background: Color, content: Color) {
    Surface(color = background, contentColor = content, shape = MaterialTheme.shapes.small) {
        Text(text, style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp))
    }
}

/** Under the composer: extension widgets' headlines and statuses such as compaction warm-up. */
@Composable
fun StatusLine(lines: List<String>) {
    if (lines.isEmpty()) return
    Text(
        lines.joinToString(" · "),
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.padding(horizontal = 14.dp),
    )
}
