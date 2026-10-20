import 'dart:math' as math;
import 'dart:ui' show SemanticsRole;

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'common.dart';
import 'gateway.dart';
import 'work_index.dart';
import 'modes.dart';
import 'web_controls.dart';
import 'session_row.dart';
import 'workspace_dialogs.dart';

class SessionSidebar extends StatefulWidget {
  const SessionSidebar({
    super.key,
    required this.controller,
    required this.onOpen,
    required this.onWorkspace,
    required this.onPage,
    required this.onCollapse,
    this.activeId,
    this.workspaceId,
  });
  final LiveController controller;
  final ValueChanged<String> onOpen, onWorkspace, onPage;
  final VoidCallback onCollapse;
  final String? activeId, workspaceId;
  @override
  State<SessionSidebar> createState() => _SessionSidebarState();
}

class _SessionSidebarState extends State<SessionSidebar> {
  final search = TextEditingController();
  String? revealedSessionId;
  LiveController get c => widget.controller;
  @override
  void dispose() {
    search.dispose();
    super.dispose();
  }

  Widget heading(
    String label, {
    Widget? leading,
    Widget? trailing,
    bool attention = false,
  }) => Container(
    height: 26,
    padding: const EdgeInsets.symmetric(horizontal: 8),
    child: Row(
      children: [
        if (leading != null) ...[leading, const SizedBox(width: 6)],
        Expanded(
          child: Text(
            leading == null ? label.toUpperCase() : label,
            style: webText(
              context,
              size: 11,
              weight: FontWeight.w600,
              color: attention ? 'status.warning' : 'text.muted',
            ).copyWith(letterSpacing: .44, height: kTextHeightNone),
          ),
        ),
        ?trailing,
      ],
    ),
  );
  Widget note(String text, {double inset = 10}) => Padding(
    padding: EdgeInsets.fromLTRB(inset, 2, inset, 6),
    child: Text(
      text,
      style: webText(
        context,
        size: 12,
        color: 'text.muted',
      ).copyWith(height: kTextHeightNone),
    ),
  );

  Widget footerEntry(
    String label,
    IconData icon,
    String page, {
    String? detail,
  }) => TextButton(
    onPressed: () => widget.onPage(page),
    style: TextButton.styleFrom(
      minimumSize: const Size(0, 36),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
      foregroundColor: palette(context)['text.secondary'],
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
    ),
    child: Row(
      children: [
        Icon(icon, size: 17),
        const SizedBox(width: 10),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                label,
                style: webText(
                  context,
                  color: 'text.secondary',
                ).copyWith(height: kTextHeightNone),
              ),
              if (detail != null)
                Text(
                  detail,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: webText(
                    context,
                    size: 11.5,
                    color: 'text.muted',
                  ).copyWith(height: kTextHeightNone),
                ),
            ],
          ),
        ),
      ],
    ),
  );
  Widget row(Json s, {bool showWorkspace = false}) => SessionRow(
    key: ValueKey('sidebar-${s['id']}'),
    controller: c,
    session: s,
    active: s['id'] == widget.activeId,
    showWorkspace: showWorkspace,
    revealed: revealedSessionId == s['id'],
    onReveal: () => setState(() => revealedSessionId = '${s['id']}'),
    onOpen: () => widget.onOpen('${s['id']}'),
  );
  List<Widget> sessionRows(
    Iterable<Json> sessions, {
    bool showWorkspace = false,
  }) {
    final items = sessions.toList();
    return [
      for (var i = 0; i < items.length; i++) ...[
        row(items[i], showWorkspace: showWorkspace),
        if (i + 1 < items.length) const SizedBox(height: 1),
      ],
    ];
  }

  Widget workspace(Json w) {
    final phone = MediaQuery.sizeOf(context).width <= 650;
    final all = c.sessions.where((s) => s['workspaceId'] == w['id']).toList();
    final unread = all.where((s) => s['unread'] == true).length;
    final running = all.where(isWorking).length;
    final online = workspaceOnline(w, c.nodes);
    final list = sidebarSessions(
      c.sessions,
      '${w['id']}',
      widget.activeId,
      skipWaiting: true,
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Material(
          color: widget.workspaceId == w['id']
              ? palette(context)['fill.active']
              : Colors.transparent,
          borderRadius: BorderRadius.circular(8),
          child: Row(
            children: [
              Expanded(
                child: InkWell(
                  borderRadius: BorderRadius.circular(8),
                  onTap: () => widget.onWorkspace('${w['id']}'),
                  child: Container(
                    height: phone ? 42 : 34,
                    padding: const EdgeInsets.only(left: 10),
                    child: Row(
                      children: [
                        Icon(
                          LucideIcons.folder,
                          size: 15,
                          color: palette(context)['text.secondary'],
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            '${w['displayName']}',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: webText(
                              context,
                              weight: FontWeight.w500,
                            ).copyWith(height: kTextHeightNone),
                          ),
                        ),
                        if (all.any(
                          (s) =>
                              s['writeLease'] != null &&
                              s['writeLease'] != false,
                        ))
                          Padding(
                            padding: const EdgeInsets.only(left: 6),
                            child: Icon(
                              LucideIcons.lock,
                              size: 12,
                              color: palette(context)['status.warning'],
                            ),
                          ),
                        if (running > 0)
                          Padding(
                            padding: const EdgeInsets.only(left: 6),
                            child: Row(
                              children: [
                                const StatusDot(
                                  session: {'runStatus': 'running'},
                                ),
                                const SizedBox(width: 6),
                                Text(
                                  '$running',
                                  style: webText(
                                    context,
                                    size: 11,
                                    color: 'text.muted',
                                  ).copyWith(height: kTextHeightNone),
                                ),
                              ],
                            ),
                          ),
                        if (unread > 0)
                          Padding(
                            padding: const EdgeInsets.symmetric(horizontal: 6),
                            child: Text(
                              '$unread',
                              semanticsLabel: '$unread unread',
                              style: webText(
                                context,
                                size: 11,
                                color: 'accent.default',
                              ).copyWith(height: kTextHeightNone),
                            ),
                          ),
                      ],
                    ),
                  ),
                ),
              ),
              WebIconButton(
                LucideIcons.plus,
                'New ${c.catalog.of(w).noun} in ${w['displayName']}',
                size: phone ? 32 : 24,
                onPressed: online && !isReadOnly(w)
                    ? () => guarded(context, () => c.create('${w['id']}'))
                    : null,
              ),
              const SizedBox(width: 4),
            ],
          ),
        ),
        if (list.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(left: 12, top: 1),
            child: Column(children: sessionRows(list)),
          ),
      ],
    );
  }

  /// Relayed delegation approvals being answered, by interaction id.
  final _answeringApprovals = <String>{};
  final _approvalErrors = <String, String>{};

  /// A delegated session's pending approval, answered in the chat that
  /// delegated it without its control lease (`origin.approval`).
  static Json? delegationApproval(Json session) {
    final origin = obj(session['origin']);
    if (origin['kind'] != 'delegation') return null;
    final approval = obj(origin['approval']);
    return approval['sessionId'] is String &&
            '${approval['interactionId'] ?? ''}'.startsWith('relay.')
        ? approval
        : null;
  }

  Future<void> answerApproval(Json approval, bool confirmed) async {
    final id = '${approval['interactionId']}';
    if (_answeringApprovals.contains(id)) return;
    setState(() {
      _answeringApprovals.add(id);
      _approvalErrors.remove(id);
    });
    try {
      await c.answerRelayedApproval('${approval['sessionId']}', id, confirmed);
    } catch (e) {
      if (mounted) {
        setState(() => _approvalErrors[id] = LiveController.describe(e));
      }
    } finally {
      if (mounted) setState(() => _answeringApprovals.remove(id));
    }
  }

  Widget waiting(Json s) {
    final w = c.workspaces
        .where((w) => w['id'] == s['workspaceId'])
        .firstOrNull;
    final origin = obj(s['origin']);
    final sub = origin.isEmpty
        ? '${w?['displayName'] ?? ''}'
        : 'Delegated · ${origin['title']}';
    final approval = delegationApproval(s);
    final approvalId = '${approval?['interactionId'] ?? ''}';
    final answering = _answeringApprovals.contains(approvalId);
    final approvalError = approval == null ? null : _approvalErrors[approvalId];
    Widget pill(String label, bool allow) => TextButton(
      key: ValueKey('needs-you-${allow ? 'allow' : 'deny'}-${s['id']}'),
      onPressed: answering ? null : () => answerApproval(approval!, allow),
      style: TextButton.styleFrom(
        minimumSize: const Size(0, 32),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        shape: const StadiumBorder(),
        backgroundColor: palette(
          context,
        )[allow ? 'accent.default' : 'fill.hover'],
        foregroundColor: palette(
          context,
        )[allow ? 'accent.on' : 'text.secondary'],
        textStyle: webText(context, size: 12, weight: FontWeight.w500),
      ),
      child: Text(label),
    );
    final reply = Material(
      color: palette(context)['fill.hover'],
      borderRadius: BorderRadius.circular(99),
      child: WebButton(
        'Reply',
        height: 32,
        fontSize: 12,
        horizontalPadding: 10,
        muted: true,
        onPressed: () => widget.onOpen('${s['id']}'),
      ),
    );
    final text = InkWell(
      onTap: () => widget.onOpen('${s['id']}'),
      child: Row(
        children: [
          StatusDot(session: s),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '${s['name']}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: webText(
                    context,
                    size: 13,
                    weight: FontWeight.w500,
                  ).copyWith(height: 1.2),
                ),
                if (approval != null)
                  Tooltip(
                    message: '${approval['message'] ?? approval['title']}',
                    child: Text(
                      '${approval['title'] ?? ''}',
                      key: ValueKey('needs-you-approval-${s['id']}'),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: webText(
                        context,
                        size: 11.5,
                        color: 'text.secondary',
                      ).copyWith(height: 1.2),
                    ),
                  ),
                Text(
                  '$sub · waiting for you',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: webText(
                    context,
                    size: 11.5,
                    color: 'text.muted',
                  ).copyWith(height: 1.2),
                ),
                if (approvalError != null)
                  Semantics(
                    role: SemanticsRole.alert,
                    child: Text(
                      approvalError,
                      style: webText(
                        context,
                        size: 11.5,
                        color: 'status.danger',
                      ).copyWith(height: 1.2),
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
    return Container(
      margin: const EdgeInsets.only(bottom: 4),
      padding: const EdgeInsets.fromLTRB(10, 6, 6, 6),
      decoration: BoxDecoration(
        color: palette(context)['surface.layer'],
        border: Border.all(color: palette(context)['line.default']),
        borderRadius: BorderRadius.circular(12),
      ),
      child: approval == null
          ? Row(
              children: [
                Expanded(child: text),
                const SizedBox(width: 6),
                reply,
              ],
            )
          // Like the web's wrapping inbox item: the actions take their own row.
          : Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                text,
                const SizedBox(height: 6),
                Align(
                  alignment: Alignment.centerRight,
                  child: Wrap(
                    spacing: 4,
                    runSpacing: 4,
                    children: [pill('Allow', true), pill('Deny', false), reply],
                  ),
                ),
              ],
            ),
    );
  }

  Future<void> add(String node) async {
    final id = await newWorkspaceDialog(context, c, node);
    if (mounted && id != null) widget.onWorkspace(id);
  }

  @override
  Widget build(BuildContext context) {
    final phone = MediaQuery.sizeOf(context).width <= 650;
    final catalog = c.catalog;
    final page = c.workspaces
        .where((w) => w['id'] == widget.workspaceId)
        .firstOrNull;
    final hosts = workHosts(c.workspaces, c.nodes, catalog);
    // The primary action creates in the open workspace page.
    final newNoun = page == null ? 'session' : catalog.of(page).noun;
    final inbox = c.sessions.where(isWaiting).toList();
    final count = c.attentionCount;
    final result = c.sessions
        .where(
          (s) =>
              c.workspaces.any((w) => w['id'] == s['workspaceId']) &&
              '${s['name']}'.toLowerCase().contains(search.text.toLowerCase()),
        )
        .toList();
    return Material(
      color: palette(context)[phone ? 'surface.page' : 'surface.sidebar'],
      child: DecoratedBox(
        decoration: BoxDecoration(
          border: phone
              ? null
              : Border(right: BorderSide(color: palette(context)['web.line'])),
        ),
        child: Padding(
          padding: EdgeInsets.only(right: phone ? 0 : 1),
          child: Column(
            children: [
              SizedBox(
                height: 56,
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  child: Row(
                    children: [
                      Container(
                        width: 26,
                        height: 26,
                        decoration: BoxDecoration(
                          color: palette(context)['accent.default'],
                          borderRadius: BorderRadius.circular(8),
                        ),
                        child: Icon(
                          LucideIcons.command,
                          size: 16,
                          color: palette(context)['accent.on'],
                        ),
                      ),
                      const SizedBox(width: 8),
                      Text(
                        'pirc',
                        style: webText(
                          context,
                          size: 16,
                          weight: FontWeight.w600,
                        ).copyWith(letterSpacing: -.16),
                      ),
                      const Spacer(),
                      if (!phone)
                        WebIconButton(
                          LucideIcons.panelLeftClose,
                          'Collapse sidebar',
                          onPressed: widget.onCollapse,
                        ),
                    ],
                  ),
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
                child: Material(
                  color: palette(context)['accent.soft'],
                  borderRadius: BorderRadius.circular(12),
                  child: InkWell(
                    borderRadius: BorderRadius.circular(12),
                    onTap: page != null && isReadOnly(page)
                        ? null
                        : () {
                            if (page != null) {
                              guarded(context, () => c.create('${page['id']}'));
                            } else {
                              newSessionDialog(context, c);
                            }
                          },
                    child: SizedBox(
                      height: 40,
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 14),
                        child: Row(
                          children: [
                            Icon(
                              LucideIcons.squarePen,
                              size: 16,
                              color: palette(context)['accent.default'],
                            ),
                            const SizedBox(width: 8),
                            Expanded(
                              child: Text(
                                'New $newNoun',
                                style: webText(
                                  context,
                                  weight: FontWeight.w500,
                                  color: 'accent.default',
                                ).copyWith(height: kTextHeightNone),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
                child: WebSearch(
                  fixedHeight: 36,
                  fontSize: 16,
                  controller: search,
                  label: 'Search sessions',
                  onChanged: (_) => setState(() {}),
                ),
              ),
              Expanded(
                child: LayoutBuilder(
                  builder: (context, constraints) {
                    final sidebarWidth = constraints.maxWidth;
                    final availableRowWidth = math.max(0.0, sidebarWidth - 16);
                    final horizontalContentWidth = math.max(
                      sidebarWidth,
                      availableRowWidth + 8,
                    );
                    Widget fixedListItem(Widget child) => Align(
                      alignment: AlignmentDirectional.topStart,
                      child: SizedBox(width: availableRowWidth, child: child),
                    );

                    return SingleChildScrollView(
                      scrollDirection: Axis.horizontal,
                      child: SizedBox(
                        width: horizontalContentWidth,
                        child: RefreshIndicator(
                          onRefresh: () async {
                            await c.refreshList();
                          },
                          child: ListView(
                            padding: const EdgeInsets.only(left: 8),
                            physics: const AlwaysScrollableScrollPhysics(),
                            children: [
                              if (search.text.isNotEmpty) ...[
                                fixedListItem(
                                  heading(
                                    'Results',
                                    trailing: Text(
                                      '${result.length}',
                                      style: webText(context, size: 11),
                                    ),
                                  ),
                                ),
                                if (result.isEmpty)
                                  fixedListItem(note('Nothing matches.')),
                                if (result.isNotEmpty)
                                  fixedListItem(const SizedBox(height: 1)),
                                ...sessionRows(
                                  result,
                                  showWorkspace: true,
                                ).map(fixedListItem),
                              ] else ...[
                                if (count > 0) ...[
                                  fixedListItem(
                                    heading(
                                      'Needs you',
                                      attention: true,
                                      trailing: Container(
                                        padding: const EdgeInsets.symmetric(
                                          horizontal: 6,
                                        ),
                                        decoration: BoxDecoration(
                                          color: palette(
                                            context,
                                          )['status.warning'],
                                          borderRadius: BorderRadius.circular(
                                            99,
                                          ),
                                        ),
                                        child: Text(
                                          '$count',
                                          style: webText(
                                            context,
                                            size: 11,
                                            color: 'surface.page',
                                          ),
                                        ),
                                      ),
                                    ),
                                  ),
                                  for (final s in inbox)
                                    fixedListItem(waiting(s)),
                                  fixedListItem(const SizedBox(height: 14)),
                                ],
                                for (final host in hosts) ...[
                                  fixedListItem(
                                    heading(
                                      '${host['id']}',
                                      leading: Container(
                                        width: 6,
                                        height: 6,
                                        decoration: BoxDecoration(
                                          shape: BoxShape.circle,
                                          color:
                                              palette(context)[host['online'] ==
                                                      true
                                                  ? 'status.success'
                                                  : 'text.muted'],
                                        ),
                                      ),
                                      trailing: Row(
                                        mainAxisSize: MainAxisSize.min,
                                        children: [
                                          if (host['online'] != true)
                                            Text(
                                              'offline',
                                              style: webText(
                                                context,
                                                size: 11,
                                                color: 'text.muted',
                                              ),
                                            ),
                                          WebIconButton(
                                            LucideIcons.plus,
                                            'Add workspace on ${host['id']}',
                                            size: 22,
                                            onPressed: host['online'] == true
                                                ? () => add('${host['id']}')
                                                : null,
                                          ),
                                        ],
                                      ),
                                    ),
                                  ),
                                  if (rows(host['workspaces']).isEmpty)
                                    fixedListItem(note('No workspaces yet.')),
                                  for (final w in rows(host['workspaces']))
                                    fixedListItem(workspace(w)),
                                  fixedListItem(const SizedBox(height: 14)),
                                ],
                                if (hosts.isEmpty)
                                  fixedListItem(
                                    note(
                                      'Connect a device to add a workspace.',
                                      inset: 2,
                                    ),
                                  ),
                              ],
                            ],
                          ),
                        ),
                      ),
                    );
                  },
                ),
              ),
              if (!phone)
                Container(
                  margin: const EdgeInsets.only(top: 6),
                  padding: const EdgeInsets.fromLTRB(8, 6, 8, 8),
                  decoration: BoxDecoration(
                    border: Border(
                      top: BorderSide(color: palette(context)['web.line']),
                    ),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      footerEntry('Settings', LucideIcons.settings, 'settings'),
                    ],
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
