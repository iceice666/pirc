import 'dart:async';
import 'dart:math' as math;
import 'dart:ui' show SemanticsRole;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'assistant_settings.dart';
import 'common.dart';
import 'gateway.dart';
import 'native_management_access.dart';
import 'pairing_qr.dart';
import 'web_controls.dart';
import 'web_length_formatter.dart';

const deviceConnectionFailure = 'Unable to reach the gateway. Try again.';

String deviceRequestError(Object cause) =>
    cause is PlatformException &&
        RegExp(r'^HTTP_\d{3}$').hasMatch(cause.code) &&
        cause.message?.isNotEmpty == true
    ? cause.message!
    : deviceConnectionFailure;

String devicePairingUri(String origin, String token) => Uri(
  scheme: 'pirc',
  host: 'pair',
  queryParameters: {'url': origin, 'token': token},
).toString();

/// Same device-management UI/API as the pinned Web component. All requests
/// still use Gateway's existing credential: a device bearer remains denied.
class PairedDevices extends StatefulWidget {
  const PairedDevices({
    super.key,
    required this.controller,
    this.disabled = false,
    this.clock = DateTime.now,
  });
  final LiveController controller;
  final bool disabled;
  final DateTime Function() clock;

  @override
  State<PairedDevices> createState() => _PairedDevicesState();
}

class _PairedDevicesState extends State<PairedDevices> {
  final name = TextEditingController();
  final nameFocus = FocusNode();
  final link = TextEditingController();
  List<Json> devices = [];
  Json? paired;
  String? error;
  late (LiveController, int, String?, String?, String?) account;
  bool loading = true, busy = false, copied = false, managementRequired = false;
  bool managementStatusChecked = false;
  Json? managementStatusSnapshot;
  int generation = 0, listRevision = 0;
  LiveController get c => widget.controller;
  (LiveController, int, String?, String?, String?) get currentAccount =>
      (c, c.accountRevision, c.origin, c.clientId, c.pairingStamp);

  @override
  void initState() {
    super.initState();
    account = currentAccount;
    c.addListener(accountChanged);
    name.addListener(nameChanged);
    refresh();
  }

  void nameChanged() {
    if (mounted) setState(() {});
  }

  void accountChanged() {
    if (account != currentAccount) reset();
  }

  @override
  void didUpdateWidget(covariant PairedDevices oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != c) {
      oldWidget.controller.removeListener(accountChanged);
      c.addListener(accountChanged);
      reset();
    } else if (oldWidget.disabled != widget.disabled) {
      reset();
    }
  }

  void reset() {
    setState(() {
      generation++;
      listRevision++;
      account = currentAccount;
      devices = [];
      paired = null;
      link.clear();
      name.clear();
      error = null;
      managementRequired = false;
      managementStatusChecked = false;
      managementStatusSnapshot = null;
      busy = copied = false;
      loading = true;
    });
    refresh();
  }

  bool current(int token) => mounted && token == generation;

  @override
  void dispose() {
    generation++;
    listRevision++;
    c.removeListener(accountChanged);
    name.removeListener(nameChanged);
    name.dispose();
    nameFocus.dispose();
    link.dispose();
    super.dispose();
  }

  Future<void> refresh() async {
    final token = generation, revision = ++listRevision;
    final controller = c;
    if (widget.disabled) {
      setState(() => loading = false);
      return;
    }
    try {
      final result = await controller.gateway.request('/api/devices');
      if (!current(token) || revision != listRevision) return;
      if (result['devices'] is! List) {
        throw const FormatException('Invalid device list');
      }
      setState(() => devices = rows(result['devices']));
      _discoverManagementStatus(token, controller);
    } catch (cause) {
      if (current(token) && revision == listRevision) {
        setState(() {
          error = deviceRequestError(cause);
          if (_requiresManagement(cause)) managementRequired = true;
        });
      }
    } finally {
      if (current(token) && revision == listRevision) {
        setState(() => loading = false);
      }
    }
  }

  bool _requiresManagement(Object cause) =>
      cause is PlatformException && cause.code == 'HTTP_403';

  void _discoverManagementStatus(int token, LiveController controller) {
    if (managementStatusChecked) return;
    managementStatusChecked = true;
    unawaited(() async {
      try {
        final status = obj(await controller.gateway.call('managementStatus'));
        if (!current(token) || controller != c) return;
        final grant = obj(status['grant'] ?? status['access']);
        final active = status['active'] == true || grant['active'] == true;
        if (!active) return;
        final value = <String, dynamic>{
          'active': true,
          if (status['expiresAt'] != null) 'expiresAt': status['expiresAt'],
          if (status['remainingMs'] != null)
            'remainingMs': status['remainingMs'],
          if (status['serverNow'] != null) 'serverNow': status['serverNow'],
          'capabilities':
              status['capabilities'] ?? grant['capabilities'] ?? const [],
        };
        setState(() {
          managementRequired = true;
          managementStatusSnapshot = value;
        });
        if (_managementSnapshotExpired(value)) await managementRevoked();
      } catch (_) {
        // Status discovery is optional; route errors still provide access help.
      }
    }());
  }

  bool _managementSnapshotExpired(Json status) {
    final remaining = status['remainingMs'];
    if (remaining is num) return remaining <= 0;
    final expiresAt = status['expiresAt'];
    final serverNow = status['serverNow'];
    if (expiresAt is! num) return false;
    if (serverNow is num) return expiresAt <= serverNow;
    return expiresAt <= widget.clock().millisecondsSinceEpoch;
  }

  Future<void> managementRevoked() async {
    if (!mounted) return;
    setState(() {
      devices = [];
      managementStatusSnapshot = null;
      error = null;
    });
    await refresh();
  }

  Future<void> pair() async {
    final value = name.text.trim();
    if (widget.disabled || busy || value.isEmpty) return;
    final token = generation, controller = c, host = c.origin;
    setState(() {
      busy = true;
      error = null;
      copied = false;
    });
    try {
      final result = await controller.gateway.request(
        '/api/devices',
        method: 'POST',
        body: {'name': value},
      );
      if (!current(token)) return;
      final device = obj(result['device']), credential = result['token'];
      if (host == null ||
          device['id'] is! String ||
          credential is! String ||
          credential.isEmpty) {
        throw const FormatException('Invalid pairing response');
      }
      setState(() {
        paired = device;
        link.text = devicePairingUri(host, credential);
        name.clear();
      });
      await refresh();
    } catch (cause) {
      if (current(token)) {
        setState(() {
          error = deviceRequestError(cause);
          if (_requiresManagement(cause)) managementRequired = true;
        });
      }
    } finally {
      if (current(token)) setState(() => busy = false);
    }
  }

  Future<void> revoke(Json device) async {
    if (widget.disabled || busy) return;
    final token = generation, controller = c;
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await controller.gateway.request(
        '/api/devices/${enc('${device['id']}')}',
        method: 'DELETE',
      );
      if (!current(token)) return;
      if (paired?['id'] == device['id']) {
        setState(() {
          paired = null;
          link.clear();
        });
      }
      await refresh();
    } catch (cause) {
      if (current(token)) {
        setState(() {
          error = deviceRequestError(cause);
          if (_requiresManagement(cause)) managementRequired = true;
        });
      }
    } finally {
      if (current(token)) setState(() => busy = false);
    }
  }

  Future<void> copyLink() async {
    if (paired == null) return;
    final token = generation, value = link.text;
    try {
      await Clipboard.setData(ClipboardData(text: value));
      if (current(token) && link.text == value) setState(() => copied = true);
    } catch (_) {
      // The Web clipboard action does not replace the pairing card on failure.
    }
  }

  Future<void> openLink() async {
    if (paired == null) return;
    final token = generation, value = link.text;
    try {
      await c.gateway.call('openPairLink', {'url': value});
    } catch (_) {
      if (current(token)) {
        setState(() => error = 'Unable to open the pirc app. Try again.');
      }
    }
  }

  String used(dynamic value) {
    if (value is! num) return 'Invalid Date';
    final seconds = math.max(
      0,
      (widget.clock().millisecondsSinceEpoch - value) / 1000,
    );
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return '${seconds ~/ 60}m ago';
    if (seconds < 86400) return '${seconds ~/ 3600}h ago';
    if (seconds < 30 * 86400) return '${seconds ~/ 86400}d ago';
    return MaterialLocalizations.of(
      context,
    ).formatCompactDate(DateTime.fromMillisecondsSinceEpoch(value.toInt()));
  }

  String expires(dynamic value) {
    if (value is! num) return 'Invalid Date';
    final date = DateTime.fromMillisecondsSinceEpoch(value.toInt());
    const months = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    return '${months[date.month - 1]} ${date.day}';
  }

  Widget pairingCard() => Container(
    key: const ValueKey('device-pairing-card'),
    margin: const EdgeInsets.symmetric(vertical: 12),
    padding: const EdgeInsets.all(12),
    decoration: BoxDecoration(
      border: Border.all(color: palette(context)['web.line']),
      borderRadius: BorderRadius.circular(12),
    ),
    child: Semantics(
      container: true,
      label: 'Pair ${paired?['name']}',
      child: LayoutBuilder(
        builder: (context, constraints) {
          final textWidth = constraints.maxWidth >= 436
              ? constraints.maxWidth - 216
              : constraints.maxWidth;
          return Wrap(
            spacing: 16,
            runSpacing: 16,
            children: [
              PairingQr(data: link.text),
              SizedBox(
                width: textWidth,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text(
                      'Scan with the pirc app',
                      style: webText(
                        context,
                        size: 13,
                        weight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      'Shown only once. Anyone with this code can use your nodes until you revoke it.',
                      style: webText(context, size: 12, color: 'text.muted'),
                    ),
                    const SizedBox(height: 6),
                    TextField(
                      key: const ValueKey('device-pairing-link'),
                      controller: link,
                      readOnly: true,
                      showCursor: false,
                      maxLines: null,
                      onTap: () => link.selection = TextSelection(
                        baseOffset: 0,
                        extentOffset: link.text.length,
                      ),
                      style: webText(
                        context,
                        size: 11,
                        color: 'text.secondary',
                      ).copyWith(fontFamily: 'monospace'),
                      decoration: const InputDecoration(
                        isDense: true,
                        contentPadding: EdgeInsets.zero,
                        border: InputBorder.none,
                      ),
                    ),
                    const SizedBox(height: 10),
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: [
                        AssistantButton('Open in app', onPressed: openLink),
                        AssistantButton(
                          copied ? 'Copied' : 'Copy link',
                          onPressed: copyLink,
                        ),
                        AssistantButton(
                          'Done',
                          onPressed: () => setState(() {
                            paired = null;
                            link.clear();
                          }),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ],
          );
        },
      ),
    ),
  );

  Widget pairForm() => Padding(
    padding: const EdgeInsets.only(top: 12),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                'Device name',
                style: webText(
                  context,
                  size: 13,
                  weight: FontWeight.w500,
                  color: 'text.secondary',
                ).copyWith(height: kTextHeightNone),
              ),
              const SizedBox(height: 6),
              SizedBox(
                height: 40,
                child: Semantics(
                  label: 'Device name',
                  child: TextField(
                    key: const ValueKey('device-name'),
                    controller: name,
                    focusNode: nameFocus,
                    enabled: !busy,
                    inputFormatters: const [WebLengthFormatter(100)],
                    onSubmitted: (_) => pair(),
                    style: webText(
                      context,
                      size: 16,
                      weight: FontWeight.w500,
                      color: 'text.muted',
                    ).copyWith(height: kTextHeightNone),
                    decoration: InputDecoration(
                      hintText: 'Pixel 9',
                      hintStyle: webText(
                        context,
                        size: 16,
                        weight: FontWeight.w500,
                        color: 'text.muted',
                      ).copyWith(height: kTextHeightNone),
                      isDense: true,
                      filled: true,
                      fillColor: palette(context)['web.bg-subtle'],
                      contentPadding: const EdgeInsets.symmetric(
                        horizontal: 12,
                      ),
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(12),
                        borderSide: BorderSide.none,
                      ),
                      enabledBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(12),
                        borderSide: BorderSide.none,
                      ),
                      disabledBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(12),
                        borderSide: BorderSide.none,
                      ),
                      focusedBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(12),
                        borderSide: BorderSide(
                          color: palette(context)['accent.default'],
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(width: 8),
        AssistantButton(
          'Pair device',
          onPressed: busy || name.text.trim().isEmpty ? null : pair,
        ),
      ],
    ),
  );

  Widget deviceRow(Json device) => Container(
    key: ValueKey('paired-device-${device['id']}'),
    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
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
                '${device['name']}',
                style: webText(context, size: 13, weight: FontWeight.w700),
              ),
              Text(
                'Used ${used(device['lastUsedAt'])} · Expires ${expires(device['expiresAt'])}',
                style: webText(context, size: 12, color: 'text.muted'),
              ),
            ],
          ),
        ),
        const SizedBox(width: 12),
        Semantics(
          label: 'Revoke ${device['name']}',
          button: true,
          child: AssistantButton(
            'Revoke',
            onPressed: busy ? null : () => revoke(device),
          ),
        ),
      ],
    ),
  );

  @override
  Widget build(BuildContext context) => AssistantSection(
    title: 'Phones',
    divider: true,
    children: [
      const AssistantParagraph(
        'Pair the pirc Android app. A phone gets the same access as this browser, including files and shells on your nodes, but cannot manage devices or model backends. Its token stops working after a stretch without use, at a fixed age after pairing, or when revoked here.',
      ),
      if (widget.disabled)
        const AssistantParagraph(
          'Pairing is unavailable in demo mode.',
          live: true,
        )
      else ...[
        if (error != null)
          Semantics(
            role: SemanticsRole.alert,
            child: AssistantParagraph(error!, error: true),
          ),
        if (managementRequired)
          NativeManagementAccess(
            key: const ValueKey('native-management-access'),
            controller: c,
            capabilities: const ['devices'],
            onApproved: refresh,
            onRevoked: managementRevoked,
            clock: widget.clock,
            initialStatus: managementStatusSnapshot,
          ),
        if (paired != null) pairingCard(),
        pairForm(),
        if (loading)
          const AssistantParagraph('Loading devices…', live: true)
        else if (devices.isEmpty)
          const AssistantParagraph('No phones paired.')
        else
          Padding(
            padding: const EdgeInsets.only(top: 12),
            child: Column(
              children: [
                for (var index = 0; index < devices.length; index++) ...[
                  if (index > 0) const SizedBox(height: 6),
                  deviceRow(devices[index]),
                ],
              ],
            ),
          ),
      ],
    ],
  );
}
