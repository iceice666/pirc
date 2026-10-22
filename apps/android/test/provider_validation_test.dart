import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/provider_editor.dart';
import 'package:pirc_mobile/live/provider_validation.dart';
import 'live_test.dart' show FakeGateway;
import 'provider_editor_test.dart' show editorShell, field, tapVisible;

Json editingProvider() => {
  'id': 'local',
  'api': 'openai-completions',
  'baseUrl': 'http://localhost:11434/v1',
  'models': [
    {'id': 'model', 'contextWindow': 128000, 'maxTokens': 4096},
  ],
};

void main() {
  test(
    'optional token counts accept integers and reject invalid numeric drafts',
    () {
      for (final value in [
        '',
        '+1',
        '1.e2',
        '1',
        '12',
        '2.0',
        '1e3',
        '1E+3',
        '1.',
      ]) {
        expect(providerTokenError(value), isNull, reason: value);
      }
      for (final value in [
        '0',
        '-1',
        '.5',
        '1.5',
        'NaN',
        'Infinity',
        '1e309',
        '0x10',
        'abc',
        '-',
        '1e',
        ' ',
      ]) {
        expect(providerTokenError(value), isNotNull, reason: value);
      }
      expect(providerNumber('broken'), isNull);
      expect(providerNumber(''), isNull);
    },
  );

  test('URL validity matches the captured Chromium field corpus', () {
    final fixture = obj(
      jsonDecode(
        File(
          '../../fixtures/mobile-parity/provider-validation.json',
        ).readAsStringSync(),
      ),
    );
    for (final example in rows(fixture['cases'])) {
      expect(
        providerUrlError(example['raw']) == null,
        obj(example['validity'])['valid'],
        reason: example['name'],
      );
    }
  });

  test('numeric edit validity and values match the Chromium typing corpus', () {
    final fixture = obj(
      jsonDecode(
        File(
          '../../fixtures/mobile-parity/provider-validation.json',
        ).readAsStringSync(),
      ),
    );
    for (final example in rows(fixture['numberCases'])) {
      final edited = providerNumericFormatter.formatEditUpdate(
        TextEditingValue.empty,
        TextEditingValue(text: example['raw']),
      );
      expect(
        providerTokenError(edited.text) == null,
        example['valid'],
        reason: example['raw'],
      );
      expect(
        providerNumber(edited.text),
        example['number'],
        reason: example['raw'],
      );
    }
  });

  testWidgets(
    'ignored numeric letters clear optional values instead of retaining old limits',
    (t) async {
      final g = FakeGateway(), c = LiveController(g, showing: 'engine');
      Json? saved;
      g.handler = (_, args) async => {'presets': []};
      await t.pumpWidget(
        editorShell(
          ProviderEditor(
            controller: c,
            provider: editingProvider(),
            onSave: (_, input, _) async => saved = input,
            onCancel: () {},
          ),
        ),
      );
      await t.pumpAndSettle();
      await tapVisible(t, find.text('Details'));
      await t.pumpAndSettle();
      await t.enterText(field('provider-model-model-context'), 'NaN');
      await t.enterText(field('provider-model-model-max-tokens'), 'Infinity');
      expect(
        t
            .widget<TextField>(field('provider-model-model-context'))
            .controller!
            .text,
        isEmpty,
      );
      expect(
        t
            .widget<TextField>(field('provider-model-model-max-tokens'))
            .controller!
            .text,
        isEmpty,
      );
      await t.testTextInput.receiveAction(TextInputAction.done);
      await t.pumpAndSettle();
      expect(rows(saved!['models']).single, {'id': 'model'});
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    },
  );

  testWidgets(
    'invalid URL focuses the field and keeps key; valid syntax reaches server callback',
    (t) async {
      final g = FakeGateway(), c = LiveController(g, showing: 'engine');
      final saved = <Json>[];
      g.handler = (_, args) async => {'presets': []};
      await t.pumpWidget(
        editorShell(
          ProviderEditor(
            controller: c,
            provider: editingProvider(),
            onSave: (_, input, _) async => saved.add(input),
            onCancel: () {},
          ),
        ),
      );
      await t.pumpAndSettle();
      await t.enterText(field('provider-editor-api-key'), 'pending-key');
      final url = field('provider-editor-base-url');
      for (final value in [
        'localhost',
        'http://',
        'https://host:65536',
        'http://[::1',
      ]) {
        await t.enterText(url, value);
        await t.testTextInput.receiveAction(TextInputAction.done);
        await t.pumpAndSettle();
        expect(saved, isEmpty);
        expect(t.widget<TextField>(url).focusNode!.hasFocus, isTrue);
        expect(find.text('Enter a valid URL.'), findsOneWidget);
        expect(
          t
              .widget<TextField>(field('provider-editor-api-key'))
              .controller!
              .text,
          'pending-key',
        );
      }
      await t.enterText(url, 'ftp://example.test/models');
      await t.testTextInput.receiveAction(TextInputAction.done);
      await t.pumpAndSettle();
      expect(saved.single['baseUrl'], 'ftp://example.test/models');
      expect(saved.single['apiKey'], 'pending-key');
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    },
  );

  testWidgets(
    'invalid tokens block save without clearing key or retaining old metadata',
    (t) async {
      final g = FakeGateway(), c = LiveController(g, showing: 'engine');
      final saved = <Json>[];
      g.handler = (_, args) async => {'presets': []};
      await t.pumpWidget(
        editorShell(
          ProviderEditor(
            controller: c,
            provider: editingProvider(),
            onSave: (_, input, _) async => saved.add(input),
            onCancel: () {},
          ),
        ),
      );
      await t.pumpAndSettle();
      await t.enterText(
        field('provider-editor-api-key'),
        'key-for-invalid-form',
      );
      await tapVisible(t, find.text('Details'));
      await t.pumpAndSettle();
      final count = field('provider-model-model-context');
      for (final value in ['0', '1.5', '-', '1e', '1e309']) {
        await t.enterText(count, value);
        await t.testTextInput.receiveAction(TextInputAction.done);
        await t.pumpAndSettle();
        expect(saved, isEmpty);
        expect(find.text(providerTokenError(value)!), findsOneWidget);
        expect(t.widget<TextField>(count).focusNode!.hasFocus, isTrue);
        expect(
          t
              .widget<TextField>(field('provider-editor-api-key'))
              .controller!
              .text,
          'key-for-invalid-form',
        );
      }
      await t.enterText(count, '2e3');
      await t.testTextInput.receiveAction(TextInputAction.done);
      await t.pumpAndSettle();
      expect(saved, hasLength(1));
      expect(rows(saved.single['models']).single['contextWindow'], 2000);
      expect(
        t.widget<TextField>(field('provider-editor-api-key')).controller!.text,
        isEmpty,
      );
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    },
  );

  testWidgets(
    'save expands collapsed invalid model details and optional clearing omits values',
    (t) async {
      final g = FakeGateway(), c = LiveController(g, showing: 'engine');
      final saved = <Json>[];
      g.handler = (_, args) async => {'presets': []};
      await t.pumpWidget(
        editorShell(
          ProviderEditor(
            controller: c,
            provider: editingProvider(),
            onSave: (_, input, _) async => saved.add(input),
            onCancel: () {},
          ),
        ),
      );
      await t.pumpAndSettle();
      await tapVisible(t, find.text('Details'));
      await t.pumpAndSettle();
      await t.enterText(field('provider-model-model-max-tokens'), '-2');
      FocusManager.instance.primaryFocus?.unfocus();
      await t.pumpAndSettle();
      await tapVisible(t, find.text('Details'));
      await t.pumpAndSettle();
      final save = find.widgetWithText(TextButton, 'Save backend');
      await t.ensureVisible(save);
      await t.pumpAndSettle();
      await t.tap(save);
      await t.pumpAndSettle();
      final maximum = field('provider-model-model-max-tokens');
      expect(saved, isEmpty);
      expect(maximum, findsOneWidget);
      expect(t.widget<TextField>(maximum).focusNode!.hasFocus, isTrue);
      await t.enterText(maximum, '');
      await t.enterText(field('provider-model-model-context'), '');
      await t.testTextInput.receiveAction(TextInputAction.done);
      await t.pumpAndSettle();
      expect(rows(saved.single['models']).single, {'id': 'model'});
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    },
  );

  testWidgets(
    'manual model Enter adds a model while ordinary field Enter submits',
    (t) async {
      final g = FakeGateway(), c = LiveController(g, showing: 'engine');
      final saved = <Json>[];
      g.handler = (_, args) async => {'presets': []};
      await t.pumpWidget(
        editorShell(
          ProviderEditor(
            controller: c,
            provider: editingProvider(),
            onSave: (_, input, _) async => saved.add(input),
            onCancel: () {},
          ),
        ),
      );
      await t.pumpAndSettle();
      await t.enterText(field('provider-editor-manual-model-id'), 'second');
      await t.testTextInput.receiveAction(TextInputAction.done);
      await t.pumpAndSettle();
      expect(saved, isEmpty);
      expect(find.text('Remove second'), findsOneWidget);
      await t.enterText(
        field('provider-editor-base-url'),
        'http://localhost:11434/v1',
      );
      t.testTextInput.updateEditingValue(
        const TextEditingValue(
          text: 'http://localhost:11434/v1',
          selection: TextSelection.collapsed(offset: 4),
          composing: TextRange(start: 0, end: 4),
        ),
      );
      await t.pump();
      expect(
        t
            .widget<TextField>(field('provider-editor-base-url'))
            .controller!
            .value
            .composing,
        const TextRange(start: 0, end: 4),
      );
      await t.sendKeyEvent(LogicalKeyboardKey.enter);
      await t.pumpAndSettle();
      expect(saved, isEmpty);
      await t.enterText(
        field('provider-editor-base-url'),
        'http://localhost:11434/v1',
      );
      await t.sendKeyEvent(LogicalKeyboardKey.enter);
      await t.pumpAndSettle();
      expect(saved, hasLength(1));
      expect(rows(saved.single['models']).map((m) => m['id']), [
        'model',
        'second',
      ]);
      await t.pumpWidget(const SizedBox());
      c.dispose();
      await g.stream.close();
    },
  );
}
