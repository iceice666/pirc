/// The fixed web's goal.ts and todo.ts widget wire formats.
class GoalView {
  const GoalView({
    required this.phase,
    required this.disarmed,
    required this.rounds,
    required this.objective,
    this.maxRounds,
    this.reason,
  });
  final String phase, objective;
  final bool disarmed;
  final int rounds;
  final int? maxRounds;
  final String? reason;
  bool get running => phase == 'active' && !disarmed;
  bool get canResume =>
      (phase == 'paused' || phase == 'blocked' || disarmed) &&
      (maxRounds == null || rounds < maxRounds!);
  String get phaseLabel => disarmed
      ? 'Waiting for resume'
      : const {
          'active': 'Active',
          'paused': 'Paused',
          'blocked': 'Blocked',
          'complete': 'Complete',
        }[phase]!;
  String get count => '$rounds${maxRounds == null ? '' : '/$maxRounds'}';
  String get dot => running
      ? 'ongoing'
      : phase == 'complete'
      ? 'done'
      : phase == 'blocked'
      ? 'error'
      : 'idle';
}

GoalView? parseGoalWidget(dynamic input) {
  if (input is! List || input.isEmpty || input.first is! String) return null;
  final match = RegExp(
    r'^GOAL · (active|paused|blocked|complete)( · disarmed)? · (\d+)(?:/(\d+))?$',
  ).firstMatch(input.first as String);
  if (match == null) return null;
  final rounds = int.tryParse(match[3]!);
  final maximum = match[4] == null ? null : int.tryParse(match[4]!);
  if (rounds == null || (match[4] != null && maximum == null)) return null;
  return GoalView(
    phase: match[1]!,
    disarmed: match[2] != null,
    rounds: rounds,
    maxRounds: maximum,
    objective: input.length > 1 ? '${input[1]}' : '',
    reason: input.length > 2 && '${input[2]}'.isNotEmpty ? '${input[2]}' : null,
  );
}

class TodoItem {
  const TodoItem(this.status, this.text, this.category, this.blocked);
  final String status, text;
  final String? category;
  final bool blocked;
  String get dot => status == 'completed'
      ? 'done'
      : status == 'in_progress'
      ? 'ongoing'
      : 'idle';
}

class TodoList {
  const TodoList(this.items, this.done, this.total);
  final List<TodoItem> items;
  final int done, total;
  List<TodoItem> get active =>
      items.where((item) => item.status == 'in_progress').toList();
  String get headline => active.isNotEmpty
      ? '${active.first.text}${active.length > 1 ? ' +${active.length - 1}' : ''}'
      : done == total && total > 0
      ? 'All tasks completed'
      : 'Tasks';
}

TodoList? parseTodoWidget(dynamic input) {
  if (input is! List || input.isEmpty) return null;
  final lines = input.map((line) => '$line').toList();
  final header = RegExp(r'^TODO · (\d+)/(\d+)$').firstMatch(lines.first);
  final items = <TodoItem>[];
  for (final line in lines.skip(header == null ? 0 : 1)) {
    if (line.isEmpty) continue;
    final status = const {
      '✓': 'completed',
      '▶': 'in_progress',
      '☐': 'pending',
    }[line.substring(0, 1)];
    if (status == null) continue;
    var text = line.substring(1).trim();
    String? category;
    final tagged = RegExp(r'^\[([^\]]*)\] (.*)$').firstMatch(text);
    if (tagged != null) {
      category = tagged[1]!.isEmpty ? null : tagged[1];
      text = tagged[2]!;
    }
    final blocked = text.endsWith(' (blocked)');
    if (blocked) text = text.substring(0, text.length - ' (blocked)'.length);
    items.add(TodoItem(status, text, category, blocked));
  }
  final done = header == null
      ? items.where((item) => item.status == 'completed').length
      : int.tryParse(header[1]!);
  final total = header == null ? items.length : int.tryParse(header[2]!);
  if (done == null || total == null || total == 0) return null;
  return TodoList(items, done, total);
}
