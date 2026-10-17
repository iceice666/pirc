import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'gateway.dart';
import 'common.dart';
import 'assistant_settings.dart';
import 'web_controls.dart';

String _notificationError(Object error) =>
    error is PlatformException && error.message != null
    ? error.message!
    : LiveController.describe(error);

typedef _NotificationAccount = (LiveController, int, String?, String?, String?);

/// NotificationSettings.svelte, using Android permission/UnifiedPush transport.
class NativeNotificationSettings extends StatefulWidget {
  const NativeNotificationSettings({
    super.key,
    required this.controller,
    this.clock,
  });
  final LiveController controller;
  final DateTime Function()? clock;
  @override
  State<NativeNotificationSettings> createState() =>
      _NotificationSettingsState();
}

class _NotificationSettingsState extends State<NativeNotificationSettings>
    with WidgetsBindingObserver {
  LiveController get c => widget.controller;
  List<Json> places = [];
  String status = 'loading';
  String? error, note, hereId;
  bool busy = false, foreground = true, visible = true;
  int revision = 0;
  Timer? registration;
  late _NotificationAccount account;
  _NotificationAccount get currentAccount =>
      (c, c.accountRevision, c.origin, c.clientId, c.pairingStamp);
  @override
  void initState() {
    super.initState();
    account = currentAccount;
    foreground =
        WidgetsBinding.instance.lifecycleState == null ||
        WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed;
    c.addListener(accountChanged);
    WidgetsBinding.instance.addObserver(this);
    load();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final nextVisible = TickerMode.valuesOf(context).enabled;
    if (visible == nextVisible) return;
    visible = nextVisible;
    registration?.cancel();
    if (visible && foreground && !busy) load();
  }

  @override
  void didUpdateWidget(covariant NativeNotificationSettings oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != c) {
      oldWidget.controller.removeListener(accountChanged);
      c.addListener(accountChanged);
      accountChanged();
    }
  }

  void accountChanged() {
    if (account == currentAccount) return;
    account = currentAccount;
    registration?.cancel();
    setState(() {
      places = [];
      hereId = null;
      error = note = null;
      status = 'loading';
      busy = false;
    });
    load();
  }

  @override
  void dispose() {
    ++revision;
    registration?.cancel();
    c.removeListener(accountChanged);
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    foreground = state == AppLifecycleState.resumed;
    registration?.cancel();
    if (foreground && visible && !busy) load();
  }

  Future<void> load() async {
    final token = ++revision, scope = currentAccount;
    try {
      final result = await Future.wait([
        c.gateway.call('pushStatus'),
        c.gateway.call('permissions'),
        c.gateway.request('/api/push'),
      ]);
      if (!mounted || token != revision || scope != currentAccount) return;
      final push = obj(result[0]), permission = obj(result[1]);
      setState(() {
        places = rows(obj(result[2])['subscriptions']);
        hereId = push['code'] == 'on'
            ? push['subscriptionId'] as String?
            : null;
        final code = '${push['code'] ?? 'off'}';
        final distributors = push['distributors'];
        status = permission['notifications'] != true
            ? 'denied'
            : code == 'off' && distributors is List && distributors.isEmpty
            ? 'unsupported'
            : const ['on', 'off', 'connecting', 'failed'].contains(code)
            ? code
            : 'unsupported';
        if (status == 'failed') error = '${push['state']}';
      });
      registration?.cancel();
      if (status == 'connecting' && foreground && visible && !busy) {
        registration = Timer(const Duration(seconds: 2), load);
      }
    } catch (e) {
      if (!mounted || token != revision || scope != currentAccount) return;
      setState(() {
        error = _notificationError(e);
        if (status == 'loading') status = 'off';
      });
    }
  }

  Future<void> act(Future<void> Function() run) async {
    if (busy) return;
    final scope = currentAccount;
    ++revision;
    registration?.cancel();
    setState(() {
      busy = true;
      error = note = null;
    });
    try {
      await run();
    } catch (e) {
      if (mounted && scope == currentAccount) {
        setState(() => error = _notificationError(e));
      }
    } finally {
      if (mounted && scope == currentAccount) {
        setState(() => busy = false);
        await load();
      }
    }
  }

  String ago(dynamic value) {
    final time = value is num
        ? DateTime.fromMillisecondsSinceEpoch(value.toInt())
        : DateTime.tryParse('$value');
    if (time == null) return '';
    final seconds = (widget.clock?.call() ?? DateTime.now())
        .difference(time)
        .inSeconds;
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return '${seconds ~/ 60}m ago';
    if (seconds < 86400) return '${seconds ~/ 3600}h ago';
    if (seconds < 2592000) return '${seconds ~/ 86400}d ago';
    return MaterialLocalizations.of(context).formatCompactDate(time);
  }

  Widget row(
    String message,
    String label,
    VoidCallback run, {
    bool primary = false,
  }) => Padding(
    padding: const EdgeInsets.only(top: 8),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        Expanded(
          child: Text(
            message,
            style: webText(
              context,
              size: 13,
              color: 'text.muted',
            ).copyWith(height: 1.5),
          ),
        ),
        const SizedBox(width: 12),
        WebButton(
          label,
          height: 32,
          fontSize: 13,
          horizontalPadding: 12,
          primary: primary,
          onPressed: busy ? null : run,
        ),
      ],
    ),
  );
  @override
  Widget build(BuildContext context) => AssistantSection(
    title: 'Notifications',
    divider: true,
    children: [
      const AssistantParagraph(
        'Scheduled runs, sessions waiting for your answer, finished delegations and memory changes to approve. Each schedule chooses which of its runs notify.',
      ),
      if (status == 'loading')
        const AssistantParagraph('Checking notifications…', live: true)
      else ...[
        // The pinned Modal p rule overrides push-error's color in this dialog.
        if (error != null)
          AssistantParagraph(
            error!,
            error: true,
            live: true,
            color: 'text.muted',
          ),
        if (note != null) AssistantParagraph(note!, live: true),
        if (status == 'unsupported')
          const Padding(
            padding: EdgeInsets.only(top: 8),
            child: _NotificationMessage(
              'No UnifiedPush distributor is installed. Install one (ntfy, for example), then come back.',
            ),
          )
        else if (status == 'denied')
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const _NotificationMessage(
                  'Notifications are blocked for this app. Allow them in Android settings.',
                ),
                const SizedBox(height: 8),
                WebButton(
                  'Allow notifications',
                  height: 32,
                  fontSize: 13,
                  horizontalPadding: 12,
                  onPressed: busy
                      ? null
                      : () => act(() async {
                          await c.gateway.call('requestNotifications');
                        }),
                ),
              ],
            ),
          )
        else if (status == 'on' || status == 'connecting')
          row(
            status == 'on'
                ? 'This phone gets notifications.'
                : 'Registering this phone for notifications…',
            'Turn off',
            () => act(() async {
              await c.gateway.call('pushDisable');
            }),
          )
        else
          row(
            'This phone does not get notifications.',
            'Turn on',
            () => act(() async {
              await c.gateway.call('pushEnable');
            }),
            primary: true,
          ),
        if (places.isNotEmpty) ...[
          const SizedBox(height: 12),
          for (final place in places)
            Container(
              margin: const EdgeInsets.only(bottom: 4),
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              decoration: BoxDecoration(
                color: palette(context)['surface.subtle'],
                borderRadius: BorderRadius.circular(8),
              ),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          '${place['name']}${place['id'] == hereId ? ' (this phone)' : ''}',
                          style: webText(
                            context,
                            size: 13,
                            weight: FontWeight.w500,
                          ).copyWith(height: kTextHeightNone),
                        ),
                        Text(
                          '${place['kind'] == 'unifiedpush' ? 'Phone · UnifiedPush' : 'Browser'} · ${place['host']}${place['lastSuccessAt'] != null && place['lastSuccessAt'] != 0 ? ' · last delivered ${ago(place['lastSuccessAt'])}' : ''}${place['failing'] == true ? ' · failing' : ''}',
                          style: webText(
                            context,
                            size: 12,
                            color: 'text.muted',
                          ).copyWith(height: kTextHeightNone),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 12),
                  WebButton(
                    'Remove',
                    height: 32,
                    fontSize: 13,
                    horizontalPadding: 12,
                    onPressed: busy
                        ? null
                        : () => act(() async {
                            if (place['id'] == hereId) {
                              await c.gateway.call('pushDisable');
                            } else {
                              await c.gateway.request(
                                '/api/push/subscriptions',
                                method: 'DELETE',
                                body: {'id': place['id']},
                              );
                            }
                          }),
                  ),
                ],
              ),
            ),
          row(
            'Send a notification to every place above.',
            'Send a test',
            () => act(() async {
              final scope = currentAccount, count = places.length;
              final result = await c.gateway.request(
                '/api/push/test',
                method: 'POST',
                body: {},
              );
              if (mounted && scope == currentAccount) {
                note = 'Sent to ${result['delivered']} of $count.';
              }
            }),
          ),
        ],
      ],
    ],
  );
}

class _NotificationMessage extends StatelessWidget {
  const _NotificationMessage(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => Text(
    text,
    style: webText(
      context,
      size: 13,
      color: 'text.muted',
    ).copyWith(height: 1.5),
  );
}
