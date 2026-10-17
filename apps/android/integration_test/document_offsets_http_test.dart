import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart' show debugPrintSynchronously;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:html/parser.dart' as html;
import 'package:integration_test/integration_test.dart';
import 'package:pirc_mobile/live/document_navigation.dart';
import 'package:pirc_mobile/live/document_navigation_state.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/rendering/html_form_submission.dart';
import 'package:pirc_mobile/rendering/native_html.dart';
import 'package:pirc_mobile/theme.dart';

const _page = r'''<!doctype html><html id="root"><head><style>
html,body{margin:0;padding:0}#parent{position:relative;width:180px;height:120px;
padding:7px 9px;border:4px solid;overflow:auto}
#content{width:400px;height:600px;padding-top:60px}
#target{width:20px;height:10px;margin-left:80px}
#percent-outer{width:300px;border:1px solid}
#percent-parent{position:relative;width:200px;margin-top:5%}
#percent-child{width:30px;height:10px;margin-top:10%}
</style></head><body id="body"><div id="parent"><div id="content">
<div id="target"></div></div></div><pre id="probe">WAIT</pre>
<button type="button" id="scroll">Scroll</button><button type="button" id="read">Read</button><button type="button" id="change">Change</button>
<button type="button" id="percent">Percent</button>
<div id="percent-outer"><div id="percent-parent"><div id="percent-child"></div></div></div>
<script>
window.readPercent=function(){var p=document.getElementById('percent-parent'),c=document.getElementById('percent-child'),o=document.getElementById('percent-outer');return {
 gap:p.getBoundingClientRect().y-o.getBoundingClientRect().y,
 childGap:c.getBoundingClientRect().y-p.getBoundingClientRect().y,
 top:c.offsetTop,parentIdentity:c.offsetParent===p,width:p.offsetWidth,height:p.offsetHeight,
 stale:window.percentMutation
}};
window.readOffsets=function(){var e=document.getElementById('target');return {
 top:e.offsetTop,left:e.offsetLeft,parent:e.offsetParent.id,stale:window.offsetMutation,
 parentIdentity:e.offsetParent===document.getElementById('parent'),
 rect:e.getBoundingClientRect().toJSON(),
 rootParent:document.documentElement.offsetParent,bodyParent:document.body.offsetParent,
 bodyTop:document.body.offsetTop,bodyLeft:document.body.offsetLeft,
 scrollTop:document.getElementById('parent').scrollTop,
 scrollLeft:document.getElementById('parent').scrollLeft,percent:readPercent()
}};
window.offsetMutation=null;window.percentMutation=null;window.initialOffsets=readOffsets();
document.addEventListener('DOMContentLoaded',function(){
 document.getElementById('probe').textContent=JSON.stringify(initialOffsets);
});
document.getElementById('scroll').onclick=function(){document.getElementById('parent').scrollTo(60,40)};
document.getElementById('read').onclick=function(){
 document.getElementById('probe').textContent=JSON.stringify(readOffsets());
};
document.getElementById('change').onclick=function(){
 var target=document.getElementById('target');target.style.marginLeft='100px';
 try{target.offsetLeft;window.offsetMutation='NO_ERROR'}catch(e){window.offsetMutation=e.name}
};
document.getElementById('percent').onclick=function(){
 document.getElementById('percent-parent').style.width='300px';
 try{document.getElementById('percent-child').offsetTop;window.percentMutation='NO_ERROR'}catch(e){window.percentMutation=e.name}
};
</script></body></html>''';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets('Android script offsets use actual native layout and scroll state', (
    t,
  ) async {
    final gateway = Gateway();
    final theme = await PircTheme.load();
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final origin = 'http://127.0.0.1:${server.port}';
    final token = 'pirc_dev_${List.filled(43, 'A').join()}';
    final failures = <String>[];
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
          request.response.write(_page);
        } else {
          request.response.statusCode = 404;
          failures.add('Unexpected path');
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
          NativeHtmlFormRequest(url: '$origin/page', method: 'GET', target: ''),
          baseUrl: origin,
        ),
        NativeDocumentLoadResult.committed,
      );
      windows.select(window);
      document = window.currentDocument!;
      t.view.devicePixelRatio = 1;
      t.view.physicalSize = const Size(390, 844);
      await t.pumpWidget(
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
      Future<void> ready([bool Function()? condition]) async {
        for (var turn = 0; turn < 300; turn++) {
          await t.pump(const Duration(milliseconds: 50));
          final text = html
              .parse(document!.scripts?.content?.text ?? '')
              .getElementById('probe')
              ?.text;
          if (document.scripts?.ready == true &&
              text?.startsWith('{') == true &&
              (condition?.call() ?? true)) {
            return;
          }
        }
        fail(
          'Native offsets script did not become ready: ${document!.scripts?.diagnostics}',
        );
      }

      Json observation() => obj(
        jsonDecode(
          html
              .parse(document!.scripts!.content!.text)
              .getElementById('probe')!
              .text,
        ),
      );
      await ready();
      final initial = observation();
      expect(initial['parent'], 'parent');
      expect(initial['parentIdentity'], true);
      expect(initial['top'], 67);
      expect(initial['left'], 89);
      expect(initial['rootParent'], isNull);
      expect(initial['bodyParent'], isNull);
      expect(initial['bodyTop'], 0);
      expect(initial['bodyLeft'], 0);
      expect(obj(initial['percent']), containsPair('gap', 21));
      expect(obj(initial['percent']), containsPair('childGap', 0));
      expect(obj(initial['percent']), containsPair('top', 0));
      expect(obj(initial['percent']), containsPair('width', 200));
      expect(obj(initial['percent']), containsPair('height', 10));
      expect(obj(initial['percent']), containsPair('parentIdentity', true));
      final parentScriptId = html
          .parse(document.scripts!.content!.text)
          .getElementById('parent')!
          .attributes['data-pirc-script-id']!;
      await t.tap(find.text('Scroll', findRichText: true));
      await ready(() {
        final renderer = t.widget<NativeHtmlDocument>(
          find.byType(NativeHtmlDocument),
        );
        final metrics = renderer.elementScrollController?.metricsFor(
          parentScriptId,
        );
        return metrics?['top'] == 40 && metrics?['left'] == 60;
      });
      await t.tap(find.text('Read', findRichText: true));
      await ready(
        () =>
            observation()['scrollTop'] == 40 &&
            observation()['scrollLeft'] == 60,
      );
      final scrolled = observation();
      expect(scrolled['top'], initial['top']);
      expect(scrolled['left'], initial['left']);
      expect(scrolled['scrollTop'], 40);
      expect(scrolled['scrollLeft'], 60);
      expect(
        obj(scrolled['rect'])['y'],
        (obj(initial['rect'])['y'] as num) - 40,
      );
      expect(
        obj(scrolled['rect'])['x'],
        (obj(initial['rect'])['x'] as num) - 60,
      );
      await t.tap(find.text('Change', findRichText: true));
      await ready(
        () =>
            html
                .parse(document!.scripts!.content!.text)
                .getElementById('target')
                ?.attributes['style']
                ?.contains('100px') ==
            true,
      );
      await t.tap(find.text('Read', findRichText: true));
      await ready(() => observation()['left'] == 109);
      final changed = observation();
      expect(changed['left'], 109);
      final stale = changed['stale'];
      expect(stale.toString(), contains('NotSupportedError'));
      await t.tap(find.text('Percent', findRichText: true));
      await ready(
        () =>
            html
                .parse(document!.scripts!.content!.text)
                .getElementById('percent-parent')
                ?.attributes['style']
                ?.contains('300px') ==
            true,
      );
      await t.tap(find.text('Read', findRichText: true));
      await ready(() => obj(observation()['percent'])['gap'] == 31);
      final percentChanged = obj(observation()['percent']);
      expect(percentChanged['childGap'], 0);
      expect(percentChanged['top'], 0);
      expect(percentChanged['width'], 300);
      expect(percentChanged['height'], 10);
      expect(percentChanged['parentIdentity'], true);
      expect(percentChanged['stale'].toString(), contains('NotSupportedError'));
      expect(failures, isEmpty);
      expect(t.takeException(), isNull);
      debugPrintSynchronously(
        'PIRC_OFFSET_ACCEPTANCE ${jsonEncode({'initial': initial, 'scrolled': scrolled, 'changed': changed, 'parentScriptId': parentScriptId, 'stale': stale, 'percentChanged': percentChanged, 'failures': failures})}',
      );
    } finally {
      await t.pumpWidget(const SizedBox.shrink());
      windows?.dispose();
      if (document?.scripts case final scripts?) await scripts.closed;
      t.view.reset();
      await listener.cancel();
      await server.close(force: true);
    }
  });
}
