import '../l10n/app_i18n.dart';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'common.dart';

TextStyle webText(
  BuildContext context, {
  double size = 14,
  FontWeight weight = FontWeight.w400,
  String color = 'text.primary',
}) => TextStyle(
  fontFamily: Theme.of(context).textTheme.bodyMedium?.fontFamily,
  fontSize: size,
  height: 1.4,
  letterSpacing: 0,
  fontWeight: weight,
  color: palette(context)[color],
);

class WebButton extends StatelessWidget {
  const WebButton(
    this.label, {
    super.key,
    this.onPressed,
    this.icon,
    this.primary = false,
    this.danger = false,
    this.height = 36,
    this.fontSize = 14,
    this.horizontalPadding = 16,
    this.muted = false,
    this.backgroundColor,
    this.disabledOpacity,
  });
  final String label;
  final VoidCallback? onPressed;
  final IconData? icon;
  final bool primary, danger;
  final double height, fontSize, horizontalPadding;
  final Color? backgroundColor;
  final double? disabledOpacity;
  final bool muted;
  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    return Opacity(
      opacity: onPressed == null ? (disabledOpacity ?? 1) : 1,
      child: TextButton(
        onPressed: onPressed,
        style: TextButton.styleFrom(
          minimumSize: Size(0, height),
          maximumSize: Size(double.infinity, height),
          padding: EdgeInsets.symmetric(horizontal: horizontalPadding),
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          shape: const StadiumBorder(),
          backgroundColor: primary
              ? palette(context)[danger ? 'status.danger' : 'text.primary']
              : backgroundColor ?? Colors.transparent,
          disabledBackgroundColor: disabledOpacity != null
              ? (primary
                    ? palette(context)['text.primary']
                    : backgroundColor ?? Colors.transparent)
              : null,
          foregroundColor:
              palette(context)[primary
                  ? 'surface.page'
                  : danger
                  ? 'status.danger'
                  : muted
                  ? 'text.muted'
                  : 'text.primary'],
          disabledForegroundColor: disabledOpacity != null
              ? palette(context)[primary
                    ? 'surface.page'
                    : danger
                    ? 'status.danger'
                    : muted
                    ? 'text.muted'
                    : 'text.primary']
              : palette(context)['text.muted'],
          textStyle: webText(
            context,
            size: fontSize,
            weight: FontWeight.w500,
          ).copyWith(height: kTextHeightNone),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (icon != null) ...[
              Icon(icon, size: 15),
              const SizedBox(width: 7),
            ],
            Flexible(
              child: Text(label, textAlign: TextAlign.center, softWrap: false),
            ),
          ],
        ),
      ),
    );
  }
}

class WebIconButton extends StatelessWidget {
  const WebIconButton(
    this.icon,
    this.label, {
    super.key,
    this.onPressed,
    this.size = 28,
    this.iconSize = 15,
    this.focusNode,
    this.autofocus = false,
  });
  final IconData icon;
  final String label;
  final VoidCallback? onPressed;
  final double size, iconSize;
  final FocusNode? focusNode;
  final bool autofocus;
  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    return IconButton(
      tooltip: label,
      focusNode: focusNode,
      autofocus: autofocus,
      onPressed: onPressed,
      icon: Icon(icon, size: iconSize),
      style: IconButton.styleFrom(
        minimumSize: Size(size, size),
        maximumSize: Size(size, size),
        padding: EdgeInsets.zero,
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        foregroundColor: palette(context)['text.muted'],
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
      ),
    );
  }
}

class WebSearch extends StatefulWidget {
  const WebSearch({
    super.key,
    required this.controller,
    required this.label,
    required this.onChanged,
    this.fixedHeight,
    this.fontSize,
  });
  final TextEditingController controller;
  final String label;
  final ValueChanged<String> onChanged;
  final double? fixedHeight, fontSize;

  @override
  State<WebSearch> createState() => _WebSearchState();
}

class _WebSearchState extends State<WebSearch> {
  late final FocusNode _focusNode;
  bool _focused = false;

  @override
  void initState() {
    super.initState();
    _focusNode = FocusNode()..addListener(_onFocusChanged);
  }

  void _onFocusChanged() {
    final focused = _focusNode.hasFocus;
    if (_focused != focused) setState(() => _focused = focused);
  }

  @override
  void dispose() {
    _focusNode
      ..removeListener(_onFocusChanged)
      ..dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    final fixed = widget.fixedHeight != null;
    final size =
        widget.fontSize ?? (MediaQuery.sizeOf(context).width <= 860 ? 16 : 13);
    final style = webText(
      context,
      size: size,
      color: fixed ? 'text.muted' : 'text.primary',
    );
    final input = TextField(
      controller: widget.controller,
      onChanged: widget.onChanged,
      focusNode: _focusNode,
      style: fixed ? style.copyWith(height: kTextHeightNone) : style,
      decoration: InputDecoration(
        hintText: widget.label,
        hintStyle: fixed
            ? style.copyWith(height: kTextHeightNone)
            : webText(context, size: size, color: 'text.muted'),
        isDense: true,
        contentPadding: EdgeInsets.symmetric(vertical: fixed ? 1 : 7),
        border: InputBorder.none,
      ),
    );
    return Container(
      height: widget.fixedHeight,
      constraints: fixed ? null : const BoxConstraints(minHeight: 36),
      decoration: BoxDecoration(
        color: palette(
          context,
        )[fixed && _focused ? 'surface.layer' : 'fill.hover'],
        borderRadius: BorderRadius.circular(8),
        boxShadow: fixed && _focused
            ? [
                BoxShadow(
                  color: palette(context)['web.line-dark'],
                  spreadRadius: 1,
                ),
              ]
            : null,
      ),
      padding: const EdgeInsets.symmetric(horizontal: 10),
      child: LayoutBuilder(
        builder: (context, constraints) {
          const svgBasis = 16.0;
          const gap = 8.0;
          var svgSize = svgBasis;
          if (fixed && constraints.hasBoundedWidth) {
            // The web SVG and width:100% input are both flex-shrink:1. The
            // input's flex basis is the whole row width, so they share the
            // icon+gap overcommit in proportion to their flex bases.
            final inputBasis = constraints.maxWidth;
            final overcommit = math.max(
              0.0,
              svgBasis + gap + inputBasis - constraints.maxWidth,
            );
            svgSize = math.max(
              0.0,
              svgBasis - overcommit * svgBasis / (svgBasis + inputBasis),
            );
          }
          final icon = Icon(
            LucideIcons.search,
            size: svgSize,
            color: palette(context)['text.muted'],
          );
          return Row(
            children: [
              if (fixed)
                SizedBox(
                  width: svgSize,
                  height: 16,
                  child: Center(child: icon),
                )
              else
                icon,
              const SizedBox(width: gap),
              Expanded(
                child: fixed
                    // Like the web input, enlarged text can extend beyond the fixed
                    // search surface while the surrounding sidebar keeps its geometry.
                    ? OverflowBox(
                        minHeight: 0,
                        maxHeight: double.infinity,
                        child: input,
                      )
                    : input,
              ),
            ],
          );
        },
      ),
    );
  }
}

class WebDialog extends StatelessWidget {
  const WebDialog({
    super.key,
    required this.title,
    required this.children,
    required this.actions,
    this.busy = false,
    this.eyebrow,
  });
  final String title;
  final String? eyebrow;
  final List<Widget> children, actions;
  final bool busy;
  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    return PopScope(
      canPop: !busy,
      child: Dialog(
        insetPadding: const EdgeInsets.all(16),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 520),
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: DefaultTextStyle(
              style: webText(context, size: 14, color: 'text.secondary'),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            if (eyebrow != null)
                              Text(
                                eyebrow!,
                                style: webText(
                                  context,
                                  size: 11,
                                  color: 'text.muted',
                                ),
                              ),
                            Text(
                              title,
                              style: webText(
                                context,
                                size: 20,
                                weight: FontWeight.w600,
                              ),
                            ),
                          ],
                        ),
                      ),
                      WebIconButton(
                        LucideIcons.x,
                        tr("Close"),
                        size: 32,
                        onPressed: busy ? null : () => Navigator.pop(context),
                      ),
                    ],
                  ),
                  const SizedBox(height: 16),
                  ...children,
                  const SizedBox(height: 20),
                  Align(
                    alignment: Alignment.centerRight,
                    child: Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      alignment: WrapAlignment.end,
                      children: actions,
                    ),
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

class WebNotice extends StatelessWidget {
  const WebNotice(this.text, {super.key, this.error = false});
  final String text;
  final bool error;
  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    return Semantics(
      liveRegion: true,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Text(
          text,
          style: webText(
            context,
            size: 13,
            color: error ? 'status.danger' : 'text.secondary',
          ),
        ),
      ),
    );
  }
}

/// The web's one-second loader rotation, suspended with the visible surface.
class WebSpinner extends StatefulWidget {
  const WebSpinner({super.key, this.size = 15, this.color});
  final double size;
  final Color? color;
  @override
  State<WebSpinner> createState() => _WebSpinnerState();
}

class _WebSpinnerState extends State<WebSpinner>
    with SingleTickerProviderStateMixin {
  late final animation = AnimationController(
    vsync: this,
    duration: const Duration(seconds: 1),
  );
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final reducedMotion = MediaQuery.disableAnimationsOf(context);
    final enabled = TickerMode.valuesOf(context).enabled && !reducedMotion;
    if (enabled) {
      if (!animation.isAnimating) animation.repeat();
    } else {
      animation.stop();
      if (reducedMotion) animation.value = 0;
    }
  }

  @override
  void dispose() {
    animation.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    return RotationTransition(
      turns: animation,
      child: Icon(
        LucideIcons.loaderCircle,
        size: widget.size,
        color: widget.color,
      ),
    );
  }
}
