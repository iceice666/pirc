import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/rendering.dart';
import 'package:pirc_mobile/live/common.dart';
import 'live_test.dart' show theme;

const message =
    'Connection failed. '
    'Check the gateway connection, keep your draft and retry. '
    'The server returned a detailed error which must remain readable. '
    '請檢查連線後重試，不需要重新輸入已保存的內容。 '
    'More diagnostic information follows. More diagnostic information follows. '
    'More diagnostic information follows. End of error.';

void main() {
  for (final brightness in Brightness.values) {
    testWidgets(
      'long notice stays onscreen with landscape keyboard $brightness',
      (t) async {
        t.view.devicePixelRatio = 1;
        t.view.physicalSize = const Size(844, 390);
        t.view.viewInsets = const FakeViewPadding(bottom: 200);
        addTearDown(t.view.reset);
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
                return const Scaffold(body: SizedBox.expand());
              },
            ),
          ),
        );
        showNotice(context, message);
        await t.pumpAndSettle();
        expect(t.takeException(), isNull);
        expect(find.text(message), findsOneWidget);
        final rect = t.getRect(find.byType(SnackBar));
        expect(rect.top, greaterThanOrEqualTo(0));
        expect(rect.bottom, lessThanOrEqualTo(190));
        final surface = t.widget<Container>(
          find.byKey(const ValueKey('app-notice')),
        );
        expect(
          (surface.decoration as BoxDecoration).color,
          palette(context)['web.bg-layer'],
        );
        expect(
          find.byTooltip('Dismiss notification').hitTestable(),
          findsOneWidget,
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
        expect(lastRect.top, greaterThanOrEqualTo(t.getRect(scroll).top));
        expect(
          lastRect.bottom,
          lessThanOrEqualTo(t.getRect(scroll).bottom + 0.01),
        );
        // A visible notice must also adapt while the keyboard closes and the
        // screen rotates, without replacing or truncating its message.
        t.view.viewInsets = const FakeViewPadding();
        t.view.physicalSize = const Size(390, 844);
        await t.pumpAndSettle();
        expect(t.takeException(), isNull);
        expect(find.text(message), findsOneWidget);
        expect(t.getRect(find.byType(SnackBar)).top, greaterThanOrEqualTo(0));
        await t.tap(find.byTooltip('Dismiss notification'));
        await t.pumpAndSettle();
        expect(find.byType(SnackBar), findsNothing);
        await t.pumpWidget(const SizedBox());
      },
    );
  }
}
