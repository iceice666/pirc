import '../l10n/app_i18n.dart';
import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'common.dart';
import 'gateway.dart';
import 'dock_models.dart';
import 'web_controls.dart';

/// Applies the composer dock's one-pixel negative bottom margin.
class ComposerDockOverlap extends SingleChildRenderObjectWidget {
  const ComposerDockOverlap({super.key, required super.child});

  @override
  RenderObject createRenderObject(BuildContext context) =>
      _RenderComposerDockOverlap();
}

class _RenderComposerDockOverlap extends RenderProxyBox {
  @override
  void performLayout() {
    final child = this.child;
    if (child == null) {
      size = constraints.smallest;
      return;
    }
    child.layout(constraints, parentUsesSize: true);
    size = constraints.constrain(
      Size(child.size.width, math.max(0, child.size.height - 1)),
    );
  }

  @override
  Size computeDryLayout(BoxConstraints constraints) {
    final child = this.child;
    if (child == null) return constraints.smallest;
    final childSize = child.getDryLayout(constraints);
    return constraints.constrain(
      Size(childSize.width, math.max(0, childSize.height - 1)),
    );
  }
}

class ComposerDock extends StatefulWidget {
  const ComposerDock({super.key, required this.controller});
  final LiveController controller;
  @override
  State<ComposerDock> createState() => _ComposerDockState();
}

class _ComposerDockState extends State<ComposerDock> {
  bool goalOpen = false, todoOpen = false, queueOpen = true;
  LiveController get c => widget.controller;
  @override
  void initState() {
    super.initState();
    goalOpen = c.preferences['goalExpanded'] == true;
    todoOpen = c.preferences['todoExpanded'] == true;
  }

  @override
  void didUpdateWidget(covariant ComposerDock oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (rows(c.state['queue']).isEmpty) queueOpen = true;
  }

  void toggle(String section) {
    setState(() {
      if (section == 'Goal') {
        goalOpen = !goalOpen;
        c.setDockExpanded('goalExpanded', goalOpen);
      } else if (section == 'Tasks') {
        todoOpen = !todoOpen;
        c.setDockExpanded('todoExpanded', todoOpen);
      } else {
        queueOpen = !queueOpen;
      }
    });
  }

  Widget tag(
    String text, {
    String color = 'text.muted',
    bool warning = false,
  }) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 6),
    decoration: BoxDecoration(
      color: palette(context)[warning ? 'status.warningSoft' : 'web.bg-hover'],
      borderRadius: BorderRadius.circular(4),
    ),
    child: Text(
      text,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: webText(context, size: 11, color: color).copyWith(height: 18 / 11),
    ),
  );
  Widget count(String value) => Text(
    value,
    style: webText(
      context,
      size: 12,
      color: 'text.muted',
    ).copyWith(fontFeatures: const [FontFeature.tabularFigures()]),
  );
  Widget body({
    required double maxHeight,
    required EdgeInsets padding,
    required Widget child,
  }) => ConstrainedBox(
    constraints: BoxConstraints(maxHeight: maxHeight),
    child: SingleChildScrollView(padding: padding, child: child),
  );
  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    final goal = parseGoalWidget(obj(c.state['widgets'])['goal']);
    final todo = parseTodoWidget(obj(c.state['widgets'])['local-todo']);
    final queue = rows(c.state['queue']);
    if (queue.isEmpty) queueOpen = true;
    if (goal == null && todo == null && queue.isEmpty) {
      return const SizedBox.shrink();
    }
    final phone = MediaQuery.sizeOf(context).width <= 650;
    final sections = <Widget>[
      if (goal != null)
        _DockSection(
          label: tr("Goal"),
          expanded: goalOpen,
          onToggle: () => toggle(tr("Goal")),
          title: goal.objective,
          active: goal.running,
          lead: goal.running
              ? const DockStateDot('ongoing')
              : const Icon(LucideIcons.target, size: 14),
          metadata: [
            tag(
              goal.phaseLabel,
              color: goal.disarmed || goal.phase == 'blocked'
                  ? 'status.warning'
                  : goal.phase == 'complete'
                  ? 'status.success'
                  : goal.running
                  ? 'accent.default'
                  : 'text.muted',
              warning: goal.disarmed || goal.phase == 'blocked',
            ),
            Tooltip(
              message: tr("Continuation rounds"),
              child: count(goal.count),
            ),
          ],
          action: goal.running || goal.canResume
              ? _DockAction(
                  goal.running ? tr("Pause") : tr("Resume"),
                  onPressed: c.canWrite
                      ? () => c.sendCommand({
                          'type': 'steer',
                          'message':
                              '/goal ${goal.running ? 'pause' : 'resume'}',
                        })
                      : null,
                )
              : null,
          child: body(
            maxHeight: 180,
            padding: const EdgeInsets.fromLTRB(32, 0, 14, 10),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  goal.objective,
                  style: webText(
                    context,
                    size: 13,
                    color: 'text.secondary',
                  ).copyWith(height: 20 / 13),
                ),
                if (goal.reason != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Padding(
                          padding: const EdgeInsets.only(top: 6),
                          child: DockStateDot(goal.dot),
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            goal.reason!,
                            style: webText(
                              context,
                              size: 13,
                              color: 'text.muted',
                            ).copyWith(height: 20 / 13),
                          ),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
        ),
      if (todo != null)
        _DockSection(
          label: tr("Tasks"),
          expanded: todoOpen,
          onToggle: () => toggle(tr("Tasks")),
          title: todo.headline,
          active: todo.active.isNotEmpty,
          lead: todo.active.isNotEmpty
              ? const DockStateDot('ongoing')
              : const Icon(LucideIcons.listChecks, size: 14),
          metadata: [
            Semantics(
              label: tr("{0} of {1} completed", [todo.done, todo.total]),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Container(
                    width: 36,
                    height: 3,
                    clipBehavior: Clip.hardEdge,
                    decoration: BoxDecoration(
                      color: palette(context)['web.line-dark'],
                      borderRadius: BorderRadius.circular(999),
                    ),
                    child: Align(
                      alignment: Alignment.centerLeft,
                      child: FractionallySizedBox(
                        widthFactor: (todo.done / todo.total).clamp(0.0, 1.0),
                        heightFactor: 1,
                        child: ColoredBox(
                          color: palette(context)['status.success'],
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 6),
                  count('${todo.done}/${todo.total}'),
                ],
              ),
            ),
          ],
          child: body(
            maxHeight: phone ? 160 : 220,
            padding: const EdgeInsets.fromLTRB(8, 0, 8, 8),
            child: Column(
              children: [
                for (final (index, item) in todo.items.indexed)
                  Padding(
                    padding: EdgeInsets.only(top: index == 0 ? 0 : 1),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 6,
                        vertical: 4,
                      ),
                      child: LayoutBuilder(
                        builder: (context, bounds) => Row(
                          children: [
                            Padding(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 3,
                              ),
                              child: Semantics(
                                label: item.status == 'completed'
                                    ? tr("Completed")
                                    : item.status == 'in_progress'
                                    ? tr("In progress")
                                    : tr("Pending"),
                                child: DockStateDot(item.dot),
                              ),
                            ),
                            const SizedBox(width: 9),
                            Expanded(
                              child: Text(
                                item.text,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style:
                                    webText(
                                      context,
                                      size: 13,
                                      weight: item.status == 'in_progress'
                                          ? FontWeight.w500
                                          : FontWeight.w400,
                                      color: item.status == 'completed'
                                          ? 'text.muted'
                                          : item.status == 'in_progress'
                                          ? 'text.primary'
                                          : 'text.secondary',
                                    ).copyWith(
                                      height: 20 / 13,
                                      decoration: item.status == 'completed'
                                          ? TextDecoration.lineThrough
                                          : null,
                                      decorationColor: palette(
                                        context,
                                      )['text.faint'],
                                    ),
                              ),
                            ),
                            if (item.category != null &&
                                item.category!.isNotEmpty) ...[
                              const SizedBox(width: 9),
                              ConstrainedBox(
                                constraints: BoxConstraints(
                                  maxWidth: bounds.maxWidth * .28,
                                ),
                                child: Tooltip(
                                  message: item.category!,
                                  child: tag(item.category!),
                                ),
                              ),
                            ],
                            if (item.blocked) ...[
                              const SizedBox(width: 9),
                              ConstrainedBox(
                                constraints: BoxConstraints(
                                  maxWidth: bounds.maxWidth * .28,
                                ),
                                child: tag(
                                  'blocked',
                                  warning: true,
                                  color: 'status.warning',
                                ),
                              ),
                            ],
                          ],
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ),
      if (queue.isNotEmpty)
        _DockSection(
          label: tr("Queued messages"),
          expanded: queueOpen,
          onToggle: () => toggle(tr("Queued messages")),
          title: tr("{0} queued", [queue.length]),
          lead: const Icon(LucideIcons.listOrdered, size: 14),
          metadata: const [],
          action: _DockAction(
            tr("Clear"),
            onPressed: c.canWrite
                ? () => c.sendCommand({'type': 'clear_queue'})
                : null,
          ),
          child: body(
            maxHeight: phone ? 88 : 168,
            padding: const EdgeInsets.fromLTRB(8, 0, 8, 8),
            child: Column(
              children: [
                for (final (index, item) in queue.indexed)
                  Container(
                    key: ValueKey('composer-queue-row-$index'),
                    decoration: BoxDecoration(
                      border: index == 0
                          ? null
                          : Border(
                              top: BorderSide(
                                color: palette(context)['web.line'],
                              ),
                            ),
                    ),
                    child: Stack(
                      clipBehavior: Clip.none,
                      children: [
                        Padding(
                          padding: const EdgeInsets.all(6),
                          child: Row(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Tooltip(
                                message: item['kind'] == 'steer'
                                    ? tr("Steer")
                                    : tr("Follow up"),
                                child: SizedBox(
                                  width: 20,
                                  height: 20,
                                  child: Icon(
                                    item['kind'] == 'steer'
                                        ? LucideIcons.navigation
                                        : LucideIcons.cornerDownRight,
                                    size: 13,
                                    color: palette(context)['accent.default'],
                                  ),
                                ),
                              ),
                              const SizedBox(width: 8),
                              Expanded(
                                child: Text(
                                  '${item['content']}',
                                  maxLines: 2,
                                  overflow: TextOverflow.ellipsis,
                                  style: webText(
                                    context,
                                    size: 13,
                                  ).copyWith(height: 20 / 13),
                                ),
                              ),
                              const SizedBox(width: 8),
                              const SizedBox(width: 26, height: 20),
                            ],
                          ),
                        ),
                        Positioned(
                          top: 3,
                          right: 6,
                          child: WebIconButton(
                            LucideIcons.sendHorizontal,
                            tr("Send now: {0}", [item['content']]),
                            size: 26,
                            iconSize: 14,
                            onPressed: c.canWrite
                                ? () => c.sendCommand({
                                    'type': 'send_now',
                                    'queue': item['kind'] == 'follow_up'
                                        ? 'followUp'
                                        : 'steering',
                                    'index': item['index'],
                                    'message': item['content'],
                                  })
                                : null,
                          ),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
        ),
    ];
    return LayoutBuilder(
      builder: (context, bounds) {
        final width = math.max(0.0, bounds.maxWidth - (phone ? 24 : 40));
        return Align(
          heightFactor: 1,
          alignment: Alignment.bottomCenter,
          child: Container(
            width: width,
            clipBehavior: Clip.hardEdge,
            decoration: BoxDecoration(
              color: palette(context)['web.bg-subtle'],
              borderRadius: const BorderRadius.vertical(
                top: Radius.circular(16),
              ),
              boxShadow: [
                BoxShadow(
                  color: palette(context)['web.line-dark'],
                  spreadRadius: 1,
                ),
              ],
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                for (final (index, section) in sections.indexed) ...[
                  if (index > 0)
                    Divider(
                      height: 1,
                      thickness: 1,
                      color: palette(context)['web.line-dark'],
                    ),
                  section,
                ],
              ],
            ),
          ),
        );
      },
    );
  }
}

class _DockAction extends StatelessWidget {
  const _DockAction(this.label, {required this.onPressed});
  final String label;
  final VoidCallback? onPressed;
  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    return TextButton(
      onPressed: onPressed,
      style: TextButton.styleFrom(
        minimumSize: const Size(0, 40),
        padding: const EdgeInsets.symmetric(horizontal: 12),
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
        foregroundColor: palette(context)['text.secondary'],
        disabledForegroundColor: palette(context)['text.faint'],
        textStyle: webText(context, size: 12.5, color: 'text.secondary'),
      ),
      child: Text(label),
    );
  }
}

class _DockSection extends StatelessWidget {
  const _DockSection({
    required this.label,
    required this.title,
    required this.expanded,
    required this.onToggle,
    required this.lead,
    required this.metadata,
    required this.child,
    this.active = false,
    this.action,
  });
  final String label, title;
  final bool expanded, active;
  final VoidCallback onToggle;
  final Widget lead, child;
  final List<Widget> metadata;
  final Widget? action;
  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 44),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(4, 2, 6, 2),
            child: Row(
              children: [
                Expanded(
                  child: Semantics(
                    label: label,
                    expanded: expanded,
                    button: true,
                    child: Tooltip(
                      message: label,
                      child: InkWell(
                        onTap: onToggle,
                        borderRadius: BorderRadius.circular(8),
                        child: ConstrainedBox(
                          constraints: const BoxConstraints(minHeight: 40),
                          child: Padding(
                            padding: const EdgeInsets.symmetric(horizontal: 8),
                            child: LayoutBuilder(
                              builder: (context, bounds) {
                                final wrap =
                                    MediaQuery.textScalerOf(
                                          context,
                                        ).scale(12.5) >
                                        18 ||
                                    bounds.maxWidth < 220;
                                final heading = Row(
                                  children: [
                                    SizedBox(
                                      width: 14,
                                      child: IconTheme(
                                        data: IconThemeData(
                                          color: palette(context)['text.muted'],
                                        ),
                                        child: Center(child: lead),
                                      ),
                                    ),
                                    const SizedBox(width: 6),
                                    Flexible(
                                      fit: label == 'Queued messages'
                                          ? FlexFit.loose
                                          : FlexFit.tight,
                                      child: Text(
                                        title,
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                        style: webText(
                                          context,
                                          size: 12.5,
                                          weight: FontWeight.w500,
                                          color: active
                                              ? 'text.primary'
                                              : 'text.secondary',
                                        ),
                                      ),
                                    ),
                                    if (!wrap) ...[
                                      for (final item in metadata) ...[
                                        const SizedBox(width: 6),
                                        item,
                                      ],
                                    ],
                                    const SizedBox(width: 6),
                                    Icon(
                                      expanded
                                          ? LucideIcons.chevronDown
                                          : LucideIcons.chevronUp,
                                      size: 14,
                                      color: palette(context)['text.muted'],
                                    ),
                                  ],
                                );
                                return Column(
                                  mainAxisSize: MainAxisSize.min,
                                  mainAxisAlignment: MainAxisAlignment.center,
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    heading,
                                    if (wrap && metadata.isNotEmpty)
                                      Padding(
                                        padding: const EdgeInsets.only(
                                          left: 20,
                                          top: 4,
                                          bottom: 4,
                                        ),
                                        child: Wrap(
                                          spacing: 6,
                                          runSpacing: 4,
                                          children: metadata,
                                        ),
                                      ),
                                  ],
                                );
                              },
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
                ?action,
              ],
            ),
          ),
        ),
        if (expanded) child,
      ],
    );
  }
}

class DockStateDot extends StatelessWidget {
  const DockStateDot(this.state, {super.key});
  final String state;
  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    return Container(
      width: 7,
      height: 7,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: state == 'idle'
            ? Colors.transparent
            : palette(context)[state == 'ongoing'
                  ? 'accent.default'
                  : state == 'done'
                  ? 'status.success'
                  : 'status.danger'],
        border: state == 'idle'
            ? Border.all(color: palette(context)['text.faint'], width: 1.5)
            : null,
      ),
    );
  }
}
