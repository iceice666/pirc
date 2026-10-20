import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/conversation_earlier_messages.dart';
import 'package:pirc_mobile/live/conversation_timeline.dart';
import 'package:pirc_mobile/live/gateway.dart';

import '../../test/live_test.dart' show FakeGateway, theme;
import 'capture_fonts.dart';

Json _map(dynamic value) => value is Map
    ? value.map((key, value) => MapEntry('$key', value))
    : <String, dynamic>{};

List<Json> _maps(dynamic value) =>
    value is List ? value.map(_map).toList() : <Json>[];

Map<String, double>? _bounds(WidgetTester tester, Finder finder) {
  if (finder.evaluate().isEmpty) return null;
  final rect = tester.getRect(finder.first);
  return {
    'left': rect.left,
    'top': rect.top,
    'right': rect.right,
    'bottom': rect.bottom,
    'width': rect.width,
    'height': rect.height,
  };
}

// Web article.getBoundingClientRect excludes the trailing message margin.
// TimelineMessage includes that spacing in its outer Padding; measure the
// actual inner surface so the two capture engines report the same box.
Map<String, double>? _messageBounds(WidgetTester tester, Finder anchor) =>
    _bounds(
      tester,
      find
          .descendant(of: anchor, matching: find.byType(AnimatedContainer))
          .first,
    );

List<double> _selectedValues(String variable, List<dynamic> defaults) {
  final configured = Platform.environment[variable];
  if (configured == null || configured.trim().isEmpty) {
    return defaults.map((value) => (value as num).toDouble()).toList();
  }
  return configured
      .split(',')
      .map((value) => double.parse(value.trim()))
      .toList();
}

class _HistoryGateway extends FakeGateway {
  _HistoryGateway(this.fixture) {
    final session = _map(fixture['session']);
    final model = _maps(fixture['models']).first;
    _preferences = {
      'appearance': 'system',
      'mode': 'chat',
      'detailsOpen': false,
      'sidebarCollapsed': false,
      'panelWidth': 360,
    };
    snapshot = {
      'session': session,
      'runnerEpoch': 'conversation-history-fixture',
      'messages': _maps(fixture['messages']),
      'interactions': _maps(_map(fixture['state'])['interactions']),
      'widgets': _map(_map(fixture['state'])['widgets']),
      'statuses': _map(_map(fixture['state'])['statuses']),
      'queue': _maps(_map(fixture['state'])['queue']),
      'run': _map(fixture['state'])['run'],
      'modelId': model['id'],
      'modelProvider': model['provider'],
      'thinking': 'medium',
    };
  }

  final Json fixture;
  late Json _preferences;
  final requests = <Json>[];

  @override
  dynamic normal(String method, Json args) {
    if (method == 'boot') {
      return {
        'origin': 'https://gateway.example',
        'clientId': 'conversation-history-fixture',
        'targetSession': _map(fixture['session'])['id'],
        'onboardingComplete': true,
      };
    }
    if (method == 'preferences') return Map<String, dynamic>.of(_preferences);
    if (method == 'savePreferences') {
      _preferences = {..._preferences, ...args};
      return Map<String, dynamic>.of(_preferences);
    }
    if (method == 'request') {
      final path = '${args['path']}';
      requests.add({'path': path, 'method': args['method'] ?? 'GET'});
      if (path == '/api/sessions') {
        final session = _map(fixture['session']);
        return {
          'sessions': [
            {
              ...session,
              'updatedAt': DateTime.parse(
                '${session['lastActivityAt']}',
              ).millisecondsSinceEpoch,
              'runStatus': session['runnerStatus'] ?? 'stopped',
            },
          ],
        };
      }
      if (path == '/api/workspaces') {
        return {'workspaces': _maps(fixture['workspaces'])};
      }
      if (path == '/api/nodes') return {'nodes': _maps(fixture['nodes'])};
      if (path.startsWith('/api/models')) {
        return {'models': _maps(fixture['models'])};
      }
      if (path == '/api/memory') return <String, dynamic>{};
      final sessionId = '${_map(fixture['session'])['id']}';
      if (path == '/api/sessions/$sessionId/read') return <String, dynamic>{};
      throw StateError('Unexpected history-fixture request: $path');
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
        'data': {'held': true, 'holderName': 'This device', 'generation': 7},
      });
      stream.add({'type': 'connection', 'sessionId': id, 'data': 'live'});
    }
    return result;
  }
}

void main() {
  final fixture = _map(
    jsonDecode(
      File(
        '../../fixtures/mobile-parity/conversation-history.json',
      ).readAsStringSync(),
    ),
  );
  final sourceMessages = _maps(fixture['messages']);
  final expectedHidden = {'initial60': 85, 'revealed120': 25, 'final145': 0};
  final expectedCount = {'initial60': 60, 'revealed120': 120, 'final145': 145};

  testWidgets('capture actual native long-history page transitions', (t) async {
    await t.runAsync(loadParityFonts);
    addTearDown(() {
      t.view.reset();
      t.platformDispatcher.clearPlatformBrightnessTestValue();
      t.platformDispatcher.clearTextScaleFactorTestValue();
    });

    final output = Directory('build/parity/conversation-history-native')
      ..createSync(recursive: true);
    final captures = <Json>[];
    final widths = _selectedValues(
      'PARITY_CAPTURE_WIDTHS',
      fixture['widths'] as List,
    );
    final textScales = _selectedValues(
      'PARITY_CAPTURE_SCALES',
      fixture['textScales'] as List,
    );

    for (final width in widths) {
      for (final brightness in Brightness.values) {
        final themeName = brightness.name;
        t.platformDispatcher.platformBrightnessTestValue = brightness;
        for (final textScale in textScales) {
          t.platformDispatcher.textScaleFactorTestValue = textScale;
          t.view.devicePixelRatio = (fixture['deviceScaleFactor'] as num)
              .toDouble();
          t.view.physicalSize = Size(
            width * (fixture['deviceScaleFactor'] as num).toDouble(),
            (fixture['height'] as num).toDouble() *
                (fixture['deviceScaleFactor'] as num).toDouble(),
          );

          final gateway = _HistoryGateway(fixture);
          final controller = LiveController(gateway);
          final boundaryKey = GlobalKey();
          await t.pumpWidget(
            RepaintBoundary(
              key: boundaryKey,
              child: MobileApp(theme: theme, controller: controller),
            ),
          );
          await t.pumpAndSettle();
          expect(controller.sessionId, _map(fixture['session'])['id']);
          expect(controller.connection, 'live');
          expect(controller.messages, hasLength(145));

          final scroll = t
              .widget<CustomScrollView>(find.byType(CustomScrollView))
              .controller!;
          final anchor = find.byKey(
            ValueKey<String>(fixture['readingAnchorId'] as String),
          );
          final earlierFinder = find.byType(ConversationEarlierMessages);

          final initial = _captureState(
            t,
            controller,
            'initial60',
            sourceMessages,
            expectedHidden['initial60']!,
            expectedCount['initial60']!,
            fixture['readingAnchorId'] as String,
          );
          await _saveScreenshot(
            t,
            boundaryKey,
            output,
            'initial60',
            width,
            themeName,
            textScale,
          );
          captures.add(_captureRow(initial, width, themeName, textScale));

          var buttonBottom = _buttonBottomContentOffset(
            t,
            scroll,
            earlierFinder,
          );
          scroll.jumpTo(buttonBottom + 201);
          await t.pumpAndSettle();
          expect(controller.hiddenMessages, 85);
          final anchorBefore = _messageBounds(t, anchor)!;
          final earlierButtonBefore = _buttonEvidence(t, earlierFinder);
          final scrollBefore = _scrollEvidence(scroll.position);
          scroll.jumpTo(buttonBottom + 199);
          await t.pump();
          await t.pumpAndSettle();
          expect(controller.hiddenMessages, 25);
          final revealed = _captureState(
            t,
            controller,
            'revealed120',
            sourceMessages,
            expectedHidden['revealed120']!,
            expectedCount['revealed120']!,
            fixture['readingAnchorId'] as String,
          );
          final anchorRetention = _measureAnchorRetention(
            anchorBefore,
            revealed['readingAnchor'] as Json,
            (fixture['anchorBoxToleranceCssPixels'] as num).toDouble(),
          );
          await _saveScreenshot(
            t,
            boundaryKey,
            output,
            'revealed120',
            width,
            themeName,
            textScale,
          );
          captures.add({
            ..._captureRow(revealed, width, themeName, textScale),
            'anchorBefore': anchorBefore,
            'anchorAfter': revealed['readingAnchor'],
            'anchorRetention': anchorRetention,
            'anchorDeltaCssPixels':
                ((revealed['readingAnchor'] as Json)['top'] as num).toDouble() -
                (anchorBefore['top'] as num).toDouble(),
            'earlierButtonBefore': earlierButtonBefore,
            'earlierButtonAfter': revealed['earlierButtonStyle'],
            'scrollBefore': scrollBefore,
            'scrollAfter': revealed['scroll'],
            'contentExtentDelta':
                ((revealed['scroll'] as Json)['contentExtent'] as num)
                    .toDouble() -
                (scrollBefore['contentExtent'] as num).toDouble(),
            'maxExtentDelta':
                ((revealed['scroll'] as Json)['maxExtent'] as num).toDouble() -
                (scrollBefore['maxExtent'] as num).toDouble(),
          });

          buttonBottom = _buttonBottomContentOffset(t, scroll, earlierFinder);
          scroll.jumpTo(buttonBottom + 201);
          await t.pumpAndSettle();
          expect(controller.hiddenMessages, 25);
          scroll.jumpTo(buttonBottom + 199);
          await t.pump();
          await t.pumpAndSettle();
          expect(controller.hiddenMessages, 0);
          expect(earlierFinder, findsNothing);
          final finalState = _captureState(
            t,
            controller,
            'final145',
            sourceMessages,
            expectedHidden['final145']!,
            expectedCount['final145']!,
            fixture['readingAnchorId'] as String,
          );
          await _saveScreenshot(
            t,
            boundaryKey,
            output,
            'final145',
            width,
            themeName,
            textScale,
          );
          captures.add(_captureRow(finalState, width, themeName, textScale));

          expect(
            t.takeException(),
            isNull,
            reason: '$width/$themeName/$textScale',
          );
          await t.pumpWidget(const SizedBox.shrink());
          await t.pumpAndSettle();
          await gateway.stream.close();
        }
      }
    }

    final expectedCaptures = widths.length * 2 * textScales.length * 3;
    expect(captures, hasLength(expectedCaptures));
    expect(captures.map(_tupleKey).toSet(), hasLength(expectedCaptures));
    await t.runAsync(() async {
      final manifest = {
        'fixture': fixture['id'],
        'webRevision': fixture['webRevision'],
        'fontOverride': fixture['fontOverride'],
        'widths': widths,
        'themes': Brightness.values.map((value) => value.name).toList(),
        'textScales': textScales,
        'anchorBoxToleranceCssPixels': fixture['anchorBoxToleranceCssPixels'],
        'anchorBoxToleranceNote': fixture['anchorBoxToleranceNote'],
        'states': fixture['states'],
        'captures': captures,
      };
      File('${output.path}/conversation-history-native.json').writeAsStringSync(
        '${const JsonEncoder.withIndent('  ').convert(manifest)}\n',
      );
    });
  });
}

Json _captureState(
  WidgetTester tester,
  LiveController controller,
  String state,
  List<Json> source,
  int expectedHidden,
  int expectedCount,
  String anchorId,
) {
  expect(controller.hiddenMessages, expectedHidden, reason: state);
  expect(
    controller.messages,
    source,
    reason: '$state full source tuples preserved',
  );
  final timelineFinder = find.byType(TimelineMessage);
  final renderedIds = tester
      .widgetList<TimelineMessage>(timelineFinder)
      .map((message) => '${message.message['id']}')
      .toList();
  final expectedIds = source
      .skip(expectedHidden)
      .map((message) => '${message['id']}')
      .toList();
  expect(renderedIds, hasLength(expectedCount), reason: state);
  expect(
    renderedIds.toSet(),
    hasLength(expectedCount),
    reason: '$state duplicate IDs',
  );
  expect(renderedIds, expectedIds, reason: '$state missing/reordered IDs');
  final anchor = find.byKey(ValueKey(anchorId));
  final anchorRect = _messageBounds(tester, anchor);
  expect(anchorRect, isNotNull, reason: '$state reading anchor box');
  final earlier = find.byType(ConversationEarlierMessages);
  final earlierButton = earlier.evaluate().isEmpty
      ? null
      : _bounds(
          tester,
          find.byKey(
            tester.widget<ConversationEarlierMessages>(earlier).buttonKey!,
          ),
        );
  return {
    'state': state,
    'hiddenMessages': controller.hiddenMessages,
    'messageCount': controller.messages.length,
    'sourceMatchesFixture': true,
    'sourceUniqueIdCount': source
        .map((message) => message['id'])
        .toSet()
        .length,
    'renderedIds': renderedIds,
    'readingAnchorId': anchorId,
    'readingAnchor': anchorRect,
    'earlierButton': earlierButton,
    'earlierButtonStyle': _buttonEvidence(
      tester,
      find.byType(ConversationEarlierMessages),
    ),
    'scroll': _scrollEvidence(
      Scrollable.of(tester.element(find.byType(ConversationTimeline))).position,
    ),
  };
}

Json? _buttonEvidence(WidgetTester tester, Finder earlierFinder) {
  if (earlierFinder.evaluate().isEmpty) return null;
  final control = tester.widget<ConversationEarlierMessages>(earlierFinder);
  final buttonFinder = find.byKey(control.buttonKey!);
  final decorated = tester.widget<DecoratedBox>(buttonFinder);
  final decoration = decorated.decoration as BoxDecoration;
  final border = decoration.border;
  final button = find.descendant(
    of: earlierFinder,
    matching: find.byType(TextButton),
  );
  final text = find.descendant(of: button, matching: find.byType(Text));
  return {
    'outerBox': _bounds(tester, buttonFinder),
    'textButtonBox': _bounds(tester, button),
    'textBox': _bounds(tester, text),
    'text': tester.widget<Text>(text).data,
    'borderTopWidth': border is Border ? border.top.width : null,
  };
}

Json _scrollEvidence(ScrollPosition scroll) => {
  'pixels': scroll.pixels,
  'minExtent': scroll.minScrollExtent,
  'maxExtent': scroll.maxScrollExtent,
  'viewport': scroll.viewportDimension,
  'contentExtent':
      scroll.maxScrollExtent -
      scroll.minScrollExtent +
      scroll.viewportDimension,
};

double _buttonBottomContentOffset(
  WidgetTester tester,
  ScrollController scroll,
  Finder earlierFinder,
) {
  final control = tester.widget<ConversationEarlierMessages>(earlierFinder);
  final buttonRect = tester.getRect(find.byKey(control.buttonKey!));
  final viewportRect = tester.getRect(find.byType(CustomScrollView));
  return buttonRect.bottom - viewportRect.top + scroll.offset;
}

Json _measureAnchorRetention(Json before, Json after, double tolerance) {
  final deltas = <String, double>{};
  for (final side in ['left', 'top', 'right', 'bottom', 'width', 'height']) {
    deltas[side] =
        (after[side] as num).toDouble() - (before[side] as num).toDouble();
  }
  final maximumAbsoluteDelta = deltas.values
      .map((delta) => delta.abs())
      .reduce((first, second) => first > second ? first : second);
  return {
    'toleranceCssPixels': tolerance,
    'withinTolerance': maximumAbsoluteDelta <= tolerance,
    'maximumAbsoluteDeltaCssPixels': maximumAbsoluteDelta,
    'deltas': deltas,
  };
}

String _tupleKey(Json row) =>
    '${row['width']}/${row['theme']}/${row['textScale']}/${row['state']}';

Json _captureRow(Json result, double width, String themeName, double scale) => {
  ...result,
  'width': width,
  'theme': themeName,
  'textScale': scale,
};

Future<void> _saveScreenshot(
  WidgetTester tester,
  GlobalKey boundaryKey,
  Directory output,
  String state,
  double width,
  String themeName,
  double textScale,
) async {
  final filename =
      '$state-${width.toInt()}-$themeName-scale${textScale.toInt()}.png';
  await tester.runAsync(() async {
    final image =
        await (boundaryKey.currentContext!.findRenderObject()
                as RenderRepaintBoundary)
            .toImage(pixelRatio: 1);
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    File(
      '${output.path}/$filename',
    ).writeAsBytesSync(bytes!.buffer.asUint8List());
    image.dispose();
  });
}
