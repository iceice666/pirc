import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/browser_state.dart';
import 'package:pirc_mobile/live/browser_pane.dart';
import 'package:pirc_mobile/live/recording_player.dart';
import 'package:pirc_mobile/live/timeline_tools.dart';
import 'live_test.dart' show FakeGateway, theme;

final Json browserFixture = obj(
  jsonDecode(
    File('../../fixtures/mobile-parity/browser.json').readAsStringSync(),
  ),
);
void browserFrame(FakeGateway g, String tag, Json frame) => g.stream.add({
  'type': 'socket',
  'data': {'tag': tag, 'frame': frame},
});
void main() {
  testWidgets('old media menu cannot download a replacement recording', (
    t,
  ) async {
    final g = FakeGateway(), source = ValueNotifier('.pirc/recordings/a.webm');
    var id = 0;
    g.handler = (method, args) async => method == 'recordingOpen'
        ? {'id': ++id, 'width': 640, 'height': 400, 'duration': 1000}
        : null;
    await t.pumpWidget(
      MaterialApp(
        theme: theme.build(Brightness.light),
        home: Scaffold(
          body: ValueListenableBuilder<String>(
            valueListenable: source,
            builder: (_, path, _) =>
                NativeRecordingPlayer(gateway: g, session: 's', path: path),
          ),
        ),
      ),
    );
    await t.pumpAndSettle();
    await t.tap(find.byTooltip('More media controls'));
    await t.pumpAndSettle();
    source.value = '.pirc/recordings/b.webm';
    await t.pumpAndSettle();
    await t.tap(find.text('Download'));
    await t.pumpAndSettle();
    expect(g.calls.where((c) => c.$1 == 'recordingSave'), isEmpty);
    expect(t.widget<Texture>(find.byType(Texture)).textureId, 2);
    expect(t.takeException(), isNull);
    await t.pumpWidget(const SizedBox());
    await t.pump();
    source.dispose();
    await g.stream.close();
  });

  testWidgets(
    'recording rates match browser fixture and commit only on success',
    (t) async {
      final fixture = obj(
        jsonDecode(
          File(
            '../../fixtures/mobile-parity/recording-controls-web.json',
          ).readAsStringSync(),
        ),
      );
      expect(
        RecordingState.playbackRates,
        (fixture['rateResults'] as List).map((v) => v['actual']),
      );
      final g = FakeGateway();
      final data = <String, dynamic>{
        'id': 10,
        'duration': 5000,
        'position': 0,
        'playing': false,
      };
      g.handler = (_, _) async => data;
      final player = RecordingState(g, 's', '.pirc/recordings/a.webm');
      await t.pump();
      final pending = Completer<Json>();
      g.handler = (_, a) async => a['action'] == 'rate' ? pending.future : data;
      final change = player.setPlaybackRate(1.5);
      expect(player.playbackRate, 1);
      expect(player.changingRate, isTrue);
      await player.setPlaybackRate(2);
      expect(g.calls.where((c) => c.$2['action'] == 'rate'), hasLength(1));
      expect(g.calls.last.$2['rate'], 1.5);
      pending.complete({...data, 'rate': 1.5});
      await change;
      expect(player.playbackRate, 1.5);
      expect(player.playing, isFalse);
      g.handler = (_, a) async {
        if (a['action'] == 'rate') throw StateError('decoder rejected speed');
        return data;
      };
      await player.setPlaybackRate(2);
      expect(player.playbackRate, 1.5);
      expect(player.error, isNotNull);
      final count = g.calls.length;
      await player.setPlaybackRate(0);
      expect(g.calls, hasLength(count));
      g.handler = (_, _) async => {...data, 'rate': 1, 'playing': true};
      await player.setPlaybackRate(1);
      expect(player.playbackRate, 1);
      expect(player.playing, isTrue);
      expect(player.error, isNull);
      player.dispose();
      await t.pump();
      await g.stream.close();
    },
  );

  testWidgets('recording speed menu selects the native rate at phone width', (
    t,
  ) async {
    t.view.devicePixelRatio = 1;
    t.view.physicalSize = const Size(390, 844);
    addTearDown(t.view.reset);
    final g = FakeGateway();
    g.handler = (_, a) async => {
      'id': 10,
      'width': 640,
      'height': 400,
      'duration': 5000,
      'playing': false,
      'rate': a['rate'] ?? 1,
    };
    await t.pumpWidget(
      MaterialApp(
        theme: theme.build(Brightness.light),
        home: Scaffold(
          body: NativeRecordingPlayer(
            gateway: g,
            session: 's',
            path: '.pirc/recordings/a.webm',
          ),
        ),
      ),
    );
    await t.pumpAndSettle();
    await t.tap(find.byTooltip('More media controls'));
    await t.pumpAndSettle();
    await t.tap(find.text('Playback speed'));
    await t.pumpAndSettle();
    expect(find.byType(PopupMenuItem<String>), findsNWidgets(9));
    await t.tap(find.text('1.5'));
    await t.pumpAndSettle();
    expect(
      g.calls.singleWhere((c) => c.$2['action'] == 'rate').$2['rate'],
      1.5,
    );
    await t.tap(find.byTooltip('More media controls'));
    await t.pumpAndSettle();
    await t.tap(find.text('Playback speed'));
    await t.pumpAndSettle();
    expect(
      t
          .widget<Semantics>(find.byKey(const ValueKey('recording-rate-1.5')))
          .properties
          .checked,
      isTrue,
    );
    await t.tap(find.text('Playback speed'));
    await t.pumpAndSettle();
    expect(find.text('Download'), findsOneWidget);
    await t.tap(find.text('Download'));
    await t.pumpAndSettle();
    expect(g.calls.singleWhere((c) => c.$1 == 'recordingSave').$2, {
      'sessionId': 's',
      'path': '.pirc/recordings/a.webm',
    });
    expect(t.takeException(), isNull);
    await t.pumpWidget(const SizedBox());
    await t.pump();
    await g.stream.close();
  });

  testWidgets('replacing fullscreen recording removes only its own route', (
    t,
  ) async {
    final g = FakeGateway();
    var id = 0;
    g.handler = (method, args) async => method == 'recordingOpen'
        ? {'id': ++id, 'width': 640, 'height': 400, 'duration': 1000}
        : null;
    final source = ValueNotifier('.pirc/recordings/a.webm');
    await t.pumpWidget(
      MaterialApp(
        theme: theme.build(Brightness.light),
        home: Scaffold(
          body: ValueListenableBuilder<String>(
            valueListenable: source,
            builder: (_, path, _) =>
                NativeRecordingPlayer(gateway: g, session: 's', path: path),
          ),
        ),
      ),
    );
    await t.pumpAndSettle();
    await t.tap(find.byTooltip('Fullscreen recording'));
    await t.pumpAndSettle();
    expect(find.byTooltip('Exit fullscreen'), findsOneWidget);
    unawaited(
      showDialog<void>(
        context: t.element(find.byType(Dialog)),
        builder: (_) => const AlertDialog(title: Text('Unrelated dialog')),
      ),
    );
    await t.pumpAndSettle();
    source.value = '.pirc/recordings/b.webm';
    await t.pumpAndSettle();
    expect(find.text('Unrelated dialog'), findsOneWidget);
    expect(
      find.byTooltip('Exit fullscreen', skipOffstage: false),
      findsNothing,
    );
    Navigator.of(t.element(find.text('Unrelated dialog'))).pop();
    await t.pumpAndSettle();
    expect(t.widget<Texture>(find.byType(Texture)).textureId, 2);
    expect(t.takeException(), isNull);
    await t.pumpWidget(const SizedBox());
    await t.pump();
    source.dispose();
    await g.stream.close();
  });

  testWidgets(
    'recording source replacement closes old player and ignores old download',
    (t) async {
      final g = FakeGateway(), download = Completer<String>();
      var id = 0;
      g.handler = (method, args) async {
        if (method == 'recordingSave') return download.future;
        if (method == 'recordingOpen') {
          return {'id': ++id, 'width': 640, 'height': 400, 'duration': 1000};
        }
        return null;
      };
      Widget host(String path) => MaterialApp(
        theme: theme.build(Brightness.light),
        home: Scaffold(
          body: NativeRecordingPlayer(gateway: g, session: 's', path: path),
        ),
      );
      await t.pumpWidget(host('.pirc/recordings/a.webm'));
      await t.pumpAndSettle();
      await t.tap(find.text('.pirc/recordings/a.webm'));
      await t.pump();
      await t.pumpWidget(host('.pirc/recordings/b.webm'));
      await t.pumpAndSettle();
      expect(
        g.calls.where((c) => c.$1 == 'recordingOpen').map((c) => c.$2['path']),
        ['.pirc/recordings/a.webm', '.pirc/recordings/b.webm'],
      );
      expect(g.calls.where((c) => c.$1 == 'recordingClose').single.$2['id'], 1);
      expect(t.widget<Texture>(find.byType(Texture)).textureId, 2);
      expect(
        t
            .widget<TextButton>(
              find.widgetWithText(TextButton, '.pirc/recordings/b.webm'),
            )
            .onPressed,
        isNotNull,
      );
      download.complete('Old download finished');
      await t.pumpAndSettle();
      expect(find.text('Old download finished'), findsNothing);
      await t.pumpWidget(const SizedBox());
      await t.pump();
      expect(g.calls.where((c) => c.$1 == 'recordingClose').last.$2['id'], 2);
      await g.stream.close();
    },
  );

  testWidgets(
    'recording mute waits for success and preserves state on failure',
    (t) async {
      final g = FakeGateway();
      final data = <String, dynamic>{
        'id': 10,
        'duration': 5000,
        'position': 0,
        'playing': false,
      };
      g.handler = (_, _) async => data;
      final player = RecordingState(g, 's', '.pirc/recordings/a.webm');
      await t.pump();
      final pending = Completer<Json>();
      g.handler = (_, a) async =>
          a['action'] == 'volume' ? pending.future : data;
      final first = player.toggleMute();
      expect(player.muted, isFalse);
      await player.toggleMute();
      expect(g.calls.where((c) => c.$2['action'] == 'volume'), hasLength(1));
      // A status response must not prevent an acknowledged volume change.
      await player.command('status');
      pending.complete(data);
      await first;
      expect(player.muted, isTrue);
      g.handler = (_, a) async {
        if (a['action'] == 'volume') throw StateError('volume unavailable');
        return data;
      };
      await player.toggleMute();
      expect(player.muted, isTrue);
      expect(player.error, isNotNull);
      g.handler = (_, _) async => data;
      await player.toggleMute();
      expect(player.muted, isFalse);
      expect(player.error, isNull);
      player.dispose();
      await t.pump();
      await g.stream.close();
    },
  );

  testWidgets(
    'browser hidden lifecycle, scope reset, reconnect and unavailable',
    (t) async {
      final g = FakeGateway(), c = LiveController(g)..sessionId = 's';
      g.handler = (_, _) async => null;
      final s = BrowserState(c);
      expect(g.calls, isEmpty);
      s.setActive(true);
      await t.pump();
      final first = s.tag!;
      browserFrame(g, first, {
        'type': 'state',
        'state': browserFixture['state'],
      });
      expect(s.connected, true);
      s.setActive(false);
      expect(s.tag, isNull);
      browserFrame(g, first, {
        'type': 'frame',
        'data': browserFixture['image'],
        'width': 640,
        'height': 400,
      });
      expect(s.image, isNull);
      s.setActive(true);
      await t.pump();
      expect(s.tag, isNot(first));
      g.stream.add({
        'type': 'socketClosed',
        'data': {'tag': s.tag, 'code': 1006},
      });
      expect(s.notice, 'Reconnecting…');
      await t.pump(const Duration(milliseconds: 500));
      expect(s.tag, isNotNull);
      g.stream.add({
        'type': 'socketClosed',
        'data': {'tag': s.tag, 'code': 4403, 'message': 'Browser disabled'},
      });
      expect(s.unavailable, 'Browser disabled');
      final count = g.calls.length;
      await t.pump(const Duration(seconds: 12));
      expect(g.calls.length, count);
      c.sessionId = 'next';
      c.changed();
      await t.pump();
      expect(s.unavailable, '');
      expect(s.view, isNull);
      expect(s.tag, isNotNull);
      s.dispose();
      c.dispose();
      await g.stream.close();
      await t.pump();
    },
  );
  testWidgets(
    'browser lease guards, URL edits, replay race and 150-entry log',
    (t) async {
      final g = FakeGateway(),
          c = LiveController(g)
            ..sessionId = 's'
            ..clientId = 'phone';
      g.handler = (_, _) async => null;
      final s = BrowserState(c)..setActive(true);
      await t.pump();
      browserFrame(g, s.tag!, {
        'type': 'state',
        'state': browserFixture['state'],
      });
      s.urlDraft = 'https://fixture.example/new';
      s.editingUrl = true;
      browserFrame(g, s.tag!, {
        'type': 'state',
        'state': {
          ...obj(browserFixture['state']),
          'url': 'https://server.example/',
        },
      });
      expect(s.urlDraft, 'https://fixture.example/new');
      await s.navigate();
      expect(s.notice, contains('Take control'));
      expect(
        g.calls.where((x) => x.$1 == 'control' || x.$1 == 'socketSend'),
        isEmpty,
      );
      c.control = {'held': true, 'generation': 4};
      c.changed();
      await s.navigate();
      final sent = g.calls.where((x) => x.$1 == 'socketSend').toList();
      expect(sent.map((x) => x.$2['data']['type']), ['takeover', 'navigate']);
      expect(sent.last.$2['data']['generation'], 4);
      browserFrame(g, s.tag!, {
        'type': 'log',
        'entries': browserFixture['log'],
      });
      s.openReplay(s.log.first);
      s.step(1);
      expect(s.replayIndex, 3);
      browserFrame(g, s.tag!, {
        'type': 'log_image',
        'index': 1,
        'data': browserFixture['image'],
      });
      expect(s.replayImage, isNull);
      browserFrame(g, s.tag!, {
        'type': 'log_image',
        'index': 3,
        'data': browserFixture['image'],
      });
      expect(s.replayImage, isNotNull);
      for (var i = 4; i < 160; i++) {
        browserFrame(g, s.tag!, {
          'type': 'log_entry',
          'entry': {'index': i, 'action': 'Step $i', 'image': false},
        });
      }
      expect(s.log.length, 150);
      expect(s.log.last['index'], 159);
      s.live();
      expect(s.replayIndex, isNull);
      s.dispose();
      c.dispose();
      await g.stream.close();
      await t.pump();
    },
  );
  for (final scale in [1.0, 2.0]) {
    testWidgets('browser native UI, pointer, IME and replay at $scale text', (
      t,
    ) async {
      t.view.devicePixelRatio = 1;
      t.view.physicalSize = const Size(390, 1000);
      addTearDown(t.view.reset);
      final g = FakeGateway(),
          c = LiveController(g)
            ..sessionId = 's'
            ..control = {'held': true, 'generation': 2};
      g.handler = (_, _) async => null;
      await t.pumpWidget(
        MaterialApp(
          theme: theme.build(Brightness.light),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(
              context,
            ).copyWith(textScaler: TextScaler.linear(scale)),
            child: child!,
          ),
          home: Scaffold(body: BrowserPane(controller: c)),
        ),
      );
      await t.pumpAndSettle();
      final tag =
          g.calls.lastWhere((x) => x.$1 == 'socketOpen').$2['tag'] as String;
      browserFrame(g, tag, {
        'type': 'state',
        'state': {
          ...obj(browserFixture['state']),
          'mode': 'user',
          'handoff': 'Please finish the form.',
        },
      });
      browserFrame(g, tag, {
        'type': 'frame',
        'data': browserFixture['image'],
        'width': 640,
        'height': 400,
      });
      browserFrame(g, tag, {'type': 'log', 'entries': browserFixture['log']});
      await t.pumpAndSettle();
      final screen = find.byKey(const ValueKey('browser-live-screen'));
      await t.tapAt(t.getCenter(screen));
      await t.pump();
      final down = g.calls
          .lastWhere(
            (x) => x.$1 == 'socketSend' && x.$2['data']['action'] == 'down',
          )
          .$2['data'];
      expect(down['x'], closeTo(320, 5));
      expect(down['y'], closeTo(200, 5));
      final input = find.byWidgetPredicate(
        (w) =>
            w is TextField &&
            w.decoration?.labelText == 'Type into the browser',
      );
      final field = t.widget<TextField>(input), ctrl = field.controller!;
      final before = g.calls.length;
      ctrl.value = const TextEditingValue(
        text: '\u200b注音',
        composing: TextRange(start: 1, end: 3),
        selection: TextSelection.collapsed(offset: 3),
      );
      await t.pump();
      expect(g.calls.length, before);
      ctrl.value = const TextEditingValue(
        text: '\u200b注音',
        selection: TextSelection.collapsed(offset: 3),
      );
      await t.pump();
      expect(g.calls.last.$2['data']['text'], '注音');
      await t.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
      await t.pump();
      expect(g.calls.last.$2['data']['key'], 'ArrowLeft');
      await t.tap(find.byTooltip('Activity and replay'));
      await t.pumpAndSettle();
      final last = find.byKey(const ValueKey('browser-log-3'));
      await t.ensureVisible(last);
      await t.tap(last);
      await t.pumpAndSettle();
      expect(g.calls.last.$2['data']['index'], 3);
      browserFrame(g, tag, {
        'type': 'log_image',
        'index': 3,
        'data': browserFixture['image'],
      });
      await t.pumpAndSettle();
      expect(find.byTooltip('Previous step'), findsOneWidget);
      expect(t.takeException(), isNull);
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
      await t.pump();
    });
  }
  testWidgets('recording late open disposal, controls and resource cleanup', (
    t,
  ) async {
    final g = FakeGateway(), pending = Completer<Json>();
    g.handler = (_, _) => pending.future;
    final s = RecordingState(g, 's', '.pirc/recordings/a.webm');
    s.dispose();
    g.handler = (_, _) async => null;
    pending.complete({'id': 9, 'width': 640, 'height': 400});
    await t.pump();
    expect(g.calls.last.$1, 'recordingClose');
    expect(g.calls.last.$2['id'], 9);
    g.handler = (method, a) async => {
      'id': 10,
      'width': 640,
      'height': 400,
      'duration': 5000,
      'position': a['position'] ?? 0,
      'playing': a['action'] == 'play',
    };
    final player = RecordingState(g, 's', '.pirc/recordings/a.webm');
    await t.pump();
    expect(player.ratio, 1.6);
    await player.command('play');
    expect(player.playing, true);
    await player.command('seek', position: 2000);
    expect(player.position, 2000);
    await player.toggleMute();
    expect(g.calls.last.$2['volume'], 0);
    player.dispose();
    await t.pump();
    expect(g.calls.last.$1, 'recordingClose');
    await g.stream.close();
  });
  testWidgets('recording ignores a stale status response after pause', (
    t,
  ) async {
    final g = FakeGateway(), pending = Completer<Json>();
    final data = {
      'id': 10,
      'width': 640,
      'height': 400,
      'duration': 5000,
      'position': 1000,
      'playing': true,
    };
    g.handler = (_, _) async => data;
    final player = RecordingState(g, 's', '.pirc/recordings/a.webm');
    await t.pump();
    g.handler = (_, a) async =>
        a['action'] == 'status' ? pending.future : {...data, 'playing': false};
    final old = player.command('status');
    await player.command('pause');
    pending.complete(data);
    await old;
    expect(player.playing, false);
    player.dispose();
    await t.pump();
    await g.stream.close();
  });
  testWidgets('native recording fullscreen fits landscape with large text', (
    t,
  ) async {
    t.view.devicePixelRatio = 1;
    t.view.physicalSize = const Size(700, 360);
    addTearDown(t.view.reset);
    final g = FakeGateway();
    g.handler = (_, _) async => {
      'id': 10,
      'width': 640,
      'height': 400,
      'duration': 5000,
      'position': 0,
      'playing': false,
    };
    await t.pumpWidget(
      MaterialApp(
        theme: theme.build(Brightness.dark),
        builder: (_, child) => MediaQuery(
          data: const MediaQueryData(
            size: Size(700, 360),
            textScaler: TextScaler.linear(2),
          ),
          child: child!,
        ),
        home: Scaffold(
          body: SingleChildScrollView(
            child: NativeRecordingPlayer(
              gateway: g,
              session: 's',
              path: '.pirc/recordings/a.webm',
            ),
          ),
        ),
      ),
    );
    await t.pump();
    await t.ensureVisible(find.byTooltip('Fullscreen recording'));
    await t.tap(find.byTooltip('Fullscreen recording'));
    await t.pumpAndSettle();
    expect(find.byTooltip('Exit fullscreen'), findsOneWidget);
    expect(t.takeException(), isNull);
    await t.tap(find.byTooltip('Exit fullscreen'));
    await t.pumpAndSettle();
    await t.pumpWidget(const SizedBox());
    await g.stream.close();
  });
  testWidgets(
    'tool recording remains inline when collapsed and limits tall video height',
    (t) async {
      final g = FakeGateway();
      final controller = LiveController(g)..sessionId = 's';
      g.handler = (_, _) async => {
        'id': 12,
        'width': 320,
        'height': 1000,
        'duration': 3000,
        'position': 0,
        'playing': false,
      };
      await t.pumpWidget(
        MaterialApp(
          theme: theme.build(Brightness.light),
          home: Scaffold(
            body: SingleChildScrollView(
              child: TimelineTool(
                controller: controller,
                tool: {
                  'id': 'record',
                  'name': 'browser_record',
                  'status': 'done',
                  'input': {'action': 'stop'},
                  'recording': '.pirc/recordings/a.webm',
                },
              ),
            ),
          ),
        ),
      );
      await t.pump();
      expect(find.byType(Texture), findsOneWidget);
      expect(find.text('Play recording'), findsNothing);
      expect(find.text('.pirc/recordings/a.webm'), findsNothing);
      expect(
        t.getSize(find.byType(NativeRecordingPlayer)).height,
        lessThanOrEqualTo(420),
      );
      await t.tap(find.byTooltip('Play recording'));
      await t.pump();
      expect(
        g.calls.where((x) => x.$1 == 'recordingControl').last.$2['action'],
        'play',
      );
      expect(
        g.calls.any((x) => x.$1 == 'recording' || x.$1 == 'external'),
        false,
      );
      await t.pumpWidget(const SizedBox());
      await t.pump();
      expect(g.calls.last.$1, 'recordingClose');
      controller.dispose();
      await g.stream.close();
    },
  );
}
