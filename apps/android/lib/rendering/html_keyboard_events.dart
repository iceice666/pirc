import '../l10n/app_i18n.dart';
import 'package:flutter/services.dart';

/// Browser-shaped metadata for a real Flutter hardware key event. Software
/// keyboard edits arrive through TextEditingValue rather than fabricated keys.
Map<String, dynamic> nativeHtmlKeyboardEventData(
  KeyEvent event, {
  bool isComposing = false,
}) {
  final logical = event.logicalKey;
  final physical = event.physicalKey;
  final keyboard = HardwareKeyboard.instance;
  final named = <LogicalKeyboardKey, String>{
    LogicalKeyboardKey.enter: tr("Enter"),
    LogicalKeyboardKey.numpadEnter: tr("Enter"),
    LogicalKeyboardKey.escape: tr("Escape"),
    LogicalKeyboardKey.tab: tr("Tab"),
    LogicalKeyboardKey.backspace: tr("Backspace"),
    LogicalKeyboardKey.delete: tr("Delete"),
    LogicalKeyboardKey.arrowUp: 'ArrowUp',
    LogicalKeyboardKey.arrowDown: 'ArrowDown',
    LogicalKeyboardKey.arrowLeft: 'ArrowLeft',
    LogicalKeyboardKey.arrowRight: 'ArrowRight',
    LogicalKeyboardKey.home: tr("Home"),
    LogicalKeyboardKey.end: tr("End"),
    LogicalKeyboardKey.pageUp: 'PageUp',
    LogicalKeyboardKey.pageDown: 'PageDown',
    LogicalKeyboardKey.insert: tr("Insert"),
    LogicalKeyboardKey.space: ' ',
    LogicalKeyboardKey.shiftLeft: tr("Shift"),
    LogicalKeyboardKey.shiftRight: tr("Shift"),
    LogicalKeyboardKey.controlLeft: tr("Control"),
    LogicalKeyboardKey.controlRight: tr("Control"),
    LogicalKeyboardKey.altLeft: tr("Alt"),
    LogicalKeyboardKey.altRight: tr("Alt"),
    LogicalKeyboardKey.metaLeft: tr("Meta"),
    LogicalKeyboardKey.metaRight: tr("Meta"),
    LogicalKeyboardKey.capsLock: 'CapsLock',
  };
  final label = logical.keyLabel;
  final fallback = label.length == 1 && !keyboard.isShiftPressed
      ? label.toLowerCase()
      : label;
  final key = named[logical] ?? event.character ?? fallback;
  final usage = physical.usbHidUsage & 0xffff;
  String code;
  if (usage >= 4 && usage <= 29) {
    code = "Key${String.fromCharCode(65 + usage - 4)}";
  } else if (usage >= 30 && usage <= 39) {
    code = "Digit${(usage - 29) % 10}";
  } else {
    code =
        <int, String>{
          40: tr("Enter"),
          41: tr("Escape"),
          42: tr("Backspace"),
          43: tr("Tab"),
          44: tr("Space"),
          45: tr("Minus"),
          46: tr("Equal"),
          47: 'BracketLeft',
          48: 'BracketRight',
          49: tr("Backslash"),
          51: tr("Semicolon"),
          52: tr("Quote"),
          53: tr("Backquote"),
          54: tr("Comma"),
          55: tr("Period"),
          56: tr("Slash"),
          57: 'CapsLock',
          73: tr("Insert"),
          74: tr("Home"),
          75: 'PageUp',
          76: tr("Delete"),
          77: tr("End"),
          78: 'PageDown',
          79: 'ArrowRight',
          80: 'ArrowLeft',
          81: 'ArrowDown',
          82: 'ArrowUp',
          84: 'NumpadDivide',
          85: 'NumpadMultiply',
          86: 'NumpadSubtract',
          87: 'NumpadAdd',
          88: 'NumpadEnter',
          98: 'Numpad0',
          99: 'NumpadDecimal',
          224: 'ControlLeft',
          225: 'ShiftLeft',
          226: 'AltLeft',
          227: 'MetaLeft',
          228: 'ControlRight',
          229: 'ShiftRight',
          230: 'AltRight',
          231: 'MetaRight',
        }[usage] ??
        (usage >= 89 && usage <= 97
            ? "Numpad${usage - 88}"
            : usage >= 58 && usage <= 69
            ? "F${usage - 57}"
            : tr("Unidentified"));
  }
  final location = code.startsWith('Numpad')
      ? 3
      : usage >= 224 && usage <= 227
      ? 1
      : usage >= 228 && usage <= 231
      ? 2
      : 0;
  final legacy = <String, int>{
    'Enter': 13,
    'Escape': 27,
    'Tab': 9,
    'Backspace': 8,
    'Delete': 46,
    'ArrowLeft': 37,
    'ArrowUp': 38,
    'ArrowRight': 39,
    'ArrowDown': 40,
    'Home': 36,
    'End': 35,
    'PageUp': 33,
    'PageDown': 34,
    'Insert': 45,
    ' ': 32,
    'Shift': 16,
    'Control': 17,
    'Alt': 18,
    'Meta': 91,
    'CapsLock': 20,
  };
  final printable = key.length == 1 ? key.toUpperCase().codeUnitAt(0) : 0;
  final keyCode =
      legacy[key] ?? (printable >= 48 && printable <= 90 ? printable : 0);
  return {
    'key': key.isEmpty ? tr("Unidentified") : key,
    'code': code,
    'location': location,
    'repeat': event is KeyRepeatEvent,
    'ctrlKey': keyboard.isControlPressed,
    'shiftKey': keyboard.isShiftPressed,
    'altKey': keyboard.isAltPressed,
    'metaKey': keyboard.isMetaPressed,
    'isComposing': isComposing,
    'keyCode': keyCode,
    'charCode': 0,
    'which': keyCode,
  };
}
