import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/provider_editor.dart';

import 'settings_shell.dart' show tap;
import 'live_test.dart' show FakeGateway, theme;

Json presetResponse() => {
  'presets': [
    {
      'id': 'openai',
      'name': 'OpenAI',
      'api': 'openai-completions',
      'baseUrl': 'https://api.openai.com/v1',
      'catalog': true,
      'models': [
        {
          'id': 'gpt-4o',
          'name': 'GPT 4o',
          'contextWindow': 128000,
          'maxTokens': 16384,
          'reasoning': false,
          'input': ['text', 'image'],
          'provider': 'openai',
        },
        {'id': 'gpt-4o-mini', 'name': 'GPT 4o mini'},
      ],
    },
    {
      'id': 'local',
      'name': 'Local server',
      'api': 'openai-completions',
      'baseUrl': 'http://localhost:11434/v1',
      'catalog': false,
      'keyless': true,
    },
  ],
};

Widget editorShell(ProviderEditor editor) => MaterialApp(
  theme: theme.build(Brightness.light),
  home: Scaffold(
    body: SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: editor,
    ),
  ),
);

Finder field(String key) => find.descendant(
  of: find.byKey(ValueKey(key)),
  matching: find.byType(TextField),
);

List<Json> requests(FakeGateway gateway, String path) => gateway.calls
    .where((call) => call.$1 == 'request' && call.$2['path'] == path)
    .map((call) => call.$2)
    .toList();

Future<void> tapVisible(WidgetTester tester, Finder finder) async {
  await tester.ensureVisible(finder);
  await tester.pump();
  await tester.tap(finder);
  await tester.pump();
}

void main() {
  testWidgets(
    'two-times text keeps the complete input line inside the 40px control',
    (t) async {
      final gateway = FakeGateway(), controller = LiveController(gateway);
      gateway.handler = (_, args) async => {'presets': []};
      await t.pumpWidget(
        MaterialApp(
          theme: theme.build(Brightness.light),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(
              context,
            ).copyWith(textScaler: const TextScaler.linear(2)),
            child: child!,
          ),
          home: Scaffold(
            body: SingleChildScrollView(
              child: ProviderEditor(
                controller: controller,
                provider: {
                  'id': 'local',
                  'baseUrl': 'http://localhost:11434/v1',
                  'models': [],
                },
                onSave: (_, _, _) async {},
                onCancel: () {},
              ),
            ),
          ),
        ),
      );
      await t.pumpAndSettle();
      final input = field('provider-editor-base-url');
      final editable = t
          .state<EditableTextState>(
            find.descendant(of: input, matching: find.byType(EditableText)),
          )
          .renderEditable;
      expect(t.getSize(input).height, 40);
      expect(editable.size.height, greaterThanOrEqualTo(36));
      final caret = editable.getLocalRectForCaret(
        const TextPosition(offset: 0),
      );
      expect(
        editable.localToGlobal(caret.topLeft).dx - t.getRect(input).left,
        12,
      );
      expect(t.takeException(), isNull);
      await t.pumpWidget(const SizedBox());
      controller.dispose();
      await gateway.stream.close();
    },
  );

  testWidgets(
    'model details support keyboard toggle and retain edited fields',
    (t) async {
      final gateway = FakeGateway(), controller = LiveController(gateway);
      gateway.handler = (_, args) async => {'presets': []};
      await t.pumpWidget(
        editorShell(
          ProviderEditor(
            controller: controller,
            provider: {
              'id': 'local',
              'baseUrl': 'http://localhost:11434/v1',
              'models': [
                {'id': 'model', 'name': 'Original'},
              ],
            },
            onSave: (_, _, _) async {},
            onCancel: () {},
          ),
        ),
      );
      await t.pumpAndSettle();
      final details = find.widgetWithText(TextButton, 'Details');
      expect(find.text('Display name'), findsNothing);
      await tapVisible(t, details);
      await t.pumpAndSettle();
      await t.enterText(field('provider-model-model-name'), 'Edited');
      FocusManager.instance.primaryFocus?.unfocus();
      await t.pumpAndSettle();
      await t.ensureVisible(details);
      await t.pumpAndSettle();
      Focus.of(t.element(find.text('Details'))).requestFocus();
      await t.pump();
      await t.sendKeyEvent(LogicalKeyboardKey.space);
      await t.pumpAndSettle();
      expect(find.text('Display name'), findsNothing);
      await t.sendKeyEvent(LogicalKeyboardKey.enter);
      await t.pumpAndSettle();
      expect(find.text('Display name'), findsOneWidget);
      expect(
        t
            .widget<TextField>(field('provider-model-model-name'))
            .controller!
            .text,
        'Edited',
      );
      expect(t.takeException(), isNull);
      await t.pumpWidget(const SizedBox());
      controller.dispose();
      await gateway.stream.close();
    },
  );

  testWidgets(
    'preset selection suggests a free id and saves editable catalog models',
    (t) async {
      final gateway = FakeGateway(), controller = LiveController(gateway);
      String? savedId, editingId;
      Json? savedInput;
      gateway.handler = (_, args) async => presetResponse();
      await t.pumpWidget(
        editorShell(
          ProviderEditor(
            controller: controller,
            takenIds: const ['openai'],
            onSave: (id, input, edit) async {
              savedId = id;
              savedInput = input;
              editingId = edit;
            },
            onCancel: () {},
          ),
        ),
      );
      await t.pumpAndSettle();
      await tap(t, 'Custom endpoint');
      await tap(t, 'OpenAI');
      await t.pumpAndSettle();

      expect(
        t.widget<TextField>(field('provider-editor-id')).controller!.text,
        'openai-2',
      );
      expect(
        t.widget<TextField>(field('provider-editor-base-url')).controller!.text,
        'https://api.openai.com/v1',
      );
      expect(find.text('GPT 4o'), findsOneWidget);
      await t.tap(find.text('GPT 4o'));
      await t.pump();
      expect(
        find.text('gpt-4o · 128K context · 16K output · images'),
        findsWidgets,
      );
      await tap(t, 'Save backend');
      await t.pumpAndSettle();

      expect(savedId, 'openai-2');
      expect(editingId, isNull);
      expect(savedInput, {
        'api': 'openai-completions',
        'baseUrl': 'https://api.openai.com/v1',
        'opencodeGo': false,
        'apiKey': '',
        'preset': 'openai',
        'models': [
          {
            'id': 'gpt-4o',
            'name': 'GPT 4o',
            'contextWindow': 128000,
            'maxTokens': 16384,
            'reasoning': false,
            'input': ['text', 'image'],
          },
        ],
      });
      expect(requests(gateway, '/api/providers/presets'), hasLength(1));
      await t.pumpWidget(const SizedBox());
      controller.dispose();
      await gateway.stream.close();
    },
  );

  testWidgets(
    'edit reuses a write-only saved key on probes and clears it after saving',
    (t) async {
      final gateway = FakeGateway(), controller = LiveController(gateway);
      Json? savedInput;
      gateway.handler = (_, args) async {
        if (args['path'] == '/api/providers/presets') return presetResponse();
        if (args['path'] == '/api/providers/test') {
          return {'ok': true, 'message': 'Endpoint is reachable'};
        }
        return <String, dynamic>{};
      };
      await t.pumpWidget(
        editorShell(
          ProviderEditor(
            controller: controller,
            provider: {
              'id': 'private-provider',
              'api': 'openai-responses',
              'baseUrl': 'https://provider.example/v1',
              'hasApiKey': true,
              'apiKey': 'must never be shown',
              'source': 'gateway-only',
              'models': [
                {
                  'id': 'model-a',
                  'name': 'Existing model',
                  'contextWindow': 32768,
                  'maxTokens': 4096,
                  'reasoning': true,
                  'input': ['text', 'image'],
                  'provider': 'gateway-only',
                  'baseUrl': 'gateway-only',
                },
              ],
            },
            onSave: (_, input, _) async => savedInput = input,
            onCancel: () {},
          ),
        ),
      );
      await t.pumpAndSettle();
      final keyField = t.widget<TextField>(field('provider-editor-api-key'));
      expect(keyField.controller!.text, isEmpty);
      expect(keyField.obscureText, isTrue);

      await tap(t, 'Test connection');
      await t.pumpAndSettle();
      expect(requests(gateway, '/api/providers/test').single['body'], {
        'api': 'openai-responses',
        'baseUrl': 'https://provider.example/v1',
        'opencodeGo': false,
        'backendId': 'private-provider',
        'model': {
          'id': 'model-a',
          'name': 'Existing model',
          'contextWindow': 32768,
          'maxTokens': 4096,
          'reasoning': true,
          'input': ['text', 'image'],
        },
      });
      expect(find.text('Connected. Endpoint is reachable'), findsOneWidget);

      await t.enterText(field('provider-editor-api-key'), 'replacement-secret');
      await t.pump();
      await tap(t, 'Save backend');
      await t.pumpAndSettle();
      expect(savedInput?['apiKey'], 'replacement-secret');
      expect(
        t.widget<TextField>(field('provider-editor-api-key')).controller!.text,
        isEmpty,
      );
      expect(savedInput!.containsKey('source'), isFalse);
      expect(savedInput!.containsKey('hasApiKey'), isFalse);
      await t.pumpWidget(const SizedBox());
      controller.dispose();
      await gateway.stream.close();
    },
  );

  testWidgets(
    'explicit key removal probes without reuse and saves an empty key',
    (t) async {
      final gateway = FakeGateway(), controller = LiveController(gateway);
      Json? savedInput;
      gateway.handler = (_, args) async {
        if (args['path'] == '/api/providers/presets') return presetResponse();
        if (args['path'] == '/api/providers/test') {
          return {'ok': true, 'message': 'ok'};
        }
        return <String, dynamic>{};
      };
      await t.pumpWidget(
        editorShell(
          ProviderEditor(
            controller: controller,
            provider: {
              'id': 'keyed',
              'api': 'openai-completions',
              'baseUrl': 'http://localhost:11434/v1',
              'hasApiKey': true,
              'models': [
                {'id': 'model'},
              ],
            },
            onSave: (_, input, _) async => savedInput = input,
            onCancel: () {},
          ),
        ),
      );
      await t.pumpAndSettle();
      await t.tap(find.text('Remove the saved API key'));
      await t.pump();
      await tap(t, 'Test connection');
      await t.pumpAndSettle();
      final body =
          requests(gateway, '/api/providers/test').single['body'] as Json;
      expect(body['apiKey'], '');
      expect(body.containsKey('backendId'), isFalse);

      await tap(t, 'Save backend');
      await t.pumpAndSettle();
      expect(savedInput?['apiKey'], '');
      await t.pumpWidget(const SizedBox());
      controller.dispose();
      await gateway.stream.close();
    },
  );

  testWidgets(
    'discovery, manual models, metadata editing, and safe test errors',
    (t) async {
      final gateway = FakeGateway(), controller = LiveController(gateway);
      Json? savedInput;
      gateway.handler = (_, args) async {
        if (args['path'] == '/api/providers/presets') return presetResponse();
        if (args['path'] == '/api/providers/discover') {
          return {
            'models': [
              {
                'id': 'found-model',
                'name': 'Found model',
                'contextWindow': 64000,
                'maxTokens': 8000,
                'reasoning': false,
                'input': ['text'],
              },
            ],
          };
        }
        if (args['path'] == '/api/providers/test') {
          throw PlatformException(
            code: 'HTTP_502',
            message: 'upstream api_key=private at https://private.example',
          );
        }
        return <String, dynamic>{};
      };
      await t.pumpWidget(
        editorShell(
          ProviderEditor(
            controller: controller,
            provider: {
              'id': 'custom',
              'api': 'openai-completions',
              'baseUrl': 'http://localhost:11434/v1',
              'models': [
                {
                  'id': 'existing',
                  'name': 'Existing',
                  'contextWindow': 1000,
                  'maxTokens': 300,
                  'reasoning': true,
                  'input': ['text', 'image'],
                },
              ],
            },
            onSave: (_, input, _) async => savedInput = input,
            onCancel: () {},
          ),
        ),
      );
      await t.pumpAndSettle();
      await tap(t, 'Fetch models from endpoint');
      await t.pumpAndSettle();
      expect(requests(gateway, '/api/providers/discover').single['body'], {
        'api': 'openai-completions',
        'baseUrl': 'http://localhost:11434/v1',
        'opencodeGo': false,
        'backendId': 'custom',
      });
      expect(
        find.text('Found 1 model. Select the ones to use.'),
        findsOneWidget,
      );
      await t.tap(find.text('Found model'));
      await t.pump();

      await t.tap(find.text('Details').first);
      await t.pumpAndSettle();
      await t.enterText(field('provider-model-existing-name'), 'Changed name');
      await t.enterText(field('provider-model-existing-context'), '4096');
      await t.enterText(field('provider-model-existing-max-tokens'), '512');
      await t.pump();
      await tapVisible(t, find.text('Supports reasoning').first);
      await tapVisible(t, find.text('Supports image input').first);
      await t.pump();

      await t.enterText(
        field('provider-editor-manual-model-id'),
        'manual-model',
      );
      await tap(t, 'Add model');
      await t.pump();
      expect(find.text('manual-model · default limits'), findsOneWidget);

      await tap(t, 'Changed name');
      await t.tap(find.widgetWithText(MenuItemButton, 'Found model'));
      await t.pump();
      await tap(t, 'Test connection');
      await t.pumpAndSettle();
      final testBody =
          requests(gateway, '/api/providers/test').single['body'] as Json;
      expect(testBody['model'], {
        'id': 'found-model',
        'name': 'Found model',
        'contextWindow': 64000,
        'maxTokens': 8000,
        'reasoning': false,
        'input': ['text'],
      });
      expect(
        find.text(
          'Backend request failed (502). Check your settings and try again.',
        ),
        findsOneWidget,
      );
      expect(find.textContaining('private.example'), findsNothing);

      await tap(t, 'Save backend');
      await t.pumpAndSettle();
      expect(savedInput?['models'], [
        {
          'id': 'existing',
          'name': 'Changed name',
          'contextWindow': 4096,
          'maxTokens': 512,
          'reasoning': false,
          'input': ['text'],
        },
        {
          'id': 'found-model',
          'name': 'Found model',
          'contextWindow': 64000,
          'maxTokens': 8000,
          'reasoning': false,
          'input': ['text'],
        },
        {'id': 'manual-model'},
      ]);
      await t.pumpWidget(const SizedBox());
      controller.dispose();
      await gateway.stream.close();
    },
  );

  testWidgets(
    'pending discovery result is ignored after the editor is disposed',
    (t) async {
      final gateway = FakeGateway(), controller = LiveController(gateway);
      final pending = Completer<Json>();
      gateway.handler = (_, args) async {
        if (args['path'] == '/api/providers/presets') return presetResponse();
        if (args['path'] == '/api/providers/discover') return pending.future;
        return <String, dynamic>{};
      };
      await t.pumpWidget(
        editorShell(
          ProviderEditor(
            controller: controller,
            provider: {
              'id': 'local',
              'baseUrl': 'http://localhost:11434/v1',
              'models': [
                {'id': 'model'},
              ],
            },
            onSave: (_, _, _) async {},
            onCancel: () {},
          ),
        ),
      );
      await t.pumpAndSettle();
      await tap(t, 'Fetch models from endpoint');
      await t.pump();
      await t.pumpWidget(const SizedBox());
      pending.complete({
        'models': [
          {'id': 'late-model'},
        ],
      });
      await t.pumpAndSettle();
      expect(t.takeException(), isNull);
      expect(find.text('late-model'), findsNothing);
      controller.dispose();
      await gateway.stream.close();
    },
  );
}
