import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/conversation_empty.dart';
import 'package:pirc_mobile/live/conversation_header.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/mobile_tabs.dart';
import 'package:pirc_mobile/live/session_sidebar.dart';
import 'package:pirc_mobile/live/web_controls.dart';

import '../../test/live_test.dart' show FakeGateway, theme;
import 'capture_fonts.dart';

const _webGeometryTolerance = 0.25;

Json _map(dynamic value) => value is Map
    ? value.map((key, value) => MapEntry('$key', value))
    : <String, dynamic>{};

List<Json> _maps(dynamic value) =>
    value is List ? value.map(_map).toList() : <Json>[];

class _StatusGateway extends FakeGateway {
  _StatusGateway(this.fixture, this.scenario, {this.startupList}) {
    final session = _map(fixture['session']);
    final model = _maps(fixture['models']).first;
    snapshot = {
      'session': session,
      'runnerEpoch': 'app-status-fixture',
      'messages': <Json>[],
      'interactions': <Json>[],
      'widgets': <String, dynamic>{},
      'statuses': <String, dynamic>{},
      'queue': <Json>[],
      'run': null,
      'modelId': model['id'],
      'modelProvider': model['provider'],
      'thinking': 'medium',
    };
  }

  final Json fixture;
  final Json scenario;
  final Completer<Json>? startupList;

  @override
  dynamic normal(String method, Json args) {
    if (method == 'boot') {
      return {
        'origin': 'https://gateway.example',
        'clientId': 'status-fixture',
        'targetSession': scenario['hasSession'] == true
            ? _map(fixture['session'])['id']
            : null,
        'onboardingComplete': true,
      };
    }
    if (method == 'preferences') {
      return {'mode': 'chat', 'appearance': 'system'};
    }
    if (method == 'request') {
      final path = '${args['path']}';
      if (path == '/api/sessions') {
        if (startupList != null) return startupList!.future;
        if (scenario['hasSession'] != true) return {'sessions': <Json>[]};
        final session = _map(fixture['session']);
        return {
          'sessions': [
            {
              ...session,
              'updatedAt': DateTime.parse(
                '${session['lastActivityAt']}',
              ).millisecondsSinceEpoch,
              'runStatus': 'stopped',
            },
          ],
        };
      }
      if (path == '/api/workspaces') {
        return {
          'workspaces': scenario['hasSession'] == true
              ? _maps(fixture['workspaces'])
              : <Json>[],
        };
      }
      if (path == '/api/nodes') {
        return {
          'nodes': scenario['hasSession'] == true
              ? _maps(fixture['nodes'])
              : <Json>[],
        };
      }
      if (path.startsWith('/api/models')) {
        return {
          'models': scenario['hasSession'] == true
              ? _maps(fixture['models'])
              : <Json>[],
        };
      }
      if (path == '/api/memory') return <String, dynamic>{};
    }
    return super.normal(method, args);
  }

  @override
  Future<dynamic> call(String method, [Json args = const {}]) async {
    final result = await super.call(method, args);
    if (method == 'watch') {
      final id = '${args['sessionId']}';
      stream.add({'type': 'snapshot', 'sessionId': id, 'data': snapshot});
      stream.add({
        'type': 'control',
        'sessionId': id,
        'data': {
          'held': scenario['controlHeld'] == true,
          'holder': scenario['holderName'],
          'generation': 7,
        },
      });
      final fixtureConnection = '${scenario['connection']}';
      stream.add({
        'type': 'connection',
        'sessionId': id,
        'data': fixtureConnection == 'connected' ? 'live' : fixtureConnection,
      });
      final pageError = '${scenario['pageError'] ?? ''}';
      if (pageError.isNotEmpty) {
        stream.add({'type': 'error', 'sessionId': id, 'data': pageError});
      }
    }
    return result;
  }
}

Json _webCase(Json expected, String themeName, int width, String caseId) {
  final themeData = _map(_map(expected['themes'])[themeName]);
  final widthData = _maps(
    themeData['widths'],
  ).firstWhere((item) => item['width'] == width);
  return _maps(widthData['cases']).firstWhere((item) => item['id'] == caseId);
}

Json? _firstElement(Json webCase, String elementName) {
  final entries = _maps(_map(webCase['elements'])[elementName]);
  return entries.isEmpty ? null : entries.first;
}

Json? _firstBox(Json webCase, String elementName) {
  final entries = _maps(_map(webCase['elements'])[elementName]);
  return entries.isEmpty ? null : _map(entries.first['box']);
}

Json? _webRelation(Json webCase, String relationName) {
  final value = _map(webCase['geometryRelations'])[relationName];
  return value == null ? null : _map(value);
}

Json _rect(Rect rect) => {
  'x': rect.left,
  'y': rect.top,
  'width': rect.width,
  'height': rect.height,
  'top': rect.top,
  'right': rect.right,
  'bottom': rect.bottom,
  'left': rect.left,
};

void _expectRectMatchesWeb(Rect actual, Json expected, String reason) {
  expect(
    actual.left,
    closeTo((expected['left'] as num).toDouble(), _webGeometryTolerance),
    reason: '$reason left',
  );
  expect(
    actual.top,
    closeTo((expected['top'] as num).toDouble(), _webGeometryTolerance),
    reason: '$reason top',
  );
  expect(
    actual.width,
    closeTo((expected['width'] as num).toDouble(), _webGeometryTolerance),
    reason: '$reason width',
  );
  expect(
    actual.height,
    closeTo((expected['height'] as num).toDouble(), _webGeometryTolerance),
    reason: '$reason height',
  );
}

void _expectDimensionsMatchWeb(Rect actual, Json expected, String reason) {
  expect(
    actual.width,
    closeTo((expected['width'] as num).toDouble(), _webGeometryTolerance),
    reason: '$reason width',
  );
  expect(
    actual.height,
    closeTo((expected['height'] as num).toDouble(), _webGeometryTolerance),
    reason: '$reason height',
  );
}

void _expectCoordinateMatchWeb(
  double actual,
  Json expected,
  String coordinate,
  String reason,
) {
  expect(
    actual,
    closeTo((expected[coordinate] as num).toDouble(), _webGeometryTolerance),
    reason: '$reason $coordinate',
  );
}

Json _boxDifferences(Rect actual, Json expected) {
  final actualBox = _rect(actual);
  return {
    for (final key in ['left', 'top', 'width', 'height', 'right', 'bottom'])
      if (((actualBox[key] as num).toDouble() -
                  (expected[key] as num).toDouble())
              .abs() >
          _webGeometryTolerance)
        key:
            (actualBox[key] as num).toDouble() -
            (expected[key] as num).toDouble(),
  };
}

Rect? _rectIfFound(WidgetTester tester, Finder finder) =>
    finder.evaluate().isEmpty ? null : tester.getRect(finder);

void main() {
  final fixture = _map(
    jsonDecode(
      File('../../fixtures/mobile-parity/app-status.json').readAsStringSync(),
    ),
  );
  final expected = _map(
    jsonDecode(
      File(
        '../../fixtures/mobile-parity/app-status-expected.json',
      ).readAsStringSync(),
    ),
  );
  final sessionCases = _maps(
    fixture['cases'],
  ).where((item) => item['hasSession'] == true).toList();

  final initialCases = _maps(
    fixture['cases'],
  ).where((item) => item['hasSession'] != true).toList();

  testWidgets('capture native startup and empty-account status against web', (
    tester,
  ) async {
    await tester.runAsync(loadParityFonts);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    addTearDown(tester.platformDispatcher.clearPlatformBrightnessTestValue);

    final output = Directory('build/parity')..createSync(recursive: true);
    final captures = <Json>[];

    for (final brightness in Brightness.values) {
      final themeName = brightness.name;
      tester.platformDispatcher.platformBrightnessTestValue = brightness;
      for (final widthValue in fixture['widths'] as List) {
        final width = (widthValue as num).toInt();
        tester.view.physicalSize = Size(
          width.toDouble(),
          (fixture['height'] as num).toDouble(),
        );
        for (final scenario in initialCases) {
          final caseId = '${scenario['id']}';
          final startupList = caseId == 'startup-loading'
              ? Completer<Json>()
              : null;
          final gateway = _StatusGateway(
            fixture,
            scenario,
            startupList: startupList,
          );
          final controller = LiveController(gateway);
          final boundaryKey = GlobalKey();
          await tester.pumpWidget(
            RepaintBoundary(
              key: boundaryKey,
              child: MobileApp(theme: theme, controller: controller),
            ),
          );
          if (startupList != null) {
            // Hold /api/sessions after boot so this frame captures initial loading.
            await tester.pump();
            await tester.pump(const Duration(milliseconds: 1));
          } else {
            await tester.pumpAndSettle();
          }

          expect(tester.takeException(), isNull, reason: caseId);
          expect(controller.booting, isFalse, reason: caseId);
          if (startupList != null) {
            expect(controller.initializing, isTrue, reason: caseId);
            expect(controller.loading, isTrue, reason: caseId);
          } else {
            expect(controller.initializing, isFalse, reason: caseId);
            expect(controller.loading, isFalse, reason: caseId);
            expect(controller.sessionId, isNull, reason: caseId);
            expect(controller.sessions, isEmpty, reason: caseId);
          }

          final phone = width <= 650;
          final isLoading = caseId == 'startup-loading';
          final stateFinder = isLoading
              ? find.byType(AppLoadingState)
              : find.byType(AppNoSessionState);
          final stateMarkFinder = find.descendant(
            of: stateFinder,
            matching: find.byType(Container),
          );
          final stateIconFinder = find.descendant(
            of: stateFinder,
            matching: find.byIcon(
              isLoading ? LucideIcons.sparkles : LucideIcons.circleAlert,
            ),
          );
          final statusText = isLoading
              ? 'Connecting to your sessions…'
              : 'No session could be loaded.';
          final stateTextFinder = find.descendant(
            of: stateFinder,
            matching: find.text(statusText),
          );
          final stateRect = _rectIfFound(tester, stateFinder);
          final stateMarkRect = isLoading
              ? _rectIfFound(tester, stateMarkFinder)
              : null;
          final stateIconRect = _rectIfFound(tester, stateIconFinder);
          final stateTextRect = _rectIfFound(tester, stateTextFinder);
          final sidebarFinder = find.byType(SessionSidebar);
          final tabsFinder = find.byType(MobileTabs);
          final sidebarSearchFinder = find.descendant(
            of: sidebarFinder,
            matching: find.byType(WebSearch),
          );
          final sidebarNewSessionText = find.descendant(
            of: sidebarFinder,
            matching: find.text('New session'),
          );
          final sidebarNewSessionFinder = find
              .ancestor(
                of: sidebarNewSessionText,
                matching: find.byType(InkWell),
              )
              .first;
          final sidebarScrollFinder = find.descendant(
            of: sidebarFinder,
            matching: find.byType(RefreshIndicator),
          );
          final sidebarEmptyNoteFinder = find.descendant(
            of: sidebarFinder,
            matching: find.text('Connect a device to add a workspace.'),
          );
          final sidebarSettingsText = find.descendant(
            of: sidebarFinder,
            matching: find.text('Settings'),
          );
          final sidebarSettingsFinder = find
              .ancestor(
                of: sidebarSettingsText,
                matching: find.byType(TextButton),
              )
              .first;
          final sidebarRect = _rectIfFound(tester, sidebarFinder);
          final sidebarSearchRect = _rectIfFound(tester, sidebarSearchFinder);
          final sidebarNewSessionRect = _rectIfFound(
            tester,
            sidebarNewSessionFinder,
          );
          final sidebarScrollRect = _rectIfFound(tester, sidebarScrollFinder);
          final sidebarEmptyNoteRect = _rectIfFound(
            tester,
            sidebarEmptyNoteFinder,
          );
          final sidebarSettingsRect = phone
              ? null
              : _rectIfFound(tester, sidebarSettingsFinder);
          final tabsRect = _rectIfFound(tester, tabsFinder);
          final sidebarSearchInputs = find.descendant(
            of: sidebarFinder,
            matching: find.byType(TextField),
          );
          expect(sidebarSearchInputs, findsOneWidget, reason: caseId);
          final searchHint = tester
              .widget<TextField>(sidebarSearchInputs)
              .decoration
              ?.hintText;
          expect(searchHint, 'Search sessions', reason: '$caseId source mode');
          expect(sidebarNewSessionText, findsOneWidget, reason: caseId);
          expect(sidebarEmptyNoteFinder, findsOneWidget, reason: caseId);

          expect(sidebarRect, isNotNull, reason: '$caseId sidebar is present');
          if (phone) {
            // The source keeps the main view behind an open phone sidebar.
            // Keep the native view mounted too, while excluding hidden content
            // from paint, focus, semantics and visible geometry measurements.
            expect(
              find.byType(
                isLoading ? AppLoadingState : AppNoSessionState,
                skipOffstage: false,
              ),
              findsOneWidget,
              reason: '$caseId retains the covered main state',
            );
            expect(controller.sessionVisible, isFalse, reason: caseId);
            expect(tabsRect, isNotNull, reason: '$caseId phone tabs');
            expect(stateRect, isNull, reason: '$caseId hidden main state');
          } else {
            expect(tabsRect, isNull, reason: '$caseId no desktop tabs');
            expect(stateRect, isNotNull, reason: '$caseId main status root');
            expect(stateIconRect, isNotNull, reason: '$caseId status icon');
            expect(stateTextRect, isNotNull, reason: '$caseId status text');
          }

          final webCase = _webCase(expected, themeName, width, caseId);
          final webSidebar = _firstBox(webCase, 'sidebar');
          final webNewSession = _firstBox(webCase, 'sidebarNewSession');
          final webSearch = _firstBox(webCase, 'sidebarSearch');
          final webScroll = _firstBox(webCase, 'sidebarScroll');
          final webEmptyNote = _firstBox(webCase, 'sidebarEmptyNote');
          final webSearchInput = _firstElement(webCase, 'sidebarSearchInput');
          final webFooterSettings = _firstBox(webCase, 'sidebarFooterSettings');
          final webState = _firstBox(webCase, 'loadingState');
          final webStateMark = _firstBox(webCase, 'loadingStateMark');
          final webStateIcon = _firstBox(webCase, 'loadingStateIcon');
          final webStateText = _firstBox(webCase, 'loadingStateText');
          expect(webSidebar, isNotNull, reason: '$caseId web sidebar');
          expect(
            _map(webSearchInput?['attributes'])['placeholder'],
            'Search sessions',
            reason: '$caseId web search placeholder',
          );
          expect(
            _map(_firstElement(webCase, 'sidebarNewSession'))['text'],
            'New session',
            reason: '$caseId web new-session label',
          );
          expect(
            _map(_firstElement(webCase, 'sidebarEmptyNote'))['text'],
            'Connect a device to add a workspace.',
            reason: '$caseId web workspace note',
          );
          _expectRectMatchesWeb(
            sidebarRect!,
            webSidebar!,
            '$caseId sidebar vs web',
          );
          _expectRectMatchesWeb(
            sidebarSearchRect!,
            webSearch!,
            '$caseId sidebar search vs web',
          );
          _expectRectMatchesWeb(
            sidebarNewSessionRect!,
            webNewSession!,
            '$caseId new session button vs web',
          );
          _expectRectMatchesWeb(
            sidebarScrollRect!,
            webScroll!,
            '$caseId sidebar scroll vs web',
          );
          _expectRectMatchesWeb(
            sidebarEmptyNoteRect!,
            webEmptyNote!,
            '$caseId sidebar workspace note vs web',
          );
          if (phone) {
            final webTabs = _firstBox(webCase, 'mobileTabs');
            _expectRectMatchesWeb(tabsRect!, webTabs!, '$caseId tabs vs web');
          } else {
            expect(sidebarSettingsText, findsOneWidget, reason: caseId);
            expect(
              webFooterSettings,
              isNotNull,
              reason: '$caseId web footer settings',
            );
            _expectRectMatchesWeb(
              sidebarSettingsRect!,
              webFooterSettings!,
              '$caseId settings footer vs web',
            );
          }
          if (!phone) {
            _expectRectMatchesWeb(
              stateRect!,
              webState!,
              '$caseId state root vs web',
            );
            if (isLoading) {
              expect(stateMarkRect, isNotNull, reason: '$caseId state mark');
              _expectRectMatchesWeb(
                stateMarkRect!,
                webStateMark!,
                '$caseId state mark vs web',
              );
            } else {
              expect(stateMarkRect, isNull, reason: '$caseId no state mark');
            }
            _expectRectMatchesWeb(
              stateIconRect!,
              webStateIcon!,
              '$caseId state icon vs web',
            );
            _expectRectMatchesWeb(
              stateTextRect!,
              webStateText!,
              '$caseId state text vs web',
            );
          }

          final screenshot = 'app-status-native-$caseId-$width-$themeName.png';
          await tester.runAsync(() async {
            final image =
                await (boundaryKey.currentContext!.findRenderObject()
                        as RenderRepaintBoundary)
                    .toImage(pixelRatio: 1);
            final bytes = await image.toByteData(
              format: ui.ImageByteFormat.png,
            );
            File(
              '${output.path}/$screenshot',
            ).writeAsBytesSync(bytes!.buffer.asUint8List());
            image.dispose();
          });
          captures.add({
            'id': caseId,
            'width': width,
            'theme': themeName,
            'fontOverride': fixture['fontOverride'],
            'phoneMainObscuredBySidebar': phone,
            'native': {
              'sidebar': _rect(sidebarRect),
              'sidebarNewSession': _rect(sidebarNewSessionRect),
              'sidebarSearch': _rect(sidebarSearchRect),
              'sidebarSearchPlaceholder': searchHint,
              'sidebarScroll': _rect(sidebarScrollRect),
              'sidebarEmptyNote': _rect(sidebarEmptyNoteRect),
              'sidebarSettings': sidebarSettingsRect == null
                  ? null
                  : _rect(sidebarSettingsRect),
              'mobileTabs': tabsRect == null ? null : _rect(tabsRect),
              'statusRoot': stateRect == null ? null : _rect(stateRect),
              'statusMark': stateMarkRect == null ? null : _rect(stateMarkRect),
              'statusIcon': stateIconRect == null ? null : _rect(stateIconRect),
              'statusText': stateTextRect == null ? null : _rect(stateTextRect),
            },
            'webReference': {
              'initialPhoneNavigation': webCase['initialPhoneNavigation'],
              'sidebar': webSidebar,
              'sidebarNewSession': webNewSession,
              'sidebarSearch': webSearch,
              'sidebarSearchPlaceholder': _map(
                _map(webSearchInput?['attributes'])['placeholder'],
              ),
              'sidebarScroll': webScroll,
              'sidebarEmptyNote': webEmptyNote,
              'sidebarSettings': webFooterSettings,
              'mobileTabs': _firstBox(webCase, 'mobileTabs'),
              'statusRoot': webState,
              'statusMark': webStateMark,
              'statusIcon': webStateIcon,
              'statusText': webStateText,
            },
            'screenshot': screenshot,
          });

          if (startupList != null) {
            startupList.complete({'sessions': <Json>[]});
            await tester.pumpAndSettle();
          }
          await tester.pumpWidget(const SizedBox.shrink());
          await tester.pumpAndSettle();
          await gateway.stream.close();
        }
      }
    }

    final document = {
      'fixture': fixture['id'],
      'reference': fixture['webRevision'],
      'fontOverride': fixture['fontOverride'],
      'captures': captures,
    };
    await tester.runAsync(() async {
      final encoded = const JsonEncoder.withIndent('  ').convert(document);
      File(
        '${output.path}/app-status-native-initial.json',
      ).writeAsStringSync('$encoded\n');
    });
  });

  testWidgets('capture native app global status against pinned web geometry', (
    tester,
  ) async {
    await tester.runAsync(loadParityFonts);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    addTearDown(tester.platformDispatcher.clearPlatformBrightnessTestValue);

    final output = Directory('build/parity')..createSync(recursive: true);
    final captures = <Json>[];

    for (final brightness in Brightness.values) {
      final themeName = brightness.name;
      tester.platformDispatcher.platformBrightnessTestValue = brightness;
      for (final widthValue in fixture['widths'] as List) {
        final width = (widthValue as num).toInt();
        tester.view.physicalSize = Size(
          width.toDouble(),
          (fixture['height'] as num).toDouble(),
        );
        for (final scenario in sessionCases) {
          final caseId = '${scenario['id']}';
          final gateway = _StatusGateway(fixture, scenario);
          final controller = LiveController(gateway);
          final boundaryKey = GlobalKey();
          await tester.pumpWidget(
            RepaintBoundary(
              key: boundaryKey,
              child: MobileApp(theme: theme, controller: controller),
            ),
          );
          await tester.pumpAndSettle();

          expect(tester.takeException(), isNull, reason: caseId);
          expect(controller.booting, isFalse, reason: caseId);
          expect(controller.sessionId, _map(fixture['session'])['id']);
          expect(
            controller.state['session']['name'],
            _map(fixture['session'])['name'],
          );
          expect(
            controller.error,
            scenario['pageError'] == '' ? isNull : scenario['pageError'],
          );
          final expectedConnection = scenario['connection'] == 'connected'
              ? 'live'
              : scenario['connection'];
          expect(controller.connection, expectedConnection, reason: caseId);

          final statusLabel = switch (controller.connection) {
            'live' => 'Live',
            'offline' || 'stopped' => 'Offline',
            _ => 'Reconnecting',
          };
          final headerFinder = find.byType(ConversationHeader);
          final errorFinder = find.byType(ConversationErrorBanner);
          final viewerFinder = find.byType(ConversationViewerBanner);
          final connectionFinder = find.byTooltip(statusLabel);
          final errorContainerFinder = find.descendant(
            of: errorFinder,
            matching: find.byType(Container),
          );
          final viewerContainerFinder = find.descendant(
            of: viewerFinder,
            matching: find.byType(Container),
          );
          final errorIconFinder = find.descendant(
            of: errorFinder,
            matching: find.byIcon(LucideIcons.circleAlert),
          );
          final dismissIconFinder = find.descendant(
            of: errorFinder,
            matching: find.byIcon(LucideIcons.x),
          );
          final emptyConversationFinder = find.byType(ConversationEmptyState);
          final emptyMarkFinder = find.descendant(
            of: emptyConversationFinder,
            matching: find.byType(Container),
          );
          final emptyIconFinder = find.descendant(
            of: emptyConversationFinder,
            matching: find.byIcon(LucideIcons.plus),
          );
          final emptyHeadingFinder = find.descendant(
            of: emptyConversationFinder,
            matching: find.text('Start something useful'),
          );
          final emptyDescriptionFinder = find.descendant(
            of: emptyConversationFinder,
            matching: find.text(
              'Describe a task, attach a reference image, or ask the agent to continue work in this workspace.',
            ),
          );

          final headerRect = _rectIfFound(tester, headerFinder);
          final errorRect = _rectIfFound(tester, errorContainerFinder);
          final errorWrapperRect = _rectIfFound(tester, errorFinder);
          final viewerRect = _rectIfFound(tester, viewerContainerFinder);
          final viewerWrapperRect = _rectIfFound(tester, viewerFinder);
          final connectionRect = _rectIfFound(tester, connectionFinder);
          final errorIconRect = _rectIfFound(tester, errorIconFinder);
          final dismissIconRect = _rectIfFound(tester, dismissIconFinder);
          final emptyConversationRect = _rectIfFound(
            tester,
            emptyConversationFinder,
          );
          final emptyMarkRect = _rectIfFound(tester, emptyMarkFinder.first);
          final emptyIconRect = _rectIfFound(tester, emptyIconFinder);
          final emptyHeadingRect = _rectIfFound(tester, emptyHeadingFinder);
          final emptyDescriptionRect = _rectIfFound(
            tester,
            emptyDescriptionFinder,
          );

          expect(headerRect, isNotNull, reason: '$caseId header');
          expect(
            connectionRect,
            isNotNull,
            reason: '$caseId connection status',
          );
          if (scenario['pageError'] != '') {
            expect(errorRect, isNotNull, reason: '$caseId error banner');
            expect(errorIconRect, isNotNull, reason: '$caseId alert icon');
            expect(dismissIconRect, isNotNull, reason: '$caseId dismiss icon');
          }
          if (scenario['controlHeld'] == false) {
            expect(viewerRect, isNotNull, reason: '$caseId viewer banner');
          }

          final webCase = _webCase(expected, themeName, width, caseId);
          final webHeader = _firstBox(webCase, 'topbar');
          final webError = _firstBox(webCase, 'errorBanner');
          final webViewer = _firstBox(webCase, 'viewerBanner');
          final webConnection = _firstBox(webCase, 'connectionPill');
          final webRelations = _map(webCase['geometryRelations']);
          final errorGap = headerRect != null && errorRect != null
              ? errorRect.top - headerRect.bottom
              : null;
          final connectionCenterY = headerRect != null && connectionRect != null
              ? connectionRect.center.dy - headerRect.top
              : null;

          _expectRectMatchesWeb(
            headerRect!,
            webHeader!,
            '$caseId header vs web',
          );
          _expectRectMatchesWeb(
            connectionRect!,
            webConnection!,
            '$caseId connection pill vs web',
          );

          final webEmptyConversation = _firstBox(webCase, 'emptyConversation');
          final webEmptyMark = _firstBox(webCase, 'emptyConversationMark');
          final webEmptyIcon = _firstBox(webCase, 'emptyConversationIcon');
          final webEmptyHeading = _firstBox(
            webCase,
            'emptyConversationHeading',
          );
          final webEmptyDescription = _firstBox(
            webCase,
            'emptyConversationDescription',
          );
          expect(
            emptyConversationRect,
            isNotNull,
            reason: '$caseId empty state',
          );
          expect(emptyMarkRect, isNotNull, reason: '$caseId empty state mark');
          expect(emptyIconRect, isNotNull, reason: '$caseId empty state icon');
          expect(
            emptyHeadingRect,
            isNotNull,
            reason: '$caseId empty state heading',
          );
          expect(
            emptyDescriptionRect,
            isNotNull,
            reason: '$caseId empty state description',
          );
          _expectRectMatchesWeb(
            emptyConversationRect!,
            webEmptyConversation!,
            '$caseId empty conversation vs web',
          );
          _expectCoordinateMatchWeb(
            emptyMarkRect!.left,
            webEmptyMark!,
            'left',
            '$caseId empty mark vs web',
          );
          _expectDimensionsMatchWeb(
            emptyMarkRect,
            webEmptyMark,
            '$caseId empty mark vs web',
          );
          _expectCoordinateMatchWeb(
            emptyIconRect!.left,
            webEmptyIcon!,
            'left',
            '$caseId empty icon vs web',
          );
          _expectDimensionsMatchWeb(
            emptyIconRect,
            webEmptyIcon,
            '$caseId empty icon vs web',
          );
          _expectCoordinateMatchWeb(
            emptyHeadingRect!.left,
            webEmptyHeading!,
            'left',
            '$caseId empty heading vs web',
          );
          _expectCoordinateMatchWeb(
            emptyHeadingRect.width,
            {'width': webEmptyHeading['width']},
            'width',
            '$caseId empty heading vs web',
          );
          _expectCoordinateMatchWeb(
            emptyDescriptionRect!.left,
            webEmptyDescription!,
            'left',
            '$caseId empty description vs web',
          );
          _expectCoordinateMatchWeb(
            emptyDescriptionRect.top,
            webEmptyDescription,
            'top',
            '$caseId empty description vs web',
          );
          _expectCoordinateMatchWeb(
            emptyDescriptionRect.width,
            {'width': webEmptyDescription['width']},
            'width',
            '$caseId empty description vs web',
          );

          if (errorGap != null) {
            final webGap =
                (webRelations['errorBannerTopAfterHeaderBottom'] as num)
                    .toDouble();
            expect(
              errorGap,
              closeTo(webGap, _webGeometryTolerance),
              reason: '$caseId error banner top relative to web header',
            );
            final webAlert = _webRelation(webCase, 'errorIconBox')!;
            final webDismiss = _webRelation(webCase, 'dismissIconBox')!;
            expect(
              errorIconRect!.width,
              closeTo(
                (webAlert['width'] as num).toDouble(),
                _webGeometryTolerance,
              ),
              reason: '$caseId alert icon size vs pinned web',
            );
            expect(
              dismissIconRect!.width,
              closeTo(
                (webDismiss['width'] as num).toDouble(),
                _webGeometryTolerance,
              ),
              reason: '$caseId dismiss icon size vs pinned web',
            );
            _expectRectMatchesWeb(
              errorRect!,
              webError!,
              '$caseId banner vs web',
            );
            _expectRectMatchesWeb(
              errorIconRect,
              webAlert,
              '$caseId alert icon vs web',
            );
            _expectRectMatchesWeb(
              dismissIconRect,
              webDismiss,
              '$caseId dismiss icon vs web',
            );
          }
          if (scenario['controlHeld'] == false) {
            _expectRectMatchesWeb(
              viewerRect!,
              webViewer!,
              '$caseId viewer banner vs web',
            );
          }

          final screenshot = 'app-status-native-$caseId-$width-$themeName.png';
          await tester.runAsync(() async {
            final image =
                await (boundaryKey.currentContext!.findRenderObject()
                        as RenderRepaintBoundary)
                    .toImage(pixelRatio: 1);
            final bytes = await image.toByteData(
              format: ui.ImageByteFormat.png,
            );
            File(
              '${output.path}/$screenshot',
            ).writeAsBytesSync(bytes!.buffer.asUint8List());
            image.dispose();
          });
          captures.add({
            'id': caseId,
            'width': width,
            'theme': themeName,
            'fontOverride': fixture['fontOverride'],
            'connectionStatus': controller.connection,
            'header': _rect(headerRect),
            'errorBanner': errorRect == null ? null : _rect(errorRect),
            'errorBannerWrapper': errorWrapperRect == null
                ? null
                : _rect(errorWrapperRect),
            'viewerBanner': viewerRect == null ? null : _rect(viewerRect),
            'viewerBannerWrapper': viewerWrapperRect == null
                ? null
                : _rect(viewerWrapperRect),
            'connectionPill': _rect(connectionRect),
            'emptyConversation': {
              'root': _rect(emptyConversationRect),
              'mark': _rect(emptyMarkRect),
              'icon': _rect(emptyIconRect),
              'heading': _rect(emptyHeadingRect),
              'description': _rect(emptyDescriptionRect),
              'knownWebGeometryDifferences': {
                'mark': _boxDifferences(emptyMarkRect, webEmptyMark),
                'icon': _boxDifferences(emptyIconRect, webEmptyIcon),
                'heading': _boxDifferences(emptyHeadingRect, webEmptyHeading),
                'description': _boxDifferences(
                  emptyDescriptionRect,
                  webEmptyDescription,
                ),
              },
            },
            'errorIcon': errorIconRect == null ? null : _rect(errorIconRect),
            'dismissIcon': dismissIconRect == null
                ? null
                : _rect(dismissIconRect),
            'geometryRelations': {
              'errorBannerTopAfterHeaderBottom': errorGap,
              'connectionCenterYFromHeaderTop': connectionCenterY,
            },
            'webReference': {
              'topbar': webHeader,
              'errorBanner': webError,
              'viewerBanner': webViewer,
              'connectionPill': webConnection,
              'emptyConversation': {
                'root': webEmptyConversation,
                'mark': webEmptyMark,
                'icon': webEmptyIcon,
                'heading': webEmptyHeading,
                'description': webEmptyDescription,
              },
              'geometryRelations': webRelations,
            },
            'screenshot': screenshot,
          });

          await tester.pumpWidget(const SizedBox.shrink());
          await tester.pumpAndSettle();
          await gateway.stream.close();
        }
      }
    }

    final document = {
      'fixture': fixture['id'],
      'reference': fixture['webRevision'],
      'fontOverride': fixture['fontOverride'],
      'captures': captures,
    };
    await tester.runAsync(() async {
      final encoded = const JsonEncoder.withIndent('  ').convert(document);
      File(
        '${output.path}/app-status-native.json',
      ).writeAsStringSync('$encoded\n');
    });
  });
}
