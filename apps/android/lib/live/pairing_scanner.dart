import '../l10n/app_i18n.dart';
import 'dart:async';
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'common.dart';
import 'gateway.dart';

/// A camera texture with Flutter controls and an APK-bundled Android decoder.
/// Pairing still goes through the original gateway link parser/transport.
class PairingScannerPage extends StatefulWidget {
  const PairingScannerPage({super.key, required this.gateway});
  final Gateway gateway;

  @override
  State<PairingScannerPage> createState() => _PairingScannerPageState();
}

class _PairingScannerPageState extends State<PairingScannerPage>
    with WidgetsBindingObserver {
  // A popped route may still be waiting for Android's permission response.
  // The next scanner must wait until that route releases the native camera.
  static Completer<void>? _cameraLease;
  final _release = Completer<void>();
  final camera = MobileScannerController(
    autoStart: false,
    formats: const [BarcodeFormat.qrCode],
    cameraResolution: const Size(1280, 720),
  );
  Future<void> _operations = Future.value();
  bool _closed = false;
  bool _active = true;
  bool _returned = false;
  String? _notice;

  @override
  void initState() {
    super.initState();
    final previous = _cameraLease;
    _operations = previous != null && !previous.isCompleted
        ? previous.future
        : Future.value();
    _cameraLease = _release;
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) => _syncCamera());
  }

  // Serialize start/stop, including an outstanding Android permission request.
  // After a late start, re-read visibility before leaving the camera running.
  void _syncCamera() {
    if (_closed) return;
    _operations = _operations
        .then((_) async {
          if (_closed) return;
          if (_active && !_returned) {
            await camera.start();
            if (_closed || !_active || _returned) await camera.stop();
          } else {
            await camera.stop();
          }
        })
        .catchError((Object _) {
          if (mounted && !_closed) {
            setState(() => _notice = tr("無法開啟相機，請重試或返回貼上配對連結。"));
          }
        });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _active = state == AppLifecycleState.resumed;
    // A permission prompt can deliver inactive/resumed while start is pending.
    // The queue lets that request finish before reconciliation.
    if (!camera.value.isStarting) _syncCamera();
  }

  void _detected(BarcodeCapture capture) {
    if (_closed ||
        _returned ||
        !mounted ||
        !_active ||
        ModalRoute.of(context)?.isCurrent != true) {
      return;
    }
    for (final barcode in capture.barcodes) {
      final raw = barcode.rawValue;
      if (raw == null) continue;
      var valid = false;
      try {
        final uri = Uri.tryParse(raw);
        valid =
            barcode.format == BarcodeFormat.qrCode &&
            uri?.scheme == 'pirc' &&
            uri?.host == 'pair' &&
            uri!.queryParameters['url']?.isNotEmpty == true &&
            uri.queryParameters['token']?.isNotEmpty == true;
      } on FormatException {
        // Malformed QR query text is rejected without exposing its contents.
      }
      if (!valid) {
        if (_notice == null) {
          setState(
            () => _notice = tr("這不是 pirc 配對 QR code，請掃描網頁「設定 → 裝置」顯示的配對碼。"),
          );
        }
        continue;
      }
      _returned = true;
      _syncCamera();
      Navigator.of(context).pop(raw);
      return;
    }
  }

  @override
  void dispose() {
    _closed = true;
    WidgetsBinding.instance.removeObserver(this);
    // A late permission response must complete before disposing native resources.
    unawaited(
      _operations
          .then((_) async {
            try {
              await camera.stop();
            } finally {
              await camera.dispose();
            }
          })
          .catchError((Object _) {})
          .whenComplete(() {
            _release.complete();
            if (identical(_cameraLease, _release)) _cameraLease = null;
          }),
    );
    super.dispose();
  }

  Widget _error(BuildContext context, MobileScannerException error) {
    final denied = error.errorCode == MobileScannerErrorCode.permissionDenied;
    return ColoredBox(
      color: palette(context)['surface.subtle'],
      child: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                denied ? LucideIcons.cameraOff : LucideIcons.scanLine,
                size: 40,
              ),
              const SizedBox(height: 16),
              Text(
                denied ? tr("需要相機權限才能掃描") : tr("無法開啟相機"),
                style: Theme.of(context).textTheme.titleMedium,
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 8),
              Text(
                denied
                    ? tr("只在掃描配對碼時使用相機。你也可以返回並貼上配對連結。")
                    : tr("請確認相機可用，或返回並貼上配對連結。"),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 16),
              FilledButton(onPressed: _syncCamera, child: Text(tr("重試"))),
              if (denied)
                TextButton(
                  onPressed: () => guarded(context, () async {
                    await widget.gateway.call('appSettings');
                  }),
                  child: Text(tr("前往系統設定")),
                ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    return Scaffold(
      appBar: AppBar(
        title: Text(tr("掃描配對碼")),
        leading: IconButton(
          tooltip: tr("取消掃描"),
          icon: const Icon(LucideIcons.x),
          onPressed: () => Navigator.of(context).pop(),
        ),
      ),
      body: SafeArea(
        child: Column(
          children: [
            Expanded(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(16),
                  child: MobileScanner(
                    controller: camera,
                    useAppLifecycleState: false,
                    fit: BoxFit.contain,
                    tapToFocus: true,
                    onDetect: _detected,
                    onDetectError: (_, _) {
                      if (mounted && !_closed) {
                        setState(() => _notice = tr("無法辨識配對碼，請重新對準。"));
                      }
                    },
                    errorBuilder: _error,
                    placeholderBuilder: (context) => ColoredBox(
                      color: palette(context)['surface.subtle'],
                      child: Center(child: Text(tr("正在開啟相機…"))),
                    ),
                  ),
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 24),
              child: Text(
                _notice ?? tr("將網頁「設定 → 裝置」的 QR code 放入畫面。"),
                textAlign: TextAlign.center,
              ),
            ),
            Padding(
              padding: const EdgeInsets.all(16),
              child: TextButton.icon(
                onPressed: () => Navigator.of(context).pop(),
                icon: const Icon(LucideIcons.link),
                label: Text(tr("返回貼上配對連結")),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
