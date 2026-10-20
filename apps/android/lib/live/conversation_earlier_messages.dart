import '../l10n/app_i18n.dart';
import 'package:flutter/material.dart';

import 'common.dart';
import 'web_controls.dart';

/// App.svelte's earlier-message control. The caller preserves the scroll anchor.
class ConversationEarlierMessages extends StatelessWidget {
  const ConversationEarlierMessages({
    super.key,
    required this.hiddenCount,
    required this.onPressed,
    this.buttonKey,
  });

  final int hiddenCount;
  final Key? buttonKey;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: Center(
        child: DecoratedBox(
          key: buttonKey,
          decoration: BoxDecoration(
            border: Border.all(color: palette(context)['line.default']),
            borderRadius: BorderRadius.circular(999),
          ),
          child: Padding(
            padding: const EdgeInsets.all(1),
            child: TextButton(
              onPressed: onPressed,
              style:
                  TextButton.styleFrom(
                    minimumSize: Size.zero,
                    padding: const EdgeInsets.symmetric(
                      horizontal: 12,
                      vertical: 6,
                    ),
                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    shape: const StadiumBorder(),
                    textStyle: webText(
                      context,
                      size: 12,
                    ).copyWith(height: kTextHeightNone),
                  ).copyWith(
                    foregroundColor: WidgetStateProperty.resolveWith(
                      (states) =>
                          palette(context)[states.contains(WidgetState.hovered)
                              ? 'text.primary'
                              : 'text.muted'],
                    ),
                    backgroundColor: WidgetStateProperty.resolveWith(
                      (states) =>
                          palette(context)[states.contains(WidgetState.hovered)
                              ? 'fill.hover'
                              : 'surface.layer'],
                    ),
                  ),
              child: Text(
                tr("Show earlier messages ({0} more)", [hiddenCount]),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
