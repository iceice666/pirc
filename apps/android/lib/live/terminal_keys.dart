import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:xterm/xterm.dart';
import 'common.dart';
import 'web_controls.dart';
import 'terminal_input.dart';

class NativeTerminalKeys extends StatelessWidget {
  const NativeTerminalKeys({
    super.key,
    required this.terminal,
    required this.enabled,
    required this.focusNode,
    this.compact = false,
  });
  final bool compact;
  final NativeTerminalInput terminal;
  final bool enabled;
  final FocusNode focusNode;
  static const rows = [
    [
      ('ESC', 'Escape', TerminalKey.escape, null),
      ('/', 'Slash', TerminalKey.slash, '/'),
      ('-', 'Hyphen', TerminalKey.minus, '-'),
      ('HOME', 'Home', TerminalKey.home, null),
      ('↑', 'Arrow up', TerminalKey.arrowUp, null),
      ('END', 'End', TerminalKey.end, null),
      ('PGUP', 'Page up', TerminalKey.pageUp, null),
    ],
    [
      ('TAB', 'Tab', TerminalKey.tab, null),
      ('CTRL', 'Control', null, null),
      ('ALT', 'Alt', null, null),
      ('←', 'Arrow left', TerminalKey.arrowLeft, null),
      ('↓', 'Arrow down', TerminalKey.arrowDown, null),
      ('→', 'Arrow right', TerminalKey.arrowRight, null),
      ('PGDN', 'Page down', TerminalKey.pageDown, null),
    ],
  ];
  @override
  Widget build(BuildContext context) {
    final p = palette(context),
        scale = MediaQuery.textScalerOf(context).scale(12) / 12;
    final keyRows = compact ? [rows.expand((row) => row).toList()] : rows;
    return Container(
      key: const ValueKey('terminal-extra-keys'),
      decoration: BoxDecoration(
        border: Border(top: BorderSide(color: p['web.line'])),
      ),
      child: ExcludeFocus(
        child: LayoutBuilder(
          builder: (context, bounds) => SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: SizedBox(
              width: math.max(bounds.maxWidth, (compact ? 14 : 7) * 44 * scale),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  for (final row in keyRows)
                    Row(
                      children: [
                        for (final (label, description, key, text) in row)
                          Expanded(
                            child: Semantics(
                              toggled: label == 'CTRL'
                                  ? terminal.controlArmed
                                  : label == 'ALT'
                                  ? terminal.altArmed
                                  : null,
                              child: Tooltip(
                                message: description,
                                excludeFromSemantics: true,
                                child: TextButton(
                                  key: ValueKey('terminal-key-$label'),
                                  onPressed: !enabled
                                      ? null
                                      : () {
                                          if (label == 'CTRL') {
                                            terminal.toggleControl();
                                          } else if (label == 'ALT') {
                                            terminal.toggleAlt();
                                          } else if (!terminal.keyInput(key!) &&
                                              text != null) {
                                            terminal.textInput(text);
                                          }
                                          focusNode.requestFocus();
                                        },
                                  style: TextButton.styleFrom(
                                    minimumSize: const Size(0, 44),
                                    padding: const EdgeInsets.symmetric(
                                      horizontal: 2,
                                    ),
                                    tapTargetSize:
                                        MaterialTapTargetSize.shrinkWrap,
                                    foregroundColor:
                                        p[(label == 'CTRL' &&
                                                    terminal.controlArmed ||
                                                label == 'ALT' &&
                                                    terminal.altArmed)
                                            ? 'accent.default'
                                            : 'text.secondary'],
                                    backgroundColor:
                                        (label == 'CTRL' &&
                                                terminal.controlArmed ||
                                            label == 'ALT' && terminal.altArmed)
                                        ? p['accent.soft']
                                        : Colors.transparent,
                                    shape: RoundedRectangleBorder(
                                      borderRadius: BorderRadius.circular(6),
                                    ),
                                    textStyle: webText(
                                      context,
                                      size: 12,
                                      weight: FontWeight.w500,
                                    ),
                                  ),
                                  child: Text(
                                    label,
                                    semanticsLabel: description,
                                  ),
                                ),
                              ),
                            ),
                          ),
                      ],
                    ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
