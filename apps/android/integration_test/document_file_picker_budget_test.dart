import 'dart:convert';
import 'dart:typed_data';
import 'package:flutter/foundation.dart' show debugPrintSynchronously;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:html/parser.dart' as html;
import 'package:integration_test/integration_test.dart';
import 'package:pirc_mobile/live/document_scripts.dart';
import 'package:pirc_mobile/live/gateway.dart';

const _fixture = r'''<!doctype html><html><body>
<button id="pick">Choose bounded file</button><pre id="result">WAITING</pre>
<script>
const detached = document.createElement('input');detached.type='file';
window.events=[];
for(const type of ['input','change','cancel']) detached.addEventListener(type,event=>events.push({type:event.type,isTrusted:event.isTrusted,composed:event.composed}));
detached.onchange=async()=>{
 try {
  const file=detached.files[0];const bytes=new Uint8Array(await file.arrayBuffer());
  let exact=bytes.length===2*1024*1024;
  for(let i=0;i<bytes.length;i++)if(bytes[i]!==i%251){exact=false;break;}
  const value={length:bytes.length,exact,name:file.name,type:file.type,value:detached.value,connected:detached.isConnected,events};
  document.getElementById('result').textContent=JSON.stringify(value);
 }catch(error){document.getElementById('result').textContent=JSON.stringify({error:error.name,message:error.message});}
};
document.getElementById('pick').onclick=()=>detached.showPicker();
</script></body></html>''';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'native picker bridge imports the full 2 MiB selected file',
    (tester) async {
      await tester.pumpWidget(const MaterialApp(home: SizedBox()));
      final scripts = NativeDocumentScripts(Gateway());
      try {
        await scripts.start(
          source: _fixture,
          url: 'https://example.test/file-picker-budget',
        );
        expect(scripts.ready, isTrue, reason: '${scripts.diagnostics}');
        final marker = html
            .parse(scripts.content!.text)
            .querySelector('#pick')!
            .attributes['data-pirc-script-id']!;
        await scripts.click(marker, const []);
        expect(scripts.filePickerActions, hasLength(1));
        final action = scripts.takeFilePickerActions([
          scripts.filePickerActions.single['sequence'] as int,
        ]).single;
        final bytes = Uint8List(2 * 1024 * 1024);
        for (var i = 0; i < bytes.length; i++) {
          bytes[i] = i % 251;
        }
        await scripts.completeFilePicker(
          action['id'] as int,
          files: [
            {
              'name': 'large-雪.bin',
              'type': 'application/octet-stream',
              'size': bytes.length,
              'lastModified': 12345,
              'bytesBase64': base64Encode(bytes),
            },
          ],
        );
        Map<String, dynamic>? result;
        for (var i = 0; i < 200 && result == null; i++) {
          final text = html
              .parse(scripts.content!.text)
              .querySelector('#result')!
              .text
              .trim();
          if (text.startsWith('{')) {
            result = Map<String, dynamic>.from(jsonDecode(text) as Map);
          } else {
            await tester.pump(const Duration(milliseconds: 25));
          }
        }
        expect(result, {
          'length': 2097152,
          'exact': true,
          'name': 'large-雪.bin',
          'type': 'application/octet-stream',
          'value': r'C:\fakepath\large-雪.bin',
          'connected': false,
          'events': [
            {'type': 'input', 'isTrusted': true, 'composed': true},
            {'type': 'change', 'isTrusted': true, 'composed': false},
          ],
        });
        expect(scripts.diagnostics, isEmpty);
        expect(scripts.filePickerActions, isEmpty);
        debugPrintSynchronously(
          'NATIVE_FILE_PICKER_BUDGET ${jsonEncode(result)}',
        );
      } finally {
        scripts.dispose();
        await scripts.closed;
      }
    },
    timeout: const Timeout(Duration(minutes: 2)),
  );
}
