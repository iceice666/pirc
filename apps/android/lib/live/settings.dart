import '../l10n/app_i18n.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:flutter/material.dart';
import '../theme.dart';
import 'permissions.dart';
import '../demo.dart' as demo;
import 'gateway.dart';
import 'common.dart';
import 'memory_settings.dart';
import 'assistant_settings.dart';
import 'web_controls.dart';
import 'schedules_page.dart';
export 'schedules_page.dart';

class ManagementPage extends StatelessWidget {
  const ManagementPage({
    super.key,
    required this.kind,
    required this.controller,
    required this.theme,
    this.onBack,
    this.onWindows,
  });
  final VoidCallback? onBack, onWindows;
  final String kind;
  final LiveController controller;
  final PircTheme theme;
  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    return Scaffold(
      backgroundColor: kind == 'settings'
          ? palette(context)['surface.grouped']
          : null,
      appBar: AppBar(
        leading: onBack == null
            ? null
            : IconButton(
                tooltip: tr("Back to the list"),
                onPressed: onBack,
                icon: const Icon(LucideIcons.chevronLeft),
              ),
        title: Text(
          {
                'settings': tr("設定"),
                'schedules': tr("排程"),
                'memory': tr("Memory"),
                'activity': tr("待處理與動態"),
              }[kind] ??
              kind,
        ),
      ),
      body: SafeArea(
        child: switch (kind) {
          'settings' => SettingsContent(
            controller: controller,
            theme: theme,
            onWindows: onWindows,
          ),
          'schedules' => SchedulesPage(controller: controller),
          'memory' => MemoryProposals(controller: controller),
          _ => ActivityPage(controller: controller, theme: theme),
        },
      ),
    );
  }
}

class SettingsContent extends StatefulWidget {
  const SettingsContent({
    super.key,
    required this.controller,
    required this.theme,
    this.onWindows,
  });
  final VoidCallback? onWindows;
  final LiveController controller;
  final PircTheme theme;
  @override
  State<SettingsContent> createState() => _SettingsContentState();
}

class _SettingsContentState extends State<SettingsContent> {
  bool busy = false;
  String? error;
  LiveController get c => widget.controller;

  @override
  void initState() {
    super.initState();
    c.addListener(update);
  }

  @override
  void didUpdateWidget(covariant SettingsContent oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != c) {
      oldWidget.controller.removeListener(update);
      c.addListener(update);
    }
  }

  void update() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    c.removeListener(update);
    super.dispose();
  }

  Future<void> run(Future<void> Function() action) async {
    if (busy) return;
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await action();
    } catch (e) {
      if (mounted) setState(() => error = LiveController.describe(e));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  String appearanceLabel() =>
      {
        'system': tr("跟隨系統"),
        'light': tr("淺色"),
        'dark': tr("深色"),
      }[c.preferences['appearance'] ?? 'system'] ??
      tr("跟隨系統");

  Widget row({
    required String title,
    String? subtitle,
    IconData? icon,
    VoidCallback? onTap,
    Widget? trailing,
    String color = 'text.primary',
  }) => _SettingsOptionRow(
    title: title,
    subtitle: subtitle,
    icon: icon,
    onTap: busy ? null : onTap,
    trailing: trailing,
    color: color,
  );

  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    return ColoredBox(
      color: palette(context)['surface.grouped'],
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 760),
          child: ListView(
            padding: const EdgeInsets.fromLTRB(24, 24, 24, 32),
            children: [
              if (error != null) WebNotice(error!, error: true),
              AssistantSection(
                title: tr("此裝置"),
                children: [
                  row(title: tr("連線"), subtitle: c.origin ?? ''),
                  row(title: tr("此裝置"), subtitle: c.clientId ?? ''),
                  row(
                    title: tr("解除配對"),
                    icon: LucideIcons.shieldCheck,
                    color: 'status.danger',
                    onTap: () => run(() async {
                      if (await confirm(
                        context,
                        tr("解除配對"),
                        tr("這會清除此 App 的配對憑證與草稿。"),
                      )) {
                        await c.unpair();
                        if (context.mounted) Navigator.pop(context);
                      }
                    }),
                  ),
                ],
              ),
              AssistantSection(
                title: tr("應用程式"),
                divider: true,
                children: [
                  if (widget.onWindows != null)
                    row(
                      title: tr("App 視窗"),
                      subtitle: tr("切換頁面、管理歷史與關閉視窗"),
                      icon: LucideIcons.panelsTopLeft,
                      onTap: widget.onWindows,
                    ),
                  row(
                    title: tr("權限與快速回應"),
                    subtitle: tr("查看通知、浮窗的授權狀態"),
                    icon: LucideIcons.shieldCheck,
                    onTap: () => Navigator.push(
                      context,
                      MaterialPageRoute<void>(
                        builder: (_) => PermissionPage(gateway: c.gateway),
                      ),
                    ),
                  ),
                  row(
                    title: tr("通知"),
                    icon: LucideIcons.bell,
                    onTap: () => Navigator.push(
                      context,
                      MaterialPageRoute<void>(
                        builder: (_) => Scaffold(
                          appBar: AppBar(title: Text(tr("通知設定"))),
                          backgroundColor: palette(context)['surface.grouped'],
                          body: SafeArea(child: PushSettings(controller: c)),
                        ),
                      ),
                    ),
                  ),
                  row(
                    title: tr("外觀"),
                    subtitle: appearanceLabel(),
                    icon: LucideIcons.settings,
                    onTap: () => _appearance(context),
                  ),
                  row(
                    title: tr("Assistant"),
                    subtitle: tr("Soul and chat rules"),
                    icon: LucideIcons.bot,
                    onTap: () => showDialog<void>(
                      context: context,
                      useRootNavigator: false,
                      builder: (_) => WebDialog(
                        title: tr("Assistant"),
                        eyebrow: 'SETTINGS',
                        actions: const [],
                        children: [AssistantSettings(controller: c)],
                      ),
                    ),
                  ),
                  row(
                    title: tr("記憶提案"),
                    icon: LucideIcons.brain,
                    onTap: () => Navigator.push(
                      context,
                      MaterialPageRoute<void>(
                        builder: (_) => ManagementPage(
                          kind: 'memory',
                          controller: c,
                          theme: widget.theme,
                        ),
                      ),
                    ),
                  ),
                ],
              ),
              AssistantSection(
                title: tr("工作區"),
                divider: true,
                children: [
                  row(
                    title: tr("新增工作空間"),
                    icon: LucideIcons.plus,
                    onTap: () => _workspace(context),
                  ),
                  if (const bool.fromEnvironment('PIRC_DEMO'))
                    row(
                      title: tr("離線驗證工具"),
                      subtitle: tr("使用本機測試資料"),
                      icon: LucideIcons.wrench,
                      onTap: () => Navigator.push(
                        context,
                        MaterialPageRoute<void>(
                          builder: (_) => demo.PircApp(theme: widget.theme),
                        ),
                      ),
                    ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _appearance(BuildContext context) async {
    await showModalBottomSheet<void>(
      context: context,
      useSafeArea: true,
      builder: (sheet) {
        String? sheetError;
        bool saving = false;
        return StatefulBuilder(
          builder: (sheet, update) => SafeArea(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(24),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                mainAxisSize: MainAxisSize.min,
                children: [
                  AssistantSection(
                    title: tr("外觀"),
                    children: [
                      for (final choice in [
                        ('system', tr("跟隨系統")),
                        ('light', tr("淺色")),
                        ('dark', tr("深色")),
                      ])
                        _SettingsOptionRow(
                          title: choice.$2,
                          trailing: c.preferences['appearance'] == choice.$1
                              ? Icon(
                                  LucideIcons.check,
                                  size: 16,
                                  color: palette(sheet)['text.secondary'],
                                )
                              : null,
                          onTap: saving
                              ? null
                              : () async {
                                  update(() {
                                    saving = true;
                                    sheetError = null;
                                  });
                                  try {
                                    await c.savePreferences({
                                      'appearance': choice.$1,
                                    });
                                    if (sheet.mounted) Navigator.pop(sheet);
                                  } catch (e) {
                                    if (sheet.mounted) {
                                      update(
                                        () => sheetError =
                                            LiveController.describe(e),
                                      );
                                    }
                                  } finally {
                                    if (sheet.mounted) {
                                      update(() => saving = false);
                                    }
                                  }
                                },
                        ),
                    ],
                  ),
                  if (sheetError != null) WebNotice(sheetError!, error: true),
                ],
              ),
            ),
          ),
        );
      },
    );
  }

  Future<void> _workspace(BuildContext context) async {
    final node = await showModalBottomSheet<String>(
      context: context,
      useSafeArea: true,
      builder: (sheet) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          padding: const EdgeInsets.all(24),
          children: [
            AssistantSection(
              title: tr("選擇 Node"),
              children: [
                if (c.nodes.isEmpty) AssistantParagraph(tr("目前沒有可用的 Node。")),
                for (final n in c.nodes)
                  _SettingsOptionRow(
                    title: '${n['id']}',
                    onTap: () => Navigator.pop(sheet, '${n['id']}'),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
    if (node == null || !context.mounted) return;
    final path = await input(context, tr("Node 上的資料夾路徑"));
    if (path == null || !context.mounted) return;
    final name = await input(context, tr("顯示名稱"));
    if (name == null || !context.mounted) return;
    await run(() async {
      await c.gateway.request(
        '/api/workspaces',
        method: 'POST',
        body: {'nodeId': node, 'path': path, 'displayName': name},
      );
      await c.refreshList();
    });
  }
}

class _SettingsOptionRow extends StatelessWidget {
  const _SettingsOptionRow({
    required this.title,
    this.subtitle,
    this.icon,
    this.onTap,
    this.trailing,
    this.color = 'text.primary',
  });
  final String title;
  final String? subtitle;
  final IconData? icon;
  final VoidCallback? onTap;
  final Widget? trailing;
  final String color;

  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(8),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 10),
          child: Row(
            children: [
              if (icon != null) ...[
                Icon(
                  icon,
                  size: 16,
                  color: palette(
                    context,
                  )[color == 'status.danger' ? color : 'text.muted'],
                ),
                const SizedBox(width: 12),
              ],
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      style: webText(
                        context,
                        size: 13,
                        weight: FontWeight.w500,
                        color: color,
                      ),
                    ),
                    if (subtitle != null && subtitle!.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 2),
                        child: Text(
                          subtitle!,
                          style: webText(
                            context,
                            size: 12,
                            color: 'text.muted',
                          ),
                        ),
                      ),
                  ],
                ),
              ),
              if (trailing != null)
                trailing!
              else if (onTap != null)
                Icon(
                  LucideIcons.chevronRight,
                  size: 16,
                  color: palette(context)['text.muted'],
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class PushSettings extends StatefulWidget {
  const PushSettings({super.key, required this.controller});
  final LiveController controller;
  @override
  State<PushSettings> createState() => _PushSettingsState();
}

class _PushSettingsState extends State<PushSettings>
    with WidgetsBindingObserver {
  LiveController get c => widget.controller;
  Json prefs = {}, push = {}, permission = {}, server = {};
  String? error, actionError, actionStatus;
  bool loading = true, saving = false, actionBusy = false;
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    load();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) load();
  }

  Future<void> perform(Future<void> Function() action) async {
    if (actionBusy) return;
    setState(() {
      actionBusy = true;
      actionError = actionStatus = null;
    });
    try {
      await action();
    } catch (e) {
      if (mounted) setState(() => actionError = LiveController.describe(e));
    } finally {
      if (mounted) setState(() => actionBusy = false);
    }
  }

  Future<void> load() async {
    try {
      final values = await Future.wait([
        c.gateway.call('preferences'),
        c.gateway.call('pushStatus'),
        c.gateway.call('permissions'),
        c.gateway.request('/api/push'),
      ]);
      if (!mounted) return;
      setState(() {
        prefs = obj(values[0]);
        push = obj(values[1]);
        permission = obj(values[2]);
        server = obj(values[3]);
        error = null;
        loading = false;
      });
    } catch (e) {
      if (mounted) {
        setState(() {
          error = LiveController.describe(e);
          loading = false;
        });
      }
    }
  }

  Future<void> save(Json patch) async {
    if (saving) return;
    setState(() {
      saving = true;
      actionError = actionStatus = null;
    });
    try {
      await c.savePreferences(patch);
      if (mounted) setState(() => prefs = {...c.preferences});
    } catch (e) {
      if (mounted) setState(() => actionError = LiveController.describe(e));
    } finally {
      if (mounted) setState(() => saving = false);
    }
  }

  Widget group(String title, List<Widget> children, {bool divider = true}) =>
      AssistantSection(title: title, divider: divider, children: children);

  Widget toggle(
    String key,
    String title,
    String detail, {
    bool defaultValue = true,
  }) {
    final current = prefs[key] as bool? ?? defaultValue;
    final disabled = saving || actionBusy;
    final activate = disabled ? null : () => save({key: !current});
    return Padding(
      padding: const EdgeInsets.fromLTRB(8, 10, 0, 8),
      child: MergeSemantics(
        child: Row(
          children: [
            Expanded(
              child: InkWell(
                onTap: activate,
                borderRadius: BorderRadius.circular(8),
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 4),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        title,
                        style: webText(
                          context,
                          size: 13,
                          weight: FontWeight.w500,
                          color: 'text.secondary',
                        ),
                      ),
                      Padding(
                        padding: const EdgeInsets.only(top: 2),
                        child: Text(
                          detail,
                          style: webText(
                            context,
                            size: 12,
                            color: 'text.muted',
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
            const SizedBox(width: 12),
            Switch.adaptive(
              value: current,
              onChanged: disabled ? null : (value) => save({key: value}),
              activeTrackColor: palette(context)['accent.default'],
            ),
          ],
        ),
      ),
    );
  }

  String time(String key, int fallback) {
    final n = (prefs[key] as num?)?.toInt() ?? fallback;
    return '${(n ~/ 60).toString().padLeft(2, '0')}:${(n % 60).toString().padLeft(2, '0')}';
  }

  Future<void> chooseTime(String key, int fallback) async {
    final n = (prefs[key] as num?)?.toInt() ?? fallback;
    final picked = await showTimePicker(
      context: context,
      useRootNavigator: false,
      initialTime: TimeOfDay(hour: n ~/ 60, minute: n % 60),
    );
    if (picked != null) await save({key: picked.hour * 60 + picked.minute});
  }

  Future<void> mute() async {
    final selected = (prefs['muted'] as List? ?? []).map((e) => '$e').toSet();
    final result = await showModalBottomSheet<List<String>>(
      context: context,
      useSafeArea: true,
      isScrollControlled: true,
      builder: (sheet) => StatefulBuilder(
        builder: (sheet, update) => FractionallySizedBox(
          heightFactor: .7,
          child: Column(
            children: [
              Padding(
                padding: EdgeInsets.all(16),
                child: Text(
                  tr("依工作空間靜音"),
                  style: TextStyle(fontSize: 20, fontWeight: FontWeight.w600),
                ),
              ),
              Expanded(
                child: ListView(
                  children: [
                    for (final w in c.workspaces)
                      CheckboxListTile(
                        title: Text('${w['displayName']}'),
                        value: selected.contains(w['id']),
                        onChanged: (on) => update(() {
                          if (on == true) {
                            selected.add('${w['id']}');
                          } else {
                            selected.remove(w['id']);
                          }
                        }),
                      ),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.all(16),
                child: FinalButton(
                  onPressed: () => Navigator.pop(sheet, selected.toList()),
                  child: Text(tr("儲存")),
                ),
              ),
            ],
          ),
        ),
      ),
    );
    if (result != null) await save({'muted': result});
  }

  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    if (loading) return const SupportingLoading();
    return ColoredBox(
      color: palette(context)['surface.grouped'],
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 760),
          child: RefreshIndicator(
            onRefresh: load,
            child: ListView(
              padding: const EdgeInsets.fromLTRB(24, 16, 24, 24),
              children: [
                if (error != null)
                  SupportingState(
                    title: tr("部分設定無法載入"),
                    detail: error!,
                    onRetry: load,
                  ),
                if (actionError != null) WebNotice(actionError!, error: true),
                if (actionStatus != null) WebNotice(actionStatus!),
                group(tr("此手機"), [
                  _SettingsOptionRow(
                    title: permission['notifications'] == true
                        ? tr("通知權限已開啟")
                        : tr("通知權限未開啟"),
                    subtitle: push['state']?.toString() ?? tr("尚未註冊推播"),
                    icon: permission['notifications'] == true
                        ? LucideIcons.bell
                        : LucideIcons.bellOff,
                  ),
                  Wrap(
                    spacing: 4,
                    children: [
                      AssistantButton(
                        tr("啟用推播"),
                        onPressed: actionBusy
                            ? null
                            : () => perform(() async {
                                await c.gateway.call('pushEnable');
                                await load();
                              }),
                      ),
                      AssistantButton(
                        tr("停用推播"),
                        onPressed: actionBusy
                            ? null
                            : () => perform(() async {
                                await c.gateway.call('pushDisable');
                                await load();
                              }),
                      ),
                      AssistantButton(
                        tr("傳送測試"),
                        filled: true,
                        onPressed: actionBusy
                            ? null
                            : () => perform(() async {
                                final d = await c.gateway.request(
                                  '/api/push/test',
                                  method: 'POST',
                                  body: {},
                                );
                                if (mounted) {
                                  setState(
                                    () => actionStatus = tr("已送達 {0} 個目標", [
                                      d['delivered'] ?? 0,
                                    ]),
                                  );
                                }
                              }),
                      ),
                    ],
                  ),
                  if ((push['distributors'] as List? ?? []).isEmpty)
                    AssistantParagraph(
                      tr("請先安裝 UnifiedPush 推播服務（例如 ntfy），再啟用此手機推播。"),
                    ),
                ], divider: false),
                group(tr("通知類別"), [
                  toggle('q', tr("需要你回應"), tr("問題、確認與等待回覆")),
                  toggle('missed', tr("錯過的排程"), tr("需要你決定執行或略過")),
                  toggle('deleg', tr("委派的工作"), tr("其他對話交付的工作")),
                  toggle(
                    'mem',
                    tr("記憶提案"),
                    tr("助手想記住的新內容"),
                    defaultValue: false,
                  ),
                  toggle(
                    'done',
                    tr("工作完成或失敗"),
                    tr("通知此手機已連線對話的執行結果"),
                    defaultValue: false,
                  ),
                  toggle('live', tr("執行中的即時進度"), tr("顯示此手機已連線對話的目前步驟")),
                  _SettingsOptionRow(
                    title: tr("系統通知設定"),
                    subtitle: tr("聲音、震動與彈出方式"),
                    trailing: const Icon(LucideIcons.externalLink, size: 16),
                    onTap: actionBusy
                        ? null
                        : () => perform(
                            () async => c.gateway.call('notificationSettings'),
                          ),
                  ),
                ]),
                group(tr("樣式"), [
                  toggle(
                    'popup',
                    tr("下方快速回應視窗"),
                    permission['overlay'] == true
                        ? tr("從通知開啟，在其他 App 上層確認並回答")
                        : tr("尚未授權浮窗；通知仍可開啟完整對話"),
                  ),
                  if (permission['overlay'] != true)
                    _SettingsOptionRow(
                      title: tr("授權浮窗"),
                      subtitle: tr("顯示在其他應用程式上層"),
                      trailing: const Icon(LucideIcons.chevronRight, size: 16),
                      onTap: actionBusy
                          ? null
                          : () => perform(
                              () async => c.gateway.call('requestOverlay'),
                            ),
                    ),
                  toggle('rich', tr("大型互動通知"), tr("顯示最多三個選項；點選後仍須確認")),
                  toggle('recall', tr("處理後自動收回"), tr("收到最新狀態時，收回已處理的問題通知")),
                  Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(tr("鎖定畫面顯示")),
                        const SizedBox(height: 12),
                        Wrap(
                          spacing: 6,
                          children: [
                            for (final item in [
                              ('hide', tr("隱藏內容")),
                              ('summary', tr("只顯示標題")),
                              ('all', tr("全部顯示")),
                            ])
                              ChoiceChip(
                                label: Text(
                                  item.$2,
                                  style: webText(
                                    context,
                                    size: 12,
                                    color: (prefs['lock'] ?? 'hide') == item.$1
                                        ? 'accent.onSoft'
                                        : 'text.secondary',
                                  ),
                                ),
                                selected: (prefs['lock'] ?? 'hide') == item.$1,
                                onSelected: saving || actionBusy
                                    ? null
                                    : (_) => save({'lock': item.$1}),
                              ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ]),
                group(tr("勿擾與範圍"), [
                  toggle(
                    'quiet',
                    tr("勿擾時段"),
                    tr("{0}–{1} · 需要你回應仍會通知", [
                      time('start', 1380),
                      time('end', 450),
                    ]),
                    defaultValue: false,
                  ),
                  if (prefs['quiet'] == true) ...[
                    _SettingsOptionRow(
                      title: tr("開始時間"),
                      trailing: Text(
                        time('start', 1380),
                        style: webText(context, size: 13, color: 'text.muted'),
                      ),
                      onTap: actionBusy
                          ? null
                          : () => chooseTime('start', 1380),
                    ),
                    _SettingsOptionRow(
                      title: tr("結束時間"),
                      trailing: Text(
                        time('end', 450),
                        style: webText(context, size: 13, color: 'text.muted'),
                      ),
                      onTap: actionBusy ? null : () => chooseTime('end', 450),
                    ),
                  ],
                  _SettingsOptionRow(
                    title: tr("依工作空間靜音"),
                    subtitle: tr("已靜音 {0} 個", [
                      (prefs['muted'] as List? ?? []).length,
                    ]),
                    trailing: const Icon(LucideIcons.chevronRight, size: 16),
                    onTap: actionBusy ? null : mute,
                  ),
                ]),
                group(tr("推送目標"), [
                  if (rows(server['subscriptions']).isEmpty)
                    AssistantParagraph(tr("尚未設定推送目標")),
                  for (final target in rows(server['subscriptions']))
                    _SettingsOptionRow(
                      title: target['name']?.toString() ?? '',
                      subtitle:
                          '${target['host']} · ${target['failing'] == true ? '最近傳送失敗' : '已註冊'}',
                      trailing: IconButton(
                        tooltip: tr("移除目標"),
                        icon: const Icon(LucideIcons.trash2, size: 16),
                        onPressed: actionBusy
                            ? null
                            : () => perform(() async {
                                if (await confirm(
                                  context,
                                  tr("移除通知目標"),
                                  target['name']?.toString() ?? '',
                                )) {
                                  await c.gateway.request(
                                    '/api/push/subscriptions',
                                    method: 'DELETE',
                                    body: {'id': target['id']},
                                  );
                                  await load();
                                }
                              }),
                      ),
                    ),
                ]),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

String _date(dynamic value) => value is num
    ? DateTime.fromMillisecondsSinceEpoch(
        value.toInt(),
      ).toLocal().toString().split('.').first
    : '—';

class MemoryProposals extends StatelessWidget {
  const MemoryProposals({super.key, required this.controller});
  final LiveController controller;
  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    return SingleChildScrollView(
      padding: const EdgeInsets.all(20),
      child: MemorySettings(controller: controller),
    );
  }
}

class ActivityPage extends StatelessWidget {
  const ActivityPage({
    super.key,
    required this.controller,
    required this.theme,
  });
  final LiveController controller;
  final PircTheme theme;
  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    return RemotePage(
      load: () async {
        await controller.refreshList();
        final pending = <Json>[];
        final waiting = controller.sessions
            .where((s) => s['runStatus'] == 'waiting_input')
            .toList();
        for (var start = 0; start < waiting.length; start += 4) {
          await Future.wait(
            waiting.skip(start).take(4).map((session) async {
              try {
                final snapshot = obj(
                  await controller.gateway.call('refresh', {
                    'sessionId': session['id'],
                  }),
                );
                for (final q in rows(
                  snapshot['interactions'],
                ).where((q) => q['status'] == 'pending')) {
                  pending.add({
                    ...q,
                    'sessionId': session['id'],
                    'sessionName': session['name'],
                  });
                }
              } catch (_) {
                pending.add({
                  'title': tr("開啟對話確認狀態"),
                  'sessionId': session['id'],
                  'sessionName': session['name'],
                });
              }
            }),
          );
        }
        pending.sort(
          (a, b) => ((a['expiresAt'] as num?) ?? 9007199254740991).compareTo(
            (b['expiresAt'] as num?) ?? 9007199254740991,
          ),
        );
        final unavailable = <String>[];
        Future<Json> source(String path, String label) async {
          try {
            return await controller.gateway.request(path);
          } catch (_) {
            unavailable.add(label);
            return {};
          }
        }

        final responses = await Future.wait([
          source('/api/schedules', tr("排程")),
          source('/api/memory', tr("記憶提案")),
        ]);
        final data = responses[0], memory = responses[1];
        return {
          'unavailable': unavailable,
          'pending': pending,
          'schedules': data['schedules'],
          'proposals': memory['proposals'],
          'recent': await controller.gateway.call('activity'),
        };
      },
      builder: (context, data, reload) => ListView(
        padding: const EdgeInsets.all(20),
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  tr("待你處理"),
                  style: TextStyle(fontSize: 22, fontWeight: FontWeight.w600),
                ),
              ),
              IconButton(
                tooltip: tr("重新整理"),
                onPressed: reload,
                icon: const Icon(LucideIcons.refreshCw),
              ),
            ],
          ),
          if ((data['unavailable'] as List? ?? []).isNotEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 12),
              child: Text(
                tr("{0} 暫時無法載入，請重新整理。", [
                  (data['unavailable'] as List).join('、'),
                ]),
              ),
            ),
          if (rows(data['pending']).isEmpty &&
              !rows(
                data['schedules'],
              ).any((s) => (s['attention'] as num? ?? 0) > 0) &&
              !rows(data['proposals']).any((p) => p['status'] == 'pending'))
            Padding(
              padding: EdgeInsets.symmetric(vertical: 24),
              child: SupportingState(
                title: tr("目前沒有待處理項目"),
                detail: tr("需要你回答的問題與錯過排程會顯示在這裡。"),
              ),
            ),
          for (final s in rows(data['pending']))
            ListTile(
              leading: const Icon(LucideIcons.circleHelp),
              title: Text('${s['title']}'),
              subtitle: Text(
                '${s['sessionName']}${s['expiresAt'] == null ? '' : ' · 到期 ${_date(s['expiresAt'])}'}',
              ),
              onTap: () => guarded(context, () async {
                await controller.open('${s['sessionId']}');
                if (context.mounted) Navigator.pop(context);
              }),
            ),
          for (final s in rows(
            data['schedules'],
          ).where((s) => (s['attention'] as num? ?? 0) > 0))
            ListTile(
              leading: const Icon(LucideIcons.clock),
              title: Text('${s['title']}'),
              subtitle: Text(tr("{0} 次執行待處理", [s['attention']])),
              onTap: () => Navigator.push(
                context,
                MaterialPageRoute<void>(
                  builder: (_) => ScheduleDetailPage(
                    controller: controller,
                    id: '${s['id']}',
                  ),
                ),
              ),
            ),
          if (rows(data['proposals']).any((p) => p['status'] == 'pending'))
            ListTile(
              leading: const Icon(LucideIcons.brain),
              title: Text(tr("記憶提案")),
              onTap: () => Navigator.push(
                context,
                MaterialPageRoute<void>(
                  builder: (_) => ManagementPage(
                    kind: 'memory',
                    controller: controller,
                    theme: theme,
                  ),
                ),
              ),
            ),
          const SizedBox(height: 24),
          Text(
            tr("最近動態"),
            style: TextStyle(fontSize: 22, fontWeight: FontWeight.w600),
          ),
          Text(tr("此裝置收到的通知"), style: TextStyle(fontSize: 12)),
          for (final entry in rows(data['recent']))
            ListTile(
              title: Text('${entry['title']}'),
              subtitle: Text('${entry['body']}\n${_date(entry['at'])}'),
              onTap: entry['sessionId'] == null
                  ? null
                  : () => guarded(context, () async {
                      await controller.open('${entry['sessionId']}');
                      if (context.mounted) Navigator.pop(context);
                    }),
            ),
          if (rows(data['recent']).isEmpty)
            Padding(
              padding: EdgeInsets.symmetric(vertical: 20),
              child: Text(tr("尚未收到通知")),
            ),
        ],
      ),
    );
  }
}
