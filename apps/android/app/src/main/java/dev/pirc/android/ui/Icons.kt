package dev.pirc.android.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.unit.dp

/** The few line icons the app draws, on a 24-unit grid (tinted by `Icon`). */
object PircIcons {
    private fun stroke(name: String, block: androidx.compose.ui.graphics.vector.PathBuilder.() -> Unit) =
        ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f).path(
            stroke = SolidColor(Color.Black),
            strokeLineWidth = 2f,
            strokeLineCap = StrokeCap.Round,
            strokeLineJoin = StrokeJoin.Round,
            pathBuilder = block,
        ).build()

    val Plus = stroke("plus") {
        moveTo(12f, 5f); lineTo(12f, 19f)
        moveTo(5f, 12f); lineTo(19f, 12f)
    }

    val ArrowUp = stroke("arrow-up") {
        moveTo(12f, 19f); lineTo(12f, 5f)
        moveTo(6f, 11f); lineTo(12f, 5f); lineTo(18f, 11f)
    }

    /** A paper plane pointing right: deliver a queued message now. */
    val SendNow = stroke("send-now") {
        moveTo(4f, 4f); lineTo(21f, 12f); lineTo(4f, 20f); lineTo(7f, 12f); close()
        moveTo(7f, 12f); lineTo(14f, 12f)
    }

    val ArrowDown = stroke("arrow-down") {
        moveTo(12f, 5f); lineTo(12f, 19f)
        moveTo(6f, 13f); lineTo(12f, 19f); lineTo(18f, 13f)
    }

    val Check = stroke("check") {
        moveTo(5f, 12.5f); lineTo(10f, 17.5f); lineTo(19f, 7f)
    }

    val ChevronDown = stroke("chevron-down") {
        moveTo(7f, 10f); lineTo(12f, 15f); lineTo(17f, 10f)
    }

    val Close = stroke("close") {
        moveTo(7f, 7f); lineTo(17f, 17f)
        moveTo(17f, 7f); lineTo(7f, 17f)
    }

    val Back = stroke("back") {
        moveTo(19f, 12f); lineTo(5f, 12f)
        moveTo(11f, 6f); lineTo(5f, 12f); lineTo(11f, 18f)
    }

    val Folder = stroke("folder") {
        moveTo(3f, 7f); quadTo(3f, 5f, 5f, 5f); lineTo(9f, 5f); lineTo(11f, 7f); lineTo(19f, 7f)
        quadTo(21f, 7f, 21f, 9f); lineTo(21f, 17f); quadTo(21f, 19f, 19f, 19f); lineTo(5f, 19f)
        quadTo(3f, 19f, 3f, 17f); close()
    }

    val File = stroke("file") {
        moveTo(14f, 3f); lineTo(6f, 3f); quadTo(5f, 3f, 5f, 4f); lineTo(5f, 20f); quadTo(5f, 21f, 6f, 21f)
        lineTo(18f, 21f); quadTo(19f, 21f, 19f, 20f); lineTo(19f, 8f); close()
        moveTo(14f, 3f); lineTo(14f, 8f); lineTo(19f, 8f)
    }

    private fun androidx.compose.ui.graphics.vector.PathBuilder.circle(cx: Float, cy: Float, r: Float) {
        moveTo(cx - r, cy)
        arcTo(r, r, 0f, false, true, cx + r, cy)
        arcTo(r, r, 0f, false, true, cx - r, cy)
        close()
    }

    val ChevronRight = stroke("chevron-right") {
        moveTo(10f, 7f); lineTo(15f, 12f); lineTo(10f, 17f)
    }

    /** A session a schedule started. */
    val Clock = stroke("clock") {
        circle(12f, 12f, 8.5f)
        moveTo(12f, 7.5f); lineTo(12f, 12f); lineTo(15f, 14f)
    }

    /** A session delegated from an assistant chat. */
    val Forward = stroke("forward") {
        moveTo(14f, 5f); lineTo(20f, 11f); lineTo(14f, 17f)
        moveTo(20f, 11f); lineTo(10f, 11f); quadTo(4f, 11f, 4f, 17f); lineTo(4f, 19f)
    }

    /** The session's agent runs outside the node's OS sandbox. */
    val ShieldOff = stroke("shield-off") {
        moveTo(12f, 3f); lineTo(19f, 6f); lineTo(19f, 11f); quadTo(19f, 18f, 12f, 21f); quadTo(5f, 18f, 5f, 11f); lineTo(5f, 6f); close()
        moveTo(4f, 4f); lineTo(20f, 20f)
    }

    /** The session holds the write lease on its workspace. */
    val Lock = stroke("lock") {
        moveTo(6f, 11f); lineTo(18f, 11f); lineTo(18f, 20f); lineTo(6f, 20f); close()
        moveTo(8.5f, 11f); lineTo(8.5f, 8f); quadTo(8.5f, 4.5f, 12f, 4.5f); quadTo(15.5f, 4.5f, 15.5f, 8f); lineTo(15.5f, 11f)
    }

    val Chat = stroke("chat") {
        moveTo(5f, 5f); lineTo(19f, 5f); quadTo(21f, 5f, 21f, 7f); lineTo(21f, 15f); quadTo(21f, 17f, 19f, 17f)
        lineTo(10f, 17f); lineTo(6f, 20.5f); lineTo(6f, 17f); lineTo(5f, 17f); quadTo(3f, 17f, 3f, 15f)
        lineTo(3f, 7f); quadTo(3f, 5f, 5f, 5f); close()
    }

    val Work = stroke("work") {
        moveTo(4f, 8f); lineTo(20f, 8f); lineTo(20f, 19f); lineTo(4f, 19f); close()
        moveTo(9f, 8f); lineTo(9f, 5.5f); lineTo(15f, 5.5f); lineTo(15f, 8f)
        moveTo(4f, 13f); lineTo(20f, 13f)
    }

    val Calendar = stroke("calendar") {
        moveTo(4f, 6f); lineTo(20f, 6f); lineTo(20f, 20f); lineTo(4f, 20f); close()
        moveTo(4f, 10f); lineTo(20f, 10f)
        moveTo(8f, 3.5f); lineTo(8f, 7.5f)
        moveTo(16f, 3.5f); lineTo(16f, 7.5f)
    }

    /** Sliders: settings. */
    val Settings = stroke("settings") {
        moveTo(4f, 7f); lineTo(20f, 7f)
        moveTo(4f, 12f); lineTo(20f, 12f)
        moveTo(4f, 17f); lineTo(20f, 17f)
        circle(9f, 7f, 2f)
        circle(15f, 12f, 2f)
        circle(8f, 17f, 2f)
    }

    val Stop = ImageVector.Builder("stop", 24.dp, 24.dp, 24f, 24f).path(fill = SolidColor(Color.Black)) {
        moveTo(8f, 7f); lineTo(16f, 7f)
        quadTo(17f, 7f, 17f, 8f); lineTo(17f, 16f)
        quadTo(17f, 17f, 16f, 17f); lineTo(8f, 17f)
        quadTo(7f, 17f, 7f, 16f); lineTo(7f, 8f)
        quadTo(7f, 7f, 8f, 7f); close()
    }.build()
}
