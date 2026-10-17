import 'package:flutter/material.dart';
import 'gateway.dart';
import 'common.dart';
import 'work_index.dart';
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
    final chatNodes = widget.c.workspaces
        .where(isTopChats)
        .map((w) => w['hostId'])
        .toSet();
    final devices = widget.c.nodes
        .where((n) => !chatNodes.contains(n['id']))
        .toList();
    final project = widget.project;
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
                      (path.text.trim().isEmpty ||
                          !devices.any((n) => n['id'] == node)))
              ? null
              : () async {
                  setState(() {
                    busy = true;
                    error = null;
                  });
                  try {
                    final w = await widget.c.createWorkspace({
                      'nodeId': node,
                      'displayName': name.text.trim(),
                      if (project) 'kind': 'chat' else 'path': path.text.trim(),
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
            onChanged: busy ? null : (value) => setState(() => node = value!),
          ),
        ],
        formField(
          context,
          project ? 'Project name' : 'Workspace name',
          name,
          hint: project ? 'Trip to Japan' : 'My project',
          enabled: !busy,
          onChanged: (_) => setState(() {}),
        ),
        if (!project)
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
              : "Choose an existing folder inside that device’s home directory. No files or folders will be created.",
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
  late String? id = widget.c.workspaces
      .where((w) => w['deleting'] != true && workspaceOnline(w, widget.c.nodes))
      .firstOrNull?['id'];
  bool busy = false;
  String? error;
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.c,
    builder: (context, _) {
      final workspaces = widget.c.workspaces;
      final selected = workspaces.where((w) => w['id'] == id).firstOrNull;
      final selectedDeleting = selected?['deleting'] == true;
      final available = workspaces.where(
        (w) => w['deleting'] != true && workspaceOnline(w, widget.c.nodes),
      );
      final deletionNeedsAttention =
          selectedDeleting ||
          (available.isEmpty && workspaces.any((w) => w['deleting'] == true));
      String workspaceLabel(Json workspace) {
        final suffix = workspace['deleting'] == true
            ? ' · deleting'
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
                busy ||
                    selected == null ||
                    selectedDeleting ||
                    !workspaceOnline(selected, widget.c.nodes)
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
                  enabled:
                      w['deleting'] != true &&
                      workspaceOnline(w, widget.c.nodes),
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
