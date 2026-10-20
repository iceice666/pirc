import '../l10n/app_i18n.dart';
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'gateway.dart';
import 'common.dart';
import 'web_controls.dart';

class AttentionCard extends StatelessWidget {
  const AttentionCard({
    super.key,
    required this.controller,
    required this.item,
    required this.memory,
    required this.onMemory,
  });
  final LiveController controller;
  final Json item;
  final bool memory;
  final VoidCallback onMemory;
  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    final a = controller.attention,
        schedule = obj(item['schedule']),
        run = obj(item['run']);
    final title = memory
        ? {
                'add': tr("Remember"),
                'remove': tr("Forget"),
                'replace': tr("Update memory"),
              }[item['action']] ??
              ''
        : '${schedule['title']}';
    final subtitle = memory
        ? '${item['content'] ?? obj(item['target'])['content'] ?? ''}'
        : 'Missed · ${item['wallTime'] ?? 'Time unavailable (${schedule['timezone']})'}';
    final busy = memory
        ? a.memoryBusy != null
        : a.runBusy.contains('${run['id']}');
    Widget pill(String label, bool approve) => TextButton(
      onPressed: busy
          ? null
          : () => memory
                ? a.decideProposal(item, approve)
                : a.decideMissed(item, approve),
      style: TextButton.styleFrom(
        minimumSize: const Size(0, 32),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        shape: const StadiumBorder(),
        backgroundColor: palette(
          context,
        )[approve ? 'accent.default' : 'fill.hover'],
        foregroundColor: palette(
          context,
        )[approve ? 'accent.on' : 'text.secondary'],
        textStyle: webText(context, size: 12, weight: FontWeight.w500),
      ),
      child: Text(label),
    );
    return Container(
      margin: const EdgeInsets.only(bottom: 4),
      padding: const EdgeInsets.fromLTRB(10, 6, 6, 6),
      decoration: BoxDecoration(
        color: palette(context)['surface.layer'],
        border: Border.all(color: palette(context)['line.default']),
        borderRadius: BorderRadius.circular(12),
      ),
      child: LayoutBuilder(
        builder: (context, size) {
          final text = InkWell(
            onTap: memory ? onMemory : null,
            child: Row(
              children: [
                Icon(
                  memory ? LucideIcons.brain : LucideIcons.clock,
                  size: 14,
                  color: palette(context)['status.warning'],
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: webText(
                          context,
                          size: 13,
                          weight: FontWeight.w500,
                        ).copyWith(height: 1.2),
                      ),
                      Tooltip(
                        message: subtitle,
                        child: Text(
                          subtitle,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: webText(
                            context,
                            size: 11.5,
                            color: 'text.muted',
                          ).copyWith(height: 1.2),
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          );
          final buttons = Wrap(
            spacing: 4,
            runSpacing: 4,
            children: [
              pill(memory ? tr("Approve") : 'Allow & run', true),
              pill(memory ? tr("Reject") : tr("Dismiss"), false),
            ],
          );
          double labelWidth(String label) {
            final painter = TextPainter(
              text: TextSpan(
                text: label,
                style: webText(context, size: 12, weight: FontWeight.w500),
              ),
              textDirection: Directionality.of(context),
              textScaler: MediaQuery.textScalerOf(context),
            )..layout();
            return painter.width + 20;
          }

          final buttonWidth =
              labelWidth(memory ? tr("Approve") : 'Allow & run') +
              labelWidth(memory ? tr("Reject") : tr("Dismiss")) +
              4;
          if (size.maxWidth >= buttonWidth + 50) {
            return Row(
              children: [
                Expanded(child: text),
                const SizedBox(width: 6),
                buttons,
              ],
            );
          }
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              text,
              const SizedBox(height: 6),
              Align(alignment: Alignment.centerRight, child: buttons),
            ],
          );
        },
      ),
    );
  }
}
