import '../l10n/app_i18n.dart';
import 'dart:async';
import 'dart:math' as math;
import 'dart:ui' show SemanticsRole;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'attention.dart';
import 'common.dart';
import 'gateway.dart';
import 'web_controls.dart';
import 'work_index.dart';

Future<bool?> deleteProjectDialog(
  BuildContext context,
  LiveController controller,
  Json workspace,
) {
  final catalog = controller.catalog;
  if (!catalog.of(workspace).projects || catalog.topChats(workspace)) {
    return Future.value(false);
  }
  return showDialog<bool>(
    context: context,
    useRootNavigator: false,
    barrierColor: Colors.black.withValues(alpha: .4),
    builder: (_) =>
        _DeleteProjectDialog(controller: controller, workspace: workspace),
  );
}

class _DeleteProjectDialog extends StatefulWidget {
  const _DeleteProjectDialog({
    required this.controller,
    required this.workspace,
  });
  final LiveController controller;
  final Json workspace;
  @override
  State<_DeleteProjectDialog> createState() => _DeleteProjectDialogState();
}

class _DeleteProjectDialogState extends State<_DeleteProjectDialog> {
  late final int account = widget.controller.accountRevision;
  late final String? origin = widget.controller.origin,
      client = widget.controller.clientId,
      stamp = widget.controller.pairingStamp;
  late final String id = '${widget.workspace['id']}',
      host = '${widget.workspace['hostId']}';
  Json? preview;
  final choices = <String, String>{};
  final edits = <String, String>{};
  bool busy = false, loading = false, closing = false;
  late bool wasOnline;
  String? error;
  int generation = 0;
  String get path => '/api/workspaces/${enc(id)}/deletion';
  Json? get workspace =>
      widget.controller.workspaces.where((w) => w['id'] == id).firstOrNull;
  bool get online =>
      workspace != null && workspaceOnline(workspace!, widget.controller.nodes);
  bool get identityValid =>
      mounted &&
      account == widget.controller.accountRevision &&
      origin == widget.controller.origin &&
      client == widget.controller.clientId &&
      stamp == widget.controller.pairingStamp;
  bool get scopeValid =>
      identityValid &&
      workspace != null &&
      '${workspace!['hostId']}' == host &&
      widget.controller.catalog.of(workspace!).projects &&
      !widget.controller.catalog.topChats(workspace!);
  bool current(int ticket) => !closing && scopeValid && ticket == generation;
  List<Json> items(String action) => rows(
    preview?['memory'],
  ).where((item) => item['action'] == action).toList();
  bool get decided => items('review').every((item) {
    final entryId = '${obj(item['entry'])['id']}';
    final choice = choices[entryId];
    final text = (edits[entryId] ?? '').trim();
    return choice != null &&
        (choice != 'edit' || (text.isNotEmpty && text.length <= 1000));
  });

  @override
  void initState() {
    super.initState();
    wasOnline = online;
    widget.controller.addListener(controllerChanged);
    unawaited(load());
  }

  @override
  void dispose() {
    generation++;
    widget.controller.removeListener(controllerChanged);
    super.dispose();
  }

  void closeObsolete() {
    if (closing || !mounted) return;
    setState(() {
      closing = true;
      generation++;
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && ModalRoute.of(context)?.isCurrent == true) {
        Navigator.pop(context, false);
      }
    });
  }

  void controllerChanged() {
    if (!scopeValid) {
      if (busy && identityValid && workspace == null) return;
      closeObsolete();
      return;
    }
    final nextOnline = online;
    if (wasOnline != nextOnline) {
      wasOnline = nextOnline;
      if (!busy) {
        generation++;
        setState(() {
          loading = false;
        });
        if (nextOnline) unawaited(load());
      } else {
        setState(() {});
      }
    }
  }

  Future<void> load([String? notice]) async {
    if (!scopeValid || closing) {
      closeObsolete();
      return;
    }
    final ticket = ++generation;
    setState(() {
      loading = true;
      preview = null;
      choices.clear();
      edits.clear();
      error = null;
    });
    try {
      final response = await widget.controller.gateway.request(
        path,
        pairingStamp: stamp,
      );
      if (!current(ticket)) return;
      if (obj(response['project'])['id'] != id ||
          response['memory'] is! List ||
          response['chats'] is! List ||
          response['schedules'] is! List ||
          response['keptSchedules'] is! List ||
          response['nodeOnline'] is! bool ||
          response['deleting'] is! bool ||
          response['links'] is! num ||
          response['delegations'] is! num ||
          rows(response['memory']).any(
            (item) =>
                !const {
                  'forget',
                  'rollback',
                  'review',
                }.contains(item['action']) ||
                obj(item['entry'])['id'] is! String ||
                obj(item['entry'])['revision'] is! int ||
                obj(item['entry'])['content'] is! String,
          )) {
        throw StateError(
          tr(
            "The gateway sent an invalid project deletion preview. Reload it before deleting.",
          ),
        );
      }
      setState(() {
        preview = response;
        for (final item in rows(response['memory'])) {
          final entry = obj(item['entry']);
          edits['${entry['id']}'] = '${entry['content'] ?? ''}';
        }
        error = notice;
      });
    } catch (cause) {
      if (current(ticket)) setState(() => error = attentionRequestError(cause));
    } finally {
      if (current(ticket)) setState(() => loading = false);
    }
  }

  Future<void> remove() async {
    if (!scopeValid ||
        closing ||
        busy ||
        loading ||
        preview == null ||
        !online ||
        preview!['nodeOnline'] != true ||
        !decided) {
      return;
    }
    final ticket = generation;
    final decisions = [
      for (final item in items('review'))
        {
          'entryId': obj(item['entry'])['id'],
          'revision': obj(item['entry'])['revision'],
          'action': choices['${obj(item['entry'])['id']}'],
          if (choices['${obj(item['entry'])['id']}'] == 'edit')
            'content': edits['${obj(item['entry'])['id']}']!.trim(),
        },
    ];
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await widget.controller.deleteProject(id, decisions);
      if (!mounted || closing) return;
      if (!identityValid) {
        closeObsolete();
        return;
      }
      closing = true;
      if (ModalRoute.of(context)?.isCurrent == true) {
        Navigator.pop(context, true);
      }
    } catch (cause) {
      if (!current(ticket)) {
        if (!scopeValid) closeObsolete();
        return;
      }
      final conflict =
          cause is PlatformException &&
          cause.code == 'HTTP_409' &&
          obj(cause.details)['code'] == 'conflict';
      final notice = conflict
          ? tr("Memory changed since this was shown. Review it again.")
          : attentionRequestError(cause);
      if (!conflict) await widget.controller.refreshList();
      if (!current(ticket)) return;
      await load(notice);
    } finally {
      if (mounted && !closing) setState(() => busy = false);
    }
  }

  String plural(int count, String one, [String? many]) =>
      '$count ${count == 1 ? one : many ?? '${one}s'}';
  Widget text(String value, {bool alert = false, String? key}) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 6),
    child: Semantics(
      role: alert ? SemanticsRole.alert : null,
      child: Text(
        value,
        key: key == null ? null : ValueKey(key),
        style: webText(
          context,
          size: 14,
          color: alert ? 'status.danger' : 'text.secondary',
        ).copyWith(height: 1.6),
      ),
    ),
  );
  Widget heading(String value) => Padding(
    padding: const EdgeInsets.only(top: 18, bottom: 6),
    child: Text(
      value,
      style: webText(context, size: 14, weight: FontWeight.w600),
    ),
  );
  Widget bullet(String value, {List<Widget> nested = const []}) => Padding(
    padding: const EdgeInsets.only(left: 4),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          '•',
          style: webText(
            context,
            size: 14,
            color: 'text.secondary',
          ).copyWith(height: 1.6),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                value,
                style: webText(
                  context,
                  size: 14,
                  color: 'text.secondary',
                ).copyWith(height: 1.6),
              ),
              ...nested,
            ],
          ),
        ),
      ],
    ),
  );
  Widget reviewEntry(Json item) {
    final entry = obj(item['entry']), entryId = '${obj(item['entry'])['id']}';
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 8),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: palette(context)['surface.subtle'],
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            '“${entry['content']}”',
            style: webText(context, size: 14).copyWith(height: 1.6),
          ),
          const SizedBox(height: 6),
          RadioGroup<String>(
            groupValue: choices[entryId],
            onChanged: (value) {
              if (!busy && !loading) {
                setState(() {
                  if (value != null) choices[entryId] = value;
                });
              }
            },
            child: Wrap(
              spacing: 14,
              runSpacing: 6,
              children: [
                for (final option in {
                  'forget': tr("Forget"),
                  'keep': tr("Keep as is"),
                  'edit': tr("Edit"),
                }.entries)
                  InkWell(
                    key: ValueKey('project-memory-$entryId-${option.key}'),
                    onTap: busy || loading
                        ? null
                        : () => setState(() => choices[entryId] = option.key),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        SizedBox(
                          width: 18,
                          height: 18,
                          child: Radio<String>(
                            value: option.key,
                            enabled: !busy && !loading,
                            materialTapTargetSize:
                                MaterialTapTargetSize.shrinkWrap,
                            visualDensity: VisualDensity.compact,
                          ),
                        ),
                        const SizedBox(width: 6),
                        Text(
                          option.value,
                          style: webText(
                            context,
                            size: 13,
                            weight: FontWeight.w500,
                            color: 'text.secondary',
                          ),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
          if (choices[entryId] == 'edit') ...[
            const SizedBox(height: 8),
            TextFormField(
              key: ValueKey('project-memory-$entryId-text'),
              initialValue: edits[entryId],
              enabled: !busy && !loading,
              minLines: 2,
              maxLines: null,
              maxLength: 1000,
              style: webText(context, size: 14).copyWith(height: 1.6),
              decoration: InputDecoration(
                labelText: tr("New text"),
                counterText: '',
                filled: true,
                fillColor: palette(context)['surface.layer'],
                contentPadding: const EdgeInsets.symmetric(
                  horizontal: 10,
                  vertical: 8,
                ),
                errorText: (edits[entryId]?.trim().length ?? 0) > 1000
                    ? tr("Use at most 1000 characters.")
                    : null,
              ),
              onChanged: (value) => setState(() => edits[entryId] = value),
            ),
          ],
        ],
      ),
    );
  }

  List<Widget> contents() {
    final data = preview;
    if (data == null) {
      return [
        if (loading)
          Semantics(
            role: SemanticsRole.status,
            child: text(tr("Loading what the project holds…")),
          ),
        if (error != null) text(error!, alert: true),
        if (!loading)
          WebButton(
            tr("Retry"),
            key: const ValueKey('project-deletion-retry'),
            onPressed: busy ? null : () => load(),
          ),
      ];
    }
    final forgotten = items('forget'),
        rollback = items('rollback'),
        review = items('review');
    final schedules = rows(data['schedules']),
        kept = rows(data['keptSchedules']);
    final links = (data['links'] as num?)?.toInt() ?? 0,
        delegations = (data['delegations'] as num?)?.toInt() ?? 0;
    return [
      if (data['deleting'] == true)
        text(
          tr(
            "An earlier deletion of this project did not finish. Deleting again completes it; entries you kept come up for a decision again.",
          ),
          alert: true,
        ),
      heading(tr("Deleted")),
      bullet(
        tr(
          "{0}, with their messages, working files, uploads and private transcripts",
          [plural(rows(data['chats']).length, 'chat')],
        ),
      ),
      bullet(
        tr("The project's instructions, files, capability settings{0}", [
          links > 0 ? ' and its links to ${plural(links, 'workspace')}' : '',
        ]),
      ),
      if (schedules.isNotEmpty)
        bullet(
          tr("{0} that run here: {1}", [
            plural(schedules.length, 'schedule'),
            schedules.map((s) => '“${s['title']}”').join(', '),
          ]),
        ),
      if (delegations > 0)
        bullet(
          tr("The records of {0} its chats started", [
            plural(delegations, 'delegated task'),
          ]),
        ),
      if (forgotten.isNotEmpty)
        bullet(
          tr("{0} written only here:", [
            plural(forgotten.length, 'memory entry', 'memory entries'),
          ]),
          nested: [
            for (final item in forgotten)
              bullet('“${obj(item['entry'])['content']}”'),
          ],
        ),
      if (rollback.isNotEmpty)
        bullet(
          tr(
            "The project's changes to {0}, which go back to their earlier text:",
            [plural(rollback.length, 'memory entry', 'memory entries')],
          ),
          nested: [
            for (final item in rollback)
              bullet(
                '“${obj(item['entry'])['content']}” → “${item['restored']}”',
              ),
          ],
        ),
      if (review.isNotEmpty) ...[
        heading(tr("Needs your decision")),
        text(
          tr(
            "These entries mix text from this project with text from other chats, which cannot be separated automatically.",
          ),
        ),
        for (final item in review) reviewEntry(item),
      ],
      heading(tr("Not deleted")),
      if (kept.isNotEmpty)
        bullet(
          tr("Schedules its chats created in other workspaces: {0}", [
            kept
                .map(
                  (s) =>
                      '“${s['title']}” (${s['workspaceName'] ?? s['workspaceId']})',
                )
                .join(', '),
          ]),
        ),
      bullet(
        tr(
          "Work done by delegated tasks in other workspaces: their sessions, files, commits and the workspace memory they wrote",
        ),
      ),
      bullet(
        tr(
          "Copies in other chats (what they already read, and anything they wrote in their own words)",
        ),
      ),
      bullet(
        tr(
          "Files uploaded before this version of pirc, which do not record their project",
        ),
      ),
      bullet(tr("Backups, logs and what model providers keep")),
      text(
        tr(
          "Forgotten text is not blocked: other chats may write it again. To keep a fact from coming back, forget it in Settings → Memory.",
        ),
      ),
      if (!online || data['nodeOnline'] != true)
        text(tr("Connect the chat node to delete this project."), alert: true),
      if (error != null) text(error!, alert: true),
    ];
  }

  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    return PopScope(
      canPop: !busy,
      child: Dialog(
        insetPadding: const EdgeInsets.all(20),
        backgroundColor: palette(context)['surface.layer'],
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 600),
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  tr("Delete project “{0}”?", [
                    widget.workspace['displayName'],
                  ]),
                  style: webText(context, size: 20, weight: FontWeight.w600),
                ),
                const SizedBox(height: 16),
                ConstrainedBox(
                  constraints: BoxConstraints(
                    maxHeight: math.min(
                      MediaQuery.sizeOf(context).height * .6,
                      560,
                    ),
                  ),
                  child: SingleChildScrollView(
                    key: const ValueKey('project-deletion-body'),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: contents(),
                    ),
                  ),
                ),
                const SizedBox(height: 20),
                Wrap(
                  alignment: WrapAlignment.end,
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    WebButton(
                      tr("Cancel"),
                      key: const ValueKey('project-deletion-cancel'),
                      disabledOpacity: .5,
                      onPressed: busy
                          ? null
                          : () => Navigator.pop(context, false),
                    ),
                    WebButton(
                      busy ? tr("Deleting…") : tr("Delete project"),
                      key: const ValueKey('project-deletion-confirm'),
                      disabledOpacity: .5,
                      primary: true,
                      onPressed:
                          busy ||
                              loading ||
                              closing ||
                              preview == null ||
                              !online ||
                              preview!['nodeOnline'] != true ||
                              !decided
                          ? null
                          : remove,
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
