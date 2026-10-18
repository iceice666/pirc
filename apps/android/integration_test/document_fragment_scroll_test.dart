import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart' show debugPrintSynchronously;
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pirc_mobile/theme.dart';
import '../test/support/document_fragment_scroll_case.dart';

const fixtureOrigin = String.fromEnvironment('PIRC_CHART_FIXTURE_ORIGIN');
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'native fragment geometry matches Chromium with and without scripts',
    (tester) async {
      final origin = Uri.parse(fixtureOrigin);
      expect(origin.scheme, 'http');
      expect(origin.host, '127.0.0.1');
      final client = HttpClient();
      late Map fixture;
      try {
        final response = await (await client.getUrl(
          origin.resolve('/fragment-scroll.json'),
        )).close();
        expect(response.statusCode, 200);
        fixture = jsonDecode(await utf8.decoder.bind(response).join()) as Map;
      } finally {
        client.close(force: true);
      }
      expect(fixture['browserVersion'], '153.0.8010.12');
      expect(fixture['cases'], hasLength(280));
      final theme = await PircTheme.load(), accepted = <Map>[];
      final excluded = <Map>[], initialAccepted = <Map>[];
      final gateway = FragmentScrollGateway();
      // Keep the real app event stream alive across document windows. A last
      // subscriber cancellation intentionally invalidates all native contexts.
      final events = gateway.events.listen((_) {});
      addTearDown(events.cancel);
      final filter = const String.fromEnvironment('PIRC_FRAGMENT_SCROLL_MODE');
      expect(filter, anyOf('', 'css-smooth'));
      for (final row in fixture['cases'] as List) {
        if (filter.isNotEmpty && row['mode'] != filter) continue;
        if (['button', 'input'].contains(row['mode'])) {
          excluded.add({
            'mode': row['mode'],
            'scripted': row['scripted'],
            'viewport': row['viewport'],
            'dpr': row['dpr'],
            'theme': row['theme'],
            'difference': 'fragment focus centering remains unimplemented',
          });
          continue;
        }
        if ([
          'default',
          'padding-margin',
          'zero-range',
          'root-padding',
          'css-smooth',
          'dynamic-margin',
        ].contains(row['mode'])) {
          initialAccepted.add(
            await checkFragmentScrollCase(
              tester,
              row as Map,
              theme.build(
                row['theme'] == 'dark' ? Brightness.dark : Brightness.light,
              ),
              initial: true,
              sharedGateway: gateway,
            ),
          );
        }
        accepted.add(
          await checkFragmentScrollCase(
            tester,
            row as Map,
            theme.build(
              row['theme'] == 'dark' ? Brightness.dark : Brightness.light,
            ),
            sharedGateway: gateway,
          ),
        );
        if (accepted.length % 35 == 0) {
          debugPrintSynchronously(
            'PIRC_FRAGMENT_SCROLL_PROGRESS ${accepted.length}/248',
          );
        }
      }
      expect(accepted, hasLength(filter.isEmpty ? 248 : 16));
      expect(excluded, hasLength(filter.isEmpty ? 32 : 0));
      expect(initialAccepted, hasLength(filter.isEmpty ? 88 : 16));
      debugPrintSynchronously(
        'PIRC_NATIVE_FRAGMENT_SCROLL_INITIAL_ACCEPTANCE ${jsonEncode(initialAccepted)}',
      );
      debugPrintSynchronously(
        'PIRC_FRAGMENT_SCROLL_KNOWN_DIFFERENCES ${jsonEncode(excluded)}',
      );
      debugPrintSynchronously(
        'PIRC_NATIVE_FRAGMENT_SCROLL_ACCEPTANCE ${jsonEncode(accepted)}',
      );
    },
    skip: fixtureOrigin.isEmpty,
  );
}
