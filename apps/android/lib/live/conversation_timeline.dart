import '../l10n/app_i18n.dart';
import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'common.dart';
import 'gateway.dart';
import 'timeline_models.dart';
import 'timeline_tools.dart';
import 'web_controls.dart';

class ConversationTimeline extends StatelessWidget {
  const ConversationTimeline({
    super.key,
    required this.controller,
    this.onFile,
    this.highlightedMessage,
  });
  final LiveController controller;
  final void Function(String)? onFile;
  final String? highlightedMessage;
  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    final items = timelineItems(controller.visibleMessages);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final (index, item) in items.indexed)
          if (item.run)
            ResponseActivity(
              key: ValueKey(item.id),
              messages: item.messages,
              controller: controller,
              onFile: onFile,
              highlightedMessage: highlightedMessage,
            )
          else
            TimelineMessage(
              key: ValueKey(item.id),
              message: item.messages.first,
              controller: controller,
              onFile: onFile,
              lastProcess:
                  index == items.length - 1 ||
                  (!items[index + 1].run &&
                      !processOnly(items[index + 1].messages.first) &&
                      items[index + 1].messages.first['systemKind'] !=
                          'notice'),
              highlighted: highlightedMessage == item.id,
            ),
      ],
    );
  }
}

/// One disclosure for a response. Pending approvals live outside the history.
class ResponseActivity extends StatefulWidget {
  const ResponseActivity({
    super.key,
    required this.messages,
    required this.controller,
    this.onFile,
    this.highlightedMessage,
  });
  final List<Json> messages;
  final LiveController controller;
  final void Function(String)? onFile;
  final String? highlightedMessage;
  @override
  State<ResponseActivity> createState() => _ResponseActivityState();
}

class _ResponseActivityState extends State<ResponseActivity> {
  bool open = false;
  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    final parts = responseParts(widget.messages);
    final tools = widget.messages.expand((m) => rows(m['tools'])).toList();
    final calls = effectiveTools(tools);
    final running = calls.reversed
        .where((t) => t['status'] == 'running')
        .firstOrNull;
    final failed = math.max(
      calls.where((t) => t['status'] == 'failed').length,
      tools.any((t) => t['status'] == 'failed') ? 1 : 0,
    );
    final latest = running ?? calls.lastOrNull;
    final thinking = widget.messages.any(
      (m) =>
          partial(m) &&
          value(m, 'content').isEmpty &&
          (value(m, 'thinking').isNotEmpty || m['thinkingRedacted'] == true),
    );
    final status =
        running != null ||
            tools.any((t) => t['status'] == 'running') ||
            thinking
        ? 'running'
        : failed > 0
        ? 'failed'
        : 'succeeded';
    final label = thinking && running == null
        ? tr('Thinking…')
        : status == 'running'
        ? tr('Running: {0}', [latest?['name'] ?? tr('Working…')])
        : calls.isNotEmpty
        ? tr('Completed {0} operations', [calls.length])
        : tr('Activity details');
    Widget message(Json m, {bool activity = false}) => TimelineMessage(
      key: ValueKey(m['id']),
      message: m,
      controller: widget.controller,
      grouped: activity,
      embedInteractions: false,
      onFile: widget.onFile,
      highlighted: widget.highlightedMessage == m['id'],
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (parts.activity.isNotEmpty)
          Container(
            margin: const EdgeInsets.only(top: 4, bottom: 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Semantics(
                  expanded: open,
                  child: InkWell(
                    onTap: () => setState(() => open = !open),
                    borderRadius: BorderRadius.circular(12),
                    child: Container(
                      constraints: const BoxConstraints(minHeight: 36),
                      padding: const EdgeInsets.symmetric(
                        horizontal: 8,
                        vertical: 6,
                      ),
                      decoration: BoxDecoration(
                        color: palette(context)['web.bg-subtle'],
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: Row(
                        children: [
                          Icon(
                            open
                                ? LucideIcons.chevronDown
                                : LucideIcons.chevronRight,
                            size: 14,
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text(
                              '$label${failed > 0 ? ' · ${tr('{0} failed', [failed])}' : ''}',
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: webText(
                                context,
                                size: 13,
                                color: 'text.secondary',
                              ),
                            ),
                          ),
                          const SizedBox(width: 8),
                          TimelineStatus(status),
                        ],
                      ),
                    ),
                  ),
                ),
                if (open)
                  Padding(
                    padding: const EdgeInsets.only(left: 12, top: 8),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        for (final m in parts.activity)
                          message(m, activity: true),
                      ],
                    ),
                  ),
              ],
            ),
          ),
        for (final m in parts.visible) message(m),
      ],
    );
  }
}

class TimelineMessage extends StatefulWidget {
  const TimelineMessage({
    super.key,
    required this.message,
    required this.controller,
    this.onFile,
    this.grouped = false,
    this.embedInteractions = true,
    this.lastProcess = true,
    this.highlighted = false,
  });
  final Json message;
  final LiveController controller;
  final void Function(String)? onFile;
  final bool grouped, lastProcess, highlighted, embedInteractions;
  @override
  State<TimelineMessage> createState() => _TimelineMessageState();
}

class _TimelineMessageState extends State<TimelineMessage> {
  bool thinkingOpen = false, systemOpen = false;
  TextEditingController? edit;
  bool saving = false;
  String? editError;

  @override
  void dispose() {
    edit?.dispose();
    super.dispose();
  }

  @override
  void didUpdateWidget(covariant TimelineMessage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.message['entryId'] != widget.message['entryId'] ||
        oldWidget.controller != widget.controller) {
      edit?.dispose();
      edit = null;
      editError = null;
      saving = false;
    }
  }

  Future<void> saveEdit() async {
    final draft = edit;
    if (draft == null || draft.text.trim().isEmpty || saving) return;
    setState(() {
      saving = true;
      editError = null;
    });
    final success = await widget.controller.changeMessageHistory(
      value(widget.message, 'entryId'),
      message: draft.text,
    );
    if (!mounted || edit != draft) return;
    setState(() {
      saving = false;
      if (success) {
        edit = null;
        draft.dispose();
      } else {
        editError =
            widget.controller.actionError ??
            tr(
              "Editing is unavailable. Wait for the session to be idle and take control.",
            );
      }
    });
  }

  Widget messageEditor() => SizedBox(
    width: double.infinity,
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        TextField(
          controller: edit,
          autofocus: true,
          minLines: 2,
          maxLines: 12,
          enabled: !saving,
          decoration: InputDecoration(labelText: tr("Edit message")),
          onChanged: (_) => setState(() {}),
        ),
        Text(
          tr(
            "Saving creates a new branch and regenerates the response. Files and tool actions are not rolled back. Attachments are kept.",
          ),
          style: TextStyle(fontSize: 12),
        ),
        if (editError != null)
          Text(editError!, style: const TextStyle(color: Colors.red)),
        Wrap(
          alignment: WrapAlignment.end,
          children: [
            TextButton(
              onPressed: saving
                  ? null
                  : () => setState(() {
                      edit?.dispose();
                      edit = null;
                      editError = null;
                    }),
              child: Text(tr("Cancel")),
            ),
            TextButton(
              onPressed:
                  !saving &&
                      widget.controller.canChangeHistory &&
                      edit!.text.trim().isNotEmpty
                  ? saveEdit
                  : null,
              child: Text(saving ? tr("Saving…") : tr("Save and regenerate")),
            ),
          ],
        ),
      ],
    ),
  );

  Widget markdown(
    String source, {
    bool compact = false,
    bool thinking = false,
    bool streaming = false,
  }) => RichTextBody(
    source,
    gateway: widget.controller.gateway,
    onFile: widget.onFile,
    compact: compact,
    streaming: streaming,
    fontSize: compact
        ? thinking
              ? 14
              : 13
        : null,
    textColor: compact
        ? palette(context)[thinking ? 'text.muted' : 'text.secondary']
        : null,
  );
  String time(BuildContext context) {
    final at = instant(widget.message['createdAt']);
    if (at == null) return '';
    final clock = TimeOfDay.fromDateTime(at);
    final localizations = MaterialLocalizations.of(context);
    final hour = localizations.formatHour(clock);
    final formatted = localizations.formatTimeOfDay(clock);
    // Message.svelte requests a two-digit hour, including 12-hour locales.
    return hour.runes.length == 1
        ? formatted.replaceFirst(hour, '${localizations.formatDecimal(0)}$hour')
        : formatted;
  }

  Widget toolStack(List<Json> tools, {double top = 0}) {
    final stack = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final (i, t) in tools.indexed) ...[
          if (i > 0) const SizedBox(height: 2),
          TimelineTool(
            key: ValueKey(t['id']),
            tool: t,
            controller: widget.controller,
            embedInteractions: widget.embedInteractions,
          ),
        ],
      ],
    );
    return Padding(
      padding: EdgeInsets.only(top: top),
      child: tools.length > 1 && !widget.grouped
          ? TimelineRun(
              tools: tools,
              forceOpen: tools.any(
                (tool) => toolHasPendingInteraction(
                  tool,
                  widget.controller.questions,
                ),
              ),
              child: stack,
            )
          : stack,
    );
  }

  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    return ListenableBuilder(
      listenable: widget.controller,
      builder: (context, _) => buildMessage(context),
    );
  }

  Widget buildMessage(BuildContext context) {
    final m = widget.message,
        p = palette(context),
        phone = MediaQuery.sizeOf(context).width <= 650;
    if (m['role'] == 'system') return system(context);
    final user = m['role'] == 'user',
        text = value(m, 'content'),
        thinking = value(m, 'thinking'),
        isPartial = partial(m),
        process = processOnly(m),
        tools = rows(m['tools']);
    final streamingThinking = isPartial && text.isEmpty && thinking.isNotEmpty;
    final thinkingVisible = thinkingOpen;
    final content = Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: user
          ? CrossAxisAlignment.end
          : CrossAxisAlignment.stretch,
      children: [
        if (thinking.isNotEmpty || m['thinkingRedacted'] == true)
          Padding(
            padding: EdgeInsets.only(bottom: process ? 2 : 8),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Semantics(
                  expanded: thinkingVisible,
                  child: InkWell(
                    onTap: () => setState(() => thinkingOpen = !thinkingOpen),
                    borderRadius: BorderRadius.circular(8),
                    child: Container(
                      constraints: const BoxConstraints(minHeight: 28),
                      padding: const EdgeInsets.only(right: 8),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(
                            LucideIcons.brain,
                            size: 15,
                            color: p['text.secondary'],
                          ),
                          const SizedBox(width: 6),
                          Flexible(
                            child: Text(
                              streamingThinking
                                  ? tr("Thinking…")
                                  : m['thinkingRedacted'] == true &&
                                        thinking.isEmpty
                                  ? tr("Reasoning redacted")
                                  : tr("Thought"),
                              style: webText(
                                context,
                                size: 14,
                                color: 'text.secondary',
                              ),
                            ),
                          ),
                          const SizedBox(width: 6),
                          Icon(
                            thinkingVisible
                                ? LucideIcons.chevronDown
                                : LucideIcons.chevronRight,
                            size: 14,
                            color: p['text.muted'],
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
                if (thinkingVisible && thinking.isNotEmpty)
                  Container(
                    margin: const EdgeInsets.fromLTRB(7, 4, 0, 4),
                    padding: const EdgeInsets.only(left: 14),
                    decoration: BoxDecoration(
                      border: Border(
                        left: BorderSide(color: p['web.line-dark']),
                      ),
                    ),
                    child: markdown(
                      thinking,
                      compact: true,
                      thinking: true,
                      streaming: streamingThinking,
                    ),
                  ),
              ],
            ),
          ),
        if (text.isNotEmpty ||
            (user && edit != null) ||
            isPartial ||
            messageError(m).isNotEmpty ||
            rows(m['images']).isNotEmpty)
          Container(
            padding: user
                ? EdgeInsets.symmetric(
                    horizontal: phone ? 14 : 16,
                    vertical: phone ? 9 : 10,
                  )
                : EdgeInsets.zero,
            decoration: user
                ? BoxDecoration(
                    color: p['surface.bubble'],
                    borderRadius: BorderRadius.circular(20),
                  )
                : null,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (user && edit != null)
                  messageEditor()
                else if (user)
                  SelectableText(
                    text,
                    style: webText(context, size: 15).copyWith(height: 22 / 15),
                  )
                else if (text.isNotEmpty)
                  markdown(text, streaming: isPartial),
                if (isPartial && !streamingThinking && (user || text.isEmpty))
                  Semantics(
                    label: tr("Streaming"),
                    child: Container(
                      width: 8,
                      height: 8,
                      margin: const EdgeInsets.only(left: 4),
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: p['accent.default'],
                      ),
                    ),
                  ),
              ],
            ),
          ),
        if (value(m, 'stopReason').isNotEmpty)
          Container(
            margin: const EdgeInsets.only(top: 8),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            decoration: BoxDecoration(
              color: p['status.dangerSoft'],
              borderRadius: BorderRadius.circular(12),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(
                  LucideIcons.circleAlert,
                  size: 14,
                  color: p['status.danger'],
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    '${m['stopReason'] == 'aborted' ? 'Stopped' : 'Error'}${messageError(m).isEmpty ? '' : ': ${messageError(m)}'}',
                    style: webText(
                      context,
                      size: 13,
                      color: 'status.danger',
                    ).copyWith(height: 1.5),
                  ),
                ),
              ],
            ),
          ),
        if (rows(m['images']).isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: TimelineImages(
              rows(m['images']),
              gateway: widget.controller.gateway,
            ),
          ),
        if (rows(m['attachments']).isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                for (final a in rows(m['attachments']))
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 10,
                      vertical: 6,
                    ),
                    decoration: BoxDecoration(
                      color: p['web.bg-subtle'],
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(
                          LucideIcons.image,
                          size: 15,
                          color: p['text.secondary'],
                        ),
                        const SizedBox(width: 6),
                        Flexible(
                          child: Text(
                            value(a, 'name'),
                            style: webText(
                              context,
                              size: 12,
                              color: 'text.secondary',
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
        if (tools.isNotEmpty)
          toolStack(
            tools,
            top: process
                ? 0
                : text.isNotEmpty
                ? 12
                : 8,
          ),
        if (!isPartial &&
            (text.isNotEmpty || user && value(m, 'entryId').isNotEmpty))
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Opacity(
              opacity: .7,
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    time(context),
                    style: webText(
                      context,
                      size: 12,
                      color: 'text.muted',
                    ).copyWith(height: kTextHeightNone),
                  ),
                  const SizedBox(width: 6),
                  if (!user && value(m, 'model').isNotEmpty) ...[
                    Flexible(
                      child: ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 220),
                        child: Text(
                          value(m, 'model'),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: webText(
                            context,
                            size: 12,
                            color: 'text.muted',
                          ).copyWith(height: kTextHeightNone),
                        ),
                      ),
                    ),
                    const SizedBox(width: 6),
                  ],
                  if (user && value(m, 'entryId').isNotEmpty) ...[
                    if (rows(m['branches']).length > 1) ...[
                      WebIconButton(
                        LucideIcons.chevronLeft,
                        tr("Previous version"),
                        size: 28,
                        iconSize: 14,
                        onPressed: branchAction(m, -1),
                      ),
                      Text(
                        '${selectedBranch(m) + 1}/${rows(m['branches']).length}',
                        style: webText(context, size: 12, color: 'text.muted'),
                      ),
                      WebIconButton(
                        LucideIcons.chevronRight,
                        tr("Next version"),
                        size: 28,
                        iconSize: 14,
                        onPressed: branchAction(m, 1),
                      ),
                    ],
                    WebIconButton(
                      LucideIcons.pencil,
                      tr("Edit message"),
                      size: 28,
                      iconSize: 14,
                      onPressed:
                          widget.controller.canChangeHistory && edit == null
                          ? () => setState(() {
                              edit = TextEditingController(text: text);
                              editError = null;
                            })
                          : null,
                    ),
                  ],
                  WebIconButton(
                    LucideIcons.copy,
                    tr("Copy message"),
                    size: 28,
                    iconSize: 14,
                    onPressed: () =>
                        Clipboard.setData(ClipboardData(text: text)),
                  ),
                ],
              ),
            ),
          ),
      ],
    );
    return Padding(
      padding: EdgeInsets.only(bottom: process && !widget.lastProcess ? 2 : 16),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 180),
        decoration: BoxDecoration(
          color: widget.highlighted ? p['accent.soft'] : Colors.transparent,
          borderRadius: BorderRadius.circular(16),
        ),
        child: user
            ? LayoutBuilder(
                builder: (context, bounds) => Align(
                  alignment: Alignment.centerRight,
                  child: ConstrainedBox(
                    constraints: BoxConstraints(
                      maxWidth: phone
                          ? bounds.maxWidth * .88
                          : math.min(bounds.maxWidth * .82, 560),
                    ),
                    child: content,
                  ),
                ),
              )
            : content,
      ),
    );
  }

  int selectedBranch(Json message) => rows(
    message['branches'],
  ).indexWhere((branch) => branch['selected'] == true);

  VoidCallback? branchAction(Json message, int delta) {
    final branches = rows(message['branches']);
    final selected = selectedBranch(message), target = selected + delta;
    if (!widget.controller.canChangeHistory ||
        edit != null ||
        selected < 0 ||
        target < 0 ||
        target >= branches.length) {
      return null;
    }
    return () async {
      final success = await widget.controller.changeMessageHistory(
        value(branches[target], 'entryId'),
      );
      if (!success && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              widget.controller.actionError ??
                  tr("Unable to switch message version."),
            ),
          ),
        );
      }
    };
  }

  Widget system(BuildContext context) {
    final m = widget.message,
        p = palette(context),
        phone = MediaQuery.sizeOf(context).width <= 650;
    final kind = m['systemKind'] ?? 'custom',
        notice = kind == 'notice',
        runtime = kind == 'team' || kind == 'background',
        text = value(m, 'content'),
        tools = rows(m['tools']);
    final collapsible = !notice;
    final first = text.split('\n').first.trim(),
        parts = RegExp(
          r'^([^:]{1,40}):\s+(.+)$',
        ).firstMatch(text.split('\n').first.trim());
    final expandable = notice
        ? text.trim().contains('\n') || first.length > 80
        : collapsible &&
              (text.isNotEmpty ||
                  tools.isNotEmpty ||
                  rows(m['images']).isNotEmpty);
    final name = notice
        ? (parts == null ? first : parts[1]!)
        : kind == 'bash'
        ? '\$ ${value(m, 'label')}'
        : value(m, 'label').isEmpty
        ? tr('System message')
        : value(m, 'label');
    final detail = notice ? (parts == null ? '' : parts[2]!) : value(m, 'meta');
    final color = notice && m['level'] == 'error'
        ? 'status.danger'
        : notice && m['level'] == 'warning'
        ? 'status.warning'
        : 'text.secondary';
    final icon = kind == 'bash'
        ? LucideIcons.squareTerminal
        : kind == 'compaction'
        ? LucideIcons.layers
        : kind == 'branch'
        ? LucideIcons.gitBranch
        : notice
        ? m['level'] == 'error'
              ? LucideIcons.circleAlert
              : m['level'] == 'warning'
              ? LucideIcons.triangleAlert
              : LucideIcons.info
        : LucideIcons.puzzle;
    final child = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Semantics(
          label: value(m, 'label').isEmpty
              ? tr("System message")
              : value(m, 'label'),
          expanded: expandable ? systemOpen : null,
          child: InkWell(
            onTap: expandable
                ? () => setState(() => systemOpen = !systemOpen)
                : null,
            borderRadius: BorderRadius.circular(8),
            child: Container(
              constraints: const BoxConstraints(minHeight: 28),
              padding: EdgeInsets.fromLTRB(notice ? 0 : 4, 2, 8, 2),
              child: Row(
                children: [
                  SizedBox(
                    width: 20,
                    height: 20,
                    child: Icon(
                      icon,
                      size: 14,
                      color:
                          p[kind == 'compaction' || kind == 'branch'
                              ? 'accent.default'
                              : notice
                              ? color
                              : 'text.muted'],
                    ),
                  ),
                  const SizedBox(width: 6),
                  Flexible(
                    fit: detail.isEmpty ? FlexFit.tight : FlexFit.loose,
                    child: Text(
                      name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style:
                          webText(
                            context,
                            size: notice
                                ? 14
                                : kind == 'bash'
                                ? 12.5
                                : 13,
                            color: color,
                          ).copyWith(
                            fontFamily: kind == 'bash' ? 'monospace' : null,
                          ),
                    ),
                  ),
                  if (detail.isNotEmpty) ...[
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        detail,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: webText(
                          context,
                          size: notice ? 13 : 12,
                          color: 'text.muted',
                        ),
                      ),
                    ),
                  ],
                  if (!phone) ...[
                    const SizedBox(width: 6),
                    Text(
                      time(context),
                      style: webText(context, size: 12, color: 'text.muted'),
                    ),
                  ],
                  if (expandable && (!notice || systemOpen)) ...[
                    const SizedBox(width: 6),
                    Icon(
                      systemOpen
                          ? LucideIcons.chevronDown
                          : LucideIcons.chevronRight,
                      size: 14,
                      color: p['text.muted'],
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
        if ((notice ? systemOpen : !collapsible || systemOpen) &&
            text.isNotEmpty)
          Container(
            margin: EdgeInsets.fromLTRB(phone ? 0 : 22, 4, 0, notice ? 8 : 0),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            decoration: BoxDecoration(
              color: p['code.bg'],
              borderRadius: BorderRadius.circular(12),
            ),
            child: kind == 'bash' || runtime
                ? ConstrainedBox(
                    constraints: const BoxConstraints(maxHeight: 320),
                    child: SingleChildScrollView(
                      child: SelectableText(
                        text,
                        style: webText(
                          context,
                          size: 12.5,
                          color: 'text.secondary',
                        ).copyWith(fontFamily: 'monospace', height: 1.6),
                      ),
                    ),
                  )
                : markdown(text, compact: true),
          ),
        if (!notice && systemOpen && rows(m['images']).isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: TimelineImages(
              rows(m['images']),
              gateway: widget.controller.gateway,
            ),
          ),
        if (!notice && systemOpen && tools.isNotEmpty) toolStack(tools, top: 4),
      ],
    );
    return Padding(
      padding: EdgeInsets.only(
        bottom: notice
            ? widget.lastProcess
                  ? 16
                  : 2
            : 12,
      ),
      child: notice
          ? child
          : Transform.translate(offset: const Offset(0, -8), child: child),
    );
  }
}
