import '../l10n/app_i18n.dart';
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'common.dart';
import 'web_controls.dart';

/// Empty conversation content for the flexing conversation body.
///
/// The source `.empty-conversation` fills the available body height and has a
/// 300px minimum height. Put this widget in an `Expanded` (or another bounded
/// flex child) to center it in that space.
class ConversationEmptyState extends StatelessWidget {
  const ConversationEmptyState({super.key});

  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    return ConstrainedBox(
      constraints: const BoxConstraints(minHeight: 300),
      child: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 48,
              height: 48,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: palette(context)['accent.soft'],
                shape: BoxShape.circle,
              ),
              child: Icon(
                LucideIcons.plus,
                size: 24,
                color: palette(context)['accent.default'],
              ),
            ),
            const SizedBox(height: 16),
            Text(
              tr("Start something useful"),
              textAlign: TextAlign.center,
              style: webText(
                context,
                size: 22,
                weight: FontWeight.w600,
              ).copyWith(height: kTextHeightNone),
            ),
            const SizedBox(height: 6),
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 400),
              child: Text(
                tr(
                  "Describe a task, attach a reference image, or ask the agent to continue work in this workspace.",
                ),
                textAlign: TextAlign.center,
                style: webText(
                  context,
                  size: 14,
                  color: 'text.muted',
                ).copyWith(height: 1.6),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Startup status shown while sessions are loading.
///
/// Like the source `.loading-state`, this widget centers its contents in the
/// available space; callers should provide bounded height (usually `Expanded`).
class AppLoadingState extends StatelessWidget {
  const AppLoadingState({super.key});

  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 48,
            height: 48,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: palette(context)['accent.soft'],
              shape: BoxShape.circle,
            ),
            child: Icon(
              LucideIcons.sparkles,
              size: 24,
              color: palette(context)['accent.default'],
            ),
          ),
          const SizedBox(height: 14),
          Text(
            tr("Connecting to your sessions…"),
            textAlign: TextAlign.center,
            style: webText(
              context,
              size: 14,
              color: 'text.muted',
            ).copyWith(height: kTextHeightNone),
          ),
        ],
      ),
    );
  }
}

/// Status shown when an account has no loadable session.
class AppNoSessionState extends StatelessWidget {
  const AppNoSessionState({super.key});

  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            LucideIcons.circleAlert,
            size: 24,
            color: palette(context)['text.muted'],
          ),
          const SizedBox(height: 14),
          Text(
            tr("No session could be loaded."),
            textAlign: TextAlign.center,
            style: webText(
              context,
              size: 14,
              color: 'text.muted',
            ).copyWith(height: kTextHeightNone),
          ),
        ],
      ),
    );
  }
}
