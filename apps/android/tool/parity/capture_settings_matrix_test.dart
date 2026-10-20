import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/settings_dialog.dart';

import '../../test/live_test.dart' show FakeGateway, theme;
import 'capture_fonts.dart';

const _captureTabs = ['General', 'Memory', 'Models', 'Devices', 'About'];
const _tabHeading = {
  'General': 'SESSIONS',
  'Memory': 'MEMORY',
  'Models': 'MODEL BACKENDS',
  'Devices': 'NODES',
  'About': 'THIS BROWSER',
};

const _providers403 = 'Device tokens cannot reach this route';
const _devices403 = 'Device tokens cannot manage devices';
const _providersVisibleError =
    'Backend request failed (403). Check your settings and try again.';

Map<String, dynamic> _object(dynamic value) => value is Map
    ? value.map((key, value) => MapEntry('$key', value))
    : <String, dynamic>{};

Map<String, double> _rect(WidgetTester tester, Finder finder) {
  final value = tester.getRect(finder);
  return {
    'x': value.left,
    'y': value.top,
    'width': value.width,
    'height': value.height,
  };
}

Map<String, double>? _optionalRect(WidgetTester tester, Finder finder) =>
    finder.evaluate().isEmpty ? null : _rect(tester, finder.first);

Map<String, double>? _unionRects(Iterable<Map<String, double>?> values) {
  final rects = values.whereType<Map<String, double>>().toList();
  if (rects.isEmpty) return null;
  final left = rects.map((rect) => rect['x']!).reduce((a, b) => a < b ? a : b);
  final top = rects.map((rect) => rect['y']!).reduce((a, b) => a < b ? a : b);
  final right = rects
      .map((rect) => rect['x']! + rect['width']!)
      .reduce((a, b) => a > b ? a : b);
  final bottom = rects
      .map((rect) => rect['y']! + rect['height']!)
      .reduce((a, b) => a > b ? a : b);
  return {'x': left, 'y': top, 'width': right - left, 'height': bottom - top};
}

String _plainText(Widget widget) {
  if (widget is Text) {
    return (widget.data ?? widget.textSpan?.toPlainText() ?? '')
        .replaceAll(RegExp(r'\s+'), ' ')
        .trim();
  }
  if (widget is SelectableText) {
    return (widget.data ?? widget.textSpan?.toPlainText() ?? '')
        .replaceAll(RegExp(r'\s+'), ' ')
        .trim();
  }
  return '';
}

String _visibleSpanText(InlineSpan span) {
  if (span is TextSpan) {
    return '${span.text ?? ''}${(span.children ?? const <InlineSpan>[]).map(_visibleSpanText).join()}';
  }
  if (span is WidgetSpan &&
      span.child is SizedBox &&
      (span.child as SizedBox).height == 0 &&
      (span.child as SizedBox).child == null) {
    // This concrete spacer has no painted/semantic text. Keep the raw string
    // separately, because paragraph geometry still counts its placeholder.
    return '';
  }
  return span.toPlainText();
}

Map<String, dynamic> _textRecord(WidgetTester tester, Finder finder) {
  final element = finder.evaluate().single;
  final widget = element.widget;
  final text = _plainText(widget);
  final style = widget is Text
      ? widget.style
      : widget is SelectableText
      ? widget.style
      : null;
  final spanStyle = widget is Text
      ? widget.textSpan?.style
      : widget is SelectableText
      ? widget.textSpan?.style
      : null;
  final inherited = DefaultTextStyle.of(element).style;
  final effective = inherited.merge(style).merge(spanStyle);
  return {
    'text': text.length > 180 ? '${text.substring(0, 177)}...' : text,
    'rawFullText': text,
    'fullText': switch (widget) {
      Text(textSpan: final InlineSpan span) => _visibleSpanText(span),
      SelectableText(textSpan: final InlineSpan span) => _visibleSpanText(span),
      _ => text,
    },
    ..._rect(tester, finder),
    'fontFamily': effective.fontFamily,
    'fontSize': effective.fontSize,
    'fontWeight': effective.fontWeight?.value,
    'lineHeight': effective.height,
    'color': effective.color == null
        ? null
        : '#${effective.color!.toARGB32().toRadixString(16).padLeft(8, '0')}',
  };
}

Finder _contentScrollFinder(WidgetTester tester, String tab) {
  final heading = find.text(_tabHeading[tab]!, skipOffstage: true).first;
  return find
      .ancestor(of: heading, matching: find.byType(SingleChildScrollView))
      .first;
}

ScrollController _contentScrollController(WidgetTester tester, String tab) {
  final scroll = _contentScrollFinder(tester, tab);
  return tester.widget<SingleChildScrollView>(scroll).controller!;
}

Future<void> _setContentScrollOffset(
  WidgetTester tester,
  String tab,
  double value,
) async {
  final controller = _contentScrollController(tester, tab);
  if (controller.hasClients) {
    controller.jumpTo(
      value.clamp(0, controller.position.maxScrollExtent).toDouble(),
    );
    await tester.pump();
  }
}

Future<void> _writePng(
  WidgetTester tester,
  GlobalKey captureKey,
  String path,
) async {
  await tester.runAsync(() async {
    final image =
        await (captureKey.currentContext!.findRenderObject()!
                as RenderRepaintBoundary)
            .toImage(pixelRatio: 1);
    final data = await image.toByteData(format: ui.ImageByteFormat.png);
    File(path).writeAsBytesSync(data!.buffer.asUint8List());
    image.dispose();
  });
}

Future<Map<String, dynamic>> _captureMemorySupplemental(
  WidgetTester tester,
  GlobalKey captureKey,
  Directory outputDirectory,
  FakeGateway gateway,
  int expectedHistoryVersions,
) async {
  await _setContentScrollOffset(tester, 'Memory', 0);
  final removed = find.textContaining('Removed ·').first;
  await tester.ensureVisible(removed);
  await tester.pumpAndSettle();
  await tester.tap(removed);
  await tester.pumpAndSettle();

  final history = find.widgetWithText(TextButton, 'History').first;
  await tester.ensureVisible(history);
  await tester.pumpAndSettle();
  await tester.tap(history);
  await tester.pumpAndSettle();
  final historyException = tester.takeException();
  expect(historyException, isNull);

  const historyPath = '/api/memory/entries/user-response-style/history';
  final historyCalls = gateway.calls
      .where((call) => call.$1 == 'request' && call.$2['path'] == historyPath)
      .toList();
  expect(historyCalls, hasLength(1));
  expect(expectedHistoryVersions, 3);
  await _writePng(
    tester,
    captureKey,
    '${outputDirectory.path}/memory-history.png',
  );
  final historyState = _captureVisibleContent(tester, 'Memory');

  final controller = _contentScrollController(tester, 'Memory');
  expect(controller.hasClients, isTrue);
  final bottomOffset = controller.position.maxScrollExtent;
  await _setContentScrollOffset(tester, 'Memory', bottomOffset);
  await tester.pumpAndSettle();
  await _writePng(
    tester,
    captureKey,
    '${outputDirectory.path}/memory-bottom.png',
  );
  final bottomState = _captureVisibleContent(tester, 'Memory');

  return {
    'history': {
      ...historyState,
      'historyOpen': true,
      'historyItems': expectedHistoryVersions,
      'removedDetailsOpen': true,
    },
    'bottom': {
      ...bottomState,
      'historyOpen': true,
      'historyItems': expectedHistoryVersions,
      'removedDetailsOpen': true,
    },
    'historyApiRequests': [
      for (final call in historyCalls)
        {'method': call.$2['method'] ?? 'GET', 'path': call.$2['path']},
    ],
    'historyVersionCount': expectedHistoryVersions,
    'removedSectionExpanded': true,
    'historyCapture': 'memory-history.png',
    'bottomCapture': 'memory-bottom.png',
  };
}

Map<String, dynamic> _captureVisibleContent(WidgetTester tester, String tab) {
  final dialog = find.byType(NativeSettingsDialog);
  final scroll = _contentScrollFinder(tester, tab);
  final scrollWidget = tester.widget<SingleChildScrollView>(scroll);
  final scrollController = scrollWidget.controller;
  final textFinder = find.descendant(
    of: scroll,
    matching: find.byWidgetPredicate(
      (widget) => widget is Text || widget is SelectableText,
    ),
  );
  final texts = <Map<String, dynamic>>[];
  for (var index = 0; index < textFinder.evaluate().length; index++) {
    final finder = textFinder.at(index);
    final record = _textRecord(tester, finder);
    if (record['text'] != '') texts.add(record);
  }
  final headings = texts.where((record) {
    final value = '${record['text']}';
    return value == value.toUpperCase() && RegExp('[A-Z]').hasMatch(value);
  }).toList();
  final paragraphs = texts
      .where((record) => '${record['text']}'.length >= 48)
      .toList();

  final fieldFinder = find.descendant(
    of: scroll,
    matching: find.byType(TextField),
  );
  final fields = <Map<String, dynamic>>[];
  for (var index = 0; index < fieldFinder.evaluate().length; index++) {
    final finder = fieldFinder.at(index);
    final field = tester.widget<TextField>(finder);
    final key = field.key is ValueKey ? (field.key! as ValueKey).value : null;
    final style = field.style;
    fields.add({
      'key': key?.toString(),
      ..._rect(tester, finder),
      'fontFamily': style?.fontFamily,
      'fontSize': style?.fontSize,
      'enabled': field.enabled ?? true,
      'readOnly': field.readOnly,
      'maxLines': field.maxLines,
      'minLines': field.minLines,
      'value': field.controller?.text,
    });
  }

  final actionFinder = find.descendant(
    of: dialog,
    matching: find.byWidgetPredicate(
      (widget) => widget is TextButton || widget is IconButton,
    ),
  );
  final actions = <Map<String, dynamic>>[];
  for (var index = 0; index < actionFinder.evaluate().length; index++) {
    final finder = actionFinder.at(index);
    final button = tester.widget(finder);
    final label = button is IconButton
        ? button.tooltip
        : find
              .descendant(of: finder, matching: find.byType(Text))
              .evaluate()
              .map((element) => (element.widget as Text).data ?? '')
              .join(' ')
              .replaceAll(RegExp(r'\s+'), ' ')
              .trim();
    if (label == null ||
        label.isEmpty ||
        _captureTabs.contains(label) ||
        label == 'Close') {
      continue;
    }
    actions.add({
      'label': label,
      ..._rect(tester, finder),
      'enabled': button is TextButton
          ? button.onPressed != null
          : button is IconButton
          ? button.onPressed != null
          : null,
    });
  }

  return {
    'viewport': _rect(tester, scroll),
    'scroll': {
      'offset': scrollController?.hasClients == true
          ? scrollController!.offset
          : 0,
      'maxExtent': scrollController?.hasClients == true
          ? scrollController!.position.maxScrollExtent
          : 0,
      'viewportDimension': scrollController?.hasClients == true
          ? scrollController!.position.viewportDimension
          : 0,
    },
    'headings': headings,
    'paragraphs': paragraphs,
    'visibleText': texts,
    'textFields': fields,
    'actions': actions,
  };
}

Map<String, dynamic> _captureTab(
  WidgetTester tester,
  String tab,
  List<Map<String, dynamic>> requests,
  List<Map<String, dynamic>> forbiddenRequests,
  List<String> layoutErrors,
) {
  final dialog = find.byType(NativeSettingsDialog);
  final frame = find.byKey(const Key('settings-frame'));
  final tabRects = <String, Map<String, double>>{
    for (final label in settingsCategories)
      label: _rect(tester, find.byKey(ValueKey('settings-tab-$label'))),
  };
  final content = _captureVisibleContent(tester, tab);
  final close = find.byTooltip('Close');
  return {
    'tab': tab.toLowerCase(),
    'selectedHeading': _tabHeading[tab],
    'authorization': switch (tab) {
      'Models' => {
        'mode': 'read-only-denied',
        'status': 403,
        'api': '/api/providers',
        'requests': forbiddenRequests
            .where((request) => request['path'] == '/api/providers')
            .toList(),
        'webFixtureStatus': 200,
        'serverMessage': _providers403,
        'visibleMessage': _providersVisibleError,
        'note':
            'The shared Web response uses browser credentials; native paired-device credentials remain forbidden.',
      },
      'Devices' => {
        'mode': 'read-only-denied',
        'status': 403,
        'api': '/api/devices',
        'requests': forbiddenRequests
            .where((request) => request['path'] == '/api/devices')
            .toList(),
        'webFixtureStatus': 200,
        'serverMessage': _devices403,
        'visibleMessage': _devices403,
        'note':
            'The shared Web response uses browser credentials; native paired-device credentials remain forbidden.',
      },
      _ => {'mode': 'fixture-read-only'},
    },
    'layoutErrors': layoutErrors,
    'frame': _rect(tester, frame),
    'header': {
      'brand': _optionalRect(
        tester,
        find.descendant(of: dialog, matching: find.text('pirc')),
      ),
      'title': _optionalRect(
        tester,
        find.descendant(of: dialog, matching: find.text('Settings')),
      ),
      'close': _optionalRect(tester, close),
      'bounds': _unionRects([
        _optionalRect(
          tester,
          find.descendant(of: dialog, matching: find.text('pirc')),
        ),
        _optionalRect(
          tester,
          find.descendant(of: dialog, matching: find.text('Settings')),
        ),
        _optionalRect(tester, close),
      ]),
    },
    'nav': {'bounds': _unionRects(tabRects.values), 'tabs': tabRects},
    'content': content,
    'apiRequests': requests,
  };
}

void main() {
  final fixture = _object(
    jsonDecode(
      File(
        '../../fixtures/mobile-parity/settings-matrix.json',
      ).readAsStringSync(),
    ),
  );
  const smoke = bool.fromEnvironment('PARITY_SETTINGS_SMOKE');
  final fixtureWidths = (fixture['widths'] as List)
      .map((value) => (value as num).toInt())
      .toList();
  final widths = smoke ? [390, 768] : [390, 650, 651, 768, 860, 861, 1024];
  if (!widths.every(fixtureWidths.contains)) {
    throw StateError('settings-matrix.json is missing one of $widths');
  }
  final themes = (fixture['themes'] as List).cast<String>();
  final scales = (fixture['textScales'] as List)
      .map((value) => (value as num).toDouble())
      .toList();
  final height = (fixture['height'] as num).toDouble();

  for (final width in widths) {
    for (final themeName in themes) {
      for (final scale in scales) {
        testWidgets('settings matrix $width $themeName scale $scale', (
          tester,
        ) async {
          await tester.runAsync(loadParityFonts);
          debugDisableShadows = false;
          tester.view.devicePixelRatio = 1;
          tester.view.physicalSize = Size(width.toDouble(), height);
          addTearDown(tester.view.reset);
          addTearDown(() => debugDisableShadows = true);

          final gateway = FakeGateway();
          final forbiddenRequests = <Map<String, dynamic>>[];
          final controller = LiveController(gateway)
            ..clientId = '${fixture['clientId']}'
            ..nodes = (fixture['nodes'] as List).map(_object).toList()
            ..preferences = {'showSettled': false};
          gateway.handler = (method, args) async {
            if (method == 'permissions') return {'notifications': true};
            if (method == 'pushStatus') return {'code': 'off'};
            if (method != 'request') return null;
            final path = '${args['path']}';
            if (path == '/api/memory') return fixture['memory'];
            if (path == '/api/providers' || path == '/api/devices') {
              final message = path == '/api/providers'
                  ? _providers403
                  : _devices403;
              forbiddenRequests.add({
                'method': args['method'] ?? 'GET',
                'path': path,
                'status': 403,
                'code': 'forbidden',
                'message': message,
              });
              throw PlatformException(code: 'HTTP_403', message: message);
            }
            if (path == '/api/push') return fixture['push'];
            const historyPrefix = '/api/memory/entries/';
            const historySuffix = '/history';
            if (path.startsWith(historyPrefix) &&
                path.endsWith(historySuffix)) {
              final id = path.substring(
                historyPrefix.length,
                path.length - historySuffix.length,
              );
              final versions = _object(fixture['memoryHistory'])[id];
              return {'versions': versions ?? []};
            }
            return <String, dynamic>{};
          };

          final captureKey = GlobalKey();
          final brightness = themeName == 'dark'
              ? Brightness.dark
              : Brightness.light;
          await tester.pumpWidget(
            RepaintBoundary(
              key: captureKey,
              child: MaterialApp(
                debugShowCheckedModeBanner: false,
                theme: theme.build(brightness),
                builder: (context, child) => MediaQuery(
                  data: MediaQuery.of(
                    context,
                  ).copyWith(textScaler: TextScaler.linear(scale)),
                  child: child!,
                ),
                home: Scaffold(
                  body: Builder(
                    builder: (context) => TextButton(
                      key: const Key('open-settings'),
                      onPressed: () => showNativeSettings(
                        context,
                        controller: controller,
                        initialTab: 'General',
                        memoryClock: () => DateTime.fromMillisecondsSinceEpoch(
                          (fixture['now'] as num).toInt(),
                        ),
                        onResetLayout: () {},
                        onOpenChat: (_) {},
                        onAppOptions: () {},
                      ),
                      child: const Text('Open settings'),
                    ),
                  ),
                ),
              ),
            ),
          );
          await tester.tap(find.byKey(const Key('open-settings')));
          await tester.pumpAndSettle();

          final outputDirectory = Directory(
            'build/parity/settings-matrix-native/$width-$themeName-scale${scale.toStringAsFixed(0)}',
          )..createSync(recursive: true);
          final cases = <Map<String, dynamic>>[];
          Map<String, dynamic>? memorySupplemental;
          for (final tab in _captureTabs) {
            await tester.tap(find.byKey(ValueKey('settings-tab-$tab')));
            await tester.pumpAndSettle();
            await _setContentScrollOffset(tester, tab, 0);
            final layoutErrors = <String>[];
            final exception = tester.takeException();
            if (exception != null) layoutErrors.add('$exception');

            final expectedHeading = _tabHeading[tab]!;
            expect(find.text(expectedHeading), findsWidgets);
            // Keep a cumulative ledger: NativeSettingsDialog constructs its
            // offstage MemorySettings panel on first build, so its initial
            // read can legitimately precede the first Memory tab selection.
            final requestRecords = gateway.calls
                .where((call) => call.$1 == 'request')
                .map(
                  (call) => <String, dynamic>{
                    'method': call.$2['method'] ?? 'GET',
                    'path': call.$2['path'],
                  },
                )
                .toList();
            final requiredPaths = switch (tab) {
              'General' => ['/api/push'],
              'Memory' => ['/api/memory'],
              'Models' => ['/api/providers'],
              'Devices' => ['/api/devices'],
              _ => <String>[],
            };
            final actualPaths = requestRecords
                .map((request) => request['path'])
                .toSet();
            expect(actualPaths, containsAll(requiredPaths));
            final restrictedPath = switch (tab) {
              'Models' => '/api/providers',
              'Devices' => '/api/devices',
              _ => null,
            };
            if (restrictedPath != null) {
              final restrictedCalls = requestRecords.where(
                (request) => request['path'] == restrictedPath,
              );
              expect(restrictedCalls, isNotEmpty);
              expect(
                forbiddenRequests.any(
                  (request) =>
                      request['path'] == restrictedPath &&
                      request['status'] == 403,
                ),
                isTrue,
              );
              expect(
                restrictedCalls.every((request) => request['method'] == 'GET'),
                isTrue,
              );
              expect(
                gateway.calls.where(
                  (call) =>
                      call.$1 == 'request' &&
                      call.$2['path'] == restrictedPath &&
                      call.$2['method'] != 'GET',
                ),
                isEmpty,
              );
              final visibleMessage = tab == 'Models'
                  ? _providersVisibleError
                  : _devices403;
              expect(
                find.text(visibleMessage, findRichText: true),
                findsOneWidget,
              );
            }

            final result = _captureTab(
              tester,
              tab,
              requestRecords,
              forbiddenRequests,
              layoutErrors,
            );
            if (tab == 'General' && width > 640) {
              final frameHeight = (result['frame']['height'] as num).toDouble();
              final headerHeight = (result['header']['bounds']['height'] as num)
                  .toDouble();
              final viewportHeight =
                  (result['content']['viewport']['height'] as num).toDouble();
              final expectedViewportHeight =
                  frameHeight - 48 - headerHeight - 16;
              expect(
                viewportHeight,
                closeTo(expectedViewportHeight, 1),
                reason:
                    'Wide General content should fill the dialog space below its header.',
              );
              result['wideContentViewportValidation'] = {
                'frameHeight': frameHeight,
                'headerHeight': headerHeight,
                'expectedContentHeight': expectedViewportHeight,
                'actualContentHeight': viewportHeight,
                'delta': viewportHeight - expectedViewportHeight,
              };
            }
            if (tab == 'Memory') {
              expect(result['content']['scroll']['offset'], 0);
              expect(
                gateway.calls.where(
                  (call) =>
                      call.$1 == 'request' &&
                      '${call.$2['path']}'.endsWith('/history'),
                ),
                isEmpty,
              );
            }
            cases.add(result);
            await tester.runAsync(() async {
              final image =
                  await (captureKey.currentContext!.findRenderObject()!
                          as RenderRepaintBoundary)
                      .toImage(pixelRatio: 1);
              final data = await image.toByteData(
                format: ui.ImageByteFormat.png,
              );
              File(
                '${outputDirectory.path}/${tab.toLowerCase()}.png',
              ).writeAsBytesSync(data!.buffer.asUint8List());
              image.dispose();
            });
            if (tab == 'Memory') {
              final historyCount =
                  (_object(fixture['memoryHistory'])['user-response-style']
                          as List)
                      .length;
              memorySupplemental = await _captureMemorySupplemental(
                tester,
                captureKey,
                outputDirectory,
                gateway,
                historyCount,
              );
            }
          }

          final config = <String, dynamic>{
            'webRevision': fixture['webRevision'],
            'width': width,
            'height': height,
            'theme': themeName,
            'textScale': scale,
            'fixtureNow': fixture['now'],
            'devicePixelRatio': 1,
            'textScaleMethod': 'MediaQuery.textScaler',
            'fontOracle':
                'loadParityFonts maps host Arial Latin into Flutter test aliases; CJK fallback remains the same host system stack.',
            'restrictedSettingsPolicy': {
              'models': {'method': 'GET', 'status': 403},
              'devices': {'method': 'GET', 'status': 403},
            },
            'webFixtureReferenceShape': {
              'providers': {
                'keys': _object(fixture['providers']).keys.toList(),
                'providerCount':
                    (_object(fixture['providers'])['providers'] as List).length,
              },
              'devices': {
                'keys': _object(fixture['devices']).keys.toList(),
                'deviceCount':
                    (_object(fixture['devices'])['devices'] as List).length,
              },
            },
            'memorySupplemental': memorySupplemental,
            'memoryBaseState': {
              'panelScrollTop': cases.firstWhere(
                (state) => state['tab'] == 'memory',
              )['content']['scroll']['offset'],
              'historyOpen': false,
              'historyItems': 0,
              'removedDetailsOpen': false,
            },
            'tabs': cases,
          };
          File('${outputDirectory.path}/geometry.json').writeAsStringSync(
            const JsonEncoder.withIndent('  ').convert(config),
          );
          await tester.pumpWidget(const SizedBox());
          controller.dispose();
          await gateway.stream.close();
          debugDisableShadows = true;
        });
      }
    }
  }
}
