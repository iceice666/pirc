import '../l10n/app_i18n.dart';
import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'common.dart';
import 'web_controls.dart';

class WorkspaceInstructionsEditor extends StatefulWidget {
  const WorkspaceInstructionsEditor({
    super.key,
    required this.controller,
    required this.enabled,
    required this.onChanged,
    required this.tooLong,
    required this.count,
  });
  final TextEditingController controller;
  final bool enabled, tooLong;
  final ValueChanged<String> onChanged;
  final String count;
  @override
  State<WorkspaceInstructionsEditor> createState() =>
      _WorkspaceInstructionsEditorState();
}

class _WorkspaceInstructionsEditorState
    extends State<WorkspaceInstructionsEditor> {
  final focus = FocusNode();
  double? resizedHeight;
  double dragY = 0, dragHeight = 0;
  @override
  void initState() {
    super.initState();
    focus.addListener(_focusChanged);
  }

  void _focusChanged() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    focus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    final platform = Theme.of(context).platform;
    final touch =
        (platform == TargetPlatform.android ||
            platform == TargetPlatform.iOS) &&
        !RendererBinding.instance.mouseTracker.mouseIsConnected;
    final fontSize = touch || MediaQuery.sizeOf(context).width <= 650
        ? 16.0
        : 14.0;
    final lineHeight = MediaQuery.textScalerOf(context).scale(fontSize) * 1.5;
    final fieldHeight = resizedHeight ?? lineHeight * 8 + 20;
    return Padding(
      padding: const EdgeInsets.only(top: 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            tr("Instructions"),
            style: webText(
              context,
              size: 13,
              color: 'text.secondary',
            ).copyWith(height: kTextHeightNone),
          ),
          const SizedBox(height: 6),
          Semantics(
            label: tr("Instructions"),
            hint: widget.count,
            validationResult: widget.tooLong
                ? SemanticsValidationResult.invalid
                : SemanticsValidationResult.none,
            child: SizedBox(
              height: fieldHeight,
              child: Stack(
                children: [
                  Positioned.fill(
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(12),
                      child: ColoredBox(
                        color: palette(context)['web.bg-subtle'],
                        child: TextField(
                          key: const ValueKey('workspace-instructions-text'),
                          focusNode: focus,
                          controller: widget.controller,
                          enabled: widget.enabled,
                          onChanged: widget.onChanged,
                          expands: true,
                          minLines: null,
                          maxLines: null,
                          textAlignVertical: TextAlignVertical.top,
                          style: webText(
                            context,
                            size: fontSize,
                            color: 'text.secondary',
                          ).copyWith(height: 1.5),
                          decoration: InputDecoration(
                            isDense: true,
                            filled: false,
                            hintText: tr(
                              "For example: answer in French, and keep trip plans on a budget.",
                            ),
                            hintStyle: webText(
                              context,
                              size: fontSize,
                              color: 'text.muted',
                            ).copyWith(height: 1.5),
                            border: InputBorder.none,
                            enabledBorder: InputBorder.none,
                            focusedBorder: InputBorder.none,
                            disabledBorder: InputBorder.none,
                            contentPadding: const EdgeInsets.fromLTRB(
                              12,
                              10,
                              9,
                              10,
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                  if (focus.hasFocus)
                    Positioned.fill(
                      child: IgnorePointer(
                        child: DecoratedBox(
                          decoration: BoxDecoration(
                            borderRadius: BorderRadius.circular(12),
                            border: Border.all(
                              color: palette(context)['accent.default'],
                            ),
                          ),
                        ),
                      ),
                    ),
                  Positioned(
                    right: 0,
                    bottom: 0,
                    width: 15,
                    height: 15,
                    child: MouseRegion(
                      cursor: SystemMouseCursors.resizeUpDown,
                      child: GestureDetector(
                        key: const ValueKey('workspace-instructions-resize'),
                        behavior: HitTestBehavior.opaque,
                        onVerticalDragDown: (details) {
                          dragY = details.globalPosition.dy;
                          dragHeight = fieldHeight;
                        },
                        onVerticalDragUpdate: (details) => setState(
                          () => resizedHeight = math.max(
                            20,
                            dragHeight + details.globalPosition.dy - dragY,
                          ),
                        ),
                        child: CustomPaint(
                          painter: _ResizeGrip(palette(context)['text.muted']),
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _ResizeGrip extends CustomPainter {
  const _ResizeGrip(this.color);
  final Color color;
  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color
      ..strokeWidth = 1;
    for (final inset in [3.0, 6.0, 9.0]) {
      canvas.drawLine(
        Offset(size.width - inset, size.height - 2),
        Offset(size.width - 2, size.height - inset),
        paint,
      );
    }
  }

  @override
  bool shouldRepaint(_ResizeGrip oldDelegate) => oldDelegate.color != color;
}
