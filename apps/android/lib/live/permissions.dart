import '../l10n/app_i18n.dart';
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'gateway.dart';
import 'common.dart';
import 'assistant_settings.dart';
import 'web_controls.dart';

/// Read OS truth on every return from Settings; opening Settings is not approval.
class PermissionPage extends StatefulWidget {
  const PermissionPage({super.key, required this.gateway, this.onComplete});
  final Gateway gateway;
  final Future<void> Function()? onComplete;
  @override
  State<PermissionPage> createState() => _PermissionPageState();
}

class _PermissionPageState extends State<PermissionPage>
    with WidgetsBindingObserver {
  Json? permissions;
  bool busy = false;
  String? error;
  int _refreshRevision = 0;
  bool get firstRun => widget.onComplete != null;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    refresh();
  }

  @override
  void dispose() {
    ++_refreshRevision;
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) refresh();
  }

  Future<void> refresh() async {
    final revision = ++_refreshRevision;
    try {
      final next = obj(await widget.gateway.call('permissions'));
      if (mounted && revision == _refreshRevision) {
        setState(() {
          permissions = next;
          error = null;
        });
      }
    } catch (e) {
      if (mounted && revision == _refreshRevision) {
        setState(() => error = LiveController.describe(e));
      }
    }
  }

  Future<void> request(String method) async {
    if (busy) return;
    setState(() {
      busy = true;
      error = null;
    });
    try {
      await widget.gateway.call(method);
      await refresh();
    } catch (e) {
      if (mounted) setState(() => error = LiveController.describe(e));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> finish() async {
    if (busy) return;
    setState(() => busy = true);
    try {
      await widget.gateway.call('completeOnboarding');
      await widget.onComplete!();
    } catch (e) {
      if (mounted) setState(() => error = LiveController.describe(e));
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Widget permissionCard(
    String name,
    String title,
    String detail,
    String fallback,
    IconData icon,
    String method, {
    bool divider = false,
  }) {
    final granted = permissions?[name] == true;
    final action =
        name == 'notifications' && permissions?['notificationSettings'] == true
        ? tr("前往系統設定")
        : tr("開啟{0}", [title]);
    return AssistantSection(
      title: title,
      divider: divider,
      children: [
        Padding(
          padding: const EdgeInsets.only(top: 8),
          child: Row(
            children: [
              Icon(icon, size: 16, color: palette(context)['text.muted']),
              const Spacer(),
              Icon(
                granted ? LucideIcons.circleCheck : LucideIcons.circle,
                size: 16,
                color: granted
                    ? palette(context)['text.success']
                    : palette(context)['text.muted'],
              ),
            ],
          ),
        ),
        AssistantParagraph(detail),
        AssistantParagraph(fallback),
        Padding(
          padding: const EdgeInsets.only(top: 10),
          child: Wrap(
            spacing: 12,
            runSpacing: 8,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              Text(
                permissions == null
                    ? tr("正在確認…")
                    : granted
                    ? tr("已開啟")
                    : tr("尚未開啟"),
                key: Key('permission-status-$name'),
                style: webText(
                  context,
                  size: 13,
                  weight: FontWeight.w500,
                  color: granted ? 'text.success' : 'text.secondary',
                ),
              ),
              if (!granted)
                AssistantButton(
                  action,
                  key: Key('permission-$name'),
                  filled: true,
                  onPressed: busy || permissions == null
                      ? null
                      : () => request(method),
                ),
            ],
          ),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    return Scaffold(
      backgroundColor: palette(context)['surface.grouped'],
      appBar: AppBar(
        title: Text(firstRun ? tr("歡迎使用 pirc") : tr("權限與快速回應")),
        backgroundColor: palette(context)['surface.grouped'],
      ),
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 760),
            child: ListView(
              padding: const EdgeInsets.fromLTRB(24, 24, 24, 32),
              children: [
                Text(
                  firstRun ? tr("讓重要的回應找得到你") : tr("依照你的使用方式設定"),
                  style: webText(
                    context,
                    size: 24,
                    weight: FontWeight.w600,
                    color: 'text.primary',
                  ).copyWith(height: 32 / 24),
                ),
                const SizedBox(height: 8),
                Text(
                  firstRun
                      ? tr("通知和快速回應浮窗只在使用相關功能時需要。你可以現在開啟，也可以先開始使用，稍後再到設定調整。")
                      : tr("只開啟你會使用的功能。系統權限可隨時從 Android 設定修改。"),
                  style: webText(
                    context,
                    size: 13,
                    color: 'text.muted',
                  ).copyWith(height: 1.55),
                ),
                const SizedBox(height: 24),
                permissionCard(
                  'notifications',
                  tr("通知"),
                  tr("此 App 可用通知提醒你工作完成、執行失敗，或 agent 等待你回覆。"),
                  tr("未開啟時，仍可在 App 內查看工作和待處理問題。"),
                  LucideIcons.bell,
                  'requestNotifications',
                ),
                permissionCard(
                  'overlay',
                  tr("快速回應浮窗"),
                  tr("允許在其他 App 上層開啟小視窗，讓你查看問題並回覆。"),
                  tr(
                    "此權限只用於你主動使用快速回應；未開啟時，通知仍會打開完整對話。Android 權限名稱為「顯示在其他應用程式上層」。",
                  ),
                  LucideIcons.panelsTopLeft,
                  'requestOverlay',
                  divider: true,
                ),
                AssistantParagraph(
                  tr("若使用內建相機掃描配對碼，會在開啟掃描頁時請求相機權限；拒絕後仍可貼上配對連結。"),
                ),
                AssistantParagraph(
                  tr("背景推播需在配對後，到「設定 → 推播與通知目標」完成服務註冊。開啟系統通知權限不代表推播服務已連線。"),
                ),
                if (error != null) ...[
                  WebNotice(error!, error: true),
                  AssistantButton(
                    tr("重新確認權限"),
                    onPressed: busy ? null : refresh,
                  ),
                ],
                const SizedBox(height: 24),
                if (firstRun)
                  FinalButton(
                    key: const Key('finish-onboarding'),
                    onPressed: busy ? null : finish,
                    child: Text(
                      busy
                          ? tr("處理中…")
                          : permissions?['notifications'] == true &&
                                permissions?['overlay'] == true
                          ? tr("開始使用")
                          : tr("先開始使用，稍後設定"),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
