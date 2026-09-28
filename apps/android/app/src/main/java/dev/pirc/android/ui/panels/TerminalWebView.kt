package dev.pirc.android.ui.panels

import android.annotation.SuppressLint
import android.content.Context
import android.text.InputType
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import android.view.ViewConfiguration
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager
import android.webkit.WebView
import kotlin.math.abs

/**
 * The terminal's WebView. It never takes focus: if it did, Chromium would
 * manage the keyboard for the page and close it again, since the page has no
 * text field of its own that it considers focused. Keyboard input goes to
 * [TerminalInputView] instead. A pinch changes the font size ([onScale] gets
 * the factor since the last step), like tmux clients; a tap calls [onTap].
 */
@SuppressLint("ViewConstructor")
class TerminalWebView(
    context: Context,
    private val onTap: () -> Unit,
    private val onScale: (Float) -> Unit,
) : WebView(context) {
    private val touchSlop = ViewConfiguration.get(context).scaledTouchSlop
    private var downX = 0f
    private var downY = 0f
    private var scaled = false

    private val scaler = ScaleGestureDetector(
        context,
        object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
            override fun onScaleBegin(detector: ScaleGestureDetector): Boolean {
                scaled = true
                return true
            }

            override fun onScale(detector: ScaleGestureDetector): Boolean {
                onScale(detector.scaleFactor)
                return true
            }
        },
    )

    init {
        isFocusable = false
        isFocusableInTouchMode = false
        descendantFocusability = FOCUS_BLOCK_DESCENDANTS
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
        scaler.onTouchEvent(event)
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                scaled = false
                downX = event.x
                downY = event.y
            }
            MotionEvent.ACTION_UP -> if (!scaled && abs(event.x - downX) < touchSlop && abs(event.y - downY) < touchSlop) onTap()
        }
        // While pinching, the page must not scroll or select underneath.
        if (scaled || event.pointerCount > 1) return true
        return super.onTouchEvent(event)
    }
}

/**
 * An invisible view that holds the keyboard for the terminal. The IME talks
 * to it directly (no autocorrect, suggestions or held-back composition, as in
 * Termux), and each committed character or key goes straight to [onInput] as
 * terminal bytes. Hardware keys arrive here too.
 */
@SuppressLint("ViewConstructor")
class TerminalInputView(context: Context, private val onInput: (String) -> Unit) : View(context) {
    init {
        isFocusable = true
        isFocusableInTouchMode = true
    }

    fun showKeyboard() {
        requestFocus()
        context.getSystemService(InputMethodManager::class.java)?.showSoftInput(this, InputMethodManager.SHOW_IMPLICIT)
    }

    override fun onCheckIsTextEditor() = true

    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection {
        outAttrs.inputType = InputType.TYPE_CLASS_TEXT or
            InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD or
            InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        outAttrs.imeOptions = EditorInfo.IME_FLAG_NO_EXTRACT_UI or EditorInfo.IME_FLAG_NO_FULLSCREEN or EditorInfo.IME_ACTION_NONE
        return TerminalInput()
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        // Back, volume and other keys without terminal bytes keep their usual meaning.
        val bytes = keyBytes(event) ?: return super.onKeyDown(keyCode, event)
        onInput(bytes)
        return true
    }

    /**
     * Committed text is sent as is. Composing text (a CJK input method's
     * candidate) is only sent once committed or finished, never piecemeal.
     */
    private inner class TerminalInput : BaseInputConnection(this, false) {
        private var composing = ""

        private fun send(text: CharSequence) {
            // Terminals take Enter as CR.
            if (text.isNotEmpty()) onInput(text.toString().replace('\n', '\r'))
        }

        override fun commitText(text: CharSequence, newCursorPosition: Int): Boolean {
            composing = ""
            send(text)
            return true
        }

        override fun setComposingText(text: CharSequence, newCursorPosition: Int): Boolean {
            composing = text.toString()
            return true
        }

        override fun finishComposingText(): Boolean {
            send(composing)
            composing = ""
            return true
        }

        override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
            if (composing.isNotEmpty()) {
                composing = composing.dropLast(beforeLength)
                return true
            }
            repeat(beforeLength.coerceIn(0, 64)) { onInput("\u007f") }
            return true
        }

        override fun sendKeyEvent(event: KeyEvent): Boolean {
            if (event.action != KeyEvent.ACTION_DOWN) return true
            keyBytes(event)?.let(onInput)
            return true
        }
    }

    companion object {
        /** A key event from the keyboard as the bytes an xterm-compatible terminal expects. */
        fun keyBytes(event: KeyEvent): String? = when (event.keyCode) {
            KeyEvent.KEYCODE_DEL -> "\u007f"
            KeyEvent.KEYCODE_FORWARD_DEL -> "\u001b[3~"
            KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> "\r"
            KeyEvent.KEYCODE_TAB -> "\t"
            KeyEvent.KEYCODE_ESCAPE -> "\u001b"
            KeyEvent.KEYCODE_DPAD_UP -> "\u001b[A"
            KeyEvent.KEYCODE_DPAD_DOWN -> "\u001b[B"
            KeyEvent.KEYCODE_DPAD_RIGHT -> "\u001b[C"
            KeyEvent.KEYCODE_DPAD_LEFT -> "\u001b[D"
            KeyEvent.KEYCODE_MOVE_HOME -> "\u001b[H"
            KeyEvent.KEYCODE_MOVE_END -> "\u001b[F"
            else -> event.unicodeChar.takeIf { it != 0 }?.let { code ->
                val text = String(Character.toChars(code))
                if (event.isCtrlPressed) dev.pirc.android.controlKey(text) else text
            }
        }
    }
}
