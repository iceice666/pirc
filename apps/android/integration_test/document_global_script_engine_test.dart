import 'dart:convert';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pirc_mobile/live/gateway.dart';

// Architectural probe: this proves engine capability, not the runtime parser fix.
void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'raw native Script retains lexical globals and module factories can read them',
    (tester) async {
      final gateway = Gateway();
      const owner = 'raw-global-script-probe';
      final id = obj(
        await gateway.call('documentScriptOpen', {
          'owner': owner,
          'documentUrl': 'https://document.example/page',
        }),
      )['id'];
      Future<String> evaluate(String source) async =>
          obj(
                await gateway.call('documentScriptEvaluate', {
                  'id': id,
                  'owner': owner,
                  'source': source,
                }),
              )['value']
              as String;
      try {
        await evaluate(
          await rootBundle.loadString('assets/document-script-runtime.js'),
        );
        await evaluate(
          '__pircDocument.init(${jsonEncode({'url': 'https://document.example/page', 'html': '<div id="probe"></div>'})})',
        );
        expect(
          await evaluate(
            'let retainedLet=9;const retainedConst=4;class RetainedClass{};var retainedVar=6;function retainedFunction(){return retainedLet};"ready"',
          ),
          'ready',
        );
        await evaluate('"use strict";var retainedStrictVar=17;"ready"');
        final state = jsonDecode(
          await evaluate(
            'JSON.stringify([retainedLet,retainedConst,RetainedClass.name,window.retainedVar,window.retainedFunction(),typeof window.retainedLet,retainedStrictVar])',
          ),
        );
        expect(state, [9, 4, 'RetainedClass', 6, 9, 'undefined', 17]);
        await expectLater(
          evaluate('throw new Error("ordinary raw failure")'),
          throwsA(
            isA<PlatformException>().having(
              (e) => e.code,
              'code',
              'SCRIPT_EVALUATION',
            ),
          ),
        );
        expect(await evaluate('String(retainedLet)'), '9');
        final source =
            "window.factoryReads=[retainedLet,retainedConst,RetainedClass.name,retainedStrictVar]";
        await evaluate(
          'var element=document.createElement("script");element.type="module";element.textContent=${jsonEncode(source)};document.head.appendChild(element);"queued"',
        );
        for (var turn = 0; turn < 10; turn++) {
          await evaluate('__pircDocument.snapshot()');
          final result =
              jsonDecode(
                    await evaluate(
                      'JSON.stringify({value:window.factoryReads})',
                    ),
                  )
                  as Map;
          if (result['value'] != null) {
            expect(result['value'], [9, 4, 'RetainedClass', 17]);
            return;
          }
          await tester.pump(const Duration(milliseconds: 16));
        }
        fail(
          'Module factory did not resolve raw native Script lexical bindings',
        );
      } finally {
        await gateway.call('documentScriptClose', {'id': id, 'owner': owner});
      }
    },
  );
}
