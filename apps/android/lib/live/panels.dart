import '../l10n/app_i18n.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'gateway.dart';
import 'common.dart';
import 'files_pane.dart';
import 'context_pane.dart';
import 'tasks_pane.dart';
import 'git_pane.dart';
import 'terminal_pane.dart';
import 'observational_memory_pane.dart';
import 'browser_pane.dart';
export 'browser_pane.dart' show BrowserPane;
export 'files_pane.dart' show FilesPane;

class WorkPanel extends StatelessWidget {
  const WorkPanel({
    super.key,
    required this.controller,
    required this.kind,
    required this.onOpen,
    this.path,
    this.onFile,
  });
  final LiveController controller;
  final String kind;
  final String? path;
  final ValueChanged<String>? onFile;
  final void Function(Widget) onOpen;
  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    final c = controller;
    if (kind == 'context') {
      return ContextPane(controller: c, onFile: onFile ?? (_) {});
    }
    if (kind == 'git') return GitPane(controller: c, onFile: onFile ?? (_) {});
    if (kind == 'tasks') return TasksPane(controller: c);
    if (kind == 'memory') return ObservationalMemoryPane(controller: c);
    if (kind == 'browser') return BrowserPane(controller: c);
    if (kind == 'files') {
      return FilesPane(controller: c, initialPath: path ?? '');
    }
    if (kind == 'terminals') return TerminalPane(controller: c);
    return const SizedBox.shrink();
  }
}

class DocumentPane extends StatefulWidget {
  const DocumentPane({
    super.key,
    required this.controller,
    required this.messageId,
    required this.initial,
    required this.title,
  });
  final LiveController controller;
  final String messageId, initial, title;
  @override
  State<DocumentPane> createState() => _DocumentPaneState();
}

class _DocumentPaneState extends State<DocumentPane> {
  late final reading = widget.controller.readers.putIfAbsent(
    '${widget.controller.sessionId}:${widget.messageId}',
    () => ReadingState(widget.initial),
  );
  List<String> get versions => reading.versions;
  int get selected => reading.selected;
  set selected(int value) => reading.selected = value;
  Map<int, double> get offsets => reading.offsets;
  late final scroll = ScrollController(
    initialScrollOffset: offsets[selected] ?? 0,
  );
  @override
  void initState() {
    super.initState();
    widget.controller.addListener(update);
    scroll.addListener(saveOffset);
    update();
  }

  void update() {
    final message = widget.controller.messages
        .where((m) => m['id'] == widget.messageId)
        .firstOrNull;
    if (message != null &&
        message['partial'] != true &&
        message['content'] != versions.last &&
        '${message['content']}'.isNotEmpty) {
      if (mounted) setState(() => versions.add('${message['content']}'));
    }
  }

  void saveOffset() {
    if (scroll.hasClients) offsets[selected] = scroll.offset;
  }

  void select(int v) {
    offsets[selected] = scroll.hasClients ? scroll.offset : 0;
    setState(() => selected = v);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (scroll.hasClients) {
        scroll.jumpTo(
          (offsets[v] ?? 0).clamp(0, scroll.position.maxScrollExtent),
        );
      }
    });
  }

  @override
  void dispose() {
    if (scroll.hasClients) offsets[selected] = scroll.offset;
    widget.controller.removeListener(update);
    scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    return Column(
      children: [
        Row(
          children: [
            Expanded(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Text(
                  '${versions[selected].split('\n').first.replaceFirst(RegExp(r'^#+\s*'), '').trim()} · v${selected + 1}',
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ),
            IconButton(
              tooltip: tr("分享"),
              icon: const Icon(LucideIcons.share2, size: 18),
              onPressed: () => guarded(context, () async {
                await widget.controller.gateway.call('share', {
                  'text': versions[selected],
                });
              }),
            ),
            PopupMenuButton<int>(
              tooltip: tr("閱讀版本"),
              onSelected: select,
              itemBuilder: (_) => [
                for (var i = 0; i < versions.length; i++)
                  PopupMenuItem(value: i, child: Text('v${i + 1}')),
              ],
            ),
            IconButton(
              tooltip: tr("複製"),
              onPressed: () =>
                  Clipboard.setData(ClipboardData(text: versions[selected])),
              icon: const Icon(LucideIcons.copy),
            ),
          ],
        ),
        if (selected < versions.length - 1)
          TextButton(
            onPressed: () => select(versions.length - 1),
            child: Text(tr("已有 v{0} · 切換新版", [versions.length])),
          ),
        if (widget.controller.messages.any(
          (m) => m['id'] == widget.messageId && m['partial'] == true,
        ))
          Padding(
            padding: EdgeInsets.all(8),
            child: Text(tr("仍在生成 · 保留目前閱讀內容，完成後可切換新版")),
          ),
        if (widget.controller.messages.any(
          (m) => m['id'] == widget.messageId && m['error'] != null,
        ))
          Padding(
            padding: EdgeInsets.all(8),
            child: Text(tr("生成遇到問題 · 目前顯示最後可讀內容")),
          ),
        Expanded(
          child: ListView(
            key: const Key('live-reader'),
            controller: scroll,
            padding: const EdgeInsets.all(24),
            children: [
              RichTextBody(
                versions[selected],
                reader: true,
                gateway: widget.controller.gateway,
              ),
            ],
          ),
        ),
      ],
    );
  }
}
