import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/app_document_route.dart';
import 'package:pirc_mobile/live/document_navigation_state.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/settings_dialog.dart';
import 'package:pirc_mobile/live/workspace_page.dart';
import 'live_test.dart' show FakeGateway, theme;

final fixture = obj(
  jsonDecode(
    File(
      '../../fixtures/mobile-parity/app-document-routes.json',
    ).readAsStringSync(),
  ),
);
final expected = obj(
  jsonDecode(
    File(
      '../../fixtures/mobile-parity/app-document-routes-expected.json',
    ).readAsStringSync(),
  ),
);
final api = obj(fixture['apiFixture']);

class RouteGateway extends FakeGateway {
  String selected = "session-latest";
  RouteGateway() {
    snapshot = {
      'session': rows(api['sessions']).first,
      'messages': [],
      'interactions': [],
      'queue': [],
      'widgets': {},
    };
  }
  @override
  Future<dynamic> call(String method, [Json args = const {}]) async {
    final result = await super.call(method, args);
    if (method == 'watch') {
      snapshot = {
        ...snapshot,
        'session': rows(
          api['sessions'],
        ).firstWhere((s) => s['id'] == args['sessionId']),
      };
      publish('${args['sessionId']}');
    }
    return result;
  }

  @override
  dynamic normal(String method, Json args) {
    if (method == 'watch') selected = '${args['sessionId']}';
    if (method == 'refresh') {
      return {
        ...snapshot,
        'session': rows(api['sessions']).firstWhere((s) => s['id'] == selected),
      };
    }
    if (method == 'request') {
      final path = '${args['path']}';
      if (path == '/api/sessions') return {'sessions': api['sessions']};
      if (path == '/api/workspaces') return {'workspaces': api['workspaces']};
      if (path == '/api/nodes') return {'nodes': api['nodes']};
      if (path == '/api/memory') return api['memory'];
    }
    return super.normal(method, args);
  }
}

NativeDocumentScope scope(WidgetTester tester) =>
    tester.widget<NativeDocumentScope>(find.byType(NativeDocumentScope).first);

Future<void> finish(
  WidgetTester tester,
  RouteGateway gateway,
  LiveController controller,
) async {
  await tester.pumpWidget(const SizedBox());
  await gateway.stream.close();
  await tester.pump();
}

void main() {
  for (final width in [390.0, 768.0]) {
    for (final source in rows(fixture['cases'])) {
      final oracle = rows(
        expected['cases'],
      ).firstWhere((entry) => entry['caseId'] == source['id']);
      testWidgets(
        'native App route ${source['id']} width $width matches pinned Chrome state',
        (tester) async {
          tester.view.devicePixelRatio = 1;
          tester.view.physicalSize = Size(width, 1000);
          addTearDown(tester.view.reset);
          final gateway = RouteGateway();
          final c = LiveController(gateway);
          await tester.pumpWidget(MobileApp(theme: theme, controller: c));
          await tester.pumpAndSettle();
          final route = NativeAppDocumentRoute.parse(
            'https://gateway.example${source['url']}',
            appRootUrl: 'https://gateway.example/',
            allowSpaFallback: true,
          )!;
          await scope(tester).windows.onAppRoute!(route);
          await tester.pumpAndSettle();
          final state = obj(oracle['appState']);
          expect(c.sessionId, state['activeSessionId']);
          expect(
            scope(tester).documentUrl,
            Uri.parse('${oracle['finalUrl']}')
                .replace(scheme: 'https', host: 'gateway.example', port: 443)
                .toString(),
          );
          final workspace = find.byType(WorkspacePage);
          expect(
            workspace,
            state['view'] == 'workspace' ? findsOneWidget : findsNothing,
          );
          if (state['view'] == 'workspace') {
            expect(
              tester.widget<WorkspacePage>(workspace).workspaceId,
              state['workspaceViewId'],
            );
          }
          final visible = obj(oracle['visiblePage']);
          expect(c.state.isNotEmpty, isTrue);
          expect(
            find.byType(NativeSettingsDialog),
            visible['settingsOpen'] == true ? findsOneWidget : findsNothing,
          );
          if (visible['settingsOpen'] == true) {
            expect(
              tester
                  .widget<NativeSettingsDialog>(
                    find.byType(NativeSettingsDialog),
                  )
                  .initialTab,
              visible['settingsTab'],
            );
          }
          if (width == 390 && visible['settingsOpen'] != true) {
            final hasDraft = find
                .byKey(const Key('live-draft'))
                .evaluate()
                .isNotEmpty;
            expect(
              hasDraft,
              state['view'] == 'session' &&
                  obj(oracle['phoneNavigation'])['listOpen'] == false,
            );
          }
          expect(tester.takeException(), isNull);
          await finish(tester, gateway, c);
        },
      );
    }
  }
  testWidgets('same-session route preserves draft and does not rewatch', (
    tester,
  ) async {
    final gateway = RouteGateway();
    final controller = LiveController(gateway);
    await tester.pumpWidget(MobileApp(theme: theme, controller: controller));
    await tester.pumpAndSettle();
    await controller.open('session-latest');
    controller.editDraft('retain draft');
    final watches = gateway.calls.where((call) => call.$1 == 'watch').length;
    final route = NativeAppDocumentRoute.parse(
      'https://gateway.example/?session=session-latest',
      appRootUrl: 'https://gateway.example/',
    )!;
    await scope(tester).windows.onAppRoute!(route);
    await tester.pumpAndSettle();
    expect(controller.draft, 'retain draft');
    expect(gateway.calls.where((call) => call.$1 == 'watch').length, watches);
    await finish(tester, gateway, controller);
  });
  testWidgets('a newer session selection cancels a route waiting for lists', (
    tester,
  ) async {
    final gateway = RouteGateway();
    final controller = LiveController(gateway);
    await tester.pumpWidget(MobileApp(theme: theme, controller: controller));
    await tester.pumpAndSettle();
    final pending = Completer<Json>();
    gateway.handler = (method, args) async =>
        method == 'request' && args['path'] == '/api/sessions'
        ? pending.future
        : gateway.normal(method, args);
    final route = NativeAppDocumentRoute.parse(
      'https://gateway.example/?open=memory',
      appRootUrl: 'https://gateway.example/',
    )!;
    final routed = scope(tester).windows.onAppRoute!(route);
    await tester.pump();
    await controller.open('session-second');
    pending.complete({'sessions': api['sessions']});
    await routed;
    await tester.pumpAndSettle();
    expect(controller.sessionId, 'session-second');
    expect(find.byType(NativeSettingsDialog), findsNothing);
    await finish(tester, gateway, controller);
  });
  testWidgets(
    'a route with an empty refreshed session list clears the old session',
    (tester) async {
      final gateway = RouteGateway();
      final c = LiveController(gateway);
      await tester.pumpWidget(MobileApp(theme: theme, controller: c));
      await tester.pumpAndSettle();
      expect(c.sessionId, 'session-latest');
      gateway.handler = (method, args) async =>
          method == 'request' && args['path'] == '/api/sessions'
          ? {'sessions': []}
          : gateway.normal(method, args);
      final route = NativeAppDocumentRoute.parse(
        'https://gateway.example/?session=missing',
        appRootUrl: 'https://gateway.example/',
      )!;
      await scope(tester).windows.onAppRoute!(route);
      await tester.pumpAndSettle();
      expect(c.sessionId, isNull);
      expect(c.state, isEmpty);
      expect(scope(tester).documentUrl, route.canonicalUrl);
      expect(tester.takeException(), isNull);
      await finish(tester, gateway, c);
    },
  );
}
