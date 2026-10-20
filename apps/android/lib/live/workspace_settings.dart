import '../l10n/app_i18n.dart';
import 'dart:async';
import 'dart:ui' show FontVariation, SemanticsRole;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'project_deletion_dialog.dart';
import 'common.dart';
import 'gateway.dart';
import 'work_index.dart';
import 'modes.dart';
import 'web_controls.dart';
import 'workspace_instructions_editor.dart';
import 'workspace_project_files.dart';
import 'workspace_project_links.dart';

class WorkspaceSettings extends StatefulWidget {
  const WorkspaceSettings({
    super.key,
    required this.controller,
    required this.workspace,
  });
  final LiveController controller;
  final Json workspace;
  @override
  State<WorkspaceSettings> createState() => _WorkspaceSettingsState();
}

String _workspaceRequestError(Object error) {
  if (error is PlatformException) {
    final match = RegExp(r'^HTTP_(\d{3})$').firstMatch(error.code);
    if (match != null) {
      return error.message ?? tr("Request failed ({0})", [match.group(1)]);
    }
  }
  return tr("Unable to reach the gateway. Try again.");
}

class _WorkspaceSettingsScope {
  const _WorkspaceSettingsScope({
    required this.controller,
    required this.accountRevision,
    required this.origin,
    required this.clientId,
    required this.pairingStamp,
    required this.workspaceId,
    required this.mode,
    required this.hostId,
    required this.deleting,
  });

  factory _WorkspaceSettingsScope.from(WorkspaceSettings widget) {
    final controller = widget.controller;
    final workspace = widget.workspace;
    return _WorkspaceSettingsScope(
      controller: controller,
      accountRevision: controller.accountRevision,
      origin: controller.origin,
      clientId: controller.clientId,
      pairingStamp: controller.pairingStamp,
      workspaceId: workspace['id']?.toString() ?? '',
      mode: controller.catalog.of(workspace),
      hostId: workspace['hostId']?.toString() ?? '',
      deleting: workspace['deleting'] == true,
    );
  }

  final LiveController controller;
  final int accountRevision;
  final String? origin, clientId, pairingStamp;
  final String workspaceId, hostId;

  /// Capabilities decide which resources load; a mode change resets them.
  final ModeInfo mode;
  final bool deleting;

  /// The node-backed resource that follows the node's online state.
  String? get nodeResource => mode.projectInstructions
      ? 'instructions'
      : mode.projectConfig
      ? 'project-config'
      : null;

  @override
  bool operator ==(Object other) =>
      other is _WorkspaceSettingsScope &&
      identical(controller, other.controller) &&
      accountRevision == other.accountRevision &&
      origin == other.origin &&
      clientId == other.clientId &&
      pairingStamp == other.pairingStamp &&
      workspaceId == other.workspaceId &&
      mode.signature == other.mode.signature &&
      hostId == other.hostId &&
      deleting == other.deleting;

  @override
  int get hashCode => Object.hash(
    identityHashCode(controller),
    accountRevision,
    origin,
    clientId,
    pairingStamp,
    workspaceId,
    mode.signature,
    hostId,
    deleting,
  );
}

class _WorkspaceSettingsState extends State<WorkspaceSettings> {
  final instructions = TextEditingController();
  final data = <String, Json>{},
      errors = <String, String>{},
      statuses = <String, String>{};
  final loading = <String>{}, saving = <String>{};
  final _readGeneration = <String, int>{};
  final _writeGeneration = <String, int>{};
  late _WorkspaceSettingsScope _scope;
  late bool _wasOnline;
  String saved = '';
  int maxChars = 8000;
  int _instructionEditRevision = 0;
  static const delegationApprovalLabels = {
    'always': 'Ask me every time',
    'untrusted': 'Only when the chat read outside content',
    'never': 'Never ask',
  };
  static const delegationApprovalNeverWarning =
      'A prompt injection in content the assistant reads can then start work in your workspaces without asking.';
  bool get online => workspaceOnline(widget.workspace, widget.controller.nodes);

  @override
  void initState() {
    super.initState();
    _scope = _WorkspaceSettingsScope.from(widget);
    _wasOnline = online;
    _initScope();
  }

  void _initScope() {
    final scope = _scope;
    if (scope.deleting) return;
    if (scope.mode.assistant) unawaited(_load('capabilities', scope));
    final resource = scope.nodeResource;
    if (resource != null && _wasOnline) unawaited(_load(resource, scope));
  }

  bool _scopeIsCurrent(_WorkspaceSettingsScope scope) =>
      mounted &&
      _scope == scope &&
      _WorkspaceSettingsScope.from(widget) == scope;

  bool _readIsCurrent(
    _WorkspaceSettingsScope scope,
    String kind,
    int generation,
  ) => _scopeIsCurrent(scope) && _readGeneration[kind] == generation;

  bool _writeIsCurrent(
    _WorkspaceSettingsScope scope,
    String kind,
    int generation,
  ) => _scopeIsCurrent(scope) && _writeGeneration[kind] == generation;

  int _nextReadGeneration(String kind) =>
      _readGeneration[kind] = (_readGeneration[kind] ?? 0) + 1;

  int _nextWriteGeneration(String kind) =>
      _writeGeneration[kind] = (_writeGeneration[kind] ?? 0) + 1;

  void _invalidateResource(String kind) {
    _nextReadGeneration(kind);
    _nextWriteGeneration(kind);
    data.remove(kind);
    errors.remove(kind);
    statuses.remove(kind);
    loading.remove(kind);
    saving.remove(kind);
  }

  void _invalidateAll() {
    for (final kind in const [
      'capabilities',
      'instructions',
      'project-config',
    ]) {
      _invalidateResource(kind);
    }
  }

  void _clearForScopeChange() {
    _invalidateAll();
    instructions.clear();
    saved = '';
    maxChars = 8000;
    _instructionEditRevision++;
  }

  @override
  void didUpdateWidget(covariant WorkspaceSettings old) {
    super.didUpdateWidget(old);
    final nextScope = _WorkspaceSettingsScope.from(widget);
    final nextOnline = online;
    if (nextScope != _scope) {
      _scope = nextScope;
      _clearForScopeChange();
      _wasOnline = nextOnline;
      _initScope();
      return;
    }

    final wasOnline = _wasOnline;
    _wasOnline = nextOnline;
    final resource = nextScope.nodeResource;
    if (resource == null) return;
    if (wasOnline && !nextOnline) {
      // The web page unmounts node-backed instructions/trust while offline.
      // Invalidate in-flight work and force a fresh read when it returns.
      _invalidateResource(resource);
      if (resource == 'instructions') {
        // The source unmounts ProjectInstructions, including its local draft.
        instructions.clear();
        saved = '';
        maxChars = 8000;
        _instructionEditRevision++;
      }
    } else if (!wasOnline && nextOnline) {
      unawaited(_load(resource, nextScope));
    }
  }

  @override
  void dispose() {
    _invalidateAll();
    instructions.dispose();
    super.dispose();
  }

  void apply(
    String kind,
    Json response, {
    bool preserveInstructionsDraft = false,
  }) {
    data[kind] = obj(response[kind == 'project-config' ? 'project' : kind]);
    if (kind == 'instructions') {
      final serverText = '${data[kind]!['text'] ?? ''}';
      saved = serverText;
      if (!preserveInstructionsDraft) {
        instructions.text = serverText;
        _instructionEditRevision++;
      }
      maxChars = (data[kind]!['maxChars'] as num?)?.toInt() ?? 8000;
      if (maxChars <= 0) maxChars = 8000;
    }
  }

  Future<void> load(String kind) => _load(kind, _scope);

  Future<void> _load(String kind, _WorkspaceSettingsScope scope) async {
    if (!_scopeIsCurrent(scope)) return;
    final generation = _nextReadGeneration(kind);
    final editRevision = _instructionEditRevision;
    final hadInstructionDraft =
        kind == 'instructions' && instructions.text != saved;
    setState(() {
      loading.add(kind);
      errors.remove(kind);
    });
    try {
      final path = '/api/workspaces/${enc(scope.workspaceId)}/$kind';
      final response = await scope.controller.gateway.request(path);
      if (!_readIsCurrent(scope, kind, generation)) return;
      setState(
        () => apply(
          kind,
          response,
          preserveInstructionsDraft:
              kind == 'instructions' &&
              (hadInstructionDraft || _instructionEditRevision != editRevision),
        ),
      );
    } catch (e) {
      if (_readIsCurrent(scope, kind, generation)) {
        setState(() => errors[kind] = _workspaceRequestError(e));
      }
    } finally {
      if (_readIsCurrent(scope, kind, generation)) {
        setState(() => loading.remove(kind));
      }
    }
  }

  Future<void> mutate(String kind, Json body, String status) async {
    final scope = _scope;
    if (!_scopeIsCurrent(scope) || saving.contains(kind)) return;
    final generation = _nextWriteGeneration(kind);
    final path =
        '/api/workspaces/${enc(scope.workspaceId)}/${kind == 'project-config' ? 'project-trust' : kind}';
    setState(() {
      saving.add(kind);
      errors.remove(kind);
      statuses.remove(kind);
    });
    try {
      final response = await scope.controller.gateway.request(
        path,
        method: kind == 'project-config' ? 'POST' : 'PATCH',
        body: body,
      );
      if (_writeIsCurrent(scope, kind, generation)) {
        setState(() {
          apply(kind, response);
          statuses[kind] = status;
        });
      }
    } catch (e) {
      if (!_writeIsCurrent(scope, kind, generation)) return;
      setState(() => errors[kind] = _workspaceRequestError(e));
      // A rejected hash requires a fresh review, never a repeated trust POST.
      if (kind == 'project-config' &&
          e is PlatformException &&
          e.code == 'HTTP_409') {
        unawaited(_refreshConflictingProject(scope, generation));
      }
    } finally {
      if (_writeIsCurrent(scope, kind, generation)) {
        setState(() => saving.remove(kind));
      }
    }
  }

  Future<void> _refreshConflictingProject(
    _WorkspaceSettingsScope scope,
    int writeGeneration,
  ) async {
    const kind = 'project-config';
    final readGeneration = _nextReadGeneration(kind);
    try {
      final response = await scope.controller.gateway.request(
        '/api/workspaces/${enc(scope.workspaceId)}/project-config',
      );
      if (_readIsCurrent(scope, kind, readGeneration) &&
          _writeIsCurrent(scope, kind, writeGeneration)) {
        setState(() => apply(kind, response));
      }
    } catch (_) {
      // The pinned Web retains the trust error and reviewed config if this GET fails.
    }
  }

  Widget heading(String title) => Text(
    title.toUpperCase(),
    style: webText(
      context,
      size: 12,
      weight: FontWeight.w600,
      color: 'text.secondary',
    ).copyWith(height: kTextHeightNone, letterSpacing: .24),
  );
  Widget paragraph(
    String text, {
    bool error = false,
    bool status = false,
    FontWeight weight = FontWeight.w400,
  }) {
    final marker = text.indexOf('.pirc/config.json');
    final style = webText(
      context,
      size: 13,
      color: 'text.muted',
      weight: weight,
    );
    // CSS defaults font-optical-sizing to auto. Flutter otherwise leaves a
    // variable system face at its default opsz coordinate, which can change
    // paragraph wrapping even when font size and line height match the Web.
    final paragraphStyle = style.copyWith(
      height: 1.55,
      fontVariations: [
        FontVariation(
          'opsz',
          MediaQuery.textScalerOf(context).scale(style.fontSize ?? 13),
        ),
      ],
    );
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Semantics(
        role: error
            ? SemanticsRole.alert
            : status
            ? SemanticsRole.status
            : SemanticsRole.none,
        child: marker < 0
            ? Text(text, style: paragraphStyle)
            : Text.rich(
                TextSpan(
                  style: paragraphStyle,
                  children: [
                    TextSpan(text: text.substring(0, marker)),
                    TextSpan(
                      text: '.pirc/config.json',
                      style: const TextStyle(
                        fontFamily: 'monospace',
                        fontSize: 12,
                        fontVariations: [],
                      ),
                    ),
                    TextSpan(text: text.substring(marker + 17)),
                  ],
                ),
              ),
      ),
    );
  }

  Widget sectionDivider() => Padding(
    padding: const EdgeInsets.only(top: 28, bottom: 20),
    child: SizedBox(
      height: 1,
      child: ColoredBox(color: palette(context)['web.line']),
    ),
  );
  Widget subheading(String title) => Padding(
    padding: const EdgeInsets.only(top: 16, bottom: 6),
    child: Text(
      title,
      style: webText(
        context,
        size: 13,
        weight: FontWeight.w600,
        color: 'text.secondary',
      ).copyWith(height: kTextHeightNone),
    ),
  );
  List<Widget> feedback(String kind) => [
    if (errors[kind] != null) paragraph(errors[kind]!, error: true),
    if (errors[kind] != null && !data.containsKey(kind))
      Align(
        alignment: Alignment.centerLeft,
        child: WebButton(
          tr("Retry"),
          disabledOpacity: .5,
          onPressed: loading.contains(kind) ? null : () => load(kind),
        ),
      ),
    if (saving.contains(kind) && kind != 'instructions')
      paragraph(
        kind == 'capabilities'
            ? tr("Saving project capabilities…")
            : tr("Saving…"),
        status: true,
      )
    else if (statuses[kind] != null)
      paragraph(statuses[kind]!, status: true),
  ];
  Widget capabilityGroup(Json cap) => Semantics(
    key: const ValueKey('project-capabilities-group'),
    container: true,
    explicitChildNodes: true,
    label: tr("Allowed assistant features"),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(2, 16, 2, 8),
          child: ExcludeSemantics(
            child: Text(
              tr("Allowed assistant features"),
              style: webText(
                context,
                size: 13,
                color: 'text.secondary',
              ).copyWith(height: kTextHeightNone),
            ),
          ),
        ),
        for (final e in {
          'delegation': tr("Delegation"),
          'memory_search': tr("Memory search"),
          'remote_recall': tr("Remote recall"),
          'schedules': tr("Schedules"),
          'web_search': tr("Web search"),
        }.entries)
          capabilityToggle(e.key, e.value, cap),
        delegationApprovalSelect(cap),
      ],
    ),
  );

  /// Who must approve a delegation: only meaningful while delegation is on.
  /// Older gateways omit the field; it then reads as `always`.
  Widget delegationApprovalSelect(Json capabilities) {
    final raw = '${capabilities['delegation_approval'] ?? 'always'}';
    final value = delegationApprovalLabels.containsKey(raw) ? raw : 'always';
    final enabled =
        capabilities['delegation'] == true && !saving.contains('capabilities');
    final text = webText(
      context,
      size: 13,
      color: 'text.secondary',
    ).copyWith(height: kTextHeightNone);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(child: Text(tr("Delegation approval"), style: text)),
              const SizedBox(width: 12),
              Flexible(
                child: Semantics(
                  label: tr("Delegation approval"),
                  enabled: enabled,
                  child: Opacity(
                    opacity: enabled ? 1 : .5,
                    child: DropdownButtonHideUnderline(
                      child: DropdownButton<String>(
                        key: const ValueKey('capability-delegation-approval'),
                        value: value,
                        isDense: true,
                        isExpanded: true,
                        style: text,
                        borderRadius: BorderRadius.circular(10),
                        items: [
                          for (final e in delegationApprovalLabels.entries)
                            DropdownMenuItem(
                              value: e.key,
                              child: Text(
                                tr(e.value),
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                        ],
                        onChanged: enabled
                            ? (next) {
                                if (next == null || next == value) return;
                                mutate(
                                  'capabilities',
                                  {
                                    'capabilities': {
                                      'delegation_approval': next,
                                    },
                                  },
                                  tr("Project capabilities saved."),
                                );
                              }
                            : null,
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ),
          if (capabilities['delegation'] != true)
            paragraph(tr("Applies only while delegation is allowed."))
          else if (value == 'untrusted')
            paragraph(
              tr(
                "Outside content: web pages, search, browser, memory search, and delegation reports since your last message.",
              ),
            )
          else if (value == 'never')
            Padding(
              key: const ValueKey('delegation-approval-warning'),
              padding: const EdgeInsets.only(top: 8),
              child: Text(
                tr(delegationApprovalNeverWarning),
                style: webText(
                  context,
                  size: 13,
                  color: 'status.danger',
                ).copyWith(height: 1.55),
              ),
            ),
        ],
      ),
    );
  }

  Widget capabilityToggle(String key, String label, Json capabilities) {
    final value = capabilities[key] == true;
    final enabled = !saving.contains('capabilities');
    void toggle() => mutate('capabilities', {
      'capabilities': {key: !value},
    }, tr("Project capabilities saved."));
    return Semantics(
      label: label,
      toggled: value,
      enabled: enabled,
      onTap: enabled ? toggle : null,
      child: ExcludeSemantics(
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: enabled ? toggle : null,
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    label,
                    style: webText(
                      context,
                      size: 13,
                      color: 'text.secondary',
                    ).copyWith(height: kTextHeightNone),
                  ),
                ),
                const SizedBox(width: 12),
                Padding(
                  padding: const EdgeInsets.fromLTRB(4, 3, 3, 3),
                  child: SizedBox(
                    key: ValueKey('capability-checkbox-$key'),
                    width: 16,
                    height: 16,
                    child: Transform.scale(
                      scale: 16 / 18,
                      child: Checkbox(
                        value: value,
                        materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                        visualDensity: VisualDensity.compact,
                        onChanged: enabled ? (_) => toggle() : null,
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

  Widget code(String text) => Container(
    width: double.infinity,
    margin: const EdgeInsets.only(top: 4),
    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
    decoration: BoxDecoration(
      color: palette(context)['web.code-bg'],
      borderRadius: BorderRadius.circular(8),
    ),
    child: SelectableText(
      text,
      style: webText(
        context,
        size: 12,
        color: 'web.code-ink',
      ).copyWith(fontFamily: 'monospace', height: 1.5),
    ),
  );
  Widget fact(String label, String value) => ConstrainedBox(
    constraints: const BoxConstraints(minHeight: 32),
    child: Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Text(
          label,
          style: webText(
            context,
            size: 13,
            color: 'text.muted',
          ).copyWith(height: kTextHeightNone),
        ),
        const SizedBox(width: 12),
        Flexible(
          child: Text(
            value,
            textAlign: TextAlign.end,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: webText(context, size: 13).copyWith(height: kTextHeightNone),
          ),
        ),
      ],
    ),
  );
  Widget facts(Json w, List<Json> sessions, Json? lease) {
    final values = <(String, String)>[
      (tr("Device"), '${w['hostId']} · ${online ? 'online' : 'offline'}'),
      (
        tr("Sessions"),
        '${sessions.length}${sessions.any(isWorking) ? ' · ${sessions.where(isWorking).length} running' : ''}${sessions.any((s) => s['unread'] == true) ? ' · ${sessions.where((s) => s['unread'] == true).length} unread' : ''}',
      ),
      (
        tr("Write lease"),
        lease == null ? tr("Free") : tr("Held by “{0}”", [lease['name']]),
      ),
      if ('${obj(w['defaults'])['modelId'] ?? ''}'.isNotEmpty)
        (tr("Default model"), '${obj(w['defaults'])['modelId']}'),
      if ('${obj(w['defaults'])['thinkingLevel'] ?? ''}'.isNotEmpty)
        (tr("Default thinking"), '${obj(w['defaults'])['thinkingLevel']}'),
    ];
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Column(
        children: [
          for (final (index, value) in values.indexed) ...[
            if (index > 0) const SizedBox(height: 2),
            fact(value.$1, value.$2),
          ],
        ],
      ),
    );
  }

  /// Project instructions/files, links and deletion, each by capability.
  List<Widget> projectSections(Json w, ModeInfo mode, bool top) {
    final noun = mode.noun;
    return [
      if (mode.projectInstructions || mode.projectFiles)
        if (!online)
          Padding(
            padding: const EdgeInsets.all(12),
            child: Text(
              tr(
                "The project's node is offline: its {0} can be changed once it is back.",
                [
                  mode.projectInstructions && mode.projectFiles
                      ? 'instructions and files'
                      : mode.projectInstructions
                      ? 'instructions'
                      : 'files',
                ],
              ),
              style: webText(
                context,
                size: 13,
                color: 'text.muted',
              ).copyWith(height: kTextHeightNone),
            ),
          )
        else if (mode.projectInstructions) ...[
          heading(tr("Project instructions")),
          paragraph(
            tr(
              "Instructions for every {0} in this project. Only you can change them: the assistant cannot edit them. They are kept on the project's node, and each {1} keeps the instructions it started with, so a change reaches new {2}s only.",
              [noun, noun, noun],
            ),
          ),
          if (loading.contains('instructions'))
            paragraph(tr("Loading project instructions…"), status: true),
          if (data.containsKey('instructions')) ...[
            WorkspaceInstructionsEditor(
              controller: instructions,
              enabled: !saving.contains('instructions'),
              tooLong: instructions.text.length > maxChars,
              count: tr("{0} / {1} characters", [
                instructions.text.length,
                maxChars,
              ]),
              onChanged: (_) {
                _instructionEditRevision++;
                setState(() {});
              },
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: Text(
                    tr("{0} / {1} characters", [
                      instructions.text.length,
                      maxChars,
                    ]),
                    style:
                        webText(
                          context,
                          size: 13,
                          color: instructions.text.length > maxChars
                              ? 'status.danger'
                              : 'text.secondary',
                        ).copyWith(
                          height: kTextHeightNone,
                          // ProjectInstructions.svelte sets this row to 13px;
                          // it inherits the page's CSS font-optical-sizing:auto.
                          fontVariations: [
                            FontVariation(
                              'opsz',
                              MediaQuery.textScalerOf(context).scale(13),
                            ),
                          ],
                        ),
                  ),
                ),
                const SizedBox(width: 12),
                WebButton(
                  saving.contains('instructions') ? tr("Saving…") : tr("Save"),
                  key: const ValueKey('workspace-instructions-save'),
                  backgroundColor: palette(context)['web.bg-hover'],
                  disabledOpacity: .5,
                  onPressed:
                      saving.contains('instructions') ||
                          instructions.text.length > maxChars ||
                          instructions.text.trim() == saved
                      ? null
                      : () => mutate(
                          'instructions',
                          {'text': instructions.text},
                          tr(
                            "Project instructions saved. New {0}s in this project will use them.",
                            [noun],
                          ),
                        ),
                ),
              ],
            ),
          ],
          ...feedback('instructions'),
        ],
      if (mode.projectFiles && online && w['deleting'] != true) ...[
        sectionDivider(),
        WorkspaceProjectFiles(controller: widget.controller, workspace: w),
      ],
      if (mode.projects && !top) ...[
        sectionDivider(),
        WorkspaceProjectLinks(
          controller: widget.controller,
          workspaceId: '${w['id']}',
        ),
        sectionDivider(),
        heading(tr("Delete project")),
        paragraph(
          tr(
            "Deletes the project, its {0}s and what they wrote to memory. You see what goes and what stays before anything is deleted.",
            [noun],
          ),
        ),
        Align(
          alignment: Alignment.centerLeft,
          child: WebButton(
            tr("Delete project…"),
            key: const ValueKey('project-delete-open'),
            danger: true,
            icon: LucideIcons.trash2,
            disabledOpacity: .5,
            onPressed: online
                ? () => deleteProjectDialog(context, widget.controller, w)
                : null,
          ),
        ),
        if (!online)
          paragraph(tr("Connect the chat node to delete this project.")),
      ],
    ];
  }

  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    final w = widget.workspace;
    final mode = widget.controller.catalog.of(w);
    final top = widget.controller.catalog.topChats(w);
    if ((mode.assistant || mode.projects) && w['deleting'] == true) {
      return paragraph(tr("Settings are gone with the project's deletion."));
    }
    final sessions = widget.controller.sessions
        .where((s) => s['workspaceId'] == w['id'])
        .toList();
    final cap = data['capabilities'], project = data['project-config'];
    final defaultModel = obj(project?['defaultModel']);
    final lease = sessions
        .where((s) => s['writeLease'] != null && s['writeLease'] != false)
        .firstOrNull;
    final projectWidgets = projectSections(w, mode, top);
    return Column(
      key: const ValueKey('workspace-settings-content'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (mode.assistant) ...[
          ...projectWidgets,
          if (online && projectWidgets.isNotEmpty) sectionDivider(),
          heading(tr("Project capabilities")),
          paragraph(
            tr(
              "Choose which assistant features this {0} workspace may use. All capabilities are allowed by default. Changes are saved to and enforced by the gateway, not just hidden in this browser.",
              [mode.noun],
            ),
          ),
          paragraph(
            tr(
              "This is not a sandbox: these settings do not isolate files, shell commands, or network access. They do not revoke data already in a conversation or stop work already running.",
            ),
          ),
          if (loading.contains('capabilities'))
            paragraph(tr("Loading project capabilities…"), status: true),
          if (cap != null) capabilityGroup(cap),
          ...feedback('capabilities'),
        ] else ...[
          heading(tr("Workspace")),
          facts(w, sessions, lease),
          if (projectWidgets.isNotEmpty) ...[
            if (online) sectionDivider(),
            ...projectWidgets,
          ],
          if (mode.projectConfig) ...[
            if (online) sectionDivider(),
            if (!online)
              Padding(
                padding: const EdgeInsets.all(12),
                child: Text(
                  tr(
                    "The workspace's node is offline: its project config can be reviewed once it is back.",
                  ),
                  style: webText(
                    context,
                    size: 13,
                    color: 'text.muted',
                  ).copyWith(height: kTextHeightNone),
                ),
              )
            else ...[
              heading(tr("Project config")),
              paragraph(
                tr(
                  "A repository's .pirc/config.json can run hook commands, set environment variables for every command the agent runs, add writable paths, and choose the model new sessions use. The workspace ignores these values until you trust them. If the repository changes them later, they are ignored again until you trust the new values.",
                ),
              ),
              if (loading.contains('project-config'))
                paragraph(tr("Loading project config…"), status: true),
              if (project != null) ...[
                if (project['error'] != null)
                  paragraph(
                    tr("The project config is invalid and is not used: {0}", [
                      project['error'],
                    ]),
                  )
                else if (project['empty'] == true)
                  paragraph(
                    tr(
                      "This workspace's project config sets no hooks, environment, allowed paths or default model.",
                    ),
                  )
                else ...[
                  paragraph(
                    project['trusted'] == true
                        ? tr("Trusted")
                        : project['trustedHash'] != null
                        ? tr(
                            "Changed since trusted: ignored until you trust it again",
                          )
                        : tr("Not trusted: ignored"),
                    weight: FontWeight.w600,
                  ),
                  if (obj(
                    project['hooks'],
                  ).values.any((v) => rows(v).isNotEmpty)) ...[
                    subheading(tr("Hooks")),
                    for (final (index, e)
                        in obj(project['hooks']).entries
                            .where((e) => rows(e.value).isNotEmpty)
                            .indexed) ...[
                      if (index > 0) const SizedBox(height: 10),
                      RichText(
                        textScaler: MediaQuery.textScalerOf(context),
                        text: TextSpan(
                          style: webText(
                            context,
                            size: 16,
                          ).copyWith(height: kTextHeightNone),
                          children: [
                            TextSpan(
                              text:
                                  {
                                    'sessionStart': tr("When a session starts"),
                                    'beforePrompt': tr("Before each prompt"),
                                    'beforeTool': tr("Before a tool runs"),
                                    'afterTool': tr("After a tool runs"),
                                    'agentSettled': tr(
                                      "When the agent settles",
                                    ),
                                  }[e.key] ??
                                  e.key,
                              style: webText(
                                context,
                                size: 12,
                                color: 'text.muted',
                              ).copyWith(height: kTextHeightNone),
                            ),
                          ],
                        ),
                        strutStyle: StrutStyle(
                          fontFamily: Theme.of(
                            context,
                          ).textTheme.bodyMedium?.fontFamily,
                          fontSize: 16,
                          forceStrutHeight: true,
                        ),
                      ),
                      for (final hook in rows(e.value)) ...[
                        code('${hook['command']}'),
                        if ('${hook['matcher'] ?? ''}'.isNotEmpty)
                          Padding(
                            padding: const EdgeInsets.only(top: 2),
                            child: Text.rich(
                              TextSpan(
                                style: webText(
                                  context,
                                  size: 12,
                                  color: 'text.muted',
                                ).copyWith(height: kTextHeightNone),
                                children: [
                                  TextSpan(
                                    text: tr("Only for tools matching "),
                                  ),
                                  TextSpan(
                                    text: '${hook['matcher']}',
                                    style: const TextStyle(
                                      fontFamily: 'monospace',
                                      fontSize: 12,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ),
                      ],
                    ],
                  ],
                  if (obj(project['env']).isNotEmpty) ...[
                    subheading(tr("Environment")),
                    code(
                      obj(
                        project['env'],
                      ).entries.map((e) => '${e.key}=${e.value}').join('\n'),
                    ),
                  ],
                  if (project['allowedPaths'] is List &&
                      (project['allowedPaths'] as List).isNotEmpty) ...[
                    subheading(tr("Allowed paths")),
                    code((project['allowedPaths'] as List).join('\n')),
                  ],
                  if ('${defaultModel['provider'] ?? ''}'.isNotEmpty &&
                      '${defaultModel['id'] ?? ''}'.isNotEmpty) ...[
                    subheading(tr("Default model")),
                    code(
                      '${defaultModel['provider']}/${defaultModel['id']}'
                      '${defaultModel['thinking'] == null ? '' : ' (thinking ${defaultModel['thinking']})'}',
                    ),
                  ],
                ],
                // The pinned Svelte output retains a whitespace text node in
                // .actions, so :empty does not remove its 12px top margin.
                Padding(
                  padding: const EdgeInsets.only(top: 12),
                  child: Wrap(
                    spacing: 8,
                    children: [
                      if (project['trusted'] != true &&
                          '${project['hash'] ?? ''}'.isNotEmpty &&
                          project['empty'] != true)
                        WebButton(
                          tr("Trust"),
                          primary: true,
                          disabledOpacity: .5,
                          onPressed: saving.contains('project-config')
                              ? null
                              : () => mutate(
                                  'project-config',
                                  {'trusted': true, 'hash': project['hash']},
                                  tr(
                                    "Trusted. New sessions in this workspace use these hooks, environment, paths and default model.",
                                  ),
                                ),
                        ),
                      if (project['trustedHash'] != null)
                        WebButton(
                          tr("Revoke trust"),
                          disabledOpacity: .5,
                          onPressed: saving.contains('project-config')
                              ? null
                              : () => mutate(
                                  'project-config',
                                  {'trusted': false},
                                  tr(
                                    "Trust revoked. New sessions ignore them.",
                                  ),
                                ),
                        ),
                    ],
                  ),
                ),
              ],
              ...feedback('project-config'),
            ],
          ],
        ],
      ],
    );
  }
}
