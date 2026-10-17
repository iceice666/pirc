import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/theme.dart';

class _RecordingGateway extends Gateway {
  final commands = <Json>[];

  @override
  Future<dynamic> call(String method, [Json args = const {}]) {
    if (method == 'command') commands.add(Map<String, dynamic>.of(args));
    return super.call(method, args);
  }
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'real Android IME and rotation preserve the unsent composer draft and live session',
    (t) async {
      expect(const bool.fromEnvironment('PIRC_REAL_GATEWAY'), isTrue);
      expect(
        t.binding.testTextInput.isRegistered,
        isFalse,
        reason:
            'IntegrationTestWidgetsFlutterBinding must use the native text-input channel.',
      );
      expect(
        const bool.fromEnvironment('PIRC_ANDROID_INPUT_ROTATION'),
        isTrue,
        reason: 'Run through tool/parity/run_android_input_rotation.py.',
      );

      const pairingLink = String.fromEnvironment('PIRC_PAIR_LINK');
      expect(pairingLink, isNotEmpty, reason: 'Missing private pairing link.');
      final gateway = _RecordingGateway();
      LiveController? controller;
      String? sessionId;
      var paired = false;
      var appMounted = false;
      const draft = 'android_rotation_draft_2026';

      Future<void> until(
        bool Function() ready,
        String label, {
        int attempts = 600,
        String Function()? diagnostics,
      }) async {
        for (var i = 0; i < attempts && !ready(); i++) {
          await t.pump(const Duration(milliseconds: 100));
        }
        final reached = ready();
        expect(
          reached,
          isTrue,
          reason: reached || diagnostics == null
              ? label
              : '$label (${diagnostics()})',
        );
        await t.pump();
        expect(t.takeException(), isNull, reason: label);
      }

      Size logicalViewport() {
        final view = t.binding.platformDispatcher.views.first;
        final ratio = view.devicePixelRatio;
        return Size(
          view.physicalSize.width / ratio,
          view.physicalSize.height / ratio,
        );
      }

      double actualViewInset() =>
          t.binding.platformDispatcher.views.first.viewInsets.bottom;

      double logicalKeyboardTop() {
        final view = t.binding.platformDispatcher.views.first;
        return (view.physicalSize.height - view.viewInsets.bottom) /
            view.devicePixelRatio;
      }

      bool composerIsAboveKeyboard(Finder composer) {
        final rect = t.getRect(composer);
        final keyboardTop = logicalKeyboardTop();
        return rect.top < keyboardTop && rect.bottom <= keyboardTop + 1;
      }

      String imeDiagnostics(Finder composer) {
        final view = t.binding.platformDispatcher.views.first;
        final textField = t.widget<TextField>(composer);
        final mediaInsets = MediaQuery.viewInsetsOf(t.element(composer)).bottom;
        return 'focus=${textField.focusNode?.hasFocus}, '
            'platformViewInsetsPhysical=${view.viewInsets.bottom}, '
            'mediaViewInsetsLogical=$mediaInsets, '
            'devicePixelRatio=${view.devicePixelRatio}, '
            'composerRect=${t.getRect(composer)}, '
            'logicalKeyboardTop=${logicalKeyboardTop()}, '
            'testTextInputMock=${t.binding.testTextInput.isRegistered}, '
            'devicePointerPropagation=${t.binding.shouldPropagateDevicePointerEvents}';
      }

      final propagateDevicePointerEventsBeforeTest =
          t.binding.shouldPropagateDevicePointerEvents;

      try {
        // Host adb taps must reach the actual app. The test binding otherwise
        // observes native pointer events for diagnostics but drops them.
        t.binding.shouldPropagateDevicePointerEvents = true;
        expect(t.binding.shouldPropagateDevicePointerEvents, isTrue);

        await gateway.call('pair', {'link': pairingLink});
        paired = true;
        await gateway.call('completeOnboarding');
        final workspaces = rows(
          (await gateway.request('/api/workspaces'))['workspaces'],
        );
        final workspace = workspaces.firstWhere((row) => row['kind'] == 'chat');
        final created = await gateway.request(
          '/api/sessions',
          method: 'POST',
          body: {'workspaceId': workspace['id']},
        );
        sessionId = '${obj(created['session'])['id']}';

        final c = controller = LiveController(gateway);
        final theme = await PircTheme.load();
        await t.pumpWidget(MobileApp(theme: theme, controller: c));
        appMounted = true;
        await until(() => !c.booting, 'paired MobileApp boot');
        c.pairLink = null;
        c.routePage = null;
        await c.open(sessionId);
        await until(
          () =>
              c.sessionId == sessionId &&
              c.canWrite &&
              c.sessionVisible &&
              find.byKey(const Key('live-draft')).evaluate().isNotEmpty,
          'one-time chat is live and the actual composer is visible',
        );

        final composer = find.byKey(const Key('live-draft'));
        expect(composer.hitTestable(), findsOneWidget);
        final composerRect = t.getRect(composer);
        final view = t.binding.platformDispatcher.views.first;
        final ratio = view.devicePixelRatio;
        final tapX = (composerRect.center.dx * ratio).round();
        final tapY = (composerRect.center.dy * ratio).round();
        final start = logicalViewport();
        expect(start.height, greaterThan(start.width));
        debugPrint('ANDROID_INPUT_ROTATION_COMPOSER_TAP $tapX $tapY');

        await until(
          () =>
              t.widget<TextField>(composer).focusNode?.hasFocus == true &&
              actualViewInset() > 0 &&
              composerIsAboveKeyboard(composer),
          'a physical adb tap focused the composer and the Android IME opened',
          diagnostics: () => imeDiagnostics(composer),
        );
        debugPrint('ANDROID_INPUT_ROTATION_IME_VISIBLE');

        await until(
          () =>
              c.draft == draft &&
              t.widget<TextField>(composer).controller?.text == draft,
          'host adb input text reached the focused composer',
        );
        expect(gateway.commands, isEmpty);
        expect(
          c.messages.any((message) => message['content'] == draft),
          isFalse,
        );
        expect(c.sessionId, sessionId);
        debugPrint('ANDROID_INPUT_ROTATION_DRAFT_READY_BACK');

        await until(
          () =>
              actualViewInset() == 0 &&
              c.draft == draft &&
              t.widget<TextField>(composer).controller?.text == draft,
          'Android Back closed the IME without discarding the draft',
        );
        expect(c.sessionId, sessionId);
        expect(c.connection, 'live');
        expect(c.canWrite, isTrue);
        expect(gateway.commands, isEmpty);
        debugPrint('ANDROID_INPUT_ROTATION_IME_HIDDEN');
        debugPrint('ANDROID_INPUT_ROTATION_READY_LANDSCAPE');

        await until(() {
          final size = logicalViewport();
          return size.width > size.height && size != start;
        }, 'device rotation changed the real Flutter viewport to landscape');
        final landscape = logicalViewport();
        await until(
          () =>
              c.sessionId == sessionId &&
              c.connection == 'live' &&
              c.canWrite &&
              c.draft == draft &&
              t.widget<TextField>(composer).controller?.text == draft,
          'live session and draft survived landscape configuration change',
        );
        debugPrint(
          'ANDROID_INPUT_ROTATION_LANDSCAPE ${landscape.width.toStringAsFixed(1)} ${landscape.height.toStringAsFixed(1)}',
        );

        await until(() {
          final size = logicalViewport();
          return size.height > size.width && size != landscape;
        }, 'device rotation restored the real Flutter viewport to portrait');
        await until(
          () =>
              c.sessionId == sessionId &&
              c.connection == 'live' &&
              c.canWrite &&
              c.draft == draft &&
              t.widget<TextField>(composer).controller?.text == draft,
          'session stream, write lease, and draft survived rotation restoration',
        );
        final restored = logicalViewport();
        expect(restored.height, greaterThan(restored.width));
        expect(gateway.commands, isEmpty);
        expect(
          c.messages.any((message) => message['content'] == draft),
          isFalse,
        );
        expect(t.takeException(), isNull);
        debugPrint(
          'ANDROID_INPUT_ROTATION_PORTRAIT ${restored.width.toStringAsFixed(1)} ${restored.height.toStringAsFixed(1)}',
        );
        debugPrint('ANDROID_INPUT_ROTATION_ACCEPTED');
      } finally {
        t.binding.shouldPropagateDevicePointerEvents =
            propagateDevicePointerEventsBeforeTest;
        await t.pumpWidget(const SizedBox());
        if (!appMounted) controller?.dispose();
        try {
          await gateway.call('unwatch');
        } finally {
          try {
            if (sessionId != null) {
              await gateway.request(sessionPath(sessionId), method: 'DELETE');
            }
          } finally {
            if (paired) await gateway.call('unpair');
          }
        }
      }
    },
    timeout: const Timeout(Duration(minutes: 5)),
  );
}
