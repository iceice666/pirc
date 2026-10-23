import '../l10n/app_i18n.dart';
import 'dart:convert';
import 'gateway.dart';

String value(Json m, String key) => '${m[key] ?? ''}';
bool partial(Json m) => m['isPartial'] == true || m['partial'] == true;
String messageError(Json m) => value(m, 'errorMessage').isNotEmpty
    ? value(m, 'errorMessage')
    : value(m, 'error');
bool processOnly(Json m) =>
    m['role'] == 'assistant' &&
    value(m, 'content').isEmpty &&
    value(m, 'stopReason').isEmpty &&
    messageError(m).isEmpty &&
    rows(m['images']).isEmpty;
bool toolsOnly(Json m) => processOnly(m) && rows(m['tools']).isNotEmpty;

class TimelineItem {
  const TimelineItem(this.messages, {this.run = false, this.anchor});
  final List<Json> messages;
  final bool run;
  final String? anchor;
  String get id =>
      run ? 'run:${anchor ?? messages.first['id']}' : '${messages.first['id']}';
  List<Json> get tools => messages.expand((m) => rows(m['tools'])).toList();
}

Json? pendingInteractionForTool(Json tool, List<Json> interactions) =>
    interactions
        .where(
          (interaction) =>
              interaction['status'] == 'pending' &&
              interaction['toolCallId'] == tool['id'],
        )
        .firstOrNull;

bool toolHasPendingInteraction(Json tool, List<Json> interactions) =>
    pendingInteractionForTool(tool, interactions) != null ||
    rows(
      tool['operations'],
    ).any((operation) => toolHasPendingInteraction(operation, interactions));

List<TimelineItem> timelineItems(List<Json> messages) {
  final result = <TimelineItem>[], run = <Json>[];
  String? anchor;
  void flush() {
    if (run.isNotEmpty) {
      result.add(TimelineItem(List.of(run), run: true, anchor: anchor));
    }
    run.clear();
  }

  for (final m in messages) {
    if (m['role'] == 'user' ||
        m['systemKind'] == 'bash' ||
        m['systemKind'] == 'branch') {
      flush();
      result.add(TimelineItem([m]));
      anchor = value(m, 'id');
    } else {
      run.add(m);
    }
  }
  flush();
  return result;
}

({List<Json> activity, List<Json> visible}) responseParts(List<Json> messages) {
  final activity = <Json>[], visible = <Json>[];
  for (final m in messages) {
    if (m['role'] == 'assistant') {
      final tools = rows(m['tools']).isNotEmpty;
      if (value(m, 'thinking').isNotEmpty ||
          m['thinkingRedacted'] == true ||
          tools) {
        activity.add({
          ...m,
          'content': tools ? m['content'] : '',
          'images': <Json>[],
          'stopReason': null,
          'errorMessage': null,
          'error': null,
        });
      }
      if ((!tools &&
              (value(m, 'content').isNotEmpty ||
                  (partial(m) &&
                      value(m, 'thinking').isEmpty &&
                      m['thinkingRedacted'] != true))) ||
          rows(m['images']).isNotEmpty ||
          value(m, 'stopReason').isNotEmpty ||
          messageError(m).isNotEmpty) {
        visible.add({
          ...m,
          'thinking': null,
          'thinkingRedacted': false,
          'tools': <Json>[],
          'content': tools ? '' : m['content'],
        });
      }
    } else if (m['level'] == 'warning' || m['level'] == 'error') {
      visible.add(m);
    } else {
      activity.add(m);
    }
  }
  return (activity: activity, visible: visible);
}

DateTime? instant(dynamic v) => v is num
    ? DateTime.fromMillisecondsSinceEpoch(v.toInt())
    : v is String
    ? DateTime.tryParse(v)?.toLocal()
    : null;
String elapsedMs(int? ms) => ms == null
    ? ''
    : ms < 1000
    ? tr("{0} ms", [ms])
    : tr("{0} s", [(ms / 1000).toStringAsFixed(ms < 10000 ? 1 : 0)]);
String toolElapsed(Json tool) {
  final start = instant(tool['startedAt']), end = instant(tool['endedAt']);
  if (start == null || end == null || end.isBefore(start)) return '';
  return elapsedMs(end.difference(start).inMilliseconds);
}

class RunSummary {
  RunSummary(List<Json> tools) {
    final calls = effectiveTools(tools);
    count = calls.length;
    status = tools.any((t) => t['status'] == 'failed')
        ? 'failed'
        : tools.any((t) => t['status'] == 'running')
        ? 'running'
        : 'succeeded';
    final starts = tools.map((t) => instant(t['startedAt'])).nonNulls.toList()
      ..sort();
    final ends = tools.map((t) => instant(t['endedAt'])).nonNulls.toList()
      ..sort();
    durationMs = starts.isNotEmpty && ends.isNotEmpty && status != 'running'
        ? ends.last.difference(starts.first).inMilliseconds.clamp(0, 1 << 62)
        : null;
    final names = calls.map((t) => t['name']).toSet();
    title = names.contains('edit') || names.contains('write')
        ? 'Made changes'
        : names.contains('bash')
        ? 'Ran commands'
        : ['read', 'grep', 'find', 'ls'].any(names.contains)
        ? 'Explored the code'
        : 'Used tools';
    for (final t in calls) {
      final path = obj(t['input'])['path'];
      if (!['read', 'edit', 'write'].contains(t['name']) ||
          path is! String ||
          path.isEmpty) {
        continue;
      }
      final parts = path.split('/').where((s) => s.isNotEmpty);
      final name = parts.isEmpty ? path : parts.last;
      if (!files.contains(name)) files.add(name);
    }
  }
  late final int count;
  late final String status, title;
  late final int? durationMs;
  final List<String> files = [];
}

List<Json> effectiveTools(List<Json> tools) {
  final calls = <Json>[];
  void add(Json tool) {
    if (tool['name'] == 'ptc_docs') return;
    final operations = rows(tool['operations']);
    if (operations.isEmpty) {
      calls.add(tool);
    } else {
      for (final operation in operations) {
        add(operation);
      }
    }
  }

  for (final tool in tools) {
    add(tool);
  }
  return calls.isEmpty ? tools : calls;
}

({String path, String holderName})? writeBlock(Json t) {
  if (t['status'] != 'failed') return null;
  final match = RegExp(
    "(\\S+) is being written by session \"(.+?)\" \\([^)]*\\); wait until its run finishes",
  ).firstMatch(value(t, 'output'));
  return match == null ? null : (path: match[1]!, holderName: match[2]!);
}

Json toolArgs(dynamic input) =>
    input is List ? {for (final (i, v) in input.indexed) '$i': v} : obj(input);
String toolDescription(Json t) {
  final a = toolArgs(t['input']);
  String first(dynamic v) => v is String ? v : '';
  switch (t['name']) {
    case 'ptc':
      final count = effectiveTools(rows(t['operations'])).length;
      return count == 1 ? '1 operation' : '$count operations';
    case 'bash':
      return first(a['command']);
    case 'read':
      return '${first(a['path'])}${a['offset'] is num ? ':${a['offset']}${a['limit'] is num ? '–${a['offset'] + a['limit'] - 1}' : ''}' : ''}';
    case 'edit':
    case 'write':
    case 'ls':
      return first(a['path']);
    case 'grep':
    case 'find':
      return [
        first(a['pattern']),
        a['path'] != null && a['path'] != '' ? 'in ${a['path']}' : '',
      ].where((s) => s.isNotEmpty).join(' ');
    default:
      return a.values.whereType<String>().firstOrNull ?? '';
  }
}

dynamic residualInput(Json t) {
  if (t['input'] == null) return null;
  if (t['input'] is! Map && t['input'] is! List) return '${t['input']}';
  final a = toolArgs(t['input']);
  final skip =
      const {
        'bash': ['command'],
        'read': ['path', 'offset', 'limit'],
        'edit': ['path', 'edits'],
        'write': ['path', 'content'],
        'ls': ['path'],
      }[t['name']] ??
      [];
  final rest = Map.of(a)..removeWhere((key, _) => skip.contains(key));
  return rest.isEmpty ? null : rest;
}

String inputText(dynamic input) =>
    input is String ? input : const JsonEncoder.withIndent('  ').convert(input);
String clipToolText(String s) {
  if (s.length <= 200000) return s;
  final remaining = '${s.length - 200000}'.replaceAllMapped(
    RegExp(r'\B(?=(\d{3})+(?!\d))'),
    (_) => ',',
  );
  return tr("{0}\n… {1} more characters not shown", [
    s.substring(0, 200000),
    remaining,
  ]);
}

String toolLanguage(dynamic path) {
  if (path is! String) return '';
  final name = path.split('/').last;
  if (name == 'Makefile' || name == 'GNUmakefile') return 'makefile';
  if (name == 'Dockerfile') return 'dockerfile';
  final extension = name.contains('.')
      ? name.split('.').last.toLowerCase()
      : '';
  return const {
        'ts': 'typescript',
        'tsx': 'typescript',
        'mts': 'typescript',
        'cts': 'typescript',
        'js': 'javascript',
        'jsx': 'javascript',
        'mjs': 'javascript',
        'cjs': 'javascript',
        'py': 'python',
        'rs': 'rust',
        'go': 'go',
        'rb': 'ruby',
        'java': 'java',
        'kt': 'kotlin',
        'swift': 'swift',
        'c': 'c',
        'h': 'c',
        'cc': 'cpp',
        'cpp': 'cpp',
        'hpp': 'cpp',
        'cs': 'csharp',
        'php': 'php',
        'sh': 'bash',
        'bash': 'bash',
        'zsh': 'bash',
        'json': 'json',
        'yaml': 'yaml',
        'yml': 'yaml',
        'toml': 'ini',
        'ini': 'ini',
        'md': 'markdown',
        'html': 'xml',
        'xml': 'xml',
        'svelte': 'xml',
        'vue': 'xml',
        'css': 'css',
        'scss': 'scss',
        'less': 'less',
        'sql': 'sql',
        'lua': 'lua',
        'diff': 'diff',
        'patch': 'diff',
        'graphql': 'graphql',
        'r': 'r',
        'pl': 'perl',
        'mk': 'makefile',
      }[extension] ??
      '';
}
