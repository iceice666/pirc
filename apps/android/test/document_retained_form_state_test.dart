import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/document_navigation_state.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/rendering/html_date.dart';
import 'package:pirc_mobile/rendering/html_file.dart';
import 'package:pirc_mobile/rendering/html_text_fields.dart';
import 'document_navigation_widget_test.dart'
    show DocumentGateway, response, app, clickSubmit;

class _FileGateway extends DocumentGateway {
  @override
  Future<dynamic> call(String method, [Json args = const {}]) {
    if (method == 'pickAttachments') {
      return Future.value([
        {
          'name': 'fixture.bin',
          'mimeType': 'application/octet-stream',
          'bytes': base64Encode([0, 127, 128, 255]),
        },
      ]);
    }
    return super.call(method, args);
  }
}

void main() {
  testWidgets(
    'retained history keeps live files, off dates, password and details',
    (tester) async {
      final gateway = _FileGateway()
        ..responses.addAll([
          response(
            '/retained',
            '<title>Retained source</title><form action="/next"><input name="date" type="date" autocomplete="off" value="2024-06-15"><input name="password" type="password" autocomplete="off" value="server"><input name="upload" type="file" required><button>Next</button></form><details><summary>More</summary><p>Retained disclosure</p></details>',
          ),
          response('/next', '<title>Next page</title><p>Next page body</p>'),
        ]);
      final windows = NativeDocumentWindows(gateway);
      addTearDown(windows.dispose);
      await tester.pumpWidget(
        app(
          gateway,
          windows,
          '<form action="/retained"><button>Open</button></form>',
        ),
      );
      await tester.pumpAndSettle();
      await clickSubmit(tester);
      final date = tester.widget<NativeHtmlDateInput>(
        find.byType(NativeHtmlDateInput),
      );
      date.state.setValue(date.control.key, '2025-10-30');
      final password = find.byWidgetPredicate(
        (widget) =>
            widget is NativeHtmlTextFieldWidget &&
            widget.field.name == 'password',
      );
      await tester.enterText(
        find.descendant(of: password, matching: find.byType(EditableText)),
        'typed fixture password',
      );
      final fileFinder = find.byType(NativeHtmlFileInputWidget);
      await tester.ensureVisible(fileFinder);
      await tester.tap(fileFinder);
      await tester.pumpAndSettle();
      final file = tester.widget<NativeHtmlFileInputWidget>(fileFinder);
      expect(file.state.pickerErrorFor(file.control.key), isNull);
      expect(file.state.filesFor(file.control.key).single.bytes, [
        0,
        127,
        128,
        255,
      ]);
      await tester.ensureVisible(
        find.byWidgetPredicate(
          (widget) =>
              widget is RichText && widget.text.toPlainText().contains('More'),
        ),
      );
      await tester.tap(
        find.byWidgetPredicate(
          (widget) =>
              widget is RichText && widget.text.toPlainText().contains('More'),
        ),
      );
      await tester.pumpAndSettle();
      final retained = windows.active!.currentDocument;
      await clickSubmit(tester);
      expect(windows.active!.currentDocument, isNot(same(retained)));
      expect(gateway.calls, hasLength(2));
      await tester.tap(find.byTooltip('返回'));
      await tester.pumpAndSettle();
      expect(windows.active!.currentDocument, same(retained));
      expect(
        gateway.calls,
        hasLength(2),
        reason: 'A retained GET Document does not fetch again',
      );
      final restoredFile = tester.widget<NativeHtmlFileInputWidget>(fileFinder);
      expect(restoredFile.state, same(file.state));
      expect(
        restoredFile.state.filesFor(restoredFile.control.key).single.bytes,
        [0, 127, 128, 255],
      );
      final restoredDate = tester.widget<NativeHtmlDateInput>(
        find.byType(NativeHtmlDateInput),
      );
      expect(
        restoredDate.state.valueFor(restoredDate.control.key),
        '2025-10-30',
      );
      final restoredPassword = tester.widget<NativeHtmlTextFieldWidget>(
        password,
      );
      expect(
        restoredPassword.state.valueFor(restoredPassword.field.key),
        'typed fixture password',
      );
      expect(
        find.text('Retained disclosure', findRichText: true),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    },
  );
}
