import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/browser_pane.dart';
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
    'real Android touch scroll, drag and text reach remote Chromium',
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
      final c = LiveController(g, showing: 'engine'),
          theme = await PircTheme.load();
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
        await tap(find.byKey(const ValueKey('panel-tab-browser')));
        await until(
          () =>
              find.byType(BrowserPane).evaluate().isNotEmpty &&
              address().evaluate().isNotEmpty,
          'browser',
        );
        await t.enterText(address(), '${url}touch');
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
          () => t
              .widget<TextField>(address())
              .controller!
              .text
              .contains('/touch?'),
          'fixture loaded',
        );
        await t.pump(const Duration(milliseconds: 500));
        final screen = find.byKey(const ValueKey('browser-live-screen'));
        await t.ensureVisible(screen);
        await t.pump();
        Offset remotePoint(double x, double y) {
          final rect = t.getRect(screen);
          return Offset(
            rect.left + rect.width * x / 640,
            rect.top + rect.height * y / 400,
          );
        }

        Map<String, String> remoteStatus() => Uri.parse(
          t.widget<TextField>(address()).controller!.text,
        ).queryParameters;
        final swipe = await t.startGesture(remotePoint(180, 260));
        await swipe.moveTo(remotePoint(180, 110));
        await swipe.up();
        await until(
          () => (int.tryParse(remoteStatus()['scroll'] ?? '') ?? 0) > 100,
          'touch swipe scrolls remote inner page',
        );
        expect(
          remoteStatus()['presses'],
          '0',
          reason: 'Swiping must not click or select remote content',
        );
        expect(
          t.widget<TextField>(hiddenInput()).focusNode!.hasFocus,
          false,
          reason: 'Scrolling must not open the keyboard',
        );
        await t.tapAt(remotePoint(470, 170));
        await t.pump(const Duration(milliseconds: 60));
        await t.tapAt(remotePoint(470, 170));
        await until(
          () => remoteStatus()['double'] == '1',
          'double tap reaches remote dblclick',
        );
        FocusManager.instance.primaryFocus?.unfocus();
        await t.pump(const Duration(milliseconds: 300));
        await tap(find.text('Touch: scroll'));
        final drag = await t.startGesture(remotePoint(430, 130));
        await drag.moveTo(remotePoint(510, 220));
        await drag.up();
        await until(
          () => remoteStatus()['dragged'] == '1',
          'explicit drag reaches remote page',
        );
        FocusManager.instance.primaryFocus?.unfocus();
        await t.pump(const Duration(milliseconds: 300));
        await tap(find.text('Touch: drag'));
        await t.tapAt(remotePoint(150, 35));
        await until(
          () => remoteStatus()['focused'] == '1',
          'touch tap focuses remote input',
        );
        t
            .widget<TextField>(hiddenInput())
            .controller!
            .value = const TextEditingValue(
          text: '\u200b手機輸入',
          selection: TextSelection.collapsed(offset: 5),
        );
        await until(
          () => remoteStatus()['typed'] == '手機輸入',
          'Unicode IME text reaches remote input',
        );
        FocusManager.instance.primaryFocus?.unfocus();
        await t.pump();
        await tap(find.text('Return control'));
        await until(
          () => find.text('Take over').evaluate().isNotEmpty,
          'return browser control',
        );
        expect(find.text('Touch: scroll'), findsNothing);
        debugPrint(
          'REAL_GATEWAY:touch-scroll-no-click-drag-tap-unicode-control',
        );
      } finally {
        await t.pumpWidget(const SizedBox());
        await g.call('unwatch');
      }
    },
    timeout: const Timeout(Duration(minutes: 4)),
  );
}
