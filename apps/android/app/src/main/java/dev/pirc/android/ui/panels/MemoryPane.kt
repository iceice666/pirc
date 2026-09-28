package dev.pirc.android.ui.panels

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.pirc.android.Loadable
import dev.pirc.android.PanelsViewModel
import dev.pirc.android.core.Meter
import dev.pirc.android.core.Observation
import java.text.NumberFormat
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

private val UNTIL = DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withZone(ZoneId.systemDefault())

private fun tokens(value: Number) = NumberFormat.getIntegerInstance().format(value.toLong())

/** Observational memory: how close each stage is to running, and what it holds. */
@Composable
fun MemoryPane(viewModel: PanelsViewModel) {
    val panel by viewModel.panel.collectAsStateWithLifecycle()
    var filter by rememberSaveable { mutableStateOf("active") }

    PullToRefreshBox(isRefreshing = viewModel.refreshing.collectAsStateWithLifecycle().value, onRefresh = viewModel::pullRefresh, modifier = Modifier.fillMaxSize()) {
        when (val current = panel) {
            Loadable.Loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            is Loadable.Failed -> Text(current.message, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(24.dp))
            is Loadable.Ready -> {
                val memory = current.value.memory
                val runtime = current.value.memoryRuntime
                if (memory == null || !memory.enabled) {
                    Text("Observational memory is off for this session.", modifier = Modifier.padding(24.dp))
                    return@PullToRefreshBox
                }
                val observations = memory.observations.filter {
                    when (filter) {
                        "active" -> !it.dropped
                        "dropped" -> it.dropped
                        else -> true
                    }
                }.asReversed()
                LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
                    item {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                                runtime?.phase?.let { Chip("Working: $it", MaterialTheme.colorScheme.tertiaryContainer) }
                                if (runtime?.autoCompacting == true) Chip("Compacting", MaterialTheme.colorScheme.tertiaryContainer)
                                if (memory.passive) Chip("Passive")
                            }
                            memory.thresholds?.let { t ->
                                MeterRow("Next observation", t.observation)
                                MeterRow("Next reflection", t.reflection)
                                MeterRow("Compaction", t.compaction)
                                MeterRow("Visible pool", t.visiblePool)
                                MeterRow("Active pool", t.activePool)
                            }
                            val counts = memory.counts
                            Text(
                                "${counts.active} active of ${counts.observations} observations · ${counts.dropped} dropped · " +
                                    "${counts.reflections} reflections · ${counts.compactions} compactions",
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            runtime?.lastErrors?.forEach { (phase, message) ->
                                Text("$phase: $message", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                            }
                            // A limit that has passed no longer applies (the panel refreshes often enough).
                            val now = System.currentTimeMillis()
                            runtime?.rateLimited?.filter { it.until > now }?.forEach {
                                Text("${it.model} is rate limited until ${UNTIL.format(Instant.ofEpochMilli(it.until))}", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                            }
                        }
                    }
                    item { SectionTitle("Reflections") }
                    if (memory.reflections.isEmpty()) item { Text("None yet.", modifier = Modifier.padding(horizontal = 16.dp)) }
                    items(memory.reflections.asReversed(), key = { "r:" + it.id }) { reflection ->
                        MemoryCard(reflection.content, "${tokens(reflection.tokenCount)} tokens" + if (!reflection.visible) " · hidden" else "", null)
                    }
                    item {
                        Column(Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp)) {
                            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                                listOf("active" to "Active", "all" to "All", "dropped" to "Dropped").forEachIndexed { index, (key, label) ->
                                    SegmentedButton(selected = filter == key, onClick = { filter = key }, shape = SegmentedButtonDefaults.itemShape(index, 3)) { Text(label) }
                                }
                            }
                        }
                    }
                    if (observations.isEmpty()) item { Text("No observations.", modifier = Modifier.padding(16.dp)) }
                    items(observations, key = { "o:" + it.id }) { observation ->
                        MemoryCard(
                            observation.content,
                            listOfNotNull(observation.timestamp.ifEmpty { null }, "${tokens(observation.tokenCount)} tokens", if (observation.dropped) "dropped" else null)
                                .joinToString(" · "),
                            relevanceColor(observation),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun MeterRow(label: String, meter: Meter) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row {
            Text(label, style = MaterialTheme.typography.labelLarge, modifier = Modifier.weight(1f))
            Text("${tokens(meter.value)} / ${tokens(meter.max)}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        LinearProgressIndicator(progress = { meter.fraction }, modifier = Modifier.fillMaxWidth())
    }
}

@Composable
private fun relevanceColor(observation: Observation): Color = when (observation.relevance) {
    "critical" -> MaterialTheme.colorScheme.error
    "high" -> MaterialTheme.colorScheme.tertiary
    "medium" -> MaterialTheme.colorScheme.primary
    else -> MaterialTheme.colorScheme.outline
}

@Composable
private fun MemoryCard(content: String, meta: String, accent: Color?) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        shape = MaterialTheme.shapes.medium,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
    ) {
        Row(Modifier.height(IntrinsicSize.Min)) {
            if (accent != null) Box(
                Modifier.padding(start = 10.dp, top = 12.dp, bottom = 12.dp).width(3.dp).fillMaxHeight().background(accent, MaterialTheme.shapes.extraSmall),
            )
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                SelectionContainer { Text(content, style = MaterialTheme.typography.bodyMedium) }
                Text(meta, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}
