import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/browser_pane.dart';
import 'package:pirc_mobile/live/recording_player.dart';
import 'package:pirc_mobile/theme.dart';

class BrowserTestGateway extends Gateway {
  @override
  Future<dynamic> call(String method, [Json args = const {}]) {
    if (method == 'socketSend') debugPrint('BROWSER_INPUT:${args['data']}');
    return super.call(method, args);
  }
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'real Android browser navigate input record replay and native playback',
    (t) async {
      const id = String.fromEnvironment('PIRC_BROWSER_SESSION'),
          url = String.fromEnvironment('PIRC_BROWSER_URL');
      expect(const bool.fromEnvironment('PIRC_REAL_GATEWAY'), true);
      expect(id.isNotEmpty, true, reason: 'Start helper with --browser.');
      final g = BrowserTestGateway();
      await g.call('pair', {
        'link': const String.fromEnvironment('PIRC_PAIR_LINK'),
      });
      await g.call('completeOnboarding');
      final c = LiveController(g), theme = await PircTheme.load();
      Future<void> until(bool Function() ready, String step) async {
        for (var i = 0; i < 200 && !ready(); i++) {
          await t.pump(const Duration(milliseconds: 200));
        }
        expect(ready(), true, reason: step);
        await t.pump();
        expect(t.takeException(), isNull, reason: step);
        debugPrint('BROWSER_STEP:$step');
      }

      Future<void> tap(Finder f) async {
        await t.ensureVisible(f);
        await t.pump(const Duration(milliseconds: 100));
        await t.tap(f);
        await t.pump(const Duration(milliseconds: 300));
      }

      Finder address() => find.byWidgetPredicate(
        (w) => w is TextField && w.keyboardType == TextInputType.url,
      );
      Finder hiddenInput() => find.byWidgetPredicate(
        (w) =>
            w is TextField &&
            w.decoration?.labelText == 'Type into the browser',
      );
      try {
        await t.pumpWidget(MobileApp(theme: theme, controller: c));
        await until(
          () => !c.booting && c.workspaces.any((w) => w['id'] == 'git:fixture'),
          'boot',
        );
        await tap(find.text('Work'));
        await tap(find.text('Native Git workspace').first);
        await until(
          () => find.text('Native Git fixture').evaluate().isNotEmpty,
          'fixture',
        );
        await tap(find.text('Native Git fixture'));
        await until(() => c.sessionId == id && c.state.isNotEmpty, 'session');
        await c.takeControl();
        await until(() => c.control['held'] == true, 'lease');
        await tap(find.byTooltip('Show side panel'));
        await tap(find.byKey(const ValueKey('panel-tab-browser')));
        await until(
          () =>
              find.byType(BrowserPane).evaluate().isNotEmpty &&
              address().evaluate().isNotEmpty,
          'browser',
        );
        await t.enterText(address(), url);
        await t.testTextInput.receiveAction(TextInputAction.go);
        await t.pump();
        await until(
          () => find
              .byKey(const ValueKey('browser-live-screen'))
              .evaluate()
              .isNotEmpty,
          'live frame',
        );
        await until(
          () => t.widget<TextField>(address()).controller!.text == url,
          'fixture loaded',
        );
        await t.pump(const Duration(milliseconds: 500));
        final screen = find.byKey(const ValueKey('browser-live-screen'));
        await t.ensureVisible(screen);
        await t.pump();
        final rect = t.getRect(screen);
        await t.tapAt(
          Offset(
            rect.left + rect.width * 170 / 640,
            rect.top + rect.width * 145 / 640,
          ),
        );
        await until(
          () => t
              .widget<TextField>(address())
              .controller!
              .text
              .contains('?focused=1'),
          'remote input focused',
        );
        final field = t.widget<TextField>(hiddenInput());
        field.controller!.value = const TextEditingValue(
          text: '\u200bNative',
          selection: TextSelection.collapsed(offset: 7),
        );
        await until(
          () => t
              .widget<TextField>(address())
              .controller!
              .text
              .contains('?typed=Native'),
          'remote text inserted',
        );
        field.onSubmitted!('');
        await until(
          () => t
              .widget<TextField>(address())
              .controller!
              .text
              .contains('?name=Native'),
          'pointer and text submit',
        );
        FocusManager.instance.primaryFocus?.unfocus();
        await t.pump(const Duration(milliseconds: 300));
        await tap(find.byTooltip('Activity and replay'));
        final activityPanel = find.byWidgetPredicate(
          (widget) =>
              widget is Semantics &&
              widget.properties.label == 'Browser activity',
        );
        await until(
          () => activityPanel.evaluate().isNotEmpty,
          'open activity before recording',
        );
        final previousRecordingPaths = find
            .byType(NativeRecordingPlayer)
            .evaluate()
            .map((element) => (element.widget as NativeRecordingPlayer).path)
            .toSet();
        await tap(find.byTooltip('Activity and replay'));
        await until(
          () => activityPanel.evaluate().isEmpty,
          'close activity before recording',
        );
        await tap(find.byTooltip('Record video'));
        await until(
          () => find.byTooltip('Stop recording').evaluate().isNotEmpty,
          'record started',
        );
        // Produce changing frames for a bounded real recording.
        await tap(find.byTooltip('Reload'));
        await t.pump(const Duration(seconds: 2));
        await tap(find.byTooltip('Stop recording'));
        await until(
          () => find.byTooltip('Record video').evaluate().isNotEmpty,
          'record stopped',
        );
        await tap(find.byTooltip('Activity and replay'));
        await until(
          () => activityPanel.evaluate().isNotEmpty,
          'open activity after recording',
        );
        final newRecording = find.byWidgetPredicate(
          (widget) =>
              widget is NativeRecordingPlayer &&
              !previousRecordingPaths.contains(widget.path),
        );
        await until(
          () => newRecording.evaluate().isNotEmpty,
          'new saved recording',
        );
        expect(newRecording, findsOneWidget);
        await t.ensureVisible(newRecording);
        await t.pump();
        final textureFinder = find.descendant(
          of: newRecording,
          matching: find.byType(Texture),
        );
        await until(
          () => textureFinder.evaluate().isNotEmpty,
          'native decoder prepared',
        );
        expect(textureFinder, findsOneWidget);
        final texture = t.widget<Texture>(textureFinder).textureId;
        final metadata = obj(
          await g.call('recordingControl', {'id': texture, 'action': 'status'}),
        );
        expect(metadata['width'], 640);
        expect((metadata['duration'] as num) > 0, true);
        // Chromium preserves a paused recording when its playback rate changes.
        for (final rate in RecordingState.playbackRates) {
          final adjusted = obj(
            await g.call('recordingControl', {
              'id': texture,
              'action': 'rate',
              'rate': rate,
            }),
          );
          expect((adjusted['rate'] as num).toDouble(), rate);
          expect(adjusted['playing'], false);
        }
        await g.call('recordingControl', {
          'id': texture,
          'action': 'rate',
          'rate': 1.0,
        });
        await expectLater(
          g.call('recordingControl', {
            'id': texture,
            'action': 'rate',
            'rate': 0.0,
          }),
          throwsA(isA<Exception>()),
        );
        final afterRejectedRate = obj(
          await g.call('recordingControl', {'id': texture, 'action': 'status'}),
        );
        expect(afterRejectedRate['rate'], 1);
        expect(afterRejectedRate['playing'], false);
        debugPrint('BROWSER_STEP:all playback rates preserve pause');
        final playButton = find.descendant(
          of: newRecording,
          matching: find.byTooltip('Play recording'),
        );
        await until(
          () => playButton.evaluate().isNotEmpty,
          'new recording play control',
        );
        expect(playButton, findsOneWidget);
        await tap(playButton);
        await t.pump(const Duration(milliseconds: 600));
        final playing = obj(
          await g.call('recordingControl', {'id': texture, 'action': 'status'}),
        );
        expect((playing['position'] as num) > 0, true);
        final pauseButton = find.descendant(
          of: newRecording,
          matching: find.byTooltip('Pause recording'),
        );
        await until(
          () => pauseButton.evaluate().isNotEmpty,
          'new recording pause control',
        );
        expect(pauseButton, findsOneWidget);
        await tap(pauseButton);
        await g.call('recordingControl', {
          'id': texture,
          'action': 'seek',
          'position': 0,
        });
        final priorReturns = find
            .text('User returned control')
            .evaluate()
            .length;
        await tap(find.text('Return control'));
        await until(
          () => find.text('Take over').evaluate().isNotEmpty,
          'return control',
        );
        final returnedRows = find.text('User returned control');
        await until(
          () => returnedRows.evaluate().length > priorReturns,
          'this return creates a new replay log entry',
        );
        // The pane lists newest entries first; previous scenarios share this browser.
        await tap(returnedRows.first);
        await until(
          () => find
              .byWidgetPredicate(
                (w) => w is Image && w.semanticLabel == 'Browser at this step',
              )
              .evaluate()
              .isNotEmpty,
          'replay image',
        );
        await tap(find.text('Live'));
        await until(
          () => find
              .byKey(const ValueKey('browser-live-screen'))
              .evaluate()
              .isNotEmpty,
          'return live',
        );
        debugPrint(
          'REAL_GATEWAY:browser-native-navigation-input-recording-texture-replay',
        );
      } finally {
        await t.pumpWidget(const SizedBox());
        await g.call('unwatch');
      }
    },
    timeout: const Timeout(Duration(minutes: 4)),
  );
}
