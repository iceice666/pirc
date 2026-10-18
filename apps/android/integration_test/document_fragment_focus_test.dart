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
    'native fragment focus and geometry agree with Chromium',
    (tester) async {
      final origin = Uri.parse(fixtureOrigin);
      expect(origin.scheme, 'http');
      expect(origin.host, '127.0.0.1');
      final client = HttpClient();
      late Map fixture;
      try {
        final response = await (await client.getUrl(
          origin.resolve('/fragment-focus.json'),
        )).close();
        expect(response.statusCode, 200);
        fixture = jsonDecode(await utf8.decoder.bind(response).join()) as Map;
      } finally {
        client.close(force: true);
      }
      expect(fixture['browserVersion'], '153.0.8010.12');
      expect(fixture['cases'], hasLength(312));
      final theme = await PircTheme.load(),
          accepted = <Map>[],
          initialAccepted = <Map>[],
          gateway = FragmentScrollGateway();
      final events = gateway.events.listen((_) {});
      addTearDown(events.cancel);
      final filter = const String.fromEnvironment('PIRC_FRAGMENT_FOCUS_MODE');
      expect(filter, anyOf('', 'button-smooth', 'textarea', 'onfocus-margin'));
      final cases = (fixture['cases'] as List)
          .where((row) => filter.isEmpty || row['mode'] == filter)
          .toList();
      const initialModes = {
        'button',
        'input',
        'textarea',
        'link',
        'tabindex',
        'onfocus-margin',
      };
      for (final row in cases) {
        debugPrintSynchronously(
          'PIRC_FRAGMENT_FOCUS_CASE ${row['mode']} scripted=${row['scripted']} ${row['viewport']} dpr${row['dpr']} ${row['theme']}',
        );
        if (initialModes.contains(row['mode'])) {
          initialAccepted.add(
            await checkFragmentScrollCase(
              tester,
              row as Map,
              theme.build(
                row['theme'] == 'dark' ? Brightness.dark : Brightness.light,
              ),
              initial: true,
              checkFocus: true,
              documentPath: '/fragment-focus',
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
            checkFocus: true,
            documentPath: '/fragment-focus',
            sharedGateway: gateway,
          ),
        );
        if (accepted.length % 32 == 0) {
          debugPrintSynchronously(
            'PIRC_FRAGMENT_FOCUS_PROGRESS ${accepted.length}/312',
          );
        }
      }
      expect(accepted, hasLength(cases.length));
      expect(
        initialAccepted,
        hasLength(
          cases.where((row) => initialModes.contains(row['mode'])).length,
        ),
      );
      if (filter.isEmpty) {
        expect(accepted, hasLength(312));
        expect(initialAccepted, hasLength(88));
      }
      debugPrintSynchronously(
        'PIRC_NATIVE_FRAGMENT_FOCUS_INITIAL_ACCEPTANCE ${jsonEncode(initialAccepted)}',
      );
      debugPrintSynchronously(
        'PIRC_NATIVE_FRAGMENT_FOCUS_ACCEPTANCE ${jsonEncode(accepted)}',
      );
    },
    skip: fixtureOrigin.isEmpty,
  );
}
