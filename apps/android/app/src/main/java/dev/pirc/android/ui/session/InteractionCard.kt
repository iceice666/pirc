package dev.pirc.android.ui.session

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
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
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import dev.pirc.android.core.InteractionAnswer
import dev.pirc.android.core.timeline.Interaction
import kotlinx.coroutines.delay
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

/**
 * A question from the agent, answered in place. Answering needs the control
 * lease and a live stream ([canAnswer]); [hasControl] only picks the hint.
 * The gateway refuses answers after `expiresAt`, so the card locks then.
 */
@Composable
fun InteractionCard(
    interaction: Interaction,
    canAnswer: Boolean,
    busy: Boolean,
    onAnswer: (InteractionAnswer) -> Unit,
    modifier: Modifier = Modifier,
    hasControl: Boolean = canAnswer,
) {
    val expiresAt = interaction.expiresAt
    var expired by remember(interaction.id, expiresAt) {
        mutableStateOf(expiresAt != null && expiresAt <= System.currentTimeMillis())
    }
    LaunchedEffect(interaction.id, expiresAt) {
        if (expiresAt == null) return@LaunchedEffect
        delay((expiresAt - System.currentTimeMillis()).coerceAtLeast(0))
        expired = true
    }
    val enabled = canAnswer && !busy && !expired
    Surface(
        color = MaterialTheme.colorScheme.tertiaryContainer,
        contentColor = MaterialTheme.colorScheme.onTertiaryContainer,
        shape = MaterialTheme.shapes.large,
        modifier = modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(interaction.title, style = MaterialTheme.typography.titleMedium)
            interaction.description?.let { Text(it, style = MaterialTheme.typography.bodyLarge) }
            when (interaction.kind) {
                "select" -> Select(interaction, enabled, onAnswer)
                "confirm" -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { onAnswer(InteractionAnswer.Confirm(true)) }, enabled = enabled) { Text("Yes") }
                    OutlinedButton(onClick = { onAnswer(InteractionAnswer.Confirm(false)) }, enabled = enabled) { Text("No") }
                }
                else -> Input(interaction, enabled, onAnswer)
            }
            if (interaction.kind != "confirm") TextButton(onClick = { onAnswer(InteractionAnswer.Cancel) }, enabled = enabled) {
                Text("Dismiss without answering")
            }
            if (expiresAt != null) Text(
                "${if (expired) "Expired" else "Expires"} ${EXPIRY_TIME.format(Instant.ofEpochMilli(expiresAt))}",
                style = MaterialTheme.typography.bodySmall,
            )
            if (!hasControl && !expired) Text("Take control to answer.", style = MaterialTheme.typography.bodySmall)
        }
    }
}

private val EXPIRY_TIME = DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withZone(ZoneId.systemDefault())

@Composable
private fun Select(interaction: Interaction, enabled: Boolean, onAnswer: (InteractionAnswer) -> Unit) {
    var chosen by rememberSaveable(interaction.id) { mutableStateOf(listOf<String>()) }
    Column {
        for (option in interaction.options) {
            val selected = option.value in chosen
            val toggle = if (interaction.multiple)
                Modifier.toggleable(selected, enabled, Role.Checkbox) { chosen = if (it) chosen + option.value else chosen - option.value }
            else Modifier.selectable(selected, enabled, Role.RadioButton) { chosen = listOf(option.value) }
            Row(
                toggle.fillMaxWidth().heightIn(min = 48.dp).padding(vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (interaction.multiple) Checkbox(checked = selected, onCheckedChange = null, enabled = enabled)
                else RadioButton(selected = selected, onClick = null, enabled = enabled)
                Column(Modifier.padding(start = 12.dp)) {
                    Text(option.label, style = MaterialTheme.typography.bodyLarge)
                    option.description?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
                }
            }
        }
        Button(
            onClick = {
                onAnswer(if (interaction.multiple) InteractionAnswer.Choices(chosen) else InteractionAnswer.Text(chosen.first()))
            },
            enabled = enabled && chosen.isNotEmpty(),
            modifier = Modifier.padding(top = 8.dp),
        ) { Text("Answer") }
    }
}

@Composable
private fun Input(interaction: Interaction, enabled: Boolean, onAnswer: (InteractionAnswer) -> Unit) {
    var text by rememberSaveable(interaction.id) { mutableStateOf(interaction.initialValue.orEmpty()) }
    val editor = interaction.kind == "editor"
    OutlinedTextField(
        value = text,
        onValueChange = { text = it },
        placeholder = interaction.placeholder?.let { { Text(it) } },
        enabled = enabled,
        minLines = if (editor) 4 else 1,
        maxLines = if (editor) 12 else 4,
        textStyle = if (editor) MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace) else MaterialTheme.typography.bodyLarge,
        modifier = Modifier.fillMaxWidth(),
    )
    Button(onClick = { onAnswer(InteractionAnswer.Text(text)) }, enabled = enabled) { Text("Answer") }
}
