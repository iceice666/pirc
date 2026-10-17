import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pirc_mobile/live/common.dart';
import 'package:pirc_mobile/theme.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'Android landscape IME keeps long themed notice readable and draft intact',
    (t) async {
      expect(t.binding.testTextInput.isRegistered, isFalse);
      final oldPropagation = t.binding.shouldPropagateDevicePointerEvents;
      t.binding.shouldPropagateDevicePointerEvents = true;
      final theme = await PircTheme.load();
      final draft = TextEditingController(text: 'Saved draft 尚未送出');
      final focus = FocusNode();
      final view = t.binding.platformDispatcher.views.first;
      Future<void> until(bool Function() ready, String label) async {
        for (var i = 0; i < 200 && !ready(); i++) {
          await t.pump(const Duration(milliseconds: 100));
        }
        expect(ready(), isTrue, reason: label);
        expect(t.takeException(), isNull, reason: label);
      }

      const message =
          'Connection failed. Check the gateway connection and retry. '
          'Keep your saved draft. The error must remain readable with the keyboard open. '
          '請檢查連線後重試，不需要重新輸入已保存的內容。 '
          'More diagnostic information follows. More diagnostic information follows. '
          'More diagnostic information follows. End of error.';
      try {
        await SystemChrome.setPreferredOrientations([
          DeviceOrientation.landscapeLeft,
        ]);
        await until(
          () => view.physicalSize.width > view.physicalSize.height,
          'actual landscape viewport',
        );
        for (final brightness in Brightness.values) {
          late BuildContext context;
          await t.pumpWidget(
            MaterialApp(
              theme: theme.build(brightness),
              builder: (context, child) => MediaQuery(
                data: MediaQuery.of(
                  context,
                ).copyWith(textScaler: TextScaler.linear(2)),
                child: child!,
              ),
              home: Builder(
                builder: (c) {
                  context = c;
                  return Scaffold(
                    body: Padding(
                      padding: const EdgeInsets.all(16),
                      child: TextField(controller: draft, focusNode: focus),
                    ),
                  );
                },
              ),
            ),
          );
          await t.pumpAndSettle();
          final tap =
              t.getCenter(find.byType(TextField)) * view.devicePixelRatio;
          debugPrint(
            'ANDROID_NOTICE_TAP ${brightness.name} ${tap.dx.round()} ${tap.dy.round()}',
          );
          await until(
            () => view.viewInsets.bottom > 0,
            'real Android keyboard',
          );
          if (!context.mounted) throw StateError('Notice surface unmounted');
          final expectedBackground = palette(context)['web.bg-layer'];
          showNotice(context, message);
          await t.pumpAndSettle();
          expect(t.takeException(), isNull);
          final keyboardTop =
              (view.physicalSize.height - view.viewInsets.bottom) /
              view.devicePixelRatio;
          final surface = find.byKey(const ValueKey('app-notice'));
          final rect = t.getRect(surface);
          expect(rect.top, greaterThanOrEqualTo(0));
          expect(rect.bottom, lessThanOrEqualTo(keyboardTop + 1));
          expect(
            (t.widget<Container>(surface).decoration as BoxDecoration).color,
            expectedBackground,
          );
          final scroll = find.byKey(const ValueKey('app-notice-scroll'));
          await t.drag(scroll, const Offset(0, -1000));
          await t.pumpAndSettle();
          final paragraph = t.renderObject<RenderParagraph>(
            find.descendant(of: scroll, matching: find.byType(RichText)),
          );
          final last = paragraph
              .getBoxesForSelection(
                TextSelection(
                  baseOffset: message.length - 1,
                  extentOffset: message.length,
                ),
              )
              .single;
          final lastRect = MatrixUtils.transformRect(
            paragraph.getTransformTo(null),
            last.toRect(),
          );
          expect(lastRect.top, greaterThanOrEqualTo(t.getRect(scroll).top - 1));
          expect(
            lastRect.bottom,
            lessThanOrEqualTo(t.getRect(scroll).bottom + 1),
          );
          expect(
            find.byTooltip('Dismiss notification').hitTestable(),
            findsOneWidget,
          );
          await t.tap(find.byTooltip('Dismiss notification'));
          await t.pumpAndSettle();
          expect(find.byType(SnackBar), findsNothing);
          expect(draft.text, 'Saved draft 尚未送出');
          focus.unfocus();
          await SystemChannels.textInput.invokeMethod<void>('TextInput.hide');
          await until(() => view.viewInsets.bottom == 0, 'keyboard closes');
          await t.pumpWidget(const SizedBox());
          await t.pumpAndSettle();
        }
      } finally {
        focus.unfocus();
        await SystemChannels.textInput.invokeMethod<void>('TextInput.hide');
        await t.pumpWidget(const SizedBox());
        await t.pumpAndSettle();
        t.binding.shouldPropagateDevicePointerEvents = oldPropagation;
        focus.dispose();
        draft.dispose();
        await SystemChrome.setPreferredOrientations([]);
      }
    },
  );
}
