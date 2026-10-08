package dev.pirc.android.ui

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.pirc.android.core.ApiException
import dev.pirc.android.core.PircApi
import dev.pirc.android.push.PushRegistration
import dev.pirc.android.push.PushStatus
import kotlinx.coroutines.launch
import org.unifiedpush.android.connector.UnifiedPush
import java.io.IOException

/**
 * Push notifications on this phone (docs/history/cron.md, phase 4), through the
 * user's UnifiedPush distributor: no Google services.
 */
@Composable
fun NotificationsDialog(api: PircApi?, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val status by PushRegistration.status.collectAsStateWithLifecycle()
    var message by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val distributors = remember { PushRegistration.distributors(context) }

    fun run(action: suspend () -> Unit) {
        busy = true
        message = null
        scope.launch {
            try {
                action()
            } catch (error: IOException) {
                message = (error as? ApiException)?.message ?: "Could not reach the gateway."
            } finally {
                busy = false
            }
        }
    }

    fun register() {
        val activity = context as? Activity ?: return
        val api = api ?: return
        // The user's default distributor, or the system's picker when there are several.
        UnifiedPush.tryUseCurrentOrDefaultDistributor(activity) { chosen ->
            if (chosen) run { PushRegistration.enable(context, api) }
            else message = "No distributor was chosen."
        }
    }

    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) register() else message = "Notifications are not allowed for pirc in the system settings."
    }

    fun turnOn() {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) permission.launch(Manifest.permission.POST_NOTIFICATIONS)
        else register()
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Notifications") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(
                    "Scheduled runs, sessions waiting for your answer, finished delegations and memory changes to approve. " +
                        "They come through a UnifiedPush distributor such as ntfy.",
                )
                Text(
                    when (val now = status) {
                        PushStatus.Off -> if (distributors.isEmpty())
                            "No UnifiedPush distributor is installed. Install one (ntfy, for example), then come back."
                        else "This phone does not get notifications."
                        PushStatus.Connecting -> "Waiting for the distributor…"
                        is PushStatus.On -> "This phone gets notifications" + (now.distributor?.let { " through $it." } ?: ".")
                        is PushStatus.Failed -> now.reason
                    },
                    style = MaterialTheme.typography.bodyMedium,
                    color = if (status is PushStatus.Failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
                )
                message?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = {
            when (status) {
                is PushStatus.On -> TextButton(onClick = {
                    run {
                        val delivered = api?.testPush() ?: 0
                        message = "Sent a test to $delivered place${if (delivered == 1) "" else "s"}."
                    }
                }, enabled = !busy && api != null) { Text("Send a test") }
                else -> TextButton(
                    onClick = ::turnOn,
                    enabled = !busy && api != null && distributors.isNotEmpty(),
                ) { Text(if (status is PushStatus.Failed) "Try again" else "Turn on") }
            }
        },
        dismissButton = {
            if (status != PushStatus.Off) TextButton(onClick = { run { PushRegistration.disable(context, api) } }, enabled = !busy) {
                Text("Turn off")
            } else TextButton(onClick = onDismiss) { Text("Close") }
        },
    )
}
