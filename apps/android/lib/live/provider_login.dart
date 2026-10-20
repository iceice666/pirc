import '../l10n/app_i18n.dart';
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'assistant_settings.dart';
import 'backend_api.dart';
import 'common.dart';
import 'gateway.dart';
import 'web_controls.dart';

class ProviderLogin extends StatefulWidget {
  const ProviderLogin({
    super.key,
    required this.controller,
    required this.providers,
    this.locked = false,
    required this.onActiveChanged,
    required this.onBusyChanged,
    required this.onLogout,
    required this.onSucceeded,
  });

  final LiveController controller;
  final List<Json> providers;
  final bool locked;
  final ValueChanged<bool> onActiveChanged;
  final ValueChanged<bool> onBusyChanged;
  final Future<void> Function(String providerId) onLogout;
  final Future<void> Function() onSucceeded;

  @override
  State<ProviderLogin> createState() => _ProviderLoginState();
}

class _ProviderLoginState extends State<ProviderLogin> {
  Json? _login;
  String? _consentingProvider;
  String? _errorProvider, _errorText, _copied;
  final _answers = <String, String>{};
  final _fields = <String, TextEditingController>{};
  Timer? _pollTimer, _expiryTimer, _dismissTimer, _copiedTimer;
  int _generation = 0;
  int? _busyGeneration;
  bool _busy = false;
  bool _reportedActive = false;
  String? _loginOrigin, _loginClientId;

  bool get _pending => _login?['status'] == 'pending';
  bool get _locked => widget.locked || _busy;
  String get _loginId => '${_login?['id'] ?? ''}';
  String get _loginProviderId => '${_login?['providerId'] ?? ''}';

  bool _sameAccount(LiveController controller) =>
      controller.origin == _loginOrigin &&
      controller.clientId == _loginClientId;

  @override
  void didUpdateWidget(ProviderLogin oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller == widget.controller) return;

    final wasBusy = _busy;
    final wasPending = _pending;
    final oldId = _loginId;
    final oldOrigin = _loginOrigin, oldClientId = _loginClientId;
    _generation++;
    _clearTimers();
    _dismissTimer?.cancel();
    _copiedTimer?.cancel();
    _clearAnswers();
    _login = null;
    _busy = false;
    _busyGeneration = null;
    _consentingProvider = null;
    _copied = null;
    if (wasPending && oldId.isNotEmpty) {
      unawaited(
        _deleteLogin(oldWidget.controller, oldId, oldOrigin, oldClientId),
      );
    }
    if (wasPending) {
      oldWidget.onActiveChanged(false);
      widget.onActiveChanged(false);
      _reportedActive = false;
    }
    if (wasBusy) {
      oldWidget.onBusyChanged(false);
      widget.onBusyChanged(false);
    }
    _errorProvider = _errorText = null;
    _loginOrigin = widget.controller.origin;
    _loginClientId = widget.controller.clientId;
  }

  @override
  void dispose() {
    final controller = widget.controller;
    final id = _loginId;
    final wasPending = _pending;
    final wasBusy = _busy;
    final origin = _loginOrigin, clientId = _loginClientId;
    _generation++;
    _clearTimers();
    _dismissTimer?.cancel();
    _copiedTimer?.cancel();
    _clearAnswers();
    if (wasPending) {
      _reportActive(false);
      if (id.isNotEmpty) {
        unawaited(_deleteLogin(controller, id, origin, clientId));
      }
    }
    if (wasBusy) {
      _busy = false;
      widget.onBusyChanged(false);
    }
    super.dispose();
  }

  void _clearTimers() {
    _pollTimer?.cancel();
    _expiryTimer?.cancel();
    _pollTimer = null;
    _expiryTimer = null;
  }

  void _clearAnswers() {
    for (final field in _fields.values) {
      field.dispose();
    }
    _fields.clear();
    _answers.clear();
  }

  bool _current(int version) =>
      mounted && version == _generation && _sameAccount(widget.controller);

  void _reportActive(bool value) {
    if (_reportedActive == value) return;
    _reportedActive = value;
    widget.onActiveChanged(value);
  }

  void _setLogin(Json? value) {
    if (!mounted) return;
    setState(() => _login = value);
    _reportActive(value?['status'] == 'pending');
  }

  void _setBusy(bool value) {
    if (!mounted || _busy == value) return;
    setState(() => _busy = value);
    widget.onBusyChanged(value);
  }

  void _beginBusy(int version) {
    if (!mounted) return;
    _busyGeneration = version;
    if (!_busy) setState(() => _busy = true);
    widget.onBusyChanged(true);
  }

  void _finishBusy(int version) {
    if (!mounted || _busyGeneration != version) return;
    _busyGeneration = null;
    _setBusy(false);
  }

  void _setError(String providerId, String text) {
    if (!mounted) return;
    setState(() {
      _errorProvider = providerId;
      _errorText = text;
    });
  }

  String _safeError(Object error, {String? submitted}) {
    final text = backendError(error);
    if (submitted != null && submitted.isNotEmpty && text.contains(submitted)) {
      return backendFailure;
    }
    return text;
  }

  Future<void> _deleteLogin(
    LiveController controller,
    String id,
    String? origin,
    String? clientId,
  ) async {
    // Never send an old session ID to a newly selected gateway account.
    if (controller.origin != origin || controller.clientId != clientId) return;
    try {
      await backendRequest(
        controller,
        '/api/provider-auth/sessions/${enc(id)}',
        method: 'DELETE',
      );
    } catch (_) {
      // Cancellation on close is best effort; the session has a gateway expiry.
    }
  }

  void _syncAnswers(Json snapshot) {
    final prompts = rows(snapshot['prompts']);
    final ids = prompts.map((p) => '${p['id'] ?? ''}').toSet();
    for (final entry in _fields.entries.toList()) {
      if (!ids.contains(entry.key)) {
        entry.value.dispose();
        _fields.remove(entry.key);
      }
    }
    _answers.removeWhere((id, _) => !ids.contains(id));
    for (final prompt in prompts) {
      final id = '${prompt['id'] ?? ''}';
      if (id.isEmpty) continue;
      _answers.putIfAbsent(id, () => '');
      if ('${prompt['kind']}' != 'select') {
        final field = _fields.putIfAbsent(
          id,
          () => TextEditingController(text: _answers[id]),
        );
        if (field.text != _answers[id]) field.text = _answers[id] ?? '';
      }
    }
  }

  Future<void> _accept(Json raw, int version) async {
    if (!_current(version)) return;
    _clearTimers();
    final status = '${raw['status'] ?? 'failed'}';
    final snapshot = <String, dynamic>{...raw, 'prompts': rows(raw['prompts'])};
    final providerId = '${snapshot['providerId'] ?? ''}';

    if (status == 'cancelled') {
      _clearAnswers();
      _setLogin(null);
      return;
    }

    if (status == 'pending') {
      _syncAnswers(snapshot);
      _setLogin(snapshot);
      final expiresAt = _asInt(snapshot['expiresAt']);
      final left = expiresAt - DateTime.now().millisecondsSinceEpoch;
      if (left <= 0) {
        await _cancelLogin(expired: true);
        return;
      }
      final id = '${snapshot['id'] ?? ''}';
      _expiryTimer = Timer(
        Duration(milliseconds: left),
        () => unawaited(_cancelLogin(expired: true)),
      );
      _pollTimer = Timer(
        Duration(milliseconds: left < 1000 ? left : 1000),
        () => unawaited(_poll(id, providerId, version)),
      );
      return;
    }

    _clearAnswers();
    _setLogin({
      ...snapshot,
      'prompts': const <Json>[],
      'auth': null,
      'progress': null,
    });
    if (status == 'succeeded') {
      final id = '${snapshot['id'] ?? ''}';
      _dismissTimer?.cancel();
      _dismissTimer = Timer(const Duration(seconds: 6), () {
        if (_current(version) && _loginId == id) _setLogin(null);
      });
      try {
        await widget.onSucceeded();
      } catch (_) {
        // The login succeeded even if refreshing the model list needs a retry.
      }
    }
  }

  int _asInt(dynamic value) =>
      value is num ? value.toInt() : int.tryParse('$value') ?? 0;

  Future<void> _poll(String id, String providerId, int version) async {
    if (!_current(version)) return;
    try {
      final snapshot = await backendRequest(
        widget.controller,
        '/api/provider-auth/sessions/${enc(id)}',
      );
      if (_current(version)) await _accept(snapshot, version);
    } catch (_) {
      if (!_current(version)) return;
      _setError(
        providerId,
        tr("Login status is unavailable. Start a new login to retry."),
      );
      await _cancelLogin();
    }
  }

  void _requestLogin(Json provider) {
    if (_locked || _pending) return;
    final id = '${provider['id'] ?? ''}';
    if (provider['requiresPolicyConsent'] == true) {
      setState(() => _consentingProvider = id);
    } else {
      unawaited(_startLogin(provider, false));
    }
  }

  Future<void> _startLogin(Json provider, bool policyConsent) async {
    if (_locked || _pending) return;
    final version = ++_generation;
    final controller = widget.controller;
    final origin = controller.origin, clientId = controller.clientId;
    final providerId = '${provider['id'] ?? ''}';
    _loginOrigin = origin;
    _loginClientId = clientId;
    _clearTimers();
    _dismissTimer?.cancel();
    _clearAnswers();
    setState(() {
      _errorProvider = null;
      _errorText = null;
      _consentingProvider = null;
      _login = null;
    });
    _reportActive(false);
    _beginBusy(version);

    try {
      final snapshot = await backendRequest(
        controller,
        '/api/provider-auth/sessions',
        method: 'POST',
        body: {'providerId': providerId, 'policyConsent': policyConsent},
      );
      if (!_current(version)) {
        final id = '${snapshot['id'] ?? ''}';
        if (id.isNotEmpty) {
          await _deleteLogin(controller, id, origin, clientId);
        }
        return;
      }
      await _accept(snapshot, version);
    } catch (cause) {
      if (_current(version)) {
        _setError(providerId, _safeError(cause));
      }
    } finally {
      _finishBusy(version);
    }
  }

  Future<void> _cancelLogin({bool expired = false}) async {
    final current = _login;
    if (current == null || current['status'] != 'pending') return;
    final id = '${current['id'] ?? ''}';
    final providerId = '${current['providerId'] ?? ''}';
    final canCancel = _sameAccount(widget.controller);
    final version = ++_generation;
    _clearTimers();
    _clearAnswers();
    _setLogin(
      expired
          ? {
              ...current,
              'status': 'expired',
              'prompts': const <Json>[],
              'auth': null,
              'progress': null,
            }
          : null,
    );
    if (!expired && mounted) _dismissTimer?.cancel();
    if (id.isEmpty || !canCancel) return;
    try {
      await backendRequest(
        widget.controller,
        '/api/provider-auth/sessions/${enc(id)}',
        method: 'DELETE',
      );
    } catch (_) {
      if (_current(version)) {
        _setError(
          providerId,
          tr(
            "Could not confirm cancellation. This login will expire on the gateway.",
          ),
        );
      }
    }
  }

  Future<void> _answer(Json prompt, {bool skip = false}) async {
    if (_locked || !_pending) return;
    if (!_sameAccount(widget.controller)) {
      await _cancelLogin();
      return;
    }
    final promptId = '${prompt['id'] ?? ''}';
    final value = _answers[promptId] ?? '';
    final allowEmpty = prompt['allowEmpty'] == true;
    if (!skip && !allowEmpty && value.isEmpty) return;

    final login = _login!;
    final id = '${login['id']}';
    final providerId = '${login['providerId'] ?? ''}';
    final version = ++_generation;
    final expiresAt = _asInt(login['expiresAt']);
    _clearTimers();
    _expiryTimer = Timer(
      Duration(
        milliseconds: (expiresAt - DateTime.now().millisecondsSinceEpoch).clamp(
          0,
          1 << 31,
        ),
      ),
      () => unawaited(_cancelLogin(expired: true)),
    );
    _beginBusy(version);
    _setError(providerId, '');
    if (mounted) {
      setState(() {
        _answers[promptId] = '';
        _fields[promptId]?.clear();
      });
    }

    try {
      final snapshot = await backendRequest(
        widget.controller,
        '/api/provider-auth/sessions/${enc(id)}/input',
        method: 'POST',
        body: {'promptId': promptId, if (!skip) 'value': value},
      );
      if (_current(version)) await _accept(snapshot, version);
    } catch (cause) {
      if (_current(version)) {
        _setError(providerId, _safeError(cause, submitted: value));
        try {
          final snapshot = await backendRequest(
            widget.controller,
            '/api/provider-auth/sessions/${enc(id)}',
          );
          if (_current(version)) await _accept(snapshot, version);
        } catch (_) {
          if (_current(version)) await _cancelLogin();
        }
      }
    } finally {
      _finishBusy(version);
    }
  }

  Future<void> _logout(Json provider) async {
    if (_locked || _pending) return;
    final providerId = '${provider['providerId'] ?? provider['id'] ?? ''}';
    final id = '${provider['id'] ?? providerId}';
    _setError(id, '');
    try {
      await widget.onLogout(providerId);
    } catch (cause) {
      _setError(id, _safeError(cause));
    }
  }

  Future<void> _copy(String value, String type) async {
    try {
      await Clipboard.setData(ClipboardData(text: value));
    } catch (_) {
      return;
    }
    if (!mounted) return;
    setState(() => _copied = type);
    _copiedTimer?.cancel();
    _copiedTimer = Timer(const Duration(seconds: 2), () {
      if (mounted) setState(() => _copied = null);
    });
  }

  Uri? _authorizationUri(dynamic value) {
    if (value is! String || value.isEmpty) return null;
    final uri = Uri.tryParse(value);
    if (uri == null ||
        !uri.hasScheme ||
        !uri.hasAuthority ||
        uri.scheme.toLowerCase() != 'https' ||
        uri.host.isEmpty ||
        uri.userInfo.isNotEmpty ||
        uri.port > 65535) {
      return null;
    }
    return uri;
  }

  Future<void> _openAuthorization(Uri uri, String providerId) async {
    try {
      await widget.controller.gateway.call('external', {'url': uri.toString()});
    } catch (_) {
      _setError(
        providerId,
        tr(
          "Could not open the authorization page. Copy the link and open it in a browser.",
        ),
      );
    }
  }

  int _remainingMinutes(dynamic value) {
    final left = _asInt(value) - DateTime.now().millisecondsSinceEpoch;
    final minutes = (left + 59999) ~/ 60000;
    return minutes < 1 ? 1 : minutes;
  }

  InputDecoration _fieldDecoration(String hint) => InputDecoration(
    hintText: hint.isEmpty ? null : hint,
    hintStyle: webText(context, size: 16, color: 'text.muted'),
    isDense: true,
    filled: true,
    fillColor: palette(context)['web.bg-subtle'],
    contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 0),
    constraints: const BoxConstraints(minHeight: 40),
    border: OutlineInputBorder(
      gapPadding: 0,
      borderRadius: BorderRadius.circular(12),
      borderSide: BorderSide.none,
    ),
    enabledBorder: OutlineInputBorder(
      gapPadding: 0,
      borderRadius: BorderRadius.circular(12),
      borderSide: BorderSide.none,
    ),
    focusedBorder: OutlineInputBorder(
      gapPadding: 0,
      borderRadius: BorderRadius.circular(12),
      borderSide: BorderSide(
        color: palette(context)['accent.default'],
        width: 1,
      ),
    ),
  );

  Widget _button(
    String label, {
    VoidCallback? onPressed,
    bool filled = false,
  }) => AssistantButton(label, onPressed: onPressed, filled: filled);

  Widget _panel(List<Widget> children) => Container(
    margin: const EdgeInsets.only(top: 12),
    padding: const EdgeInsets.only(top: 12),
    decoration: BoxDecoration(
      border: Border(top: BorderSide(color: palette(context)['web.line'])),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: children,
    ),
  );

  Widget _providerCard(Json provider) {
    final id = '${provider['id'] ?? ''}';
    final name = '${provider['name'] ?? id}';
    final connected = provider['connected'] == true;
    final count = _asInt(provider['modelCount']);
    final current = _loginProviderId == id ? _login : null;
    final consent = _consentingProvider == id;
    final colors = palette(context);

    return Container(
      key: ValueKey('provider-login-$id'),
      margin: const EdgeInsets.symmetric(vertical: 12),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        border: Border.all(color: colors['web.line']),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Wrap(
            alignment: WrapAlignment.spaceBetween,
            crossAxisAlignment: WrapCrossAlignment.center,
            runSpacing: 8,
            children: [
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    name,
                    style: webText(context, size: 13, weight: FontWeight.w700),
                  ),
                  Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: Text(
                      tr("{0} · {1} known models", [
                        connected ? 'Connected' : 'Not connected',
                        count,
                      ]),
                      style: webText(
                        context,
                        size: 12,
                        color: connected ? 'status.success' : 'text.muted',
                      ),
                    ),
                  ),
                ],
              ),
              Wrap(
                spacing: 8,
                runSpacing: 4,
                children: [
                  if (current?['status'] != 'pending' && !consent)
                    _button(
                      connected ? tr("Reconnect") : tr("Log in"),
                      onPressed: _locked || _pending
                          ? null
                          : () => _requestLogin(provider),
                    ),
                  if (connected && current?['status'] != 'pending')
                    _button(
                      tr("Log out {0}", [name]),
                      onPressed: _locked || _pending
                          ? null
                          : () => unawaited(_logout(provider)),
                    ),
                ],
              ),
            ],
          ),
          if (_errorProvider == id &&
              _errorText != null &&
              _errorText!.isNotEmpty)
            AssistantParagraph(_errorText!, error: true, live: true),
          if (consent)
            _panel([
              AssistantParagraph(
                tr(
                  "Logging in enables the policies for all known GitHub Copilot models in your account.",
                ),
              ),
              Wrap(
                spacing: 8,
                runSpacing: 4,
                children: [
                  _button(
                    tr("I agree, log in"),
                    filled: true,
                    onPressed: _locked || _pending
                        ? null
                        : () => unawaited(_startLogin(provider, true)),
                  ),
                  _button(
                    tr("Not now"),
                    onPressed: _busy
                        ? null
                        : () => setState(() => _consentingProvider = null),
                  ),
                ],
              ),
            ]),
          if (current != null) _loginPanel(provider, current),
        ],
      ),
    );
  }

  Widget _loginPanel(Json provider, Json login) {
    final status = '${login['status'] ?? 'failed'}';
    if (status == 'pending') return _pendingPanel(provider, login);
    if (status == 'succeeded') {
      return _panel([
        Padding(
          padding: const EdgeInsets.only(top: 8),
          child: Semantics(
            liveRegion: true,
            child: Text(
              tr("Connected. {0} models are now available.", [
                _asInt(provider['modelCount']),
              ]),
              style: webText(context, size: 14, color: 'status.success'),
            ),
          ),
        ),
      ]);
    }
    final expired = status == 'expired';
    return _panel([
      AssistantParagraph(
        expired
            ? tr("The login timed out before it was completed.")
            : tr("The login failed."),
        error: true,
        live: true,
      ),
      Wrap(
        spacing: 8,
        children: [
          _button(
            tr("Try again"),
            onPressed: _locked || _pending
                ? null
                : () => _requestLogin(provider),
          ),
          _button(
            tr("Dismiss"),
            onPressed: () {
              ++_generation;
              _clearTimers();
              _clearAnswers();
              _setLogin(null);
            },
          ),
        ],
      ),
    ]);
  }

  Widget _pendingPanel(Json provider, Json login) {
    final providerId = '${provider['id'] ?? ''}';
    final auth = obj(login['auth']);
    final userCode = auth['userCode'] is String ? '${auth['userCode']}' : '';
    final authUri = _authorizationUri(auth['url']);
    final prompts = rows(login['prompts']);
    final callbackServer = provider['usesCallbackServer'] == true;
    final progress = safeBackendText(login['progress'], '');
    final children = <Widget>[];

    if (auth.isEmpty) {
      children.add(AssistantParagraph(tr("Preparing the login…")));
    } else {
      if (userCode.isNotEmpty) {
        children.add(
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                AssistantParagraph(tr("1. Copy your one-time code")),
                Wrap(
                  spacing: 8,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    SelectableText(
                      userCode,
                      key: const ValueKey('provider-login-user-code'),
                      style: webText(
                        context,
                        size: 18,
                      ).copyWith(fontFamily: 'monospace', letterSpacing: 1.4),
                    ),
                    _button(
                      _copied == 'code' ? tr("Copied") : tr("Copy code"),
                      onPressed: () => unawaited(_copy(userCode, 'code')),
                    ),
                  ],
                ),
              ],
            ),
          ),
        );
      }
      children.add(
        Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (userCode.isNotEmpty)
                AssistantParagraph(tr("2. Enter it on the authorization page")),
              if (authUri == null)
                AssistantParagraph(
                  tr("The provider returned an unsupported authorization URL."),
                  error: true,
                  live: true,
                )
              else
                Wrap(
                  spacing: 8,
                  runSpacing: 4,
                  children: [
                    _button(
                      tr("Open authorization page"),
                      filled: true,
                      onPressed: () =>
                          unawaited(_openAuthorization(authUri, providerId)),
                    ),
                    _button(
                      _copied == 'link' ? tr("Copied") : tr("Copy link"),
                      onPressed: () =>
                          unawaited(_copy(authUri.toString(), 'link')),
                    ),
                  ],
                ),
            ],
          ),
        ),
      );
      final instructions = safeBackendText(auth['instructions'], '');
      if (callbackServer) {
        children.add(
          AssistantParagraph(
            tr(
              "Sign in on the authorization page. If this browser runs on the gateway's machine, the login finishes by itself. Otherwise the browser ends on a localhost page that may not load. Copy that page's full address and paste it below.",
            ),
          ),
        );
      } else if (instructions.isNotEmpty && userCode.isEmpty) {
        children.add(AssistantParagraph(instructions));
      }
    }

    if (progress.isNotEmpty) {
      children.add(AssistantParagraph(progress, live: true));
    }
    for (final prompt in prompts) {
      children.add(_prompt(prompt));
    }
    final minutes = _remainingMinutes(login['expiresAt']);
    children.add(
      Padding(
        padding: const EdgeInsets.only(top: 8),
        child: Wrap(
          alignment: WrapAlignment.spaceBetween,
          crossAxisAlignment: WrapCrossAlignment.center,
          runSpacing: 4,
          children: [
            Text(
              tr(
                "Waiting for authorization · expires in {0} minute{1} · closing settings cancels it",
                [minutes, minutes == 1 ? '' : 's'],
              ),
              style: webText(context, size: 12, color: 'text.muted'),
            ),
            _button(
              tr("Cancel login"),
              onPressed: () => unawaited(_cancelLogin()),
            ),
          ],
        ),
      ),
    );

    return _panel([
      Semantics(
        liveRegion: true,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: children,
        ),
      ),
    ]);
  }

  Widget _prompt(Json prompt) {
    final id = '${prompt['id'] ?? ''}';
    final kind = '${prompt['kind'] ?? 'prompt'}';
    final message = '${prompt['message'] ?? ''}';
    final allowEmpty = prompt['allowEmpty'] == true;
    final enabled = !_locked;
    final answer = _answers[id] ?? '';
    final options = rows(prompt['options']);

    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(message, style: webText(context, size: 14)),
          const SizedBox(height: 6),
          if (kind == 'select')
            DropdownButtonFormField<String>(
              initialValue: answer.isEmpty ? null : answer,
              isExpanded: true,
              hint: Text(tr("Choose an option")),
              decoration: _fieldDecoration(''),
              items: [
                for (final option in options)
                  DropdownMenuItem<String>(
                    value: '${option['id'] ?? ''}',
                    child: Text(
                      '${option['label'] ?? option['id'] ?? ''}',
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
              ],
              onChanged: enabled
                  ? (value) {
                      setState(() => _answers[id] = value ?? '');
                    }
                  : null,
            )
          else
            TextField(
              key: ValueKey('provider-login-input-$id'),
              controller: _fields.putIfAbsent(
                id,
                () => TextEditingController(text: answer),
              ),
              obscureText: kind == 'manual',
              enableSuggestions: false,
              autocorrect: false,
              enabled: enabled,
              style: webText(context, size: 16),
              decoration: _fieldDecoration(
                '${prompt['placeholder'] ?? (kind == 'manual' ? 'http://localhost:…/callback?code=…' : '')}',
              ),
              onChanged: (value) => setState(() => _answers[id] = value),
              onSubmitted: (_) {
                if (_canSubmit(id, allowEmpty)) unawaited(_answer(prompt));
              },
            ),
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Wrap(
              spacing: 8,
              children: [
                _button(
                  kind == 'manual' ? tr("Finish login") : tr("Continue"),
                  onPressed: enabled && _canSubmit(id, allowEmpty)
                      ? () => unawaited(_answer(prompt))
                      : null,
                ),
                if (kind == 'select')
                  _button(
                    tr("Skip selection"),
                    onPressed: enabled
                        ? () => unawaited(_answer(prompt, skip: true))
                        : null,
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  bool _canSubmit(String id, bool allowEmpty) =>
      allowEmpty || (_answers[id]?.isNotEmpty ?? false);

  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.only(top: 20, bottom: 2),
          child: Text(
            tr("Subscription accounts"),
            style: webText(
              context,
              size: 14,
              weight: FontWeight.w700,
            ).copyWith(height: 16 / 14),
          ),
        ),
        AssistantParagraph(
          tr(
            "Sign in with an existing subscription. pi-ai's built-in model list is not a verification of your account's model access or service policy.",
          ),
        ),
        for (final provider in widget.providers) _providerCard(provider),
        AssistantParagraph(
          tr(
            "Log out removes this gateway's saved credentials and prevents new requests. It does not revoke your account upstream or recall content already sent.",
          ),
        ),
      ],
    );
  }
}
