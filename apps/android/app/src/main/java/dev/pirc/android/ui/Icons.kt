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

    val ChevronDown = stroke("chevron-down") {
        moveTo(7f, 10f); lineTo(12f, 15f); lineTo(17f, 10f)
    }

    val Close = stroke("close") {
        moveTo(7f, 7f); lineTo(17f, 17f)
        moveTo(17f, 7f); lineTo(7f, 17f)
    }

    val Stop = ImageVector.Builder("stop", 24.dp, 24.dp, 24f, 24f).path(fill = SolidColor(Color.Black)) {
        moveTo(8f, 7f); lineTo(16f, 7f)
        quadTo(17f, 7f, 17f, 8f); lineTo(17f, 16f)
        quadTo(17f, 17f, 16f, 17f); lineTo(8f, 17f)
        quadTo(7f, 17f, 7f, 16f); lineTo(7f, 8f)
        quadTo(7f, 7f, 8f, 7f); close()
    }.build()
}
