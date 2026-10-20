import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'common.dart';
import 'gateway.dart';
import 'jobs_menu.dart';
import 'web_controls.dart';

/// App.svelte topbar. Safe-area padding is supplied by the containing shell.
class ConversationHeader extends StatelessWidget {
  const ConversationHeader({
    super.key,
    required this.controller,
    required this.sidebarCollapsed,
    required this.panelOpen,
    required this.onBack,
    required this.onExpand,
    required this.onPanel,
    required this.onWorkspace,
    required this.onOrigin,
    this.panelFocus,
  });
  final LiveController controller;
  final FocusNode? panelFocus;
  final bool sidebarCollapsed, panelOpen;
  final VoidCallback onBack, onExpand, onPanel, onWorkspace;
  final ValueChanged<Json> onOrigin;
  @override
  Widget build(BuildContext context) {
    final c = controller, colors = palette(context);
    final phone = MediaQuery.sizeOf(context).width <= 650;
    final workspace = c.workspaces
        .where((w) => w['id'] == obj(c.state['session'])['workspaceId'])
        .firstOrNull;
    final origin = obj(obj(c.state['session'])['origin']);
    final sandbox = obj(c.state['sandbox']);
    final live = c.connection == 'live';
    final offline = c.connection == 'offline' || c.connection == 'stopped';
    final status = live
        ? 'Live'
        : offline
        ? 'Offline'
        : 'Reconnecting';
    Widget chip(
      String label,
      IconData icon, {
      VoidCallback? action,
      bool warning = false,
      String? tooltip,
    }) => Tooltip(
      message: tooltip ?? label,
      child: InkWell(
        onTap: action,
        borderRadius: BorderRadius.circular(999),
        child: Container(
          constraints: const BoxConstraints(minHeight: 24),
          padding: EdgeInsets.symmetric(horizontal: phone ? 7 : 9),
          decoration: BoxDecoration(
            color: colors[warning ? 'status.warningSoft' : 'web.bg-subtle'],
            border: Border.all(
              color: colors[warning ? 'status.warning' : 'web.line'],
            ),
            borderRadius: BorderRadius.circular(999),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                icon,
                size: 13,
                color: colors[warning ? 'status.warning' : 'text.secondary'],
              ),
              const SizedBox(width: 5),
              Flexible(
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: webText(
                    context,
                    size: 12,
                    color: warning ? 'status.warning' : 'text.secondary',
                  ).copyWith(height: kTextHeightNone),
                ),
              ),
            ],
          ),
        ),
      ),
    );
    final held = c.control['held'] == true;
    return LayoutBuilder(
      builder: (context, bounds) {
        double labelWidth(
          String text, {
          double size = 12,
          FontWeight weight = FontWeight.w400,
        }) {
          final painter = TextPainter(
            text: TextSpan(
              text: text,
              style: webText(
                context,
                size: size,
                weight: weight,
              ).copyWith(height: kTextHeightNone),
            ),
            textDirection: TextDirection.ltr,
            textScaler: MediaQuery.textScalerOf(context),
          )..layout();
          final width = painter.width;
          painter.dispose();
          return width;
        }

        // CSS flex-shrink weights each title item by its intrinsic basis.
        // Equal Flutter flex factors truncate a long title even when the
        // title and short workspace breadcrumb both fit in the header.
        int titleFlex(
          String text, {
          double size = 12,
          double extra = 0,
          FontWeight weight = FontWeight.w400,
        }) => math.max(
          1,
          ((labelWidth(text, size: size, weight: weight) + extra) * 1000)
              .round(),
        );

        final room = math.max(
          80.0,
          bounds.maxWidth -
              32 -
              12 -
              32 -
              8 -
              70 -
              (sidebarCollapsed ? 46 : 0) -
              (phone ? 0 : labelWidth('99 running') + 42),
        );
        final controlNatural = !held
            ? labelWidth('Take control') + 45
            : labelWidth('In control') + 39;
        final liveNatural = labelWidth(status) + 38;
        final ratio = math.min(1.0, room / (controlNatural + liveNatural));
        final liveWidth = phone ? 28.0 : math.max(38.0, liveNatural * ratio);
        final controlWidth = math.max(46.0, controlNatural * ratio);
        return ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 56),
          child: Padding(
            padding: EdgeInsets.only(
              left: phone ? 6 : 20,
              right: phone ? 6 : 12,
            ),
            child: Row(
              children: [
                if (phone) ...[
                  WebIconButton(
                    LucideIcons.chevronLeft,
                    'Back to the list',
                    size: 40,
                    iconSize: 22,
                    onPressed: onBack,
                  ),
                  const SizedBox(width: 4),
                ] else if (sidebarCollapsed) ...[
                  WebIconButton(
                    LucideIcons.panelLeftOpen,
                    'Show sidebar',
                    size: 34,
                    iconSize: 19,
                    onPressed: onExpand,
                  ),
                  const SizedBox(width: 12),
                ],
                Expanded(
                  child: Row(
                    children: [
                      Flexible(
                        flex: titleFlex(
                          c.title,
                          size: 15,
                          weight: FontWeight.w600,
                        ),
                        child: Text(
                          c.title,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: webText(
                            context,
                            size: 15,
                            weight: FontWeight.w600,
                          ).copyWith(height: kTextHeightNone),
                        ),
                      ),
                      if (!phone) ...[
                        const SizedBox(width: 10),
                        Flexible(
                          flex: titleFlex(
                            '${workspace?['displayName'] ?? 'Workspace'}',
                          ),
                          child: InkWell(
                            onTap: onWorkspace,
                            child: Text(
                              '${workspace?['displayName'] ?? 'Workspace'}',
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
                      ],
                      if (origin['kind'] == 'delegation') ...[
                        const SizedBox(width: 10),
                        Flexible(
                          flex: titleFlex(
                            'Delegated · ${origin['title'] ?? ''}',
                            extra: 38,
                          ),
                          child: chip(
                            'Delegated · ${origin['title'] ?? ''}',
                            LucideIcons.forward,
                            action:
                                c.sessions.any(
                                  (s) => s['id'] == origin['fromSessionId'],
                                )
                                ? () => onOrigin(origin)
                                : null,
                          ),
                        ),
                      ],
                      if (sandbox['active'] == false) ...[
                        const SizedBox(width: 10),
                        Flexible(
                          flex: titleFlex('Not sandboxed', extra: 38),
                          child: chip(
                            'Not sandboxed',
                            LucideIcons.shieldOff,
                            warning: true,
                            tooltip:
                                'Not sandboxed${sandbox['reason'] == null ? '' : ': ${sandbox['reason']}'}',
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
                SizedBox(width: phone ? 4 : 12),
                JobsMenu(controller: c),
                SizedBox(width: phone ? 2 : 4),
                Tooltip(
                  message: status,
                  child: Semantics(
                    label: status,
                    child: Container(
                      width: liveWidth,
                      constraints: BoxConstraints(minHeight: phone ? 28 : 26),
                      padding: EdgeInsets.symmetric(
                        horizontal: phone ? 7.5 : 10,
                      ),
                      decoration: BoxDecoration(
                        color: phone
                            ? Colors.transparent
                            : colors['web.bg-hover'],
                        borderRadius: BorderRadius.circular(999),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(
                            live
                                ? LucideIcons.radio
                                : offline
                                ? LucideIcons.cloudOff
                                : LucideIcons.refreshCw,
                            size: 13,
                            color:
                                colors[live
                                    ? 'status.success'
                                    : offline
                                    ? 'status.danger'
                                    : 'status.warning'],
                          ),
                          if (!phone) ...[
                            const SizedBox(width: 5),
                            Flexible(
                              child: Text(
                                status,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: webText(
                                  context,
                                  size: 12,
                                  color: 'text.secondary',
                                ).copyWith(height: kTextHeightNone),
                              ),
                            ),
                          ],
                        ],
                      ),
                    ),
                  ),
                ),
                SizedBox(width: phone ? 2 : 4),
                if (!held) ...[
                  Tooltip(
                    message: 'Take control',
                    child: SizedBox(
                      width: phone ? 36 : controlWidth,
                      child: TextButton(
                        onPressed: () =>
                            guarded(context, () => c.takeControl(force: true)),
                        style: TextButton.styleFrom(
                          minimumSize: Size(phone ? 36 : 0, phone ? 36 : 28),
                          padding: EdgeInsets.symmetric(
                            horizontal: phone ? 0 : 12,
                          ),
                          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                          backgroundColor: colors['accent.default'],
                          foregroundColor: colors['accent.on'],
                          shape: const StadiumBorder(),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const Icon(LucideIcons.shieldCheck, size: 15),
                            if (!phone) ...[
                              const SizedBox(width: 6),
                              Flexible(
                                child: Text(
                                  'Take control',
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: webText(
                                    context,
                                    size: 12,
                                    color: 'accent.on',
                                  ).copyWith(height: kTextHeightNone),
                                ),
                              ),
                            ],
                          ],
                        ),
                      ),
                    ),
                  ),
                  SizedBox(width: phone ? 2 : 4),
                ] else if (!phone) ...[
                  Container(
                    width: controlWidth,
                    constraints: const BoxConstraints(minHeight: 26),
                    padding: const EdgeInsets.symmetric(horizontal: 10),
                    decoration: BoxDecoration(
                      color: colors['accent.soft'],
                      borderRadius: BorderRadius.circular(999),
                    ),
                    child: Row(
                      children: [
                        Icon(
                          LucideIcons.shieldCheck,
                          size: 14,
                          color: colors['accent.default'],
                        ),
                        const SizedBox(width: 5),
                        Flexible(
                          child: Text(
                            'In control',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: webText(
                              context,
                              size: 12,
                              color: 'accent.default',
                            ).copyWith(height: kTextHeightNone),
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 4),
                ],
                WebIconButton(
                  panelOpen
                      ? LucideIcons.panelRightClose
                      : LucideIcons.panelRightOpen,
                  panelOpen ? 'Hide side panel' : 'Show side panel',
                  size: phone ? 40 : 32,
                  iconSize: 19,
                  onPressed: onPanel,
                  focusNode: panelFocus,
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}

class ConversationViewerBanner extends StatelessWidget {
  const ConversationViewerBanner({super.key, required this.controller});
  final LiveController controller;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
    child: Align(
      alignment: Alignment.center,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 780),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          decoration: BoxDecoration(
            color: palette(context)['web.bg-subtle'],
            borderRadius: BorderRadius.circular(12),
          ),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  'You’re viewing this session. ${controller.control['holder'] ?? 'Another device'} currently has control.',
                  style: webText(
                    context,
                    size: 13,
                    color: 'text.secondary',
                  ).copyWith(height: kTextHeightNone),
                ),
              ),
              const SizedBox(width: 8),
              TextButton(
                style: TextButton.styleFrom(
                  minimumSize: Size.zero,
                  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 4,
                  ),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(6),
                  ),
                  foregroundColor: palette(context)['accent.default'],
                  textStyle: webText(
                    context,
                    size: 13,
                    weight: FontWeight.w500,
                  ).copyWith(height: kTextHeightNone),
                ),
                onPressed: () =>
                    guarded(context, () => controller.takeControl(force: true)),
                child: const Text('Take control'),
              ),
            ],
          ),
        ),
      ),
    ),
  );
}

/// The pinned App.svelte error-banner, positioned below the conversation header.
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
