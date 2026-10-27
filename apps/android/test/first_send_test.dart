import 'dart:async';
import 'dart:convert';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'live_test.dart' show FakeGateway;

/// Tests the Flutter/native boundary; native filesystem/HTTP has separate JVM proofs.
class FirstPort {
  FirstPort(this.gateway) {
    gateway.handler = call;
  }
  final FakeGateway gateway;
  String owner = 'alice';
  int? contract = 2;
  int capabilityFailure = 503;
  bool full = false,
      loseSubmit = false,
      failCapabilities = false,
      supportsSubmit = true;
  Json? remotePending;
  Completer<void>? entered, release;
  final records = <String, Json>{};
  final bytes = <String, Uint8List>{};
  String key(Json args) => '${args['ownerUser']}:${args['operationId']}';
  Json clone(Json row) => obj(jsonDecode(jsonEncode(row)));
  Future<dynamic> call(String method, Json args) async {
    if (method == 'firstSendCapabilities') {
      if (failCapabilities) {
        throw PlatformException(
          code: 'HTTP_$capabilityFailure',
          details: {'status': capabilityFailure},
        );
      }
      return {
        'version': 1,
        if (contract != null) 'clientContract': contract,
        if (contract != null) 'requiredClientContract': 2,
        'canSubmit': supportsSubmit,
        'canFenceAccount': true,
        'canFindPendingSession': true,
        'canStopBeforeAllocation': true,
        'canRetryFirstMessage': true,
        'ownerUser': owner,
        'draftScope': jsonEncode(['https://gateway.example', owner]),
      };
    }
    if (method == 'firstSendDrafts') {
      final k = key(args), row = records[k];
      switch (args['action']) {
        case 'list':
          return records.values
              .where((r) => r['ownerUser'] == args['ownerUser'])
              .map(clone)
              .toList();
        case 'get':
          return row == null ? null : clone(row);
        case 'put':
          if (full) {
            throw PlatformException(code: 'STORAGE', message: 'disk full');
          }
          if (row == null
              ? args['expectedRevision'] != null
              : row['revision'] != args['expectedRevision'] ||
                    row['frozen'] == true) {
            throw PlatformException(
              code: 'CONFLICT',
              message: 'draft changed',
              details: {'code': 'draft_changed', 'status': 409},
            );
          }
          final record = clone(obj(args['record']));
          final files = rows(record['files']);
          for (final file in rows(args['files'])) {
            bytes['$k:${file['id']}'] = file['bytes'] as Uint8List;
          }
          record['files'] = files
              .map(
                (f) => {
                  ...f,
                  'sha256': f['sha256'] ?? List.filled(64, 'a').join(),
                },
              )
              .toList();
          records[k] = {
            ...record,
            'scope': jsonEncode(['https://gateway.example', args['ownerUser']]),
            'ownerUser': args['ownerUser'],
            'operationId': args['operationId'],
            'revision': (row?['revision'] as int? ?? 0) + 1,
            'frozen': false,
            'prepareAttempted': false,
          };
          return clone(records[k]!);
        case 'recover':
          final source = '${args['ownerUser']}:${args['sourceOperationId']}';
          if (row == null
              ? args['expectedRevision'] != null
              : row['revision'] != args['expectedRevision'] ||
                    row['frozen'] == true) {
            throw PlatformException(
              code: 'CONFLICT',
              details: {'code': 'draft_changed', 'status': 409},
            );
          }
          final input = clone(obj(args['record']));
          final supplied = {
            for (final f in rows(args['files']))
              f['id']: f['bytes'] as Uint8List,
          };
          for (final file in rows(input['files'])) {
            final content =
                supplied[file['id']] ??
                bytes['$k:${file['id']}'] ??
                bytes['$source:${file['id']}'];
            if (content == null) throw StateError('missing original bytes');
            bytes['$k:${file['id']}'] = content;
          }
          records[k] = {
            ...input,
            'ownerUser': args['ownerUser'],
            'operationId': args['operationId'],
            'scope': jsonEncode(['https://gateway.example', args['ownerUser']]),
            'recoveredFrom': args['sourceOperationId'],
            'revision': (row?['revision'] as int? ?? 0) + 1,
            'frozen': false,
            'prepareAttempted': false,
          };
          return clone(records[k]!);
        case 'delete':
          if (row != null && row['revision'] != args['expectedRevision']) {
            throw StateError('stale delete');
          }
          records.remove(k);
          return null;
      }
    }
    if (method == 'firstSendAdopt') {
      if (remotePending != null &&
          obj(remotePending!['preparation'])['sessionId'] ==
              args['sessionId']) {
        final row = {
          ...remotePending!,
          'ownerUser': args['ownerUser'],
          'scope': jsonEncode(['https://gateway.example', args['ownerUser']]),
        };
        records['${args['ownerUser']}:${row['operationId']}'] = row;
        return clone(row);
      }
      throw PlatformException(code: 'HTTP_404', details: {'status': 404});
    }
    final k = key(args), row = records[k];
    if (method == 'firstSendSubmit') {
      if (row == null) throw StateError('missing draft');
      row['frozen'] = true;
      row['prepareAttempted'] = true;
      row['revision']++;
      row['preparation'] = {
        'operationId': row['operationId'],
        'sessionId': 'public-${row['operationId']}',
        'workspaceId': 'w',
        'state': 'admitted',
        'accepted': true,
        'cleanupPending': false,
      };
      entered?.complete();
      await release?.future;
      if (loseSubmit) {
        throw PlatformException(
          code: 'HTTP_503',
          message: 'reply lost',
          details: {'status': 503},
        );
      }
      return clone(row);
    }
    if (method == 'firstSendCheck') return row == null ? null : clone(row);
    if (method == 'firstSendTakeControl') return 11;
    if (method == 'firstSendStop') {
      if (row == null) throw StateError('missing');
      row['revision']++;
      row['stopCommandId'] = 'fixed-stop';
      row['preparation'] = {
        ...obj(row['preparation']),
        'state': 'stopping',
        'nodeMapped': false,
        'messageAdmission': {
          'outcome': 'outcome_unknown',
          'stopRequested': true,
          'stopConfirmed': false,
        },
      };
      return clone(row);
    }
    if (method == 'firstSendRelease') {
      if (row == null) throw StateError('missing');
      row['revision']++;
      row['released'] = true;
      row['preparation'] = {...obj(row['preparation']), 'nodeMapped': true};
      return clone(row);
    }
    if (method == 'firstSendCancel') {
      if (row == null) return null;
      if (obj(row['preparation'])['accepted'] == true &&
          args['deleteAccepted'] != true) {
        row['cancelRequested'] = true;
        row['revision']++;
        throw PlatformException(
          code: 'HTTP_409',
          details: {'status': 409, 'code': 'confirmation_required'},
        );
      }
      records.remove(k);
      return null;
    }
    if (method == 'pickAttachments') {
      return [
        {
          'name': 'note.txt',
          'mimeType': 'text/plain',
          'bytes': Uint8List.fromList([65, 66]),
        },
      ];
    }
    return gateway.normal(method, args);
  }
}

void main() {
  Future<(LiveController, FakeGateway, FirstPort)> setup() async {
    final gateway = FakeGateway();
    final port = FirstPort(gateway);
    final controller = LiveController(gateway);
    await controller.boot();
    gateway.calls.clear();
    return (controller, gateway, port);
  }

  Future<void> dispose(LiveController c, FakeGateway g) async {
    c.dispose();
    await g.stream.close();
  }

  test(
    'real Send uses the native durable engine, preserves files and never uses legacy creation',
    () async {
      final (c, g, p) = await setup();
      await c.create('w');
      c.editDraft('Original text');
      await c.attach();
      await c.send('prompt');
      expect(
        g.calls.where((call) => call.$1 == 'firstSendSubmit'),
        hasLength(1),
      );
      expect(
        g.calls.where(
          (call) =>
              call.$1 == 'command' ||
              call.$1 == 'uploadAttachment' ||
              (call.$1 == 'request' && call.$2['method'] == 'POST'),
        ),
        isEmpty,
      );
      expect(c.sessionId, startsWith('public-'));
      expect(c.draft, '');
      expect(c.firstSend.current, isNull);
      expect(p.bytes.values.single, [65, 66]);
      await dispose(c, g);
    },
  );
  test(
    'navigation and a new controller restore original draft bytes without publishing',
    () async {
      final (c, g, p) = await setup();
      await c.create('w');
      c.editDraft('Unsent');
      await c.attach();
      await c.flushDraft();
      final op = c.firstSend.current!['operationId'];
      await c.create('w');
      expect(c.firstSend.saved.single['message'], 'Unsent');
      expect(g.calls.where((call) => call.$1 == 'firstSendSubmit'), isEmpty);
      c.dispose();
      final restored = LiveController(g);
      await restored.boot();
      await restored.firstSend.resume(restored.firstSend.saved.single);
      expect(restored.firstSend.current!['operationId'], op);
      expect(restored.draft, 'Unsent');
      expect(restored.attachments.single['sha256'], isNotNull);
      expect(p.bytes.values.single, [65, 66]);
      await dispose(restored, g);
    },
  );
  test(
    'storage refusal keeps the selected text and never exposes legacy Send',
    () async {
      final (c, g, p) = await setup();
      p.full = true;
      await expectLater(c.create('w'), throwsA(isA<PlatformException>()));
      c.editDraft('Keep me');
      await c.send('prompt');
      expect(c.draft, 'Keep me');
      expect(c.firstSend.current, isNotNull);
      expect(
        g.calls.where(
          (call) =>
              call.$1 == 'firstSendSubmit' ||
              call.$1 == 'command' ||
              (call.$1 == 'request' && call.$2['method'] == 'POST'),
        ),
        isEmpty,
      );
      p.full = false;
      await c.send('prompt');
      expect(c.firstSend.current, isNull);
      await dispose(c, g);
    },
  );
  test(
    'checking a lost reply does not watch, take control or resend; opening is explicit',
    () async {
      final (c, g, p) = await setup();
      await c.create('w');
      c.editDraft('One only');
      p.loseSubmit = true;
      await c.send('prompt');
      expect(c.firstSend.frozen, true);
      expect(c.draft, 'One only');
      g.calls.clear();
      await c.firstSend.check();
      expect(g.calls.map((call) => call.$1), ['firstSendCheck']);
      expect(c.draft, 'One only');
      expect(c.isDraftSession, true);
      await c.firstSend.openKnown();
      expect(c.firstSend.current, isNull);
      expect(c.draft, '');
      await dispose(c, g);
    },
  );
  test(
    'late successful admission never replaces a newer local conversation',
    () async {
      final (c, g, p) = await setup();
      await c.create('w');
      c.editDraft('Earlier');
      p.entered = Completer<void>();
      p.release = Completer<void>();
      final sending = c.send('prompt');
      await p.entered!.future;
      await c.create('w');
      final newer = c.sessionId;
      p.release!.complete();
      await sending;
      expect(c.sessionId, newer);
      expect(c.firstSend.current?['operationId'], newer);
      expect(c.draft, '');
      expect(
        c.firstSend.saved.any(
          (r) => obj(r['preparation'])['state'] == 'admitted',
        ),
        true,
      );
      await dispose(c, g);
    },
  );
  test(
    'background and resume never watch a local draft or send it automatically',
    () async {
      final (c, g, _) = await setup();
      await c.create('w');
      c.editDraft('Local only');
      g.calls.clear();
      await c.lifecycle(false);
      await c.lifecycle(true);
      expect(c.draft, 'Local only');
      expect(
        g.calls.where(
          (call) =>
              call.$1 == 'firstSendSubmit' ||
              (call.$1 == 'watch' &&
                  '${call.$2['sessionId']}'.startsWith('draft-')),
        ),
        isEmpty,
      );
      await dispose(c, g);
    },
  );
  test(
    'account changes hide original drafts and cannot retarget their send',
    () async {
      final (c, g, p) = await setup();
      await c.create('w');
      c.editDraft('Alice private');
      await c.flushDraft();
      p.owner = 'bob';
      await c.firstSend.initialize();
      expect(c.draft, '');
      expect(c.firstSend.current, isNull);
      expect(c.firstSend.saved, isEmpty);
      expect(p.records.values.single['ownerUser'], 'alice');
      await c.create('w');
      c.editDraft('Bob private');
      await c.flushDraft();
      expect(
        p.records.values.map((r) => r['ownerUser']),
        containsAll(['alice', 'bob']),
      );
      expect(g.calls.where((call) => call.$1 == 'firstSendSubmit'), isEmpty);
      await dispose(c, g);
    },
  );
  test(
    'unknown cold capability support cannot fall back to legacy creation',
    () async {
      final (c, g, p) = await setup();
      c.firstSend.reset();
      p.failCapabilities = true;
      await c.firstSend.initialize();
      g.calls.clear();
      await expectLater(c.create('w'), throwsStateError);
      expect(
        g.calls.where(
          (call) =>
              call.$1 == 'firstSendSubmit' ||
              (call.$1 == 'request' && call.$2['method'] == 'POST'),
        ),
        isEmpty,
      );
      expect(c.firstSend.unavailable, true);
      p.failCapabilities = false;
      await c.create('w');
      expect(c.firstSend.current, isNotNull);
      await dispose(c, g);
    },
  );
  test(
    'an already-authenticated draft remains editable through a transient capability failure',
    () async {
      final (c, g, p) = await setup();
      await c.create('w');
      c.editDraft('Before offline');
      await c.flushDraft();
      p.failCapabilities = true;
      await c.firstSend.initialize();
      c.editDraft('Kept while offline');
      await c.flushDraft();
      expect(c.firstSend.current!['message'], 'Kept while offline');
      expect(c.firstSend.enabled, true);
      expect(g.calls.where((call) => call.$1 == 'firstSendSubmit'), isEmpty);
      await dispose(c, g);
    },
  );
  test(
    'opening another device pending intent is read-only and uses its original conversation',
    () async {
      final (c, g, p) = await setup();
      p.remotePending = {
        'operationId': 'other-device',
        'workspaceId': 'w',
        'message': 'From another phone',
        'files': [],
        'revision': 1,
        'frozen': true,
        'prepareAttempted': true,
        'preparation': {
          'operationId': 'other-device',
          'sessionId': 'remote-pending',
          'workspaceId': 'w',
          'accepted': true,
          'state': 'accepted',
          'cleanupPending': false,
        },
      };
      g.calls.clear();
      await c.open('remote-pending');
      expect(c.sessionId, 'remote-pending');
      expect(c.draft, 'From another phone');
      expect(c.firstSend.current!['operationId'], 'other-device');
      expect(c.firstSend.frozen, true);
      expect(
        g.calls.where(
          (call) => [
            'watch',
            'control',
            'command',
            'firstSendSubmit',
          ].contains(call.$1),
        ),
        isEmpty,
      );
      await dispose(c, g);
    },
  );
  test(
    'a disabled new-send gate still exposes an existing pending recovery without legacy fallback',
    () async {
      final (c, g, p) = await setup();
      await c.create('w');
      c.editDraft('Keep pending');
      p.loseSubmit = true;
      await c.send('prompt');
      final stored = p.records.values.single;
      stored['preparation'] = {
        ...obj(stored['preparation']),
        'state': 'outcome_unknown',
      };
      p.supportsSubmit = false;
      await c.firstSend.initialize();
      await c.home();
      expect(c.firstSend.available, true);
      expect(c.firstSend.enabled, false);
      await c.firstSend.resume(c.firstSend.saved.single);
      g.calls.clear();
      await c.send('prompt');
      expect(c.draft, 'Keep pending');
      expect(c.firstSend.frozen, true);
      expect(
        g.calls.where(
          (call) =>
              call.$1 == 'firstSendSubmit' ||
              call.$1 == 'command' ||
              (call.$1 == 'request' && call.$2['method'] == 'POST'),
        ),
        isEmpty,
      );
      await c.firstSend.check();
      expect(g.calls.last.$1, 'firstSendCheck');
      await dispose(c, g);
    },
  );
  test(
    'page navigation refuses a failed local save and keeps the newest visible input',
    () async {
      final (c, g, p) = await setup();
      await c.create('w');
      c.editDraft('Stored');
      await c.flushDraft();
      p.full = true;
      c.editDraft('Newest input');
      await expectLater(
        c.prepareDraftNavigation(),
        throwsA(isA<PlatformException>()),
      );
      expect(c.firstSend.current, isNotNull);
      expect(c.draft, 'Newest input');
      p.full = false;
      expect(await c.prepareDraftNavigation(), true);
      c.discardDraftSession();
      expect(p.records.values.single['message'], 'Newest input');
      expect(g.calls.where((call) => call.$1 == 'firstSendSubmit'), isEmpty);
      await dispose(c, g);
    },
  );
  test(
    'removing an attachment is durable and attachment-only first send is supported',
    () async {
      final (c, g, _) = await setup();
      await c.create('w');
      await c.attach();
      c.removeAttachment(c.attachments.single);
      await c.flushDraft();
      expect(c.firstSend.current!['files'], isEmpty);
      await c.attach();
      await c.send('prompt');
      expect(
        g.calls.where((call) => call.$1 == 'firstSendSubmit'),
        hasLength(1),
      );
      expect(c.firstSend.current, isNull);
      await dispose(c, g);
    },
  );

  test(
    'an incompatible client contract cannot create a legacy replacement',
    () async {
      final (c, g, p) = await setup();
      p.contract = 3;
      await c.firstSend.initialize();
      g.calls.clear();
      expect(c.firstSend.enabled, false);
      expect(c.firstSend.unavailable, true);
      await expectLater(c.create('w'), throwsStateError);
      expect(
        g.calls.where(
          (call) => call.$1 == 'request' && call.$2['method'] == 'POST',
        ),
        isEmpty,
      );
      c.dispose();
      await g.stream.close();
    },
  );
  test(
    'bound modern drafts survive old gated and missing capability responses without legacy replacement',
    () async {
      final (c, g, p) = await setup();
      await c.create('w');
      c.editDraft('Keep original');
      await c.attach();
      await c.flushDraft();
      final id = c.firstSend.current!['operationId'];
      p.contract = null;
      p.supportsSubmit = false;
      await c.firstSend.initialize();
      await c.firstSend.initialize();
      expect(c.firstSend.unavailable, true);
      await expectLater(c.create('w'), throwsStateError);
      p.failCapabilities = true;
      p.capabilityFailure = 404;
      await c.firstSend.initialize();
      expect(c.firstSend.unavailable, true);
      await expectLater(c.create('w'), throwsStateError);
      expect(c.firstSend.current!['operationId'], id);
      expect(c.draft, 'Keep original');
      expect(c.attachments, hasLength(1));
      expect(p.bytes.values.single, [65, 66]);
      expect(
        g.calls.where(
          (call) =>
              call.$1 == 'firstSendSubmit' ||
              (call.$1 == 'request' && call.$2['method'] == 'POST'),
        ),
        isEmpty,
      );
      await dispose(c, g);
    },
  );
  test(
    'conflicted edits retain private text and original file bytes until an explicit reviewed Send',
    () async {
      final (c, g, p) = await setup();
      await c.create('w');
      c.editDraft('Original');
      await c.attach();
      await c.flushDraft();
      final op = c.firstSend.current!['operationId'];
      final primary = p.records['alice:$op']!;
      primary['frozen'] = true;
      primary['revision']++;
      primary['preparation'] = {
        'state': 'admitted',
        'accepted': true,
        'sessionId': 'public-original',
        'operationId': op,
      };
      c.editDraft('Local unsent changes');
      await c.flushDraft();
      await c.send('prompt');
      final copy = c.firstSend.saved.singleWhere(
        (r) => r['recoveredFrom'] == op,
      );
      expect(copy['message'], 'Local unsent changes');
      expect(copy['frozen'], false);
      expect(copy['preparation'], isNull);
      expect(primary['message'], 'Original');
      expect(
        p.bytes['alice:${copy['operationId']}:${rows(copy['files']).single['id']}'],
        [65, 66],
      );
      expect(g.calls.where((call) => call.$1 == 'firstSendSubmit'), isEmpty);
      await c.firstSend.resume(copy);
      expect(c.draft, 'Local unsent changes');
      expect(g.calls.where((call) => call.$1 == 'firstSendSubmit'), isEmpty);
      await c.send('prompt');
      expect(
        g.calls.where((call) => call.$1 == 'firstSendSubmit'),
        hasLength(1),
      );
      expect(primary['message'], 'Original');
      await dispose(c, g);
    },
  );
  test(
    'a peer-edited recovery copy is kept while later local edits get a different draft',
    () async {
      final (c, g, p) = await setup();
      await c.create('w');
      c.editDraft('Original');
      await c.flushDraft();
      final op = c.firstSend.current!['operationId'],
          primary = p.records['alice:${c.firstSend.current!['operationId']}']!;
      primary['message'] = 'Peer main';
      primary['revision']++;
      c.editDraft('Local one');
      await c.flushDraft();
      final first = c.firstSend.saved.singleWhere(
        (r) => r['recoveredFrom'] == op,
      );
      p.records['alice:${first['operationId']}']!['message'] = 'Peer copy';
      p.records['alice:${first['operationId']}']!['revision']++;
      c.editDraft('Local two');
      await c.flushDraft();
      expect(
        p.records.values
            .where((r) => r['recoveredFrom'] == op)
            .map((r) => r['message']),
        unorderedEquals(['Peer copy', 'Local two']),
      );
      expect(primary['message'], 'Peer main');
      expect(g.calls.where((call) => call.$1 == 'firstSendSubmit'), isEmpty);
      await dispose(c, g);
    },
  );
}
