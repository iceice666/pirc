import 'dart:math' as math;
import 'dart:ui' show SemanticsRole;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'common.dart';
import 'gateway.dart';
import 'work_index.dart';
import 'modes.dart';
import 'session_row.dart';
import 'web_controls.dart';
import 'workspace_settings.dart';

class WorkspacePage extends StatefulWidget {
  const WorkspacePage({
    super.key,
    required this.controller,
    required this.workspaceId,
    required this.onBack,
    required this.onOpen,
    this.sidebarCollapsed = false,
    this.onExpand,
  });
  final LiveController controller;
  final String workspaceId;
  final bool sidebarCollapsed;
  final VoidCallback? onExpand;
  final VoidCallback onBack;
  final ValueChanged<String> onOpen;
  @override
  State<WorkspacePage> createState() => _WorkspacePageState();
}

class _WorkspacePageState extends State<WorkspacePage> {
  final query = TextEditingController();
  final _sessionsTabFocus = FocusNode(debugLabel: 'workspace-sessions-tab');
  final _settingsTabFocus = FocusNode(debugLabel: 'workspace-settings-tab');
  bool settings = false, showDone = false;
  @override
  void initState() {
    super.initState();
    _settingsTabFocus.skipTraversal = true;
    showDone = widget.controller.preferences['showSettled'] == true;
  }

  @override
  void didUpdateWidget(covariant WorkspacePage old) {
    super.didUpdateWidget(old);
    if (old.workspaceId != widget.workspaceId) {
      settings = false;
      _sessionsTabFocus.skipTraversal = false;
      _settingsTabFocus.skipTraversal = true;
      query.clear();
      showDone = widget.controller.preferences['showSettled'] == true;
    }
  }

  @override
  void dispose() {
    query.dispose();
    _sessionsTabFocus.dispose();
    _settingsTabFocus.dispose();
    super.dispose();
  }

  void _selectTab(bool showSettings, {bool moveFocus = false}) {
    _sessionsTabFocus.skipTraversal = showSettings;
    _settingsTabFocus.skipTraversal = !showSettings;
    if (settings != showSettings) {
      setState(() => settings = showSettings);
    }
    if (moveFocus) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        (showSettings ? _settingsTabFocus : _sessionsTabFocus).requestFocus();
      });
    }
  }

  KeyEventResult _handleTabKey(FocusNode _, KeyEvent event) {
    final keyboard = HardwareKeyboard.instance;
    if (event is KeyUpEvent ||
        keyboard.isAltPressed ||
        keyboard.isControlPressed ||
        keyboard.isMetaPressed) {
      return KeyEventResult.ignored;
    }
    final currentFocus = FocusManager.instance.primaryFocus;
    final current = identical(currentFocus, _settingsTabFocus)
        ? 1
        : identical(currentFocus, _sessionsTabFocus)
        ? 0
        : -1;
    if (current < 0) return KeyEventResult.ignored;
    final next = switch (event.logicalKey) {
      LogicalKeyboardKey.arrowRight => (current + 1) % 2,
      LogicalKeyboardKey.arrowLeft => (current + 1) % 2,
      LogicalKeyboardKey.home => 0,
      LogicalKeyboardKey.end => 1,
      _ => -1,
    };
    if (next < 0) return KeyEventResult.ignored;
    _selectTab(next == 1, moveFocus: true);
    return KeyEventResult.handled;
  }

  double _textWidth(BuildContext context, String text, TextStyle style) {
    final painter = TextPainter(
      text: TextSpan(text: text, style: style),
      textDirection: Directionality.of(context),
      textScaler: MediaQuery.textScalerOf(context),
      locale: Localizations.maybeLocaleOf(context),
      maxLines: 1,
    )..layout();
    return painter.width;
  }

  bool _tabsNeedCompression(
    BuildContext context,
    Json workspace,
    int unread,
    double availableWidth,
  ) {
    final labelStyle = webText(context, size: 13, weight: FontWeight.w500);
    final firstLabelWidth = _textWidth(
      context,
      widget.controller.catalog.of(workspace).nounPlural,
      labelStyle,
    );
    final countStyle = webText(context, size: 11, weight: FontWeight.w600);
    final badgeWidth = unread > 0
        ? 6 + 12 + _textWidth(context, '$unread', countStyle)
        : 0.0;
    final settingsWidth = _textWidth(context, 'Settings', labelStyle);
    const horizontalPadding = 20.0;
    const tabGap = 4.0;
    return horizontalPadding * 2 +
            firstLabelWidth +
            badgeWidth +
            settingsWidth +
            tabGap >
        availableWidth;
  }

  Widget row(Json s) => Padding(
    padding: const EdgeInsets.only(bottom: 1),
    child: SessionRow(
      key: ValueKey('workspace-${s['id']}'),
      controller: widget.controller,
      session: s,
      page: true,
      onOpen: () => widget.onOpen('${s['id']}'),
    ),
  );
  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
    final w = c.workspaces
        .where((w) => w['id'] == widget.workspaceId)
        .firstOrNull;
    if (w == null) {
      return Column(
        children: [
          WebButton('Back to the list', onPressed: widget.onBack),
          const WebNotice('This workspace is no longer available.'),
        ],
      );
    }
    final phone = MediaQuery.sizeOf(context).width <= 650;
    final mode = c.catalog.of(w);
    final noun = mode.noun;
    final readOnly = isReadOnly(w);
    final all = c.sessions.where((s) => s['workspaceId'] == w['id']).toList();
    final done = all.where(isDone).length,
        unread = all.where((s) => s['unread'] == true).length;
    final listed = pinnedFirst(
      all.where(
        (s) =>
            (showDone || query.text.isNotEmpty || !isDone(s)) &&
            '${s['name']}'.toLowerCase().contains(query.text.toLowerCase()),
      ),
    );
    final online = workspaceOnline(w, c.nodes);
    return Material(
      color: palette(context)['surface.page'],
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            key: const Key('workspace-page-header'),
            constraints: const BoxConstraints(minHeight: 56),
            padding: EdgeInsets.only(
              left: phone ? 8 : 20,
              right: phone ? 12 : 20,
            ),
            child: Row(
              children: [
                if (phone) ...[
                  WebIconButton(
                    LucideIcons.chevronLeft,
                    'Back to the list',
                    size: 36,
                    iconSize: 22,
                    onPressed: widget.onBack,
                  ),
                  const SizedBox(width: 8),
                ],
                if (!phone && widget.sidebarCollapsed)
                  WebIconButton(
                    LucideIcons.panelLeftOpen,
                    'Expand sidebar',
                    onPressed: widget.onExpand,
                  ),
                Icon(
                  LucideIcons.folder,
                  size: 18,
                  color: palette(context)['text.secondary'],
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.baseline,
                    textBaseline: TextBaseline.alphabetic,
                    children: [
                      Flexible(
                        child: Text(
                          '${w['displayName']}',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: webText(
                            context,
                            size: 15,
                            weight: FontWeight.w600,
                          ),
                        ),
                      ),
                      if (!phone) ...[
                        const SizedBox(width: 10),
                        Flexible(
                          fit: FlexFit.loose,
                          child: Text(
                            '${mode.repository ? 'Workspace' : mode.label} · ${w['hostId']}${online ? '' : ' · offline'}',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: webText(
                              context,
                              size: 12,
                              color: 'text.muted',
                            ),
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              ],
            ),
          ),
          if (readOnly)
            const Padding(
              padding: EdgeInsets.symmetric(horizontal: 20),
              child: WebNotice(workspaceUnavailableNotice),
            ),
          LayoutBuilder(
            builder: (context, size) {
              final horizontalPadding = phone
                  ? 12.0
                  : math.max(22.0, (size.maxWidth - 780) / 2 + 22);
              final compressed = _tabsNeedCompression(
                context,
                w,
                unread,
                size.maxWidth - horizontalPadding * 2,
              );

              Widget tabButton(bool tab) {
                final tabLabel = tab ? 'Settings' : mode.nounPlural;
                final tabWidget = Semantics(
                  key: Key(
                    tab ? 'workspace-tab-settings' : 'workspace-tab-sessions',
                  ),
                  role: SemanticsRole.tab,
                  label: tab
                      ? 'Settings'
                      : '${mode.nounPlural}${unread > 0 ? ', $unread unread' : ''}',
                  selected: settings == tab,
                  child: InkWell(
                    focusNode: tab ? _settingsTabFocus : _sessionsTabFocus,
                    onTap: () => _selectTab(tab, moveFocus: true),
                    child: Container(
                      height: 36,
                      padding: const EdgeInsets.symmetric(horizontal: 10),
                      alignment: Alignment.center,
                      decoration: BoxDecoration(
                        border: Border(
                          bottom: BorderSide(
                            width: 2,
                            color: settings == tab
                                ? palette(context)['accent.default']
                                : Colors.transparent,
                          ),
                        ),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          if (compressed)
                            Flexible(
                              child: Text(
                                tabLabel,
                                maxLines: 1,
                                softWrap: false,
                                overflow: TextOverflow.ellipsis,
                                style: webText(
                                  context,
                                  size: 13,
                                  weight: FontWeight.w500,
                                  color: settings == tab
                                      ? 'text.primary'
                                      : 'text.muted',
                                ).copyWith(height: kTextHeightNone),
                              ),
                            )
                          else
                            Text(
                              tabLabel,
                              maxLines: 1,
                              softWrap: false,
                              style: webText(
                                context,
                                size: 13,
                                weight: FontWeight.w500,
                                color: settings == tab
                                    ? 'text.primary'
                                    : 'text.muted',
                              ).copyWith(height: kTextHeightNone),
                            ),
                          if (!tab && unread > 0) ...[
                            const SizedBox(width: 6),
                            Container(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 6,
                              ),
                              decoration: BoxDecoration(
                                color: palette(context)['accent.default'],
                                borderRadius: BorderRadius.circular(999),
                              ),
                              child: Text(
                                '$unread',
                                style: webText(
                                  context,
                                  size: 11,
                                  weight: FontWeight.w600,
                                  color: 'accent.on',
                                ).copyWith(height: kTextHeightNone),
                              ),
                            ),
                          ],
                        ],
                      ),
                    ),
                  ),
                );
                return compressed
                    ? Flexible(fit: FlexFit.loose, child: tabWidget)
                    : tabWidget;
              }

              return Container(
                key: const Key('workspace-page-tabs'),
                padding: EdgeInsets.symmetric(horizontal: horizontalPadding),
                decoration: BoxDecoration(
                  border: Border(
                    bottom: BorderSide(color: palette(context)['line.default']),
                  ),
                ),
                child: Focus(
                  canRequestFocus: false,
                  onKeyEvent: _handleTabKey,
                  child: Semantics(
                    role: SemanticsRole.tabBar,
                    label: '${w['displayName']} sections',
                    explicitChildNodes: true,
                    child: Row(
                      children: [
                        tabButton(false),
                        const SizedBox(width: 4),
                        tabButton(true),
                      ],
                    ),
                  ),
                ),
              );
            },
          ),
          Expanded(
            child: Semantics(
              role: SemanticsRole.tabPanel,
              label: settings ? 'Settings' : 'Sessions',
              explicitChildNodes: true,
              child: SingleChildScrollView(
                child: Align(
                  alignment: Alignment.topCenter,
                  child: ConstrainedBox(
                    key: const Key('workspace-page-body'),
                    constraints: const BoxConstraints(maxWidth: 780),
                    child: Padding(
                      padding: phone
                          ? const EdgeInsets.fromLTRB(10, 8, 10, 72)
                          : const EdgeInsets.fromLTRB(32, 16, 32, 48),
                      child: settings
                          ? WorkspaceSettings(
                              key: ValueKey(w['id']),
                              controller: c,
                              workspace: w,
                            )
                          : Column(
                              crossAxisAlignment: CrossAxisAlignment.stretch,
                              children: [
                                Row(
                                  key: const Key('workspace-page-list-tools'),
                                  children: [
                                    Expanded(
                                      child: WebSearch(
                                        controller: query,
                                        label: 'Search ${noun}s',
                                        onChanged: (_) => setState(() {}),
                                      ),
                                    ),
                                    if (done > 0 || showDone) ...[
                                      const SizedBox(width: 8),
                                      WebButton(
                                        showDone
                                            ? 'Hide done'
                                            : 'Show done · $done',
                                        height: 30,
                                        fontSize: 12,
                                        horizontalPadding: 10,
                                        muted: true,
                                        onPressed: () => setState(
                                          () => showDone = !showDone,
                                        ),
                                      ),
                                    ],
                                  ],
                                ),
                                const SizedBox(height: 8),
                                for (final s in listed) row(s),
                                if (listed.isEmpty)
                                  Padding(
                                    padding: const EdgeInsets.all(12),
                                    child: Text(
                                      query.text.isNotEmpty
                                          ? 'Nothing matches.'
                                          : done > 0
                                          ? 'Every $noun here is done.'
                                          : 'No ${noun}s yet.',
                                      style: webText(
                                        context,
                                        size: 13,
                                        color: 'text.muted',
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
          ),
        ],
      ),
    );
  }
}
