import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'gateway.dart';
import 'common.dart';
import 'web_controls.dart';
import 'assistant_settings.dart';
import 'memory_settings.dart';
import 'notification_settings.dart';
import 'backend_settings.dart';
import 'about_settings.dart';
import 'paired_devices.dart';

const settingsCategories = ['General', 'Memory', 'Models', 'Devices', 'About'];
Future<void> showNativeSettings(
  BuildContext context, {
  required LiveController controller,
  required VoidCallback onResetLayout,
  required ValueChanged<String> onOpenChat,
  required VoidCallback onAppOptions,
  String initialTab = 'General',
  DateTime Function()? memoryClock,
  DateTime Function()? notificationClock,
}) => showDialog<void>(
  context: context,
  useRootNavigator: false,
  barrierColor: Colors.black.withValues(alpha: .4),
  builder: (_) => NativeSettingsDialog(
    controller: controller,
    onResetLayout: onResetLayout,
    onOpenChat: onOpenChat,
    onAppOptions: onAppOptions,
    initialTab: initialTab,
    memoryClock: memoryClock,
    notificationClock: notificationClock,
  ),
);

class NativeSettingsDialog extends StatefulWidget {
  const NativeSettingsDialog({
    super.key,
    required this.controller,
    required this.onResetLayout,
    required this.onOpenChat,
    required this.onAppOptions,
    this.initialTab = 'General',
    this.memoryClock,
    this.notificationClock,
  });
  final LiveController controller;
  final VoidCallback onResetLayout, onAppOptions;
  final ValueChanged<String> onOpenChat;
  final String initialTab;
  final DateTime Function()? memoryClock;
  final DateTime Function()? notificationClock;
  @override
  State<NativeSettingsDialog> createState() => _NativeSettingsDialogState();
}

class _NativeSettingsDialogState extends State<NativeSettingsDialog> {
  late int selected = math.max(
    0,
    settingsCategories.indexOf(widget.initialTab),
  );
  final tabs = List.generate(
    settingsCategories.length,
    (i) => FocusNode(debugLabel: settingsCategories[i]),
  );
  final scroll = ScrollController();
  final closeFocus = FocusNode();
  bool saving = false;
  String? error;
  LiveController get c => widget.controller;
  @override
  void initState() {
    super.initState();
    c.addListener(update);
    FocusManager.instance.addHighlightModeListener(highlightChanged);
  }

  void highlightChanged(FocusHighlightMode _) {
    if (mounted) setState(() {});
  }

  void update() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    c.removeListener(update);
    FocusManager.instance.removeHighlightModeListener(highlightChanged);
    for (final tab in tabs) {
      tab.dispose();
    }
    scroll.dispose();
    closeFocus.dispose();
    super.dispose();
  }

  void select(int index, {bool focus = false}) {
    setState(() => selected = index);
    if (focus) tabs[index].requestFocus();
  }

  Future<void> saveDone(bool value) async {
    if (saving) return;
    setState(() {
      saving = true;
      error = null;
    });
    try {
      await c.savePreferences({'showSettled': value});
    } catch (e) {
      if (mounted) error = LiveController.describe(e);
    } finally {
      if (mounted) setState(() => saving = false);
    }
  }

  Widget general() => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      AssistantSection(
        title: 'Sessions',
        children: [
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  excludeFromSemantics: true,
                  onTap: saving
                      ? null
                      : () => saveDone(c.preferences['showSettled'] != true),
                  child: Text(
                    'Show done sessions',
                    style: webText(
                      context,
                      size: 13,
                      color: 'text.muted',
                    ).copyWith(height: kTextHeightNone),
                  ),
                ),
              ),
              const SizedBox(width: 12),
              Padding(
                padding: const EdgeInsets.fromLTRB(4, 3, 3, 3),
                child: SizedBox(
                  width: 16,
                  height: 16,
                  child: FittedBox(
                    child: SizedBox(
                      width: 18,
                      height: 18,
                      child: Checkbox(
                        value: c.preferences['showSettled'] == true,
                        onChanged: saving ? null : (v) => saveDone(v!),
                        semanticLabel: 'Show done sessions',
                        visualDensity: VisualDensity.compact,
                        materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                        shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(2),
                        ),
                        side: BorderSide(color: palette(context)['text.muted']),
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ),
          const AssistantParagraph(
            'Settled (done) sessions are hidden from project and workspace pages unless this is on. Project and workspace settings are on their own pages.',
          ),
          if (error != null)
            AssistantParagraph(error!, error: true, live: true),
        ],
      ),
      NativeNotificationSettings(
        controller: c,
        clock: widget.notificationClock,
      ),
      AssistantSection(
        title: 'Layout',
        divider: true,
        children: [
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: Text(
                  'Restore the sidebar and side panel to their default size and visibility.',
                  style: webText(
                    context,
                    size: 13,
                    color: 'text.muted',
                  ).copyWith(height: 1.5),
                ),
              ),
              const SizedBox(width: 12),
              AssistantButton('Reset', onPressed: widget.onResetLayout),
            ],
          ),
        ],
      ),
    ],
  );
  Widget navLabel(int i, bool narrow) {
    final label = Text(settingsCategories[i]);
    if (narrow) return label;
    // The browser keeps the desktop tab width at 148px and allows its inline
    // label/badge to extend into the padding at enlarged font sizes.
    return SizedBox(
      width: 128,
      child: OverflowBox(
        alignment: Alignment.centerLeft,
        minWidth: 0,
        maxWidth: double.infinity,
        child: label,
      ),
    );
  }

  Widget navButton(int i, bool narrow) => Focus(
    onKeyEvent: (_, event) {
      if (event is! KeyDownEvent) return KeyEventResult.ignored;
      final key = event.logicalKey;
      final next = key == LogicalKeyboardKey.arrowDown
          ? (i + 1) % tabs.length
          : key == LogicalKeyboardKey.arrowUp
          ? (i - 1) % tabs.length
          : key == LogicalKeyboardKey.home
          ? 0
          : key == LogicalKeyboardKey.end
          ? tabs.length - 1
          : null;
      if (next == null) return KeyEventResult.ignored;
      select(next, focus: true);
      return KeyEventResult.handled;
    },
    child: Semantics(
      selected: selected == i,
      button: true,
      child: TextButton(
        key: ValueKey('settings-tab-${settingsCategories[i]}'),
        focusNode: tabs[i]..skipTraversal = selected != i,
        onPressed: () => select(i),
        style: TextButton.styleFrom(
          alignment: Alignment.centerLeft,
          minimumSize: Size(narrow ? 0 : 148, 32),
          maximumSize: const Size(double.infinity, 32),
          padding: const EdgeInsets.symmetric(horizontal: 10),
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
          foregroundColor: palette(
            context,
          )[selected == i ? 'text.primary' : 'text.secondary'],
          backgroundColor: selected == i
              ? palette(context)['surface.subtle']
              : Colors.transparent,
          textStyle: webText(
            context,
            size: 13,
            weight: selected == i ? FontWeight.w600 : FontWeight.w400,
          ).copyWith(height: kTextHeightNone),
        ),
        child: navLabel(i, narrow),
      ),
    ),
  );
  @override
  Widget build(BuildContext context) {
    final media = MediaQuery.of(context), narrow = media.size.width <= 640;
    final colors = palette(context);
    final availableHeight =
        media.size.height -
        media.viewInsets.vertical -
        media.padding.vertical -
        40;
    final panels = [
      general(),
      MemorySettings(
        controller: c,
        clock: widget.memoryClock,
        onOpenChat: (id) {
          Navigator.pop(context);
          widget.onOpenChat(id);
        },
      ),
      BackendSettings(controller: c),
      Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          AssistantSection(
            title: 'Nodes',
            children: [
              const SizedBox(height: 8),
              if (c.nodes.isEmpty) const AssistantParagraph('No nodes online.'),
              for (final node in c.nodes)
                Container(
                  constraints: const BoxConstraints(minHeight: 34),
                  margin: const EdgeInsets.only(bottom: 2),
                  padding: const EdgeInsets.symmetric(horizontal: 10),
                  decoration: BoxDecoration(
                    color: colors['surface.subtle'],
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Row(
                    children: [
                      Container(
                        width: 8,
                        height: 8,
                        decoration: BoxDecoration(
                          color: colors['status.success'],
                          shape: BoxShape.circle,
                        ),
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Text(
                          '${node['id']}',
                          overflow: TextOverflow.ellipsis,
                          style: webText(
                            context,
                            size: 13,
                            weight: FontWeight.w500,
                          ),
                        ),
                      ),
                      const SizedBox(width: 10),
                      Text(
                        '${rows(node['workspaces']).length} workspace${rows(node['workspaces']).length == 1 ? '' : 's'}',
                        style: webText(context, size: 11, color: 'text.muted'),
                      ),
                    ],
                  ),
                ),
              AssistantParagraph('${c.nodes.length} online'),
            ],
          ),
          PairedDevices(controller: c),
        ],
      ),
      NativeAboutSettings(
        clientId: c.clientId,
        onAppOptions: widget.onAppOptions,
      ),
    ];
    final nav = narrow
        ? Wrap(
            spacing: 2,
            runSpacing: 2,
            children: [
              for (var i = 0; i < tabs.length; i++) navButton(i, true),
            ],
          )
        : SizedBox(
            width: 148,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                for (var i = 0; i < tabs.length; i++) ...[
                  navButton(i, false),
                  const SizedBox(height: 2),
                ],
              ],
            ),
          );
    final body = SingleChildScrollView(
      controller: scroll,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (var i = 0; i < panels.length; i++)
            Offstage(
              offstage: selected != i,
              child: TickerMode(enabled: selected == i, child: panels[i]),
            ),
        ],
      ),
    );
    return Dialog(
      insetPadding: const EdgeInsets.all(20),
      backgroundColor: Colors.transparent,
      elevation: 0,
      child: Container(
        key: const Key('settings-frame'),
        width: 760,
        height: math.max(0, math.min(640, availableHeight)),
        padding: const EdgeInsets.all(24),
        decoration: BoxDecoration(
          color: colors['surface.layer'],
          borderRadius: BorderRadius.circular(20),
          boxShadow: [
            BoxShadow(
              color:
                  colors[Theme.of(context).brightness == Brightness.dark
                      ? 'web.line-dark'
                      : 'web.line'],
              spreadRadius: 1,
            ),
            BoxShadow(
              color: Theme.of(context).brightness == Brightness.dark
                  ? Colors.black.withValues(alpha: .45)
                  : const Color(0xff0f1115).withValues(alpha: .12),
              offset: const Offset(0, 12),
              blurRadius: 40,
            ),
          ],
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'pirc',
                        style: webText(
                          context,
                          size: 12,
                          weight: FontWeight.w500,
                          color: 'accent.default',
                        ).copyWith(height: 18 / 12),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        'Settings',
                        style: webText(
                          context,
                          size: 18,
                          weight: FontWeight.w600,
                        ).copyWith(height: 21 / 18),
                      ),
                    ],
                  ),
                ),
                ListenableBuilder(
                  listenable: closeFocus,
                  builder: (context, _) => Stack(
                    clipBehavior: Clip.none,
                    children: [
                      if (closeFocus.hasFocus &&
                          FocusManager.instance.highlightMode ==
                              FocusHighlightMode.traditional)
                        Positioned.fill(
                          key: const ValueKey('settings-close-focus-ring'),
                          left: -4,
                          right: -4,
                          top: -4,
                          bottom: -4,
                          child: IgnorePointer(
                            child: DecoratedBox(
                              decoration: BoxDecoration(
                                border: Border.all(
                                  color: colors['accent.default'],
                                  width: 2,
                                ),
                                borderRadius: BorderRadius.circular(12),
                              ),
                            ),
                          ),
                        ),
                      WebIconButton(
                        LucideIcons.x,
                        'Close',
                        size: 32,
                        iconSize: 19,
                        focusNode: closeFocus,
                        autofocus: true,
                        onPressed: () => Navigator.pop(context),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16),
            Expanded(
              child: narrow
                  ? LayoutBuilder(
                      builder: (context, bounds) => Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          ConstrainedBox(
                            constraints: BoxConstraints(
                              maxHeight: bounds.maxHeight * .5,
                            ),
                            child: SingleChildScrollView(child: nav),
                          ),
                          const SizedBox(height: 12),
                          Expanded(child: body),
                        ],
                      ),
                    )
                  : Row(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        nav,
                        const SizedBox(width: 20),
                        Expanded(child: body),
                      ],
                    ),
            ),
          ],
        ),
      ),
    );
  }
}
