import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/document_navigation.dart';
import 'package:pirc_mobile/live/document_navigation_state.dart';
import 'package:pirc_mobile/live/document_scripts.dart';
import 'package:pirc_mobile/rendering/html_buttons.dart';
import 'package:pirc_mobile/rendering/html_form_submission.dart';

import 'document_navigation_widget_test.dart' show response;
import 'live_test.dart' show theme;
import 'support/document_vm_gateway.dart';

const _html = '''<!doctype html><html><body>
<div id="host"></div><p id="status">waiting</p>
<script>
const host = document.getElementById('host');
const range = document.createRange();
range.selectNodeContents(host);
const markup = '<script>document.getElementById("status").textContent="ready";<' +
  '/script><button id="generated">Go</button>';
host.appendChild(range.createContextualFragment(markup));
document.getElementById('generated').addEventListener('click', () => {
  document.getElementById('status').textContent = 'clicked';
});
</script></body></html>''';

void main() {
  final runtime = File('assets/document-script-runtime.js').readAsStringSync();
  for (final width in [390.0, 768.0]) {
    testWidgets('contextual fragment paints and responds at width $width', (
      t,
    ) async {
      final gateway = (await t.runAsync(DocumentVmGateway.start))!
        ..responses.add(response('/test', _html));
      final windows = NativeDocumentWindows(gateway);
      final window = windows.target(
        'fragment',
        null,
        sourceUrl: 'https://fragment.example/',
      );
      await window.load(
        const NativeHtmlFormRequest(url: '/test', method: 'GET', target: ''),
        baseUrl: window.sourceUrl,
      );
      windows.select(window);
      final document = window.currentDocument!;
      document.scripts = NativeDocumentScripts(
        gateway,
        loadRuntime: () async => runtime,
      );
      final button = find.byWidgetPredicate(
        (widget) =>
            widget is NativeHtmlButtonWidget && widget.button.label == 'Go',
      );
      Finder status(String value) => find.byWidgetPredicate(
        (widget) =>
            widget is RichText && widget.text.toPlainText().contains(value),
      );
      try {
        t.view.physicalSize = Size(width, 844);
        t.view.devicePixelRatio = 1;
        addTearDown(t.view.reset);
        await t.pumpWidget(
          MaterialApp(
            theme: theme.build(Brightness.light),
            home: NativeDocumentWorkspace(windows: windows),
          ),
        );
        await driveDocumentVm(
          t,
          () =>
              document.scripts!.ready &&
              !document.scripts!.hasPendingPublication &&
              button.evaluate().isNotEmpty &&
              status('ready').evaluate().isNotEmpty,
          reason: 'contextual fragment published',
          diagnostic: () => document.scripts!.diagnostics.toString(),
        );
        expect(
          await t.runAsync(
            () => gateway.inspect(
              "document.getElementById('status').textContent",
            ),
          ),
          'ready',
        );
        await t.tap(button);
        await driveDocumentVm(
          t,
          () =>
              status('clicked').evaluate().isNotEmpty &&
              !document.scripts!.hasPendingPublication,
          reason: 'fragment button updates native text',
          diagnostic: () => document.scripts!.diagnostics.toString(),
        );
        expect(
          await t.runAsync(
            () => gateway.inspect(
              "document.getElementById('status').textContent",
            ),
          ),
          'clicked',
        );
        expect(t.takeException(), isNull);
      } finally {
        await t.pumpWidget(const SizedBox.shrink());
        final scripts = document.scripts;
        windows.dispose();
        var closed = false;
        (scripts?.closed ?? Future<void>.value()).then((_) => closed = true);
        await driveDocumentVm(
          t,
          () => closed && gateway.closes == gateway.opens,
          reason: 'retire contextual fragment document',
        );
        await t.runAsync(gateway.close);
        await t.pump();
      }
    });
  }
}
