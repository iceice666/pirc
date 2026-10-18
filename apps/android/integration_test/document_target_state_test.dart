import 'dart:convert';
import 'dart:io';
import 'package:flutter/foundation.dart' show debugPrintSynchronously;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pirc_mobile/theme.dart';
import '../test/support/document_fragment_scroll_case.dart'
    show FragmentScrollGateway;
import '../test/support/document_target_state_case.dart';

const fixtureOrigin = String.fromEnvironment('PIRC_CHART_FIXTURE_ORIGIN');
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'native target state and selectors agree with Chromium',
    (tester) async {
      final origin = Uri.parse(fixtureOrigin);
      expect(origin.scheme, 'http');
      expect(origin.host, '127.0.0.1');
      final client = HttpClient();
      late Map fixture;
      try {
        final r = await (await client.getUrl(
          origin.resolve('/target-state.json'),
        )).close();
        expect(r.statusCode, 200);
        fixture = jsonDecode(await utf8.decoder.bind(r).join()) as Map;
      } finally {
        client.close(force: true);
      }
      expect(fixture['browserVersion'], '153.0.8010.12');
      expect(fixture['cases'], hasLength(16));
      final theme = await PircTheme.load(), gateway = FragmentScrollGateway();
      final events = gateway.events.listen((_) {});
      addTearDown(events.cancel);
      var states = 0, profiles = 0;
      for (final row in fixture['cases'] as List) {
        debugPrintSynchronously(
          'PIRC_TARGET_CASE ${row['viewport']} dpr${row['dpr']} ${row['theme']} scripted=${row['scripted']}',
        );
        states += await checkDocumentTargetState(
          tester,
          row as Map,
          theme.build(
            row['theme'] == 'dark' ? Brightness.dark : Brightness.light,
          ),
          sharedGateway: gateway,
        );
        profiles++;
      }
      expect(profiles, 16);
      expect(states, 256);
      debugPrintSynchronously(
        'PIRC_NATIVE_TARGET_STATE_ACCEPTANCE ${jsonEncode({'profiles': profiles, 'states': states})}',
      );
    },
    skip: fixtureOrigin.isEmpty,
  );
}
