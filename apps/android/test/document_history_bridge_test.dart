import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/document_scripts.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'document_script_navigation_actions_test.dart'
    show NavigationGateway, navigation;

Json mutation(int revision, {String method = 'push'}) => {
  'kind': 'history',
  'method': method,
  'target': '_self',
  'url': 'https://example.test/?page=$revision',
  'stateGraph': {'version': 1, 'root': null, 'nodes': []},
  'entryKey': 'entry-$revision',
  'revision': revision,
  'scrollRestoration': 'auto',
  'actionOrder': revision,
};
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test(
    'history mutations keep their order across navigation coalescing',
    () async {
      final gateway = NavigationGateway()
        ..initial = [
          mutation(1),
          {...navigation('old'), 'actionOrder': 2},
          mutation(3),
          {...navigation('new'), 'actionOrder': 4},
          mutation(5),
        ];
      final scripts = NativeDocumentScripts(
        gateway,
        loadRuntime: () async => 'runtime',
      );
      addTearDown(scripts.dispose);
      await scripts.start(source: '', url: 'https://example.test/');
      expect(scripts.ready, isTrue, reason: '${scripts.diagnostics}');
      expect(scripts.navigationActions.map((a) => a['actionOrder']), [
        1,
        3,
        4,
        5,
      ]);
      final actions = scripts.takeNavigationActions(
        scripts.navigationActions.map((a) => a['sequence'] as int).toList(),
      );
      expect(actions.where((a) => a['kind'] == 'history'), hasLength(3));
      expect(scripts.navigationActions, isEmpty);
    },
  );
  test(
    'initial history arrives before page scripts and same URL snapshots do not collapse',
    () async {
      final gateway = NavigationGateway();
      final scripts = NativeDocumentScripts(
        gateway,
        loadRuntime: () async => 'runtime',
      );
      addTearDown(scripts.dispose);
      final initial = <String, dynamic>{
        'url': 'https://example.test/',
        'entryKey': 'a',
        'index': 1,
        'length': 3,
        'ackRevision': 0,
      };
      await scripts.start(
        source: '<script>history.state</script>',
        url: 'https://example.test/',
        history: initial,
      );
      final init =
          gateway.calls
                  .singleWhere(
                    (c) =>
                        c.$1 == 'documentScriptEvaluate' &&
                        '${c.$2['source']}'.startsWith('__pircDocument.init'),
                  )
                  .$2['source']
              as String;
      final encoded = init.substring(
        '__pircDocument.init('.length,
        init.length - 1,
      );
      expect((jsonDecode(encoded) as Map)['history'], initial);
      await scripts.updateHistory({...initial, 'entryKey': 'b', 'index': 2});
      await scripts.updateHistory({...initial, 'entryKey': 'b', 'index': 2});
      await scripts.updateHistory(initial);
      final updates = gateway.calls
          .where(
            (c) =>
                c.$1 == 'documentScriptEvaluate' &&
                '${c.$2['source']}'.startsWith('__pircDocument.updateHistory'),
          )
          .toList();
      expect(updates, hasLength(2));
      expect(
        gateway.calls.where((c) => c.$1 == 'documentScriptOpen'),
        hasLength(1),
      );
    },
  );
  test(
    'invalid history actions fail closed and retire their script context',
    () async {
      for (final invalid in [
        {...mutation(1), 'revision': 0},
        {...mutation(1), 'entryKey': ''},
        {...mutation(1), 'stateGraph': 'wrong'},
        {...mutation(1), 'scrollRestoration': 'wrong'},
        {
          'kind': 'history',
          'method': 'go',
          'target': '_self',
          'delta': 2147483648,
          'actionOrder': 1,
        },
      ]) {
        final gateway = NavigationGateway()..initial = [invalid];
        final scripts = NativeDocumentScripts(
          gateway,
          loadRuntime: () async => 'runtime',
        );
        await scripts.start(source: '', url: 'https://example.test/');
        expect(scripts.ready, isFalse);
        expect(scripts.navigationActions, isEmpty);
        expect(scripts.diagnostics, isNotEmpty);
        scripts.dispose();
        await scripts.closed;
      }
    },
  );
}
