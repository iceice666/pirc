import 'dart:math' as math;
import 'dart:ui' show SemanticsRole;
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'common.dart';
import 'web_controls.dart';

const panelTabs = [
  ('files', 'Files', LucideIcons.folderTree),
  ('git', 'Git', LucideIcons.gitBranch),
  ('memory', 'Memory', LucideIcons.brain),
  ('context', 'Context', LucideIcons.scanText),
  ('tasks', 'Tasks', LucideIcons.listChecks),
  ('terminals', 'Terminal', LucideIcons.squareTerminal),
  ('browser', 'Browser', LucideIcons.globe),
];

double sidePanelMax(double viewport, bool collapsed) =>
    math.max(280, viewport - (collapsed ? 0 : 264) - 380);

/// Pinned SidePanel.svelte chrome; tab contents own their scrolling and state.
class NativeSidePanel extends StatefulWidget {
  const NativeSidePanel({
    super.key,
    required this.tab,
    this.git = true,
    this.terminal = true,
    required this.open,
    required this.overlay,
    required this.width,
    required this.maxWidth,
    required this.onSelect,
    required this.onResize,
    required this.child,
    this.activity = const {},
    this.touch,
  });
  final String tab;

  /// Capability-driven tabs: Git for repositories, Terminal for workspaces
  /// whose sessions share one directory.
  final bool git, terminal, open, overlay;
  final bool? touch;
  final double width, maxWidth;
  final ValueChanged<String> onSelect;
  final ValueChanged<double> onResize;
  final Map<String, int> activity;
  final Widget child;
  @override
  State<NativeSidePanel> createState() => _NativeSidePanelState();
}

class _NativeSidePanelState extends State<NativeSidePanel> {
  final nodes = {for (final t in panelTabs) t.$1: FocusNode()};
  final resizeFocus = FocusNode();
  bool dragging = false, hover = false;
  double startX = 0, startWidth = 0;
  List<(String, String, IconData)> get tabs => panelTabs
      .where(
        (t) =>
            (t.$1 != 'git' || widget.git) &&
            (t.$1 != 'terminals' || widget.terminal),
      )
      .toList();
  @override
  void initState() {
    super.initState();
    focusTab();
  }

  @override
  void didUpdateWidget(NativeSidePanel old) {
    super.didUpdateWidget(old);
    if (widget.open && widget.overlay && (!old.open || !old.overlay)) {
      focusTab();
    }
  }

  void focusTab() {
    if (!widget.overlay || !widget.open) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && widget.open) nodes[widget.tab]?.requestFocus();
    });
  }

  void resize(double value) =>
      widget.onResize(value.clamp(280, widget.maxWidth).roundToDouble());
  KeyEventResult tabKey(String id, KeyEvent e) {
    if (e is! KeyDownEvent && e is! KeyRepeatEvent) {
      return KeyEventResult.ignored;
    }
    final i = tabs.indexWhere((t) => t.$1 == id), k = e.logicalKey;
    final next =
        k == LogicalKeyboardKey.arrowRight || k == LogicalKeyboardKey.arrowDown
        ? (i + 1) % tabs.length
        : k == LogicalKeyboardKey.arrowLeft || k == LogicalKeyboardKey.arrowUp
        ? (i - 1 + tabs.length) % tabs.length
        : k == LogicalKeyboardKey.home
        ? 0
        : k == LogicalKeyboardKey.end
        ? tabs.length - 1
        : null;
    if (next == null) return KeyEventResult.ignored;
    widget.onSelect(tabs[next].$1);
    final node = nodes[tabs[next].$1]!;
    node.requestFocus();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && node.context != null) {
        Scrollable.ensureVisible(node.context!);
      }
    });
    return KeyEventResult.handled;
  }

  @override
  void dispose() {
    for (final n in nodes.values) {
      n.dispose();
    }
    resizeFocus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = palette(context);
    final touch =
        widget.touch ??
        [
          TargetPlatform.android,
          TargetPlatform.iOS,
        ].contains(defaultTargetPlatform);
    final phone = MediaQuery.sizeOf(context).width <= 650;
    return Semantics(
      label: 'Session side panel',
      container: true,
      child: Material(
        color: colors[widget.overlay ? 'web.bg-layer' : 'web.bg-sidebar'],
        child: DecoratedBox(
          decoration: BoxDecoration(
            border: widget.overlay
                ? null
                : Border(left: BorderSide(color: colors['web.line'])),
          ),
          child: Padding(
            padding: EdgeInsets.only(left: widget.overlay ? 0 : 1),
            child: Stack(
              children: [
                Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Container(
                      key: const Key('side-panel-tabs'),
                      decoration: BoxDecoration(
                        border: Border(
                          bottom: BorderSide(color: colors['web.line']),
                        ),
                      ),
                      padding: const EdgeInsets.fromLTRB(8, 8, 8, 6),
                      child: LayoutBuilder(
                        builder: (context, bounds) => SingleChildScrollView(
                          scrollDirection: Axis.horizontal,
                          child: Row(
                            children: [
                              for (final (i, t) in tabs.indexed) ...[
                                if (i > 0) const SizedBox(width: 2),
                                Focus(
                                  onKeyEvent: (_, e) => tabKey(t.$1, e),
                                  skipTraversal: true,
                                  child: ListenableBuilder(
                                    listenable: nodes[t.$1]!,
                                    builder: (context, _) {
                                      final selected = widget.tab == t.$1,
                                          focused = nodes[t.$1]!.hasFocus;
                                      return Semantics(
                                        role: SemanticsRole.tab,
                                        container: true,
                                        excludeSemantics: true,
                                        focusable: true,
                                        focused: focused,
                                        onTap: () => widget.onSelect(t.$1),
                                        selected: selected,
                                        label:
                                            '${t.$2}${(widget.activity[t.$1] ?? 0) > 0 ? ' (activity)' : ''}',
                                        child: Tooltip(
                                          message: t.$2,
                                          child: Stack(
                                            children: [
                                              SizedBox(
                                                height: touch ? 40 : 30,
                                                child: TextButton(
                                                  key: ValueKey(
                                                    'panel-tab-${t.$1}',
                                                  ),
                                                  focusNode: nodes[t.$1]!
                                                    ..skipTraversal = !selected,
                                                  onPressed: () =>
                                                      widget.onSelect(t.$1),
                                                  style: TextButton.styleFrom(
                                                    minimumSize: Size.zero,
                                                    padding:
                                                        EdgeInsets.symmetric(
                                                          horizontal: touch
                                                              ? 12
                                                              : 9,
                                                        ),
                                                    tapTargetSize:
                                                        MaterialTapTargetSize
                                                            .shrinkWrap,
                                                    backgroundColor: selected
                                                        ? colors['web.bg-active']
                                                        : Colors.transparent,
                                                    foregroundColor:
                                                        colors[selected
                                                            ? 'text.primary'
                                                            : 'text.muted'],
                                                    shape: RoundedRectangleBorder(
                                                      borderRadius:
                                                          BorderRadius.circular(
                                                            6,
                                                          ),
                                                      side:
                                                          focused &&
                                                              FocusManager
                                                                      .instance
                                                                      .highlightMode ==
                                                                  FocusHighlightMode
                                                                      .traditional
                                                          ? BorderSide(
                                                              color:
                                                                  colors['accent.default'],
                                                              width: 2,
                                                            )
                                                          : BorderSide.none,
                                                    ),
                                                    textStyle: webText(
                                                      context,
                                                      size: 12.5,
                                                      weight: FontWeight.w500,
                                                    ),
                                                  ),
                                                  child: Row(
                                                    mainAxisSize:
                                                        MainAxisSize.min,
                                                    children: [
                                                      Icon(t.$3, size: 16),
                                                      if (!phone &&
                                                          (bounds.maxWidth +
                                                                      16 >
                                                                  459 ||
                                                              selected)) ...[
                                                        const SizedBox(
                                                          width: 6,
                                                        ),
                                                        Text(t.$2),
                                                      ],
                                                    ],
                                                  ),
                                                ),
                                              ),
                                              if ((widget.activity[t.$1] ?? 0) >
                                                  0)
                                                Positioned(
                                                  top: 5,
                                                  right: 5,
                                                  child: IgnorePointer(
                                                    child: Container(
                                                      width: 6,
                                                      height: 6,
                                                      decoration: BoxDecoration(
                                                        shape: BoxShape.circle,
                                                        color:
                                                            colors['accent.default'],
                                                      ),
                                                    ),
                                                  ),
                                                ),
                                            ],
                                          ),
                                        ),
                                      );
                                    },
                                  ),
                                ),
                              ],
                            ],
                          ),
                        ),
                      ),
                    ),
                    Expanded(
                      child: Semantics(
                        role: SemanticsRole.tabPanel,
                        container: true,
                        label: tabs
                            .firstWhere(
                              (t) => t.$1 == widget.tab,
                              orElse: () => tabs.first,
                            )
                            .$2,
                        child: widget.child,
                      ),
                    ),
                  ],
                ),
                if (!widget.overlay)
                  Positioned(
                    left: 0,
                    top: 0,
                    bottom: 0,
                    width: 7,
                    child: ListenableBuilder(
                      listenable: resizeFocus,
                      builder: (context, _) => Focus(
                        focusNode: resizeFocus,
                        onKeyEvent: (_, e) {
                          if (e is! KeyDownEvent && e is! KeyRepeatEvent) {
                            return KeyEventResult.ignored;
                          }
                          final step = HardwareKeyboard.instance.isShiftPressed
                                  ? 64.0
                                  : 16.0,
                              k = e.logicalKey;
                          final next = k == LogicalKeyboardKey.arrowLeft
                              ? widget.width + step
                              : k == LogicalKeyboardKey.arrowRight
                              ? widget.width - step
                              : k == LogicalKeyboardKey.home
                              ? widget.maxWidth
                              : k == LogicalKeyboardKey.end
                              ? 280.0
                              : null;
                          if (next == null) return KeyEventResult.ignored;
                          resize(next);
                          return KeyEventResult.handled;
                        },
                        child: Semantics(
                          label: 'Resize side panel',
                          value: '${widget.width.round()}',
                          increasedValue:
                              '${(widget.width + 16).clamp(280, widget.maxWidth).round()}',
                          decreasedValue:
                              '${(widget.width - 16).clamp(280, widget.maxWidth).round()}',
                          onIncrease: () => resize(widget.width + 16),
                          onDecrease: () => resize(widget.width - 16),
                          child: Tooltip(
                            message: 'Drag to resize · double-click to reset',
                            child: MouseRegion(
                              cursor: SystemMouseCursors.resizeColumn,
                              onEnter: (_) => setState(() => hover = true),
                              onExit: (_) => setState(() => hover = false),
                              child: GestureDetector(
                                key: const Key('panel-resizer'),
                                behavior: HitTestBehavior.opaque,
                                onHorizontalDragStart: (d) {
                                  startX = d.globalPosition.dx;
                                  startWidth = widget.width;
                                  setState(() => dragging = true);
                                },
                                onHorizontalDragUpdate: (d) => resize(
                                  startWidth + startX - d.globalPosition.dx,
                                ),
                                onHorizontalDragEnd: (_) =>
                                    setState(() => dragging = false),
                                onHorizontalDragCancel: () =>
                                    setState(() => dragging = false),
                                onDoubleTap: () => resize(360),
                                child: Align(
                                  alignment: Alignment.centerLeft,
                                  child: Container(
                                    width: 2,
                                    color:
                                        hover ||
                                            dragging ||
                                            resizeFocus.hasFocus
                                        ? colors['accent.default']
                                        : Colors.transparent,
                                  ),
                                ),
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
