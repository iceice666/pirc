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
#target{width:20px;height:10px;margin-left:80px;font-size:20px;color:#123456}
#percent-outer{width:300px;border:1px solid}
#percent-parent{position:relative;width:200px;margin-top:5%}
#percent-child{width:30px;height:10px;margin-top:10%}
#relative-parent{position:relative;left:30px;top:20px;width:180px;height:70px;border:3px solid;padding:4px}
#relative-parent.changed{color:rgb(60,40,20)}
#flex{display:flex;width:200px;height:20px}#flex-child{width:40px;height:10px}
#grid{display:grid;grid-template-columns:100px 100px;width:200px;height:20px}#grid-child{height:10px}
#relative-target{position:relative;left:-7.5px;top:5px;width:90px;height:30px}
</style></head><body id="body"><div id="parent"><div id="content">
<div id="target"></div></div></div><pre id="probe">WAIT</pre>
<button type="button" id="scroll">Scroll</button><button type="button" id="read">Read</button><button type="button" id="change">Change</button>
<button type="button" id="percent">Percent</button><button type="button" id="relative">Relative</button>
<div id="percent-outer"><div id="percent-parent"><div id="percent-child"></div></div></div>
<div id="relative-parent"><div id="relative-target"><button type="button" id="moved">Moved</button></div></div>
<div id="flex"><span id="flex-child"></span></div>
<div id="grid"><span id="grid-child"></span><span></span></div>
<script>
window.relativeHits=0;window.relativeMutation=null;window.computedMutation=null;
window.retainedRelativeStyle=getComputedStyle(document.getElementById('relative-parent'));
window.readComputed=function(){var e=document.getElementById('target'),s=getComputedStyle(e),r=window.retainedRelativeStyle,readonly='NO_ERROR';try{r.setProperty('left','99px')}catch(error){readonly=error.name}return {width:s.width,height:s.height,flexDisplay:getComputedStyle(document.getElementById('flex-child')).display,flexWidth:getComputedStyle(document.getElementById('flex-child')).width,gridDisplay:getComputedStyle(document.getElementById('grid-child')).display,gridWidth:getComputedStyle(document.getElementById('grid-child')).width,fontSize:s.fontSize,color:s.color,marginLeft:s.marginLeft,parentWidth:r.width,parentHeight:r.height,parentColor:r.color,childColor:getComputedStyle(document.getElementById('relative-target')).color,paddingLeft:r.paddingLeft,borderLeft:r.borderLeftWidth,left:r.left,right:r.right,cssText:r.cssText,distinct:r!==getComputedStyle(document.getElementById('relative-parent')),readonly:readonly,stale:window.computedMutation}};
window.readRelative=function(){var p=document.getElementById('relative-parent'),c=document.getElementById('relative-target'),r=p.getBoundingClientRect(),q=c.getBoundingClientRect();return {parentX:r.x,gapX:q.x-r.x,gapY:q.y-r.y,top:c.offsetTop,left:c.offsetLeft,parentIdentity:c.offsetParent===p,hits:window.relativeHits,stale:window.relativeMutation}};
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
 scrollLeft:document.getElementById('parent').scrollLeft,percent:readPercent(),relative:readRelative(),computed:readComputed()
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
document.getElementById('relative').onclick=function(){
 document.getElementById('relative-parent').style.left='50px';
 document.getElementById('relative-parent').classList.add('changed');
 try{window.retainedRelativeStyle.left;window.computedMutation='NO_ERROR'}catch(e){window.computedMutation=e.name}
 try{document.getElementById('relative-target').offsetLeft;window.relativeMutation='NO_ERROR'}catch(e){window.relativeMutation=e.name}
};
document.getElementById('moved').onclick=function(){
 window.relativeHits++;
 document.getElementById('probe').textContent=JSON.stringify(readOffsets());
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
      final initialComputed = obj(initial['computed']);
      expect(initialComputed, containsPair('width', '20px'));
      expect(initialComputed, containsPair('height', '10px'));
      expect(initialComputed, containsPair('flexDisplay', 'block'));
      expect(initialComputed, containsPair('flexWidth', '40px'));
      expect(initialComputed, containsPair('gridDisplay', 'block'));
      expect(initialComputed, containsPair('gridWidth', '100px'));
      expect(initialComputed, containsPair('fontSize', '20px'));
      expect(initialComputed, containsPair('color', 'rgb(18, 52, 86)'));
      expect(initialComputed, containsPair('marginLeft', '80px'));
      expect(initialComputed, containsPair('parentWidth', '180px'));
      expect(initialComputed, containsPair('parentHeight', '70px'));
      expect(initialComputed, containsPair('parentColor', 'rgb(0, 0, 0)'));
      expect(initialComputed, containsPair('childColor', 'rgb(0, 0, 0)'));
      expect(initialComputed, containsPair('paddingLeft', '4px'));
      expect(initialComputed, containsPair('borderLeft', '3px'));
      expect(initialComputed, containsPair('left', '30px'));
      expect(initialComputed, containsPair('right', '-30px'));
      expect(initialComputed, containsPair('cssText', ''));
      expect(initialComputed, containsPair('distinct', true));
      expect(
        initialComputed,
        containsPair('readonly', 'NoModificationAllowedError'),
      );
      final initialRelative = obj(initial['relative']);
      expect(initialRelative['parentX'], 30);
      expect(initialRelative['gapX'], -.5);
      expect(initialRelative['gapY'], 12);
      expect(initialRelative['top'], 9);
      expect(initialRelative['left'], -3);
      expect(initialRelative['parentIdentity'], true);
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
      await t.tap(find.text('Relative', findRichText: true));
      await ready(
        () =>
            html
                .parse(document!.scripts!.content!.text)
                .getElementById('relative-parent')
                ?.attributes['style']
                ?.contains('50px') ==
            true,
      );
      await t.tap(find.text('Read', findRichText: true));
      await ready(() => obj(observation()['relative'])['parentX'] == 50);
      final changedComputed = obj(observation()['computed']);
      expect(changedComputed, containsPair('marginLeft', '100px'));
      expect(changedComputed, containsPair('left', '50px'));
      expect(changedComputed, containsPair('parentColor', 'rgb(60, 40, 20)'));
      expect(changedComputed, containsPair('childColor', 'rgb(60, 40, 20)'));
      expect(changedComputed, containsPair('right', '-50px'));
      expect(changedComputed['stale'], 'NotSupportedError');
      final relativeChanged = obj(observation()['relative']);
      expect(relativeChanged['gapX'], -.5);
      expect(relativeChanged['gapY'], 12);
      expect(relativeChanged['top'], 9);
      expect(relativeChanged['left'], -3);
      expect(relativeChanged['parentIdentity'], true);
      expect(
        relativeChanged['stale'].toString(),
        contains('NotSupportedError'),
      );
      await t.tap(find.text('Moved', findRichText: true));
      await ready(() => obj(observation()['relative'])['hits'] == 1);
      final moved = obj(observation()['relative']);
      expect(moved['parentX'], 50);
      expect(moved['top'], 9);
      expect(moved['left'], -3);
      expect(failures, isEmpty);
      expect(t.takeException(), isNull);
      debugPrintSynchronously(
        'PIRC_OFFSET_ACCEPTANCE ${jsonEncode({'initial': initial, 'scrolled': scrolled, 'changed': changed, 'parentScriptId': parentScriptId, 'stale': stale, 'percentChanged': percentChanged, 'relativeChanged': relativeChanged, 'computedChanged': changedComputed, 'moved': moved, 'failures': failures})}',
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
