import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/backend_api.dart';
import 'package:pirc_mobile/live/backend_settings.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/provider_editor.dart';
import 'settings_shell.dart' show shell, tap;
import 'live_test.dart' show FakeGateway, theme;

Json snapshot({
  String id = 'local',
  bool readOnly = false,
  Json? defaultModel,
}) => {
  'providers': [
    {
      'id': id,
      'name': 'Local',
      'source': readOnly ? 'file' : 'ui',
      'readOnly': readOnly,
      'api': 'openai-completions',
      'baseUrl': 'https://example.test/v1',
      'hasApiKey': true,
      'models': [
        {'id': 'model', 'name': 'Test model'},
      ],
    },
    {
      'id': 'subscription',
      'name': 'Subscription',
      'source': 'oauth',
      'readOnly': true,
      'models': [
        {'id': 'sub-model'},
      ],
    },
  ],
  'oauthProviders': [],
  'defaultModel': ?defaultModel,
};

void main() {
  test('backend errors keep status and redact upstream credentials', () async {
    final g = FakeGateway(), c = LiveController(g, showing: 'engine');
    for (final message in [
      'token abc',
      'api_key abc',
      'https://private.test',
      'x=y',
      'x:y',
      '{private}',
      'a' * 201,
    ]) {
      g.handler = (_, args) async =>
          throw PlatformException(code: 'HTTP_409', message: message);
      await expectLater(
        backendRequest(c, '/api/providers'),
        throwsA(
          isA<BackendException>()
              .having((e) => e.status, 'status', 409)
              .having(
                (e) => e.message,
                'message',
                'Backend request failed (409). Check your settings and try again.',
              ),
        ),
      );
    }
    g.handler = (_, args) async =>
        throw PlatformException(code: 'HTTP_403', message: 'Access denied');
    await expectLater(
      backendRequest(c, '/api/providers'),
      throwsA(
        isA<BackendException>().having(
          (e) => e.message,
          'message',
          'Access denied',
        ),
      ),
    );
    g.handler = (_, args) async => throw StateError('private network detail');
    await expectLater(
      backendRequest(c, '/api/providers'),
      throwsA(
        isA<BackendException>().having(
          (e) => e.message,
          'message',
          backendFailure,
        ),
      ),
    );
    c.dispose();
    await g.stream.close();
  });

  testWidgets(
    'file providers are read only; subscription models remain choices',
    (t) async {
      final g = FakeGateway(), c = LiveController(g, showing: 'engine');
      g.handler = (_, args) async => snapshot(readOnly: true);
      await t.pumpWidget(shell(BackendSettings(controller: c)));
      await t.pumpAndSettle();
      expect(find.textContaining('File-managed · Read only'), findsOneWidget);
      expect(find.text('Edit local'), findsNothing);
      expect(find.text('Remove local'), findsNothing);
      expect(find.byKey(const ValueKey('backend-subscription')), findsNothing);
      final select = t.widget<DropdownButton<String>>(
        find.byType(DropdownButton<String>),
      );
      expect(
        select.items!.map((i) => i.value),
        contains(jsonEncode(['subscription', 'sub-model'])),
      );
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    },
  );

  testWidgets(
    'deletion sends exact endpoint; failed mutation keeps card and safe error',
    (t) async {
      final g = FakeGateway(), c = LiveController(g, showing: 'engine');
      var fail = true;
      g.handler = (_, args) async {
        if (args['method'] == 'DELETE') {
          if (fail) {
            throw PlatformException(
              code: 'HTTP_403',
              message: 'token is private',
            );
          }
          return {'providers': [], 'oauthProviders': []};
        }
        if (args['path'] == '/api/models') {
          return {
            'models': [
              {'id': 'fresh'},
            ],
          };
        }
        return snapshot(id: 'local/id');
      };
      await t.pumpWidget(shell(BackendSettings(controller: c)));
      await t.pumpAndSettle();
      await tap(t, 'Remove local/id');
      await t.pumpAndSettle();
      expect(find.text('Remove local/id'), findsOneWidget);
      expect(
        find.text(
          'Backend request failed (403). Check your settings and try again.',
        ),
        findsOneWidget,
      );
      expect(
        g.calls.where((call) => call.$1 == 'request').last.$2['path'],
        '/api/providers/local%2Fid',
      );
      fail = false;
      await tap(t, 'Remove local/id');
      await t.pumpAndSettle();
      expect(find.text('Remove local/id'), findsNothing);
      expect(c.models.single['id'], 'fresh');
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    },
  );

  testWidgets(
    'default saves tuple, preserves unsaved choice on same saved default',
    (t) async {
      final g = FakeGateway(), c = LiveController(g, showing: 'engine');
      dynamic body;
      g.handler = (_, args) async {
        if (args['path'] == '/api/models') return {'models': []};
        if (args['method'] == 'PUT') body = args['body'];
        if (args['method'] == 'DELETE') return snapshot();
        return snapshot();
      };
      await t.pumpWidget(shell(BackendSettings(controller: c)));
      await t.pumpAndSettle();
      final selected = jsonEncode(['subscription', 'sub-model']);
      t
          .widget<DropdownButton<String>>(find.byType(DropdownButton<String>))
          .onChanged!(selected);
      await t.pump();
      await tap(t, 'Remove local');
      await t.pumpAndSettle();
      expect(
        t
            .widget<DropdownButton<String>>(find.byType(DropdownButton<String>))
            .value,
        selected,
      );
      await tap(t, 'Save default');
      await t.pumpAndSettle();
      expect(body, {'provider': 'subscription', 'id': 'sub-model'});
      t
          .widget<DropdownButton<String>>(find.byType(DropdownButton<String>))
          .onChanged!('');
      await t.pump();
      await tap(t, 'Save default');
      await t.pumpAndSettle();
      expect(body, isNull);
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    },
  );

  testWidgets('successful mutation survives a secondary model-list failure', (
    t,
  ) async {
    final g = FakeGateway(), c = LiveController(g, showing: 'engine');
    g.handler = (_, args) async {
      if (args['path'] == '/api/models') {
        throw PlatformException(code: 'HTTP_503', message: 'Unavailable');
      }
      if (args['method'] == 'DELETE') {
        return {'providers': [], 'oauthProviders': []};
      }
      return snapshot();
    };
    await t.pumpWidget(shell(BackendSettings(controller: c)));
    await t.pumpAndSettle();
    await tap(t, 'Remove local');
    await t.pumpAndSettle();
    expect(find.text('Remove local'), findsNothing);
    expect(find.text(backendFailure), findsNothing);
    expect(find.textContaining('503'), findsNothing);
    await t.pumpWidget(const SizedBox());
    c.dispose();
    await g.stream.close();
  });

  testWidgets(
    'subscription logout reaches parent mutation without locking it out',
    (t) async {
      final g = FakeGateway(), c = LiveController(g, showing: 'engine');
      g.handler = (_, args) async {
        if (args['path'] == '/api/models') return {'models': []};
        return {
          ...snapshot(),
          'oauthProviders': [
            {
              'id': 'oauth',
              'providerId': 'saved/oauth',
              'name': 'Account',
              'connected': true,
              'modelCount': 1,
            },
          ],
        };
      };
      await t.pumpWidget(shell(BackendSettings(controller: c)));
      await t.pumpAndSettle();
      await tap(t, 'Log out Account');
      await t.pumpAndSettle();
      expect(
        g.calls.where(
          (call) =>
              call.$2['path'] == '/api/providers/saved%2Foauth' &&
              call.$2['method'] == 'DELETE',
        ),
        hasLength(1),
      );
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    },
  );

  testWidgets(
    'failed edit retains editor, clears typed key, and can save again',
    (t) async {
      final g = FakeGateway(), c = LiveController(g, showing: 'engine');
      var fail = true;
      final writes = <Json>[];
      g.handler = (_, args) async {
        if (args['path'] == '/api/providers/presets') return {'presets': []};
        if (args['path'] == '/api/models') return {'models': []};
        if (args['method'] == 'PUT') {
          writes.add(obj(args['body']));
          if (fail) {
            throw PlatformException(
              code: 'HTTP_500',
              message: 'Unable to save',
            );
          }
        }
        return snapshot();
      };
      await t.pumpWidget(shell(BackendSettings(controller: c)));
      await t.pumpAndSettle();
      await tap(t, 'Edit local');
      await t.pumpAndSettle();
      final field = find.descendant(
        of: find.byKey(const ValueKey('provider-editor-api-key')),
        matching: find.byType(TextField),
      );
      await t.enterText(field, 'test-credential');
      FocusManager.instance.primaryFocus?.unfocus();
      await t.pumpAndSettle();
      final save = find.widgetWithText(TextButton, 'Save backend');
      await t.ensureVisible(save);
      await t.pumpAndSettle();
      await t.tap(save);
      await t.pumpAndSettle();
      expect(find.byType(ProviderEditor), findsOneWidget);
      expect(t.widget<TextField>(field).controller!.text, isEmpty);
      expect(writes.single['apiKey'], 'test-credential');
      fail = false;
      await tap(t, 'Save backend');
      await t.pumpAndSettle();
      expect(find.byType(ProviderEditor), findsNothing);
      expect(writes.last.containsKey('apiKey'), isFalse);
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    },
  );

  testWidgets('old account snapshot cannot replace new account', (t) async {
    final g = FakeGateway(),
        c = LiveController(g, showing: 'engine')..origin = 'old';
    final old = Completer<Json>();
    var calls = 0;
    g.handler = (_, args) async =>
        ++calls == 1 ? old.future : snapshot(id: 'new');
    await t.pumpWidget(shell(BackendSettings(controller: c)));
    await t.pump();
    c.origin = 'new';
    c.changed();
    await t.pumpAndSettle();
    old.complete(snapshot(id: 'old'));
    await t.pumpAndSettle();
    expect(find.text('Remove new'), findsOneWidget);
    expect(find.text('Remove old'), findsNothing);
    await t.pumpWidget(const SizedBox());
    c.dispose();
    await g.stream.close();
  });

  testWidgets('controller replacement drops old in-flight mutation', (t) async {
    final g = FakeGateway(), c = LiveController(g, showing: 'engine');
    final g2 = FakeGateway(), c2 = LiveController(g2, showing: 'engine');
    final response = Completer<Json>();
    g.handler = (_, args) async =>
        args['method'] == 'DELETE' ? response.future : snapshot();
    g2.handler = (_, args) async => snapshot(id: 'new');
    await t.pumpWidget(shell(BackendSettings(controller: c)));
    await t.pumpAndSettle();
    await tap(t, 'Remove local');
    await t.pumpWidget(shell(BackendSettings(controller: c2)));
    await t.pumpAndSettle();
    response.complete({'providers': [], 'oauthProviders': []});
    await t.pumpAndSettle();
    expect(find.text('Remove new'), findsOneWidget);
    expect(g.calls.where((call) => call.$2['path'] == '/api/models'), isEmpty);
    await t.pumpWidget(const SizedBox());
    c.dispose();
    c2.dispose();
    await g.stream.close();
    await g2.stream.close();
  });

  testWidgets('demo performs no requests and loads when enabled', (t) async {
    final g = FakeGateway(), c = LiveController(g, showing: 'engine');
    g.handler = (_, args) async => snapshot();
    await t.pumpWidget(shell(BackendSettings(controller: c, disabled: true)));
    await t.pumpAndSettle();
    expect(g.calls, isEmpty);
    await t.pumpWidget(shell(BackendSettings(controller: c)));
    await t.pumpAndSettle();
    expect(find.text('Remove local'), findsOneWidget);
    await t.pumpWidget(const SizedBox());
    c.dispose();
    await g.stream.close();
  });

  testWidgets(
    'provider cards and default selector fit phone and tablet text scales',
    (t) async {
      addTearDown(t.view.reset);
      for (final width in [390.0, 768.0]) {
        for (final brightness in Brightness.values) {
          for (final scale in [1.0, 2.0]) {
            t.view.devicePixelRatio = 1;
            t.view.physicalSize = Size(width, 844);
            final g = FakeGateway(), c = LiveController(g, showing: 'engine');
            g.handler = (_, args) async =>
                snapshot(id: 'a-long-custom-provider-name');
            await t.pumpWidget(
              MaterialApp(
                theme: theme.build(brightness),
                builder: (_, child) => MediaQuery(
                  data: MediaQueryData(
                    size: Size(width, 844),
                    textScaler: TextScaler.linear(scale),
                  ),
                  child: child!,
                ),
                home: Scaffold(
                  body: SingleChildScrollView(
                    padding: const EdgeInsets.all(24),
                    child: BackendSettings(controller: c),
                  ),
                ),
              ),
            );
            await t.pumpAndSettle();
            await t.ensureVisible(find.byType(DropdownButton<String>));
            await t.pump();
            expect(t.takeException(), isNull);
            await t.pumpWidget(const SizedBox());
            c.dispose();
            await g.stream.close();
          }
        }
      }
    },
  );

  test('latest model refresh wins for the same account and session', () async {
    final g = FakeGateway(), c = LiveController(g, showing: 'engine');
    final first = Completer<Json>(), second = Completer<Json>();
    var calls = 0;
    g.handler = (_, args) => ++calls == 1 ? first.future : second.future;
    final a = c.refreshModels(), b = c.refreshModels();
    second.complete({
      'models': [
        {'id': 'new'},
      ],
    });
    await b;
    first.complete({
      'models': [
        {'id': 'old'},
      ],
    });
    await a;
    expect(c.models.single['id'], 'new');
    c.dispose();
    await g.stream.close();
  });

  test('model refresh ignores old account and session response', () async {
    final g = FakeGateway(),
        c = LiveController(g, showing: 'engine')..sessionId = 'one';
    final response = Completer<Json>();
    g.handler = (_, args) => response.future;
    final pending = c.refreshModels();
    c.sessionId = 'two';
    response.complete({
      'models': [
        {'id': 'old'},
      ],
    });
    await pending;
    expect(c.models, isEmpty);
    c.dispose();
    await g.stream.close();
  });
}
