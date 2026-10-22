import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/room_message_row.dart';
import 'package:pirc_mobile/live/rooms_state.dart';
import 'live_test.dart' show theme;
import 'rooms_test.dart' show RoomsGateway, me;

/// The room's actions answer; downloads and saves are recorded.
class RowGateway extends RoomsGateway {
  @override
  dynamic normal(String method, Json args) {
    switch (method) {
      case 'request':
        return {};
      case 'roomsDownload':
        return {
          'bytes': Uint8List.fromList([1, 2, 3]),
          'mimeType': 'text/plain',
        };
      case 'saveDocument':
        return {'name': args['name'], 'bytesWritten': 3};
    }
    return super.normal(method, args);
  }

  List<(String, String, Object?)> get requests => [
    for (final call in calls)
      if (call.$1 == 'request')
        ('${call.$2['method']}', '${call.$2['path']}', call.$2['body']),
  ];
}

Json row(
  String kind,
  Json body, {
  String speaker = 'face:host',
  String? threadId,
  int at = 1000,
  String id = 'm',
}) => {
  'id': id,
  'roomId': 'general',
  'seq': 1,
  'speaker': speaker,
  'user': speaker == 'user' ? me : null,
  'kind': kind,
  'body': body,
  'threadId': threadId,
  'createdAt': at,
  'editedAt': null,
  'pinnedAt': null,
};

class Pumped {
  Pumped(this.gateway, this.rooms);
  final RowGateway gateway;
  final RoomsController rooms;
  final opened = <String>[], threads = <String>[], details = <String>[];
}

Future<Pumped> pumpRow(
  WidgetTester t,
  Json message, {
  Json? previous,
  Json activity = const {},
}) async {
  final g = RowGateway();
  final rooms = RoomsController(g, pairingStampOf: () => 'stamp');
  rooms.apply({...g.view, 'threadActivity': activity});
  final pumped = Pumped(g, rooms);
  await t.pumpWidget(
    MaterialApp(
      theme: theme.build(Brightness.light),
      home: Scaffold(
        body: SingleChildScrollView(
          child: RoomMessageRow(
            message: message,
            previous: previous,
            rooms: rooms,
            onOpenRoom: pumped.opened.add,
            onOpenThread: pumped.threads.add,
            onPin: (_, _) {},
            onDetails: pumped.details.add,
          ),
        ),
      ),
    ),
  );
  await t.pump();
  return pumped;
}

void main() {
  testWidgets('progress says what is being done', (t) async {
    await pumpRow(t, row('progress', {'text': 'Reading the CI log'}));
    expect(find.text('Reading the CI log'), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
  });

  testWidgets('a remembered fact expands and is not kept', (t) async {
    final p = await pumpRow(
      t,
      row('line', {
        'text': 'Remembered: CI runs on Fridays',
        'memory': {'kind': 'fact', 'id': 'f1', 'origin': 'user'},
      }),
    );
    await t.tap(find.text('Remembered: CI runs on Fridays'));
    await t.pump();
    expect(
      find.text('A fact: found again when it matters. From your words.'),
      findsOneWidget,
    );
    await t.tap(find.text("Don't keep"));
    await t.pumpAndSettle();
    expect(p.gateway.requests.single.$1, 'DELETE');
    expect(p.gateway.requests.single.$2, '/api/memory/records/f1');
    await t.tap(find.text('Details'));
    expect(p.details, ['memory']);
  });

  testWidgets('a preference is forgotten through the preferences', (t) async {
    final p = await pumpRow(
      t,
      row('line', {
        'text': 'Will remember: answer in Chinese',
        'memory': {'kind': 'preference', 'id': 'p1'},
      }),
    );
    await t.tap(find.text("Don't keep"));
    await t.pumpAndSettle();
    expect(p.gateway.requests.single.$1, 'POST');
    expect(p.gateway.requests.single.$2, '/api/memory/preferences/p1/forget');
  });

  testWidgets('an open loop line is undone once', (t) async {
    final p = await pumpRow(
      t,
      row('line', {
        'text': 'Keeping an eye on: the visa',
        'loop': {'id': 'l1', 'event': 'opened'},
      }),
    );
    await t.tap(find.text("Don't keep"));
    await t.pumpAndSettle();
    expect(p.gateway.requests.single.$1, 'PATCH');
    expect(p.gateway.requests.single.$2, '/api/loops/l1');
    expect(p.gateway.requests.single.$3, {'status': 'closed'});
    expect(find.text("Don't keep"), findsNothing);
    await t.tap(find.text('Details'));
    expect(p.details, ['loops']);
  });

  testWidgets('a closed loop opens again', (t) async {
    final p = await pumpRow(
      t,
      row('line', {
        'text': 'Done: the visa',
        'loop': {'id': 'l1', 'event': 'closed'},
      }),
    );
    await t.tap(find.text('Not done yet'));
    await t.pumpAndSettle();
    expect(p.gateway.requests.single.$3, {'status': 'open'});
  });

  testWidgets('a scheduled wake is called off', (t) async {
    final p = await pumpRow(
      t,
      row('line', {
        'text': "I'll look again at 18:00",
        'wake': {'id': 'w1', 'event': 'scheduled'},
      }),
    );
    await t.tap(find.text('Cancel'));
    await t.pumpAndSettle();
    expect(p.gateway.requests.single.$1, 'DELETE');
    expect(p.gateway.requests.single.$2, '/api/wakes/w1');
    expect(find.text('Cancel'), findsNothing);
  });

  testWidgets('a move line opens the other room', (t) async {
    final p = await pumpRow(
      t,
      row('line', {
        'text': 'Continued in #slime',
        'move': {'direction': 'to', 'roomId': 'slime', 'roomName': 'slime'},
      }),
    );
    await t.tap(find.text('Continued in #slime'));
    expect(p.opened, ['slime']);
  });

  testWidgets('a working anchor shows its progress, opens and stops', (
    t,
  ) async {
    final p = await pumpRow(
      t,
      row('text', {
        'text': 'Fix lint',
        'worker': {
          'delegationId': 'd1',
          'threadId': 'thr',
          'status': 'running',
          'title': 'Fix lint',
          'workspace': 'slimeos',
          'workers': 2,
          'readOnly': false,
          'note': null,
        },
      }, threadId: 'thr'),
      activity: {
        'thr': {'text': 'bun run lint (3 errors)', 'at': 5},
      },
    );
    expect(find.text('Working (2)'), findsOneWidget);
    expect(find.text('bun run lint (3 errors)'), findsOneWidget);
    await t.tap(find.text('Thread'));
    expect(p.threads, ['thr']);
    await t.tap(find.text('Stop'));
    await t.pumpAndSettle();
    expect(p.gateway.requests.single.$2, '/api/delegations/d1/stop');
  });

  testWidgets('a finished anchor shows no progress and no stop', (t) async {
    await pumpRow(
      t,
      row('text', {
        'text': 'Fix lint',
        'worker': {
          'delegationId': 'd1',
          'threadId': 'thr',
          'status': 'completed',
          'title': 'Fix lint',
          'workers': 1,
        },
      }, threadId: 'thr'),
      activity: {
        'thr': {'text': 'old line', 'at': 5},
      },
    );
    expect(find.text('Done'), findsOneWidget);
    expect(find.text('old line'), findsNothing);
    expect(find.text('Stop'), findsNothing);
  });

  testWidgets('a red-line question is answered in the room', (t) async {
    final p = await pumpRow(
      t,
      row('question', {
        'text': 'May I push to origin?',
        'question': {
          'interactionId': 'i1',
          'threadMessageId': 'tm',
          'request': {'title': 'Push', 'allowAgain': true},
          'status': 'pending',
        },
      }, threadId: 'thr'),
    );
    expect(find.text('asks you'), findsOneWidget);
    expect(find.text('Allow again this session'), findsOneWidget);
    await t.tap(find.text('Yes'));
    await t.pumpAndSettle();
    final (method, path, body) = p.gateway.requests.single;
    expect(method, 'POST');
    expect(path, '/api/threads/thr/answer');
    expect(body, {
      'interactionId': 'i1',
      'answer': {'confirmed': true},
    });
  });

  testWidgets('an answered question says how it ended', (t) async {
    await pumpRow(
      t,
      row('question', {
        'text': 'May I push?',
        'question': {
          'interactionId': 'i1',
          'request': {},
          'status': 'answered',
          'answeredBy': me,
          'answer': {'confirmed': true, 'again': true},
        },
      }, threadId: 'thr'),
    );
    expect(
      find.text('Allowed for the rest of its session by $me.'),
      findsOneWidget,
    );
    expect(find.text('Yes'), findsNothing);
  });

  testWidgets('a file is saved where the user picks', (t) async {
    final p = await pumpRow(
      t,
      row('text', {
        'text': 'the log',
        'attachments': [
          {
            'id': 'u1',
            'kind': 'file',
            'filename': 'ci.log',
            'mimeType': 'text/plain',
            'byteSize': 2048,
          },
        ],
      }, speaker: 'user'),
    );
    await t.tap(find.text('ci.log · 2 KB'));
    await t.pumpAndSettle();
    final download = p.gateway.calls.firstWhere(
      (call) => call.$1 == 'roomsDownload',
    );
    expect(download.$2, {'roomId': 'general', 'uploadId': 'u1'});
    final save = p.gateway.calls.firstWhere(
      (call) => call.$1 == 'saveDocument',
    );
    expect(save.$2['name'], 'ci.log');
    expect(save.$2['pairingStamp'], 'stamp');
  });

  testWidgets('a run by one speaker shares a header for five minutes', (
    t,
  ) async {
    await pumpRow(
      t,
      row('text', {'text': 'second'}, at: 60_000, id: 'b'),
      previous: row('text', {'text': 'first'}, at: 0, id: 'a'),
    );
    expect(find.text('pirc'), findsNothing);
    await pumpRow(
      t,
      row('text', {'text': 'later'}, at: 6 * 60_000, id: 'c'),
      previous: row('text', {'text': 'first'}, at: 0, id: 'a'),
    );
    expect(find.text('pirc'), findsOneWidget);
  });
}
