import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/common.dart';
import 'package:pirc_mobile/live/document_navigation.dart';
import 'package:pirc_mobile/live/document_navigation_state.dart';
import 'package:pirc_mobile/live/document_window_manager.dart';
import 'package:pirc_mobile/live/gateway.dart';

import 'document_navigation_widget_test.dart'
    show DocumentGateway, clickSubmit, response;
import 'live_test.dart' show theme;
import 'native_html_test.dart' show tapText;

class _NestedDocuments {
  const _NestedDocuments({
    required this.gateway,
    required this.windows,
    required this.hostKey,
    required this.opener,
    required this.child,
  });

  final DocumentGateway gateway;
  final NativeDocumentWindows windows;
  final GlobalKey<NativeDocumentHostState> hostKey;
  final NativeDocumentWindow opener, child;
}

Widget _hostedApp({
  required DocumentGateway gateway,
  required NativeDocumentWindows windows,
  required GlobalKey<NativeDocumentHostState> hostKey,
  required String source,
}) => MaterialApp(
  theme: theme.build(Brightness.light),
  home: NativeDocumentScope(
    windows: windows,
    documentUrl: 'https://gateway.example/?session=source',
    sourceIdentity: windows.accountIdentity,
    child: NativeDocumentHost(
      key: hostKey,
      windows: windows,
      child: Scaffold(
        body: SingleChildScrollView(
          child: RichTextBody(source, gateway: gateway),
        ),
      ),
    ),
  ),
);

Future<_NestedDocuments> _openNestedDocuments(
  WidgetTester tester, {
  LiveController? owner,
}) async {
  final gateway = DocumentGateway()
    ..responses.addAll([
      response(
        '/opener',
        '<title>Original opener</title>'
            '<form action="/child" target="_blank">'
            '<button>Open child</button></form>',
      ),
      response('/child', '<title>Child document</title><p>Child body</p>'),
    ]);
  final windows = NativeDocumentWindows(
    gateway,
    owner: owner,
    appDocumentUrl: () => 'https://gateway.example/?session=source',
  );
  final hostKey = GlobalKey<NativeDocumentHostState>();
  await tester.pumpWidget(
    _hostedApp(
      gateway: gateway,
      windows: windows,
      hostKey: hostKey,
      source: '<form action="/opener"><button>Open opener</button></form>',
    ),
  );
  await tester.pumpAndSettle();
  await clickSubmit(tester);
  final opener = windows.active!;
  await clickSubmit(tester);
  final child = windows.active!;
  return _NestedDocuments(
    gateway: gateway,
    windows: windows,
    hostKey: hostKey,
    opener: opener,
    child: child,
  );
}

void main() {
  testWidgets(
    'selecting App source snapshots current state while the primary document stays mounted',
    (tester) async {
      final gateway = DocumentGateway()
        ..responses.add(response('/primary', '<title>Primary page</title>'));
      Object appState = 'old';
      final restored = <Object>[];
      final windows = NativeDocumentWindows(
        gateway,
        captureAppState: () => appState,
        restoreAppState: (state) async {
          restored.add(state);
          appState = state;
        },
        appDocumentUrl: () => 'https://gateway.example/?session=primary',
      );
      addTearDown(windows.dispose);
      final hostKey = GlobalKey<NativeDocumentHostState>();
      await tester.pumpWidget(
        _hostedApp(
          gateway: gateway,
          windows: windows,
          hostKey: hostKey,
          source:
              '<form action="/primary"><button>Open primary</button></form>',
        ),
      );
      await tester.pumpAndSettle();
      await clickSubmit(tester);

      final primaryWindow = windows.active!;
      final document = primaryWindow.currentDocument!;
      expect(primaryWindow.index, 0);
      expect(primaryWindow.canReturnToSource, isTrue);
      expect(primaryWindow.sourceState, 'old');

      appState = 'new chat';
      await hostKey.currentState!.selectWindow(null);
      await tester.pumpAndSettle();
      expect(primaryWindow.index, 0);
      expect(primaryWindow.currentDocument, same(document));

      await hostKey.currentState!.selectWindow(primaryWindow);
      expect(primaryWindow.sourceState, 'new chat');
      await hostKey.currentState!.back();
      await tester.pumpAndSettle();

      expect(primaryWindow.index, -1);
      expect(appState, 'new chat');
      expect(restored, ['new chat']);
      expect(primaryWindow.currentDocument, isNull);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('selecting the App source preserves mounted document history', (
    tester,
  ) async {
    final nested = await _openNestedDocuments(tester);
    addTearDown(nested.windows.dispose);
    final host = nested.hostKey.currentState!;
    final document = nested.child.currentDocument!;
    final history = List<NativeDocumentHistoryItem>.of(nested.child.history);
    expect(nested.windows.active, same(nested.child));

    await host.selectWindow(null);
    await tester.pumpAndSettle();
    expect(nested.windows.active, isNull);
    expect(nested.child.history, history);
    expect(nested.child.currentDocument, same(document));
    expect(find.byType(NativeDocumentWorkspace), findsNothing);
    expect(find.text('Open opener', findRichText: true), findsOneWidget);

    await host.selectWindow(nested.child);
    await tester.pumpAndSettle();
    expect(nested.windows.active, same(nested.child));
    expect(nested.child.currentDocument, same(document));
    expect(find.byType(NativeDocumentWorkspace), findsOneWidget);
    expect(find.text('Child body', findRichText: true), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('closing the active child returns to its original opener', (
    tester,
  ) async {
    final nested = await _openNestedDocuments(tester);
    addTearDown(nested.windows.dispose);
    final openerDocument = nested.opener.currentDocument;

    await nested.hostKey.currentState!.closeWindow(nested.child);
    await tester.pumpAndSettle();

    expect(nested.child.disposed, isTrue);
    expect(nested.windows.windows, [nested.opener]);
    expect(nested.windows.active, same(nested.opener));
    expect(nested.opener.currentDocument, same(openerDocument));
    expect(find.text('Original opener', findRichText: true), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'a pending close cannot steal selection back after another window is selected',
    (tester) async {
      final nested = await _openNestedDocuments(tester);
      addTearDown(nested.windows.dispose);
      final entered = Completer<void>();
      final allowFlush = Completer<void>();
      var flushes = 0;
      nested.child.beforeClose = () async {
        flushes++;
        if (!entered.isCompleted) entered.complete();
        await allowFlush.future;
      };

      final closing = nested.hostKey.currentState!.closeWindow(nested.child);
      await entered.future;
      await tester.pump();
      expect(nested.child.closing, isTrue);
      final documentAbsorbers = tester.widgetList<AbsorbPointer>(
        find.descendant(
          of: find.byType(NativeDocumentWorkspace),
          matching: find.byType(AbsorbPointer),
        ),
      );
      expect(documentAbsorbers.any((absorber) => absorber.absorbing), isTrue);

      await nested.hostKey.currentState!.selectWindow(nested.opener);
      await tester.pumpAndSettle();
      expect(nested.windows.active, same(nested.opener));
      allowFlush.complete();
      await closing;
      await tester.pumpAndSettle();

      expect(flushes, 1);
      expect(nested.child.disposed, isTrue);
      expect(nested.windows.active, same(nested.opener));
      expect(nested.windows.windows, [nested.opener]);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('repeated close while beforeClose is pending flushes once', (
    tester,
  ) async {
    final nested = await _openNestedDocuments(tester);
    addTearDown(nested.windows.dispose);
    final entered = Completer<void>();
    final allowFlush = Completer<void>();
    var flushes = 0;
    nested.child.beforeClose = () async {
      flushes++;
      if (!entered.isCompleted) entered.complete();
      await allowFlush.future;
    };

    final firstClose = nested.hostKey.currentState!.closeWindow(nested.child);
    await entered.future;
    await nested.hostKey.currentState!.closeWindow(nested.child);
    expect(flushes, 1);
    expect(nested.child.closing, isTrue);

    allowFlush.complete();
    await firstClose;
    await tester.pumpAndSettle();
    await nested.hostKey.currentState!.closeWindow(nested.child);
    expect(flushes, 1);
    expect(nested.child.disposed, isTrue);
    expect(nested.windows.active, same(nested.opener));
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'account change during a close flush cannot close a new context',
    (tester) async {
      final gateway = DocumentGateway();
      final owner = LiveController(gateway, showing: 'engine')
        ..origin = 'https://gateway.example'
        ..clientId = 'client'
        ..pairingStamp = 'stamp';
      final nested = await _openNestedDocuments(tester, owner: owner);
      addTearDown(() {
        nested.windows.dispose();
        owner.dispose();
      });
      final entered = Completer<void>();
      final allowFlush = Completer<void>();
      nested.child.beforeClose = () async {
        if (!entered.isCompleted) entered.complete();
        await allowFlush.future;
      };

      final closing = nested.hostKey.currentState!.closeWindow(nested.child);
      await entered.future;
      owner.origin = 'https://next-gateway.example';
      owner.pairingStamp = 'next-stamp';
      owner.changed();
      await tester.pumpAndSettle();
      expect(nested.child.disposed, isTrue);
      expect(nested.windows.windows, isEmpty);

      final fresh = nested.windows.target(
        '',
        null,
        sourceUrl: 'https://next-gateway.example/',
      );
      expect(nested.windows.select(fresh), isTrue);
      allowFlush.complete();
      await closing;
      await tester.pumpAndSettle();

      expect(nested.windows.windows, [fresh]);
      expect(nested.windows.active, same(fresh));
      expect(fresh.disposed, isFalse);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('selecting an opener from the real manager route pops to root', (
    tester,
  ) async {
    final nested = await _openNestedDocuments(tester);
    addTearDown(nested.windows.dispose);
    final context = tester.element(find.byKey(nested.hostKey));
    final route = showNativeDocumentWindowManager(
      context,
      nested.windows,
      nested.hostKey.currentState!,
    );
    await tester.pumpAndSettle();
    expect(find.byType(NativeDocumentWindowManagerPage), findsOneWidget);

    await tester.tap(
      find.byKey(Key('document-window-select-${nested.opener.id}')),
    );
    await tester.pumpAndSettle();
    await route;

    expect(find.byType(NativeDocumentWindowManagerPage), findsNothing);
    expect(nested.windows.active, same(nested.opener));
    expect(nested.opener.currentDocument!.content.title, 'Original opener');
    expect(find.byType(NativeDocumentWorkspace), findsOneWidget);
    expect(
      Navigator.of(tester.element(find.byKey(nested.hostKey))).canPop(),
      isFalse,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'manager back clones POST history and forward refetches GET without POST replay',
    (tester) async {
      final postedResponse =
          response(
              '/submitted',
              '<title>POST result</title>'
                  '<form><input name="result" value="server"></form>'
                  '<a href="/after-post">Continue to GET</a>',
              finalMethod: 'POST',
            )
            ..['headersRelevant'] = <String, String>{
              'Cache-Control': 'public, max-age=3600',
              'Content-Location': 'https://gateway.example/submitted',
              'Content-Type': 'text/html; charset=utf-8',
            };
      final gateway = DocumentGateway()
        ..responses.addAll([
          postedResponse,
          response('/after-post', '<title>After POST</title><p>GET result</p>'),
          response(
            '/after-post',
            '<title>After POST fetched again</title><p>Fresh GET result</p>',
          ),
        ]);
      final windows = NativeDocumentWindows(
        gateway,
        appDocumentUrl: () => 'https://gateway.example/?session=source',
      );
      addTearDown(windows.dispose);
      final hostKey = GlobalKey<NativeDocumentHostState>();
      await tester.pumpWidget(
        _hostedApp(
          gateway: gateway,
          windows: windows,
          hostKey: hostKey,
          source:
              '<form action="/submitted" method="post">'
              '<input name="value" value="posted once">'
              '<button>Submit POST</button></form>',
        ),
      );
      await tester.pumpAndSettle();
      await clickSubmit(tester);

      final window = windows.active!;
      final postDocument = window.currentDocument!;
      expect(postDocument.reloadRequest?.method, 'POST');
      expect(gateway.calls, hasLength(1));
      expect(gateway.calls.single['method'], 'POST');
      final postedEditor = find.byType(EditableText).first;
      final postedController = tester
          .widget<EditableText>(postedEditor)
          .controller;
      await tester.enterText(postedEditor, 'edited POST result');
      await tester.pumpAndSettle();
      await tapText(tester, 'Continue to GET');
      await tester.pumpAndSettle();

      final getDocument = window.currentDocument!;
      expect(window.history, hasLength(2));
      expect(window.index, 1);
      expect(gateway.calls, hasLength(2));
      expect(gateway.calls.last['method'], 'GET');

      final managerRoute = showNativeDocumentWindowManager(
        tester.element(find.byKey(hostKey)),
        windows,
        hostKey.currentState!,
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('document-window-back')));
      await tester.pumpAndSettle();
      expect(window.index, 0);
      final restoredPostDocument = window.currentDocument!;
      expect(restoredPostDocument, isNot(same(postDocument)));
      expect(restoredPostDocument.content.title, 'POST result');
      final restoredEditor = find
          .descendant(
            of: find.byType(NativeDocumentWorkspace, skipOffstage: false),
            matching: find.byType(EditableText, skipOffstage: false),
          )
          .first;
      final restoredController = tester
          .widget<EditableText>(restoredEditor)
          .controller;
      expect(restoredController, isNot(same(postedController)));
      expect(restoredController.text, 'edited POST result');
      expect(gateway.calls, hasLength(2));

      await tester.tap(find.byKey(const Key('document-window-forward')));
      await tester.pumpAndSettle();
      expect(window.index, 1);
      expect(window.currentDocument, isNot(same(getDocument)));
      expect(window.currentDocument!.content.title, 'After POST fetched again');
      expect(gateway.calls, hasLength(3));
      expect(gateway.calls.map((call) => call['method']), [
        'POST',
        'GET',
        'GET',
      ]);
      expect(
        gateway.calls.where((call) => call['method'] == 'POST'),
        hasLength(1),
      );
      expect(tester.takeException(), isNull);

      Navigator.of(
        tester.element(find.byType(NativeDocumentWindowManagerPage)),
      ).popUntil((route) => route.isFirst);
      await tester.pumpAndSettle();
      await managerRoute;
    },
  );
}
