import 'dart:async';
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'common.dart';
import 'web_controls.dart';
import 'gateway.dart';

/// A session's run status in a few words.
String sessionStatusLabel(Object? status) => switch (status) {
  'queued' => 'Queued',
  'running' => 'Running',
  'stopping' => 'Stopping',
  'waiting_input' => 'Waiting',
  'succeeded' || 'completed' => 'Done',
  'failed' => 'Failed',
  'cancelled' || 'stopped' => 'Stopped',
  null => 'Idle',
  final other => '$other',
};

/// The top of a session in the engine (plans/rewrite/12-android.md,
/// decision 4): sessions are workers' machinery, not conversations, so the
/// engine shows their name, workspace and state, renames them, and gives the
/// rest of the page to their panes (files, git, terminals, browser, tasks).
class SessionHeader extends StatelessWidget {
  const SessionHeader({
    super.key,
    required this.controller,
    required this.sidebarCollapsed,
    required this.onBack,
    required this.onExpand,
    required this.onWorkspace,
  });
  final LiveController controller;
  final bool sidebarCollapsed;
  final VoidCallback onBack, onExpand, onWorkspace;

  Future<void> _rename(BuildContext context, String name) async {
    final field = TextEditingController(text: name);
    final next = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Rename'),
        content: TextField(
          controller: field,
          autofocus: true,
          maxLength: 120,
          onSubmitted: (value) => Navigator.pop(context, value),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, field.text),
            child: const Text('Save'),
          ),
        ],
      ),
    );
    field.dispose();
    if (next == null ||
        next.trim().isEmpty ||
        next.trim() == name ||
        !context.mounted) {
      return;
    }
    await guarded(
      context,
      () => controller.updateSession({'name': next.trim()}),
    );
  }

  @override
  Widget build(BuildContext context) {
    final c = controller, colors = palette(context);
    final phone = MediaQuery.sizeOf(context).width <= 650;
    final session = obj(c.state['session']);
    final name = '${session['name'] ?? 'Session'}';
    final workspace = c.workspaces
        .where((w) => w['id'] == session['workspaceId'])
        .firstOrNull;
    final status = sessionStatusLabel(
      obj(c.state['run'])['status'] ?? session['runStatus'],
    );
    return Container(
      height: 56,
      padding: const EdgeInsets.symmetric(horizontal: 4),
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: colors['web.line'])),
      ),
      child: Row(
        children: [
          if (phone)
            IconButton(
              tooltip: 'Back to the list',
              onPressed: onBack,
              icon: const Icon(LucideIcons.chevronLeft),
            )
          else if (sidebarCollapsed)
            IconButton(
              tooltip: 'Show sidebar',
              onPressed: onExpand,
              icon: const Icon(LucideIcons.panelLeftOpen, size: 18),
            )
          else
            const SizedBox(width: 12),
          Expanded(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                Text(
                  [
                    status,
                    if (workspace != null) '${workspace['displayName']}',
                  ].join(' · '),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 12, color: colors['text.muted']),
                ),
              ],
            ),
          ),
          if (workspace != null)
            IconButton(
              tooltip: 'Open the workspace',
              onPressed: onWorkspace,
              icon: const Icon(LucideIcons.folder, size: 18),
            ),
          IconButton(
            tooltip: 'Rename',
            onPressed: () => unawaited(_rename(context, name)),
            icon: const Icon(LucideIcons.pencil, size: 18),
          ),
        ],
      ),
    );
  }
}

/// A session's last failure, dismissable.
class ConversationErrorBanner extends StatelessWidget {
  const ConversationErrorBanner({super.key, required this.controller});
  final LiveController controller;

  @override
  Widget build(BuildContext context) {
    final colors = palette(context);
    return Semantics(
      liveRegion: true,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
        child: Align(
          alignment: Alignment.center,
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 780),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              decoration: BoxDecoration(
                color: colors['status.dangerSoft'],
                borderRadius: BorderRadius.circular(12),
              ),
              child: Row(
                children: [
                  Icon(
                    LucideIcons.circleAlert,
                    size: 16,
                    color: colors['status.danger'],
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      controller.error ?? '',
                      style: webText(
                        context,
                        size: 13,
                        color: 'status.danger',
                      ).copyWith(height: kTextHeightNone),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Tooltip(
                    message: 'Dismiss error',
                    child: TextButton(
                      style: ButtonStyle(
                        foregroundColor: WidgetStatePropertyAll(
                          colors['status.danger'],
                        ),
                        minimumSize: const WidgetStatePropertyAll(Size.zero),
                        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                        padding: const WidgetStatePropertyAll(
                          EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                        ),
                        shape: WidgetStatePropertyAll(
                          RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(6),
                          ),
                        ),
                        overlayColor: WidgetStateProperty.resolveWith(
                          (states) => states.contains(WidgetState.hovered)
                              ? colors['web.bg-hover']
                              : Colors.transparent,
                        ),
                      ),
                      onPressed: () {
                        controller.error = null;
                        controller.changed();
                      },
                      child: const Icon(LucideIcons.x, size: 15),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
