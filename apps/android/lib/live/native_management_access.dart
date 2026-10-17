import 'dart:async';

import 'package:flutter/material.dart';

import 'assistant_settings.dart';
import 'common.dart';
import 'gateway.dart';
import 'web_controls.dart';

/// Browser approval for a short lived native management grant.
///
/// The native bridge owns the verifier and grant secret. Dart only sees the
/// sanitized request state and asks the bridge to open its current browser URL.
class NativeManagementAccess extends StatefulWidget {
  const NativeManagementAccess({
    super.key,
    required this.controller,
    required this.capabilities,
    required this.onApproved,
    required this.onRevoked,
    this.clock = DateTime.now,
    this.initialStatus,
  });

  final LiveController controller;
  final List<String> capabilities;
  final Future<void> Function() onApproved;
  final Future<void> Function() onRevoked;
  final DateTime Function() clock;

  /// A status snapshot already read by the owning settings page.
  ///
  /// Pages use this to discover a grant after a successful protected GET
  /// without issuing a duplicate native status call when the affordance mounts.
  final Json? initialStatus;

  @override
  State<NativeManagementAccess> createState() => _NativeManagementAccessState();
}

enum _AccessPhase { loading, idle, pending, active, limited, expired }

typedef _ManagementAccount = (LiveController, int, String?, String?, String?);

class _NativeManagementAccessState extends State<NativeManagementAccess> {
  late _ManagementAccount _account;
  _AccessPhase _phase = _AccessPhase.loading;
  Json _request = {};
  List<String> _activeCapabilities = [];
  DateTime? _expiresAt;
  String? _error;
  bool _starting = false,
      _opening = false,
      _checking = false,
      _cancelling = false;
  Timer? _timer;
  int _ticks = 0;
  bool _expiryCheckAttempted = false;

  LiveController get _controller => widget.controller;

  _ManagementAccount _readAccount() => (
    _controller,
    _controller.accountRevision,
    _controller.origin,
    _controller.clientId,
    _controller.pairingStamp,
  );

  bool _isCurrent(_ManagementAccount account) =>
      mounted && account == _account && account == _readAccount();

  @override
  void initState() {
    super.initState();
    _account = _readAccount();
    _controller.addListener(_accountChanged);
    final status = widget.initialStatus;
    if (status == null) {
      unawaited(_loadStatus());
    } else {
      _applySnapshot(status, _account, notify: false);
    }
  }

  @override
  void didUpdateWidget(covariant NativeManagementAccess oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != _controller) {
      oldWidget.controller.removeListener(_accountChanged);
      _controller.addListener(_accountChanged);
      _resetForAccount(_readAccount());
      return;
    }
    if (widget.initialStatus != null &&
        oldWidget.initialStatus != widget.initialStatus) {
      _applySnapshot(widget.initialStatus!, _account, notify: false);
    }
    if (!_sameCapabilities(oldWidget.capabilities, widget.capabilities)) {
      _stopTimer();
      _account = _readAccount();
      _phase = _AccessPhase.loading;
      _request = {};
      _activeCapabilities = [];
      _expiresAt = null;
      _error = null;
      unawaited(_loadStatus());
    }
  }

  bool _sameCapabilities(List<String> a, List<String> b) =>
      a.length == b.length && a.every((capability) => b.contains(capability));

  void _accountChanged() {
    final next = _readAccount();
    if (next != _account) _resetForAccount(next);
  }

  void _resetForAccount(_ManagementAccount next) {
    _stopTimer();
    _account = next;
    if (!mounted) return;
    setState(() {
      _phase = _AccessPhase.loading;
      _request = {};
      _activeCapabilities = [];
      _expiresAt = null;
      _error = null;
      _starting = _opening = _checking = _cancelling = false;
    });
    // Do not query the new account from a widget that was opened for the old
    // account. Its owner will mount a fresh affordance if the new account gets
    // a protected-route response.
  }

  void _stopTimer() {
    _timer?.cancel();
    _timer = null;
    _ticks = 0;
  }

  DateTime? _expiry(Json data, {Json? request}) {
    final remaining = data['remainingMs'] ?? request?['remainingMs'];
    if (remaining is num) {
      return widget.clock().add(Duration(milliseconds: remaining.toInt()));
    }
    final value = data['expiresAt'] ?? request?['expiresAt'];
    final serverNow = data['serverNow'] ?? request?['serverNow'];
    if (value is num && serverNow is num) {
      return widget.clock().add(
        Duration(milliseconds: (value - serverNow).toInt()),
      );
    }
    if (value is num) return DateTime.fromMillisecondsSinceEpoch(value.toInt());
    return null;
  }

  List<String> _capabilities(dynamic value) => value is List
      ? value.whereType<String>().where((item) => item.isNotEmpty).toList()
      : [];

  Json _requestView(dynamic value) {
    final source = obj(value);
    const visibleFields = {
      'id',
      'status',
      'expiresAt',
      'serverNow',
      'remainingMs',
      'deviceName',
      'capabilities',
    };
    return {
      for (final entry in source.entries)
        if (visibleFields.contains(entry.key)) entry.key: entry.value,
    };
  }

  Future<void> _loadStatus() async {
    final account = _account;
    try {
      final result = obj(await _controller.gateway.call('managementStatus'));
      if (!_isCurrent(account)) return;
      _applySnapshot(result, account);
    } catch (_) {
      if (!_isCurrent(account)) return;
      setState(() {
        _phase = _AccessPhase.idle;
        _error = 'Unable to check management access. Try again.';
      });
    }
  }

  void _applySnapshot(
    Json result,
    _ManagementAccount account, {
    bool notify = true,
  }) {
    if (!_isCurrent(account)) return;
    final wasActive =
        _phase == _AccessPhase.active || _phase == _AccessPhase.limited;
    final wasSatisfied = _phase == _AccessPhase.active;
    final request = _requestView(result['request'] ?? result['latestRequest']);
    final grant = obj(result['grant'] ?? result['access']);
    final capabilities = _capabilities(
      result['capabilities'] ??
          grant['capabilities'] ??
          request['capabilities'],
    );
    final active = result['active'] == true || grant['active'] == true;

    if (active) {
      final expiry = _expiry(result, request: grant.isNotEmpty ? grant : null);
      final satisfiesScope = widget.capabilities.every(
        (capability) => capabilities.contains(capability),
      );
      final alreadyExpired = expiry != null && !expiry.isAfter(widget.clock());
      setState(() {
        _phase = alreadyExpired
            ? _AccessPhase.expired
            : satisfiesScope
            ? _AccessPhase.active
            : _AccessPhase.limited;
        _request = request;
        _activeCapabilities = capabilities;
        _expiresAt = expiry;
        _error = null;
      });
      if (alreadyExpired) {
        _stopTimer();
        if (notify && wasActive) unawaited(_notifyRevoked());
      } else {
        _startTimer();
        if (notify && satisfiesScope && !wasSatisfied) {
          unawaited(_notifyApproved());
        } else if (notify && !satisfiesScope && wasSatisfied) {
          unawaited(_notifyRevoked());
        }
      }
      return;
    }

    final status = '${request['status'] ?? ''}'.toLowerCase();
    final requestExpiry = _expiry(request, request: request);
    final pending = status == 'pending' || status == 'approved';
    final expired =
        (pending &&
            requestExpiry != null &&
            !requestExpiry.isAfter(widget.clock())) ||
        const {
          'expired',
          'denied',
          'rejected',
          'revoked',
          'cancelled',
          'canceled',
        }.contains(status) ||
        (wasActive && !pending);
    final priorCapabilities = _activeCapabilities;
    setState(() {
      _phase = pending && !expired
          ? _AccessPhase.pending
          : expired
          ? _AccessPhase.expired
          : _AccessPhase.idle;
      _request = request;
      _activeCapabilities = pending ? priorCapabilities : [];
      _expiresAt = pending ? requestExpiry : null;
      _error = null;
    });
    if (_phase == _AccessPhase.pending) {
      _startTimer();
    } else {
      _stopTimer();
    }
    if (notify && wasActive && (expired || !pending)) {
      unawaited(_notifyRevoked());
    }
  }

  Future<void> _begin() async {
    if (_starting || _cancelling || _controller.pairingStamp != _account.$5) {
      return;
    }
    final account = _account;
    final previousPhase = _phase;
    setState(() {
      _starting = true;
      _error = null;
    });
    try {
      final result = obj(
        await _controller.gateway.call('managementBegin', {
          'capabilities': List<String>.of(widget.capabilities),
        }),
      );
      if (!_isCurrent(account)) return;
      final request = _requestView(result['request'] ?? result);
      _applySnapshot({'active': false, 'request': request}, account);
      await _openBrowser(account);
    } catch (_) {
      if (_isCurrent(account)) {
        setState(() {
          _phase = previousPhase;
          _error = 'Unable to request browser approval. Try again.';
        });
      }
    } finally {
      if (_isCurrent(account)) setState(() => _starting = false);
    }
  }

  Future<void> _openBrowser([_ManagementAccount? expected]) async {
    final account = expected ?? _account;
    if (_opening || !_isCurrent(account)) return;
    setState(() {
      _opening = true;
      _error = null;
    });
    try {
      // Native opens its stored verification URL. Never send a URL or verifier
      // back through Dart arguments.
      await _controller.gateway.call('managementOpen');
      if (!_isCurrent(account)) return;
    } catch (_) {
      if (_isCurrent(account)) {
        setState(() => _error = 'Unable to open your browser. Try again.');
      }
    } finally {
      if (_isCurrent(account)) setState(() => _opening = false);
    }
  }

  Future<void> _check() async {
    if (_checking || _cancelling || _controller.pairingStamp != _account.$5) {
      return;
    }
    final account = _account;
    setState(() {
      _checking = true;
      _error = null;
    });
    try {
      final result = obj(await _controller.gateway.call('managementCheck'));
      if (!_isCurrent(account)) return;
      _applySnapshot(result, account);
    } catch (_) {
      if (_isCurrent(account)) {
        setState(() => _error = 'Unable to check approval status. Try again.');
      }
    } finally {
      if (_isCurrent(account)) setState(() => _checking = false);
    }
  }

  Future<void> _cancel() async {
    if (_cancelling || _starting || _controller.pairingStamp != _account.$5) {
      return;
    }
    final account = _account;
    final wasActive =
        _phase == _AccessPhase.active || _phase == _AccessPhase.limited;
    setState(() {
      _cancelling = true;
      _error = null;
    });
    try {
      await _controller.gateway.call('managementCancel');
      if (!_isCurrent(account)) return;
      _setInactive();
      if (wasActive) await _notifyRevoked();
    } catch (_) {
      if (!_isCurrent(account)) return;
      // Native clears its local grant before attempting remote revocation. Read
      // that local state so the UI reflects the cleared grant even offline.
      try {
        final result = obj(await _controller.gateway.call('managementStatus'));
        if (!_isCurrent(account)) return;
        if (wasActive) setState(() => _phase = _AccessPhase.idle);
        _applySnapshot(result, account);
      } catch (_) {
        if (!_isCurrent(account)) return;
        _setInactive();
      }
      if (_isCurrent(account)) {
        setState(
          () => _error =
              'Access was cleared here, but the gateway could not confirm revocation.',
        );
      }
      if (wasActive &&
          _phase != _AccessPhase.active &&
          _phase != _AccessPhase.limited) {
        await _notifyRevoked();
      }
    } finally {
      if (_isCurrent(account)) setState(() => _cancelling = false);
    }
  }

  void _setInactive() {
    _stopTimer();
    setState(() {
      _phase = _AccessPhase.idle;
      _request = {};
      _activeCapabilities = [];
      _expiresAt = null;
      _error = null;
    });
  }

  Future<void> _notifyApproved() async {
    try {
      await widget.onApproved();
    } catch (_) {
      // The owning settings view reports its own protected-route errors.
    }
  }

  Future<void> _notifyRevoked() async {
    try {
      await widget.onRevoked();
    } catch (_) {
      // The owning settings view reports its own protected-route errors.
    }
  }

  void _startTimer() {
    _timer?.cancel();
    _ticks = 0;
    _expiryCheckAttempted = false;
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      final account = _account;
      if (!_isCurrent(account)) {
        _stopTimer();
        return;
      }
      if (_phase != _AccessPhase.pending &&
          _phase != _AccessPhase.active &&
          _phase != _AccessPhase.limited) {
        _stopTimer();
        return;
      }
      _ticks++;
      if (mounted) setState(() {});
      if (_expiresAt != null && !_expiresAt!.isAfter(widget.clock())) {
        if (!_checking && !_expiryCheckAttempted) {
          _expiryCheckAttempted = true;
          unawaited(_check());
        }
        return;
      }
      final interval = _phase == _AccessPhase.pending ? 2 : 5;
      if (_ticks % interval == 0 && !_checking) unawaited(_check());
    });
  }

  String _capabilityLabel(List<String> capabilities) {
    final labels = <String>[
      if (capabilities.contains('providers')) 'model backends',
      if (capabilities.contains('devices')) 'paired devices',
    ];
    return labels.isEmpty ? 'management settings' : labels.join(' and ');
  }

  String _scopeBadgeLabel(List<String> capabilities) {
    final labels = <String>[
      if (capabilities.contains('providers')) 'Model backends',
      if (capabilities.contains('devices')) 'Paired devices',
    ];
    return labels.isEmpty ? 'Management settings' : labels.join(' · ');
  }

  String _remainingLabel() {
    final expiry = _expiresAt;
    if (expiry == null) return '';
    final seconds = expiry
        .difference(widget.clock())
        .inSeconds
        .clamp(0, 999999);
    final minutes = seconds ~/ 60;
    final remainder = (seconds % 60).toString().padLeft(2, '0');
    return '$minutes:$remainder';
  }

  Widget _badge(String label) {
    final colors = palette(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
      decoration: BoxDecoration(
        color: colors['surface.subtle'],
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: colors['web.line']),
      ),
      child: Text(
        label,
        style: webText(context, size: 12, weight: FontWeight.w600),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final requestDevice = _request['deviceName'];
    final remaining = _remainingLabel();
    return AssistantSection(
      title: 'Browser management access',
      divider: true,
      children: [
        WebNotice(
          'Approve this app in your browser to manage ${_capabilityLabel(widget.capabilities)}. Access lasts 15 minutes.',
        ),
        if (_phase == _AccessPhase.loading)
          const AssistantParagraph('Checking management access…', live: true)
        else if (_phase == _AccessPhase.pending) ...[
          AssistantParagraph(
            requestDevice is String && requestDevice.isNotEmpty
                ? 'Waiting for approval for $requestDevice.'
                : 'Waiting for approval in your browser.',
            live: true,
          ),
          if (remaining.isNotEmpty)
            AssistantParagraph('Request expires in $remaining.', live: true),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              AssistantButton(
                _opening ? 'Opening browser…' : 'Open browser',
                key: const ValueKey('native-management-open'),
                onPressed: _opening || _cancelling ? null : _openBrowser,
              ),
              AssistantButton(
                _checking ? 'Checking…' : 'Check status',
                key: const ValueKey('native-management-check'),
                onPressed: _checking || _cancelling ? null : _check,
              ),
              AssistantButton(
                'Cancel request',
                key: const ValueKey('native-management-cancel'),
                onPressed: _cancelling || _starting ? null : _cancel,
              ),
            ],
          ),
        ] else if (_phase == _AccessPhase.active ||
            _phase == _AccessPhase.limited) ...[
          AssistantParagraph(
            _phase == _AccessPhase.limited
                ? 'Current access covers ${_capabilityLabel(_activeCapabilities)}. This page requires ${_capabilityLabel(widget.capabilities)}.'
                : remaining.isEmpty
                ? 'Management access is active.'
                : 'Management access expires in $remaining.',
            live: true,
          ),
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Wrap(
              spacing: 8,
              runSpacing: 8,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                _badge(_scopeBadgeLabel(_activeCapabilities)),
                AssistantButton(
                  _checking ? 'Checking…' : 'Check status',
                  key: const ValueKey('native-management-check'),
                  onPressed: _checking || _cancelling ? null : _check,
                ),
                AssistantButton(
                  _cancelling ? 'Revoking…' : 'Revoke access',
                  key: const ValueKey('native-management-revoke'),
                  onPressed: _cancelling ? null : _cancel,
                ),
                if (_phase == _AccessPhase.limited)
                  AssistantButton(
                    _starting ? 'Requesting…' : 'Request additional access',
                    key: const ValueKey('native-management-begin'),
                    onPressed: _starting || _cancelling ? null : _begin,
                  ),
              ],
            ),
          ),
        ] else if (_phase == _AccessPhase.expired) ...[
          const AssistantParagraph(
            'The approval request expired or management access ended.',
            live: true,
          ),
          Align(
            alignment: Alignment.centerLeft,
            child: AssistantButton(
              _starting ? 'Requesting…' : 'Request again',
              key: const ValueKey('native-management-retry'),
              onPressed: _starting || _cancelling ? null : _begin,
            ),
          ),
        ] else ...[
          Align(
            alignment: Alignment.centerLeft,
            child: AssistantButton(
              _starting
                  ? 'Requesting…'
                  : _error == null
                  ? 'Request browser approval'
                  : 'Retry',
              key: const ValueKey('native-management-begin'),
              onPressed: _starting || _cancelling ? null : _begin,
            ),
          ),
        ],
        if (_error != null) WebNotice(_error!, error: true),
      ],
    );
  }

  @override
  void dispose() {
    _stopTimer();
    _controller.removeListener(_accountChanged);
    super.dispose();
  }
}
