import '../l10n/app_i18n.dart';
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'common.dart';
import 'web_controls.dart';

/// App.svelte's floating jump-to-latest control; the caller owns scroll state.
class ConversationJumpLatest extends StatelessWidget {
  const ConversationJumpLatest({super.key, required this.onPressed});

  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    return DecoratedBox(
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(999),
        boxShadow: pircShadow(context),
      ),
      child: SizedBox(
        height: 36,
        child: TextButton(
          onPressed: onPressed,
          style:
              TextButton.styleFrom(
                minimumSize: const Size(0, 36),
                maximumSize: const Size(double.infinity, 36),
                padding: const EdgeInsets.symmetric(horizontal: 14),
                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                shape: const StadiumBorder(),
                foregroundColor: palette(context)['text.primary'],
                textStyle: webText(
                  context,
                  size: 13,
                  weight: FontWeight.w500,
                ).copyWith(height: kTextHeightNone),
              ).copyWith(
                backgroundColor: WidgetStateProperty.resolveWith(
                  (states) =>
                      palette(context)[states.contains(WidgetState.hovered)
                          ? 'surface.subtle'
                          : 'surface.layer'],
                ),
              ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(LucideIcons.arrowDown, size: 15),
              SizedBox(width: 6),
              Text(tr("New messages")),
            ],
          ),
        ),
      ),
    );
  }
}
