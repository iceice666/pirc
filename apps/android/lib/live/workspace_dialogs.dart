import 'package:flutter/material.dart';
import 'gateway.dart';
import 'common.dart';
import 'work_index.dart';
import 'modes.dart';
import 'web_controls.dart';

Future<String?> newWorkspaceDialog(
  BuildContext context,
  LiveController c,
  String nodeId, {
  bool project = false,
}) => showDialog<String>(
  context: context,
  useRootNavigator: false,
  barrierDismissible: false,
  builder: (_) => _WorkspaceDialog(c: c, nodeId: nodeId, project: project),
);
Future<void> newSessionDialog(BuildContext context, LiveController c) =>
    showDialog<void>(
      context: context,
      useRootNavigator: false,
      barrierDismissible: false,
      builder: (_) => _NewSession(c),
    );

Widget formField(
  BuildContext context,
  String label,
  TextEditingController control, {
  String? hint,
  bool enabled = true,
  ValueChanged<String>? onChanged,
  int? maxLines = 1,
}) => Padding(
  padding: const EdgeInsets.only(top: 12),
  child: Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(label, style: webText(context, size: 13, weight: FontWeight.w500)),
      const SizedBox(height: 6),
      Container(
        decoration: BoxDecoration(
          color: palette(context)['surface.subtle'],
          borderRadius: BorderRadius.circular(12),
        ),
        child: TextField(
          controller: control,
          enabled: enabled,
          onChanged: onChanged,
          maxLines: maxLines,
          style: webText(context, size: 16),
          decoration: InputDecoration(
            hintText: hint,
            isDense: true,
            contentPadding: const EdgeInsets.all(12),
          ),
        ),
      ),
    ],
  ),
);

class _WorkspaceDialog extends StatefulWidget {
  const _WorkspaceDialog({
    required this.c,
    required this.nodeId,
    required this.project,
  });
  final LiveController c;
  final String nodeId;
  final bool project;
  @override
  State<_WorkspaceDialog> createState() => _WorkspaceDialogState();
}

class _WorkspaceDialogState extends State<_WorkspaceDialog> {
  final name = TextEditingController(), path = TextEditingController();
  late String node = widget.nodeId;

  /// The chosen mode id; null picks the node's first creatable mode.
  String? modeId;
  bool busy = false;
  String? error;
  @override
  void dispose() {
    name.dispose();
    path.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final catalog = widget.c.catalog;
    final devices = catalog.workNodes(widget.c.nodes, widget.c.workspaces);
    final project = widget.project;
    // Chat projects keep their own flow, in the Chats workspace's mode.
    final chats = widget.c.workspaces
        .where((w) => catalog.topChats(w) && w['hostId'] == node)
        .firstOrNull;
    final projectMode = chats == null ? null : catalog.byId('${chats['mode']}');
    // Work workspaces: the node's accepted, non-assistant modes. Empty with an
    // older gateway, where a path alone creates a directory workspace.
    final modes = project
        ? const <ModeInfo>[]
        : catalog.creatable(devices.where((n) => n['id'] == node).firstOrNull);
    final mode =
        modes.where((m) => m.id == modeId).firstOrNull ?? modes.firstOrNull;
    final needsPath = !project && (mode == null || mode.sharedDirectory);
    return WebDialog(
      title: project ? 'New project' : 'Add workspace',
      eyebrow: project ? 'Chats' : 'On a device',
      busy: busy,
      actions: [
        WebButton(
          'Cancel',
          onPressed: busy ? null : () => Navigator.pop(context),
        ),
        WebButton(
          busy
              ? (project ? 'Creating…' : 'Adding…')
              : project
              ? 'Create project'
              : 'Add workspace',
          primary: true,
          onPressed:
              busy ||
                  name.text.trim().isEmpty ||
                  node.isEmpty ||
                  (!project &&
                      ((needsPath && path.text.trim().isEmpty) ||
                          !devices.any((n) => n['id'] == node)))
              ? null
              : () async {
                  setState(() {
                    busy = true;
                    error = null;
                  });
                  try {
                    final Json kind = project
                        ? projectMode != null && projectMode.projects
                              ? {'mode': projectMode.id}
                              : {'kind': 'chat'}
                        : {
                            'mode': ?mode?.id,
                            if (needsPath) 'path': path.text.trim(),
                          };
                    final w = await widget.c.createWorkspace({
                      'nodeId': node,
                      'displayName': name.text.trim(),
                      ...kind,
                    });
                    if (context.mounted) Navigator.pop(context, '${w['id']}');
                  } catch (e) {
                    if (mounted) {
                      setState(() {
                        error = LiveController.describe(e);
                        busy = false;
                      });
                    }
                  }
                },
        ),
      ],
      children: [
        if (!project) ...[
          Text(
            'Device',
            style: webText(context, size: 13, weight: FontWeight.w500),
          ),
          DropdownButton<String>(
            isExpanded: true,
            value: devices.any((n) => n['id'] == node) ? node : null,
            items: [
              for (final n in devices)
                DropdownMenuItem(
                  value: '${n['id']}',
                  child: Text('${n['id']}'),
                ),
            ],
            onChanged: busy
                ? null
                : (value) => setState(() {
                    node = value!;
                    modeId = null;
                  }),
          ),
          // One option needs no choice: the picker appears only for several.
          if (modes.length > 1) ...[
            const SizedBox(height: 12),
            Text(
              'Mode',
              style: webText(context, size: 13, weight: FontWeight.w500),
            ),
            DropdownButton<String>(
              key: const ValueKey('workspace-mode'),
              isExpanded: true,
              value: mode?.id,
              items: [
                for (final m in modes)
                  DropdownMenuItem(
                    value: m.id,
                    child: Text(
                      m.description.isEmpty
                          ? m.label
                          : '${m.label} · ${m.description}',
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
              ],
              onChanged: busy
                  ? null
                  : (value) => setState(() => modeId = value),
            ),
          ],
        ],
        formField(
          context,
          project ? 'Project name' : 'Workspace name',
          name,
          hint: project ? 'Trip to Japan' : 'My project',
          enabled: !busy,
          onChanged: (_) => setState(() {}),
        ),
        if (needsPath)
          formField(
            context,
            'Existing directory on that device',
            path,
            hint: '~/projects/my-project',
            enabled: !busy,
            onChanged: (_) => setState(() {}),
          ),
        const SizedBox(height: 12),
        Text(
          project
              ? 'A project groups related chats. The assistant keeps its files for you; no folder to pick.'
              : needsPath
              ? "Choose an existing folder inside that device’s home directory. No files or folders will be created."
              : 'Each ${mode!.noun} gets its own folder on that device; no folder to pick.',
        ),
        if (!project && devices.isEmpty)
          const WebNotice(
            'No device can host workspaces: the chat node holds chats and projects only.',
            error: true,
          ),
        if (error != null) WebNotice(error!, error: true),
      ],
    );
  }
}

class _NewSession extends StatefulWidget {
  const _NewSession(this.c);
  final LiveController c;
  @override
  State<_NewSession> createState() => _NewSessionState();
}

class _NewSessionState extends State<_NewSession> {
  bool _open(Json w) =>
      w['deleting'] != true &&
      !isReadOnly(w) &&
      workspaceOnline(w, widget.c.nodes);
  late String? id = widget.c.workspaces.where(_open).firstOrNull?['id'];
  bool busy = false;
  String? error;
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.c,
    builder: (context, _) {
      final workspaces = widget.c.workspaces;
      final selected = workspaces.where((w) => w['id'] == id).firstOrNull;
      final selectedDeleting = selected?['deleting'] == true;
      final available = workspaces.where(_open);
      final deletionNeedsAttention =
          selectedDeleting ||
          (available.isEmpty && workspaces.any((w) => w['deleting'] == true));
      String workspaceLabel(Json workspace) {
        final suffix = workspace['deleting'] == true
            ? ' · deleting'
            : isReadOnly(workspace)
            ? ' · unavailable'
            : workspaceOnline(workspace, widget.c.nodes)
            ? ''
            : ' · offline';
        return '${workspace['displayName']}$suffix';
      }

      return WebDialog(
        title: 'Create a session',
        eyebrow: 'New work',
        busy: busy,
        actions: [
          WebButton(
            'Cancel',
            onPressed: busy ? null : () => Navigator.pop(context),
          ),
          WebButton(
            busy ? 'Creating…' : 'Create session',
            primary: true,
            onPressed:
                busy || selected == null || selectedDeleting || !_open(selected)
                ? null
                : () async {
                    setState(() {
                      busy = true;
                      error = null;
                    });
                    try {
                      await widget.c.create(id!);
                      if (context.mounted) Navigator.pop(context);
                    } catch (e) {
                      if (mounted) {
                        setState(() {
                          error = LiveController.describe(e);
                          busy = false;
                        });
                      }
                    }
                  },
          ),
        ],
        children: [
          Text(
            'Workspace',
            style: webText(context, size: 13, weight: FontWeight.w500),
          ),
          DropdownButton<String>(
            isExpanded: true,
            value: selected == null ? null : id,
            hint: Text(
              available.isEmpty
                  ? 'No workspace available'
                  : 'Choose a workspace',
            ),
            items: [
              for (final w in workspaces)
                DropdownMenuItem(
                  value: '${w['id']}',
                  enabled: _open(w),
                  child: Text(
                    workspaceLabel(w),
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
            ],
            onChanged: busy || available.isEmpty
                ? null
                : (value) => setState(() => id = value),
          ),
          if (deletionNeedsAttention)
            const WebNotice(workspaceDeletionNotice, error: true),
          const Text(
            'The session is named from your first message and stays active on the host when this browser disconnects.',
          ),
          if (error != null) WebNotice(error!, error: true),
        ],
      );
    },
  );
}
