import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/app_document_route.dart';

const _root = 'https://pirc.example/apps/pirc/';

NativeAppDocumentRoute? _parse(String suffix, {String root = _root}) =>
    NativeAppDocumentRoute.parse(
      'https://pirc.example$suffix',
      appRootUrl: root,
    );

void main() {
  group('nativePircReplaceRouteQuery', () {
    test(
      'keeps an index alias origin and path, replacing query and fragment',
      () {
        expect(
          nativePircReplaceRouteQuery(
            'https://pirc.example/apps/pirc/index.html?open=schedules#cron-1',
            key: 'session',
            value: 'session-1',
          ),
          'https://pirc.example/apps/pirc/index.html?session=session-1',
        );
      },
    );

    test('keeps a deep path and explicit origin port', () {
      expect(
        nativePircReplaceRouteQuery(
          'http://gateway.example:8080/prefix/schedules/nightly?old=1#anchor',
          key: 'workspace',
          value: 'team-1',
        ),
        'http://gateway.example:8080/prefix/schedules/nightly?workspace=team-1',
      );
    });

    test('uses encodeURIComponent UTF-8 and its exact unescaped punctuation', () {
      expect(
        nativePircReplaceRouteQuery(
          'https://pirc.example/apps/pirc/deep?old=value#fragment',
          key: 'session',
          value: "é 中 !*'()~ -_./:@+\$,&=?#🚀",
        ),
        "https://pirc.example/apps/pirc/deep?session=%C3%A9%20%E4%B8%AD%20!*'()~%20-_.%2F%3A%40%2B%24%2C%26%3D%3F%23%F0%9F%9A%80",
      );
    });

    test('accepts an empty previous query and drops its fragment', () {
      expect(
        nativePircReplaceRouteQuery(
          'https://pirc.example/?#old',
          key: 'session',
          value: '',
        ),
        'https://pirc.example/?session=',
      );
    });

    test('rejects non-HTTP URLs and malformed UTF-16 values', () {
      expect(
        () => nativePircReplaceRouteQuery(
          'file:///apps/pirc/index.html',
          key: 'session',
          value: 'session-1',
        ),
        throwsFormatException,
      );
      expect(
        () => nativePircReplaceRouteQuery(
          'not a URL',
          key: 'session',
          value: 'session-1',
        ),
        throwsFormatException,
      );
      expect(
        () => nativePircReplaceRouteQuery(
          'https://pirc.example/apps/pirc/',
          key: 'session',
          value: '\ud800',
        ),
        throwsFormatException,
      );
    });
  });

  group('NativeAppDocumentRoute.parse', () {
    test('selects a session before open targets and keeps workspace separate', () {
      final route = _parse(
        '/apps/pirc/?session=s%2B1&session=second&open=schedules&schedule=cron-1&workspace=project%3Aone&workspace=second&trace=a%2Fb#part%2Fone',
      )!;

      expect(route.target, isA<NativeAppSessionRouteTarget>());
      expect((route.target! as NativeAppSessionRouteTarget).sessionId, 's+1');
      expect(route.workspaceId, 'project:one');
      expect(route.workspaceOverridesTarget, isTrue);
      expect(route.hasSessionParameter, isTrue);
      expect(route.isIndexAlias, isFalse);
      expect(
        route.rawQuery,
        'session=s%2B1&session=second&open=schedules&schedule=cron-1&workspace=project%3Aone&workspace=second&trace=a%2Fb',
      );
      expect(route.rawFragment, 'part%2Fone');
      expect(route.canonicalUrl, contains('#part%2Fone'));
      expect(route.queryParameters, hasLength(7));
      expect(
        route.queryParameters
            .where((parameter) => parameter.name == 'session')
            .map((parameter) => parameter.value),
        ['s+1', 'second'],
      );
      expect(route.unknownQueryParameters, hasLength(1));
      expect(route.unknownQueryParameters.single.name, 'trace');
      expect(route.unknownQueryParameters.single.value, 'a/b');
      expect(route.unknownQueryParameters.single.rawValue, 'a%2Fb');
    });

    test(
      'routes open schedules and memory targets from first query values',
      () {
        final schedules = _parse(
          '/apps/pirc/?open=schedules&schedule=s%209&schedule=second',
        )!;
        expect(schedules.target, isA<NativeAppSchedulesRouteTarget>());
        expect(
          (schedules.target! as NativeAppSchedulesRouteTarget).scheduleId,
          's 9',
        );
        expect(schedules.workspaceId, isNull);

        final memory = _parse(
          '/apps/pirc/?open=memory&workspace=workspace-1&schedule=ignored',
        )!;
        expect(memory.target, isA<NativeAppMemoryRouteTarget>());
        expect(memory.workspaceId, 'workspace-1');
        expect(memory.workspaceOverridesTarget, isTrue);
      },
    );

    test('empty first IDs fall through exactly as the web app does', () {
      final route = _parse(
        '/apps/pirc/?session=&session=late&open=schedules&schedule=&schedule=late&workspace=&workspace=late',
      )!;

      expect(route.target, isA<NativeAppSchedulesRouteTarget>());
      expect(
        (route.target! as NativeAppSchedulesRouteTarget).scheduleId,
        isNull,
      );
      expect(route.workspaceId, isNull);
      expect(route.hasSessionParameter, isTrue);
      expect(route.queryParameters.map((parameter) => parameter.value), [
        '',
        'late',
        'schedules',
        '',
        'late',
        '',
        'late',
      ]);
    });

    test('unsupported open values and unrelated queries remain metadata', () {
      final route = _parse(
        '/apps/pirc/?open=other&open=memory&mode=first+value&mode=second#',
      )!;

      expect(route.target, isNull);
      expect(route.hasSessionParameter, isFalse);
      expect(route.rawFragment, '');
      expect(route.hasQuery, isTrue);
      expect(route.unknownQueryParameters, hasLength(2));
      expect(route.unknownQueryParameters.first.value, 'first value');
      expect(route.unknownQueryParameters.last.value, 'second');
    });

    test('query decoding matches URLSearchParams malformed-input behavior', () {
      final route = _parse(
        '/apps/pirc/?badEscape=a%2Gz&trailing=100%&badUtf8=%E0%A4%A&singleByte=%FF',
      )!;
      final values = {
        for (final parameter in route.queryParameters)
          parameter.name: parameter.value,
      };

      expect(values['badEscape'], 'a%2Gz');
      expect(values['trailing'], '100%');
      expect(values['badUtf8'], '\uFFFD%A');
      expect(values['singleByte'], '\uFFFD');
    });

    test('selection validates loaded IDs and mirrors page/list precedence', () {
      final sessions = <Map<String, dynamic>>[
        {'id': 'first'},
        {'id': 'known'},
      ];
      final workspaces = <Map<String, dynamic>>[
        {'id': 'workspace-1'},
      ];

      final linkedSession = _parse(
        '/apps/pirc/?session=known',
      )!.resolve(sessions: sessions, workspaces: workspaces, phone: true);
      expect(linkedSession.sessionId, 'known');
      expect(linkedSession.workspaceId, isNull);
      expect(linkedSession.listOpen, isFalse);

      final missingSession = _parse(
        '/apps/pirc/?session=missing&workspace=missing',
      )!.resolve(sessions: sessions, workspaces: workspaces, phone: true);
      expect(missingSession.sessionId, 'first');
      expect(missingSession.workspaceId, isNull);
      expect(missingSession.listOpen, isFalse);

      final schedulesBehindWorkspace = _parse(
        '/apps/pirc/?open=schedules&schedule=cron-1&workspace=workspace-1',
      )!.resolve(sessions: sessions, workspaces: workspaces, phone: true);
      expect(schedulesBehindWorkspace.sessionId, 'first');
      expect(schedulesBehindWorkspace.workspaceId, 'workspace-1');
      expect(schedulesBehindWorkspace.showSchedules, isFalse);
      expect(schedulesBehindWorkspace.scheduleId, 'cron-1');
      expect(schedulesBehindWorkspace.listOpen, isFalse);

      final schedules = _parse(
        '/apps/pirc/?open=schedules&schedule=cron-2',
      )!.resolve(sessions: sessions, workspaces: workspaces, phone: true);
      expect(schedules.showSchedules, isTrue);
      expect(schedules.scheduleId, 'cron-2');
      expect(schedules.listOpen, isFalse);

      final phoneDefault = _parse(
        '/apps/pirc/',
      )!.resolve(sessions: sessions, workspaces: workspaces, phone: true);
      expect(phoneDefault.sessionId, 'first');
      expect(phoneDefault.listOpen, isTrue);

      final desktopDefault = _parse(
        '/apps/pirc/',
      )!.resolve(sessions: sessions, workspaces: workspaces, phone: false);
      expect(desktopDefault.sessionId, 'first');
      expect(desktopDefault.listOpen, isFalse);

      final emptySessionParameter = _parse(
        '/apps/pirc/?session=',
      )!.resolve(sessions: sessions, workspaces: workspaces, phone: true);
      expect(emptySessionParameter.sessionId, 'first');
      expect(emptySessionParameter.listOpen, isFalse);
    });

    test('memory remains an overlay when workspace is also selected', () {
      final route = _parse('/apps/pirc/?open=memory&workspace=workspace-1')!;
      final selection = route.resolve(
        sessions: const [],
        workspaces: <Map<String, dynamic>>[
          {'id': 'workspace-1'},
        ],
        phone: true,
      );

      expect(selection.showMemory, isTrue);
      expect(selection.workspaceId, 'workspace-1');
      expect(selection.showSchedules, isFalse);
      expect(selection.listOpen, isFalse);

      final memoryWithoutWorkspace = _parse(
        '/apps/pirc/?open=memory',
      )!.resolve(sessions: const [], workspaces: const [], phone: true);
      expect(memoryWithoutWorkspace.showMemory, isTrue);
      expect(memoryWithoutWorkspace.listOpen, isTrue);
    });

    test('accepts only the configured root and its index.html alias', () {
      final root = _parse('/apps/pirc/?open=memory');
      final index = _parse('/apps/pirc/index.html?open=memory');

      expect(root, isNotNull);
      expect(root!.isIndexAlias, isFalse);
      expect(root.isSpaFallbackPath, isFalse);
      expect(index, isNotNull);
      expect(index!.isIndexAlias, isTrue);
      expect(index.isSpaFallbackPath, isFalse);
      expect(_parse('/apps/pirc/index.php?session=s1'), isNull);
      expect(_parse('/apps/pirc/other?session=s1'), isNull);
      expect(_parse('/api/sessions?session=s1'), isNull);
      expect(_parse('/apps/pirc//?session=s1'), isNull);
    });

    test('deep SPA fallback requires opt-in and excludes API/foreign paths', () {
      const deepUrl =
          'https://pirc.example/apps/pirc/schedules/weekly?open=schedules#week';
      expect(NativeAppDocumentRoute.parse(deepUrl, appRootUrl: _root), isNull);

      final deep = NativeAppDocumentRoute.parse(
        deepUrl,
        appRootUrl: _root,
        allowSpaFallback: true,
      )!;
      expect(deep.isSpaFallbackPath, isTrue);
      expect(deep.isIndexAlias, isFalse);
      expect(deep.canonicalUrl, deepUrl);
      expect(deep.rawQuery, 'open=schedules');
      expect(deep.rawFragment, 'week');
      expect(deep.target, isA<NativeAppSchedulesRouteTarget>());

      expect(
        NativeAppDocumentRoute.parse(
          'https://pirc.example/apps/pirc/api',
          appRootUrl: _root,
          allowSpaFallback: true,
        ),
        isNull,
      );
      expect(
        NativeAppDocumentRoute.parse(
          'https://pirc.example/apps/pirc/api/sessions',
          appRootUrl: _root,
          allowSpaFallback: true,
        ),
        isNull,
      );
      expect(
        NativeAppDocumentRoute.parse(
          'https://pirc.example/apps/pirc/%61pi/sessions',
          appRootUrl: _root,
          allowSpaFallback: true,
        ),
        isNull,
      );
      expect(
        NativeAppDocumentRoute.parse(
          'https://pirc.example/apps/pirc/apiary/page',
          appRootUrl: _root,
          allowSpaFallback: true,
        )!.isSpaFallbackPath,
        isTrue,
      );
      expect(
        NativeAppDocumentRoute.parse(
          'https://other.example/apps/pirc/schedules',
          appRootUrl: _root,
          allowSpaFallback: true,
        ),
        isNull,
      );
      expect(
        NativeAppDocumentRoute.parse(
          'https://pirc.example/apps/pircevil/schedules',
          appRootUrl: _root,
          allowSpaFallback: true,
        ),
        isNull,
      );
    });

    test('rejects foreign origin, scheme, port, and invalid root URL', () {
      expect(
        NativeAppDocumentRoute.parse(
          'https://other.example/apps/pirc/?open=memory',
          appRootUrl: _root,
        ),
        isNull,
      );
      expect(
        NativeAppDocumentRoute.parse(
          'http://pirc.example/apps/pirc/?open=memory',
          appRootUrl: _root,
        ),
        isNull,
      );
      expect(
        NativeAppDocumentRoute.parse(
          'https://pirc.example:8443/apps/pirc/?open=memory',
          appRootUrl: _root,
        ),
        isNull,
      );
      expect(
        NativeAppDocumentRoute.parse(
          'https://pirc.example/apps/pirc/?open=memory',
          appRootUrl: 'https://pirc.example/apps/pirc/?wrong=1',
        ),
        isNull,
      );
      expect(
        NativeAppDocumentRoute.parse(
          'file:///apps/pirc/?open=memory',
          appRootUrl: _root,
        ),
        isNull,
      );
    });
  });
}
