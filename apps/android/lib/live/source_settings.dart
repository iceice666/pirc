import 'dart:async';
import 'package:flutter/material.dart';
import 'assistant_settings.dart';
import 'common.dart';
import 'engine_overview.dart' show agoMs;
import 'gateway.dart';

const _gmail = 'imap.gmail.com';

const sourceKindLabels = {
  'email': 'Email',
  'calendar': 'Calendar',
  'moodle': 'Moodle',
  'workspace': 'Workspace',
};

/// What a source is, in one line (no credential is ever in its config).
String describeSource(Json source) {
  final config = obj(source['config']);
  String text(String key) => config[key] is String ? config[key] as String : '';
  final parts = switch (source['kind']) {
    'email' => [text('username'), text('host'), text('mailbox')],
    'calendar' =>
      text('mode') == 'caldav'
          ? ['CalDAV', text('username'), text('host')]
          : ['ICS', text('host')],
    'moodle' => [
      text('siteName'),
      text('fullName').isEmpty ? text('username') : text('fullName'),
      text('url'),
    ],
    'workspace' => [
      text('workspaceName').isEmpty ? text('workspace') : text('workspaceName'),
    ],
    _ => <String>[],
  };
  return parts.where((part) => part.isNotEmpty).join(' · ');
}

/// How often it is read, for people.
String cadence(Object? ms) {
  final minutes = ((ms is num ? ms : 0) / 60000).round();
  if (minutes < 60) return 'every $minutes min';
  final hours = (minutes / 60).round();
  return hours >= 24 ? 'once a day' : 'every $hours h';
}

/// Its state, for people: paused, failing, read, or not yet.
String sourceStatus(Json source) {
  if (source['pausedAt'] != null) return 'Paused';
  final failures = (source['failures'] as num?)?.toInt() ?? 0;
  if (failures > 0 && source['lastError'] != null) {
    return 'Cannot be read: ${source['lastError']}';
  }
  if (source['lastPolledAt'] != null) {
    return 'Read ${cadence(source['cadenceMs'])}';
  }
  return 'Not read yet';
}

/// Sources (plans/rewrite/09-sources.md), beside the model backends: add a
/// mailbox, a calendar, Moodle or a workspace; read now, pause, remove, sign
/// in again. Credentials are write-only: no answer holds one.
class NativeSourceSettings extends StatefulWidget {
  const NativeSourceSettings({super.key, required this.gateway});
  final Gateway gateway;

  @override
  State<NativeSourceSettings> createState() => _NativeSourceSettingsState();
}

class _NativeSourceSettingsState extends State<NativeSourceSettings> {
  List<Json> sources = [];
  bool loading = true;
  String busy = '';
  String? error, notice, confirmRemove;

  /// The add form, or a source signing in again.
  bool formOpen = false;
  Json? editing;
  String kind = 'email', provider = 'gmail', calendarMode = 'ics';
  String moodleLogin = 'password';
  String? launchUrl;
  final name = TextEditingController(),
      username = TextEditingController(),
      password = TextEditingController(),
      host = TextEditingController(),
      port = TextEditingController(text: '993'),
      mailbox = TextEditingController(text: 'INBOX'),
      address = TextEditingController(),
      pasted = TextEditingController(),
      workspace = TextEditingController();

  Gateway get g => widget.gateway;

  @override
  void initState() {
    super.initState();
    unawaited(load());
  }

  @override
  void dispose() {
    for (final field in [
      name,
      username,
      password,
      host,
      port,
      mailbox,
      address,
      pasted,
      workspace,
    ]) {
      field.dispose();
    }
    super.dispose();
  }

  Future<void> load() async {
    try {
      final reply = await g.request('/api/sources');
      sources = rows(reply['sources']);
      error = null;
    } catch (e) {
      error = LiveController.describe(e);
    }
    if (mounted) setState(() => loading = false);
  }

  Future<void> act(String id, Future<String?> Function() action) async {
    if (busy.isNotEmpty) return;
    setState(() {
      busy = id;
      error = null;
      notice = null;
    });
    try {
      final said = await action();
      notice = said;
      await load();
    } catch (e) {
      error = LiveController.describe(e);
    }
    if (mounted) setState(() => busy = '');
  }

  void open([Json? source]) {
    final config = obj(source?['config']);
    String text(String key) =>
        config[key] is String ? config[key] as String : '';
    setState(() {
      formOpen = true;
      editing = source;
      kind = '${source?['kind'] ?? 'email'}';
      name.text = '${source?['name'] ?? ''}';
      provider = source == null || text('host') == _gmail ? 'gmail' : 'other';
      username.text = text('username');
      host.text = text('host') == _gmail ? '' : text('host');
      port.text = '${config['port'] ?? 993}';
      mailbox.text = text('mailbox').isEmpty ? 'INBOX' : text('mailbox');
      calendarMode = text('mode') == 'caldav' ? 'caldav' : 'ics';
      address.text = kind == 'moodle' || calendarMode == 'caldav'
          ? text('url')
          : '';
      password.clear();
      pasted.clear();
      moodleLogin = 'password';
      launchUrl = null;
      workspace.text = text('workspace');
    });
  }

  Json input() => switch (kind) {
    'email' => {
      'config': {
        'host': provider == 'gmail' ? _gmail : host.text.trim(),
        'port': int.tryParse(port.text) ?? 993,
        'username': username.text.trim(),
        'mailbox': mailbox.text.trim().isEmpty ? 'INBOX' : mailbox.text.trim(),
      },
      'secret': {'password': password.text},
    },
    'calendar' =>
      calendarMode == 'ics'
          ? {
              'config': {'mode': 'ics'},
              'secret': {'url': address.text.trim()},
            }
          : {
              'config': {
                'mode': 'caldav',
                'url': address.text.trim(),
                'username': username.text.trim(),
              },
              'secret': {'password': password.text},
            },
    'moodle' => {
      'config': {'url': address.text.trim()},
      'secret': moodleLogin == 'app'
          ? {'launch': pasted.text.trim()}
          : {'username': username.text.trim(), 'password': password.text},
    },
    _ => {
      'config': {'workspace': workspace.text.trim()},
    },
  };

  Future<void> save() => act(editing?['id'] as String? ?? 'new', () async {
    final source = editing;
    final reply = source != null
        ? await g.request(
            '/api/sources/${enc('${source['id']}')}',
            method: 'PUT',
            body: {
              if (name.text.trim().isNotEmpty) 'name': name.text.trim(),
              ...input(),
            },
          )
        : await g.request(
            '/api/sources',
            method: 'POST',
            body: {'kind': kind, 'name': name.text.trim(), ...input()},
          );
    setState(() => formOpen = false);
    password.clear();
    final test = reply['test'];
    return test != null
        ? '${source != null ? 'Saved' : 'Added'}: $test'
        : 'Saved.';
  });

  Future<void> startAppLogin() => act('launch', () async {
    final reply = await g.request(
      '/api/sources/moodle/launch',
      method: 'POST',
      body: {'url': address.text.trim()},
    );
    launchUrl = '${reply['launchUrl']}';
    await g.call('external', {'url': launchUrl});
    return null;
  });

  Future<void> poll(Json source) => act('${source['id']}', () async {
    final result = await g.request(
      '/api/sources/${enc('${source['id']}')}/poll',
      method: 'POST',
      body: {},
    );
    final failed = obj(result['error']);
    if (failed.isNotEmpty) throw StateError('${failed['message']}');
    if (result['baseline'] == true) {
      return '${source['name']}: read for the first time.';
    }
    final count = rows(result['changed']).length;
    return '${source['name']}: ${count > 0 ? '$count new or changed' : 'nothing new'}'
        '${result['wake'] != null ? ', and pirc woke up for it' : ''}.';
  });

  Future<void> remove(Json source) async {
    if (confirmRemove != source['id']) {
      setState(() => confirmRemove = '${source['id']}');
      return;
    }
    confirmRemove = null;
    await act('${source['id']}', () async {
      await g.request(
        '/api/sources/${enc('${source['id']}')}',
        method: 'DELETE',
      );
      return 'Removed ${source['name']}.';
    });
  }

  Widget field(
    TextEditingController controller,
    String label, {
    bool secret = false,
    String? hint,
    TextInputType? keyboard,
  }) => Padding(
    padding: const EdgeInsets.only(top: 8),
    child: TextField(
      controller: controller,
      obscureText: secret,
      keyboardType: keyboard,
      autocorrect: !secret,
      decoration: InputDecoration(
        labelText: label,
        hintText: hint,
        isDense: true,
        border: const OutlineInputBorder(),
      ),
    ),
  );

  Widget choice(
    String label,
    String value,
    List<(String, String)> options,
    ValueChanged<String> pick,
  ) => Padding(
    padding: const EdgeInsets.only(top: 8),
    child: DropdownButtonFormField<String>(
      initialValue: value,
      decoration: InputDecoration(
        labelText: label,
        isDense: true,
        border: const OutlineInputBorder(),
      ),
      items: [
        for (final (id, text) in options)
          DropdownMenuItem(value: id, child: Text(text)),
      ],
      onChanged: (next) {
        if (next != null) setState(() => pick(next));
      },
    ),
  );

  List<Widget> form() {
    final editingNow = editing != null;
    return [
      Text(
        editingNow ? 'Sign in again: ${editing!['name']}' : 'New source',
        style: const TextStyle(fontWeight: FontWeight.w600),
      ),
      if (!editingNow)
        choice('Kind', kind, [
          for (final entry in sourceKindLabels.entries)
            (entry.key, entry.value),
        ], (next) => kind = next),
      field(name, 'Name', hint: sourceKindLabels[kind]),
      if (kind == 'email') ...[
        choice('Mail', provider, [
          ('gmail', 'Gmail (app password)'),
          ('other', 'Another IMAP server'),
        ], (next) => provider = next),
        if (provider == 'other') ...[
          field(host, 'IMAP server', hint: 'imap.example.com'),
          field(port, 'Port', keyboard: TextInputType.number),
        ],
        field(username, 'Address'),
        field(
          password,
          provider == 'gmail' ? 'App password' : 'Password',
          secret: true,
        ),
        field(mailbox, 'Mailbox'),
      ] else if (kind == 'calendar') ...[
        choice('Calendar', calendarMode, [
          ('ics', 'An ICS address'),
          ('caldav', 'CalDAV'),
        ], (next) => calendarMode = next),
        field(
          address,
          calendarMode == 'ics'
              ? 'ICS address (kept secret)'
              : 'CalDAV address',
          secret: calendarMode == 'ics',
        ),
        if (calendarMode == 'caldav') ...[
          field(username, 'User name'),
          field(password, 'Password', secret: true),
        ],
      ] else if (kind == 'moodle') ...[
        field(address, 'Site', hint: 'https://moodle.example.edu'),
        choice('Sign in', moodleLogin, [
          ('password', 'User name and password'),
          ('app', 'Like the Moodle app (SSO)'),
        ], (next) => moodleLogin = next),
        if (moodleLogin == 'password') ...[
          field(username, 'User name'),
          field(password, 'Password', secret: true),
        ] else ...[
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: AssistantButton(
              'Open the sign-in page',
              onPressed: busy.isEmpty ? startAppLogin : null,
            ),
          ),
          field(pasted, 'Where it ended (moodlemobile://…)'),
        ],
      ] else
        field(workspace, 'Workspace', hint: 'node:workspace'),
      Padding(
        padding: const EdgeInsets.only(top: 12),
        child: Row(
          children: [
            AssistantButton(
              editingNow ? 'Save' : 'Add',
              primary: true,
              onPressed: busy.isEmpty ? save : null,
            ),
            const SizedBox(width: 8),
            AssistantButton(
              'Cancel',
              onPressed: () => setState(() => formOpen = false),
            ),
          ],
        ),
      ),
    ];
  }

  @override
  Widget build(BuildContext context) {
    final colors = palette(context);
    return AssistantSection(
      title: 'Sources',
      divider: true,
      children: [
        const AssistantParagraph(
          'What pirc reads beyond the rooms: a mailbox, a calendar, Moodle, a workspace. All read-only; '
          'the passwords stay on the gateway.',
        ),
        if (error != null) AssistantParagraph(error!, error: true, live: true),
        if (notice != null) AssistantParagraph(notice!, live: true),
        if (loading)
          const AssistantParagraph('Loading sources…', live: true)
        else ...[
          for (final source in sources)
            Container(
              margin: const EdgeInsets.only(top: 8),
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: colors['surface.subtle'],
                borderRadius: BorderRadius.circular(8),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '${source['name']} · ${sourceKindLabels[source['kind']] ?? source['kind']}',
                    style: const TextStyle(fontWeight: FontWeight.w500),
                  ),
                  Text(
                    describeSource(source),
                    style: TextStyle(fontSize: 12, color: colors['text.muted']),
                  ),
                  Text(
                    '${sourceStatus(source)}${source['lastPolledAt'] != null ? ' · last ${agoMs(source['lastPolledAt'])}' : ''}',
                    style: TextStyle(
                      fontSize: 12,
                      color:
                          colors[sourceStatus(source).startsWith('Cannot')
                              ? 'status.danger'
                              : 'text.muted'],
                    ),
                  ),
                  Wrap(
                    spacing: 4,
                    children: [
                      TextButton(
                        onPressed: busy.isEmpty ? () => poll(source) : null,
                        child: const Text('Read now'),
                      ),
                      TextButton(
                        onPressed: busy.isEmpty
                            ? () => act('${source['id']}', () async {
                                final paused = source['pausedAt'] != null;
                                await g.request(
                                  '/api/sources/${enc('${source['id']}')}/${paused ? 'resume' : 'pause'}',
                                  method: 'POST',
                                  body: {},
                                );
                                return null;
                              })
                            : null,
                        child: Text(
                          source['pausedAt'] != null ? 'Resume' : 'Pause',
                        ),
                      ),
                      if (source['kind'] != 'workspace')
                        TextButton(
                          onPressed: busy.isEmpty ? () => open(source) : null,
                          child: const Text('Sign in again'),
                        ),
                      TextButton(
                        onPressed: busy.isEmpty ? () => remove(source) : null,
                        child: Text(
                          confirmRemove == source['id']
                              ? 'Remove for good'
                              : 'Remove',
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          const SizedBox(height: 8),
          if (formOpen)
            ...form()
          else
            AssistantButton('Add a source', onPressed: () => open()),
        ],
      ],
    );
  }
}
