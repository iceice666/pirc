import '../l10n/app_i18n.dart';
import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'assistant_settings.dart';
import 'backend_api.dart';
import 'common.dart';
import 'web_controls.dart';
import 'gateway.dart';
import 'native_management_access.dart';
import 'provider_editor.dart';
import 'provider_login.dart';

class BackendSettings extends StatefulWidget {
  const BackendSettings({
    super.key,
    required this.controller,
    this.disabled = false,
  });
  final LiveController controller;
  final bool disabled;
  @override
  State<BackendSettings> createState() => _BackendSettingsState();
}

class _BackendSettingsState extends State<BackendSettings> {
  Json? snapshot, editingProvider;
  String? error, origin, client, pairingStamp;
  String savedDefault = '', defaultChoice = '';
  bool loading = true, busy = false, activeLogin = false, loginBusy = false;
  bool editing = false, managementRequired = false;
  bool managementStatusChecked = false;
  Json? managementStatusSnapshot;
  int generation = 0, editorRevision = 0, accountRevision = 0;
  final expanded = <String>{};
  LiveController get c => widget.controller;
  bool get locked => widget.disabled || busy || loginBusy;

  @override
  void initState() {
    super.initState();
    origin = c.origin;
    client = c.clientId;
    pairingStamp = c.pairingStamp;
    accountRevision = c.accountRevision;
    c.addListener(accountChanged);
    refresh();
  }

  @override
  void didUpdateWidget(BackendSettings oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != c) {
      oldWidget.controller.removeListener(accountChanged);
      c.addListener(accountChanged);
      reset();
    } else if (oldWidget.disabled != widget.disabled) {
      reset();
    }
  }

  void accountChanged() {
    if (origin != c.origin ||
        client != c.clientId ||
        pairingStamp != c.pairingStamp ||
        accountRevision != c.accountRevision) {
      reset();
    }
  }

  void reset() {
    generation++;
    origin = c.origin;
    client = c.clientId;
    pairingStamp = c.pairingStamp;
    accountRevision = c.accountRevision;
    snapshot = null;
    error = null;
    managementRequired = false;
    managementStatusChecked = false;
    managementStatusSnapshot = null;
    savedDefault = defaultChoice = '';
    busy = activeLogin = loginBusy = editing = false;
    editingProvider = null;
    expanded.clear();
    editorRevision++;
    refresh();
  }

  bool current(int token) => mounted && token == generation;
  void accept(Json value) {
    final model = obj(value['defaultModel']);
    final saved = model.isEmpty
        ? ''
        : jsonEncode([model['provider'], model['id']]);
    if (saved != savedDefault) defaultChoice = saved;
    savedDefault = saved;
    snapshot = value;
  }

  Future<void> refresh({bool models = false}) async {
    final token = generation;
    final controller = c;
    if (widget.disabled) {
      setState(() => loading = false);
      return;
    }
    setState(() {
      loading = snapshot == null;
      error = null;
    });
    try {
      final data = await backendRequest(controller, '/api/providers');
      if (!current(token)) return;
      setState(() => accept(data));
      _discoverManagementStatus(token, controller);
      if (models) await controller.refreshModels().catchError((Object _) {});
    } catch (e) {
      if (current(token)) {
        setState(() {
          error = backendError(e);
          if (e is BackendException && e.status == 403) {
            managementRequired = true;
          }
        });
      }
    } finally {
      if (current(token)) setState(() => loading = false);
    }
  }

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
        if (_managementSnapshotExpired(value, DateTime.now())) {
          await managementRevoked();
        }
      } catch (_) {
        // Status discovery is optional; normal protected-route errors continue
        // to provide the browser-approval affordance.
      }
    }());
  }

  bool _managementSnapshotExpired(Json status, DateTime now) {
    final remaining = status['remainingMs'];
    if (remaining is num) return remaining <= 0;
    final expiresAt = status['expiresAt'];
    final serverNow = status['serverNow'];
    if (expiresAt is! num) return false;
    if (serverNow is num) return expiresAt <= serverNow;
    return expiresAt <= now.millisecondsSinceEpoch;
  }

  Future<void> mutate(
    String path,
    String method, {
    dynamic body,
    bool closeEditor = false,
  }) async {
    if (locked || activeLogin) return;
    final token = generation, controller = c;
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final data = await backendRequest(
        controller,
        path,
        method: method,
        body: body,
      );
      if (!current(token)) return;
      setState(() {
        accept(data);
        if (closeEditor) {
          editing = false;
          editingProvider = null;
        }
      });
      await controller.refreshModels().catchError((Object _) {});
    } catch (e) {
      if (current(token)) {
        setState(() {
          error = backendError(e);
          if (e is BackendException && e.status == 403) {
            managementRequired = true;
          }
        });
      }
    } finally {
      if (current(token)) setState(() => busy = false);
    }
  }

  void edit([Json? provider]) {
    if (locked || activeLogin || provider?['readOnly'] == true) return;
    setState(() {
      editing = true;
      editingProvider = provider;
      editorRevision++;
    });
  }

  Widget editor() {
    final token = generation;
    return ProviderEditor(
      key: ValueKey('editor-$generation-$editorRevision'),
      controller: c,
      // The preceding heading/card already contributes the collapsed 12px gap.
      margin: const EdgeInsets.only(bottom: 12),
      provider: editingProvider,
      takenIds: rows(snapshot?['providers']).map((p) => '${p['id']}').toList(),
      locked: locked || activeLogin,
      onSave: (id, input, editingId) async {
        if (!current(token)) return;
        await mutate(
          editingId == null
              ? '/api/providers'
              : '/api/providers/${enc(editingId)}',
          editingId == null ? 'POST' : 'PUT',
          body: editingId == null ? {'id': id, ...input} : input,
          closeEditor: true,
        );
      },
      onCancel: () {
        if (!current(token)) return;
        setState(() {
          editing = false;
          editingProvider = null;
        });
      },
    );
  }

  Widget heading(String label) => Padding(
    padding: const EdgeInsets.only(top: 20, bottom: 12),
    child: Text(
      label,
      style: webText(
        context,
        size: 14,
        weight: FontWeight.w700,
      ).copyWith(height: 16 / 14),
    ),
  );

  Future<void> managementRevoked() async {
    if (!mounted) return;
    setState(() {
      snapshot = null;
      managementStatusSnapshot = null;
      error = null;
      editing = false;
      editingProvider = null;
    });
    await refresh();
  }

  Widget card(Json provider) {
    final id = '${provider['id']}';
    final models = rows(provider['models']);
    final colors = palette(context);
    return Container(
      key: ValueKey('backend-$id'),
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        border: Border.all(color: colors['web.line']),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            '${provider['name'] == null || provider['name'] == '' ? id : provider['name']}',
            style: webText(
              context,
              size: 13,
              weight: FontWeight.w700,
            ).copyWith(height: 18 / 13),
          ),
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(
              '${provider['source'] == 'file' ? 'File-managed · Read only' : 'Web-managed'} · ${provider['api']} · ${provider['hasApiKey'] == true ? 'API key saved' : 'No API key'}${provider['preset'] == null || provider['preset'] == '' ? '' : ' · ${provider['preset']} preset'}',
              style: webText(
                context,
                size: 12,
                color: 'text.muted',
              ).copyWith(height: 14 / 12),
            ),
          ),
          if (provider['baseUrl'] != null && provider['baseUrl'] != '')
            AssistantParagraph('${provider['baseUrl']}'),
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Semantics(
              expanded: expanded.contains(id),
              child: Align(
                alignment: Alignment.centerLeft,
                child: TextButton(
                  style: TextButton.styleFrom(
                    padding: EdgeInsets.zero,
                    minimumSize: Size.zero,
                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  ),
                  onPressed: () => setState(() {
                    if (!expanded.add(id)) expanded.remove(id);
                  }),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      CustomPaint(
                        size: const Size(9, 9),
                        painter: _DisclosurePainter(
                          expanded.contains(id),
                          colors['text.primary'],
                        ),
                      ),
                      const SizedBox(width: 4),
                      Text(
                        tr("{0} models", [models.length]),
                        style: webText(
                          context,
                          size: 13,
                        ).copyWith(height: 15 / 13),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
          if (expanded.contains(id))
            ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: 180),
              child: SingleChildScrollView(
                child: Padding(
                  padding: const EdgeInsets.only(left: 20),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      for (final model in models)
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 4),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                '• ${model['name'] ?? model['id']}',
                                style: webText(context, size: 13),
                              ),
                              Text(
                                '${model['id']}',
                                style: webText(
                                  context,
                                  size: 12,
                                  color: 'text.muted',
                                ),
                              ),
                            ],
                          ),
                        ),
                    ],
                  ),
                ),
              ),
            ),
          if (provider['readOnly'] != true)
            Padding(
              padding: const EdgeInsets.only(top: 10),
              child: Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  AssistantButton(
                    tr("Edit {0}", [id]),
                    onPressed: locked || activeLogin
                        ? null
                        : () => edit(provider),
                  ),
                  AssistantButton(
                    tr("Remove {0}", [id]),
                    onPressed: locked || activeLogin
                        ? null
                        : () => mutate('/api/providers/${enc(id)}', 'DELETE'),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    final providers = rows(snapshot?['providers']);
    final choices = <String, String>{'': tr("Use file default / automatic")};
    for (final provider in providers) {
      for (final model in rows(provider['models'])) {
        choices[jsonEncode([provider['id'], model['id']])] =
            '${provider['name'] == null || provider['name'] == '' ? provider['id'] : provider['name']} / ${model['name'] ?? model['id']}';
      }
    }
    final token = generation;
    return AssistantSection(
      title: tr("Model backends"),
      children: [
        AssistantParagraph(
          tr(
            "Global settings for this single-user gateway. All model requests run on the gateway; endpoints must be reachable from there.",
          ),
        ),
        if (widget.disabled)
          AssistantParagraph(
            tr(
              "Backend settings are unavailable in demo mode. No real accounts or settings will be changed.",
            ),
            live: true,
          )
        else ...[
          if (loading) AssistantParagraph(tr("Loading backends…"), live: true),
          if (error != null)
            AssistantParagraph(error!, error: true, live: true),
          if (managementRequired)
            NativeManagementAccess(
              key: const ValueKey('native-management-access'),
              controller: c,
              capabilities: const ['providers'],
              onApproved: () => refresh(models: true),
              onRevoked: managementRevoked,
              initialStatus: managementStatusSnapshot,
            ),
          if (!loading && snapshot != null) ...[
            ProviderLogin(
              key: ValueKey('login-$generation'),
              controller: c,
              providers: rows(snapshot?['oauthProviders']),
              locked: locked,
              onActiveChanged: (value) {
                if (current(token) && value != activeLogin) {
                  setState(() => activeLogin = value);
                }
              },
              onBusyChanged: (value) {
                if (current(token) && value != loginBusy) {
                  setState(() => loginBusy = value);
                }
              },
              onLogout: (id) async {
                if (current(token)) {
                  await mutate('/api/providers/${enc(id)}', 'DELETE');
                }
              },
              onSucceeded: () async {
                if (current(token)) await refresh(models: true);
              },
            ),
            heading(tr("API keys and custom endpoints")),
            for (final provider in providers.where(
              (p) => p['source'] != 'oauth',
            ))
              if (editing && editingProvider?['id'] == provider['id'])
                editor()
              else
                card(provider),
            if (editing && editingProvider == null)
              editor()
            else
              Align(
                alignment: Alignment.centerLeft,
                child: AssistantButton(
                  tr("Add backend"),
                  onPressed: locked || activeLogin || editing
                      ? null
                      : () => edit(),
                ),
              ),
            heading(tr("Default model")),
            Text(
              tr("Gateway default"),
              style: webText(
                context,
                size: 13,
                color: 'text.secondary',
              ).copyWith(height: 15 / 13),
            ),
            const SizedBox(height: 6),
            Container(
              height: (MediaQuery.textScalerOf(context).scale(20) + 20).clamp(
                40.0,
                double.infinity,
              ),
              padding: const EdgeInsets.symmetric(horizontal: 12),
              decoration: BoxDecoration(
                color: palette(context)['surface.subtle'],
                borderRadius: BorderRadius.circular(12),
              ),
              child: DropdownButtonHideUnderline(
                child: DropdownButton<String>(
                  value: choices.containsKey(defaultChoice)
                      ? defaultChoice
                      : null,
                  isExpanded: true,
                  isDense: true,
                  iconSize: 14,
                  style: webText(context, size: 16, color: 'text.secondary'),
                  onChanged: locked || activeLogin
                      ? null
                      : (value) => setState(() => defaultChoice = value ?? ''),
                  items: [
                    for (final choice in choices.entries)
                      DropdownMenuItem(
                        value: choice.key,
                        child: Text(
                          choice.value,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 12),
            Align(
              alignment: Alignment.centerLeft,
              child: AssistantButton(
                tr("Save default"),
                onPressed: locked || activeLogin
                    ? null
                    : () {
                        final selected = defaultChoice.isEmpty
                            ? null
                            : jsonDecode(defaultChoice) as List;
                        mutate(
                          '/api/providers/default-model',
                          'PUT',
                          body: selected == null
                              ? null
                              : {'provider': selected[0], 'id': selected[1]},
                        );
                      },
              ),
            ),
            AssistantParagraph(
              tr("Applies to new runs that have no explicit model selection."),
            ),
          ],
          if (!loading && snapshot == null)
            Align(
              alignment: Alignment.centerLeft,
              child: AssistantButton(
                tr("Retry settings"),
                onPressed: () => refresh(),
              ),
            ),
        ],
      ],
    );
  }

  @override
  void dispose() {
    generation++;
    c.removeListener(accountChanged);
    super.dispose();
  }
}

class _DisclosurePainter extends CustomPainter {
  const _DisclosurePainter(this.expanded, this.color);
  final bool expanded;
  final Color color;
  @override
  void paint(Canvas canvas, Size size) {
    final path = Path();
    if (expanded) {
      path.moveTo(0, 1);
      path.lineTo(size.width, 1);
      path.lineTo(size.width / 2, size.height - 1);
    } else {
      path.moveTo(1, 0);
      path.lineTo(size.width - 1, size.height / 2);
      path.lineTo(1, size.height);
    }
    path.close();
    canvas.drawPath(path, Paint()..color = color);
  }

  @override
  bool shouldRepaint(_DisclosurePainter oldDelegate) =>
      expanded != oldDelegate.expanded || color != oldDelegate.color;
}
