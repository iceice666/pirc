import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/face_page.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/rooms_state.dart';
import 'package:pirc_mobile/live/settings_dialog.dart';
import 'package:pirc_mobile/live/source_settings.dart';
import 'live_test.dart' show theme;
import 'rooms_test.dart' show RoomsGateway, room;

Json face(
  String id,
  String name, {
  bool host = false,
  List<String> rooms = const [],
  bool archived = false,
}) => {
  'id': id,
  'name': name,
  'bio': '',
  'tone': '',
  'avatar': null,
  'color': null,
  'roleMd': '',
  'territory': {
    'rooms': rooms,
    'workspaces': <String>[],
    'sources': <String>[],
  },
  'isHost': host,
  'createdAt': 1,
  'archivedAt': archived ? 5 : null,
  'hiddenAt': null,
};

/// Faces, prompts, workspaces and sources answered; every request recorded.
class FaceGateway extends RoomsGateway {
  final requests = <(String, String, Object?)>[];
  bool soulWritable = true;
  final saved = <Json>[];

  @override
  dynamic normal(String method, Json args) {
    if (method == 'roomsFaceSaved') {
      saved.add(obj(args['face']));
      return null;
    }
    if (method != 'request') return super.normal(method, args);
    final path = '${args['path']}';
    final verb = '${args['method'] ?? 'GET'}';
    requests.add((verb, path, args['body']));
    if (verb == 'PATCH' && path.startsWith('/api/faces/')) {
      return {
        'face': {...face(path.split('/').last, 'PM'), ...obj(args['body'])},
      };
    }
    if (verb == 'POST' && path == '/api/faces') {
      return {'face': face('face_new', '${obj(args['body'])['name']}')};
    }
    if (verb == 'PUT' && path.startsWith('/api/brain/prompts/')) {
      return {
        'prompt': {
          'text': obj(args['body'])['text'],
          'writable': true,
          'path': '/x',
          'maxChars': 8000,
        },
      };
    }
    if (verb == 'POST' && path == '/api/sources') {
      return {'source': {}, 'test': 'Logged in; 12 messages.'};
    }
    if (verb != 'GET') return {};
    if (path.endsWith('/activity')) {
      return {
        'loops': [
          {'id': 'l1', 'what': 'Watch the CI'},
        ],
        'workers': [
          {
            'id': 'w',
            'title': 'Fix lint',
            'status': 'completed',
            'updatedAt': 1,
          },
        ],
        'wakes': [],
      };
    }
    if (path == '/api/workspaces') {
      return {
        'workspaces': [
          {
            'id': 'desk:slimeos',
            'displayName': 'slimeos',
            'hostId': 'desk',
            'mode': 'repo',
          },
          {
            'id': 'desk:scratch',
            'displayName': 'scratch',
            'hostId': 'desk',
            'mode': 'scratch',
          },
        ],
      };
    }
    if (path == '/api/sources') return {'sources': []};
    if (path == '/api/brain/prompts') {
      return {
        'prompts': {
          'soul': {
            'text': 'You are pirc.',
            'writable': soulWritable,
            'reason': soulWritable ? null : 'nix-store',
            'path': '/etc/pirc/SOUL.md',
            'maxChars': 8000,
          },
          'chat': {
            'text': 'Be brief.',
            'writable': true,
            'path': '/x/CHAT.md',
            'maxChars': 8000,
          },
        },
      };
    }
    return {};
  }
}

Future<(FaceGateway, RoomsController)> pumpFace(
  WidgetTester t,
  String faceId, {
  bool soulWritable = true,
}) async {
  t.view.devicePixelRatio = 1;
  t.view.physicalSize = const Size(420, 2400);
  addTearDown(t.view.reset);
  final g = FaceGateway()..soulWritable = soulWritable;
  final rooms = RoomsController(g);
  rooms.apply({
    ...g.view,
    'rooms': [room('general', kind: 'general'), room('slime'), room('taken')],
    'faces': [
      face('host', 'pirc', host: true),
      face('face_pm', 'PM', rooms: ['slime']),
      face('face_ops', 'Ops', rooms: ['taken']),
    ],
  });
  await t.pumpWidget(
    MaterialApp(
      theme: theme.build(Brightness.light),
      home: Scaffold(
        body: FacePage(rooms: rooms, faceId: faceId, onBack: () {}),
      ),
    ),
  );
  await t.pumpAndSettle();
  return (g, rooms);
}

void main() {
  testWidgets("a face's page saves what changed, from its next turn", (
    t,
  ) async {
    final (g, _) = await pumpFace(t, 'face_pm');
    expect(find.text('• Watch the CI'), findsOneWidget);
    expect(find.textContaining('Fix lint · Done'), findsOneWidget);
    // Another face's room is not offered; scratch workspaces are not listed.
    final taken = t.widget<CheckboxListTile>(
      find.widgetWithText(CheckboxListTile, "#taken · Ops's"),
    );
    expect(taken.onChanged, isNull);
    expect(find.text('scratch · desk'), findsNothing);
    await t.enterText(find.widgetWithText(TextField, 'Name'), 'SlimeOS PM');
    await t.tap(find.text('slimeos · desk'));
    await t.pump();
    await t.tap(find.text('Save'));
    await t.pumpAndSettle();
    final patch = g.requests.lastWhere((r) => r.$1 == 'PATCH');
    expect(patch.$2, '/api/faces/face_pm');
    expect(obj(patch.$3)['name'], 'SlimeOS PM');
    expect(obj(patch.$3)['territory'], {
      'rooms': ['slime'],
      'workspaces': ['desk:slimeos'],
      'sources': [],
    });
    expect(g.saved.single['name'], 'SlimeOS PM');
    await t.tap(find.text('Archive'));
    await t.pumpAndSettle();
    expect(g.requests.lastWhere((r) => r.$1 == 'PATCH').$3, {'archived': true});
  });

  testWidgets("the host's page edits who pirc is", (t) async {
    final (g, _) = await pumpFace(t, 'host');
    expect(
      find.text('Answers in #general and in every room no other face has.'),
      findsOneWidget,
    );
    expect(find.text('Archive'), findsNothing);
    final soul = find.widgetWithText(TextField, 'You are pirc.');
    await t.enterText(soul, 'You are pirc, kind and brief.');
    await t.pump();
    await t.tap(find.text('Save SOUL.md'));
    await t.pumpAndSettle();
    final put = g.requests.lastWhere((r) => r.$1 == 'PUT');
    expect(put.$2, '/api/brain/prompts/soul');
    expect(put.$3, {'text': 'You are pirc, kind and brief.'});
  });

  testWidgets('a prompt managed elsewhere is read-only and says where', (
    t,
  ) async {
    await pumpFace(t, 'host', soulWritable: false);
    expect(find.text('Save SOUL.md'), findsNothing);
    expect(find.text('Managed by Nix (/etc/pirc/SOUL.md).'), findsOneWidget);
  });

  testWidgets(
    'a source is added with its credential and removed after asking',
    (t) async {
      t.view.devicePixelRatio = 1;
      t.view.physicalSize = const Size(420, 2000);
      addTearDown(t.view.reset);
      final g = FaceGateway();
      await t.pumpWidget(
        MaterialApp(
          theme: theme.build(Brightness.light),
          home: Scaffold(
            body: SingleChildScrollView(
              child: NativeSourceSettings(gateway: g),
            ),
          ),
        ),
      );
      await t.pumpAndSettle();
      await t.tap(find.text('Add a source'));
      await t.pumpAndSettle();
      await t.enterText(find.widgetWithText(TextField, 'Name'), 'School mail');
      await t.enterText(
        find.widgetWithText(TextField, 'Address'),
        'me@school.edu',
      );
      await t.enterText(
        find.widgetWithText(TextField, 'App password'),
        'abcd efgh',
      );
      await t.tap(find.text('Add'));
      await t.pumpAndSettle();
      final post = g.requests.lastWhere((r) => r.$1 == 'POST');
      expect(post.$2, '/api/sources');
      expect(post.$3, {
        'kind': 'email',
        'name': 'School mail',
        'config': {
          'host': 'imap.gmail.com',
          'port': 993,
          'username': 'me@school.edu',
          'mailbox': 'INBOX',
        },
        'secret': {'password': 'abcd efgh'},
      });
      expect(find.text('Added: Logged in; 12 messages.'), findsOneWidget);
    },
  );

  test('a source in one line, without its secret', () {
    expect(
      describeSource({
        'kind': 'email',
        'config': {
          'username': 'me@x',
          'host': 'imap.gmail.com',
          'mailbox': 'INBOX',
        },
      }),
      'me@x · imap.gmail.com · INBOX',
    );
    expect(
      describeSource({
        'kind': 'calendar',
        'config': {'mode': 'ics', 'host': 'cal.x'},
      }),
      'ICS · cal.x',
    );
    expect(sourceStatus({'pausedAt': 1}), 'Paused');
    expect(
      sourceStatus({'failures': 2, 'lastError': 'bad login'}),
      'Cannot be read: bad login',
    );
    expect(
      sourceStatus({'lastPolledAt': 1, 'cadenceMs': 300000}),
      'Read every 5 min',
    );
    expect(cadence(86400000), 'once a day');
  });

  test('settings has the web four tabs', () {
    expect(settingsCategories, [
      'Models & sources',
      'Devices',
      'Notifications',
      'About',
    ]);
  });

  test('the members add a face and open it', () async {
    final g = FaceGateway();
    final rooms = RoomsController(g);
    final id = await rooms.createFace('Ops');
    expect(id, 'face_new');
    expect(g.requests.single.$3, {'name': 'Ops'});
    expect(g.saved.single['id'], 'face_new');
  });
}
