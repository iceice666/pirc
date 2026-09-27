package dev.pirc.android.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import dev.pirc.android.AppViewModel
import dev.pirc.android.PairState

@Composable
fun PairScreen(viewModel: AppViewModel) {
    val state by viewModel.pairState.collectAsStateWithLifecycle()
    val notice by viewModel.notice.collectAsStateWithLifecycle()
    val context = LocalContext.current
    var link by rememberSaveable { mutableStateOf("") }
    var scanError by rememberSaveable { mutableStateOf<String?>(null) }
    val verifying = state is PairState.Verifying

    fun scan() {
        scanError = null
        val options = GmsBarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
            .build()
        GmsBarcodeScanning.getClient(context, options).startScan()
            .addOnSuccessListener { barcode -> barcode.rawValue?.let(viewModel::pair) }
            .addOnFailureListener { scanError = "The scanner is unavailable. Paste the link instead." }
    }

    Surface(Modifier.fillMaxSize()) {
        Column(
            Modifier
                .safeDrawingPadding()
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Spacer(Modifier.height(32.dp))
            Text("pirc", style = MaterialTheme.typography.displaySmall)
            Text(
                "On a computer, open pirc → Settings → Devices → Phones, pair this phone, then scan the QR code.",
                style = MaterialTheme.typography.bodyLarge,
            )
            notice?.let {
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
            }
            Button(onClick = ::scan, enabled = !verifying, modifier = Modifier.fillMaxWidth().height(56.dp)) {
                Text("Scan QR code")
            }
            Text("Or paste the pairing link", style = MaterialTheme.typography.titleSmall)
            OutlinedTextField(
                value = link,
                onValueChange = { link = it },
                placeholder = { Text("pirc://pair?url=…") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                enabled = !verifying,
                minLines = 2,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedButton(
                onClick = { viewModel.pair(link) },
                enabled = !verifying && link.isNotBlank(),
                modifier = Modifier.fillMaxWidth().height(48.dp),
            ) { Text("Pair") }

            AnimatedVisibility(visible = verifying) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.size(12.dp))
                    Text("Checking ${(state as? PairState.Verifying)?.origin.orEmpty()}…")
                }
            }
            val error = (state as? PairState.Failed)?.message ?: scanError
            AnimatedVisibility(visible = error != null) {
                Text(error.orEmpty(), color = MaterialTheme.colorScheme.error)
            }
        }
    }
}
