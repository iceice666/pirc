import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/web_controls.dart';
import 'package:pirc_mobile/live/workspace_page.dart';
import 'package:pirc_mobile/live/workspace_settings.dart';

import '../../test/live_test.dart' show theme;
import 'capture_workspace_matrix_test.dart' show WorkspaceMatrixGateway;

final fixture = obj(
  jsonDecode(
    File(
      '../../fixtures/mobile-parity/workspace-settings-states.json',
    ).readAsStringSync(),
  ),
);
final measurements = <Json>[];
final outputDirectory = Directory('build/parity/workspace-settings-states');

class _HeldRequest {
  final started = Completer<void>();
  final release = Completer<String>();
}

class _WorkspaceStateRun {
  _WorkspaceStateRun(this.state, this.gateway);

  final Json state;
  final WorkspaceMatrixGateway gateway;
  final receipts = <Json>[];
  final sequenceIndexes = <String, int>{};
  final unexpected = <Json>[];
  _HeldRequest? held;
  int pending = 0;
  bool holdUsed = false;

  Future<dynamic> handle(String method, Json args) async {
    if (method != 'request') return gateway.normal(method, args);
    pending++;
    try {
      final path = '${args['path'] ?? ''}';
      final httpMethod = '${args['method'] ?? 'GET'}'.toUpperCase();
      final match = RegExp(
        r'^/api/workspaces/([^/]+)/(instructions|capabilities|project-config|project-trust)$',
      ).firstMatch(path);
      if (match == null) {
        return gateway.normal(method, args);
      }

      final workspaceId = Uri.decodeComponent(match.group(1)!);
      final endpoint = match.group(2)!;
      if (workspaceId != state['workspaceId']) {
        final receipt = <String, dynamic>{
          'method': httpMethod,
          'path': path,
          'endpoint': endpoint,
          'status': 500,
          'unexpected': true,
        };
        receipts.add(receipt);
        unexpected.add(receipt);
        throw PlatformException(
          code: 'HTTP_500',
          message: 'Unexpected workspace settings scope',
        );
      }

      final key = '$httpMethod $endpoint';
      final index = sequenceIndexes[key] ?? 0;
      sequenceIndexes[key] = index + 1;
      final aliases = (obj(state['sequences'])[key] as List?) ?? const [];
      var alias = index < aliases.length
          ? '${aliases[index]}'
          : _defaultAlias(httpMethod, endpoint);
      final hold = obj(state['hold']);
      if (!holdUsed &&
          hold['method'] == httpMethod &&
          hold['endpoint'] == endpoint) {
        holdUsed = true;
        final gate = _HeldRequest();
        held = gate;
        final receipt = <String, dynamic>{
          'method': httpMethod,
          'path': path,
          'endpoint': endpoint,
          'held': true,
          if (args['body'] is Map) 'body': obj(args['body']),
        };
        receipts.add(receipt);
        gate.started.complete();
        alias = await gate.release.future;
        final descriptor = obj(obj(fixture['responses'])[alias]);
        receipt['responseAlias'] = alias;
        receipt['status'] = descriptor['status'];
        return _response(descriptor);
      }

      final descriptor = obj(obj(fixture['responses'])[alias]);
      final receipt = <String, dynamic>{
        'method': httpMethod,
        'path': path,
        'endpoint': endpoint,
        'responseAlias': alias,
        'status': descriptor['status'],
        if (args['body'] is Map) 'body': obj(args['body']),
      };
      receipts.add(receipt);
      return _response(descriptor);
    } finally {
      pending--;
    }
  }

  dynamic _response(Json descriptor) {
    final status = (descriptor['status'] as num?)?.toInt() ?? 500;
    final body = obj(descriptor['body']);
    if (status >= 400) {
      final error = obj(body['error']);
      throw PlatformException(
        code: 'HTTP_$status',
        message: '${error['message'] ?? 'Request failed ($status)'}',
        details: body,
      );
    }
    return body;
  }

  String _defaultAlias(String method, String endpoint) =>
      switch ((method, endpoint)) {
        ('GET', 'instructions') => 'instructions',
        ('PATCH', 'instructions') => 'instructionsSaved',
        ('GET', 'capabilities') => 'capabilities',
        ('PATCH', 'capabilities') => 'capabilitiesSaved',
        ('GET', 'project-config') => 'projectUntrusted',
        ('POST', 'project-trust') => 'projectTrusted',
        _ => 'unavailable',
      };

  int requestCount(String method, String endpoint) => receipts
      .where((row) => row['method'] == method && row['endpoint'] == endpoint)
      .length;

  Future<void> dispose() async {
    await gateway.stream.close();
  }
}

Map<String, dynamic> _rect(Rect rect) => {
  'x': _round(rect.left),
  'y': _round(rect.top),
  'width': _round(rect.width),
  'height': _round(rect.height),
  'right': _round(rect.right),
  'bottom': _round(rect.bottom),
};

double _round(double value) => (value * 100).roundToDouble() / 100;

String _textStyleColor(Color? color) => color?.toString() ?? '';

Map<String, dynamic> _style(TextStyle? own, Element element) {
  final inherited = element.findAncestorWidgetOfExactType<DefaultTextStyle>();
  final style = (inherited?.style ?? const TextStyle()).merge(own);
  final size = style.fontSize;
  return {
    'fontFamily': style.fontFamily,
    'fontFamilyFallback': style.fontFamilyFallback,
    'fontSize': size,
    'scaledFontSize': size == null
        ? null
        : MediaQuery.textScalerOf(element).scale(size),
    'fontWeight': style.fontWeight?.value,
    'height': style.height,
    'letterSpacing': style.letterSpacing,
    'color': _textStyleColor(style.color),
  };
}

String _plainText(Widget widget) => switch (widget) {
  Text(:final data?) => data,
  Text(:final textSpan?) => textSpan.toPlainText(),
  RichText(:final text) => text.toPlainText(),
  _ => '',
};

Future<void> _loadParityFonts() async {
  final manifest = jsonDecode(await rootBundle.loadString('FontManifest.json'));
  for (final entry in manifest as List) {
    final loader = FontLoader(entry['family'] as String);
    for (final font in entry['fonts'] as List) {
      loader.addFont(rootBundle.load(font['asset'] as String));
    }
    await loader.load();
  }
  for (final (family, path) in [
    ('Roboto', '/System/Library/Fonts/SFNS.ttf'),
    ('monospace', '/System/Library/Fonts/SFNSMono.ttf'),
  ]) {
    await (FontLoader(
      family,
    )..addFont(File(path).readAsBytes().then(ByteData.sublistView))).load();
  }
}

Future<void> _waitFor(
  WidgetTester tester,
  bool Function() condition, {
  String reason = 'condition did not become true',
}) async {
  for (var i = 0; i < 240; i++) {
    if (condition()) return;
    await tester.pump(const Duration(milliseconds: 25));
  }
  expect(condition(), isTrue, reason: reason);
}

Future<void> _waitIdle(WidgetTester tester, _WorkspaceStateRun run) async {
  await _waitFor(
    tester,
    () => run.pending == 0 && run.held == null,
    reason: 'workspace settings requests did not become idle',
  );
  await tester.pumpAndSettle();
}

Future<void> _capturePng(
  WidgetTester tester,
  GlobalKey boundaryKey,
  String name,
) async {
  await tester.runAsync(() async {
    final context = boundaryKey.currentContext;
    if (context == null) throw StateError('Missing capture boundary for $name');
    final boundary = context.findRenderObject()! as RenderRepaintBoundary;
    final image = await boundary.toImage(pixelRatio: 1);
    try {
      final data = await image.toByteData(format: ui.ImageByteFormat.png);
      outputDirectory.createSync(recursive: true);
      File(
        '${outputDirectory.path}/$name.png',
      ).writeAsBytesSync(data!.buffer.asUint8List());
    } finally {
      image.dispose();
    }
  });
}

Json _snapshot(WidgetTester tester, Finder settings, Finder scrollable) {
  final textRows = <Json>[];
  final textFinder = find.descendant(
    of: settings,
    matching: find.byWidgetPredicate(
      (widget) => widget is Text || widget is RichText,
    ),
  );
  for (final (index, element) in textFinder.evaluate().indexed) {
    final widget = element.widget;
    final text = _plainText(widget).trim();
    if (text.isEmpty) continue;
    final style = switch (widget) {
      Text(:final style) => _style(style, element),
      RichText(:final text) => _style(text.style, element),
      _ => <String, dynamic>{},
    };
    textRows.add({
      'index': index,
      'text': text,
      'rect': _rect(tester.getRect(textFinder.at(index))),
      'style': style,
    });
  }

  final textFields = <Json>[];
  for (final (index, element)
      in find
          .descendant(of: settings, matching: find.byType(TextField))
          .evaluate()
          .indexed) {
    final field = element.widget as TextField;
    textFields.add({
      'index': index,
      'key': field.key?.toString(),
      'value': field.controller?.text ?? '',
      'enabled': field.enabled ?? true,
      'readOnly': field.readOnly,
      'rect': _rect(
        tester.getRect(
          find
              .descendant(of: settings, matching: find.byType(TextField))
              .at(index),
        ),
      ),
      'style': _style(field.style, element),
    });
  }

  final checkboxes = <Json>[];
  for (final (index, element)
      in find
          .descendant(of: settings, matching: find.byType(Checkbox))
          .evaluate()
          .indexed) {
    final checkbox = element.widget as Checkbox;
    final finder = find
        .descendant(of: settings, matching: find.byType(Checkbox))
        .at(index);
    checkboxes.add({
      'index': index,
      'key': checkbox.key?.toString(),
      'value': checkbox.value,
      'enabled': checkbox.onChanged != null,
      'rect': _rect(tester.getRect(finder)),
    });
  }

  final buttons = <Json>[];
  for (final (index, element)
      in find
          .descendant(
            of: settings,
            matching: find.byWidgetPredicate((widget) => widget is WebButton),
          )
          .evaluate()
          .indexed) {
    final button = element.widget as WebButton;
    final finder = find
        .descendant(
          of: settings,
          matching: find.byWidgetPredicate((widget) => widget is WebButton),
        )
        .at(index);
    buttons.add({
      'index': index,
      'label': button.label,
      'enabled': button.onPressed != null,
      'primary': button.primary,
      'rect': _rect(tester.getRect(finder)),
    });
  }

  final semantics = <Json>[];
  final semanticsFinder = find.descendant(
    of: settings,
    matching: find.byType(Semantics),
  );
  for (final (index, _) in semanticsFinder.evaluate().indexed) {
    try {
      final data = tester
          .getSemantics(semanticsFinder.at(index))
          .getSemanticsData();
      if (data.role == SemanticsRole.status ||
          data.role == SemanticsRole.alert) {
        semantics.add({
          'index': index,
          'role': data.role.toString(),
          'text': data.label,
          'value': data.value,
          'rect': _rect(tester.getRect(semanticsFinder.at(index))),
        });
      }
    } catch (_) {
      // A Semantics widget can be merged into its ancestor; record emitted
      // roles only when Flutter exposes a distinct node for it.
    }
  }

  final scrollPosition = tester.state<ScrollableState>(scrollable).position;
  final allText = [
    ...textRows.map((row) => '${row['text']}'),
    ...textFields.map((row) => '${row['value']}'),
  ].join('\n');
  final controls = <Json>[
    for (final field in textFields)
      {
        'tag': 'textarea',
        'type': 'textarea',
        'label': 'Instructions',
        'disabled': !(field['enabled'] as bool),
        'effectiveDisabled': !(field['enabled'] as bool),
        'value': field['value'],
        'rect': field['rect'],
        'style': field['style'],
      },
    for (final checkbox in checkboxes)
      {
        'tag': 'input',
        'type': 'checkbox',
        'label': const [
          'Delegation',
          'Memory search',
          'Remote recall',
          'Schedules',
          'Web search',
        ][checkbox['index'] as int],
        'disabled': !(checkbox['enabled'] as bool),
        'effectiveDisabled': !(checkbox['enabled'] as bool),
        'checked': checkbox['value'],
        'rect': checkbox['rect'],
      },
    for (final button in buttons)
      {
        'tag': 'button',
        'type': 'button',
        'label': button['label'],
        'disabled': !(button['enabled'] as bool),
        'effectiveDisabled': !(button['enabled'] as bool),
        'rect': button['rect'],
      },
  ];
  return {
    'settingsText': allText,
    'statuses': semantics
        .where((row) => row['role'] == 'SemanticsRole.status')
        .map((row) => {'text': row['text'], 'rect': row['rect']})
        .toList(),
    'alerts': semantics
        .where((row) => row['role'] == 'SemanticsRole.alert')
        .map((row) => {'text': row['text'], 'rect': row['rect']})
        .toList(),
    'semantics': semantics,
    'text': textRows,
    'textFields': textFields,
    'checkboxes': checkboxes,
    'buttons': buttons,
    'controls': controls,
    'scroll': {
      'offset': _round(scrollPosition.pixels),
      'viewport': _round(scrollPosition.viewportDimension),
      'maxExtent': _round(scrollPosition.maxScrollExtent),
      'contentExtent': _round(
        scrollPosition.extentInside + scrollPosition.maxScrollExtent,
      ),
    },
    'settingsRect': _rect(tester.getRect(settings)),
  };
}

void _assertStage(
  Json state,
  String stage,
  Json capture,
  _WorkspaceStateRun run,
) {
  final expected = obj(state['expect']);
  final top = obj(capture['top']);
  final bottom = obj(capture['bottom']);
  final settingsText = '${top['settingsText'] ?? ''}';
  final statuses = [...rows(top['statuses']), ...rows(bottom['statuses'])];
  final alerts = [...rows(top['alerts']), ...rows(bottom['alerts'])];
  final statusText = statuses.map((row) => '${row['text']}').join(' | ');
  final alertText = alerts.map((row) => '${row['text']}').join(' | ');
  final fields = rows(top['textFields']);
  final buttons = rows(top['buttons']);
  final checkboxes = rows(top['checkboxes']);

  if (expected['stage'] == stage && expected['status'] != null) {
    final message = '${expected['status']}';
    expect(
      '$statusText\n$settingsText',
      contains(message),
      reason: '${state['id']}/$stage should expose status $message',
    );
  }
  if (expected['error'] != null && stage == (expected['stage'] ?? 'error')) {
    expect(
      alertText,
      contains('${expected['error']}'),
      reason: '${state['id']}/$stage alert',
    );
  }
  if (expected['recovered'] != null && stage == 'recovered') {
    final recovered = '${expected['recovered']}';
    expect(
      fields.any((field) => field['value'] == recovered) ||
          settingsText.contains(recovered),
      isTrue,
      reason: '${state['id']} recovered settings content',
    );
  }
  if (expected['text'] != null && stage == 'final') {
    expect(settingsText, contains('${expected['text']}'));
  }
  if (expected['trustButtons'] != null && stage == 'final') {
    expect(
      buttons.where((button) => button['label'] == 'Trust').length,
      expected['trustButtons'],
    );
  }
  if (expected['revokeButtons'] != null && stage == 'final') {
    expect(
      buttons.where((button) => button['label'] == 'Revoke trust').length,
      expected['revokeButtons'],
    );
  }
  if (expected['trustDisabled'] != null &&
      stage == (expected['stage'] ?? 'error')) {
    final trust = buttons.where((button) => button['label'] == 'Trust');
    expect(trust, isNotEmpty);
    expect(trust.first['enabled'], expected['trustDisabled'] == false);
  }
  if (expected['fieldsetDisabled'] == true && stage == 'saving') {
    expect(checkboxes, isNotEmpty);
    expect(
      checkboxes.every((checkbox) => checkbox['enabled'] == false),
      isTrue,
    );
  }
  if (state['id'] == 'instructions-saving' && stage == 'saving') {
    expect(fields.single['enabled'], isFalse);
    expect(buttons.where((button) => button['label'] == 'Saving…'), isNotEmpty);
    expect(buttons.where((button) => button['label'] == 'Save'), isEmpty);
  }
  if (state['id'] == 'instructions-save-error' && stage == 'error') {
    expect(fields.single['value'], 'Updated project instructions.');
    expect(
      buttons.any((button) => button['label'] == 'Save' && button['enabled']),
      isTrue,
    );
  }
  if (state['id'] == 'trust-saving' && stage == 'saving') {
    expect(
      buttons.firstWhere((button) => button['label'] == 'Trust')['enabled'],
      isFalse,
    );
  }
  if (state['id'] == 'trust-409' && stage == 'final') {
    expect(alertText, contains('${expected['error']}'));
    expect(
      run.requestCount('GET', 'project-config'),
      expected['projectConfigGets'],
    );
    expect(run.requestCount('POST', 'project-trust'), 1);
  }
  if (state['id'] == 'directory-offline' && stage == 'final') {
    expect(settingsText, contains("workspace's node is offline"));
    expect(
      run.requestCount('GET', 'project-config'),
      expected['projectConfigRequests'],
    );
  }
}

void main() {
  setUpAll(_loadParityFonts);

  for (final state in rows(fixture['states'])) {
    for (final width in fixture['widths'] as List) {
      for (final themeName in fixture['themes'] as List) {
        for (final scale in fixture['textScales'] as List) {
          final id = '${state['id']}-$width-$themeName-text$scale';
          testWidgets('workspace settings state $id', (tester) async {
            tester.view.devicePixelRatio = 1;
            tester.view.physicalSize = Size((width as num).toDouble(), 900);
            tester.view.padding = FakeViewPadding.zero;
            tester.view.viewInsets = FakeViewPadding.zero;
            tester.platformDispatcher.textScaleFactorTestValue = (scale as num)
                .toDouble();
            tester.platformDispatcher.platformBrightnessTestValue =
                themeName == 'dark' ? Brightness.dark : Brightness.light;
            addTearDown(tester.view.reset);
            addTearDown(
              tester.platformDispatcher.clearTextScaleFactorTestValue,
            );
            addTearDown(
              tester.platformDispatcher.clearPlatformBrightnessTestValue,
            );
            final semanticsHandle = tester.ensureSemantics();

            final stateFixture = <String, dynamic>{
              ...fixture,
              'sessions': const <dynamic>[],
              'models': const <dynamic>[],
              'captureTheme': themeName,
              if (state['nodes'] == 'home-only')
                'nodes': rows(
                  fixture['nodes'],
                ).where((node) => node['id'] == 'home').toList(),
            };
            final gateway = WorkspaceMatrixGateway(stateFixture);
            final run = _WorkspaceStateRun(state, gateway);
            gateway.handler = run.handle;
            final controller = LiveController(gateway);
            final boundaryKey = GlobalKey();
            await tester.pumpWidget(
              RepaintBoundary(
                key: boundaryKey,
                child: MobileApp(theme: theme, controller: controller),
              ),
            );
            await tester.pumpAndSettle();
            if (find
                .byTooltip('Back to the list')
                .hitTestable()
                .evaluate()
                .isNotEmpty) {
              await tester.tap(find.byTooltip('Back to the list'));
              await tester.pumpAndSettle();
            }
            final workspace = rows(
              fixture['workspaces'],
            ).firstWhere((item) => item['id'] == state['workspaceId']);
            final modeLabel = workspace['kind'] == 'chat' ? 'Chat' : 'Work';
            final mode = find.text(modeLabel).hitTestable();
            expect(
              mode,
              findsWidgets,
              reason: '$id should expose $modeLabel mode',
            );
            await tester.tap(mode.first);
            await tester.pumpAndSettle();
            await tester.tap(
              find.text('${workspace['displayName']}').hitTestable().first,
            );
            await tester.pumpAndSettle();
            final page = find.byType(WorkspacePage);
            expect(
              page,
              findsOneWidget,
              reason: '$id should open workspace page',
            );
            await tester.tap(
              find
                  .descendant(of: page, matching: find.text('Settings'))
                  .hitTestable()
                  .first,
            );
            await tester.pumpAndSettle();
            final settings = find.byType(WorkspaceSettings);
            expect(settings, findsOneWidget, reason: '$id settings UI');
            final scrollView = find
                .descendant(
                  of: page,
                  matching: find.byType(SingleChildScrollView),
                )
                .first;
            final scrollable = find
                .descendant(of: scrollView, matching: find.byType(Scrollable))
                .first;
            final snapshots = <Json>[];

            Future<Json> captureStage(String stage) async {
              await tester.pumpAndSettle();
              final position = tester
                  .state<ScrollableState>(scrollable)
                  .position;
              final revealScrollTop = position.pixels;
              position.jumpTo(0);
              await tester.pumpAndSettle();
              final top = _snapshot(tester, settings, scrollable);
              await _capturePng(tester, boundaryKey, '$id-native-$stage-top');
              position.jumpTo(position.maxScrollExtent);
              await tester.pumpAndSettle();
              final bottom = _snapshot(tester, settings, scrollable);
              await _capturePng(
                tester,
                boundaryKey,
                '$id-native-$stage-bottom',
              );
              final capture = <String, dynamic>{
                'stage': stage,
                'revealScrollTop': revealScrollTop,
                'top': top,
                'bottom': bottom,
                'screenshot': {
                  'top':
                      'build/parity/workspace-settings-states/$id-native-$stage-top.png',
                  'bottom':
                      'build/parity/workspace-settings-states/$id-native-$stage-bottom.png',
                },
                'apiReceipts': run.receipts
                    .map((row) => Map<String, dynamic>.of(row))
                    .toList(),
              };
              _assertStage(state, stage, capture, run);
              snapshots.add(capture);
              return capture;
            }

            Future<void> tapSettingsButton(String label) async {
              final button = find.descendant(
                of: settings,
                matching: find.byWidgetPredicate(
                  (widget) => widget is WebButton && widget.label == label,
                ),
              );
              expect(button, findsOneWidget, reason: '$id button $label');
              await tester.ensureVisible(button);
              await tester.pumpAndSettle();
              await tester.tap(button.hitTestable());
              await tester.pumpAndSettle();
            }

            for (final step in rows(state['flow'])) {
              switch (step['type']) {
                case 'waitIdle':
                  await _waitIdle(tester, run);
                case 'waitHeld':
                  await _waitFor(
                    tester,
                    () => run.held?.started.isCompleted == true,
                    reason: '$id expected held request',
                  );
                  if (step['withOtherSettingsLoaded'] == true) {
                    await _waitFor(
                      tester,
                      () =>
                          run.requestCount('GET', 'capabilities') > 0 &&
                          run.pending == 1,
                      reason:
                          '$id capabilities should load while instructions wait',
                    );
                  }
                case 'waitRequests':
                  final endpoint = '${step['endpoint']}';
                  final count = (step['count'] as num).toInt();
                  await _waitFor(
                    tester,
                    () =>
                        run.requestCount('GET', endpoint) >= count &&
                        run.pending == 0,
                    reason: '$id expected $count GET $endpoint requests',
                  );
                  await tester.pumpAndSettle();
                case 'releaseHeld':
                  final held = run.held;
                  expect(
                    held,
                    isNotNull,
                    reason: '$id no held request to release',
                  );
                  held!.release.complete(
                    '${step['releaseResponse'] ?? obj(state['hold'])['releaseResponse']}',
                  );
                  run.held = null;
                  await tester.pumpAndSettle();
                case 'fillInstructions':
                  final field = find.byKey(
                    const ValueKey('workspace-instructions-text'),
                  );
                  expect(
                    field,
                    findsOneWidget,
                    reason: '$id instructions editor',
                  );
                  await tester.ensureVisible(field);
                  await tester.pumpAndSettle();
                  await tester.enterText(field, '${step['text']}');
                  tester.testTextInput.hide();
                  await tester.pumpAndSettle();
                case 'clickFirstSwitch':
                  final toggle = find.byKey(
                    const ValueKey('capability-checkbox-delegation'),
                  );
                  expect(
                    toggle,
                    findsOneWidget,
                    reason: '$id capability switch',
                  );
                  await tester.ensureVisible(toggle);
                  await tester.pumpAndSettle();
                  await tester.tap(toggle.hitTestable());
                  await tester.pumpAndSettle();
                case 'click':
                  final target = '${step['target']}';
                  await tapSettingsButton(target);
                case 'capture':
                  await captureStage('${step['stage']}');
                default:
                  throw StateError('$id unknown flow step ${step['type']}');
              }
              expect(
                tester.takeException(),
                isNull,
                reason: '$id ${step['type']}',
              );
            }

            expect(snapshots, isNotEmpty, reason: '$id has no captures');
            expect(run.unexpected, isEmpty, reason: '$id unexpected requests');
            expect(
              run.pending,
              0,
              reason: '$id pending requests after workflow',
            );
            expect(run.held, isNull, reason: '$id held request after workflow');
            measurements.add({
              'id': id,
              'state': state['id'],
              'workspaceId': state['workspaceId'],
              'width': width,
              'height': 900,
              'theme': themeName,
              'textScale': scale,
              'stages': snapshots,
              'finalApiReceipts': run.receipts,
              'unexpectedRequests': run.unexpected,
            });

            await tester.pumpWidget(const SizedBox());
            semanticsHandle.dispose();
            await run.dispose();
          });
        }
      }
    }
  }

  tearDownAll(() {
    outputDirectory.createSync(recursive: true);
    File('${outputDirectory.path}/native-measurements.json').writeAsStringSync(
      const JsonEncoder.withIndent('  ').convert({
        'fixture': 'fixtures/mobile-parity/workspace-settings-states.json',
        'webRevision': fixture['webRevision'],
        'capturedAt': DateTime.now().toUtc().toIso8601String(),
        'capture': {
          'shell':
              'Actual MobileApp and WorkspaceSettings UI with deterministic local FakeGateway responses.',
          'font':
              'Bundled FontManifest plus macOS SFNS/SFNSMono aliases for visual comparison.',
          'devicePixelRatio': 1,
          'safeArea': 'Zero padding; zero IME insets.',
          'widths': fixture['widths'],
          'themes': fixture['themes'],
          'textScales': fixture['textScales'],
        },
        'cases': measurements,
      }),
    );
  });
}
