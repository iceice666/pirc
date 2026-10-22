import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/side_panel.dart';
import 'package:pirc_mobile/live/context_pane.dart';
import 'package:pirc_mobile/live/files_pane.dart';
import 'live_test.dart' show FakeGateway, theme;

final fixture = obj(
  jsonDecode(
    File('../../fixtures/mobile-parity/side-panel.json').readAsStringSync(),
  ),
);

class PanelGateway extends FakeGateway {
  Json prefs = {};
  @override
  dynamic normal(String method, Json args) {
    if (method == 'preferences') return prefs;
    if (method == 'savePreferences') return prefs = {...prefs, ...args};
    if (method == 'request') {
      final path = '${args['path']}';
      if (path.endsWith('/panel/context')) return fixture['context'];
      if (path.endsWith('/panel/state')) return fixture['panel'];
      if (path.contains('/files?')) return fixture['directory'];
    }
    return super.normal(method, args);
  }
}

void main() {
  for (final width in [390.0, 651.0, 1280.0]) {
    testWidgets(
      'saved panel layout at $width respects overlay and safe areas',
      (t) async {
        t.view.devicePixelRatio = 1;
        t.view.physicalSize = Size(width, 900);
        t.view.padding = const FakeViewPadding(top: 24, bottom: 24);
        addTearDown(t.view.reset);
        final g = PanelGateway()
          ..prefs = {
            'panelWidth': 512,
            'detailsOpen': true,
            'sidebarCollapsed': false,
          };
        final c = LiveController(g, showing: 'engine');
        await t.pumpWidget(MobileApp(theme: theme, controller: c));
        await t.pumpAndSettle();
        await c.open('s');
        g.publish('s');
        await t.pumpAndSettle();
        if (width <= 860) {
          expect(find.byType(NativeSidePanel), findsNothing);
          await t.tap(find.byTooltip('Show side panel'));
          await t.pumpAndSettle();
        }
        final panel = find.byType(NativeSidePanel);
        expect(t.getTopLeft(panel).dy, 80);
        expect(
          t.getSize(panel).width,
          width == 390
              ? 390
              : width == 651
              ? 420
              : 512,
        );
        if (width == 651) expect(t.getTopLeft(panel).dx, 223);
        expect(
          find.byKey(const ValueKey('panel-tab-files')).hitTestable(),
          findsOneWidget,
        );
        if (width <= 860) {
          expect(
            g.prefs['detailsOpen'],
            true,
            reason: 'overlay toggles do not overwrite desktop preference',
          );
        }
        expect(t.takeException(), isNull);
        await t.pumpWidget(const SizedBox());
        await g.stream.close();
      },
    );
  }

  testWidgets(
    'tabs follow viewport/container rules, roving focus and resize keyboard/drag/reset',
    (t) async {
      t.view.devicePixelRatio = 1;
      t.view.physicalSize = const Size(1280, 900);
      addTearDown(t.view.reset);
      String tab = 'files';
      double width = 360;
      bool chat = false;
      late StateSetter update;
      await t.pumpWidget(
        MaterialApp(
          theme: theme.build(Brightness.light),
          home: StatefulBuilder(
            builder: (context, set) {
              update = set;
              return Scaffold(
                body: Align(
                  alignment: Alignment.centerRight,
                  child: SizedBox(
                    width: width,
                    height: 600,
                    child: NativeSidePanel(
                      tab: tab,
                      git: !chat,
                      terminal: !chat,
                      open: true,
                      overlay: false,
                      width: width,
                      maxWidth: 636,
                      touch: true,
                      activity: const {'memory': 1, 'tasks': 1},
                      onSelect: (v) => set(() => tab = v),
                      onResize: (v) => set(() => width = v),
                      child: const SizedBox(),
                    ),
                  ),
                ),
              );
            },
          ),
        ),
      );
      expect(find.text('Files'), findsOneWidget);
      expect(find.text('Git'), findsNothing);
      expect(t.getSize(find.byKey(const Key('side-panel-tabs'))).height, 55);
      t
          .widget<TextButton>(find.byKey(const ValueKey('panel-tab-files')))
          .focusNode!
          .requestFocus();
      await t.pump();
      await t.sendKeyEvent(LogicalKeyboardKey.arrowRight);
      await t.pumpAndSettle();
      expect(tab, 'git');
      expect(find.text('Git'), findsOneWidget);
      await t.sendKeyEvent(LogicalKeyboardKey.end);
      await t.pumpAndSettle();
      expect(tab, 'browser');
      final handle = find.byKey(const Key('panel-resizer'));
      Focus.of(t.element(handle)).requestFocus();
      await t.pump();
      await t.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
      await t.pump();
      expect(width, 376);
      await t.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
      await t.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
      await t.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
      await t.pump();
      expect(width, 440);
      await t.sendKeyEvent(LogicalKeyboardKey.home);
      await t.pump();
      expect(width, 636);
      expect(find.text('Files'), findsOneWidget);
      await t.sendKeyEvent(LogicalKeyboardKey.end);
      await t.pump();
      expect(width, 280);
      await t.drag(handle, const Offset(-100, 0));
      await t.pump();
      expect(width, greaterThan(340));
      await t.tap(handle);
      await t.pump(const Duration(milliseconds: 50));
      await t.tap(handle);
      await t.pumpAndSettle();
      expect(width, 360);
      update(() => chat = true);
      await t.pumpAndSettle();
      expect(find.byKey(const ValueKey('panel-tab-git')), findsNothing);
      expect(find.byKey(const ValueKey('panel-tab-context')), findsOneWidget);
      t.view.physicalSize = const Size(390, 844);
      await t.pumpAndSettle();
      expect(find.text('Browser'), findsNothing);
      expect(t.takeException(), isNull);
    },
  );
  testWidgets(
    'actual shell starts Files, keeps mounted contents closed, restores focus and persists wide layout',
    (t) async {
      t.view.devicePixelRatio = 1;
      t.view.physicalSize = const Size(1280, 900);
      addTearDown(t.view.reset);
      final g = PanelGateway(), c = LiveController(g, showing: 'engine');
      await t.pumpWidget(MobileApp(theme: theme, controller: c));
      await t.pumpAndSettle();
      await c.open('s');
      g.publish('s');
      await t.pumpAndSettle();
      await t.tap(find.byTooltip('Show side panel'));
      await t.pumpAndSettle();
      final pane = t.state(find.byType(FilesPane));
      expect(g.prefs['detailsOpen'], true);
      expect(t.getTopLeft(find.byType(NativeSidePanel)).dy, 56);
      await t.tap(find.byTooltip('Hide side panel'));
      await t.pumpAndSettle();
      expect(find.byType(FilesPane), findsNothing);
      expect(find.byType(FilesPane, skipOffstage: false), findsOneWidget);
      expect(g.prefs['detailsOpen'], false);
      await t.tap(find.byTooltip('Show side panel'));
      await t.pumpAndSettle();
      expect(t.state(find.byType(FilesPane)), same(pane));
      t.view.physicalSize = const Size(768, 900);
      await t.pumpAndSettle();
      expect(find.byKey(const Key('panel-resizer')), findsNothing);
      await t.sendKeyEvent(LogicalKeyboardKey.escape);
      await t.pumpAndSettle();
      expect(find.byType(NativeSidePanel), findsNothing);
      expect(
        t
            .widget<IconButton>(
              find.byWidgetPredicate(
                (w) => w is IconButton && w.tooltip == 'Show side panel',
              ),
            )
            .focusNode!
            .hasFocus,
        true,
      );
      await t.pumpWidget(const SizedBox());
      await g.stream.close();
    },
  );
  testWidgets(
    'Context preserves exact sections, copies only system text and opens source; hidden reads cannot replace another account',
    (t) async {
      t.view.devicePixelRatio = 1;
      t.view.physicalSize = const Size(500, 1000);
      addTearDown(t.view.reset);
      final g = PanelGateway(),
          c = LiveController(g, showing: 'engine')
            ..sessionId = 's'
            ..origin = 'one'
            ..clientId = 'a';
      String? path;
      bool active = true;
      late StateSetter update;
      String? clipboard;
      t.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          if (call.method == 'Clipboard.setData') {
            clipboard = call.arguments['text'];
          }
          return null;
        },
      );
      addTearDown(
        () => t.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform,
          null,
        ),
      );
      await t.pumpWidget(
        MaterialApp(
          theme: theme.build(Brightness.light),
          home: StatefulBuilder(
            builder: (context, set) {
              update = set;
              return Scaffold(
                body: TickerMode(
                  enabled: active,
                  child: ContextPane(controller: c, onFile: (p) => path = p),
                ),
              );
            },
          ),
        ),
      );
      await t.pumpAndSettle();
      expect(find.textContaining('Saved snapshot'), findsOneWidget);
      expect(find.textContaining('Reported input: 1,200'), findsOneWidget);
      await t.tap(find.text('Copy all'));
      await t.pumpAndSettle();
      expect(clipboard, 'Exact system prompt\nPreserve the source text.');
      await t.tap(find.textContaining('System prompt ~'));
      await t.pumpAndSettle();
      await t.tap(find.text('AGENTS.md'));
      expect(path, 'AGENTS.md');
      expect(
        find.text('Exact system prompt\nPreserve the source text.'),
        findsOneWidget,
      );
      final pending = Completer<dynamic>();
      g.handler = (_, _) => pending.future;
      await t.tap(find.text('Refresh'));
      await t.pump();
      update(() => active = false);
      await t.pump();
      c.origin = 'two';
      c.clientId = 'b';
      c.changed();
      await t.pump();
      pending.complete(fixture['context']);
      await t.pumpAndSettle();
      g.handler = (_, _) async => throw PlatformException(
        code: 'HTTP_403',
        message: 'Context not available for this device',
      );
      update(() => active = true);
      await t.pumpAndSettle();
      expect(
        find.text('Exact system prompt\nPreserve the source text.'),
        findsNothing,
      );
      expect(
        find.text('Context not available for this device'),
        findsOneWidget,
      );
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    },
  );
}
