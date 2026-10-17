import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart' show defaultTargetPlatform, kIsWeb;
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import '../theme.dart';
import 'gateway.dart';
import 'common.dart';
import 'panels.dart';
import 'settings.dart';
import 'settings_dialog.dart';
import 'interaction.dart';
import 'permissions.dart';
import 'pairing_scanner.dart';
import 'mobile_tabs.dart';
import 'session_sidebar.dart';
import 'workspace_page.dart';
import 'conversation_header.dart';
import 'conversation_empty.dart';
import 'conversation_composer.dart';
import 'conversation_timeline.dart';
import 'conversation_jump_latest.dart';
import 'conversation_earlier_messages.dart';
import 'timeline_models.dart';
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
    required this.mode,
    required this.scheduleFocus,
    required this.scrollOffset,
  });
  final Object surfaceIdentity, surfaceOwner;
  final String? url, sessionId, section, scheduleFocus, panelKind;
  final bool listOpen, panelOpen, sidebarCollapsed;
  final double panelWidth, scrollOffset;
  final String mode;
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
    mode: c.mode,
    scheduleFocus: scheduleFocus,
    scrollOffset: chatScroll.hasClients ? chatScroll.offset : 0,
  );

  Future<void> _restoreDocumentAppState(Object value) => guarded(
    context,
    () async {
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
          c.mode = value.mode;
          scheduleFocus = value.scheduleFocus;
          if (section == 'schedules') scheduleFocusRevision++;
        });
        if (value.panelOpen && value.sessionId != null) {
          _panel(value.panelKind ?? 'files', remember: false);
        }
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (current() && chatScroll.hasClients) {
            chatScroll.jumpTo(
              value.scrollOffset.clamp(0, chatScroll.position.maxScrollExtent),
            );
          }
        });
      } finally {
        if (ticket == _documentRouteTicket) {
          _documentRouting = false;
          if (mounted) _update();
        }
      }
    },
  );

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
            selection.workspaceId == null &&
                !selection.showSchedules &&
                selection.sessionId != null
            ? nativePircReplaceRouteQuery(
                route.canonicalUrl,
                key: 'session',
                value: selection.sessionId!,
              )
            : route.canonicalUrl;
        section = selection.workspaceId != null
            ? 'workspace:${selection.workspaceId}'
            : selection.showSchedules
            ? 'schedules'
            : null;
        listOpen = selection.listOpen;
        scheduleFocus = selection.showSchedules ? selection.scheduleId : null;
        if (selection.showSchedules) scheduleFocusRevision++;
        if (section != null) panelOpen = false;
        if (selection.workspaceId != null) {
          final workspace = c.workspaces.firstWhere(
            (w) => w['id'] == selection.workspaceId,
          );
          c.mode = workspace['kind'] == 'chat' ? 'chat' : 'work';
        }
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
  final chatKey = GlobalKey();
  final panelCache = <String, Widget>{};
  final panelCounts = <String, int>{};
  final paneHistory = <Widget>[];
  String? highlightedMessage;
  String? readingMessage;
  Timer? highlightTimer;
  final chatScroll = ScrollController();
  bool _revealingEarlier = false, _earlierCheckScheduled = false;
  bool _following = true;
  double _lastScrollTop = 0;
  final _earlierButtonKey = GlobalKey();
  final composer = TextEditingController();
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
  String seenContent = '';
  bool newContent = false;
  bool listOpen = true;
  bool sidebarCollapsed = false;
  bool? phoneLayout;
  String? section;
  String? scheduleFocus;
  int scheduleFocusRevision = 0;
  bool _syncing = false;
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
    composer.addListener(_typed);
    chatScroll.addListener(_onTimelineScroll);
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

  void _typed() {
    if (!_syncing) c.editDraft(composer.text);
  }

  void _update() {
    if (!mounted || !_inTree) return;
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
        scheduleFocus = null;
      }
      pane = null;
      panelCounts.clear();
      panelCache.clear();
      paneHistory.clear();
      seenOrigin = c.origin;
      seenClient = c.clientId;
      seenSession = c.sessionId;
      seenContent = '';
      newContent = false;
      _following = true;
      _lastScrollTop = 0;
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
    if (c.chat && (panelKind == 'git' || panelKind == 'terminals')) {
      panelKind = 'files';
      pane = null;
    }
    if (c.sessionId != null && panelOpen && pane == null) {
      _panel(panelKind ?? 'files', remember: false);
    }
    final run = obj(c.state['run'])['status'] as String?;
    if (previousRun == 'running' && run != 'running') unawaited(_panelCounts());
    previousRun = run;
    if (composer.text != c.draft) {
      _syncing = true;
      composer.value = TextEditingValue(
        text: c.draft,
        selection: TextSelection.collapsed(offset: c.draft.length),
      );
      _syncing = false;
    }
    final last = c.messages.lastOrNull;
    final fingerprint = '${jsonEncode(last)}:${c.questions.length}';
    if (fingerprint != seenContent) {
      final bottom = _following || !chatScroll.hasClients;
      seenContent = fingerprint;
      if (bottom) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted &&
              _following &&
              !_revealingEarlier &&
              chatScroll.hasClients) {
            chatScroll.jumpTo(chatScroll.position.maxScrollExtent);
          }
        });
      } else {
        newContent = true;
      }
    }
    if (c.notificationQuestion != null &&
        c.sessionId != null &&
        c.state.isNotEmpty &&
        !c.initializing &&
        c.onboardingComplete) {
      final intent = c.notificationQuestion!;
      c.notificationQuestion = null;
      final interactionId = intent['interactionId'];
      final interactionEpoch = intent['interactionEpoch'] ?? intent['epoch'];
      final rawNotificationPairingStamp =
          intent['interactionPairingStamp'] ?? intent['questionPairingStamp'];
      final notificationPairingStamp = rawNotificationPairingStamp is String
          ? rawNotificationPairingStamp
          : null;
      final pairingMismatch =
          notificationPairingStamp != null &&
          notificationPairingStamp != c.pairingStamp;
      final q = interactionId == null || pairingMismatch
          ? null
          : rows(c.state['interactions'])
                .where(
                  (q) =>
                      q['id'] == interactionId &&
                      (interactionEpoch == null ||
                          '${q['epoch']}' == '$interactionEpoch'),
                )
                .firstOrNull;
      final account = _documents.accountIdentity;
      final targetController = c;
      final targetSessionId = c.sessionId;
      final routedSessionId = intent['sessionId'];
      final targetOrigin = c.origin;
      final targetPairingStamp = c.pairingStamp;
      final targetAccountRevision = c.accountRevision;
      final targetNavigationRevision = c.sessionNavigationRevision;
      bool routeStillOwnsQuestion() =>
          mounted &&
          identical(c, targetController) &&
          targetSessionId != null &&
          targetSessionId.isNotEmpty &&
          routedSessionId == targetSessionId &&
          c.sessionId == targetSessionId &&
          c.origin == targetOrigin &&
          c.pairingStamp == targetPairingStamp &&
          c.accountRevision == targetAccountRevision &&
          c.sessionNavigationRevision == targetNavigationRevision &&
          account == _documents.accountIdentity;
      WidgetsBinding.instance.addPostFrameCallback((_) async {
        if (!routeStillOwnsQuestion()) return;
        if (widget.documentWindow == null) {
          await _documentHost.currentState?.selectWindow(null);
          if (!routeStillOwnsQuestion()) return;
        }
        await WidgetsBinding.instance.endOfFrame;
        if (!routeStillOwnsQuestion()) return;
        final appContext = _appSurface.currentState?.appContext;
        if (appContext != null && appContext.mounted) {
          showModalBottomSheet<void>(
            context: appContext,
            isScrollControlled: true,
            useSafeArea: true,
            builder: (_) => QuestionSheet(
              controller: targetController,
              question:
                  q ??
                  {
                    'id': interactionId,
                    'epoch': interactionEpoch,
                    'title': '確認通知狀態',
                  },
              requiresManualReview:
                  interactionId == null ||
                  interactionEpoch == null ||
                  notificationPairingStamp == null,
              notificationPairingStamp: notificationPairingStamp,
              initialChoice:
                  interactionId != null &&
                      interactionEpoch != null &&
                      notificationPairingStamp != null &&
                      !pairingMismatch
                  ? intent['answerChoice'] as String?
                  : null,
            ),
          );
        }
      });
    }
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
    highlightTimer?.cancel();
    resizeSave?.cancel();
    countRefresh?.cancel();
    unawaited(panelEvents?.cancel());
    panelToggleFocus.dispose();
    composer.dispose();
    search.dispose();
    chatScroll.dispose();
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
    if (!documentRoute && name != 'settings' && name != 'memory') {
      _documentRouteTicket++;
      _documentRouting = false;
    }
    if (name == 'settings' || name == 'memory') {
      setState(() => settingsOpen = true);
      unawaited(
        showNativeSettings(
          context,
          controller: c,
          initialTab: name == 'memory' ? 'Memory' : 'General',
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
    if (name == 'schedules') {
      c.sessionVisible = false;
      setState(() {
        section = name;
        scheduleFocus = null;
        listOpen = false;
        panelOpen = false;
      });
      return;
    }
    if (name.startsWith('schedule:')) {
      c.sessionVisible = false;
      setState(() {
        section = 'schedules';
        scheduleFocus = name.substring(9);
        scheduleFocusRevision++;
        listOpen = false;
        panelOpen = false;
      });
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
      if (readingMessage != null) {
        highlightedMessage = readingMessage;
        readingMessage = null;
        highlightTimer?.cancel();
        highlightTimer = Timer(const Duration(seconds: 1), () {
          if (mounted) setState(() => highlightedMessage = null);
        });
      }
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

  void _resizePanel(double width) {
    setState(() => panelWidth = width);
    resizeSave?.cancel();
    resizeSave = Timer(const Duration(milliseconds: 150), () {
      if (mounted) _saveLayout({'panelWidth': panelWidth.round()});
    });
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
    if (c.chat && (kind == 'git' || kind == 'terminals')) kind = 'files';
    panelOpen = true;
    if (remember) _rememberPanel();
    unawaited(_panelCounts());
    setState(() {
      paneHistory.clear();
      readingMessage = null;
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
    final layout = LayoutBuilder(
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
        final canLeave = !panelOpen && (!phone || listOpen) && section == null;
        final hasChats = c.workspaces.any(
          (w) => w['kind'] == 'chat' && w['id'] == "${w['hostId']}:chats",
        );
        final mobileMode = hasChats ? c.mode : 'work';
        return ListenableBuilder(
          listenable: _documents,
          builder: (context, _) {
            final historyOwnsBack =
                _documents.managedPresentation &&
                (_documents.presented || _documents.active?.canBack == true);
            return PopScope(
              canPop: historyOwnsBack || canLeave,
              onPopInvokedWithResult: (didPop, result) {
                if (didPop || historyOwnsBack) return;
                if (panelOpen) {
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
                      ? MobileTabs(
                          current: settingsOpen
                              ? 'settings'
                              : listOpen
                              ? mobileMode
                              : section?.startsWith('workspace:') == true
                              ? mobileMode
                              : section ?? mobileMode,
                          chats: hasChats,
                          waiting: c.attentionCount,
                          onPick: (tab) {
                            if (tab == 'chat' || tab == 'work') {
                              unawaited(guarded(context, () => c.setMode(tab)));
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
                                                            builder: (context, bounds) {
                                                              final media =
                                                                  MediaQuery.of(
                                                                    context,
                                                                  );
                                                              final extra =
                                                                  phone
                                                                  ? max(
                                                                      0.0,
                                                                      56 +
                                                                          media
                                                                              .viewPadding
                                                                              .bottom -
                                                                          media
                                                                              .viewInsets
                                                                              .bottom,
                                                                    )
                                                                  : 0.0;
                                                              return OverflowBox(
                                                                alignment:
                                                                    Alignment
                                                                        .topLeft,
                                                                minHeight:
                                                                    bounds
                                                                        .maxHeight +
                                                                    extra,
                                                                maxHeight:
                                                                    bounds
                                                                        .maxHeight +
                                                                    extra,
                                                                child: WorkspacePage(
                                                                  key: ValueKey(
                                                                    section,
                                                                  ),
                                                                  controller: c,
                                                                  workspaceId:
                                                                      section!
                                                                          .substring(
                                                                            10,
                                                                          ),
                                                                  onBack:
                                                                      _showList,
                                                                  onOpen:
                                                                      _openSession,
                                                                  sidebarCollapsed:
                                                                      sidebarCollapsed,
                                                                  onExpand: () =>
                                                                      _sidebarCollapsed(
                                                                        false,
                                                                      ),
                                                                ),
                                                              );
                                                            },
                                                          )
                                                        : section == 'schedules'
                                                        ? SchedulesPage(
                                                            controller: c,
                                                            focusId:
                                                                scheduleFocus,
                                                            focusRevision:
                                                                scheduleFocusRevision,
                                                            onOpenChat:
                                                                _openSession,
                                                            sidebarCollapsed:
                                                                sidebarCollapsed,
                                                            onExpand: () =>
                                                                _sidebarCollapsed(
                                                                  false,
                                                                ),
                                                          )
                                                        : ManagementPage(
                                                            kind: section!,
                                                            controller: c,
                                                            theme: widget.theme,
                                                            onBack: _showList,
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
                        if (overlay &&
                            pane != null &&
                            !showList &&
                            section == null)
                          ..._overlayPanel(phone, size.maxWidth),
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

  Widget _header() => ConversationHeader(
    controller: c,
    sidebarCollapsed: sidebarCollapsed,
    panelOpen: panelOpen,
    panelFocus: panelToggleFocus,
    onBack: _showList,
    onExpand: () => _sidebarCollapsed(false),
    onPanel: () => panelOpen ? _closePane() : _panel(panelKind ?? 'files'),
    onWorkspace: () {
      final id = obj(c.state['session'])['workspaceId'];
      if (id != null) _openWorkspace('$id');
    },
    onOrigin: (origin) {
      if (origin['kind'] == 'schedule') {
        _page('schedule:${origin['scheduleId']}');
      } else {
        _openSession('${origin['fromSessionId']}');
      }
    },
  );

  Widget _conversationArea(bool overlay, bool phone, double viewport) {
    final width = panelWidth
        .clamp(280.0, sidePanelMax(viewport, sidebarCollapsed))
        .toDouble();
    Widget contents() => ExcludeFocus(
      excluding: overlay && panelOpen,
      child: ExcludeSemantics(
        excluding: overlay && panelOpen,
        child: IgnorePointer(
          ignoring: overlay && panelOpen,
          child: Column(
            key: chatKey,
            children: [Expanded(child: _chat())],
          ),
        ),
      ),
    );

    if (c.initializing ||
        (c.sessionId != null && c.state.isEmpty && c.error == null)) {
      return const AppLoadingState();
    }
    if (c.sessionId == null || c.state.isEmpty) {
      return const AppNoSessionState();
    }
    return Column(
      children: [
        _header(),
        if (c.error != null) ConversationErrorBanner(controller: c),
        if (c.sessionId != null &&
            c.state.isNotEmpty &&
            c.control['held'] != true)
          ConversationViewerBanner(controller: c),
        Expanded(
          child: Stack(
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Expanded(child: contents()),
                  if (!overlay && pane != null)
                    Offstage(
                      offstage: !panelOpen,
                      child: SizedBox(
                        width: width,
                        child: _panelBody(
                          overlay,
                          width,
                          sidePanelMax(viewport, sidebarCollapsed),
                        ),
                      ),
                    ),
                ],
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _panelBody(bool overlay, double width, double maxWidth) => Offstage(
    offstage: !panelOpen,
    child: TickerMode(
      enabled: panelOpen,
      child: Focus(
        onKeyEvent: (_, event) {
          if (overlay &&
              panelOpen &&
              panelKind != 'terminals' &&
              event is KeyDownEvent &&
              event.logicalKey == LogicalKeyboardKey.escape) {
            _closePane();
            return KeyEventResult.handled;
          }
          return KeyEventResult.ignored;
        },
        child: ExcludeFocus(
          excluding: !panelOpen,
          child: _pane(overlay, width, maxWidth),
        ),
      ),
    ),
  );
  List<Widget> _overlayPanel(bool phone, double viewport) => [
    if (panelOpen)
      Positioned.fill(
        top: 56,
        child: ModalBarrier(
          key: const Key('panel-scrim'),
          color: Colors.black.withValues(alpha: .25),
          dismissible: true,
          semanticsLabel: 'Close side panel',
          onDismiss: _closePane,
        ),
      ),
    if (pane != null)
      Positioned(
        top: 56,
        bottom: phone
            ? 0
            : MediaQuery.paddingOf(context).bottom.clamp(8, double.infinity),
        right: phone ? 0 : 8,
        width: phone ? viewport : (viewport - 16).clamp(0, 420),
        child: Offstage(
          offstage: !panelOpen,
          child: DecoratedBox(
            decoration: BoxDecoration(
              borderRadius: BorderRadius.vertical(
                top: const Radius.circular(20),
                bottom: Radius.circular(phone ? 0 : 20),
              ),
              boxShadow: [
                BoxShadow(color: palette(context)['web.line'], spreadRadius: 1),
                BoxShadow(
                  color: Colors.black.withValues(
                    alpha: Theme.of(context).brightness == Brightness.dark
                        ? .45
                        : .12,
                  ),
                  offset: const Offset(0, 12),
                  blurRadius: 40,
                ),
              ],
            ),
            child: ClipRRect(
              borderRadius: BorderRadius.vertical(
                top: const Radius.circular(20),
                bottom: Radius.circular(phone ? 0 : 20),
              ),
              child: ColoredBox(
                color: palette(context)['web.bg-layer'],
                child: Padding(
                  padding: EdgeInsets.only(
                    bottom: phone ? MediaQuery.paddingOf(context).bottom : 0,
                  ),
                  child: _panelBody(
                    true,
                    panelWidth,
                    sidePanelMax(viewport, sidebarCollapsed),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
  ];
  Widget _pane(bool overlay, double width, double maxWidth) {
    if (panelKind != null && paneHistory.isEmpty) {
      return NativeSidePanel(
        key: paneKey,
        tab: panelKind!,
        chat: c.chat,
        open: panelOpen,
        overlay: overlay,
        width: width,
        maxWidth: maxWidth,
        activity: panelCounts,
        onSelect: _panel,
        onResize: _resizePanel,
        child: pane!,
      );
    }
    return Material(
      key: paneKey,
      color: palette(context)['web.bg-layer'],
      child: Column(
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
    );
  }

  void _openSession(String id) {
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
    final w = c.workspaces.where((w) => w['id'] == id).firstOrNull;
    c.sessionVisible = false;
    setState(() {
      if (w != null) c.mode = w['kind'] == 'chat' ? 'chat' : 'work';
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
    onMode: (mode) {
      // The desktop switch filters the sidebar without navigating the surface.
      unawaited(guarded(context, () => c.setMode(mode)));
    },
    onCollapse: () => _sidebarCollapsed(true),
  );

  void _onTimelineScroll() {
    if (!chatScroll.hasClients) return;
    final position = chatScroll.position;
    final top = position.pixels;
    final nearBottom = position.extentAfter < 80;
    if (top < _lastScrollTop - 1) {
      _following = nearBottom;
    } else if (nearBottom) {
      _following = true;
    }
    if (_following && newContent) setState(() => newContent = false);
    _lastScrollTop = top;
    _scheduleEarlierCheck();
  }

  void _scheduleEarlierCheck() {
    if (_earlierCheckScheduled || _revealingEarlier || c.hiddenMessages == 0) {
      return;
    }
    _earlierCheckScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _earlierCheckScheduled = false;
      if (!mounted || _revealingEarlier || !chatScroll.hasClients) return;
      final button = _earlierButtonKey.currentContext?.findRenderObject();
      final viewport = button is RenderBox
          ? RenderAbstractViewport.maybeOf(button)
          : null;
      if (button is! RenderBox || viewport == null) return;
      final offset = viewport.getOffsetToReveal(button, 0).offset;
      final position = chatScroll.position;
      // IntersectionObserver uses a 200px top root margin on .timeline.
      if (offset + button.size.height >= position.pixels - 200 &&
          offset <= position.pixels + position.viewportDimension) {
        _showEarlier();
      }
    });
  }

  void _showEarlier() {
    if (_revealingEarlier || c.hiddenMessages == 0 || !chatScroll.hasClients) {
      return;
    }
    final session = c.sessionId;
    final navigation = c.sessionNavigationRevision;
    final previousExtent = chatScroll.position.maxScrollExtent;
    final previousTop = chatScroll.offset;
    _revealingEarlier = true;
    c.revealEarlierMessages();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      if (session == c.sessionId &&
          navigation == c.sessionNavigationRevision &&
          chatScroll.hasClients) {
        final position = chatScroll.position;
        chatScroll.jumpTo(
          (previousTop + position.maxScrollExtent - previousExtent).clamp(
            position.minScrollExtent,
            position.maxScrollExtent,
          ),
        );
      }
      _revealingEarlier = false;
      _scheduleEarlierCheck();
    });
  }

  void _keepBottomAfterLayout() {
    if (_revealingEarlier || !_following || !chatScroll.hasClients) {
      return;
    }
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted &&
          _following &&
          !_revealingEarlier &&
          chatScroll.hasClients) {
        chatScroll.jumpTo(chatScroll.position.maxScrollExtent);
      }
    });
  }

  Widget _chat() {
    _scheduleEarlierCheck();
    _keepBottomAfterLayout();
    return LayoutBuilder(
      builder: (context, bounds) => Column(
        children: [
          Expanded(
            child: Stack(
              children: [
                CustomScrollView(
                  controller: chatScroll,
                  slivers: [
                    SliverPadding(
                      padding: EdgeInsets.fromLTRB(
                        (bounds.maxWidth - bounds.maxWidth.clamp(0, 780)) / 2 +
                            (MediaQuery.sizeOf(context).width <= 650
                                ? 14
                                : MediaQuery.sizeOf(context).width <= 1100
                                ? 24
                                : 32),
                        MediaQuery.sizeOf(context).width <= 650 ? 8 : 16,
                        (bounds.maxWidth - bounds.maxWidth.clamp(0, 780)) / 2 +
                            (MediaQuery.sizeOf(context).width <= 650
                                ? 14
                                : MediaQuery.sizeOf(context).width <= 1100
                                ? 24
                                : 32),
                        c.messages.isEmpty
                            ? 0
                            : MediaQuery.sizeOf(context).width <= 650
                            ? 20
                            : 32,
                      ),
                      sliver: SliverMainAxisGroup(
                        slivers: [
                          SliverToBoxAdapter(
                            child:
                                NotificationListener<
                                  SizeChangedLayoutNotification
                                >(
                                  onNotification: (_) {
                                    _keepBottomAfterLayout();
                                    _scheduleEarlierCheck();
                                    return false;
                                  },
                                  child: SizeChangedLayoutNotifier(
                                    child: Column(
                                      children: [
                                        if (c.hiddenMessages > 0)
                                          ConversationEarlierMessages(
                                            buttonKey: _earlierButtonKey,
                                            hiddenCount: c.hiddenMessages,
                                            onPressed: _showEarlier,
                                          ),
                                        ConversationTimeline(
                                          controller: c,
                                          onFile: (path) =>
                                              _panel('files', path: path),
                                          highlightedMessage:
                                              highlightedMessage,
                                        ),
                                        for (final q
                                            in timelineInteractionsNotEmbedded(
                                              c.visibleMessages,
                                              c.questions,
                                            ))
                                          QuestionSheet(
                                            key: ValueKey(
                                              '${c.sessionId}:${q['id']}:${q['epoch']}',
                                            ),
                                            controller: c,
                                            question: q,
                                            embedded: true,
                                            onLayout: _keepBottomAfterLayout,
                                          ),
                                      ],
                                    ),
                                  ),
                                ),
                          ),
                          if (c.messages.isEmpty)
                            SliverFillRemaining(
                              hasScrollBody: false,
                              // Include the trailing inset in the fill extent:
                              // outer sliver padding otherwise adds scroll room
                              // below an already viewport-filling empty state.
                              child: Padding(
                                padding: EdgeInsets.only(
                                  bottom:
                                      MediaQuery.sizeOf(context).width <= 650
                                      ? 20
                                      : 32,
                                ),
                                child: const ConversationEmptyState(),
                              ),
                            ),
                        ],
                      ),
                    ),
                  ],
                ),
                if (newContent)
                  Positioned(
                    left: 0,
                    right: 0,
                    bottom: 12,
                    child: Center(
                      child: ConversationJumpLatest(
                        onPressed: () {
                          _following = true;
                          setState(() => newContent = false);
                          chatScroll.animateTo(
                            chatScroll.position.maxScrollExtent,
                            duration: const Duration(milliseconds: 200),
                            curve: Curves.easeOut,
                          );
                        },
                      ),
                    ),
                  ),
                // Composer.svelte's ::before overlays the preceding 24px of
                // transcript without taking layout space or pointer events.
                Positioned(
                  left: 0,
                  right: 0,
                  bottom: 0,
                  height: 24,
                  child: IgnorePointer(
                    child: DecoratedBox(
                      key: const Key('conversation-composer-fade'),
                      decoration: BoxDecoration(
                        gradient: LinearGradient(
                          begin: Alignment.topCenter,
                          end: Alignment.bottomCenter,
                          colors: [
                            palette(
                              context,
                            )['surface.page'].withValues(alpha: 0),
                            palette(context)['surface.page'],
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
          ConstrainedBox(
            constraints: BoxConstraints(maxHeight: bounds.maxHeight),
            child: _composer(),
          ),
        ],
      ),
    );
  }

  Widget _composer() => ConversationComposer(controller: c, text: composer);
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
