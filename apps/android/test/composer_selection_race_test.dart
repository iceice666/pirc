import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/conversation_composer.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'live_test.dart' show FakeGateway, theme;

void main() {
  for (final width in [390.0, 768.0]) {
    for (final brightness in Brightness.values) {
      for (final model in [true, false]) {
        testWidgets(
          'rapid ${model ? 'model' : 'thinking'} choices at $width ${brightness.name} all reach the gateway',
          (t) async {
            t.view.devicePixelRatio = 1;
            t.view.physicalSize = Size(width, 900);
            addTearDown(t.view.reset);
            final g = FakeGateway(),
                c = LiveController(g, showing: 'engine')
                  ..sessionId = 's'
                  ..connection = 'live'
                  ..control = {'held': true, 'generation': 3}
                  ..models = [
                    for (final id in ['a', 'b', 'c'])
                      {
                        'id': id,
                        'provider': 'test',
                        'displayName': 'Model ${id.toUpperCase()}',
                        'available': true,
                      },
                  ]
                  ..state = {
                    'modelId': 'a',
                    'modelProvider': 'test',
                    'thinking': 'medium',
                  };
            final pending = [Completer<Json>(), Completer<Json>()];
            final type = model ? 'set_model' : 'set_thinking';
            final choices = <Json>[];
            g.handler = (method, args) async {
              if (method == 'command' &&
                  (args['payload'] as Json)['type'] == type) {
                choices.add(Map<String, dynamic>.from(args['payload'] as Json));
                return pending[choices.length - 1].future;
              }
              return g.normal(method, args);
            };
            final text = TextEditingController();
            await t.pumpWidget(
              MaterialApp(
                theme: theme.build(brightness),
                home: Scaffold(
                  body: AnimatedBuilder(
                    animation: c,
                    builder: (_, _) =>
                        ConversationComposer(controller: c, text: text),
                  ),
                ),
              ),
            );
            Future<void> choose(String value) async {
              await t.tap(find.byTooltip(model ? 'Model' : 'Reasoning effort'));
              await t.pump();
              final item = find.widgetWithText(MenuItemButton, value);
              expect(item, findsOneWidget);
              await t.ensureVisible(item);
              await t.tap(item);
              await t.pump();
            }

            await choose(model ? 'Model B' : 'High');
            expect(
              c.busy,
              isFalse,
              reason: 'preference requests do not block the composer on Web',
            );
            await choose(model ? 'Model C' : 'Low');
            final submitted = [
              for (final choice in choices) choice[model ? 'modelId' : 'level'],
            ];
            pending.first.complete({'status': 'accepted'});
            await t.pump();
            final waitingForSecond = c.busy;
            pending.last.complete({'status': 'accepted'});
            await t.pump();
            final completed = !c.busy;
            await t.pumpWidget(const SizedBox());
            text.dispose();
            c.dispose();
            await g.stream.close();
            expect(submitted, model ? ['b', 'c'] : ['high', 'low']);
            expect(waitingForSecond, isFalse);
            expect(completed, isTrue);
          },
        );
      }
    }
  }
  test(
    'selection commands retain connection, control and unknown-result checks',
    () async {
      final g = FakeGateway(),
          c = LiveController(g, showing: 'engine')
            ..sessionId = 's'
            ..busy = true;
      c.connection = 'offline';
      c.control = {'held': true};
      await c.changeThinking('high');
      c.connection = 'live';
      c.control = {'held': false};
      await c.changeThinking('low');
      c.control = {'held': true};
      c.unknownCommand = true;
      await c.changeThinking('minimal');
      expect(g.calls.where((call) => call.$1 == 'command'), isEmpty);
      expect(
        await c.sendCommand({'type': 'steer', 'message': 'duplicate'}),
        isFalse,
      );
      c.dispose();
      await g.stream.close();
    },
  );
  test('a pending preference keeps ordinary sending available', () async {
    final g = FakeGateway(),
        c = LiveController(g, showing: 'engine')
          ..sessionId = 's'
          ..connection = 'live'
          ..control = {'held': true};
    final preference = Completer<Json>();
    g.handler = (method, args) async {
      if (method == 'command' &&
          (args['payload'] as Json)['type'] == 'set_thinking') {
        return preference.future;
      }
      return g.normal(method, args);
    };
    final selection = c.changeThinking('high');
    expect(c.canWrite, isTrue);
    final accepted = await c.sendCommand({
      'type': 'prompt',
      'message': 'send with current preference',
    });
    final types = g.calls
        .where((call) => call.$1 == 'command')
        .map((call) => (call.$2['payload'] as Json)['type'])
        .toList();
    preference.complete({'status': 'accepted'});
    await selection;
    c.dispose();
    await g.stream.close();
    expect(accepted, isTrue);
    expect(types, ['set_thinking', 'prompt']);
  });
}
