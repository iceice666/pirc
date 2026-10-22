import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/app.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/mobile_tabs.dart';
import 'package:pirc_mobile/live/rooms_page.dart';
import 'package:pirc_mobile/live/rooms_state.dart';
import 'live_test.dart' show FakeGateway, theme;

const me = 'me@example.com';

Json room(
  String id, {
  int unread = 0,
  bool waiting = false,
  String kind = 'topic',
}) => {
  'id': id,
  'name': id,
  'kind': kind,
  'createdAt': 1,
  'archivedAt': null,
  'lastActivityAt': 1,
  'lastSeq': 3,
  'readSeq': 3 - unread,
  'unread': unread,
  'waiting': waiting,
};

Json message(String id, int seq, String text, {String speaker = 'face:host'}) =>
    {
      'id': id,
      'roomId': 'general',
      'seq': seq,
      'speaker': speaker,
      'user': speaker == 'user' ? me : null,
      'kind': 'text',
      'body': {'text': text},
      'threadId': null,
      'createdAt': seq,
      'editedAt': null,
      'pinnedAt': null,
    };

/// A gateway whose native rooms runtime answers with [view] and records drafts.
class RoomsGateway extends FakeGateway {
  Json view = {
    'user': me,
    'currentId': 'general',
    'current': room('general', kind: 'general'),
    'rooms': [
      room('slime', unread: 2, waiting: true),
      room('general', kind: 'general'),
    ],
    'messages': [
      message('m1', 1, 'Good morning'),
      message('m2', 2, 'Hi', speaker: 'user'),
    ],
    'pinned': [],
    'hasMore': false,
    'loading': false,
    'opening': false,
    'connection': 'connected',
    'typing': {
      'general': {'other@example.com': 9999999999999, me: 9999999999999},
    },
    'thinking': {
      'general': ['host'],
    },
    'faces': [
      {'id': 'host', 'name': 'pirc', 'isHost': true, 'territory': {}},
    ],
    'facePresence': {},
    'threadMessages': [],
    'threadWorkers': [],
    'threadActivity': {},
  };
  final roomDrafts = <String, String>{};

  void publishRooms() =>
      stream.add({'type': 'rooms', 'scope': 'rooms', 'data': view});

  @override
  dynamic normal(String method, Json args) {
    switch (method) {
      case 'roomsStart':
        return view;
      case 'roomDraft':
        return roomDrafts[args['roomId']] ?? '';
      case 'saveRoomDraft':
        roomDrafts['${args['roomId']}'] = '${args['text']}';
        return null;
      case 'roomsOpen':
        view = {
          ...view,
          'currentId': args['roomId'],
          'current': room('${args['roomId']}'),
          'messages': [],
        };
        publishRooms();
        return null;
      case 'roomsSend':
      case 'roomsTyping':
      case 'roomsVisible':
      case 'roomsOpenThread':
      case 'roomsCloseThread':
        return null;
    }
    return super.normal(method, args);
  }

  int count(String method) => calls.where((call) => call.$1 == method).length;
}

Future<RoomsGateway> pumpRooms(WidgetTester t, {double width = 390}) async {
  t.view.devicePixelRatio = 1;
  t.view.physicalSize = Size(width, 844);
  addTearDown(t.view.reset);
  final g = RoomsGateway();
  final c = LiveController(g);
  await t.pumpWidget(MobileApp(theme: theme, controller: c));
  await t.pumpAndSettle();
  return g;
}

void main() {
  test('a snapshot says who types, who thinks and where a face waits', () {
    final rooms = RoomsController(RoomsGateway());
    rooms.apply(RoomsGateway().view);
    expect(rooms.typingIn('general', 0), ['other@example.com']);
    expect(rooms.typingIn('general', 9999999999999), isEmpty);
    expect(rooms.thinkingIn('general'), ['pirc']);
    expect(rooms.waitingCount, 1);
    expect(rooms.speakerName(message('x', 1, 'x')), 'pirc');
    expect(rooms.speakerName(message('x', 1, 'x', speaker: 'user')), me);
    expect(rooms.hereIn('general'), 'pirc');
    rooms.dispose();
  });

  test('presence reads like the web', () {
    expect(presenceLabel(null), 'Here');
    expect(presenceLabel({'state': 'thinking'}), 'Thinking');
    expect(
      presenceLabel({'state': 'working', 'line': 'Fix lint'}),
      'Working on Fix lint',
    );
    expect(presenceLabel({'state': 'waiting'}), 'Waiting for you');
    expect(initialOf('pirc'), 'P');
    expect(initialOf('pirc', '🤖'), '🤖');
    expect(hueOf('pirc'), hueOf('pirc'));
  });

  testWidgets('the app opens on the rooms, with unread and your turn', (
    t,
  ) async {
    final g = await pumpRooms(t);
    expect(find.byType(RoomsPage), findsOneWidget);
    expect(g.count('roomsStart'), 1);
    expect(find.text('Your turn'), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp('2 unread')), findsOneWidget);
    final tabs = t.widget<MobileTabs>(find.byType(MobileTabs));
    expect(tabs.tabs.map((tab) => tab.id), [
      'rooms',
      'members',
      'engine',
      'settings',
    ]);
    expect(tabs.tabs.first.badge, 1);
  });

  testWidgets('a room shows its messages, typing and thinking', (t) async {
    final g = await pumpRooms(t);
    await t.tap(find.text('general'));
    await t.pumpAndSettle();
    expect(g.count('roomsVisible'), greaterThan(0));
    expect(find.text('Good morning'), findsOneWidget);
    expect(find.text('Hi'), findsOneWidget);
    expect(find.textContaining('other@example.com is typing'), findsOneWidget);
    expect(find.textContaining('pirc is thinking'), findsOneWidget);
    // The phone's room has a back arrow instead of the tabs.
    expect(find.byType(MobileTabs), findsNothing);
    await t.tap(find.byTooltip('Rooms'));
    await t.pumpAndSettle();
    expect(find.byType(MobileTabs), findsOneWidget);
  });

  testWidgets('sending clears the composer; a long press sends now', (t) async {
    final g = await pumpRooms(t);
    await t.tap(find.text('general'));
    await t.pumpAndSettle();
    await t.enterText(find.byType(TextField), 'CI 又紅了');
    await t.pump(const Duration(milliseconds: 500));
    expect(g.roomDrafts['general'], 'CI 又紅了');
    expect(g.count('roomsTyping'), 1);
    await t.tap(find.bySemanticsLabel('Send'));
    await t.pumpAndSettle();
    final sent = g.calls.lastWhere((call) => call.$1 == 'roomsSend').$2;
    expect(sent['text'], 'CI 又紅了');
    expect(sent['immediate'], false);
    expect(t.widget<TextField>(find.byType(TextField)).controller!.text, '');
    expect(g.roomDrafts['general'], '');
    await t.enterText(find.byType(TextField), '現在就看');
    await t.pump();
    await t.longPress(find.bySemanticsLabel('Send'));
    await t.pumpAndSettle();
    final now = g.calls.lastWhere((call) => call.$1 == 'roomsSend').$2;
    expect(now['text'], '現在就看');
    expect(now['immediate'], true);
  });

  testWidgets('each room keeps its own draft', (t) async {
    final g = await pumpRooms(t);
    g.roomDrafts['slime'] = 'slime draft';
    await t.tap(find.text('general'));
    await t.pumpAndSettle();
    await t.enterText(find.byType(TextField), 'general draft');
    await t.tap(find.byTooltip('Rooms'));
    await t.pumpAndSettle();
    await t.tap(find.text('slime'));
    await t.pumpAndSettle();
    expect(g.roomDrafts['general'], 'general draft');
    expect(
      t.widget<TextField>(find.byType(TextField)).controller!.text,
      'slime draft',
    );
  });

  testWidgets('the engine tab leaves the rooms and comes back', (t) async {
    final g = await pumpRooms(t);
    final c = t.widget<MobileApp>(find.byType(MobileApp)).controller;
    await t.tap(find.text('Engine'));
    await t.pumpAndSettle();
    expect(c.showing, 'engine');
    expect(find.byType(RoomsPage), findsNothing);
    expect(g.calls.last.$1 != 'roomsStart', isTrue);
    await t.tap(find.text('Rooms'));
    await t.pumpAndSettle();
    expect(c.showing, 'rooms');
    expect(find.byType(RoomsPage), findsOneWidget);
    // Started once: coming back only shows them again.
    expect(g.count('roomsStart'), 1);
  });

  testWidgets('a wide screen shows the list, the room and the members', (
    t,
  ) async {
    await pumpRooms(t, width: 1024);
    expect(find.byType(MobileTabs), findsNothing);
    expect(find.text('Good morning'), findsOneWidget);
    expect(find.text('Engine'), findsOneWidget);
    await t.tap(find.byTooltip('Members'));
    await t.pumpAndSettle();
    expect(find.text('pirc (host)'), findsOneWidget);
    expect(find.text('Here'), findsOneWidget);
  });
}
