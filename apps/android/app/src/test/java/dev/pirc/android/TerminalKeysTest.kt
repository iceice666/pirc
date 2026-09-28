package dev.pirc.android

import android.view.KeyEvent
import dev.pirc.android.ui.panels.TerminalInputView
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TerminalKeysTest {
    @Test
    fun controlMapsLettersAndC0SymbolsOnly() {
        assertEquals("\u0003", controlKey("c"))
        assertEquals("\u0003", controlKey("C"))
        assertEquals("\u0000", controlKey("@"))
        assertEquals("\u001b", controlKey("["))
        assertEquals("\u001f", controlKey("_"))
        assertEquals("\u001c", controlKey("\\"))
        // Anything else is sent unchanged.
        for (text in listOf("1", " ", "é", "中", "ab", "")) assertEquals(text, controlKey(text))
    }

    private fun key(code: Int, char: Char? = null, ctrl: Boolean = false) = TerminalInputView.keyBytes(code, char?.code ?: 0, ctrl)

    @Test
    fun keysBecomeXtermBytes() {
        assertEquals("\u007f", key(KeyEvent.KEYCODE_DEL))
        assertEquals("\u001b[3~", key(KeyEvent.KEYCODE_FORWARD_DEL))
        assertEquals("\r", key(KeyEvent.KEYCODE_ENTER, '\n'))
        assertEquals("\r", key(KeyEvent.KEYCODE_NUMPAD_ENTER))
        assertEquals("\t", key(KeyEvent.KEYCODE_TAB, '\t'))
        assertEquals("\u001b", key(KeyEvent.KEYCODE_ESCAPE))
        assertEquals("\u001b[A", key(KeyEvent.KEYCODE_DPAD_UP))
        assertEquals("\u001b[B", key(KeyEvent.KEYCODE_DPAD_DOWN))
        assertEquals("\u001b[C", key(KeyEvent.KEYCODE_DPAD_RIGHT))
        assertEquals("\u001b[D", key(KeyEvent.KEYCODE_DPAD_LEFT))
        assertEquals("\u001b[H", key(KeyEvent.KEYCODE_MOVE_HOME))
        assertEquals("\u001b[F", key(KeyEvent.KEYCODE_MOVE_END))
    }

    @Test
    fun charactersAreTypedAndCtrlAppliesToThem() {
        assertEquals("a", key(KeyEvent.KEYCODE_A, 'a'))
        assertEquals("\u0001", key(KeyEvent.KEYCODE_A, 'a', ctrl = true))
        assertEquals("\u0004", key(KeyEvent.KEYCODE_D, 'd', ctrl = true))
        assertEquals("1", key(KeyEvent.KEYCODE_1, '1', ctrl = true))
        // Keys without a character (volume, back) keep their usual meaning.
        assertNull(key(KeyEvent.KEYCODE_VOLUME_UP))
        assertNull(key(KeyEvent.KEYCODE_BACK))
    }
}
