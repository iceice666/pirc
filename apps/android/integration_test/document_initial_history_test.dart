import 'dart:convert';
import 'dart:io';
import 'package:flutter/foundation.dart' show debugPrintSynchronously;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pirc_mobile/theme.dart';
import '../test/support/document_fragment_scroll_case.dart'
    show FragmentScrollGateway;
import '../test/support/document_initial_history_case.dart';

const fixtureOrigin = String.fromEnvironment('PIRC_CHART_FIXTURE_ORIGIN');
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'initial History writes preserve browser target selection',
    (tester) async {
      final uri = Uri.parse(fixtureOrigin);
      expect(uri.scheme, 'http');
      expect(uri.host, '127.0.0.1');
      final client = HttpClient();
      late Map fixture;
      try {
        final r = await (await client.getUrl(
          uri.resolve('/initial-history.json'),
        )).close();
        expect(r.statusCode, 200);
        fixture = jsonDecode(await utf8.decoder.bind(r).join()) as Map;
      } finally {
        client.close(force: true);
      }
      expect(fixture['browserVersion'], '153.0.8010.12');
      expect(fixture['cases'], hasLength(288));
      final theme = await PircTheme.load(), gateway = FragmentScrollGateway();
      final events = gateway.events.listen((_) {});
      addTearDown(events.cancel);
      var profiles = 0, states = 0;
      for (final row in fixture['cases'] as List) {
        debugPrintSynchronously(
          'PIRC_INITIAL_HISTORY_CASE ${row['spec']['id']} ${row['viewport']} dpr${row['dpr']} ${row['theme']}',
        );
        states += await checkInitialHistoryCase(
          tester,
          row as Map,
          theme.build(
            row['theme'] == 'dark' ? Brightness.dark : Brightness.light,
          ),
          gateway,
        );
        profiles++;
      }
      expect(profiles, 288);
      expect(states, 880);
      debugPrintSynchronously(
        'PIRC_NATIVE_INITIAL_HISTORY_ACCEPTANCE ${jsonEncode({'profiles': profiles, 'states': states})}',
      );
    },
    skip: fixtureOrigin.isEmpty,
  );
}
