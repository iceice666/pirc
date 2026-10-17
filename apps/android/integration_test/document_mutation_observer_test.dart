import 'dart:convert';

import 'package:flutter/foundation.dart' show debugPrintSynchronously;
import 'package:flutter_test/flutter_test.dart';
import 'package:html/parser.dart' as html;
import 'package:integration_test/integration_test.dart';
import 'package:pirc_mobile/live/document_scripts.dart';
import 'package:pirc_mobile/live/gateway.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'native MutationObserver delivers real records in microtask order',
    (tester) async {
      const source = r'''<!doctype html><html><body>
<main id="root"><p id="nested">first</p></main><div id="drain"></div>
<button type="button" id="read">Read</button><pre id="probe">WAIT</pre>
<script>
var events=[],seen=[],batches=0,root=document.getElementById('root');
var text=document.getElementById('nested').firstChild;
var observer=new MutationObserver(function(records,self){
  batches++;events.push('mutation');var receiver=this;
  seen.push(...records.map(function(r){return {
    type:r.type,target:r.target.id||r.target.parentNode.id,old:r.oldValue,name:r.attributeName,
    added:Array.from(r.addedNodes).map(function(n){return n.id}),
    removed:Array.from(r.removedNodes).map(function(n){return n.id}),
    self:self===observer,receiver:receiver===observer,
    record:r instanceof MutationRecord,nodeList:r.addedNodes instanceof NodeList,
    item:r.addedNodes.item(0)?r.addedNodes.item(0).id:null
  }}));
});
observer.observe(root,{subtree:true,attributes:true,attributeOldValue:true,childList:true,characterDataOldValue:true});
root.setAttribute('data-chart','ready');root.setAttribute('data-chart','ready');
root.style.width='120px';root.style.width='121px';
text.data='second';
var inserted=document.createElement('b');inserted.id='inserted';document.getElementById('nested').appendChild(inserted);inserted.remove();
var drainCalls=0,drainObserver=new MutationObserver(function(){drainCalls++});
drainObserver.observe(document.getElementById('drain'),{attributes:true});
document.getElementById('drain').setAttribute('data-taken','yes');
var taken=drainObserver.takeRecords().length;drainObserver.disconnect();
function report(){document.getElementById('probe').textContent=JSON.stringify({events:events,seen:seen,batches:batches,taken:taken,drainCalls:drainCalls})}
events.push('sync');Promise.resolve().then(function(){events.push('promise')});Promise.resolve().then(report);
document.getElementById('read').onclick=report;
</script></body></html>''';
      final gateway = Gateway();
      final scripts = NativeDocumentScripts(gateway);
      try {
        await scripts.start(
          source: source,
          url: 'https://example.test/native-mutation-observer',
        );
        expect(scripts.ready, true, reason: '${scripts.diagnostics}');
        Json observation() => obj(
          jsonDecode(
            html.parse(scripts.content!.text).getElementById('probe')!.text,
          ),
        );
        final initial = observation();
        expect(initial['events'], ['sync', 'mutation', 'promise']);
        expect(initial['batches'], 1);
        expect(initial['taken'], 1);
        expect(initial['drainCalls'], 0);
        final records = rows(initial['seen']);
        expect(records.map((record) => record['type']).toList(), [
          'attributes',
          'attributes',
          'attributes',
          'attributes',
          'characterData',
          'childList',
          'childList',
        ]);
        expect(records.map((record) => record['target']).toList(), [
          'root',
          'root',
          'root',
          'root',
          'nested',
          'nested',
          'nested',
        ]);
        expect(records.map((record) => record['old']).toList(), [
          null,
          'ready',
          null,
          'width:120px',
          'first',
          null,
          null,
        ]);
        for (final record in records) {
          for (final field in ['self', 'receiver', 'record', 'nodeList']) {
            expect(record[field], true, reason: '$field: $record');
          }
        }
        expect(records[5]['added'], ['inserted']);
        expect(records[5]['item'], 'inserted');
        expect(records[6]['removed'], ['inserted']);
        final button = html
            .parse(scripts.content!.text)
            .getElementById('read')!;
        await scripts.click(button.attributes['data-pirc-script-id']!, []);
        expect(
          observation(),
          initial,
          reason: 'Private snapshots must not produce guest mutation records.',
        );
        expect(scripts.diagnostics, isEmpty);
        debugPrintSynchronously(
          'PIRC_NATIVE_MUTATION_ACCEPTANCE ${jsonEncode(initial)}',
        );
      } finally {
        scripts.dispose();
        await scripts.closed;
      }
    },
  );
}
