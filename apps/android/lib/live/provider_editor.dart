import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'assistant_settings.dart';
import 'backend_api.dart';
import 'common.dart';
import 'gateway.dart';
import '../theme.dart';
import 'web_controls.dart';
import 'provider_validation.dart';

/// Endpoint/model editor for API-key and custom backends.
///
/// Probes use the paired gateway request. Saving is delegated to the caller's
/// authorized provider-settings path.
class ProviderEditor extends StatefulWidget {
  const ProviderEditor({
    super.key,
    required this.controller,
    this.provider,
    this.takenIds = const [],
    this.locked = false,
    this.margin = const EdgeInsets.symmetric(vertical: 12),
    required this.onSave,
    required this.onCancel,
  });

  final LiveController controller;
  final Json? provider;
  final List<String> takenIds;
  final bool locked;
  final EdgeInsetsGeometry margin;
  final Future<void> Function(String id, Json input, String? editingId) onSave;
  final VoidCallback onCancel;

  @override
  State<ProviderEditor> createState() => _ProviderEditorState();
}

class _ProviderEditorState extends State<ProviderEditor> {
  final id = TextEditingController();
  final baseUrl = TextEditingController();
  final apiKey = TextEditingController();
  final filter = TextEditingController();
  final manualId = TextEditingController();
  final baseUrlFocus = FocusNode();
  String? invalidField, validationError;
  final models = <_Model>[];
  List<Json> presets = [], discovered = [];
  String api = 'openai-completions',
      presetId = '',
      suggestedId = '',
      testModel = '';
  bool opencodeGo = false, clearKey = false, presetsUnavailable = false;
  bool connectionChanged = false, saving = false;
  _Check? checking;
  String? formError;
  ({bool ok, String text})? discovery;
  ({bool ok, String message})? testResult;
  int presetRevision = 0, actionRevision = 0;
  String? origin, clientId;

  LiveController get c => widget.controller;
  String? get editingId => widget.provider?['id'] is String
      ? widget.provider!['id'] as String
      : null;
  bool get busy =>
      widget.locked || connectionChanged || checking != null || saving;
  bool get ready =>
      id.text.trim().isNotEmpty &&
      baseUrl.text.trim().isNotEmpty &&
      models.isNotEmpty &&
      !models.any((m) => m.id.trim().isEmpty);

  Json? get preset {
    for (final item in presets) {
      if (item['id'] == presetId) return item;
    }
    return null;
  }

  String? get savedPreset {
    if (editingId != null) {
      final value = widget.provider?['preset'];
      return value is String && value.isNotEmpty ? value : null;
    }
    return preset?['catalog'] == true ? _str(preset?['id']) : null;
  }

  @override
  void initState() {
    super.initState();
    _initialize();
    origin = c.origin;
    clientId = c.clientId;
    c.addListener(_watchController);
    _loadPresets();
  }

  void _initialize() {
    final p = widget.provider;
    id.text = _str(p?['id']);
    api = p?['api'] is String ? p!['api'] as String : 'openai-completions';
    baseUrl.text = _str(p?['baseUrl']);
    opencodeGo = p?['opencodeGo'] == true;
    presetId = _str(p?['preset']);
    clearKey = false;
    apiKey.clear();
    filter.clear();
    manualId.clear();
    suggestedId = '';
    testModel = '';
    discovered = [];
    discovery = null;
    testResult = null;
    formError = null;
    invalidField = validationError = null;
    _clearModels();
    for (final model in rows(p?['models'])) {
      models.add(_Model(_editable(model)));
    }
  }

  @override
  void didUpdateWidget(covariant ProviderEditor oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != widget.controller) {
      oldWidget.controller.removeListener(_watchController);
      widget.controller.addListener(_watchController);
      final same =
          oldWidget.controller.origin == widget.controller.origin &&
          oldWidget.controller.clientId == widget.controller.clientId;
      origin = c.origin;
      clientId = c.clientId;
      _invalidate();
      apiKey.clear();
      if (!same) {
        connectionChanged = true;
        formError =
            'The gateway connection changed. Close and reopen backend settings.';
      } else {
        _loadPresets();
      }
    }
    if (oldWidget.provider?['id'] != widget.provider?['id']) _initialize();
  }

  void _watchController() {
    if (origin == c.origin && clientId == c.clientId) return;
    final hadIdentity = origin != null || clientId != null;
    origin = c.origin;
    clientId = c.clientId;
    _invalidate();
    apiKey.clear();
    if (!mounted) return;
    setState(() {
      checking = null;
      discovery = null;
      testResult = null;
      if (hadIdentity) {
        connectionChanged = true;
        formError =
            'The gateway connection changed. Close and reopen backend settings.';
      } else {
        presets = [];
        presetsUnavailable = false;
      }
    });
    if (!hadIdentity) _loadPresets();
  }

  void _invalidate() {
    presetRevision++;
    actionRevision++;
  }

  bool _currentPreset(
    int token,
    LiveController owner,
    String? host,
    String? client,
  ) =>
      mounted &&
      token == presetRevision &&
      identical(owner, widget.controller) &&
      host == owner.origin &&
      client == owner.clientId;

  bool _currentAction(
    int token,
    LiveController owner,
    String? host,
    String? client,
  ) =>
      mounted &&
      token == actionRevision &&
      identical(owner, widget.controller) &&
      host == owner.origin &&
      client == owner.clientId &&
      !connectionChanged;

  Future<void> _loadPresets() async {
    final token = ++presetRevision,
        owner = c,
        host = c.origin,
        client = c.clientId;
    try {
      final result = await backendRequest(owner, '/api/providers/presets');
      if (!_currentPreset(token, owner, host, client)) return;
      setState(() {
        presets = rows(result['presets']);
        presetsUnavailable = false;
      });
    } catch (_) {
      if (_currentPreset(token, owner, host, client)) {
        setState(() => presetsUnavailable = true);
      }
    }
  }

  @override
  void dispose() {
    _invalidate();
    c.removeListener(_watchController);
    apiKey.clear();
    id.dispose();
    baseUrl.dispose();
    apiKey.dispose();
    filter.dispose();
    manualId.dispose();
    baseUrlFocus.dispose();
    _clearModels();
    super.dispose();
  }

  static String _str(dynamic value) =>
      value is String ? value : value?.toString() ?? '';

  static Json _editable(Json model) {
    final result = <String, dynamic>{
      'id': model['id'] is String ? model['id'] : '',
    };
    if (model['name'] is String &&
        (model['name'] as String).trim().isNotEmpty) {
      result['name'] = (model['name'] as String).trim();
    }
    for (final key in ['contextWindow', 'maxTokens']) {
      final value = model[key];
      if (value is num && value != 0) result[key] = value;
    }
    if (model.containsKey('reasoning')) {
      result['reasoning'] = model['reasoning'];
    }
    if (model['input'] is List) {
      result['input'] = List<dynamic>.from(model['input'] as List);
    }
    return result;
  }

  List<Json> get choices {
    final catalog = preset?['catalog'] == true
        ? rows(preset?['models'])
        : <Json>[];
    final listed = discovered.map((m) => _str(m['id'])).toSet();
    return [
      ...discovered,
      ...catalog.where((m) => !listed.contains(_str(m['id']))),
    ];
  }

  List<Json> get shown {
    final query = filter.text.trim().toLowerCase();
    if (query.isEmpty) return choices;
    return choices
        .where(
          (m) =>
              _str(m['id']).toLowerCase().contains(query) ||
              (m['name'] is String &&
                  (m['name'] as String).toLowerCase().contains(query)),
        )
        .toList();
  }

  Set<String> get selected => models.map((m) => m.id).toSet();

  String _freeId(String base) {
    if (!widget.takenIds.contains(base)) return base;
    for (var n = 2; ; n++) {
      final value = '$base-$n';
      if (!widget.takenIds.contains(value)) return value;
    }
  }

  void _choosePreset(String value) {
    if (busy) return;
    final previous = preset;
    Json? next;
    for (final p in presets) {
      if (p['id'] == value) {
        next = p;
        break;
      }
    }
    setState(() {
      presetId = value;
      if (next != null) {
        api = _str(next['api']);
        baseUrl.text = _str(next['baseUrl']);
      } else if (previous != null &&
          baseUrl.text == _str(previous['baseUrl'])) {
        baseUrl.clear();
      }
      if (id.text.trim().isEmpty || id.text == suggestedId) {
        suggestedId = next == null ? '' : _freeId(value);
        id.text = suggestedId;
      }
      _clearModels();
      discovered = [];
      discovery = null;
      testResult = null;
      filter.clear();
    });
  }

  void _clearModels() {
    for (final model in models) {
      model.dispose();
    }
    models.clear();
  }

  void _toggle(Json model, bool checked) {
    final key = _str(model['id']);
    final index = models.indexWhere((m) => m.id == key);
    if (checked && index < 0) {
      setState(() => models.add(_Model(_editable(model))));
    } else if (!checked && index >= 0) {
      setState(() => models.removeAt(index).dispose());
    }
  }

  void _remove(_Model model) {
    if (!models.contains(model)) return;
    setState(() {
      models.remove(model);
      model.dispose();
    });
  }

  void _selectShown() {
    final remaining = 200 - models.length;
    if (busy || remaining <= 0) return;
    final missing = shown
        .where((m) => !selected.contains(_str(m['id'])))
        .take(remaining)
        .toList();
    if (missing.isNotEmpty) {
      setState(() => models.addAll(missing.map((m) => _Model(_editable(m)))));
    }
  }

  void _addManual() {
    final value = manualId.text.trim();
    if (busy || value.isEmpty || selected.contains(value)) return;
    setState(() {
      models.add(_Model({'id': value}));
      manualId.clear();
    });
  }

  void _setApi(String value) {
    if (api == value) return;
    setState(() {
      api = value;
      testResult = null;
    });
  }

  void _setKey(String _) => setState(() => testResult = null);
  void _setClearKey(bool value) => setState(() {
    clearKey = value;
    testResult = null;
  });
  void _setGo(bool value) => setState(() {
    opencodeGo = value;
    testResult = null;
  });
  void _setTestModel(String value) => setState(() {
    testModel = value;
    testResult = null;
  });

  Json _probe() {
    final body = <String, dynamic>{
      'api': api,
      'baseUrl': baseUrl.text.trim(),
      'opencodeGo': opencodeGo,
    };
    if (clearKey) {
      body['apiKey'] = '';
    } else if (apiKey.text.isNotEmpty) {
      body['apiKey'] = apiKey.text;
    } else if (editingId != null) {
      body['backendId'] = editingId;
    } else {
      body['apiKey'] = '';
    }
    if (savedPreset != null) body['preset'] = savedPreset;
    return body;
  }

  Future<void> _discover() async {
    if (busy || baseUrl.text.trim().isEmpty) return;
    final owner = c,
        host = c.origin,
        client = c.clientId,
        token = ++actionRevision;
    final body = _probe();
    setState(() {
      checking = _Check.discover;
      discovery = null;
    });
    try {
      final result = await backendRequest(
        owner,
        '/api/providers/discover',
        method: 'POST',
        body: body,
      );
      if (!_currentAction(token, owner, host, client)) return;
      final found = rows(result['models']);
      setState(() {
        discovered = found;
        discovery = (
          ok: true,
          text: found.isEmpty
              ? 'The endpoint lists no models. Add model IDs manually.'
              : 'Found ${found.length} model${found.length == 1 ? '' : 's'}. Select the ones to use.',
        );
      });
    } catch (error) {
      if (_currentAction(token, owner, host, client)) {
        setState(() => discovery = (ok: false, text: backendError(error)));
      }
    } finally {
      if (_currentAction(token, owner, host, client)) {
        setState(() => checking = null);
      }
    }
  }

  Future<void> _test() async {
    if (busy || models.isEmpty || baseUrl.text.trim().isEmpty) return;
    var model = models.first;
    for (final candidate in models) {
      if (candidate.id == testModel) {
        model = candidate;
        break;
      }
    }
    final owner = c,
        host = c.origin,
        client = c.clientId,
        token = ++actionRevision;
    final body = {..._probe(), 'model': model.editable()};
    setState(() {
      checking = _Check.test;
      testResult = null;
    });
    try {
      final result = await backendRequest(
        owner,
        '/api/providers/test',
        method: 'POST',
        body: body,
      );
      if (!_currentAction(token, owner, host, client)) return;
      final ok = result['ok'] == true;
      final message = ok
          ? _str(result['message'])
          : safeBackendText(result['message'], 'The connection test failed.');
      setState(() => testResult = (ok: ok, message: message));
    } catch (error) {
      if (_currentAction(token, owner, host, client)) {
        setState(() => testResult = (ok: false, message: backendError(error)));
      }
    } finally {
      if (_currentAction(token, owner, host, client)) {
        setState(() => checking = null);
      }
    }
  }

  void _invalid(String key, String message, FocusNode focus, [_Model? model]) {
    setState(() {
      invalidField = key;
      validationError = message;
    });
    model?.expansion.expand();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || invalidField != key || !focus.canRequestFocus) return;
      focus.requestFocus();
      final target = focus.context;
      if (target != null) Scrollable.ensureVisible(target, alignment: .4);
    });
  }

  Future<void> _save() async {
    if (busy || !ready) return;
    final urlError = providerUrlError(baseUrl.text);
    if (urlError != null) {
      _invalid('provider-editor-base-url', urlError, baseUrlFocus);
      return;
    }
    for (final model in models) {
      final contextError = providerTokenError(model.contextController.text);
      if (contextError != null) {
        _invalid(
          'provider-model-${model.id}-context',
          contextError,
          model.contextFocus,
          model,
        );
        return;
      }
      final maxError = providerTokenError(model.maxController.text);
      if (maxError != null) {
        _invalid(
          'provider-model-${model.id}-max-tokens',
          maxError,
          model.maxFocus,
          model,
        );
        return;
      }
    }
    invalidField = validationError = null;
    final edit = editingId;
    final body = <String, dynamic>{
      'api': api,
      'baseUrl': baseUrl.text.trim(),
      'opencodeGo': opencodeGo,
      if (clearKey)
        'apiKey': ''
      else if (apiKey.text.isNotEmpty)
        'apiKey': apiKey.text
      else if (edit == null)
        'apiKey': '',
      if (savedPreset != null) 'preset': savedPreset,
      'models': models.map((m) => m.editable(trimId: true)).toList(),
    };
    final owner = c,
        host = c.origin,
        client = c.clientId,
        token = ++actionRevision;
    setState(() {
      saving = true;
      apiKey.clear();
      testResult = null;
      formError = null;
    });
    try {
      await widget.onSave(id.text.trim(), body, edit);
    } catch (error) {
      if (_currentAction(token, owner, host, client)) {
        setState(() => formError = backendError(error));
      }
    } finally {
      if (_currentAction(token, owner, host, client)) {
        setState(() => saving = false);
      }
    }
  }

  String? _tokens(num? value) {
    if (value == null || value == 0) return null;
    if (value >= 1000000) {
      return '${_trimDecimal((value / 1000000).toStringAsFixed(1))}M';
    }
    if (value >= 1000) return '${(value / 1000).round()}K';
    if (value is double && value == value.roundToDouble()) {
      return value.toInt().toString();
    }
    return value.toString();
  }

  String _trimDecimal(String value) => value.replaceFirst(RegExp(r'\.0$'), '');

  String _summary(num? context, num? output, bool reasoning, bool image) {
    final ctx = _tokens(context), out = _tokens(output);
    return [
      if (ctx != null) '$ctx context' else 'default limits',
      if (out != null) '$out output',
      if (reasoning) 'reasoning',
      if (image) 'images',
    ].join(' · ');
  }

  String _modelSummary(_Model m) => _summary(
    m.context,
    m.maxTokens,
    m.reasoning == true,
    m.input?.contains('image') == true,
  );

  String _choiceSummary(Json m) => _summary(
    m['contextWindow'] is num ? m['contextWindow'] as num : null,
    m['maxTokens'] is num ? m['maxTokens'] as num : null,
    m['reasoning'] == true,
    m['input'] is List && (m['input'] as List).contains('image'),
  );

  @override
  Widget build(BuildContext context) {
    final colors = palette(context), edit = editingId, catalogId = savedPreset;
    final allChoices = choices, visibleChoices = shown, chosenIds = selected;
    final serviceOptions = <_Option>[
      const _Option('', 'Custom endpoint'),
      for (final p in presets)
        _Option(
          _str(p['id']),
          _str(p['name']).isEmpty ? _str(p['id']) : _str(p['name']),
          p['catalog'] == true ? 'Cloud service catalog' : 'Local server',
        ),
    ];
    return Container(
      margin: widget.margin,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        border: Border.all(color: colors['web.line']),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 20),
            child: Text(
              edit == null ? 'New backend' : 'Edit $edit',
              style: webText(
                context,
                size: 14,
                weight: FontWeight.w700,
              ).copyWith(height: 16 / 14),
            ),
          ),
          if (edit == null) ...[
            _selectField(
              'Service',
              presetId,
              serviceOptions,
              _choosePreset,
              busy,
            ),
            if (presetsUnavailable)
              const AssistantParagraph(
                'Service presets are unavailable. Enter the endpoint details manually.',
                live: true,
              ),
          ],
          if (catalogId != null)
            AssistantParagraph(
              "Uses pi-ai's ${_str(preset?['name']).isEmpty ? catalogId : _str(preset?['name'])} catalog. Known models keep their limits and request compatibility.",
            ),
          _field(
            'Backend ID',
            id,
            disabled: edit != null || busy,
            key: 'provider-editor-id',
            onChanged: (_) => setState(() {}),
          ),
          _selectField(
            'API',
            api,
            const [
              _Option('openai-completions', 'OpenAI-compatible chat'),
              _Option('openai-chat', 'OpenAI chat (legacy)'),
              _Option('openai-responses', 'OpenAI Responses'),
              _Option('anthropic-messages', 'Anthropic Messages'),
            ],
            _setApi,
            busy || catalogId != null,
          ),
          _field(
            'Base URL',
            baseUrl,
            hint: 'http://localhost:11434/v1',
            keyboardType: TextInputType.url,
            disabled: busy,
            key: 'provider-editor-base-url',
            focusNode: baseUrlFocus,
            onChanged: (_) => setState(() => testResult = null),
          ),
          _field(
            'API key (optional)',
            apiKey,
            hint: edit != null
                ? 'Leave blank to keep saved key'
                : (preset?['keyless'] == true
                      ? 'Not needed for a local server'
                      : 'Leave blank for a no-key endpoint'),
            keyboardType: TextInputType.visiblePassword,
            obscureText: true,
            disabled: busy || clearKey,
            key: 'provider-editor-api-key',
            onChanged: _setKey,
          ),
          if (edit != null)
            _checkbox(
              'Remove the saved API key',
              clearKey,
              _setClearKey,
              busy,
              colors,
            ),
          if (catalogId == null)
            _checkbox(
              'OpenCode Go compatibility (session routing + pirc User-Agent; automatic for opencode.ai/zen/go)',
              opencodeGo,
              _setGo,
              busy,
              colors,
            ),
          Padding(
            padding: const EdgeInsets.only(top: 16, bottom: 10),
            child: Text(
              'Models',
              style: webText(
                context,
                size: 13,
                weight: FontWeight.w700,
              ).copyWith(height: 15 / 13),
            ),
          ),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              AssistantButton(
                checking == _Check.discover
                    ? 'Fetching models…'
                    : 'Fetch models from endpoint',
                onPressed: busy || baseUrl.text.trim().isEmpty
                    ? null
                    : _discover,
              ),
            ],
          ),
          if (discovery != null)
            AssistantParagraph(
              discovery!.text,
              error: !discovery!.ok,
              live: true,
            ),
          if (allChoices.isNotEmpty)
            Container(
              margin: const EdgeInsets.only(top: 10),
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                border: Border.all(color: colors['web.line-dark']),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: [
                      SizedBox(
                        width: 220,
                        child: _field(
                          '',
                          filter,
                          hint: 'Filter ${allChoices.length} models',
                          onChanged: (_) => setState(() {}),
                        ),
                      ),
                      AssistantButton(
                        'Select shown',
                        onPressed: busy ? null : _selectShown,
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  ConstrainedBox(
                    constraints: const BoxConstraints(maxHeight: 240),
                    child: visibleChoices.isEmpty
                        ? const Align(
                            alignment: Alignment.centerLeft,
                            child: AssistantParagraph(
                              'No models match the filter.',
                            ),
                          )
                        : SingleChildScrollView(
                            child: Column(
                              children: [
                                for (final model in visibleChoices)
                                  _modelChoice(
                                    model,
                                    chosenIds.contains(_str(model['id'])),
                                    busy,
                                    colors,
                                  ),
                              ],
                            ),
                          ),
                  ),
                ],
              ),
            ),
          if (models.isEmpty)
            AssistantParagraph(
              allChoices.isNotEmpty
                  ? 'Select at least one model above, or add a model ID.'
                  : 'Fetch the endpoint’s models, or add a model ID.',
            )
          else
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  for (final model in models) _selectedModel(model, colors),
                ],
              ),
            ),
          Padding(
            padding: const EdgeInsets.only(top: 10),
            child: LayoutBuilder(
              builder: (context, constraints) {
                final measure = TextPainter(
                  text: TextSpan(
                    text: 'Add model',
                    style: webText(context, size: 14, weight: FontWeight.w500),
                  ),
                  textDirection: Directionality.of(context),
                  textScaler: MediaQuery.textScalerOf(context),
                )..layout();
                final buttonWidth = measure.width + 32;
                measure.dispose();
                final fits = constraints.maxWidth >= 180 + 8 + buttonWidth;
                return Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    SizedBox(
                      width: fits
                          ? constraints.maxWidth - buttonWidth - 8
                          : constraints.maxWidth,
                      child: Padding(
                        padding: const EdgeInsets.only(bottom: 12),
                        child: _field(
                          'Model ID',
                          manualId,
                          disabled: busy,
                          key: 'provider-editor-manual-model-id',
                          onChanged: (_) => setState(() {}),
                          onSubmitted: (_) => _addManual(),
                        ),
                      ),
                    ),
                    AssistantButton(
                      'Add model',
                      onPressed:
                          busy ||
                              manualId.text.trim().isEmpty ||
                              chosenIds.contains(manualId.text.trim())
                          ? null
                          : _addManual,
                    ),
                  ],
                );
              },
            ),
          ),
          Padding(
            padding: const EdgeInsets.only(top: 10),
            child: Wrap(
              spacing: 8,
              runSpacing: 8,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                if (models.length > 1) _testModelSelect(),
                AssistantButton(
                  checking == _Check.test ? 'Testing…' : 'Test connection',
                  onPressed:
                      busy || models.isEmpty || baseUrl.text.trim().isEmpty
                      ? null
                      : _test,
                ),
              ],
            ),
          ),
          if (testResult != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Semantics(
                liveRegion: true,
                child: Text(
                  testResult!.ok
                      ? 'Connected. ${testResult!.message}'
                      : testResult!.message,
                  style: webText(
                    context,
                    size: 13,
                    color: testResult!.ok ? 'status.success' : 'status.danger',
                  ),
                ),
              ),
            ),
          if (formError != null)
            AssistantParagraph(formError!, error: true, live: true),
          if (connectionChanged)
            const AssistantParagraph(
              'The gateway connection changed. Close and reopen backend settings before continuing.',
              error: true,
              live: true,
            ),
          Padding(
            padding: const EdgeInsets.only(top: 10),
            child: Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                AssistantButton(
                  'Save backend',
                  primary: true,
                  onPressed: busy || !ready ? null : _save,
                ),
                AssistantButton(
                  'Cancel editing',
                  onPressed: widget.locked ? null : widget.onCancel,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _field(
    String label,
    TextEditingController controller, {
    String? hint,
    TextInputType? keyboardType,
    bool obscureText = false,
    bool disabled = false,
    String? key,
    FocusNode? focusNode,
    ValueChanged<String>? onChanged,
    ValueChanged<String>? onSubmitted,
  }) => _Field(
    key: key == null ? null : ValueKey(key),
    label: label,
    controller: controller,
    hint: hint,
    keyboardType: keyboardType,
    obscureText: obscureText,
    disabled: disabled,
    focusNode: focusNode,
    validationError: key != null && invalidField == key
        ? validationError
        : null,
    onChanged: (value) {
      if (invalidField == key) {
        setState(() => invalidField = validationError = null);
      }
      onChanged?.call(value);
    },
    onSubmitted: onSubmitted ?? (_) => _save(),
  );

  Widget _selectField(
    String label,
    String value,
    List<_Option> options,
    ValueChanged<String> onSelect,
    bool disabled,
  ) => Padding(
    padding: const EdgeInsets.only(top: 12),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          label,
          style: webText(
            context,
            size: 13,
            weight: FontWeight.w500,
            color: 'text.secondary',
          ).copyWith(height: 15 / 13),
        ),
        const SizedBox(height: 6),
        _Select(
          label: label,
          value: value,
          options: options,
          onSelect: onSelect,
          disabled: disabled,
        ),
      ],
    ),
  );

  Widget _checkbox(
    String label,
    bool value,
    ValueChanged<bool> onChanged,
    bool disabled,
    PircColors colors,
  ) => InkWell(
    onTap: disabled ? null : () => onChanged(!value),
    borderRadius: BorderRadius.circular(6),
    child: Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 2),
            child: SizedBox(
              width: 16,
              height: 16,
              child: Transform.scale(
                scale: 16 / 18,
                child: Checkbox(
                  value: value,
                  onChanged: disabled ? null : (v) => onChanged(v == true),
                  visualDensity: VisualDensity.compact,
                  materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  side: BorderSide(color: colors['text.muted']),
                ),
              ),
            ),
          ),
          const SizedBox(height: 6),
          Text(
            label,
            style: webText(
              context,
              size: 13,
              weight: FontWeight.w500,
              color: 'text.secondary',
            ).copyWith(height: 15 / 13),
          ),
        ],
      ),
    ),
  );

  Widget _modelChoice(
    Json model,
    bool checked,
    bool disabled,
    PircColors colors,
  ) {
    final key = _str(model['id']);
    final name = model['name'] is String ? model['name'] as String : key;
    return InkWell(
      onTap: disabled ? null : () => _toggle(model, !checked),
      borderRadius: BorderRadius.circular(6),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 5),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox(
              width: 20,
              height: 20,
              child: Checkbox(
                value: checked,
                onChanged: disabled ? null : (v) => _toggle(model, v == true),
                visualDensity: VisualDensity.compact,
                materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                side: BorderSide(color: colors['text.muted']),
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    name,
                    style: webText(context, size: 13, weight: FontWeight.w500),
                  ),
                  Text(
                    '$key · ${_choiceSummary(model)}',
                    style: webText(context, size: 11, color: 'text.muted'),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _selectedModel(_Model model, PircColors colors) => Container(
    padding: const EdgeInsets.only(top: 8, bottom: 8),
    decoration: BoxDecoration(
      border: Border(top: BorderSide(color: colors['web.line'])),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    model.nameController.text.trim().isEmpty
                        ? model.id
                        : model.nameController.text,
                    style: webText(
                      context,
                      size: 13,
                      weight: FontWeight.w700,
                    ).copyWith(height: 18 / 13),
                  ),
                  Text(
                    '${model.id} · ${_modelSummary(model)}',
                    style: webText(
                      context,
                      size: 12,
                      color: 'text.muted',
                    ).copyWith(height: 14 / 12),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            AssistantButton(
              'Remove ${model.id}',
              onPressed: busy ? null : () => _remove(model),
            ),
          ],
        ),
        ListenableBuilder(
          listenable: model.expansion,
          builder: (context, _) => Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Semantics(
                  expanded: model.expansion.isExpanded,
                  child: TextButton(
                    onPressed: () => model.expansion.isExpanded
                        ? model.expansion.collapse()
                        : model.expansion.expand(),
                    style: TextButton.styleFrom(
                      minimumSize: Size.zero,
                      padding: EdgeInsets.zero,
                      alignment: Alignment.centerLeft,
                      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                      shape: const RoundedRectangleBorder(),
                      foregroundColor: colors['text.primary'],
                    ),
                    child: Row(
                      children: [
                        CustomPaint(
                          size: const Size(9, 9),
                          painter: _DetailsMarker(
                            model.expansion.isExpanded,
                            colors['text.primary'],
                          ),
                        ),
                        const SizedBox(width: 5),
                        Text(
                          'Details',
                          style: webText(
                            context,
                            size: 13,
                          ).copyWith(height: 15 / 13),
                        ),
                      ],
                    ),
                  ),
                ),
                if (model.expansion.isExpanded)
                  Container(
                    margin: const EdgeInsets.only(top: 8),
                    padding: const EdgeInsets.fromLTRB(
                      9.75,
                      4.546875,
                      9.75,
                      20.125,
                    ),
                    decoration: BoxDecoration(
                      border: Border.all(color: colors['web.line']),
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        _field(
                          'Display name',
                          model.nameController,
                          disabled: busy,
                          key: 'provider-model-${model.id}-name',
                          onChanged: (_) => setState(() {}),
                        ),
                        _field(
                          'Context window (tokens)',
                          model.contextController,
                          hint: '200000',
                          keyboardType: const TextInputType.numberWithOptions(
                            decimal: true,
                            signed: false,
                          ),
                          disabled: busy,
                          key: 'provider-model-${model.id}-context',
                          focusNode: model.contextFocus,
                          onChanged: (_) => setState(() {}),
                        ),
                        _field(
                          'Maximum output tokens',
                          model.maxController,
                          hint: '32000',
                          keyboardType: const TextInputType.numberWithOptions(
                            decimal: true,
                            signed: false,
                          ),
                          disabled: busy,
                          key: 'provider-model-${model.id}-max-tokens',
                          focusNode: model.maxFocus,
                          onChanged: (_) => setState(() {}),
                        ),
                        _checkbox(
                          'Supports reasoning',
                          model.reasoning ?? false,
                          (value) => setState(() => model.reasoning = value),
                          busy,
                          colors,
                        ),
                        _checkbox(
                          'Supports image input',
                          model.input?.contains('image') ?? false,
                          (value) => setState(
                            () => model.input = value
                                ? ['text', 'image']
                                : ['text'],
                          ),
                          busy,
                          colors,
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
        ),
      ],
    ),
  );

  Widget _testModelSelect() {
    final options = [
      for (final model in models)
        _Option(
          model.id,
          model.nameController.text.trim().isEmpty
              ? model.id
              : model.nameController.text,
        ),
    ];
    var value = testModel;
    if (!models.any((model) => model.id == value)) value = models.first.id;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          'Test with',
          style: webText(
            context,
            size: 13,
            weight: FontWeight.w500,
            color: 'text.secondary',
          ).copyWith(height: 15 / 13),
        ),
        const SizedBox(width: 8),
        ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 240),
          child: _Select(
            label: 'Test with',
            value: value,
            options: options,
            onSelect: _setTestModel,
            disabled: busy,
          ),
        ),
      ],
    );
  }
}

class _Model {
  _Model(Json model)
    : id = model['id'] is String ? model['id'] as String : '',
      nameController = TextEditingController(
        text: model['name'] is String ? model['name'] as String : '',
      ),
      contextController = TextEditingController(
        text: model['contextWindow'] is num
            ? model['contextWindow'].toString()
            : '',
      ),
      maxController = TextEditingController(
        text: model['maxTokens'] is num ? model['maxTokens'].toString() : '',
      ),
      reasoning = model['reasoning'] is bool
          ? model['reasoning'] as bool
          : null,
      input = model['input'] is List
          ? List<dynamic>.from(model['input'] as List)
          : null;

  final String id;
  final TextEditingController nameController, contextController, maxController;
  final contextFocus = FocusNode(), maxFocus = FocusNode();
  final expansion = ExpansibleController();
  bool? reasoning;
  List<dynamic>? input;

  num? get context => providerNumber(contextController.text);
  num? get maxTokens => providerNumber(maxController.text);

  Json editable({bool trimId = false}) {
    final result = <String, dynamic>{'id': trimId ? id.trim() : id};
    final name = nameController.text.trim();
    if (name.isNotEmpty) result['name'] = name;
    if (context != null && context != 0) result['contextWindow'] = context;
    if (maxTokens != null && maxTokens != 0) result['maxTokens'] = maxTokens;
    if (reasoning != null) result['reasoning'] = reasoning;
    if (input != null) result['input'] = List<dynamic>.from(input!);
    return result;
  }

  void dispose() {
    contextFocus.dispose();
    maxFocus.dispose();
    expansion.dispose();
    nameController.dispose();
    contextController.dispose();
    maxController.dispose();
  }
}

class _Option {
  const _Option(this.value, this.label, [this.detail]);
  final String value, label;
  final String? detail;
}

class _Select extends StatefulWidget {
  const _Select({
    required this.label,
    required this.value,
    required this.options,
    required this.onSelect,
    this.disabled = false,
  });
  final String label, value;
  final List<_Option> options;
  final ValueChanged<String> onSelect;
  final bool disabled;

  @override
  State<_Select> createState() => _SelectState();
}

class _SelectState extends State<_Select> {
  final menu = MenuController();
  final focus = FocusNode();

  @override
  void dispose() {
    focus.dispose();
    super.dispose();
  }

  @override
  void didUpdateWidget(covariant _Select oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.disabled && menu.isOpen) menu.close();
  }

  @override
  Widget build(BuildContext context) {
    final colors = palette(context);
    var current = _Option(widget.value, widget.label);
    for (final option in widget.options) {
      if (option.value == widget.value) {
        current = option;
        break;
      }
    }
    return MenuAnchor(
      controller: menu,
      childFocusNode: focus,
      consumeOutsideTap: false,
      style: MenuStyle(
        alignment: Alignment.topLeft,
        backgroundColor: WidgetStatePropertyAll(colors['web.bg-layer']),
        surfaceTintColor: const WidgetStatePropertyAll(Colors.transparent),
        elevation: const WidgetStatePropertyAll(8),
        minimumSize: const WidgetStatePropertyAll(Size(180, 0)),
        maximumSize: WidgetStatePropertyAll(
          Size(
            MediaQuery.sizeOf(context).width - 32,
            MediaQuery.sizeOf(context).height * .55,
          ),
        ),
        padding: const WidgetStatePropertyAll(EdgeInsets.all(6)),
        side: WidgetStatePropertyAll(
          BorderSide(color: colors['web.line-dark']),
        ),
        shape: WidgetStatePropertyAll(
          RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        ),
      ),
      menuChildren: [
        for (final option in widget.options)
          MenuItemButton(
            onPressed: () {
              menu.close();
              focus.requestFocus();
              if (option.value != widget.value) widget.onSelect(option.value);
            },
            style: MenuItemButton.styleFrom(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
              minimumSize: Size.zero,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(8),
              ),
            ),
            trailingIcon: SizedBox(
              width: 16,
              child: option.value == widget.value
                  ? Icon(Icons.check, size: 15, color: colors['text.secondary'])
                  : null,
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(option.label, style: webText(context, size: 13)),
                if (option.detail != null)
                  Text(
                    option.detail!,
                    style: webText(context, size: 11, color: 'text.muted'),
                  ),
              ],
            ),
          ),
      ],
      builder: (context, controller, child) => TextButton(
        focusNode: focus,
        onPressed: widget.disabled || widget.options.isEmpty
            ? null
            : () => controller.isOpen ? controller.close() : controller.open(),
        style: TextButton.styleFrom(
          alignment: Alignment.centerLeft,
          minimumSize: const Size.fromHeight(40),
          padding: const EdgeInsets.symmetric(horizontal: 12),
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          foregroundColor: colors['text.primary'],
          backgroundColor: colors['web.bg-subtle'],
          disabledForegroundColor: colors['text.muted'],
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(12),
          ),
          textStyle: webText(context, size: 16),
        ),
        child: Row(
          children: [
            Expanded(
              child: Text(
                current.label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: webText(
                  context,
                  size: 16,
                  weight: FontWeight.w500,
                  color: 'text.secondary',
                ).copyWith(height: 18 / 16),
              ),
            ),
            Icon(Icons.expand_more, size: 18, color: colors['text.muted']),
          ],
        ),
      ),
    );
  }
}

enum _Check { discover, test }

class _Field extends StatelessWidget {
  const _Field({
    super.key,
    required this.label,
    required this.controller,
    this.hint,
    this.keyboardType,
    this.obscureText = false,
    this.disabled = false,
    this.onChanged,
    this.onSubmitted,
    this.focusNode,
    this.validationError,
  });
  final String label;
  final TextEditingController controller;
  final String? hint, validationError;
  final FocusNode? focusNode;
  final TextInputType? keyboardType;
  final bool obscureText, disabled;
  final ValueChanged<String>? onChanged, onSubmitted;

  @override
  Widget build(BuildContext context) {
    final colors = palette(context);
    final lineHeight = MediaQuery.textScalerOf(context).scale(16) * 18 / 16;
    return Padding(
      padding: EdgeInsets.only(top: label.isEmpty ? 0 : 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (label.isNotEmpty) ...[
            Text(
              label,
              style: webText(
                context,
                size: 13,
                weight: FontWeight.w500,
                color: 'text.secondary',
              ).copyWith(height: 15 / 13),
            ),
            const SizedBox(height: 6),
          ],
          Focus(
            canRequestFocus: false,
            onKeyEvent: (_, event) {
              if (event is! KeyDownEvent ||
                  onSubmitted == null ||
                  (event.logicalKey != LogicalKeyboardKey.enter &&
                      event.logicalKey != LogicalKeyboardKey.numpadEnter) ||
                  !controller.value.composing.isCollapsed) {
                return KeyEventResult.ignored;
              }
              onSubmitted!(controller.text);
              return KeyEventResult.handled;
            },
            child: TextField(
              focusNode: focusNode,
              controller: controller,
              enabled: !disabled,
              obscureText: obscureText,
              autocorrect: false,
              enableSuggestions: !obscureText,
              keyboardType: keyboardType,
              inputFormatters: keyboardType?.index == TextInputType.number.index
                  ? [providerNumericFormatter]
                  : null,
              textInputAction: onSubmitted == null
                  ? TextInputAction.next
                  : TextInputAction.done,
              onChanged: onChanged,
              onSubmitted: onSubmitted,
              style: webText(
                context,
                size: 16,
                weight: FontWeight.w500,
                color: 'text.secondary',
              ).copyWith(height: 18 / 16),
              decoration: InputDecoration(
                hintText: hint,
                hintStyle: webText(
                  context,
                  size: 16,
                  weight: FontWeight.w500,
                  color: 'text.muted',
                ).copyWith(height: 18 / 16, overflow: TextOverflow.clip),
                filled: true,
                fillColor: colors['web.bg-subtle'],
                isDense: true,
                constraints: const BoxConstraints(minHeight: 40, maxHeight: 40),
                contentPadding: EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: ((40 - lineHeight) / 2).clamp(0.0, 20.0),
                ),
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
                  borderSide: BorderSide(color: colors['accent.default']),
                ),
                disabledBorder: OutlineInputBorder(
                  gapPadding: 0,
                  borderRadius: BorderRadius.circular(12),
                  borderSide: BorderSide.none,
                ),
              ),
            ),
          ),
          if (validationError != null)
            AssistantParagraph(validationError!, error: true, live: true),
        ],
      ),
    );
  }
}

class _DetailsMarker extends CustomPainter {
  const _DetailsMarker(this.expanded, this.color);
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
    canvas.drawPath(path..close(), Paint()..color = color);
  }

  @override
  bool shouldRepaint(_DetailsMarker oldDelegate) =>
      expanded != oldDelegate.expanded || color != oldDelegate.color;
}
