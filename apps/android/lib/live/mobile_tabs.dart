import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../theme.dart';

/// MobileTabs.svelte: the phone list/pages own the bottom navigation. A
/// conversation has a back action, leaving all available height for its content.
class MobileTabs extends StatelessWidget {
  const MobileTabs({
    super.key,
    required this.current,
    required this.chats,
    required this.waiting,
    required this.onPick,
  });
  final String current;
  final bool chats;
  final int waiting;
  final ValueChanged<String> onPick;
  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).extension<PircColors>()!;
    final tabs = [
      if (chats) ('chat', 'Chat', LucideIcons.messageSquare),
      ('work', 'Work', LucideIcons.squareTerminal),
      ('schedules', 'Schedules', LucideIcons.calendarClock),
      ('settings', 'Settings', LucideIcons.settings),
    ];
    final available = MediaQuery.sizeOf(context).width;
    final minimum = <double>[];
    for (final tab in tabs) {
      final painter = TextPainter(
        text: TextSpan(
          text: tab.$2,
          style: TextStyle(
            fontFamily: Theme.of(context).textTheme.bodyMedium?.fontFamily,
            fontSize: 11,
            height: 1.2,
            letterSpacing: 0,
            fontWeight: current == tab.$1 ? FontWeight.w500 : FontWeight.w400,
          ),
        ),
        textDirection: Directionality.of(context),
        textScaler: MediaQuery.textScalerOf(context),
      )..layout();
      minimum.add(math.max(20, painter.width));
      painter.dispose();
    }
    final frozen = <int>{};
    var share = available / tabs.length;
    while (true) {
      final changed = [
        for (var i = 0; i < tabs.length; i++)
          if (!frozen.contains(i) && minimum[i] > share) i,
      ];
      if (changed.isEmpty || frozen.length == tabs.length) break;
      frozen.addAll(changed);
      final remaining =
          available - frozen.fold<double>(0, (sum, i) => sum + minimum[i]);
      share = frozen.length == tabs.length
          ? 0
          : math.max(0, remaining / (tabs.length - frozen.length));
    }
    final widths = [
      for (var i = 0; i < tabs.length; i++)
        frozen.contains(i) ? minimum[i] : share,
    ];
    final rowWidth = widths.fold<double>(0, (sum, width) => sum + width);
    return Material(
      color: colors['surface.page'],
      child: Container(
        decoration: BoxDecoration(
          border: Border(top: BorderSide(color: colors['line.hairline'])),
        ),
        child: SafeArea(
          top: false,
          child: SizedBox(
            height: 55,
            child: ClipRect(
              child: OverflowBox(
                alignment: Alignment.topLeft,
                minWidth: rowWidth,
                maxWidth: rowWidth,
                child: Row(
                  children: [
                    for (final (index, tab) in tabs.indexed)
                      SizedBox(
                        width: widths[index],
                        child: Semantics(
                          selected: current == tab.$1,
                          button: true,
                          child: InkWell(
                            onTap: () => onPick(tab.$1),
                            child: Column(
                              mainAxisAlignment: MainAxisAlignment.center,
                              children: [
                                Stack(
                                  clipBehavior: Clip.none,
                                  children: [
                                    Icon(
                                      tab.$3,
                                      size: 20,
                                      color:
                                          colors[current == tab.$1
                                              ? 'text.primary'
                                              : 'text.muted'],
                                    ),
                                    if (tab.$1 == 'work' && waiting > 0)
                                      Positioned(
                                        top: -5,
                                        right: -9,
                                        child: Semantics(
                                          label: '$waiting waiting for you',
                                          child: Container(
                                            constraints: const BoxConstraints(
                                              minWidth: 16,
                                            ),
                                            height: 16,
                                            padding: const EdgeInsets.symmetric(
                                              horizontal: 4,
                                            ),
                                            decoration: BoxDecoration(
                                              color: colors['status.warning'],
                                              borderRadius:
                                                  BorderRadius.circular(999),
                                            ),
                                            child: Text(
                                              '$waiting',
                                              textAlign: TextAlign.center,
                                              style: const TextStyle(
                                                color: Colors.white,
                                                fontSize: 10,
                                                height: 1.6,
                                                fontWeight: FontWeight.w600,
                                              ),
                                            ),
                                          ),
                                        ),
                                      ),
                                  ],
                                ),
                                const SizedBox(height: 2),
                                Text(
                                  tab.$2,
                                  maxLines: 1,
                                  softWrap: false,
                                  style: TextStyle(
                                    fontFamily: Theme.of(
                                      context,
                                    ).textTheme.bodyMedium?.fontFamily,
                                    fontSize: 11,
                                    height: 1.2,
                                    letterSpacing: 0,
                                    color:
                                        colors[current == tab.$1
                                            ? 'text.primary'
                                            : 'text.muted'],
                                    fontWeight: current == tab.$1
                                        ? FontWeight.w500
                                        : FontWeight.w400,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
