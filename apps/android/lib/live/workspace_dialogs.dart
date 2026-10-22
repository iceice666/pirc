import 'package:flutter/material.dart';
import 'gateway.dart';
import 'common.dart';
import 'web_controls.dart';

Future<String?> newWorkspaceDialog(
  BuildContext context,
  LiveController c,
  String nodeId,
) => showDialog<String>(
  context: context,
  useRootNavigator: false,
  barrierDismissible: false,
  builder: (_) => _WorkspaceDialog(c: c, nodeId: nodeId),
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
  const _WorkspaceDialog({required this.c, required this.nodeId});
  final LiveController c;
  final String nodeId;
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
    final devices = catalog.workNodes(widget.c.nodes);
    // The node's accepted modes. Empty with an older gateway, where a path
    // alone creates a directory workspace.
    final modes = catalog.creatable(
      devices.where((n) => n['id'] == node).firstOrNull,
    );
    final mode =
        modes.where((m) => m.id == modeId).firstOrNull ?? modes.firstOrNull;
    final needsPath = mode == null || mode.sharedDirectory;
    return WebDialog(
      title: 'Add workspace',
      eyebrow: 'On a device',
      busy: busy,
      actions: [
        WebButton(
          'Cancel',
          onPressed: busy ? null : () => Navigator.pop(context),
        ),
        WebButton(
          busy ? 'Adding…' : 'Add workspace',
          primary: true,
          onPressed:
              busy ||
                  name.text.trim().isEmpty ||
                  node.isEmpty ||
                  (needsPath && path.text.trim().isEmpty) ||
                  !devices.any((n) => n['id'] == node)
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
                      'mode': ?mode?.id,
                      if (needsPath) 'path': path.text.trim(),
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
        Text(
          'Device',
          style: webText(context, size: 13, weight: FontWeight.w500),
        ),
        DropdownButton<String>(
          isExpanded: true,
          value: devices.any((n) => n['id'] == node) ? node : null,
          items: [
            for (final n in devices)
              DropdownMenuItem(value: '${n['id']}', child: Text('${n['id']}')),
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
            onChanged: busy ? null : (value) => setState(() => modeId = value),
          ),
        ],
        formField(
          context,
          'Workspace name',
          name,
          hint: 'My project',
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
          needsPath
              ? "Choose an existing folder inside that device’s home directory. No files or folders will be created."
              : 'Each ${mode.noun} gets its own folder on that device; no folder to pick.',
        ),
        if (devices.isEmpty)
          const WebNotice('No device can host workspaces.', error: true),
        if (error != null) WebNotice(error!, error: true),
      ],
    );
  }
}
