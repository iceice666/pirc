import 'dart:async';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'live_test.dart' show FakeGateway;

Json binding(int generation) => {
  'version': 1,
  'membership': {'revision': 2, 'legacyWorkspaceId': 'node:repo'},
  'execution': {
    'generation': generation,
    'workspaceId': 'node:repo',
    'nodeId': 'node',
    'modeId': 'directory',
  },
};
LiveController controller(FakeGateway g) => LiveController(g)
  ..sessionId = 's'
  ..connection = 'live'
  ..control = {'held': true, 'generation': 3}
  ..state = {
    'session': {'id': 's', 'workspaceId': 'node:repo', 'binding': binding(7)},
  };

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test(
    'settings and prompt retain the visible binding when a newer snapshot arrives',
    () async {
      final g = FakeGateway();
      final live = controller(g);
      addTearDown(live.dispose);
      final first = Completer<Json>(), calls = <Json>[];
      g.handler = (method, args) async {
        if (method != 'command') return g.normal(method, args);
        calls.add(args);
        if (calls.length == 1) return first.future;
        return {'status': 'accepted'};
      };
      final pending = live.sendCommand(
        {'type': 'prompt', 'message': 'hello'},
        before: [
          {'type': 'set_thinking', 'level': 'high'},
        ],
      );
      expect(calls, hasLength(1));
      // Also mutate the old map: delivery owns its small frozen copy.
      (((live.state['session'] as Json)['binding'] as Json)['execution']
              as Json)['generation'] =
          8;
      (live.state['session'] as Json)['binding'] = binding(9);
      first.complete({'status': 'accepted'});
      expect(await pending, isTrue);
      expect(calls.map((c) => c['expectedBinding']).toList(), [
        binding(7),
        binding(7),
      ]);
    },
  );
  test(
    'known stale rejection retains input and stops the sequence; Stop still works',
    () async {
      final g = FakeGateway(), calls = <Json>[];
      final c = controller(g)..draft = 'keep my message';
      addTearDown(c.dispose);
      g.handler = (method, args) async {
        if (method != 'command') return g.normal(method, args);
        calls.add(args);
        if (obj(args['payload'])['type'] == 'stop') {
          return {'status': 'accepted'};
        }
        throw PlatformException(
          code: 'HTTP_409',
          details: {'code': 'stale_environment'},
        );
      };
      expect(
        await c.sendCommand(
          {'type': 'prompt', 'message': c.draft},
          before: [
            {'type': 'set_thinking', 'level': 'high'},
          ],
        ),
        isFalse,
      );
      expect(calls, hasLength(1));
      expect(c.unknownCommand, isFalse);
      expect(c.draft, 'keep my message');
      expect(c.actionError, isNotNull);
      expect(await c.sendCommand({'type': 'stop'}), isTrue);
    },
  );
  test('an older snapshot never invents an environment version', () async {
    final g = FakeGateway();
    final live = controller(g)..state = {};
    addTearDown(live.dispose);
    Json? sent;
    g.handler = (method, args) async {
      if (method != 'command') return g.normal(method, args);
      sent = args;
      return {'status': 'accepted'};
    };
    expect(await live.sendCommand({'type': 'stop'}), isTrue);
    expect(sent!.containsKey('expectedBinding'), isFalse);
  });
}
