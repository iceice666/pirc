package dev.pirc.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.snapping.SnapPosition
import androidx.compose.foundation.gestures.snapping.rememberSnapFlingBehavior
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.min

/**
 * A scroll wheel like a date picker's: items roll past a highlighted middle
 * row, snap to it, and the one resting there is the selection. Tapping an item
 * rolls it into place. [selected] follows the caller; a change in items keeps
 * the wheel on the caller's selection.
 */
@Composable
fun <T> WheelPicker(
    items: List<T>,
    selected: Int,
    onSelect: (Int) -> Unit,
    label: (T) -> String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    rowHeight: Dp = 44.dp,
    visibleRows: Int = 5,
) {
    val side = visibleRows / 2
    val list = rememberLazyListState(initialFirstVisibleItemIndex = selected.coerceIn(0, (items.size - 1).coerceAtLeast(0)))
    val scope = rememberCoroutineScope()
    val haptics = LocalHapticFeedback.current
    val currentSelect by rememberUpdatedState(onSelect)
    val currentItems by rememberUpdatedState(items)
    val currentSelected by rememberUpdatedState(selected)

    /** The row nearest the middle, and how far (in rows) each visible row is from it. */
    val centered by remember {
        derivedStateOf {
            val info = list.layoutInfo
            val middle = (info.viewportStartOffset + info.viewportEndOffset) / 2
            info.visibleItemsInfo.minByOrNull { abs(it.offset + it.size / 2 - middle) }?.index ?: currentSelected
        }
    }

    // Report where the wheel rests; a tick as each row passes the middle.
    LaunchedEffect(list) {
        snapshotFlow { centered }.distinctUntilChanged().drop(1).collect { haptics.performHapticFeedback(HapticFeedbackType.SegmentFrequentTick) }
    }
    // Report the row the wheel rests on. Reading it once, as the scroll flag
    // flips, can catch a layout one frame behind and report the row left behind,
    // so keep watching while the wheel rests: the row that finally sits in the
    // middle is the selection.
    LaunchedEffect(list) {
        snapshotFlow { if (list.isScrollInProgress) null else centered }
            .distinctUntilChanged()
            .collect { index -> if (index != null && index in currentItems.indices) currentSelect(index) }
    }
    // Follow the caller: new items (e.g. another model's levels) or an outside
    // change. Never mid-gesture: that would fight the finger on the wheel.
    LaunchedEffect(items, selected) {
        if (selected in items.indices && selected != centered && !list.isScrollInProgress)
            list.scrollToItem(selected)
    }

    Box(modifier.height(rowHeight * visibleRows), contentAlignment = Alignment.Center) {
        Box(
            Modifier
                .fillMaxWidth()
                .height(rowHeight)
                .background(MaterialTheme.colorScheme.surfaceContainerHighest, MaterialTheme.shapes.medium),
        )
        LazyColumn(
            state = list,
            flingBehavior = rememberSnapFlingBehavior(list, SnapPosition.Center),
            contentPadding = PaddingValues(vertical = rowHeight * side),
            userScrollEnabled = enabled,
            modifier = Modifier.fillMaxWidth().height(rowHeight * visibleRows),
        ) {
            itemsIndexed(items) { index, item ->
                val text = label(item)
                Box(
                    Modifier
                        .fillMaxWidth()
                        .height(rowHeight)
                        .graphicsLayer {
                            // Rows curve away from the middle like a drum.
                            val info = list.layoutInfo
                            val middle = (info.viewportStartOffset + info.viewportEndOffset) / 2f
                            val row = info.visibleItemsInfo.firstOrNull { it.index == index }
                            val distance = row?.let { (it.offset + it.size / 2f - middle) / it.size } ?: side.toFloat()
                            val fraction = min(abs(distance) / (side + 0.5f), 1f)
                            alpha = if (enabled) 1f - 0.75f * fraction else 0.4f
                            scaleX = 1f - 0.12f * fraction
                            scaleY = scaleX
                            rotationX = -distance * 18f
                        }
                        .semantics {
                            this.selected = index == centered
                            contentDescription = text
                        }
                        .clickable(
                            enabled = enabled,
                            interactionSource = remember { MutableInteractionSource() },
                            indication = null,
                        ) { scope.launch { list.animateScrollToItem(index) } },
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text,
                        style = MaterialTheme.typography.titleMedium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.padding(horizontal = 12.dp),
                    )
                }
            }
        }
    }
}
