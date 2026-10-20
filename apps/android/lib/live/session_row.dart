import '../l10n/app_i18n.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'common.dart';
import 'gateway.dart';
import 'work_index.dart';
import 'modes.dart';
import 'web_controls.dart';
import 'web_length_formatter.dart';

const _delegationStatus = {
  'running': 'is running',
  'waiting_input': 'waits for you',
  'completed': 'finished',
  'failed': 'failed',
};

class SessionRow extends StatefulWidget {
  const SessionRow({
    super.key,
    required this.controller,
    required this.session,
    required this.onOpen,
    required this.onDeleted,
    this.active = false,
    this.page = false,
    this.showWorkspace = false,
    this.revealed = false,
    this.onReveal,
  });
  final LiveController controller;
  final Json session;
  final VoidCallback onOpen;
  final ValueChanged<String> onDeleted;
  final bool active, page, showWorkspace;
  final bool revealed;
  final VoidCallback? onReveal;
  @override
  State<SessionRow> createState() => _SessionRowState();
}

class _SessionRowState extends State<SessionRow> {
  final name = TextEditingController();
  final focus = FocusNode();
  bool localReveal = false, hover = false, focusWithin = false;
  bool renaming = false, saving = false;
  String? error;
  Json get s => widget.session;
  bool get isRevealed => widget.revealed || localReveal;

  bool _canHover() {
    final platform = Theme.of(context).platform;
    final desktop =
        platform == TargetPlatform.linux ||
        platform == TargetPlatform.macOS ||
        platform == TargetPlatform.windows;
    return desktop || RendererBinding.instance.mouseTracker.mouseIsConnected;
  }

  void _reveal() {
    final callback = widget.onReveal;
    if (callback != null) {
      callback();
    } else {
      setState(() => localReveal = true);
    }
  }

  @override
  void dispose() {
    name.dispose();
    focus.dispose();
    super.dispose();
  }

  void rename() {
    name.text = '${s['name']}';
    name.selection = TextSelection(
      baseOffset: 0,
      extentOffset: name.text.length,
    );
    setState(() {
      renaming = true;
      error = null;
    });
    focus.requestFocus();
  }

  Future<void> patch(Json body) async {
    if (saving) return;
    setState(() {
      saving = true;
      error = null;
    });
    try {
      await widget.controller.updateSession(body, targetId: '${s['id']}');
    } catch (e) {
      if (mounted) setState(() => error = LiveController.describe(e));
    } finally {
      if (mounted) setState(() => saving = false);
    }
  }

  Future<void> finishRename(bool commit) async {
    if (!renaming || saving) return;
    if (commit &&
        name.text.trim().isNotEmpty &&
        name.text.trim() != s['name']) {
      await patch({'name': name.text.trim()});
      if (!mounted || error != null) return;
    }
    setState(() => renaming = false);
  }

  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    final w =
        widget.controller.workspaces
            .where((w) => w['id'] == s['workspaceId'])
            .firstOrNull ??
        {};
    // An unavailable mode leaves history readable but accepts no mutations.
    final locked = saving || isReadOnly(w);
    final phone = MediaQuery.sizeOf(context).width <= 650;
    final hoverCapable = _canHover();
    final actions = widget.page
        ? !hoverCapable || hover || focusWithin
        : hoverCapable
        ? hover || focusWithin
        : widget.active || isRevealed;
    final showMore =
        !widget.page && !hoverCapable && !widget.active && !isRevealed;
    final origin = obj(s['origin']);
    final delegationStatus = origin['kind'] == 'delegation'
        ? _delegationStatus[origin['status']]
        : null;
    final delegationFinished =
        origin['kind'] == 'delegation' &&
        const ['completed', 'failed'].contains(origin['status']);
    final color = palette(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Focus(
          onFocusChange: (hasFocus) {
            if (mounted && focusWithin != hasFocus) {
              setState(() => focusWithin = hasFocus);
            }
          },
          onKeyEvent: (_, e) {
            if (e is KeyDownEvent && e.logicalKey == LogicalKeyboardKey.f2) {
              if (!isReadOnly(w)) rename();
              return KeyEventResult.handled;
            }
            if (renaming &&
                e is KeyDownEvent &&
                e.logicalKey == LogicalKeyboardKey.escape) {
              finishRename(false);
              return KeyEventResult.handled;
            }
            return KeyEventResult.ignored;
          },
          child: MouseRegion(
            onEnter: (_) {
              if (_canHover()) setState(() => hover = true);
            },
            onExit: (_) {
              if (hover) setState(() => hover = false);
            },
            child: Material(
              color: widget.active
                  ? color['fill.active']
                  : hover
                  ? color['fill.hover']
                  : Colors.transparent,
              borderRadius: BorderRadius.circular(8),
              child: ConstrainedBox(
                constraints: widget.page
                    ? const BoxConstraints(minHeight: 44)
                    : BoxConstraints.tightFor(height: phone ? 44 : 36),
                child: renaming
                    ? Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 12),
                        child: Focus(
                          onFocusChange: (has) {
                            if (!has) finishRename(true);
                          },
                          child: TextField(
                            key: ValueKey('rename-${s['id']}'),
                            controller: name,
                            focusNode: focus,
                            inputFormatters: const [WebLengthFormatter(200)],
                            enabled: !saving,
                            style: webText(context),
                            onSubmitted: (_) => finishRename(true),
                            decoration: const InputDecoration(
                              isDense: true,
                              counterText: '',
                              contentPadding: EdgeInsets.symmetric(
                                vertical: 10,
                              ),
                            ),
                          ),
                        ),
                      )
                    : Row(
                        children: [
                          Expanded(
                            child: InkWell(
                              onTap: widget.onOpen,
                              onDoubleTap: isReadOnly(w) ? null : rename,
                              borderRadius: BorderRadius.circular(8),
                              child: Padding(
                                padding: EdgeInsets.fromLTRB(
                                  widget.page ? 12 : 8,
                                  0,
                                  4,
                                  0,
                                ),
                                child: Row(
                                  children: [
                                    StatusDot(
                                      session: s,
                                      size: widget.page ? 7 : 6,
                                    ),
                                    const SizedBox(width: 8),
                                    if (origin['kind'] == 'schedule' ||
                                        origin['kind'] == 'delegation') ...[
                                      Tooltip(
                                        message:
                                            '${origin['kind'] == 'schedule' ? 'Scheduled' : 'Delegated'}: ${origin['title']}${delegationStatus == null ? '' : ' ($delegationStatus)'}',
                                        child: Icon(
                                          origin['kind'] == 'schedule'
                                              ? LucideIcons.clock
                                              : LucideIcons.forward,
                                          size: 13,
                                          color: color['text.muted'],
                                        ),
                                      ),
                                      const SizedBox(width: 8),
                                    ],
                                    Expanded(
                                      child: Text(
                                        '${s['name']}',
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                        style: webText(
                                          context,
                                          weight: s['unread'] == true
                                              ? FontWeight.w600
                                              : FontWeight.w400,
                                          color: isDone(s)
                                              ? 'text.muted'
                                              : 'text.primary',
                                        ).copyWith(height: kTextHeightNone),
                                      ),
                                    ),
                                    if (!widget.page && delegationFinished)
                                      Padding(
                                        padding: const EdgeInsets.only(left: 6),
                                        child: Tooltip(
                                          message: tr(
                                            "The delegated task {0}",
                                            [delegationStatus],
                                          ),
                                          child: Container(
                                            padding: const EdgeInsets.symmetric(
                                              horizontal: 6,
                                            ),
                                            decoration: BoxDecoration(
                                              color: color['surface.layer'],
                                              borderRadius:
                                                  BorderRadius.circular(999),
                                            ),
                                            child: Text(
                                              origin['status'] == 'completed'
                                                  ? tr("Done")
                                                  : tr("Failed"),
                                              style: webText(
                                                context,
                                                size: 11,
                                                color:
                                                    origin['status'] ==
                                                        'completed'
                                                    ? 'status.success'
                                                    : 'status.danger',
                                              ).copyWith(height: 16 / 11),
                                            ),
                                          ),
                                        ),
                                      ),
                                    if (!actions) ...[
                                      if (s['writeLease'] != null &&
                                          s['writeLease'] != false)
                                        Padding(
                                          padding: const EdgeInsets.only(
                                            left: 6,
                                          ),
                                          child: Icon(
                                            LucideIcons.lock,
                                            size: 12,
                                            color: color['status.warning'],
                                          ),
                                        ),
                                      if (isPinned(s))
                                        Padding(
                                          padding: const EdgeInsets.only(
                                            left: 6,
                                          ),
                                          child: Icon(
                                            LucideIcons.pin,
                                            size: 12,
                                            color: color['text.muted'],
                                          ),
                                        ),
                                      if (widget.showWorkspace)
                                        Flexible(
                                          child: Padding(
                                            padding: const EdgeInsets.only(
                                              left: 6,
                                            ),
                                            child: Text(
                                              '${w['displayName'] ?? ''}',
                                              maxLines: 1,
                                              overflow: TextOverflow.ellipsis,
                                              style:
                                                  webText(
                                                    context,
                                                    size: 10.5,
                                                    color: 'text.muted',
                                                  ).copyWith(
                                                    height: kTextHeightNone,
                                                  ),
                                            ),
                                          ),
                                        ),
                                      if (s['unread'] == true)
                                        const Padding(
                                          padding: EdgeInsets.only(left: 6),
                                          child: _UnreadDot(),
                                        ),
                                      const SizedBox(width: 6),
                                      Text(
                                        shortAgo(s['updatedAt']),
                                        style: webText(
                                          context,
                                          size: 11,
                                          color: 'text.muted',
                                        ).copyWith(height: kTextHeightNone),
                                      ),
                                    ],
                                  ],
                                ),
                              ),
                            ),
                          ),
                          if (actions) ...[
                            WebIconButton(
                              isPinned(s)
                                  ? LucideIcons.pinOff
                                  : LucideIcons.pin,
                              '${isPinned(s) ? 'Unpin' : 'Pin'} ${s['name']}',
                              size: widget.page
                                  ? 28
                                  : phone
                                  ? 32
                                  : 24,
                              iconSize: 14,
                              onPressed: locked
                                  ? null
                                  : () => patch({'pinned': !isPinned(s)}),
                            ),
                            const SizedBox(width: 2),
                            WebIconButton(
                              isDone(s)
                                  ? LucideIcons.archiveRestore
                                  : LucideIcons.archive,
                              '${isDone(s) ? 'Reopen' : 'Settle'} ${s['name']}',
                              size: widget.page
                                  ? 28
                                  : phone
                                  ? 32
                                  : 24,
                              iconSize: 14,
                              onPressed: locked
                                  ? null
                                  : () => patch({'settled': !isDone(s)}),
                            ),
                            if (widget.controller.catalog
                                .of(w)
                                .deleteSessions) ...[
                              const SizedBox(width: 2),
                              WebIconButton(
                                LucideIcons.trash2,
                                tr("Delete {0}", [s['name']]),
                                size: widget.page
                                    ? 28
                                    : phone
                                    ? 32
                                    : 24,
                                iconSize: 14,
                                onPressed: saving
                                    ? null
                                    : () async {
                                        final deleted = await showDialog<bool>(
                                          context: context,
                                          useRootNavigator: false,
                                          barrierDismissible: false,
                                          builder: (_) => _DeleteChat(
                                            controller: widget.controller,
                                            session: s,
                                          ),
                                        );
                                        if (deleted == true) {
                                          widget.onDeleted(
                                            '${s['workspaceId']}',
                                          );
                                        }
                                      },
                              ),
                            ],
                            const SizedBox(width: 2),
                            WebIconButton(
                              LucideIcons.pencil,
                              tr("Rename {0}", [s['name']]),
                              size: widget.page
                                  ? 28
                                  : phone
                                  ? 32
                                  : 24,
                              iconSize: 14,
                              onPressed: locked ? null : rename,
                            ),
                          ] else if (showMore)
                            WebIconButton(
                              LucideIcons.ellipsis,
                              tr("Actions for {0}", [s['name']]),
                              size: 36,
                              iconSize: 16,
                              onPressed: _reveal,
                            ),
                          const SizedBox(width: 6),
                        ],
                      ),
              ),
            ),
          ),
        ),
        if (error != null) WebNotice(error!, error: true),
      ],
    );
  }
}

class StatusDot extends StatelessWidget {
  const StatusDot({super.key, required this.session, this.size = 7});
  final Json session;
  final double size;
  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    return Tooltip(
      message: isWaiting(session)
          ? tr("Needs input")
          : isWorking(session)
          ? tr("Working")
          : '${session['runStatus'] ?? 'idle'}',
      child: Container(
        width: size,
        height: size,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          color:
              !isWaiting(session) &&
                  !isWorking(session) &&
                  session['unread'] != true
              ? Colors.transparent
              : palette(context)[isWaiting(session)
                    ? 'status.warning'
                    : isWorking(session)
                    ? 'accent.default'
                    : session['unread'] == true
                    ? 'accent.default'
                    : 'line.strong'],
        ),
      ),
    );
  }
}

class _UnreadDot extends StatelessWidget {
  const _UnreadDot();
  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    return Semantics(
      label: tr("Unread"),
      child: Container(
        width: 6,
        height: 6,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          color: palette(context)['accent.default'],
        ),
      ),
    );
  }
}

class _DeleteChat extends StatefulWidget {
  const _DeleteChat({required this.controller, required this.session});
  final LiveController controller;
  final Json session;
  @override
  State<_DeleteChat> createState() => _DeleteChatState();
}

class _DeleteChatState extends State<_DeleteChat> {
  bool busy = false;
  String? error;
  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    return WebDialog(
      title: tr("Delete chat?"),
      busy: busy,
      actions: [
        WebButton(
          tr("Cancel"),
          onPressed: busy ? null : () => Navigator.pop(context, false),
        ),
        WebButton(
          busy ? tr("Deleting…") : tr("Delete chat and memories"),
          primary: true,
          danger: true,
          onPressed: busy
              ? null
              : () async {
                  setState(() {
                    busy = true;
                    error = null;
                  });
                  try {
                    await widget.controller.deleteChat(
                      '${widget.session['id']}',
                    );
                    if (context.mounted) Navigator.pop(context, true);
                  } catch (e) {
                    if (mounted) {
                      setState(() {
                        busy = false;
                        error = LiveController.describe(e);
                      });
                    }
                  }
                },
        ),
      ],
      children: [
        Text(
          tr(
            "“{0}” will be permanently deleted, including its messages and chat files.",
            [widget.session['name']],
          ),
        ),
        const SizedBox(height: 12),
        Text(
          tr(
            "This also deletes USER memories and MEMORY notes created by this chat, and its pending memory proposals.",
          ),
          style: TextStyle(fontWeight: FontWeight.w600),
        ),
        Text(tr("Memories created by other chats are kept.")),
        const SizedBox(height: 12),
        Text(
          tr(
            "Copies already present in other chats are not erased. Any running reply will stop. This cannot be undone.",
          ),
        ),
        if (error != null) WebNotice(error!, error: true),
      ],
    );
  }
}
