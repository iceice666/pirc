import 'dart:ui' show SemanticsRole;
import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'common.dart';
import 'gateway.dart';
import 'web_controls.dart';
import 'observational_memory_state.dart';

class ObservationalMemoryPane extends StatefulWidget {
  const ObservationalMemoryPane({
    super.key,
    required this.controller,
    this.clock,
  });
  final LiveController controller;
  final DateTime Function()? clock;
  @override
  State<ObservationalMemoryPane> createState() =>
      _ObservationalMemoryPaneState();
}

class _ObservationalMemoryPaneState extends State<ObservationalMemoryPane> {
  late final state = ObservationalMemoryState(widget.controller);
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    state.setActive(TickerMode.valuesOf(context).enabled);
  }

  @override
  void dispose() {
    state.dispose();
    super.dispose();
  }

  TextStyle text(
    double size, {
    String color = 'text.primary',
    FontWeight weight = FontWeight.w400,
    double? height,
  }) => webText(
    context,
    size: size,
    color: color,
    weight: weight,
  ).copyWith(height: height ?? 1.15);
  String normal(String value) =>
      value.replaceAll(RegExp(r'[ \t\r\n\f]+'), ' ').trim();
  Widget empty(String value) => Padding(
    padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 4),
    child: Text(value, style: text(13, color: 'text.muted', height: 1.5)),
  );
  BoxDecoration box(String color, double radius, {bool border = false}) =>
      BoxDecoration(
        color: palette(context)[color],
        borderRadius: BorderRadius.circular(radius),
        boxShadow: border
            ? [BoxShadow(color: palette(context)['web.line'], spreadRadius: 1)]
            : null,
      );
  Widget errors(List<Widget> children) => Container(
    decoration: box('status.dangerSoft', 8),
    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
    child: DefaultTextStyle(
      style: text(12.5, color: 'status.danger', height: 1.45),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: children,
      ),
    ),
  );
  Widget chip(String label, {IconData? icon, bool working = false}) =>
      Container(
        key: ValueKey('memory-status-chip-$label'),
        // The source .chip is a fixed 20px row. At larger text scales its text
        // paints beyond that box; growing the chip changes every section below
        // it and diverges from the Web flow.
        height: 20,
        padding: const EdgeInsets.symmetric(horizontal: 7),
        decoration: box(working ? 'accent.soft' : 'web.bg-hover', 999),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (icon != null) ...[
              if (working)
                WebSpinner(size: 12, color: palette(context)['accent.default'])
              else
                Icon(icon, size: 12, color: palette(context)['text.secondary']),
              const SizedBox(width: 4),
            ],
            Flexible(
              child: Text(
                label,
                style: text(
                  11,
                  color: working ? 'accent.default' : 'text.secondary',
                  weight: FontWeight.w500,
                ).copyWith(height: kTextHeightNone),
              ),
            ),
          ],
        ),
      );
  Widget status() {
    final r = state.runtime;
    final phase = r['phase'];
    final busy = phase != null && phase != '';
    const labels = {
      'starting': 'Starting consolidation',
      'observer': 'Observing recent turns',
      'reflector': 'Reflecting on observations',
      'dropper': 'Pruning low-value observations',
    };
    return Wrap(
      spacing: 6,
      runSpacing: 6,
      children: [
        if (busy)
          chip(
            labels[phase] ?? '$phase',
            icon: LucideIcons.loaderCircle,
            working: true,
          )
        else if (r['autoCompacting'] == true)
          chip('Compacting', icon: LucideIcons.loaderCircle, working: true)
        else
          chip(
            widget.controller.panelData.value?['agentRunning'] == true
                ? 'Idle'
                : 'Agent stopped',
            icon: LucideIcons.brain,
          ),
        if (state.memory?['passive'] == true) chip('Passive'),
      ],
    );
  }

  Widget stats() => LayoutBuilder(
    builder: (context, bounds) {
      // The pane may be wider than the viewport because the observation
      // toolbar creates a horizontal scroll extent. The source container
      // query is based on the unscrolled panel width, so don't let that wider
      // child extent switch the stat grid from two columns to four.
      final viewportContentWidth = math.max(
        0.0,
        MediaQuery.sizeOf(context).width - 24,
      );
      final gridWidth = math.min(bounds.maxWidth, viewportContentWidth);
      final count = gridWidth <= 380 ? 2 : 4;
      final width = (gridWidth - (count - 1) * 6) / count;
      final counts = obj(state.memory?['counts']);
      return Align(
        alignment: Alignment.topLeft,
        widthFactor: 1,
        child: SizedBox(
          width: gridWidth,
          child: Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [
              for (final item in [
                ('reflections', 'Reflections'),
                ('active', 'Active obs.'),
                ('dropped', 'Dropped'),
                ('compactions', 'Compactions'),
              ])
                Container(
                  key: ValueKey('memory-stat-${item.$1}'),
                  width: width,
                  padding: const EdgeInsets.all(8),
                  decoration: box('web.bg-layer', 12, border: true),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Text(
                        '${counts[item.$1] ?? 0}',
                        style: text(17, weight: FontWeight.w600)
                            .copyWith(height: kTextHeightNone)
                            .copyWith(
                              fontFeatures: const [
                                FontFeature.tabularFigures(),
                              ],
                            ),
                      ),
                      const SizedBox(height: 1),
                      Text(
                        item.$2,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: text(
                          11,
                          color: 'text.muted',
                        ).copyWith(height: kTextHeightNone),
                      ),
                    ],
                  ),
                ),
            ],
          ),
        ),
      );
    },
  );
  Widget meters() {
    final thresholds = obj(state.memory?['thresholds']);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: box('web.bg-layer', 12, border: true),
      child: Column(
        children: [
          for (final (index, item) in [
            ('observation', 'Next observation'),
            ('reflection', 'Next reflection'),
            ('compaction', 'Next compaction'),
            ('activePool', 'Active observation pool'),
          ].indexed) ...[
            if (index > 0) const SizedBox(height: 8),
            meter(item.$2, obj(thresholds[item.$1])),
          ],
        ],
      ),
    );
  }

  Widget meter(String label, Json value) {
    final amount = value['value'] as num? ?? 0, max = value['max'] as num? ?? 0;
    final fraction = max > 0 ? (amount / max).clamp(0.0, 1.0) : 0.0;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Flexible(
              child: Text(label, style: text(12.5, height: 14 / 12.5)),
            ),
            const SizedBox(width: 8),
            Flexible(
              child: Text(
                '${memoryTokens(amount)} / ${memoryTokens(max)}',
                textAlign: TextAlign.right,
                style: text(
                  11.5,
                  color: 'text.muted',
                ).copyWith(fontFeatures: const [FontFeature.tabularFigures()]),
              ),
            ),
          ],
        ),
        const SizedBox(height: 4),
        Semantics(
          role: SemanticsRole.progressBar,
          minValue: '0',
          maxValue: '100',
          label: label,
          value: '${(fraction * 100).round()}%',
          child: ExcludeSemantics(
            child: Container(
              height: 5,
              clipBehavior: Clip.antiAlias,
              decoration: box('web.bg-hover-strong', 999),
              child: TweenAnimationBuilder<double>(
                tween: Tween(end: fraction),
                duration: const Duration(milliseconds: 300),
                curve: const Cubic(.4, 0, .2, 1),
                builder: (context, width, _) => Align(
                  alignment: Alignment.centerLeft,
                  child: FractionallySizedBox(
                    widthFactor: width,
                    child: DecoratedBox(
                      decoration: box(
                        fraction >= 1 ? 'text.warning' : 'accent.default',
                        999,
                      ),
                      child: const SizedBox.expand(),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }

  Widget filters() => Semantics(
    label: 'Observation filter',
    container: true,
    child: Container(
      padding: const EdgeInsets.all(2),
      decoration: box('web.bg-hover', 999),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final (index, option) in [
            'active',
            'all',
            'dropped',
          ].indexed) ...[
            if (index > 0) const SizedBox(width: 2),
            Semantics(
              button: true,
              selected: state.filter == option,
              child: DecoratedBox(
                decoration: state.filter == option
                    ? BoxDecoration(
                        color: palette(context)['web.bg-layer'],
                        borderRadius: BorderRadius.circular(999),
                        boxShadow: [
                          BoxShadow(
                            color: palette(context)['web.line'],
                            spreadRadius: 1,
                          ),
                          const BoxShadow(
                            color: Color(0x0f000000),
                            offset: Offset(0, 1),
                            blurRadius: 2,
                          ),
                        ],
                      )
                    : const BoxDecoration(),
                child: InkWell(
                  key: ValueKey('memory-filter-$option'),
                  onTap: () => state.setFilter(option),
                  borderRadius: BorderRadius.circular(999),
                  splashFactory: NoSplash.splashFactory,
                  child: Container(
                    height: 22,
                    padding: const EdgeInsets.symmetric(horizontal: 8),
                    alignment: Alignment.center,
                    child: Text(
                      '${option[0].toUpperCase()}${option.substring(1)}',
                      overflow: TextOverflow.visible,
                      style: text(
                        11.5,
                        color: state.filter == option
                            ? 'text.primary'
                            : 'text.secondary',
                        weight: FontWeight.w500,
                        height: kTextHeightNone,
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ],
        ],
      ),
    ),
  );
  Widget group(String name, Widget trailing) => Padding(
    key: ValueKey('memory-group-${name.toLowerCase()}'),
    padding: const EdgeInsets.only(top: 6),
    child: LayoutBuilder(
      builder: (context, b) {
        final title = Text(
          name.toUpperCase(),
          style:
              text(
                11.5,
                color: 'text.muted',
                weight: FontWeight.w600,
                height: kTextHeightNone,
              ).copyWith(
                letterSpacing:
                    .02 * MediaQuery.textScalerOf(context).scale(11.5),
              ),
        );
        if (name == 'Observations') {
          // The web group-title is a no-wrap flex row. Keep the filters beside
          // the title and let the panel own any horizontal overflow.
          return Row(
            mainAxisSize: MainAxisSize.max,
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [title, const SizedBox(width: 8), trailing],
          );
        }
        return Row(
          children: [
            Expanded(child: title),
            const SizedBox(width: 8),
            trailing,
          ],
        );
      },
    ),
  );
  Widget entry(Json item, bool reflection) {
    final id = '${item['id']}', open = state.expanded.contains(id);
    final dim = reflection ? item['visible'] != true : item['dropped'] == true;
    final metadata = reflection
        ? ' · ${(item['supportingObservationIds'] as List? ?? []).length} sources · ${memoryTokens(item['tokenCount'] as num? ?? 0)} tok${item['visible'] != true ? ' · not in context' : ''}'
        : ' · ${item['timestamp']}${item['dropped'] == true ? ' · dropped' : ''}';
    return Opacity(
      opacity: dim ? .55 : 1,
      child: Semantics(
        button: true,
        expanded: open,
        child: InkWell(
          key: ValueKey('memory-entry-$id'),
          onTap: () => state.toggle(id),
          borderRadius: BorderRadius.circular(8),
          hoverColor: palette(context)['web.bg-hover'],
          splashFactory: NoSplash.splashFactory,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 7),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text.rich(
                  TextSpan(
                    children: [
                      if (!reflection)
                        WidgetSpan(
                          alignment: PlaceholderAlignment.middle,
                          child: Tooltip(
                            message: '${item['relevance']} relevance',
                            child: Padding(
                              padding: const EdgeInsets.only(
                                right: 6,
                                bottom: 1,
                              ),
                              child: Container(
                                width: 7,
                                height: 7,
                                decoration: box(switch (item['relevance']) {
                                  'medium' => 'accent.default',
                                  'high' => 'text.warning',
                                  'critical' => 'status.danger',
                                  _ => 'text.faint',
                                }, 999),
                              ),
                            ),
                          ),
                        ),
                      TextSpan(text: normal('${item['content']}')),
                    ],
                  ),
                  maxLines: open ? null : 3,
                  overflow: open ? TextOverflow.clip : TextOverflow.ellipsis,
                  style: text(13, height: 1.45),
                ),
                const SizedBox(height: 3),
                Text.rich(
                  TextSpan(
                    children: [
                      TextSpan(
                        text: id,
                        style: const TextStyle(fontFamily: 'monospace'),
                      ),
                      TextSpan(text: metadata),
                    ],
                  ),
                  style: text(11.5, color: 'text.muted', height: 1.45),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget entries(List<Json> items, bool reflection) => Column(
    children: [
      for (final (i, item) in items.indexed) ...[
        if (i > 0) const SizedBox(height: 1),
        entry(item, reflection),
      ],
    ],
  );
  double measureText(String value, TextStyle style) {
    final painter = TextPainter(
      text: TextSpan(text: value, style: style),
      textScaler: MediaQuery.textScalerOf(context),
      textDirection: Directionality.of(context),
      locale: Localizations.maybeLocaleOf(context),
      maxLines: 1,
    )..layout();
    final width = painter.width;
    painter.dispose();
    return width;
  }

  double observationsHeaderWidth() {
    final scale = MediaQuery.textScalerOf(context).scale(11.5);
    final headingStyle = text(
      11.5,
      color: 'text.muted',
      weight: FontWeight.w600,
      height: kTextHeightNone,
    ).copyWith(letterSpacing: .02 * scale);
    final filterStyle = text(
      11.5,
      color: 'text.secondary',
      weight: FontWeight.w500,
      height: kTextHeightNone,
    );
    final headingWidth = measureText('OBSERVATIONS', headingStyle);
    final filtersWidth = ['Active', 'All', 'Dropped']
        .map((label) => measureText(label, filterStyle))
        .fold(0.0, (a, b) => a + b);
    // Three 16px button paddings, two 2px gaps, and 2px group padding.
    return headingWidth + 8 + filtersWidth + 48 + 4 + 4;
  }

  String time(num millis) {
    final d = DateTime.fromMillisecondsSinceEpoch(millis.toInt()).toLocal();
    return '${d.hour % 12 == 0 ? 12 : d.hour % 12}:${d.minute.toString().padLeft(2, '0')}:${d.second.toString().padLeft(2, '0')} ${d.hour < 12 ? 'AM' : 'PM'}';
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: state,
    builder: (context, _) {
      final panel = widget.controller.panelData, memory = state.memory;
      final now =
          (widget.clock?.call() ?? DateTime.now()).millisecondsSinceEpoch;
      final lastErrors = obj(state.runtime['lastErrors']);
      final limited = rows(
        state.runtime['rateLimited'],
      ).where((r) => (r['until'] as num? ?? 0) > now);
      final children = <Widget>[
        if (panel.error != null && panel.value == null)
          errors([Text(panel.error!)])
        else if (panel.value == null)
          empty('Loading…')
        else if (memory == null)
          empty('Memory state is unavailable for this session.')
        else if (memory['enabled'] != true)
          empty('Observational memory is disabled in this workspace’s config.')
        else ...[
          status(),
          stats(),
          meters(),
          if (lastErrors.isNotEmpty || limited.isNotEmpty)
            errors([
              for (final e in lastErrors.entries)
                Row(
                  crossAxisAlignment: CrossAxisAlignment.center,
                  children: [
                    Icon(
                      LucideIcons.circleAlert,
                      size: 13,
                      color: palette(context)['status.danger'],
                    ),
                    const SizedBox(width: 6),
                    Expanded(child: Text(normal('${e.key}: ${e.value}'))),
                  ],
                ),
              for (final r in limited)
                Text('${r['model']} rate-limited until ${time(r['until'])}'),
            ]),
          group(
            'Reflections',
            Text(
              '${state.reflections.length}',
              style: text(11.5, color: 'text.muted', weight: FontWeight.w500),
            ),
          ),
          if (state.reflections.isEmpty)
            empty('No reflections yet.')
          else
            entries(state.reflections, true),
          group('Observations', filters()),
          if (state.observations.isEmpty)
            empty('Nothing here yet.')
          else
            entries(state.observations, false),
        ],
      ];
      return LayoutBuilder(
        builder: (context, bounds) {
          final viewportWidth = bounds.maxWidth;
          final contentWidth = math.max(0.0, viewportWidth - 24).toDouble();
          final headerWidth = observationsHeaderWidth();
          final listWidth = math
              .max(viewportWidth, headerWidth + 24)
              .toDouble();
          return SingleChildScrollView(
            key: const ValueKey('memory-pane-horizontal-scroll'),
            scrollDirection: Axis.horizontal,
            child: SizedBox(
              width: listWidth,
              child: ListView(
                clipBehavior: Clip.none,
                padding: const EdgeInsets.fromLTRB(12, 12, 12, 16),
                children: [
                  for (final (i, w) in children.indexed) ...[
                    if (i > 0) SizedBox(width: contentWidth, height: 8),
                    SizedBox(
                      width:
                          w.key == const ValueKey('memory-group-observations')
                          ? math.max(contentWidth, headerWidth).toDouble()
                          : contentWidth,
                      child: w,
                    ),
                  ],
                ],
              ),
            ),
          );
        },
      );
    },
  );
}
