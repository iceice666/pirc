import 'dart:async';
import 'dart:ui' show SemanticsRole;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'common.dart';
import 'gateway.dart';
import 'web_controls.dart';
import 'work_index.dart';

class WorkspaceProjectLinks extends StatefulWidget {
  const WorkspaceProjectLinks({
    super.key,
    required this.controller,
    required this.workspaceId,
  });

  final LiveController controller;
  final String workspaceId;

  @override
  State<WorkspaceProjectLinks> createState() => _WorkspaceProjectLinksState();
}

class _ProjectLinksScope {
  const _ProjectLinksScope({
    required this.controller,
    required this.accountRevision,
    required this.origin,
    required this.clientId,
    required this.pairingStamp,
    required this.workspaceId,
  });

  factory _ProjectLinksScope.from(WorkspaceProjectLinks widget) =>
      _ProjectLinksScope(
        controller: widget.controller,
        accountRevision: widget.controller.accountRevision,
        origin: widget.controller.origin,
        clientId: widget.controller.clientId,
        pairingStamp: widget.controller.pairingStamp,
        workspaceId: widget.workspaceId,
      );

  final LiveController controller;
  final int accountRevision;
  final String? origin, clientId, pairingStamp;
  final String workspaceId;

  @override
  bool operator ==(Object other) =>
      other is _ProjectLinksScope &&
      identical(controller, other.controller) &&
      accountRevision == other.accountRevision &&
      origin == other.origin &&
      clientId == other.clientId &&
      pairingStamp == other.pairingStamp &&
      workspaceId == other.workspaceId;

  @override
  int get hashCode => Object.hash(
    identityHashCode(controller),
    accountRevision,
    origin,
    clientId,
    pairingStamp,
    workspaceId,
  );
}

class _WorkspaceProjectLinksState extends State<WorkspaceProjectLinks> {
  List<Json>? links;
  Set<String> chosen = {};
  bool loading = false, saving = false;
  String? error, status;
  late _ProjectLinksScope _scope;
  late List<Json> _observedWorkspaces, _observedNodes;
  int _generation = 0;

  /// Link targets: workspaces whose mode accepts delegated work.
  List<Json> get directoryWorkspaces =>
      widget.controller.catalog.delegateTargets(widget.controller.workspaces);

  @override
  void initState() {
    super.initState();
    _scope = _ProjectLinksScope.from(widget);
    _observedWorkspaces = widget.controller.workspaces;
    _observedNodes = widget.controller.nodes;
    widget.controller.addListener(_controllerChanged);
    unawaited(load());
  }

  @override
  void didUpdateWidget(covariant WorkspaceProjectLinks oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != widget.controller) {
      oldWidget.controller.removeListener(_controllerChanged);
      widget.controller.addListener(_controllerChanged);
    }
    _syncScope();
  }

  @override
  void dispose() {
    _generation++;
    widget.controller.removeListener(_controllerChanged);
    super.dispose();
  }

  bool _isCurrent(_ProjectLinksScope scope, int generation) =>
      mounted &&
      _scope == scope &&
      _ProjectLinksScope.from(widget) == scope &&
      _generation == generation;

  void _controllerChanged() {
    if (!mounted) return;
    if (_syncScope()) return;
    final workspaces = widget.controller.workspaces;
    final nodes = widget.controller.nodes;
    if (!identical(workspaces, _observedWorkspaces) ||
        !identical(nodes, _observedNodes)) {
      _observedWorkspaces = workspaces;
      _observedNodes = nodes;
      setState(() {});
    }
  }

  bool _syncScope() {
    final next = _ProjectLinksScope.from(widget);
    if (_scope == next) return false;
    _scope = next;
    _generation++;
    setState(() {
      links = null;
      chosen = {};
      loading = false;
      saving = false;
      error = null;
      status = null;
    });
    unawaited(load());
    return true;
  }

  Future<void> load() async {
    final scope = _scope;
    final generation = ++_generation;
    setState(() {
      loading = true;
      error = null;
      status = null;
    });
    try {
      final response = await scope.controller.gateway.request(
        '/api/workspaces/${enc(scope.workspaceId)}/links',
      );
      if (!_isCurrent(scope, generation)) return;
      final next = rows(response['links']);
      setState(() => _show(next));
    } catch (cause) {
      if (_isCurrent(scope, generation)) {
        setState(() => error = _requestError(cause));
      }
    } finally {
      if (_isCurrent(scope, generation)) {
        setState(() => loading = false);
      }
    }
  }

  void _show(List<Json> next) {
    links = next;
    chosen = next.map((link) => '${link['workspaceId']}').toSet();
  }

  String _requestError(Object cause) {
    if (cause is PlatformException) {
      final match = RegExp(r'^HTTP_(\d{3})$').firstMatch(cause.code);
      if (match != null) {
        return cause.message ?? 'Request failed (${match.group(1)})';
      }
    }
    return 'Unable to reach the gateway. Try again.';
  }

  Json? _linkFor(String id) =>
      links?.where((link) => link['workspaceId'] == id).firstOrNull;

  bool get changed {
    final saved =
        links?.map((link) => '${link['workspaceId']}').toSet() ?? <String>{};
    return chosen.length != saved.length ||
        chosen.any((id) => !saved.contains(id));
  }

  void toggle(String id, bool checked) {
    final next = Set<String>.of(chosen);
    if (checked) {
      next.add(id);
    } else {
      next.remove(id);
    }
    setState(() {
      chosen = next;
      status = null;
    });
  }

  Future<void> save() async {
    final scope = _scope;
    final savedLinks = links;
    if (savedLinks == null || saving || !changed) return;
    final generation = ++_generation;
    final savedIds = savedLinks
        .map((link) => '${link['workspaceId']}')
        .toList();
    final workspaceIds = [
      ...savedIds.where(chosen.contains),
      ...chosen.where((id) => !savedIds.contains(id)),
    ];
    setState(() {
      saving = true;
      error = null;
      status = null;
    });
    try {
      final response = await scope.controller.gateway.request(
        '/api/workspaces/${enc(scope.workspaceId)}/links',
        method: 'PUT',
        body: {'workspaceIds': workspaceIds},
      );
      if (!_isCurrent(scope, generation)) return;
      setState(() {
        _show(rows(response['links']));
        status = 'Linked workspaces saved.';
      });
    } catch (cause) {
      if (_isCurrent(scope, generation)) {
        setState(() => error = _requestError(cause));
      }
    } finally {
      if (_isCurrent(scope, generation)) {
        setState(() => saving = false);
      }
    }
  }

  String _details(Json workspace) {
    final id = '${workspace['id']}';
    final link = _linkFor(id);
    final reach = link?['removed'] == true
        ? 'removed from its device'
        : ((link?['online'] as bool?) ??
              workspaceOnline(workspace, widget.controller.nodes))
        ? ''
        : 'offline';
    return [
      if ('${workspace['hostId'] ?? ''}'.isNotEmpty) '${workspace['hostId']}',
      if ('${link?['repo'] ?? ''}'.isNotEmpty) '${link?['repo']}',
      if (reach.isNotEmpty) reach,
    ].join(' · ');
  }

  Widget _description(String value) => Padding(
    padding: const EdgeInsets.only(top: 8),
    child: Text(
      value,
      style: webText(
        context,
        size: 13,
        color: 'text.muted',
      ).copyWith(height: 1.55),
    ),
  );

  Widget _choice({
    required String id,
    required String name,
    required String details,
  }) => Semantics(
    label: [name, details].where((part) => part.isNotEmpty).join(', '),
    child: InkWell(
      onTap: saving ? null : () => toggle(id, !chosen.contains(id)),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            Checkbox(
              value: chosen.contains(id),
              onChanged: saving ? null : (value) => toggle(id, value == true),
              visualDensity: VisualDensity.compact,
              materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    name,
                    style: webText(context, size: 14, weight: FontWeight.w500),
                  ),
                  if (details.isNotEmpty)
                    Text(
                      details,
                      style: webText(context, size: 12, color: 'text.muted'),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    ),
  );

  @override
  Widget build(BuildContext context) {
    final saved = links ?? const <Json>[];
    final workspaces = directoryWorkspaces;
    final missing = saved
        .where(
          (link) =>
              !workspaces.any((item) => item['id'] == link['workspaceId']),
        )
        .toList(growable: false);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          'Linked workspaces',
          style: webText(context, size: 14, weight: FontWeight.w600),
        ),
        _description(
          'The repositories this project is about. Its assistant lists them first, hands a task to the linked workspace when only one is linked and the task names none, and searches their notes (and those of other clones of the same repository) first.',
        ),
        _description(
          'A link is not a permission: you still approve every delegation, and the assistant can still reach workspaces that are not linked. Chats already open keep the workspace list they started with.',
        ),
        if (loading)
          Padding(
            padding: const EdgeInsets.only(top: 12),
            child: Semantics(
              role: SemanticsRole.status,
              child: Text(
                'Loading linked workspaces…',
                style: webText(context, size: 13, color: 'text.muted'),
              ),
            ),
          )
        else if (links != null) ...[
          Padding(
            padding: const EdgeInsets.only(top: 12),
            child: Text(
              'Workspaces',
              style: webText(context, size: 13, color: 'text.secondary'),
            ),
          ),
          if (workspaces.isEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                'No directory workspaces yet.',
                style: webText(context, size: 13, color: 'text.muted'),
              ),
            ),
          for (final workspace in workspaces)
            _choice(
              id: '${workspace['id']}',
              name: '${workspace['displayName'] ?? workspace['id']}',
              details: _details(workspace),
            ),
          for (final link in missing)
            _choice(
              id: '${link['workspaceId']}',
              name: '${link['name'] ?? link['workspaceId']}',
              details: [
                if ('${link['node'] ?? ''}'.isNotEmpty) '${link['node']}',
                'no longer available',
              ].join(' · '),
            ),
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(
                  '${chosen.length} linked',
                  style: webText(context, size: 13, color: 'text.muted'),
                ),
                WebButton(
                  saving ? 'Saving…' : 'Save',
                  backgroundColor: palette(context)['web.bg-hover'],
                  disabledOpacity: .5,
                  onPressed: saving || !changed ? null : save,
                ),
              ],
            ),
          ),
        ],
        if (error != null) ...[
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Semantics(
              role: SemanticsRole.alert,
              child: Text(
                error!,
                style: webText(context, size: 13, color: 'status.danger'),
              ),
            ),
          ),
          if (links == null)
            Align(
              alignment: Alignment.centerLeft,
              child: WebButton(
                'Retry',
                disabledOpacity: .5,
                onPressed: loading ? null : load,
              ),
            ),
        ],
        if (status != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Semantics(
              role: SemanticsRole.status,
              child: Text(
                status!,
                style: webText(context, size: 13, color: 'text.muted'),
              ),
            ),
          ),
      ],
    );
  }
}
