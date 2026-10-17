import 'dart:ui' as ui;
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:html/parser.dart' as html;
import 'package:integration_test/integration_test.dart';
import 'package:pirc_mobile/live/document_scripts.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/rendering/document_canvas.dart';

class _ProbeGateway extends Gateway {
  int? fontBytes;
  int? heapBytes;
  int? fontCount;

  @override
  Future<dynamic> call(String method, [Json args = const {}]) async {
    final result = await super.call(method, args);
    if (method == 'documentScriptCanvasTextResources') {
      fontBytes = obj(result)['fontBytes'] as int?;
    } else if (method == 'documentScriptEvaluate' &&
        (args['source'] as String).startsWith('__pircInitializeCanvasText(')) {
      final prepared = obj(jsonDecode(obj(result)['value'] as String));
      heapBytes = prepared['heapBytes'] as int?;
      fontCount = prepared['fontCount'] as int?;
    }
    return result;
  }
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('Canvas measureText uses matched native Skia fonts synchronously', (
    tester,
  ) async {
    final rows = [
      {'font': '16px Arial', 'family': 'Arial', 'text': 'Hello AV fi'},
      {
        'font': 'bold 16px Arial',
        'family': 'Arial',
        'text': 'Hello AV fi',
        'bold': true,
      },
      {
        'font': 'italic 16px Arial',
        'family': 'Arial',
        'text': 'Hello AV fi',
        'italic': true,
      },
      {
        'font': 'italic bold 16px Arial',
        'family': 'Arial',
        'text': 'Hello AV fi',
        'bold': true,
        'italic': true,
      },
      {'font': '16px serif', 'family': 'serif', 'text': 'Hello AV fi'},
      {'font': '16px monospace', 'family': 'monospace', 'text': 'Hello AV fi'},
      {'font': '16px Arial', 'family': 'Arial', 'text': 'Hello  '},
      {'font': '16px Arial', 'family': 'Arial', 'text': '中文繁體測試'},
      {
        'font': 'bold 16px Arial',
        'family': 'Arial',
        'text': '中文繁體測試',
        'bold': true,
      },
      {
        'font': 'italic 16px Arial',
        'family': 'Arial',
        'text': '中文繁體測試',
        'italic': true,
      },
      {'font': '16px serif', 'family': 'serif', 'text': '中文繁體測試'},
      {'font': '16px monospace', 'family': 'monospace', 'text': '中文繁體測試'},
      {'font': '16px Arial', 'family': 'Arial', 'text': '\tHello\n世界'},
      {'font': '16px Arial', 'family': 'Arial', 'text': ''},
    ];
    final source =
        '''<!doctype html><html><body><canvas id="c"></canvas><pre id="probe">WAIT</pre><script>
var rows=${jsonEncode(rows)},ctx=document.getElementById('c').getContext('2d'),results=[];
for(var row of rows){try{ctx.font=row.font;var before=ctx.font;var metrics=ctx.measureText(row.text);results.push({font:ctx.font,width:metrics.width,type:metrics instanceof TextMetrics,unchanged:ctx.font===before});}catch(e){results.push({error:e.name+': '+e.message})}}
document.getElementById('probe').textContent=JSON.stringify(results);
ctx.font='16px Arial';ctx.fillStyle='#ff0000';ctx.fillRect(0,0,ctx.measureText('中文繁體測試').width,8);
ctx.fillStyle='#000000';ctx.fillText('Canvas label',0,30,undefined);
</script></body></html>''';
    final gateway = _ProbeGateway();
    final scripts = NativeDocumentScripts(gateway);
    final startup = Stopwatch()..start();
    try {
      await scripts.start(
        source: source,
        url: 'https://example.test/native-canvas-text',
      );
      startup.stop();
      debugPrintSynchronously(
        'PIRC_NATIVE_CANVAS_TEXT_RESOURCES ${jsonEncode({'startupMs': startup.elapsedMilliseconds, 'fontBytes': gateway.fontBytes, 'heapBytes': gateway.heapBytes, 'fontCount': gateway.fontCount})}',
      );
      expect(scripts.ready, isTrue, reason: '${scripts.diagnostics}');
      final raw = html
          .parse(scripts.content!.text)
          .getElementById('probe')!
          .text;
      debugPrintSynchronously('PIRC_NATIVE_CANVAS_TEXT $raw');
      final actual = jsonDecode(raw) as List;
      expect(actual, hasLength(rows.length));
      for (var i = 0; i < rows.length; i++) {
        final row = rows[i], entry = actual[i] as Map;
        expect(
          entry,
          isNot(contains('error')),
          reason: 'row $i ${scripts.diagnostics}',
        );
        final text = (row['text'] as String).replaceAll(
          RegExp(r'[\t\n\f\r]'),
          ' ',
        );
        final painter = TextPainter(
          text: TextSpan(
            text: text,
            style: TextStyle(
              fontFamily: row['family'] as String,
              fontSize: 16,
              fontWeight: row['bold'] == true
                  ? FontWeight.w700
                  : FontWeight.w400,
              fontStyle: row['italic'] == true
                  ? FontStyle.italic
                  : FontStyle.normal,
              height: 1,
            ),
          ),
          textDirection: TextDirection.ltr,
          textScaler: TextScaler.noScaling,
          maxLines: 1,
        )..layout();
        debugPrintSynchronously(
          'PIRC_NATIVE_CANVAS_TEXT_COMPARE ${jsonEncode({'row': i, 'runtime': entry['width'], 'flutter': painter.width})}',
        );
        expect(
          entry['width'],
          closeTo(painter.width, .02),
          reason: 'Same actual font and style for row $i',
        );
        expect(entry['type'], true);
        expect(entry['unchanged'], true);
        painter.dispose();
      }
      final snapshot = scripts.canvases.values.single;
      expect(snapshot.commands.map((command) => command.op), [
        'fillRect',
        'fillText',
      ]);
      final recorder = ui.PictureRecorder();
      final canvas = Canvas(recorder);
      NativeDocumentCanvasPainter(
        snapshot,
      ).paint(canvas, Size(snapshot.width, snapshot.height));
      final picture = recorder.endRecording();
      final image = await tester.runAsync(() => picture.toImage(300, 150));
      try {
        final data = (await tester.runAsync(
          () => image!.toByteData(format: ui.ImageByteFormat.rawRgba),
        ))!;
        final bytes = data.buffer.asUint8List();
        List<int> pixel(int x, int y) =>
            bytes.sublist((y * 300 + x) * 4, (y * 300 + x) * 4 + 4);
        expect(pixel(94, 4), [255, 0, 0, 255]);
        expect(pixel(99, 4), [0, 0, 0, 0]);
        expect(
          [
            for (var y = 10; y < 35; y++)
              for (var x = 0; x < 130; x++) pixel(x, y)[3],
          ].any((alpha) => alpha > 0),
          true,
          reason:
              'The shipped Flutter Canvas painter draws the measured document labels',
        );
      } finally {
        image?.dispose();
        picture.dispose();
      }
    } finally {
      scripts.dispose();
      await scripts.closed;
    }
  });
}
