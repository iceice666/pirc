import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/notification_settings.dart';
import 'package:pirc_mobile/live/settings_dialog.dart';

import '../../test/live_test.dart' show FakeGateway, theme;
import 'capture_fonts.dart';

Json _object(dynamic value) => value is Map
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

String _text(Widget widget) {
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

Map<String, dynamic> _textRecord(WidgetTester tester, Finder finder) {
  final element = finder.evaluate().single;
  final widget = element.widget;
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
  final effective = DefaultTextStyle.of(
    element,
  ).style.merge(style).merge(spanStyle);
  return {
    'text': _text(widget),
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

Map<String, dynamic> _caseFromWeb(Json scenario, Json fixture) {
  final on = scenario['subscription'] == true;
  final permission = scenario['permission'] != 'denied';
  final unsupported = scenario['browserSupport'] == 'unsupported';
  return {
    ...scenario,
    'nativePermission': permission,
    'nativeDistributors': unsupported
        ? <String>[]
        : <String>['org.unifiedpush.distributor.fixture'],
    'nativeCode': on ? 'on' : 'off',
    'nativeState': on ? '已啟用：Fixture distributor' : '尚未啟用',
    'nativeSubscriptionId': on
        ? _object(fixture['places'])['phone']['id']
        : null,
    'nativeAction': scenario['action'],
    'nativeCaseType': 'web-scenario',
    'comparisonNote': switch (scenario['id']) {
      'loading' =>
        'The Web harness holds service-worker registration pending; Android holds the native pushStatus call pending.',
      'off-enable-success' =>
        'Android enables through the selected UnifiedPush distributor; the Web reference requests browser permission and POSTs a Web Push subscription.',
      'on' =>
        'The current endpoint is the paired phone (Pixel 9) on Android and the browser subscription (Chrome on macOS) in the Web reference.',
      'denied' =>
        'The Web reference reports site notification permission; Android reports app-level notification permission.',
      'unsupported' =>
        'The Web reference lacks ServiceWorker support; this native case has no installed UnifiedPush distributor. These are different platform causes.',
      'info-forbidden' =>
        'Both use the same 403 envelope; LiveController.describe translates the server message into the native permission message.',
      _ => null,
    },
  };
}

List<Map<String, dynamic>> _nativeOnlyCases(Json fixture) {
  final places = _object(fixture['places']);
  final phone = _object(places['phone']);
  return [
    {
      'id': 'native-connecting',
      'nativeCaseType': 'android-only',
      'nativePermission': true,
      'nativeDistributors': ['org.unifiedpush.distributor.fixture'],
      'nativeCode': 'connecting',
      'nativeState': '正在向 Fixture distributor 註冊',
      'nativeSubscriptionId': null,
      'places': [phone],
      'nativeAction': null,
      'comparisonNote':
          'Android UnifiedPush registration has a connecting state; the Web fixture has no equivalent registration status.',
    },
    {
      'id': 'native-failed',
      'nativeCaseType': 'android-only',
      'nativePermission': true,
      'nativeDistributors': ['org.unifiedpush.distributor.fixture'],
      'nativeCode': 'failed',
      'nativeState': 'Registration failed: fixture distributor is unavailable.',
      'nativeSubscriptionId': null,
      'places': [phone],
      'nativeAction': null,
      'comparisonNote':
          'Android UnifiedPush registration failure is surfaced from the native registration state; the Web fixture has no equivalent state.',
    },
    {
      'id': 'native-distributor-available',
      'nativeCaseType': 'android-only',
      'nativePermission': true,
      'nativeDistributors': ['org.unifiedpush.distributor.fixture'],
      'nativeCode': 'off',
      'nativeState': '尚未啟用',
      'nativeSubscriptionId': null,
      'places': <Json>[],
      'nativeAction': null,
      'browserScenarioId': 'unsupported',
      'comparisonNote':
          'A Web browser without ServiceWorker support can be unsupported while Android has an installed UnifiedPush distributor and can offer Turn on.',
    },
    {
      'id': 'native-denied-no-distributor',
      'nativeCaseType': 'android-only',
      'nativePermission': false,
      'nativeDistributors': <String>[],
      'nativeCode': 'off',
      'nativeState': '尚未啟用',
      'nativeSubscriptionId': null,
      'places': <Json>[],
      'nativeAction': null,
      'comparisonNote':
          'Android notification permission denial takes precedence over the missing-distributor unsupported state.',
    },
    {
      'id': 'native-denied-permission-request',
      'nativeCaseType': 'android-only',
      'nativePermission': false,
      'nativeDistributors': ['org.unifiedpush.distributor.fixture'],
      'nativeCode': 'off',
      'nativeState': '尚未啟用',
      'nativeSubscriptionId': null,
      'places': <Json>[],
      'nativeAction': 'request-permission',
      'comparisonNote':
          'Tapping Allow notifications requests Android app permission; this local fixture grants it without showing a real system prompt.',
    },
  ];
}

String _expectedNativeStatus(Map<String, dynamic> scenario) {
  if (scenario['nativeCaseType'] == 'android-only' &&
      scenario['id'] == 'native-connecting') {
    return 'connecting';
  }
  if (scenario['nativeCaseType'] == 'android-only' &&
      scenario['id'] == 'native-failed') {
    return 'failed';
  }
  if (scenario['id'] == 'native-denied-permission-request') return 'off';
  if (scenario['nativePermission'] != true) return 'denied';
  if (scenario['nativeCode'] == 'off' &&
      (scenario['nativeDistributors'] as List).isEmpty) {
    return 'unsupported';
  }
  if (scenario['id'] == 'loading') return 'loading';
  if (scenario['id'] == 'off-enable-success') return 'on';
  return '${scenario['nativeCode']}';
}

String? _expectedNativeMessage(String status) => switch (status) {
  'loading' => 'Checking notifications…',
  'off' => 'This phone does not get notifications.',
  'on' => 'This phone gets notifications.',
  'connecting' => 'Registering this phone for notifications…',
  'denied' =>
    'Notifications are blocked for this app. Allow them in Android settings.',
  'unsupported' =>
    'No UnifiedPush distributor is installed. Install one (ntfy, for example), then come back.',
  _ => null,
};

ScrollController _panelScrollController(WidgetTester tester) {
  final notification = find.byType(NativeNotificationSettings);
  final scroll = find
      .ancestor(of: notification, matching: find.byType(SingleChildScrollView))
      .first;
  return tester.widget<SingleChildScrollView>(scroll).controller!;
}

double _scrollTop(WidgetTester tester) {
  final controller = _panelScrollController(tester);
  return controller.hasClients ? controller.offset : 0;
}

void _scrollPanelToTop(WidgetTester tester) {
  final controller = _panelScrollController(tester);
  if (controller.hasClients) controller.jumpTo(0);
}

Map<String, double>? _intersection(Rect a, Rect b) {
  final value = a.intersect(b);
  if (value.width <= 0 || value.height <= 0) return null;
  return {
    'x': value.left,
    'y': value.top,
    'width': value.width,
    'height': value.height,
  };
}

Map<String, double>? _ancestorRect(
  WidgetTester tester,
  Finder target,
  Type type,
) {
  if (target.evaluate().isEmpty) return null;
  final ancestor = find.ancestor(of: target.first, matching: find.byType(type));
  return _optionalRect(tester, ancestor);
}

Future<Map<String, dynamic>?> _captureFocusedAnchor(
  WidgetTester tester, {
  required String scenarioId,
  required GlobalKey captureKey,
  required Finder target,
  required String anchor,
  required String selector,
  required Directory outputDirectory,
  required Map<String, dynamic> Function() relatedGeometry,
}) async {
  if (target.evaluate().isEmpty) return null;
  final before = _scrollTop(tester);
  await tester.ensureVisible(target.first);
  await tester.pumpAndSettle();
  final after = _scrollTop(tester);
  final targetRect = tester.getRect(target.first);
  final panelFinder = find
      .ancestor(
        of: find.byType(NativeNotificationSettings),
        matching: find.byType(SingleChildScrollView),
      )
      .first;
  final panelRect = tester.getRect(panelFinder);
  final viewportSize = tester.view.physicalSize / tester.view.devicePixelRatio;
  final browserRect = Offset.zero & viewportSize;
  final screenshot = '$scenarioId--$anchor.png';
  await _writePng(tester, captureKey, '${outputDirectory.path}/$screenshot');
  final widget = target.evaluate().first.widget;
  final primaryFocus = FocusManager.instance.primaryFocus;
  final highlightMode = FocusManager.instance.highlightMode;
  return {
    'anchor': {
      'id': anchor,
      'selector': selector,
      'targetText': _text(widget),
      'targetBox': _rect(tester, target.first),
      'panelViewportBox': {
        'x': panelRect.left,
        'y': panelRect.top,
        'right': panelRect.right,
        'bottom': panelRect.bottom,
        'width': panelRect.width,
        'height': panelRect.height,
      },
      'panelScrollTopBefore': before,
      'panelScrollTopAfter': after,
      'panelScrollDelta': after - before,
      'targetIntersectsPanelViewport':
          _intersection(targetRect, panelRect) != null,
      'targetFullyWithinPanelViewport':
          panelRect.contains(targetRect.topLeft) &&
          panelRect.contains(targetRect.bottomRight),
      'targetIntersectsBrowserViewport':
          _intersection(targetRect, browserRect) != null,
      'windowScrollYBefore': 0,
      'windowScrollYAfter': 0,
      'relatedGeometry': relatedGeometry(),
      'nativeInput': {
        'mode': 'Flutter test pointer',
        'primaryFocus': primaryFocus?.debugLabel,
        'highlightMode': '$highlightMode',
      },
    },
    'screenshot': screenshot,
  };
}

Map<String, dynamic> _captureCase(
  WidgetTester tester, {
  required Map<String, dynamic> scenario,
  required String expectedStatus,
  required String screenshot,
  required List<Map<String, dynamic>> apiRequests,
  required List<String> gatewayCalls,
}) {
  final notification = find.byType(NativeNotificationSettings);
  final dialog = find.byType(NativeSettingsDialog);
  final textFinder = find.descendant(
    of: notification,
    matching: find.byWidgetPredicate(
      (widget) => widget is Text || widget is SelectableText,
    ),
  );
  final texts = <Map<String, dynamic>>[];
  for (var index = 0; index < textFinder.evaluate().length; index++) {
    texts.add(_textRecord(tester, textFinder.at(index)));
  }
  final buttonFinder = find.descendant(
    of: notification,
    matching: find.byType(TextButton),
  );
  final buttons = <Map<String, dynamic>>[];
  for (var index = 0; index < buttonFinder.evaluate().length; index++) {
    final finder = buttonFinder.at(index);
    final button = tester.widget<TextButton>(finder);
    final label = find
        .descendant(of: finder, matching: find.byType(Text))
        .evaluate()
        .map((element) => _text(element.widget))
        .where((value) => value.isNotEmpty)
        .join(' ');
    buttons.add({
      'label': label,
      ..._rect(tester, finder),
      'enabled': button.onPressed != null,
    });
  }
  final sectionHeading = find.descendant(
    of: notification,
    matching: find.text('NOTIFICATIONS'),
  );
  final frame = find.byKey(const Key('settings-frame'));
  final tabs = [
    for (final label in settingsCategories)
      {
        'label': label,
        'box': _optionalRect(
          tester,
          find.byKey(ValueKey('settings-tab-$label')),
        ),
        'selected': label == 'General',
      },
  ];
  final memoryTab = find.byKey(const ValueKey('settings-tab-Memory'));
  final memoryBadge = find.descendant(of: memoryTab, matching: find.text('1'));
  return {
    'id': scenario['id'],
    'caseType': scenario['nativeCaseType'],
    'browserScenarioId': scenario['browserScenarioId'] ?? scenario['id'],
    'browserExpectedState': scenario['expectedState'],
    'browserExpectedMessage': scenario['expectedMessage'],
    'nativeState': expectedStatus,
    'nativePermission': scenario['nativePermission'],
    'nativeDistributors': scenario['nativeDistributors'],
    'nativeRegistrationCode': scenario['nativeCode'],
    'nativeRegistrationState': scenario['nativeState'],
    'comparisonNote': scenario['comparisonNote'],
    'screenshot': screenshot,
    'settingsFrame': _optionalRect(tester, frame),
    'sharedChrome': {
      'fixture': 'settings-matrix.json',
      'tabs': tabs,
      'memoryPendingBadgeCount': memoryBadge.evaluate().isEmpty ? 0 : 1,
      'memoryBadgeBox': _optionalRect(tester, memoryBadge),
    },
    'notification': {
      'heading': _optionalRect(tester, sectionHeading),
      'bounds': _optionalRect(tester, notification),
      'panelScrollTop': _scrollTop(tester),
      'visibleText': texts,
      'buttons': buttons,
      'places': scenario['places'] ?? <Json>[],
    },
    'gatewayCalls': gatewayCalls,
    'apiRequests': apiRequests,
    'layoutError': tester.takeException()?.toString(),
    'settingsDialogMounted': dialog.evaluate().isNotEmpty,
  };
}

void main() {
  final fixture = _object(
    jsonDecode(
      File(
        '../../fixtures/mobile-parity/notification-matrix.json',
      ).readAsStringSync(),
    ),
  );
  final expectedFixture = _object(
    jsonDecode(
      File(
        '../../fixtures/mobile-parity/notification-matrix-expected.json',
      ).readAsStringSync(),
    ),
  );
  final settingsFixture = _object(
    jsonDecode(
      File(
        '../../fixtures/mobile-parity/settings-matrix.json',
      ).readAsStringSync(),
    ),
  );
  const smoke = bool.fromEnvironment('PARITY_NOTIFICATION_SMOKE');
  final widths = smoke
      ? [390, 768]
      : (fixture['widths'] as List)
            .map((value) => (value as num).toInt())
            .toList();
  final themes = (fixture['themes'] as List).cast<String>();
  final scales = (fixture['textScales'] as List)
      .map((value) => (value as num).toDouble())
      .toList();
  final height = (fixture['height'] as num).toDouble();
  final baseScenarios = (fixture['scenarios'] as List).map(_object).toList();
  final scenarios = [
    for (final scenario in baseScenarios) _caseFromWeb(scenario, fixture),
    ..._nativeOnlyCases(fixture),
  ];
  if (fixture['webRevision'] != expectedFixture['webRevision'] ||
      fixture['webRevision'] != 'bd3d90981271e1f93cf3d1d1a5bbf9b61136b74c' ||
      _object(settingsFixture['notificationBaseline'])['state'] != 'off' ||
      scenarios.length != baseScenarios.length + 5 ||
      !widths.every((width) => (fixture['widths'] as List).contains(width))) {
    throw StateError('Notification matrix fixture contract does not match.');
  }

  for (final width in widths) {
    for (final themeName in themes) {
      for (final scale in scales) {
        testWidgets('native notification matrix $width $themeName scale $scale', (
          tester,
        ) async {
          await tester.runAsync(loadParityFonts);
          tester.view.devicePixelRatio = 1;
          tester.view.physicalSize = Size(width.toDouble(), height);
          addTearDown(tester.view.reset);

          final gateway = FakeGateway();
          final initialLoading = Completer<dynamic>();
          final apiRequests = <Map<String, dynamic>>[];
          final platformCalls = <String>[];
          var active = scenarios.first;
          var permission = true;
          var distributors = <String>[];
          var code = 'off';
          var registrationState = '尚未啟用';
          var subscriptionId = '';
          var places = <Json>[];
          var statusReadPending = true;
          var enabled = false;

          void activate(Map<String, dynamic> scenario) {
            active = scenario;
            permission = scenario['nativePermission'] == true;
            distributors = (scenario['nativeDistributors'] as List)
                .map((value) => '$value')
                .toList();
            code = '${scenario['nativeCode']}';
            registrationState = '${scenario['nativeState']}';
            subscriptionId = '${scenario['nativeSubscriptionId'] ?? ''}';
            places =
                (scenario['places'] is List
                        ? scenario['places'] as List
                        : <dynamic>[])
                    .map(_object)
                    .toList();
            enabled = false;
            apiRequests.clear();
            platformCalls.clear();
          }

          activate(scenarios.first);
          gateway.handler = (method, args) async {
            if (method == 'boot') {
              return {
                'origin': 'https://gateway.example',
                'clientId': '${settingsFixture['clientId']}',
                'pairingStamp': 'notification-matrix-start',
              };
            }
            if (method == 'preferences') return <String, dynamic>{};
            if (method == 'permissions') {
              platformCalls.add(method);
              return {'notifications': permission};
            }
            if (method == 'pushStatus') {
              platformCalls.add(method);
              if (active['id'] == 'loading' && statusReadPending) {
                return initialLoading.future;
              }
              return {
                'code': code,
                'state': registrationState,
                'distributors': distributors,
                'subscriptionId': subscriptionId.isEmpty
                    ? null
                    : subscriptionId,
              };
            }
            if (method == 'pushEnable') {
              platformCalls.add(method);
              enabled = true;
              code = 'on';
              registrationState = '已啟用：Fixture distributor';
              subscriptionId = '${_object(fixture['places'])['phone']['id']}';
              return null;
            }
            if (method == 'pushDisable') {
              platformCalls.add(method);
              code = 'off';
              registrationState = '尚未啟用';
              subscriptionId = '';
              return null;
            }
            if (method == 'requestNotifications') {
              platformCalls.add(method);
              permission = true;
              return null;
            }
            if (method != 'request') return null;
            final path = '${args['path']}';
            final requestMethod = '${args['method'] ?? 'GET'}';
            if (path == '/api/memory') {
              return settingsFixture['memory'];
            }
            if (path == '/api/schedules') {
              return {'schedules': <Json>[]};
            }
            if (!path.startsWith('/api/push')) return <String, dynamic>{};
            var status = 200;
            dynamic body;
            if (path == '/api/push' && requestMethod == 'GET') {
              status = (active['infoStatus'] as num?)?.toInt() ?? 200;
              body = status == 200
                  ? {'subscriptions': places}
                  : active['infoBody'];
            } else if (path == '/api/push/test' && requestMethod == 'POST') {
              final result = _object(active['testResponse']);
              status = (result['status'] as num?)?.toInt() ?? 200;
              body = result['body'] ?? {'delivered': 2};
            } else if (path == '/api/push/subscriptions' &&
                requestMethod == 'DELETE') {
              body = <String, dynamic>{};
            } else {
              status = 404;
              body = {
                'error': {'message': 'Unexpected notification request'},
              };
            }
            apiRequests.add({
              'method': requestMethod,
              'path': path,
              'status': status,
              'body': body,
            });
            if (status >= 400) {
              final message =
                  '${_object(_object(body)['error'])['message'] ?? 'HTTP $status'}';
              throw PlatformException(code: 'HTTP_$status', message: message);
            }
            return body ?? <String, dynamic>{};
          };

          final controller = LiveController(gateway);
          await controller.boot();
          var cleaned = false;
          addTearDown(() async {
            if (!cleaned) {
              controller.dispose();
              await gateway.stream.close();
            }
          });

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
                        notificationClock: () =>
                            DateTime.fromMillisecondsSinceEpoch(
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
            'build/parity/notification-matrix-native/$width-$themeName-scale${scale.toStringAsFixed(0)}',
          )..createSync(recursive: true);
          final captured = <Map<String, dynamic>>[];
          for (var index = 0; index < scenarios.length; index++) {
            final scenario = scenarios[index];
            if (index > 0) {
              if (active['id'] == 'loading' && !initialLoading.isCompleted) {
                statusReadPending = false;
                initialLoading.complete({
                  'code': 'off',
                  'state': '尚未啟用',
                  'distributors': ['org.unifiedpush.distributor.fixture'],
                  'subscriptionId': null,
                });
                await tester.pump();
              }
              await tester.tap(find.byTooltip('Close'));
              await tester.pumpAndSettle();
              activate(scenario);
              await tester.tap(find.byKey(const Key('open-settings')));
              await tester.pumpAndSettle();
            }

            final expectedStatus = _expectedNativeStatus(scenario);
            final preActionStatus = switch (scenario['nativeAction']) {
              'enable' => 'off',
              'request-permission' => 'denied',
              _ => expectedStatus,
            };
            final expectedMessage = _expectedNativeMessage(preActionStatus);
            if (expectedMessage != null) {
              expect(
                find.text(expectedMessage),
                findsOneWidget,
                reason:
                    'scenario ${scenario['id']}; visible=${find.byType(Text).evaluate().map((element) => _text(element.widget)).where((text) => text.isNotEmpty).toList()}',
              );
            }
            if (scenario['nativeAction'] == 'enable') {
              expect(find.text('Turn on'), findsOneWidget);
              await tester.ensureVisible(find.text('Turn on'));
              await tester.pumpAndSettle();
              await tester.tap(find.text('Turn on'));
              await tester.pumpAndSettle();
              expect(
                find.text('This phone gets notifications.'),
                findsOneWidget,
              );
              expect(enabled, isTrue);
            } else if (scenario['nativeAction'] == 'test') {
              expect(find.text('Send a test'), findsOneWidget);
              await tester.ensureVisible(find.text('Send a test'));
              await tester.pumpAndSettle();
              await tester.tap(find.text('Send a test'));
              await tester.pumpAndSettle();
              if (scenario['id'] == 'on-test-success') {
                expect(find.text('Sent to 2 of 3.'), findsOneWidget);
              } else {
                final error = _object(
                  _object(scenario['testResponse'])['body'],
                );
                final message = '${_object(error['error'])['message']}';
                expect(find.text(message), findsOneWidget);
              }
            } else if (scenario['nativeAction'] == 'request-permission') {
              final deniedText = find.text(
                'Notifications are blocked for this app. Allow them in Android settings.',
              );
              final allowText = find.text('Allow notifications');
              expect(deniedText, findsOneWidget);
              expect(allowText, findsOneWidget);
              final allowButton = find
                  .ancestor(of: allowText, matching: find.byType(TextButton))
                  .first;
              final deniedRect = tester.getRect(deniedText);
              final buttonRect = tester.getRect(allowButton);
              final labelRect = tester.getRect(allowText);
              expect(buttonRect.height, 32);
              expect(buttonRect.top, greaterThanOrEqualTo(deniedRect.bottom));
              expect(labelRect.left, greaterThanOrEqualTo(buttonRect.left));
              expect(labelRect.right, lessThanOrEqualTo(buttonRect.right));
              await tester.ensureVisible(allowText);
              await tester.pumpAndSettle();
              await tester.tap(allowText);
              await tester.pumpAndSettle();
              expect(permission, isTrue);
              expect(
                find.text('This phone does not get notifications.'),
                findsOneWidget,
              );
            }

            final id = '${scenario['id']}';
            _scrollPanelToTop(tester);
            await tester.pumpAndSettle();
            final filename = 'notification-$id.png';
            await _writePng(
              tester,
              captureKey,
              '${outputDirectory.path}/$filename',
            );
            final capturedScenario = <String, dynamic>{
              ...scenario,
              'nativePermission': permission,
              'nativeDistributors': List<String>.of(distributors),
              'nativeCode': code,
              'nativeState': registrationState,
              'nativeSubscriptionId': subscriptionId.isEmpty
                  ? null
                  : subscriptionId,
              'places': List<Json>.of(places),
            };
            final caseRecord = _captureCase(
              tester,
              scenario: capturedScenario,
              expectedStatus: expectedStatus,
              screenshot: filename,
              apiRequests: List<Map<String, dynamic>>.of(apiRequests),
              gatewayCalls: List<String>.of(platformCalls),
            );
            final nativeStatusText = switch (expectedStatus) {
              'failed' => 'This phone does not get notifications.',
              'denied' =>
                'Notifications are blocked for this app. Allow them in Android settings.',
              'unsupported' =>
                'No UnifiedPush distributor is installed. Install one (ntfy, for example), then come back.',
              'loading' => 'Checking notifications…',
              'connecting' => 'Registering this phone for notifications…',
              'on' => 'This phone gets notifications.',
              _ => 'This phone does not get notifications.',
            };
            final titleFinder = find.text('NOTIFICATIONS');
            const introduction =
                'Scheduled runs, sessions waiting for your answer, finished delegations and memory changes to approve. Each schedule chooses which of its runs notify.';
            final introductionFinder = find.text(introduction);
            final statusFinder = find.text(nativeStatusText);
            final feedbackText = switch (scenario['id']) {
              'native-failed' => '${scenario['nativeState']}',
              'on-test-success' => 'Sent to 2 of 3.',
              'on-test-error' =>
                '${_object(_object(_object(scenario['testResponse'])['body'])['error'])['message']}',
              'info-api-error' =>
                '${_object(_object(scenario['infoBody'])['error'])['message']}',
              'info-forbidden' => 'Identity is not allowed',
              _ => null,
            };
            final feedbackFinder = feedbackText == null
                ? find.byWidgetPredicate((_) => false)
                : find.text(feedbackText);
            final placeNames = places.map((place) {
              final isThisPhone = place['id'] == subscriptionId;
              return '${place['name']}${isThisPhone ? ' (this phone)' : ''}';
            }).toList();
            final firstPlaceFinder = placeNames.isEmpty
                ? find.byWidgetPredicate((_) => false)
                : find.text(placeNames.first);
            final lastPlaceFinder = placeNames.isEmpty
                ? find.byWidgetPredicate((_) => false)
                : find.text(placeNames.last);
            final sendTestFinder = find.text('Send a test');
            final primaryActionFinder = switch (expectedStatus) {
              'on' || 'connecting' => find.text('Turn off'),
              'denied' => find.text('Allow notifications'),
              'unsupported' => find.byWidgetPredicate((_) => false),
              _ => find.text('Turn on'),
            };
            final buttonFinder = places.isNotEmpty
                ? sendTestFinder
                : primaryActionFinder;

            Map<String, dynamic> readRelatedGeometry() {
              final statusRowRect =
                  const [
                    'off',
                    'on',
                    'connecting',
                    'failed',
                  ].contains(expectedStatus)
                  ? _ancestorRect(tester, statusFinder, Row)
                  : null;
              final placeCardRects = [
                for (final name in placeNames)
                  _ancestorRect(tester, find.text(name), Container),
              ];
              final actionRowRect = places.isNotEmpty
                  ? _ancestorRect(tester, sendTestFinder, Row)
                  : expectedStatus == 'denied'
                  ? _ancestorRect(tester, primaryActionFinder, Column)
                  : _ancestorRect(tester, primaryActionFinder, Row);
              final actionButtonRect = _optionalRect(
                tester,
                find.ancestor(
                  of: buttonFinder,
                  matching: find.byType(TextButton),
                ),
              );
              return {
                'notificationSection': _optionalRect(
                  tester,
                  find.byType(NativeNotificationSettings),
                ),
                'title': _optionalRect(tester, titleFinder),
                'introduction': _optionalRect(tester, introductionFinder),
                'statusRow': statusRowRect,
                'statusText': _optionalRect(tester, statusFinder),
                'feedback': _optionalRect(tester, feedbackFinder),
                'subscriptionsList': _unionRects(placeCardRects),
                'subscriptionRows': placeCardRects,
                'actionRow': actionRowRect,
                'actionButton': actionButtonRect,
              };
            }

            final focus = <String, dynamic>{};

            Future<void> captureAnchor(
              String id,
              String selector,
              Finder target,
            ) async {
              final result = await _captureFocusedAnchor(
                tester,
                scenarioId: '${scenario['id']}',
                captureKey: captureKey,
                target: target,
                anchor: id,
                selector: selector,
                outputDirectory: outputDirectory,
                relatedGeometry: readRelatedGeometry,
              );
              if (result != null) {
                result['capture'] = _captureCase(
                  tester,
                  scenario: capturedScenario,
                  expectedStatus: expectedStatus,
                  screenshot: '${result['screenshot']}',
                  apiRequests: List<Map<String, dynamic>>.of(apiRequests),
                  gatewayCalls: List<String>.of(platformCalls),
                );
                focus[id] = result;
              }
            }

            await captureAnchor(
              'notification-section-top',
              'NOTIFICATIONS section title',
              titleFinder,
            );
            await captureAnchor(
              'status-row',
              'native notification status',
              statusFinder,
            );
            if (feedbackFinder.evaluate().isNotEmpty) {
              await captureAnchor(
                'feedback',
                'native notification feedback',
                feedbackFinder,
              );
            }
            if (placeNames.isNotEmpty) {
              await captureAnchor(
                'subscriptions-list',
                'first native subscription card',
                firstPlaceFinder,
              );
              await captureAnchor(
                'subscriptions-bottom',
                'last native subscription card',
                lastPlaceFinder,
              );
            }
            if (buttonFinder.evaluate().isNotEmpty) {
              await captureAnchor(
                'action-row',
                places.isNotEmpty
                    ? 'Send a test action'
                    : expectedStatus == 'denied'
                    ? 'Android permission request action (native-only)'
                    : 'Turn on/off action',
                buttonFinder,
              );
            }
            caseRecord['focusedAnchors'] = focus;
            captured.add(caseRecord);
            final exception = tester.takeException();
            if (exception != null) {
              captured.last['layoutError'] = '$exception';
            }
          }

          final capture = <String, dynamic>{
            'webRevision': fixture['webRevision'],
            'notificationBaseline': settingsFixture['notificationBaseline'],
            'captureKind': 'native-android-notification-settings',
            'viewport': {
              'width': width,
              'height': height,
              'deviceScaleFactor': 1,
              'theme': themeName,
              'textScale': scale,
            },
            'fixture': 'notification-matrix.json',
            'settingsFixture': 'settings-matrix.json',
            'caseCount': captured.length,
            'cases': captured,
          };
          File('${outputDirectory.path}/capture.json').writeAsStringSync(
            const JsonEncoder.withIndent('  ').convert(capture),
          );
          expect(captured, hasLength(scenarios.length));
          await tester.pumpWidget(const SizedBox());
          controller.dispose();
          cleaned = true;
          await gateway.stream.close();
        });
      }
    }
  }
}
