import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart' show debugPrintSynchronously;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:html/parser.dart' as html;
import 'package:integration_test/integration_test.dart';
import 'package:pirc_mobile/live/document_navigation.dart';
import 'package:pirc_mobile/live/document_navigation_state.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/rendering/document_canvas.dart';
import 'package:pirc_mobile/rendering/html_form_submission.dart';
import 'package:pirc_mobile/theme.dart';

const _fixtureOrigin = String.fromEnvironment('PIRC_CHART_FIXTURE_ORIGIN');

class _ChartGateway extends Gateway {
  @override
  Future<dynamic> call(String method, [Json args = const {}]) async {
    try {
      return await super.call(method, args);
    } catch (error) {
      if (method.startsWith('documentScript')) {
        final source = args['source'] as String? ?? '';
        final operation =
            RegExp(
              r'^(__pircDocument\.\w+|__pircInitializeCanvasText)',
            ).firstMatch(source)?.group(1) ??
            'runtime/source';
        debugPrintSynchronously(
          'PIRC_CHART_BRIDGE_ERROR ${jsonEncode({'method': method, 'operation': operation, 'error': '$error'})}',
        );
      }
      rethrow;
    }
  }
}

Future<String> _fixture(String path) async {
  final origin = Uri.parse(_fixtureOrigin);
  if (origin.scheme != 'http' || origin.host != '127.0.0.1') {
    throw ArgumentError(
      'Chart acceptance requires the loopback fixture server.',
    );
  }
  final client = HttpClient();
  try {
    final request = await client.getUrl(origin.resolve(path));
    final response = await request.close();
    if (response.statusCode != 200) {
      throw HttpException('Missing fixture: $path');
    }
    return await utf8.decoder.bind(response).join();
  } finally {
    client.close(force: true);
  }
}

String _page(int width, int dpr) {
  final chartWidth = width - 40;
  return '''<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0}
#chart-container{position:relative;margin-left:20px;width:${chartWidth}px;height:240px}
#chart{display:block;box-sizing:border-box;width:${chartWidth}px;height:240px}
</style></head><body>
<div id="chart-container"><canvas id="chart" width="${chartWidth * dpr}" height="${240 * dpr}" style="display:block;box-sizing:border-box;width:${chartWidth}px;height:240px"></canvas></div>
<button type="button" id="update">Update data</button><button type="button" id="resize">Resize container</button><pre id="probe">WAIT</pre>
<script src="/chart.js"></script><script>
var canvas=document.getElementById('chart'),chart;
function chartState(){var s=getComputedStyle(canvas),r=canvas.getBoundingClientRect();return {
 chart:{width:chart.width,height:chart.height,currentDevicePixelRatio:chart.currentDevicePixelRatio},
 windowDevicePixelRatio:window.devicePixelRatio,
 canvas:{widthAttribute:canvas.width,heightAttribute:canvas.height,css:{display:s.display,boxSizing:s.boxSizing,width:s.width,height:s.height},rect:{x:r.x,y:r.y,width:r.width,height:r.height}},
 bars:chart.getDatasetMeta(0).data.map(function(e,i){var g=e.getProps(['x','y','base','width','height'],true);return {index:i,label:chart.data.labels[i],value:chart.data.datasets[0].data[i],x:g.x,y:g.y,base:g.base,width:g.width,height:g.height}}),
 labels:chart.data.labels,mutationObserver:typeof MutationObserver
}}
try{
 var ctx=canvas.getContext('2d');ctx.fillStyle='#ff00ff';ctx.fillRect(0,0,2,2);
 canvas.width=canvas.width;canvas.height=canvas.height;
 chart=new Chart(canvas,{type:'bar',data:{labels:['A','B'],datasets:[{label:'Data',data:[3,7],backgroundColor:'#3b82f6'}]},options:{responsive:true,animation:false,maintainAspectRatio:false,devicePixelRatio:$dpr}});
 document.getElementById('probe').textContent=JSON.stringify(chartState());
 document.getElementById('update').onclick=function(){try{chart.data.datasets[0].data=[6,2];chart.update('none');document.getElementById('probe').textContent=JSON.stringify(chartState())}catch(e){document.getElementById('probe').textContent=JSON.stringify({error:e.name+': '+e.message})}};
 document.getElementById('resize').onclick=function(){
   document.getElementById('chart-container').style.width='${chartWidth + 20}px';canvas.style.width='${chartWidth + 20}px';
   var turns=0;
   function reportResize(){try{if(chart.width!==${chartWidth + 20}&&++turns<30){requestAnimationFrame(reportResize);return}var state=chartState();state.resized=true;document.getElementById('probe').textContent=JSON.stringify(state)}catch(e){document.getElementById('probe').textContent=JSON.stringify({error:e.name+': '+e.message})}}
   requestAnimationFrame(function(){requestAnimationFrame(reportResize)});
 };
}catch(e){document.getElementById('probe').textContent=JSON.stringify({error:e.name+': '+e.message})}
</script></body></html>''';
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'responsive Chart.js renders, updates and resizes on native phone/tablet at DPR 1 and 3',
    (tester) async {
      final chartSource = await _fixture('/chart.js');
      final reference = obj(jsonDecode(await _fixture('/reference.json')));
      final theme = await PircTheme.load();
      final acceptance = <Json>[];
      final gateway = _ChartGateway();
      for (final expectedCase in rows(reference['cases'])) {
        final viewport = obj(expectedCase['viewport']);
        final width = (viewport['width'] as num).toInt();
        final height = (viewport['height'] as num).toInt();
        final dpr = (expectedCase['dpr'] as num).toInt();
        final failures = <String>[];
        final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
        final origin = 'http://127.0.0.1:${server.port}';
        final token = 'pirc_dev_${List.filled(43, 'C').join()}';
        final listener = server.listen((request) async {
          try {
            await request.drain<void>();
            if (request.headers.value('authorization') != 'Bearer $token') {
              failures.add('Missing synthetic bearer');
            }
            if (request.uri.path == '/api/sessions') {
              request.response.headers.contentType = ContentType.json;
              request.response.write('{"sessions":[]}');
            } else if (request.uri.path == '/page') {
              request.response.headers.contentType = ContentType(
                'text',
                'html',
                charset: 'utf-8',
              );
              request.response.write(_page(width, dpr));
            } else if (request.uri.path == '/chart.js') {
              request.response.headers.contentType = ContentType(
                'text',
                'javascript',
                charset: 'utf-8',
              );
              request.response.write(chartSource);
            } else {
              request.response.statusCode = 404;
              failures.add('Unexpected path ${request.uri.path}');
            }
            await request.response.close();
          } catch (error) {
            failures.add('$error');
          }
        });
        NativeDocumentWindows? windows;
        NativeFetchedDocument? document;
        try {
          await gateway.call('pair', {
            'link': Uri(
              scheme: 'pirc',
              host: 'pair',
              queryParameters: {'url': origin, 'token': token},
            ).toString(),
          });
          windows = NativeDocumentWindows(gateway);
          final window = windows.target('', null, sourceUrl: '$origin/page');
          expect(
            await window.load(
              NativeHtmlFormRequest(
                url: '$origin/page',
                method: 'GET',
                target: '',
              ),
              baseUrl: origin,
            ),
            NativeDocumentLoadResult.committed,
          );
          windows.select(window);
          document = window.currentDocument!;
          tester.view.devicePixelRatio = dpr.toDouble();
          tester.view.physicalSize = Size(
            width * dpr.toDouble(),
            height * dpr.toDouble(),
          );
          await tester.pumpWidget(
            MaterialApp(
              theme: theme.build(Brightness.light),
              home: Scaffold(
                body: NativeDocumentScope(
                  documentUrl: '$origin/page',
                  windows: windows,
                  window: window,
                  child: NativeFetchedDocumentView(
                    document: document,
                    gateway: gateway,
                    onLink: (_) {},
                    onSubmit: (_) {},
                  ),
                ),
              ),
            ),
          );
          Json observation() {
            final text = html
                .parse(document!.scripts?.content?.text ?? '')
                .getElementById('probe')
                ?.text;
            if (text == null || !text.startsWith('{')) return {};
            return obj(jsonDecode(text));
          }

          Future<void> ready({
            bool updated = false,
            bool resized = false,
          }) async {
            for (var turn = 0; turn < 300; turn++) {
              await tester.pump(const Duration(milliseconds: 50));
              final current = observation();
              if (current.containsKey('error')) {
                fail(
                  '${expectedCase['caseId']} ${current['error']}; ${document!.scripts?.diagnostics}',
                );
              }
              if (document!.scripts?.ready == true &&
                  current['bars'] is List &&
                  (!updated || rows(current['bars']).first['value'] == 6) &&
                  (!resized || current['resized'] == true)) {
                return;
              }
            }
            fail('Chart not ready: ${document!.scripts?.diagnostics}');
          }

          final deltas = <Json>[];
          void compare(Json actual, Json expected, String stage) {
            expect(actual['chart'], expected['chart']);
            expect(
              actual['windowDevicePixelRatio'],
              expected['windowDevicePixelRatio'],
            );
            expect(actual['canvas'], expected['canvas']);
            expect(actual['labels'], expected['labels']);
            expect(actual['mutationObserver'], 'function');
            final bars = rows(actual['bars']),
                referenceBars = rows(expected['bars']);
            expect(bars, hasLength(referenceBars.length));
            for (var i = 0; i < bars.length; i++) {
              expect(bars[i]['value'], referenceBars[i]['value']);
              for (final key in ['x', 'y', 'base', 'width', 'height']) {
                final delta =
                    (bars[i][key] as num).toDouble() -
                    (referenceBars[i][key] as num).toDouble();
                deltas.add({
                  'stage': stage,
                  'bar': i,
                  'property': key,
                  'delta': delta,
                });
                expect(
                  delta.abs(),
                  lessThanOrEqualTo(2),
                  reason:
                      'Known platform-font geometry delta ${expectedCase['caseId']} $stage/$i/$key',
                );
              }
            }
          }

          Future<void> verifyPaint(Json current) async {
            final finder = find.byType(NativeDocumentCanvas);
            expect(finder, findsOneWidget);
            final widget = tester.widget<NativeDocumentCanvas>(finder);
            final snapshot = widget.snapshot;
            expect(snapshot.width, obj(current['canvas'])['widthAttribute']);
            expect(snapshot.height, 240 * dpr);
            expect(
              snapshot.commands.any((command) => command.op == 'fillText'),
              true,
            );
            final recorder = ui.PictureRecorder();
            final canvas = Canvas(recorder);
            NativeDocumentCanvasPainter(
              snapshot,
            ).paint(canvas, Size(snapshot.width, snapshot.height));
            final picture = recorder.endRecording();
            final image = await tester.runAsync(
              () => picture.toImage(
                snapshot.width.toInt(),
                snapshot.height.toInt(),
              ),
            );
            try {
              final data = (await tester.runAsync(
                () => image!.toByteData(format: ui.ImageByteFormat.rawRgba),
              ))!;
              final bytes = data.buffer.asUint8List();
              for (final bar in rows(current['bars'])) {
                final x = ((bar['x'] as num) * dpr).floor();
                final y = (((bar['y'] as num) + (bar['base'] as num)) / 2 * dpr)
                    .floor();
                final offset = (y * snapshot.width.toInt() + x) * 4;
                expect(bytes.sublist(offset, offset + 4), [59, 130, 246, 255]);
              }
            } finally {
              image?.dispose();
              picture.dispose();
            }
          }

          await ready();
          final initial = observation();
          compare(initial, obj(expectedCase['initial']), 'initial');
          await verifyPaint(initial);
          await tester.tap(find.text('Update data', findRichText: true));
          await ready(updated: true);
          final updated = observation();
          compare(updated, obj(expectedCase['updated']), 'updated');
          await verifyPaint(updated);
          await tester.tap(find.text('Resize container', findRichText: true));
          await ready(updated: true, resized: true);
          final resized = observation();

          compare(
            resized,
            obj(obj(expectedCase['responsiveWidthChange'])['measurement']),
            'resized',
          );
          await verifyPaint(resized);
          expect(document.scripts?.diagnostics, isEmpty);
          expect(failures, isEmpty);
          expect(tester.takeException(), isNull);
          acceptance.add({
            'caseId': expectedCase['caseId'],
            'initial': initial,
            'updated': updated,
            'resized': resized,
            'geometryDeltas': deltas,
            'diagnostics': document.scripts?.diagnostics,
          });
        } finally {
          await tester.pumpWidget(const SizedBox.shrink());
          windows?.dispose();
          if (document?.scripts case final scripts?) await scripts.closed;
          tester.view.reset();
          await listener.cancel();
          await server.close(force: true);
        }
      }
      debugPrintSynchronously(
        'PIRC_NATIVE_CHART_ACCEPTANCE ${jsonEncode(acceptance)}',
      );
    },
    skip: _fixtureOrigin.isEmpty,
  );
}
