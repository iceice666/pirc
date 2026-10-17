import 'package:flutter/material.dart';
import 'common.dart';
import 'composer_select.dart';
import 'gateway.dart';

const approvalModeLabels = {
  'read-only': 'Read-only',
  'auto': 'Auto',
  'full-access': 'Full access',
};
const _details = {
  'read-only': 'asks before any change',
  'auto': 'asks before risky commands',
  'full-access': 'never asks',
};

/// Reflects the mode the node reports, and confirms escalation for this session.
class ApprovalModeControl extends StatelessWidget {
  const ApprovalModeControl({super.key, required this.controller});
  final LiveController controller;

  Future<void> _select(BuildContext context, String mode) async {
    final c = controller;
    if (!c.canControl || mode == c.approvalMode) return;
    final session = c.sessionId, account = c.accountRevision;
    final navigation = c.sessionNavigationRevision;
    final origin = c.origin, pairing = c.pairingStamp;
    if (mode == 'full-access') {
      final allowed = await confirm(
        context,
        'Give this session full access?',
        "The agent will run every command, script and file change without asking you, including ones auto mode would stop as dangerous (deleting files, force-pushing, changing the system).\n\nYour deny-list still asks, writes still take the workspace's write lease, and the node's OS sandbox stays as it is. Teammates and subagents of this session follow it; delegated sessions do not.",
        action: 'Allow full access',
        cancelLabel: 'Cancel',
      );
      if (!allowed || !context.mounted) return;
    }
    if (!context.mounted ||
        c.sessionId != session ||
        c.accountRevision != account ||
        c.sessionNavigationRevision != navigation ||
        c.origin != origin ||
        c.pairingStamp != pairing ||
        !c.canControl) {
      return;
    }
    await c.changeApprovalMode(mode);
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (context, _) {
      final mode = controller.approvalMode;
      if (mode == null) return const SizedBox.shrink();
      return ComposerSelect(
        label: 'Approval mode',
        value: mode,
        disabled: !controller.canControl,
        foregroundColorKey: mode == 'full-access'
            ? 'status.danger'
            : 'text.secondary',
        options: [
          for (final entry in approvalModeLabels.entries)
            ComposerOption(
              entry.key,
              entry.value,
              '${_details[entry.key]}${entry.key == controller.state['defaultApprovalMode'] ? ' · default' : ''}',
            ),
        ],
        onSelect: (value) => _select(context, value),
      );
    },
  );
}
