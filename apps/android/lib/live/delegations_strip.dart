import '../l10n/app_i18n.dart';
import 'dart:ui' show SemanticsRole;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'common.dart';
import 'gateway.dart';
import 'web_controls.dart';

/// The web DelegationStrip: delegations the open chat started that still run
/// or wait for you, each with Open and Stop. Not a question: the chat keeps
/// going while they run.
class DelegationsStrip extends StatefulWidget {
  const DelegationsStrip({
    super.key,
    required this.delegations,
    required this.onOpen,
    required this.onStop,
  });
  final List<Json> delegations;
  final ValueChanged<String> onOpen;

  /// Stops one delegation; throws with the message to show.
  final Future<void> Function(String delegationId) onStop;

  /// The muted line under a delegation's title, or null.
  static String? detail(Json delegation) {
    final parts = [
      if (delegation['status'] == 'waiting_input') tr("Waiting for you"),
      if (delegation['dispatch'] == 'auto') tr("started automatically"),
    ];
    return parts.isEmpty ? null : parts.join(' · ');
  }

  /// The gateway's own 404/409 message (e.g. another device controls the
  /// delegated session, or nothing is running), else the generic one.
  static String stopError(Object e) =>
      e is PlatformException &&
          (e.code == 'HTTP_404' || e.code == 'HTTP_409') &&
          (e.message?.trim().isNotEmpty ?? false)
      ? e.message!
      : LiveController.describe(e);

  static String headline(Json delegation) => tr("Delegated to {0} — {1}", [
    delegation['workspace'] ?? '',
    delegation['title'] ?? '',
  ]);

  @override
  State<DelegationsStrip> createState() => _DelegationsStripState();
}

class _DelegationsStripState extends State<DelegationsStrip> {
  final stopping = <String>{};
  final errors = <String, String>{};

  Future<void> stop(String id) async {
    if (stopping.contains(id)) return;
    setState(() {
      stopping.add(id);
      errors.remove(id);
    });
    try {
      await widget.onStop(id);
    } catch (e) {
      if (mounted) setState(() => errors[id] = DelegationsStrip.stopError(e));
    } finally {
      if (mounted) setState(() => stopping.remove(id));
    }
  }

  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    if (widget.delegations.isEmpty) return const SizedBox.shrink();
    final p = palette(context);
    return Semantics(
      key: const ValueKey('delegations-strip'),
      container: true,
      label: tr("Active delegations"),
      child: Padding(
        padding: const EdgeInsets.only(top: 4, bottom: 24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (final (index, d) in widget.delegations.indexed) ...[
              if (index > 0) const SizedBox(height: 6),
              Container(
                key: ValueKey('delegation-${d['id']}'),
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 10,
                ),
                decoration: BoxDecoration(
                  color: p['surface.layer'],
                  borderRadius: BorderRadius.circular(16),
                  boxShadow: pircShadow(context, card: true),
                ),
                child: Wrap(
                  crossAxisAlignment: WrapCrossAlignment.center,
                  alignment: WrapAlignment.spaceBetween,
                  spacing: 10,
                  runSpacing: 6,
                  children: [
                    Row(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Padding(
                          padding: const EdgeInsets.only(top: 1),
                          child: Icon(
                            LucideIcons.forward,
                            size: 15,
                            color: p['accent.default'],
                          ),
                        ),
                        const SizedBox(width: 10),
                        Flexible(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Text(
                                DelegationsStrip.headline(d),
                                style: webText(
                                  context,
                                  size: 13,
                                  weight: FontWeight.w600,
                                ),
                              ),
                              if (DelegationsStrip.detail(d) case final line?)
                                Text(
                                  line,
                                  style: webText(
                                    context,
                                    size: 12,
                                    color: 'text.muted',
                                  ),
                                ),
                              if (errors['${d['id']}'] case final error?)
                                Semantics(
                                  role: SemanticsRole.alert,
                                  child: Text(
                                    error,
                                    style: webText(
                                      context,
                                      size: 12,
                                      color: 'status.danger',
                                    ),
                                  ),
                                ),
                            ],
                          ),
                        ),
                      ],
                    ),
                    Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        WebButton(
                          tr("Open"),
                          key: ValueKey('delegation-open-${d['id']}'),
                          height: 30,
                          fontSize: 13,
                          horizontalPadding: 12,
                          onPressed: () =>
                              widget.onOpen('${d['targetSessionId']}'),
                        ),
                        WebButton(
                          stopping.contains('${d['id']}')
                              ? tr("Stopping…")
                              : tr("Stop"),
                          key: ValueKey('delegation-stop-${d['id']}'),
                          height: 30,
                          fontSize: 13,
                          horizontalPadding: 12,
                          disabledOpacity: .5,
                          onPressed: stopping.contains('${d['id']}')
                              ? null
                              : () => stop('${d['id']}'),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
