import 'package:flutter/foundation.dart';
import 'package:xterm/xterm.dart';

/// One-shot mobile modifiers affect user input, never PTY replies or replay.
class NativeTerminalInput extends Terminal {
  NativeTerminalInput({
    required super.onOutput,
    required super.onResize,
    required this.onModifiersChanged,
  }) : super(maxLines: 5000);
  final VoidCallback onModifiersChanged;
  bool _control = false, _alt = false;
  bool get controlArmed => _control;
  bool get altArmed => _alt;
  void toggleControl() {
    _control = !_control;
    onModifiersChanged();
  }

  void toggleAlt() {
    _alt = !_alt;
    onModifiersChanged();
  }

  void clearModifiers({bool notify = true}) {
    if (!_control && !_alt) return;
    _control = _alt = false;
    if (notify) onModifiersChanged();
  }

  @override
  bool keyInput(
    TerminalKey key, {
    bool shift = false,
    bool alt = false,
    bool ctrl = false,
  }) {
    final letter =
        key.index >= TerminalKey.keyA.index &&
        key.index <= TerminalKey.keyZ.index;
    if (letter && (_alt || _control)) {
      if ((_alt || alt) && (_control || ctrl)) {
        super.textInput(
          '\x1b${String.fromCharCode(key.index - TerminalKey.keyA.index + 1)}',
        );
        clearModifiers();
        return true;
      }
      // Let the host's committed character retain its case. xterm's Alt key
      // table uses the enum's uppercase name for printable letter keys.
      if (_alt && !ctrl && !_control) return false;
    }
    final handled = super.keyInput(
      key,
      shift: shift,
      alt: alt || _alt,
      ctrl: ctrl || _control,
    );
    if (handled) clearModifiers();
    return handled;
  }

  @override
  bool charInput(int charCode, {bool alt = false, bool ctrl = false}) {
    if (_control || _alt) {
      textInput(String.fromCharCode(charCode));
      return true;
    }
    final handled = super.charInput(
      charCode,
      alt: alt || _alt,
      ctrl: ctrl || _control,
    );
    if (handled) clearModifiers();
    return handled;
  }

  @override
  void textInput(String text) {
    if (text.isEmpty) return;
    if (!_control && !_alt) {
      super.textInput(text);
      return;
    }
    final runes = text.runes.toList();
    var first = runes.first;
    if (_control) {
      if (first >= 0x40 && first <= 0x5f || first >= 0x61 && first <= 0x7a) {
        first &= 0x1f;
      } else {
        first =
            const {
              0x20: 0,
              0x60: 0,
              0x3f: 0x7f,
              0x32: 0,
              0x33: 0x1b,
              0x34: 0x1c,
              0x35: 0x1d,
              0x36: 0x1e,
              0x37: 0x1f,
              0x38: 0x7f,
            }[first] ??
            first;
      }
    }
    final result =
        (_alt ? '\x1b' : '') + String.fromCharCodes([first, ...runes.skip(1)]);
    clearModifiers();
    super.textInput(result);
  }

  @override
  void paste(String text) {
    // Clipboard contents retain bracketed-paste semantics and literal bytes.
    clearModifiers();
    super.paste(text);
  }
}
