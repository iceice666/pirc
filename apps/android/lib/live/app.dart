import 'dart:async';
import 'dart:math';
import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart' show defaultTargetPlatform, kIsWeb;
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../theme.dart';
import 'gateway.dart';
import 'common.dart';
import 'panels.dart';
import 'settings.dart';
import 'settings_dialog.dart';
import 'permissions.dart';
import 'pairing_scanner.dart';
import 'mobile_tabs.dart';
import 'rooms_page.dart';
import 'engine_overview.dart';
import 'session_sidebar.dart';
import 'workspace_page.dart';

import 'session_view.dart';
import 'conversation_empty.dart';
import 'side_panel.dart';
import 'document_navigation_state.dart';
import 'document_navigation.dart';
import 'app_document_route.dart';
import 'scoped_gateway.dart';
import 'native_app_surface.dart';

class MobileApp extends StatelessWidget {
  const MobileApp({super.key, required this.theme, required this.controller});
  final PircTheme theme;
  final LiveController controller;
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (context, _) => MaterialApp(
      title: 'pirc',
      builder: (context, child) => AnnotatedRegion<SystemUiOverlayStyle>(
        value: Theme.of(context).brightness == Brightness.dark
            ? SystemUiOverlayStyle.light
            : SystemUiOverlayStyle.dark,
        child: child ?? const SizedBox(),
      ),
      themeMode: switch (controller.preferences['appearance']) {
        'light' => ThemeMode.light,
        'dark' => ThemeMode.dark,
        _ => ThemeMode.system,
      },
      debugShowCheckedModeBanner: false,
      theme: theme.build(Brightness.light),
      darkTheme: theme.build(Brightness.dark),
      home: LiveShell(controller: controller, theme: theme),
    ),
  );
}

class LiveShell extends StatefulWidget {
  const LiveShell({
    super.key,
    required this.controller,
    required this.theme,
    this.documentWindows,
    this.documentWindow,
    this.initialRoute,
    this.onBooted,
  });
  final LiveController controller;
  final PircTheme theme;
  final NativeDocumentWindows? documentWindows;
  final NativeDocumentWindow? documentWindow;
  final NativeAppDocumentRoute? initialRoute;
  final VoidCallback? onBooted;
  @override
  State<LiveShell> createState() => _LiveShellState();
}

class _AppDocumentViewSnapshot {
  const _AppDocumentViewSnapshot({
    required this.url,
    required this.surfaceIdentity,
    required this.surfaceOwner,
    required this.sessionId,
    required this.section,
    required this.listOpen,
    required this.panelOpen,
    required this.panelKind,
    required this.panelWidth,
    required this.sidebarCollapsed,
    required this.scrollOffset,
  });
  final Object surfaceIdentity, surfaceOwner;
  final String? url, sessionId, section, panelKind;
  final bool listOpen, panelOpen, sidebarCollapsed;
  final double panelWidth, scrollOffset;
}

class _LiveShellState extends State<LiveShell> with WidgetsBindingObserver {
  final _documentHost = GlobalKey<NativeDocumentHostState>();
  final _appSurface = GlobalKey<NativeAppSurfaceState>();
  final _surfaceOwner = Object();
  Object _appSurfaceIdentity = Object();
  LiveController get c => widget.controller;
  late final _documents =
      widget.documentWindows ??
      NativeDocumentWindows(
        c.gateway,
        owner: c,
        onAppRoute: _openDocumentAppRoute,
        appBuilder: _buildIndependentApp,
        captureAppState: _captureDocumentAppState,
        appCanPop: () => _appSurface.currentState?.canPop ?? false,
        restoreAppState: _restoreDocumentAppState,
        appDocumentUrl: () => _currentDocumentUrl,
        appNavigationIdentity: () =>
            (_documentRouteTicket, c.sessionNavigationRevision),
      );

  Widget _buildIndependentApp(NativeDocumentWindow window) =>
      _IndependentAppWindow(
        key: ValueKey(('app-context', window.id)),
        window: window,
        windows: _documents,
        transport: c.gateway,
        theme: widget.theme,
      );

  Future<void> _bootView() async {
    try {
      if (c.gateway is DartScopedGateway) {
        await (c.gateway as DartScopedGateway).ensureContext();
      }
      await c.boot();
      if (!mounted) return;
      if (widget.initialRoute != null) {
        await _openDocumentAppRoute(widget.initialRoute!);
        widget.documentWindow?.captureCurrentAppState();
      }
    } finally {
      widget.onBooted?.call();
    }
  }

  int _documentRouteTicket = 0;
  String? _documentRouteUrl;
  bool _documentRouting = false;
  bool _inTree = true;

  String? get _currentDocumentUrl => c.origin == null
      ? null
      : _documentRouteUrl ??
            '${c.origin}/${section?.startsWith('workspace:') == true
                ? '?workspace=${enc(section!.substring('workspace:'.length))}'
                : c.sessionId != null
                ? '?session=${enc(c.sessionId!)}'
                : ''}';

  Object _captureDocumentAppState() => _AppDocumentViewSnapshot(
    url: _currentDocumentUrl,
    surfaceIdentity: _appSurfaceIdentity,
    surfaceOwner: _surfaceOwner,
    sessionId: c.sessionId,
    section: section,
    listOpen: listOpen,
    panelOpen: panelOpen,
    panelKind: panelKind,
    panelWidth: panelWidth,
    sidebarCollapsed: sidebarCollapsed,
    scrollOffset: 0,
  );

  Future<void> _restoreDocumentAppState(Object value) =>
      guarded(context, () async {
        if (value is! _AppDocumentViewSnapshot ||
            !mounted ||
            value.surfaceOwner != _surfaceOwner) {
          return;
        }
        final ticket = ++_documentRouteTicket;
        final account = _documents.accountIdentity;
        bool current() =>
            mounted &&
            ticket == _documentRouteTicket &&
            account == _documents.accountIdentity;
        _documentRouting = true;
        try {
          await c.flushDraft();
          if (!current()) return;
          if (value.sessionId != c.sessionId) {
            if (value.sessionId == null) {
              await c.home();
            } else {
              await c.open(value.sessionId!, reveal: false);
            }
          }
          if (!current() || value.sessionId != c.sessionId) return;
          setState(() {
            _appSurfaceIdentity = value.surfaceIdentity;
            _documentRouteUrl = value.url;
            section = value.section;
            listOpen = value.listOpen;
            panelOpen = value.panelOpen;
            panelKind = value.panelKind;
            panelWidth = value.panelWidth;
            sidebarCollapsed = value.sidebarCollapsed;
          });
          if (value.panelOpen && value.sessionId != null) {
            _panel(value.panelKind ?? 'files', remember: false);
          }
        } finally {
          if (ticket == _documentRouteTicket) {
            _documentRouting = false;
            if (mounted) _update();
          }
        }
      });

  void _replaceDocumentAddress(String key, String id) {
    final current = _currentDocumentUrl;
    if (current != null) {
      _documentRouteUrl = nativePircReplaceRouteQuery(
        current,
        key: key,
        value: id,
      );
    }
  }

  Future<void> _openDocumentAppRoute(NativeAppDocumentRoute route) =>
      guarded(context, () => _applyDocumentAppRoute(route));

  Future<void> _applyDocumentAppRoute(NativeAppDocumentRoute route) async {
    if (!mounted || !_inTree || c.origin == null) return;
    final ticket = ++_documentRouteTicket;
    final identity = _documents.accountIdentity;
    final navigation = c.sessionNavigationRevision;
    bool current() =>
        mounted &&
        _inTree &&
        ticket == _documentRouteTicket &&
        identity == _documents.accountIdentity;
    _documentRouting = true;
    try {
      // A room or the engine: their own pages, not the session list.
      final target = route.target;
      if (target is NativeAppRoomRouteTarget) {
        c.showRooms(roomId: target.roomId);
        return;
      }
      if (target is NativeAppEngineRouteTarget) {
        c.showEngine(section: target.section);
        return;
      }
      if (target is NativeAppSessionRouteTarget && c.showing != 'engine') {
        c.showEngine();
      }
      await c.flushDraft();
      if (!current() || navigation != c.sessionNavigationRevision) return;
      await c.refreshList();
      if (!mounted || !current() || navigation != c.sessionNavigationRevision) {
        return;
      }
      final selection = route.resolve(
        sessions: c.sessions,
        workspaces: c.workspaces,
        phone: MediaQuery.sizeOf(context).width <= 650,
      );
      if (selection.sessionId != null) {
        await c.open(selection.sessionId!, reveal: false);
        if (!current() || c.sessionId != selection.sessionId) return;
      } else if (c.sessionId != null) {
        await c.home();
        if (!current() || c.sessionId != null) return;
      }
      setState(() {
        final window = widget.documentWindow ?? _documents.active;
        _appSurfaceIdentity = window?.current ?? Object();
        _documentRouteUrl =
            selection.workspaceId == null && selection.sessionId != null
            ? nativePircReplaceRouteQuery(
                route.canonicalUrl,
                key: 'session',
                value: selection.sessionId!,
              )
            : route.canonicalUrl;
        section = selection.workspaceId != null
            ? 'workspace:${selection.workspaceId}'
            : null;
        listOpen = selection.listOpen;
        if (section != null) panelOpen = false;
      });
      _update();
      if (selection.showMemory && current()) {
        _page('memory', documentRoute: true);
      }
    } finally {
      if (ticket == _documentRouteTicket) {
        _documentRouting = false;
        if (mounted) _update();
      }
    }
  }

  final scaffold = GlobalKey<ScaffoldState>();
  final paneKey = GlobalKey();
  final sidebarKey = GlobalKey();
  final panelCache = <String, Widget>{};
  final panelCounts = <String, int>{};
  final paneHistory = <Widget>[];
  final search = TextEditingController();
  Widget? pane;
  String? seenSession;
  String? panelKind;
  bool panelOpen = false, layoutLoaded = false;
  bool settingsOpen = false;
  double panelWidth = 360;
  final panelToggleFocus = FocusNode();
  Timer? resizeSave, countRefresh;
  StreamSubscription<Json>? panelEvents;
  String? seenOrigin, seenClient, previousRun;
  Future<void> layoutWrite = Future.value();
  bool listOpen = true;
  bool sidebarCollapsed = false;
  bool? phoneLayout;
  String? section;
  bool _platformVisible = true;
  int seenNavigationRevision = 0;
  @override
  void initState() {
    super.initState();
    final documentWindow = widget.documentWindow;
    if (documentWindow != null) {
      documentWindow.captureAppState = _captureDocumentAppState;
      documentWindow.appCanPop = () =>
          _appSurface.currentState?.canPop ?? false;
      documentWindow.restoreAppState = _restoreDocumentAppState;
      documentWindow.onAppRoute = _openDocumentAppRoute;
      documentWindow.appNavigationIdentity = () =>
          (_documentRouteTicket, c.sessionNavigationRevision);
      documentWindow.appDocumentUrl = () => _currentDocumentUrl;
      documentWindow.beforeClose = c.flushDraft;
    }
    WidgetsBinding.instance.addObserver(this);
    c.addListener(_update);
    c.panelData.addListener(_syncPanelCounts);
    panelEvents = c.gateway.events.listen((event) {
      if (event['sessionId'] == c.sessionId && event['type'] == 'panelChange') {
        countRefresh?.cancel();
        countRefresh = Timer(
          const Duration(milliseconds: 150),
          () => unawaited(_panelCounts()),
        );
      }
    });
    unawaited(_bootView());
  }

  void _update() {
    if (!mounted || !_inTree) return;
    // A room line's "Details" (or a link) asked for an engine section.
    final asked = c.engineSection;
    if (asked != null && c.showing == 'engine' && c.origin != null) {
      c.engineSection = null;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _page('overview:$asked');
      });
    }
    if (!c.booting && !layoutLoaded) {
      layoutLoaded = true;
      sidebarCollapsed = c.preferences['sidebarCollapsed'] == true;
      panelWidth = (c.preferences['panelWidth'] as num?)?.toDouble() ?? 360;
      panelOpen =
          MediaQuery.sizeOf(context).width > 860 &&
          c.preferences['detailsOpen'] == true;
    }
    if (seenNavigationRevision != c.sessionNavigationRevision) {
      seenNavigationRevision = c.sessionNavigationRevision;
      if (c.sessionId == null) {
        listOpen = true;
        section = null;
        panelOpen = false;
      }
      if (c.revealSelectedSession) {
        _documentRouteTicket++;
        if (c.sessionId != null) {
          _replaceDocumentAddress('session', c.sessionId!);
        }
        _documentRouting = false;
        listOpen = false;
        section = null;
      }
    }
    if (seenSession != c.sessionId ||
        seenOrigin != c.origin ||
        seenClient != c.clientId) {
      if (seenOrigin != c.origin || seenClient != c.clientId) {
        panelKind = null;
        _documentRouteTicket++;
        _documentRouting = false;
        _documentRouteUrl = null;
      }
      pane = null;
      panelCounts.clear();
      panelCache.clear();
      paneHistory.clear();
      seenOrigin = c.origin;
      seenClient = c.clientId;
      seenSession = c.sessionId;
    }
    c.sessionVisible =
        c.active &&
        !_documentRouting &&
        !c.booting &&
        !c.initializing &&
        c.state.isNotEmpty &&
        c.onboardingComplete &&
        c.pairLink == null &&
        c.routePage == null &&
        section == null &&
        (MediaQuery.sizeOf(context).width > 650 || !listOpen);
    if (c.sessionVisible) unawaited(c.markVisibleRead());
    if (panelKind != null && !c.sessionPanel(panelKind!)) {
      panelKind = 'files';
      pane = null;
    }
    if (c.sessionId != null && panelOpen && pane == null) {
      _panel(panelKind ?? 'files', remember: false);
    }
    final run = obj(c.state['run'])['status'] as String?;
    if (previousRun == 'running' && run != 'running') unawaited(_panelCounts());
    previousRun = run;
    if (c.routePage != null &&
        c.origin != null &&
        !c.initializing &&
        c.onboardingComplete) {
      final route = c.routePage!;
      c.routePage = null;
      final account = _documents.accountIdentity;
      final removalNavigation = c.sessionNavigationRevision;
      WidgetsBinding.instance.addPostFrameCallback((_) async {
        if (!mounted || account != _documents.accountIdentity) return;
        if (widget.documentWindow == null) {
          await _documentHost.currentState?.selectWindow(null);
        }
        await WidgetsBinding.instance.endOfFrame;
        if (!mounted || account != _documents.accountIdentity) return;
        if (route.startsWith('workspace:')) {
          if (c.sessionId == null &&
              removalNavigation == c.sessionNavigationRevision) {
            _openWorkspace(route.substring(10));
          }
        } else {
          _page(route);
        }
      });
    }
    setState(() {});
  }

  @override
  void deactivate() {
    _inTree = false;
    super.deactivate();
  }

  @override
  void activate() {
    super.activate();
    _inTree = true;
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Both resumed and inactive retain a visible view; focus alone does not
    // change the Web document's visibility or require a second reconnection.
    final visible =
        state == AppLifecycleState.resumed ||
        state == AppLifecycleState.inactive;
    if (visible == _platformVisible) return;
    _platformVisible = visible;
    unawaited(c.lifecycle(visible));
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    if (widget.documentWindows == null) _documents.dispose();
    c.removeListener(_update);
    c.panelData.removeListener(_syncPanelCounts);
    if (widget.documentWindow == null) unawaited(c.flushDraft());
    if (resizeSave?.isActive == true) {
      _saveLayout({'panelWidth': panelWidth.round()});
    }
    c.dispose();
    resizeSave?.cancel();
    countRefresh?.cancel();
    unawaited(panelEvents?.cancel());
    panelToggleFocus.dispose();
    search.dispose();
    super.dispose();
  }

  void _page(String name, {bool documentRoute = false, bool deferred = false}) {
    final surface = _appSurface.currentState;
    final context = surface?.widget.activeIdentity == _appSurfaceIdentity
        ? surface?.ownedAppContext
        : null;
    if (context == null) {
      if (!deferred) {
        final account = _documents.accountIdentity;
        final identity = _appSurfaceIdentity;
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted &&
              account == _documents.accountIdentity &&
              identity == _appSurfaceIdentity) {
            _page(name, documentRoute: documentRoute, deferred: true);
          }
        });
      }
      return;
    }
    if (name == 'rooms') {
      c.showRooms();
      return;
    }
    if (name == 'overview' || name.startsWith('overview:')) {
      final section = name.startsWith('overview:')
          ? name.substring(9)
          : 'nodes';
      unawaited(
        Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) => EngineOverview(
              gateway: c.gateway,
              section: section,
              roomId: c.rooms.currentId,
              loopsRevision: c.rooms.loopsChanged,
              wakesRevision: c.rooms.wakesChanged,
            ),
          ),
        ),
      );
      return;
    }
    if (!documentRoute && name != 'settings' && name != 'memory') {
      _documentRouteTicket++;
      _documentRouting = false;
    }
    // What pirc keeps is on the engine's front page now.
    if (name == 'memory') {
      _page('overview:memory', documentRoute: documentRoute);
      return;
    }
    if (name == 'settings') {
      setState(() => settingsOpen = true);
      unawaited(
        showNativeSettings(
          context,
          controller: c,
          onOpenChat: _openSession,
          onResetLayout: () => setState(() {
            sidebarCollapsed = false;
            panelOpen = false;
            panelWidth = 360;
            resizeSave?.cancel();
            _saveLayout({
              'panelWidth': 360,
              'detailsOpen': false,
              'sidebarCollapsed': false,
            });
            paneHistory.clear();
          }),
          onAppOptions: () => Navigator.of(context).push(
            MaterialPageRoute<void>(
              builder: (_) => ManagementPage(
                kind: 'settings',
                onWindows: () {
                  final host =
                      _documentHost.currentState ??
                      NativeDocumentHost.maybeOf(context);
                  if (host != null) {
                    unawaited(
                      showNativeDocumentWindowManager(
                        context,
                        _documents,
                        host,
                      ),
                    );
                  }
                },
                controller: c,
                theme: widget.theme,
              ),
            ),
          ),
        ).whenComplete(() {
          if (mounted) setState(() => settingsOpen = false);
        }),
      );
      return;
    }
    if (name == 'activity') {
      showModalBottomSheet<void>(
        context: context,
        isScrollControlled: true,
        useSafeArea: true,
        builder: (_) => FractionallySizedBox(
          heightFactor: .85,
          child: Column(
            children: [
              const Padding(
                padding: EdgeInsets.fromLTRB(16, 0, 16, 16),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: Text(
                    '待處理與動態',
                    style: TextStyle(fontSize: 20, fontWeight: FontWeight.w600),
                  ),
                ),
              ),
              Expanded(
                child: ActivityPage(controller: c, theme: widget.theme),
              ),
            ],
          ),
        ),
      );
    } else {
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) =>
              ManagementPage(kind: name, controller: c, theme: widget.theme),
        ),
      );
    }
  }

  void _closePane() {
    setState(() {
      if (paneHistory.isNotEmpty) {
        pane = paneHistory.removeLast();
        return;
      }
      panelOpen = false;
      _rememberPanel();
      panelToggleFocus.requestFocus();
    });
  }

  void _saveLayout(Json changes) {
    layoutWrite = layoutWrite
        .then((_) => c.savePreferences(changes))
        .catchError((Object e) {
          if (mounted) {
            c.actionError = LiveController.describe(e);
            c.changed();
          }
        });
  }

  void _rememberPanel() {
    if (MediaQuery.sizeOf(context).width > 860) {
      _saveLayout({'detailsOpen': panelOpen});
    }
  }

  void _sidebarCollapsed(bool value) {
    setState(() => sidebarCollapsed = value);
    _saveLayout({'sidebarCollapsed': value});
  }

  void _syncPanelCounts() {
    final d = c.panelData.value;
    if (!mounted || !_inTree) return;
    setState(() {
      panelCounts['tasks'] = rows(
        d?['backgroundTasks'],
      ).where((t) => t['status'] == 'running').length;
      final phase = obj(d?['memoryRuntime'])['phase'];
      panelCounts['memory'] = phase != null && phase != '' ? 1 : 0;
    });
  }

  Future<void> _panelCounts() => c.panelData.refresh();

  void _panel(String kind, {String? path, bool remember = true}) {
    if (c.sessionId == null) return;
    if (!c.sessionPanel(kind)) kind = 'files';
    panelOpen = true;
    if (remember) _rememberPanel();
    unawaited(_panelCounts());
    setState(() {
      paneHistory.clear();
      panelKind = kind;
      if (path != null) panelCache.remove(kind);
      panelCache.putIfAbsent(
        kind,
        () => WorkPanel(
          key: GlobalKey(),
          controller: c,
          kind: kind,
          path: path,
          onFile: (path) => _panel('files', path: path),
          onOpen: (w) => setState(() {
            paneHistory.add(pane!);
            pane = w;
          }),
        ),
      );
      pane = IndexedStack(
        index: panelCache.keys.toList().indexOf(kind),
        children: panelCache.entries
            .map(
              (entry) =>
                  TickerMode(enabled: entry.key == kind, child: entry.value),
            )
            .toList(),
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    if (c.booting) {
      return const Scaffold(body: AppLoadingState());
    }
    if (!c.onboardingComplete) {
      return PermissionPage(
        gateway: c.gateway,
        onComplete: () async {
          c.onboardingComplete = true;
          c.changed();
        },
      );
    }
    if (c.origin == null || c.pairLink != null) {
      return PairingScreen(
        controller: c,
        onCancel: c.origin == null
            ? null
            : () {
                c.pairLink = null;
                c.changed();
              },
      );
    }
    final documentUrl = _currentDocumentUrl!;
    final Widget layout = c.showing == 'rooms' && widget.documentWindow == null
        ? RoomsPage(
            rooms: c.rooms,
            onEngine: c.showEngine,
            onSettings: () => _page('settings'),
            onDetails: (section) => c.showEngine(section: section),
          )
        : LayoutBuilder(
            builder: (context, size) {
              final phone = size.maxWidth <= 650;
              if (phoneLayout != phone) {
                phoneLayout = phone;
                WidgetsBinding.instance.addPostFrameCallback((_) {
                  if (mounted) _update();
                });
              }
              final sidebarWidth = size.maxWidth <= 860 ? 232.0 : 264.0;
              final overlay = size.maxWidth <= 860;
              final showList = phone && listOpen;
              final showTabs = phone && (listOpen || section != null);
              // The panes are the session's page: back leaves a pane opened
              // from another, then the session, not "the side panel".
              final canLeave =
                  paneHistory.isEmpty &&
                  (!phone || listOpen || c.sessionId == null) &&
                  section == null;
              return ListenableBuilder(
                listenable: _documents,
                builder: (context, _) {
                  final historyOwnsBack =
                      _documents.managedPresentation &&
                      (_documents.presented ||
                          _documents.active?.canBack == true);
                  return PopScope(
                    canPop: historyOwnsBack || canLeave,
                    onPopInvokedWithResult: (didPop, result) {
                      if (didPop || historyOwnsBack) return;
                      if (paneHistory.isNotEmpty) {
                        _closePane();
                      } else if (phone && listOpen && section != null) {
                        _closePhoneSidebar();
                      } else {
                        _showList();
                      }
                    },
                    child: Focus(
                      autofocus: true,
                      onKeyEvent: (_, event) {
                        if (event is KeyDownEvent &&
                            event.logicalKey == LogicalKeyboardKey.escape &&
                            listOpen &&
                            (ModalRoute.of(context)?.isCurrent ?? false)) {
                          _closePhoneSidebar();
                          return KeyEventResult.handled;
                        }
                        return KeyEventResult.ignored;
                      },
                      child: Scaffold(
                        key: scaffold,
                        bottomNavigationBar: showTabs
                            ? ListenableBuilder(
                                listenable: c.rooms,
                                builder: (context, _) => MobileTabs(
                                  tabs: [
                                    MobileTab(
                                      'rooms',
                                      badge: c.rooms.waitingCount,
                                    ),
                                    MobileTab(
                                      'engine',
                                      badge: c.attentionCount,
                                    ),
                                    const MobileTab('settings'),
                                  ],
                                  current: settingsOpen ? 'settings' : 'engine',
                                  onPick: (tab) {
                                    if (tab == 'rooms') {
                                      c.showRooms();
                                    } else if (tab == 'engine') {
                                      c.workspaceFilter = null;
                                      if (section != null) {
                                        // The Web app opens its phone sidebar over the
                                        // current page. Offstage keeps page/editor state
                                        // alive until navigation or drawer close.
                                        setState(() => listOpen = true);
                                      } else {
                                        _showList();
                                      }
                                    } else {
                                      _page(tab);
                                    }
                                  },
                                ),
                              )
                            : null,
                        body: SafeArea(
                          bottom: false,
                          child: Stack(
                            children: [
                              SafeArea(
                                top: false,
                                bottom: !showTabs,
                                child: Row(
                                  children: [
                                    if (!phone) _desktopSidebar(sidebarWidth),
                                    Expanded(
                                      child: Stack(
                                        fit: StackFit.expand,
                                        children: [
                                          ExcludeFocus(
                                            excluding: showList,
                                            child: Offstage(
                                              offstage: showList,
                                              child: Column(
                                                children: [
                                                  Expanded(
                                                    child: section != null
                                                        ? section!.startsWith(
                                                                'workspace:',
                                                              )
                                                              ? LayoutBuilder(
                                                                  builder:
                                                                      (
                                                                        context,
                                                                        bounds,
                                                                      ) {
                                                                        final media =
                                                                            MediaQuery.of(
                                                                              context,
                                                                            );
                                                                        final extra =
                                                                            phone
                                                                            ? max(
                                                                                0.0,
                                                                                56 +
                                                                                    media.viewPadding.bottom -
                                                                                    media.viewInsets.bottom,
                                                                              )
                                                                            : 0.0;
                                                                        return OverflowBox(
                                                                          alignment:
                                                                              Alignment.topLeft,
                                                                          minHeight:
                                                                              bounds.maxHeight +
                                                                              extra,
                                                                          maxHeight:
                                                                              bounds.maxHeight +
                                                                              extra,
                                                                          child: WorkspacePage(
                                                                            key: ValueKey(
                                                                              section,
                                                                            ),
                                                                            controller:
                                                                                c,
                                                                            workspaceId: section!.substring(
                                                                              10,
                                                                            ),
                                                                            onBack:
                                                                                _showList,
                                                                            onOpen:
                                                                                _openSession,
                                                                            sidebarCollapsed:
                                                                                sidebarCollapsed,
                                                                            onExpand: () => _sidebarCollapsed(
                                                                              false,
                                                                            ),
                                                                          ),
                                                                        );
                                                                      },
                                                                )
                                                              : ManagementPage(
                                                                  kind:
                                                                      section!,
                                                                  controller: c,
                                                                  theme: widget
                                                                      .theme,
                                                                  onBack:
                                                                      _showList,
                                                                )
                                                        : _conversationArea(
                                                            overlay,
                                                            phone,
                                                            size.maxWidth,
                                                          ),
                                                  ),
                                                ],
                                              ),
                                            ),
                                          ),
                                          if (phone)
                                            ExcludeFocus(
                                              excluding: !showList,
                                              child: Offstage(
                                                offstage: !showList,
                                                child: _sidebar(),
                                              ),
                                            ),
                                        ],
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  );
                },
              );
            },
          );
    final source = ListenableBuilder(
      listenable: _documents,
      builder: (_, _) {
        final retained = <Object>{_appSurfaceIdentity};
        void keep(Object? value) {
          if (value is _AppDocumentViewSnapshot &&
              value.surfaceOwner == _surfaceOwner) {
            retained.add(value.surfaceIdentity);
          }
        }

        for (final window in _documents.windows) {
          if (window.canReturnToSource) keep(window.sourceState);
          for (final entry in window.history) {
            keep(entry.appState);
          }
        }
        final active = _documents.active;
        final visible = widget.documentWindow == null
            ? active == null ||
                  active.canReturnToSource &&
                      active.currentDocument == null &&
                      active.error == null
            : active == widget.documentWindow &&
                  active?.currentAppRoute != null;
        return NativeAppSurface(
          key: _appSurface,
          activeIdentity: _appSurfaceIdentity,
          retainedIdentities: retained,
          accountIdentity: _documents.accountIdentity,
          visible: visible,
          onNavigationChanged: _documents.notifyAppNavigationChanged,
          child: layout,
        );
      },
    );
    return NativeDocumentScope(
      windows: _documents,
      documentUrl: documentUrl,
      sourceIdentity: _documents.accountIdentity,
      window: widget.documentWindow,
      child: widget.documentWindow == null
          ? NativeDocumentHost(
              key: _documentHost,
              windows: _documents,
              child: source,
            )
          : source,
    );
  }

  Widget _desktopSidebar(double width) => SizedBox(
    width: sidebarCollapsed ? 0 : width,
    child: OverflowBox(
      alignment: Alignment.topLeft,
      minWidth: width,
      maxWidth: width,
      child: ExcludeFocus(
        excluding: sidebarCollapsed,
        child: Offstage(offstage: sidebarCollapsed, child: _sidebar()),
      ),
    ),
  );

  void _showList() {
    _documentRouteTicket++;
    _documentRouting = false;
    c.sessionVisible = false;
    setState(() {
      listOpen = true;
      section = null;
      sidebarCollapsed = false;
      panelOpen = false;
    });
    c.fromNotification = false;
    // Keep the active session and draft: back is navigation, not a new chat.
    unawaited(guarded(context, c.flushDraft));
  }

  void _closePhoneSidebar() {
    if (!listOpen) return;
    setState(() => listOpen = false);
    _update();
  }

  Widget _header() => SessionHeader(
    controller: c,
    sidebarCollapsed: sidebarCollapsed,
    onBack: _showList,
    onExpand: () => _sidebarCollapsed(false),
    onWorkspace: () {
      final id = obj(c.state['session'])['workspaceId'];
      if (id != null) _openWorkspace('$id');
    },
  );

  Widget _conversationArea(bool overlay, bool phone, double viewport) {
    if (c.initializing ||
        (c.sessionId != null && c.state.isEmpty && c.error == null)) {
      return const AppLoadingState();
    }
    if (c.sessionId == null || c.state.isEmpty) {
      return const AppNoSessionState();
    }
    // A session is shown by its panes (decision 4): no transcript, no
    // composer. The panes take the whole page.
    if (pane == null || !panelOpen) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && c.sessionId != null && (pane == null || !panelOpen)) {
          _panel(panelKind ?? 'files', remember: false);
        }
      });
    }
    return Column(
      children: [
        _header(),
        if (c.error != null) ConversationErrorBanner(controller: c),
        Expanded(
          child: pane == null
              ? const AppLoadingState()
              : LayoutBuilder(
                  builder: (context, size) => NativeSidePanel(
                    tab: panelKind ?? 'files',
                    git: c.sessionPanel('git'),
                    terminal: c.sessionPanel('terminals'),
                    open: true,
                    overlay: false,
                    width: size.maxWidth,
                    maxWidth: size.maxWidth,
                    activity: panelCounts,
                    onSelect: _panel,
                    onResize: (_) {},
                    child: paneHistory.isEmpty
                        ? pane!
                        : Column(
                            children: [
                              Align(
                                alignment: Alignment.centerLeft,
                                child: IconButton(
                                  tooltip: 'Back to side panel',
                                  onPressed: _closePane,
                                  icon: const Icon(LucideIcons.arrowLeft),
                                ),
                              ),
                              Expanded(child: pane!),
                            ],
                          ),
                  ),
                ),
        ),
      ],
    );
  }

  void _openSession(String id) {
    if (c.showing != 'engine') c.showEngine();
    _documentRouteTicket++;
    _documentRouting = false;
    _replaceDocumentAddress('session', id);
    setState(() {
      listOpen = false;
      section = null;
    });
    c.sessionVisible = true;
    unawaited(guarded(context, () => c.open(id)));
  }

  void _openWorkspace(String id) {
    _documentRouteTicket++;
    _documentRouting = false;
    _replaceDocumentAddress('workspace', id);
    c.sessionVisible = false;
    setState(() {
      section = 'workspace:$id';
      listOpen = false;
      panelOpen = false;
    });
    unawaited(guarded(context, c.flushDraft));
  }

  Widget _sidebar() => SessionSidebar(
    key: sidebarKey,
    controller: c,
    activeId: section == null ? c.sessionId : null,
    workspaceId: section?.startsWith('workspace:') == true
        ? section!.substring(10)
        : null,
    onOpen: _openSession,
    onWorkspace: _openWorkspace,
    onPage: _page,
    onCollapse: () => _sidebarCollapsed(true),
  );
}

class _IndependentAppWindow extends StatefulWidget {
  const _IndependentAppWindow({
    super.key,
    required this.window,
    required this.windows,
    required this.transport,
    required this.theme,
  });
  final NativeDocumentWindow window;
  final NativeDocumentWindows windows;
  final Gateway transport;
  final PircTheme theme;
  @override
  State<_IndependentAppWindow> createState() => _IndependentAppWindowState();
}

class _IndependentAppWindowState extends State<_IndependentAppWindow> {
  late final scoped = DartScopedGateway(
    widget.transport,
    contextId:
        'app-${List.generate(16, (_) => Random.secure().nextInt(256).toRadixString(16).padLeft(2, '0')).join()}',
  );
  late final controller = LiveController(scoped);
  late final initialRoute = widget.window.history
      .firstWhere((entry) => entry.appRoute != null)
      .appRoute!;
  final ready = Completer<void>();
  bool _covered = false;
  int _visibility = 0;
  Future<void> _changes = Future.value();
  Future<void>? _closing;

  @override
  void initState() {
    super.initState();
    widget.window.appReady = ready.future;
    widget.window.onDisposeContext = _close;
    widget.windows.addListener(_syncVisibility);
    _syncVisibility();
  }

  void _booted() {
    if (!ready.isCompleted) ready.complete();
    _syncVisibility(force: true);
  }

  void _syncVisibility({bool force = false}) {
    if (!mounted || widget.windows.disposed) return;
    final hidden =
        widget.windows.active != widget.window ||
        widget.window.currentAppRoute == null;
    if (!force && hidden == _covered) return;
    final ticket = ++_visibility;
    final changed = hidden != _covered;
    _covered = hidden;
    _changes = _changes.catchError((Object _) {}).then((_) async {
      if (!mounted || widget.window.disposed || ticket != _visibility) return;
      if (changed) {
        if (hidden) {
          await controller.coverDocument();
        } else {
          await controller.uncoverDocument();
        }
      } else if (ready.isCompleted && hidden) {
        await controller.resyncVisibility();
      }
    });
  }

  void _close() {
    _closing ??= controller
        .flushDraft()
        .catchError((Object _) {})
        .whenComplete(scoped.closeContext);
    unawaited(_closing);
  }

  @override
  void dispose() {
    _visibility++;
    widget.windows.removeListener(_syncVisibility);
    _close();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => LiveShell(
    controller: controller,
    theme: widget.theme,
    documentWindows: widget.windows,
    documentWindow: widget.window,
    initialRoute: initialRoute,
    onBooted: _booted,
  );
}

class PairingScreen extends StatefulWidget {
  const PairingScreen({super.key, required this.controller, this.onCancel});
  final LiveController controller;
  final VoidCallback? onCancel;
  @override
  State<PairingScreen> createState() => _PairingScreenState();
}

class _PairingScreenState extends State<PairingScreen> {
  late final field = TextEditingController(
    text: widget.controller.pairLink ?? '',
  );
  String? _observedPairLink;
  bool _scanPending = false;
  bool _bundledScannerAvailable = false;
  bool _bundledScannerPending = false;
  String? _scanRequestId;

  Future<bool> _cancelScanPreparation() async {
    final requestId = _scanRequestId;
    if (requestId == null) return false;
    return await widget.controller.gateway.call('cancelScanPreparation', {
          'requestId': requestId,
        }) ==
        true;
  }

  Future<void> _scan() async {
    if (_scanPending || widget.controller.busy) return;
    final requestId =
        'scan-${DateTime.now().microsecondsSinceEpoch}-${Random().nextInt(1 << 32)}';
    setState(() {
      _scanPending = true;
      _scanRequestId = requestId;
    });
    try {
      await guarded(context, () async {
        dynamic value;
        try {
          value = await widget.controller.gateway.call('scan', {
            'requestId': requestId,
          });
        } on PlatformException catch (error) {
          if (mounted &&
              !kIsWeb &&
              defaultTargetPlatform == TargetPlatform.android &&
              {
                'SCAN',
                'SCAN_TIMEOUT',
                'SCAN_DOWNLOADING',
                'SCAN_UNSUPPORTED',
              }.contains(error.code)) {
            setState(() => _bundledScannerAvailable = true);
          }
          rethrow;
        }
        if (value != null && mounted) {
          setState(() => field.text = '$value');
          await widget.controller.pair('$value');
        }
      });
    } finally {
      if (_scanRequestId == requestId) {
        _scanRequestId = null;
        if (mounted) setState(() => _scanPending = false);
      }
    }
  }

  Future<void> _scanBundled() async {
    if (_scanPending || _bundledScannerPending || widget.controller.busy) {
      return;
    }
    setState(() => _bundledScannerPending = true);
    try {
      final value = await Navigator.of(context).push<String>(
        MaterialPageRoute(
          builder: (_) =>
              PairingScannerPage(gateway: widget.controller.gateway),
        ),
      );
      if (value != null && mounted) {
        setState(() => field.text = value);
        await guarded(context, () => widget.controller.pair(value));
      }
    } finally {
      if (mounted) setState(() => _bundledScannerPending = false);
    }
  }

  @override
  void initState() {
    super.initState();
    _observedPairLink = widget.controller.pairLink;
  }

  @override
  void didUpdateWidget(covariant PairingScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    final nextPairLink = widget.controller.pairLink;
    if (nextPairLink != null && nextPairLink != _observedPairLink) {
      field.value = TextEditingValue(
        text: nextPairLink,
        selection: TextSelection.collapsed(offset: nextPairLink.length),
      );
    }
    // The controller is mutated before the parent rebuilds, so its old value
    // cannot be read from oldWidget here. Keep our own last-seen value instead.
    _observedPairLink = nextPairLink;
  }

  @override
  void dispose() {
    final requestId = _scanRequestId;
    if (requestId != null) {
      unawaited(
        widget.controller.gateway
            .call('cancelScanPreparation', {'requestId': requestId})
            .catchError((Object _) => null),
      );
    }
    field.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: const Text('連接 pirc'),
      leading: widget.onCancel == null
          ? null
          : IconButton(
              onPressed: widget.onCancel,
              icon: const Icon(LucideIcons.x),
            ),
    ),
    body: Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 480),
        child: ListView(
          shrinkWrap: true,
          padding: const EdgeInsets.all(16),
          children: [
            const Icon(LucideIcons.messagesSquare, size: 48),
            const SizedBox(height: 24),
            const Text(
              '讓工作跟著你',
              textAlign: TextAlign.center,
              style: TextStyle(
                fontSize: 24,
                height: 32 / 24,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 16),
            const Text(
              '在網頁版「設定 → 裝置」建立配對，掃描 QR code 或貼上配對連結。',
              style: TextStyle(fontSize: 16, height: 28 / 16),
            ),
            const SizedBox(height: 20),
            TextField(
              controller: field,
              obscureText: true,
              autocorrect: false,
              enableSuggestions: false,
              decoration: supportingField(
                context,
                label: '配對連結',
                hint: 'pirc://pair?…',
              ),
            ),
            const SizedBox(height: 16),
            FilledButton(
              onPressed: widget.controller.busy
                  ? null
                  : () => guarded(context, () async {
                      final cancelled = await _cancelScanPreparation();
                      if (!mounted || (_scanPending && !cancelled)) return;
                      await widget.controller.pair(field.text);
                    }),
              child: Text(widget.controller.busy ? '確認連線中…' : '連接'),
            ),
            TextButton.icon(
              onPressed:
                  widget.controller.busy ||
                      _scanPending ||
                      _bundledScannerPending
                  ? null
                  : _scan,
              icon: const Icon(LucideIcons.scanLine),
              label: Text(_scanPending ? '正在準備掃描器…' : '掃描 QR code'),
            ),
            if (_bundledScannerAvailable)
              TextButton.icon(
                onPressed:
                    widget.controller.busy ||
                        _scanPending ||
                        _bundledScannerPending
                    ? null
                    : _scanBundled,
                icon: const Icon(LucideIcons.camera),
                label: const Text('使用內建相機掃描'),
              ),
            if (_scanPending)
              TextButton(
                onPressed: () => guarded(context, () async {
                  await _cancelScanPreparation();
                }),
                child: const Text('取消準備'),
              ),
            if (widget.controller.error != null)
              Text(
                widget.controller.error!,
                style: TextStyle(color: palette(context)['status.danger']),
              ),
          ],
        ),
      ),
    ),
  );
}
