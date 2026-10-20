import '../l10n/app_i18n.dart';
import 'package:flutter/material.dart';

import 'assistant_settings.dart';
import 'web_controls.dart';

/// The fixed About content shared with the web settings panel, plus the
/// native-only entry point for operating-system app settings.
class NativeAboutSettings extends StatelessWidget {
  const NativeAboutSettings({
    super.key,
    required this.clientId,
    required this.onAppOptions,
  });

  final String? clientId;
  final VoidCallback onAppOptions;

  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    return AssistantSection(
      title: tr("This browser"),
      children: [
        const SizedBox(height: 8),
        LayoutBuilder(
          builder: (context, constraints) => Row(
            children: [
              Expanded(
                child: Text(
                  tr("Client ID"),
                  style: webText(
                    context,
                    size: 13,
                    color: 'text.muted',
                  ).copyWith(height: 1.5),
                ),
              ),
              const SizedBox(width: 12),
              ConstrainedBox(
                constraints: BoxConstraints(
                  maxWidth: constraints.maxWidth * .6,
                ),
                child: SelectionArea(
                  child: Text(
                    clientId ?? '',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: webText(
                      context,
                      size: 12,
                      color: 'text.secondary',
                    ).copyWith(fontFamily: 'monospace', height: 1.5),
                  ),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 18),
        Align(
          alignment: Alignment.centerLeft,
          child: AssistantButton(tr("App options"), onPressed: onAppOptions),
        ),
      ],
    );
  }
}
