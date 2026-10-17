import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'common.dart';
import 'document_navigation_state.dart';
import 'gateway.dart';
import 'web_controls.dart';

/// A management view for the live App source and its native document windows.
///
/// The callbacks own window selection, history navigation, and closing. The
/// page only displays existing contexts; it never reloads a document or replays
/// a form submission.
class NativeDocumentWindowManagerPage extends StatefulWidget {
  const NativeDocumentWindowManagerPage({
    super.key,
    required this.windows,
    required this.onSelect,
    required this.onClose,
    required this.onBack,
    required this.onForward,
  });

  final NativeDocumentWindows windows;
  final Future<void> Function(NativeDocumentWindow?) onSelect;
  final Future<void> Function(NativeDocumentWindow) onClose;
  final Future<void> Function(NativeDocumentWindow) onBack;
  final Future<void> Function(NativeDocumentWindow) onForward;

  @override
  State<NativeDocumentWindowManagerPage> createState() =>
      _NativeDocumentWindowManagerPageState();
}

class _NativeDocumentWindowManagerPageState
    extends State<NativeDocumentWindowManagerPage> {
  late Object _accountIdentity;
  int _actionGeneration = 0;
  bool _busy = false;
  String? _error;
  NativeDocumentWindow? _busyWindow;

  NativeDocumentWindows get windows => widget.windows;

  @override
  void initState() {
    super.initState();
    _accountIdentity = windows.accountIdentity;
    windows.addListener(_windowsChanged);
  }

  @override
  void didUpdateWidget(covariant NativeDocumentWindowManagerPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.windows != windows) {
      oldWidget.windows.removeListener(_windowsChanged);
      _accountIdentity = windows.accountIdentity;
      _actionGeneration++;
      _busy = false;
      _busyWindow = null;
      _error = null;
      windows.addListener(_windowsChanged);
    }
  }

  bool _containsWindow(NativeDocumentWindow? window) =>
      window == null ||
      (!window.disposed &&
          identical(window.windows, windows) &&
          windows.windows.contains(window));

  void _windowsChanged() {
    if (!mounted) return;
    final identity = windows.accountIdentity;
    if (identity != _accountIdentity) {
      _accountIdentity = identity;
      _actionGeneration++;
      _busy = false;
      _busyWindow = null;
      _error = windows.connectionError;
    } else if (_busy && !_containsWindow(_busyWindow)) {
      // A close or account reset removed the operation's target while it was
      // awaiting a host callback. Its eventual completion is stale.
      _actionGeneration++;
      _busy = false;
      _busyWindow = null;
    }
    setState(() {});
  }

  bool _operationIsCurrent(
    int generation,
    Object identity,
    NativeDocumentWindow? window,
  ) =>
      mounted &&
      generation == _actionGeneration &&
      identity == windows.accountIdentity &&
      identity == _accountIdentity &&
      !windows.disposed &&
      _containsWindow(window);

  Future<void> _run(
    NativeDocumentWindow? window,
    Future<void> Function() action,
  ) async {
    if (_busy ||
        windows.disposed ||
        windows.accountIdentity != _accountIdentity ||
        !_containsWindow(window)) {
      return;
    }

    final identity = windows.accountIdentity;
    final generation = ++_actionGeneration;
    setState(() {
      _busy = true;
      _busyWindow = window;
      _error = null;
    });
    try {
      await action();
    } catch (error) {
      if (_operationIsCurrent(generation, identity, window)) {
        setState(() => _error = LiveController.describe(error));
      }
    } finally {
      if (_operationIsCurrent(generation, identity, window)) {
        setState(() {
          _busy = false;
          _busyWindow = null;
        });
      }
    }
  }

  String _sourceUrl() {
    try {
      return windows.appDocumentUrl?.call() ?? '目前的 App 頁面';
    } catch (_) {
      return '目前的 App 頁面';
    }
  }

  String _windowTitle(NativeDocumentWindow window) {
    final title = window.current?.document?.content.title?.trim();
    if (title != null && title.isNotEmpty) return title;
    if (window.currentAppRoute != null) return 'Pirc App';
    final url = window.current?.url ?? window.sourceUrl;
    return url.isEmpty ? '未命名頁面' : url;
  }

  String _windowStatus(NativeDocumentWindow window) {
    if (window.loading) return '載入中';
    if (window.error != null) return '錯誤';
    if (window.currentAppRoute != null) return 'App 頁面';
    final status = window.current?.document?.status;
    return status == null ? '已開啟' : 'HTTP $status';
  }

  Widget _statusPill(String text, {required bool selected}) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
    decoration: BoxDecoration(
      color: palette(context)[selected ? 'accent.soft' : 'web.bg-hover'],
      borderRadius: BorderRadius.circular(999),
    ),
    child: Text(
      text,
      style: webText(
        context,
        size: 11,
        weight: FontWeight.w500,
        color: selected ? 'accent.onSoft' : 'text.secondary',
      ),
    ),
  );

  Widget _card({required Widget child}) => Container(
    decoration: BoxDecoration(
      color: palette(context)['surface.page'],
      borderRadius: BorderRadius.circular(12),
      border: Border.all(color: palette(context)['line.hairline']),
    ),
    padding: const EdgeInsets.all(14),
    child: child,
  );

  Widget _sourceCard() {
    final selected = windows.active == null;
    return _card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '主 App',
                      style: webText(
                        context,
                        size: 15,
                        weight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      _sourceUrl(),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: webText(context, size: 12, color: 'text.muted'),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              _statusPill(selected ? '已選取' : '隱藏中', selected: selected),
            ],
          ),
          const SizedBox(height: 10),
          Align(
            alignment: Alignment.centerRight,
            child: WebButton(
              selected ? '目前頁面' : '切換到主 App',
              key: const Key('document-window-source-select'),
              primary: !selected,
              onPressed: selected || _busy
                  ? null
                  : () => _run(null, () => widget.onSelect(null)),
            ),
          ),
        ],
      ),
    );
  }

  Widget _windowCard(NativeDocumentWindow window) {
    final selected = windows.active == window;
    final title = _windowTitle(window);
    final url = window.current?.url ?? window.sourceUrl;
    final label = window.name.isEmpty ? '獨立頁面' : '名稱：${window.name}';
    final selectKey = 'select-${window.id}';
    final closeKey = 'close-${window.id}';
    return _card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: webText(
                        context,
                        size: 15,
                        weight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 3),
                    Text(
                      label,
                      style: webText(
                        context,
                        size: 12,
                        color: 'text.secondary',
                      ),
                    ),
                    const SizedBox(height: 3),
                    Text(
                      url,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: webText(context, size: 12, color: 'text.muted'),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  _statusPill(selected ? '已選取' : '隱藏中', selected: selected),
                  const SizedBox(height: 4),
                  Text(
                    _windowStatus(window),
                    style: webText(context, size: 11, color: 'text.muted'),
                  ),
                  const SizedBox(height: 2),
                  WebIconButton(
                    LucideIcons.x,
                    '關閉 $title',
                    key: Key('document-window-$closeKey'),
                    onPressed: _busy
                        ? null
                        : () => _run(window, () => widget.onClose(window)),
                  ),
                ],
              ),
            ],
          ),
          const SizedBox(height: 8),
          Align(
            alignment: Alignment.centerRight,
            child: WebButton(
              selected ? '目前頁面' : '切換頁面',
              key: Key('document-window-$selectKey'),
              primary: !selected,
              onPressed: selected || _busy
                  ? null
                  : () => _run(window, () => widget.onSelect(window)),
            ),
          ),
        ],
      ),
    );
  }

  @override
  void dispose() {
    windows.removeListener(_windowsChanged);
    _actionGeneration++;
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final active = windows.active;
    final narrow = MediaQuery.sizeOf(context).width <= 650;
    return Scaffold(
      backgroundColor: palette(context)['surface.grouped'],
      appBar: AppBar(
        leading: IconButton(
          tooltip: '返回',
          onPressed: () => Navigator.maybePop(context),
          icon: const Icon(LucideIcons.chevronLeft),
        ),
        title: const Text('App 視窗'),
        actions: [
          WebIconButton(
            LucideIcons.chevronLeft,
            '上一頁',
            key: const Key('document-window-back'),
            onPressed: active != null && active.canBack && !_busy
                ? () => _run(active, () => widget.onBack(active))
                : null,
          ),
          WebIconButton(
            LucideIcons.chevronRight,
            '下一頁',
            key: const Key('document-window-forward'),
            onPressed: active != null && active.canForward && !_busy
                ? () => _run(active, () => widget.onForward(active))
                : null,
          ),
          const SizedBox(width: 8),
        ],
      ),
      body: SafeArea(
        top: false,
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 760),
            child: ListView(
              padding: EdgeInsets.fromLTRB(
                narrow ? 14 : 28,
                16,
                narrow ? 14 : 28,
                32,
              ),
              children: [
                Text(
                  '主 App 與開啟中的網頁',
                  style: webText(
                    context,
                    size: 12,
                    weight: FontWeight.w600,
                  ).copyWith(letterSpacing: .24),
                ),
                const SizedBox(height: 8),
                if (windows.connectionError != null)
                  WebNotice(windows.connectionError!, error: true),
                if (_error != null) WebNotice(_error!, error: true),
                _sourceCard(),
                for (final window in windows.windows) ...[
                  const SizedBox(height: 10),
                  _windowCard(window),
                ],
                if (windows.windows.isEmpty) ...[
                  const SizedBox(height: 10),
                  Text(
                    '目前沒有其他原生視窗。',
                    style: webText(context, size: 13, color: 'text.muted'),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}
