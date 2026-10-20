import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'common.dart';
import 'web_controls.dart';

class AssistantSection extends StatelessWidget {
  const AssistantSection({
    super.key,
    required this.title,
    required this.children,
    this.divider = false,
  });
  final String title;
  final List<Widget> children;
  final bool divider;
  @override
  Widget build(BuildContext context) => Container(
    margin: EdgeInsets.only(top: divider ? 18 : 0),
    padding: EdgeInsets.only(top: divider ? 16 : 0),
    decoration: divider
        ? BoxDecoration(
            border: Border(
              top: BorderSide(color: palette(context)['web.line']),
            ),
          )
        : null,
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Semantics(
          headingLevel: 3,
          child: Text(
            title.toUpperCase(),
            style: webText(
              context,
              size: 12,
              weight: FontWeight.w600,
              color: 'text.secondary',
            ).copyWith(letterSpacing: .24, height: 14 / 12),
          ),
        ),
        ...children,
      ],
    ),
  );
}

class AssistantParagraph extends StatelessWidget {
  const AssistantParagraph(
    this.text, {
    super.key,
    this.error = false,
    this.live = false,
    this.code = false,
    this.color,
    this.inlineCode,
    this.inlineCodeStart = 0,
  });
  final String text;
  final String? inlineCode;
  final String? color;
  final int inlineCodeStart;
  final bool error, live, code;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: 8),
    child: Semantics(
      liveRegion: live,
      child: text.isEmpty
          ? const SizedBox.shrink()
          : LayoutBuilder(
              builder: (context, constraints) {
                final style = webText(
                  context,
                  size: 13,
                  color: color ?? (error ? 'status.danger' : 'text.muted'),
                ).copyWith(height: 1.55, fontFamily: code ? 'monospace' : null);
                return SelectionArea(
                  child: Text.rich(
                    _content(context, style, constraints.maxWidth),
                  ),
                );
              },
            ),
    ),
  );

  TextSpan _content(BuildContext context, TextStyle style, double maxWidth) {
    final fragment = inlineCode;
    if (fragment == null || fragment.isEmpty) {
      return TextSpan(text: text, style: style);
    }
    final start = text.indexOf(fragment, inlineCodeStart);
    if (start < 0) return TextSpan(text: text, style: style);

    final direction = Directionality.of(context);
    final scaler = MediaQuery.textScalerOf(context);
    final codeStyle = style.copyWith(fontFamily: 'monospace');
    final spans = <InlineSpan>[
      TextSpan(text: text.substring(0, start)),
      TextSpan(text: fragment, style: codeStyle),
      TextSpan(text: text.substring(start + fragment.length)),
    ];
    double? breakGap;
    if (maxWidth.isFinite && maxWidth > 0 && direction == TextDirection.ltr) {
      final fullLine = TextPainter(
        text: TextSpan(style: style, children: spans),
        textDirection: direction,
        textScaler: scaler,
        textWidthBasis: TextWidthBasis.parent,
      )..layout(maxWidth: maxWidth);
      final codeStart = fullLine
          .getOffsetForCaret(TextPosition(offset: start), Rect.zero)
          .dx;
      fullLine.dispose();

      final measuredCode = TextPainter(
        text: TextSpan(text: fragment, style: codeStyle),
        textDirection: direction,
        textScaler: scaler,
      )..layout();
      final codeWidth = measuredCode.width;
      measuredCode.dispose();
      final remaining = maxWidth - codeStart;

      // Keep an inline code run with its preceding text only when the whole
      // run fits that line. A longer run starts at the next line and can wrap
      // within the paragraph width.
      if (codeStart > 0 && remaining > .5 && codeWidth > remaining + .01) {
        // WidgetSpan scales its child by the current text scale factor. Leave
        // a fraction of a pixel for layout rounding so the spacer stays after
        // the prefix instead of moving to a line of its own.
        final fontSize = style.fontSize ?? 14;
        final inlineScale = scaler.scale(fontSize) / fontSize;
        breakGap = (remaining - .5) / inlineScale;
      }
    }
    if (breakGap != null) {
      spans.insert(1, WidgetSpan(child: SizedBox(width: breakGap, height: 0)));
    }
    return TextSpan(style: style, children: spans);
  }
}

class AssistantButton extends StatefulWidget {
  const AssistantButton(
    this.label, {
    super.key,
    this.onPressed,
    this.filled = false,
    this.primary = false,
  });
  final String label;
  final VoidCallback? onPressed;
  final bool filled, primary;
  @override
  State<AssistantButton> createState() => _AssistantButtonState();
}

class _AssistantButtonState extends State<AssistantButton> {
  bool focused = false, keyboardFocus = true;
  bool keyEvent(KeyEvent event) {
    if (!keyboardFocus && mounted) setState(() => keyboardFocus = true);
    return false;
  }

  @override
  void initState() {
    super.initState();
    FocusManager.instance.addHighlightModeListener(highlightChanged);
    HardwareKeyboard.instance.addHandler(keyEvent);
  }

  void highlightChanged(FocusHighlightMode _) {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    FocusManager.instance.removeHighlightModeListener(highlightChanged);
    HardwareKeyboard.instance.removeHandler(keyEvent);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final onPressed = widget.onPressed,
        primary = widget.primary,
        filled = widget.filled;
    final colors = palette(context);
    return Opacity(
      opacity: onPressed == null ? .45 : 1,
      child: Listener(
        onPointerDown: (_) => setState(() => keyboardFocus = false),
        child: Stack(
          clipBehavior: Clip.none,
          children: [
            if (onPressed != null &&
                focused &&
                keyboardFocus &&
                FocusManager.instance.highlightMode ==
                    FocusHighlightMode.traditional)
              Positioned.fill(
                left: -4,
                right: -4,
                top: -4,
                bottom: -4,
                child: IgnorePointer(
                  child: DecoratedBox(
                    key: ValueKey(
                      'assistant-button-${widget.label}-focus-ring',
                    ),
                    decoration: ShapeDecoration(
                      shape: StadiumBorder(
                        side: BorderSide(
                          color: colors['accent.default'],
                          width: 2,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            TextButton(
              onPressed: onPressed,
              onFocusChange: (value) => setState(() => focused = value),
              style:
                  TextButton.styleFrom(
                    minimumSize: const Size(0, 36),
                    fixedSize: const Size.fromHeight(36),
                    padding: const EdgeInsets.symmetric(horizontal: 16),
                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    foregroundColor: primary
                        ? Colors.white
                        : palette(context)['text.primary'],
                    disabledForegroundColor: primary
                        ? Colors.white
                        : palette(context)['text.primary'],
                    shape: const StadiumBorder(),
                    textStyle: TextStyle(
                      fontFamily: Theme.of(
                        context,
                      ).textTheme.bodyMedium?.fontFamily,
                      fontSize: 14,
                      fontWeight: FontWeight.w500,
                      letterSpacing: 0,
                    ),
                    overlayColor: Colors.transparent,
                    splashFactory: NoSplash.splashFactory,
                  ).copyWith(
                    backgroundColor: WidgetStateProperty.resolveWith((states) {
                      final hovered =
                          states.contains(WidgetState.hovered) &&
                          !states.contains(WidgetState.disabled);
                      if (primary) {
                        return colors[hovered
                            ? 'web.accent-hover'
                            : 'accent.default'];
                      }
                      if (filled) {
                        return colors[hovered
                            ? 'web.bg-hover-strong'
                            : 'web.bg-hover'];
                      }
                      return hovered
                          ? colors['web.bg-hover']
                          : Colors.transparent;
                    }),
                  ),
              child: Text(
                widget.label,
                textAlign: TextAlign.center,
                softWrap: false,
                maxLines: 1,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
