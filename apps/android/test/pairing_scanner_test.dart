import 'dart:async';
import 'dart:collection';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
// ignore: depend_on_referenced_packages
import 'package:plugin_platform_interface/plugin_platform_interface.dart';
import 'package:pirc_mobile/live/gateway.dart';
import 'package:pirc_mobile/live/pairing_scanner.dart';
import 'package:pirc_mobile/theme.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late MobileScannerPlatform originalPlatform;
  late _FakeMobileScannerPlatform platform;

  setUp(() {
    originalPlatform = MobileScannerPlatform.instance;
    platform = _FakeMobileScannerPlatform();
    MobileScannerPlatform.instance = platform;
    MobileScannerController.resetPlatformSessionOwner();
  });

  tearDown(() async {
    MobileScannerPlatform.instance = originalPlatform;
    MobileScannerController.resetPlatformSessionOwner();
    await platform.close();
  });

  testWidgets('invalid QR is rejected and valid pairing URI returns once', (
    tester,
  ) async {
    final gateway = _ScannerGateway();
    final results = <String?>[];
    final navigatorKey = GlobalKey<NavigatorState>();
    await tester.pumpWidget(_scannerHost(navigatorKey, gateway, results));
    await _openScanner(tester);

    expect(platform.startCalls, 1);
    expect(platform.hasBarcodeListener, isTrue);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pumpAndSettle();
    platform.emit(
      const BarcodeCapture(
        barcodes: [
          Barcode(
            format: BarcodeFormat.qrCode,
            rawValue: 'https://example.test/not-a-pairing-code',
          ),
        ],
      ),
    );
    await tester.pumpAndSettle();
    expect(
      find.text('這不是 pirc 配對 QR code，請掃描網頁「設定 → 裝置」顯示的配對碼。'),
      findsOneWidget,
    );
    expect(results, isEmpty);

    platform.emit(
      const BarcodeCapture(
        barcodes: [
          Barcode(
            format: BarcodeFormat.qrCode,
            rawValue: 'pirc://pair?url=%FF&token=x',
          ),
        ],
      ),
    );
    await tester.pumpAndSettle();
    expect(results, isEmpty);
    expect(tester.takeException(), isNull);

    const valid =
        'pirc://pair?url=https%3A%2F%2Fgateway.example&token=test-token';
    const validCapture = BarcodeCapture(
      barcodes: [Barcode(format: BarcodeFormat.qrCode, rawValue: valid)],
    );
    platform.emit(validCapture);
    platform.emit(validCapture);
    await tester.pumpAndSettle();

    expect(results, [valid]);
    expect(platform.startCalls, 1);
    expect(platform.stopCalls, 1);
    expect(platform.disposeCalls, 1);
  });

  testWidgets('permission denial has retry and settings actions', (
    tester,
  ) async {
    platform.enqueueStart(() async {
      throw const MobileScannerException(
        errorCode: MobileScannerErrorCode.permissionDenied,
      );
    });
    final gateway = _ScannerGateway();
    final results = <String?>[];
    final navigatorKey = GlobalKey<NavigatorState>();
    await tester.pumpWidget(_scannerHost(navigatorKey, gateway, results));
    await _openScanner(tester);

    expect(platform.startCalls, 1);
    expect(find.text('需要相機權限才能掃描'), findsOneWidget);
    expect(find.text('只在掃描配對碼時使用相機。你也可以返回並貼上配對連結。'), findsOneWidget);
    expect(find.text('重試'), findsOneWidget);
    expect(find.text('前往系統設定'), findsOneWidget);

    await tester.tap(find.text('前往系統設定'));
    await tester.pumpAndSettle();
    expect(gateway.calls, ['appSettings']);

    await tester.tap(find.text('重試'));
    await tester.pumpAndSettle();
    expect(platform.startCalls, 2);
    expect(find.text('需要相機權限才能掃描'), findsNothing);

    await tester.tap(find.byTooltip('取消掃描'));
    await tester.pumpAndSettle();
    expect(results, [null]);
  });

  testWidgets(
    'cancel during a pending start stops and disposes after it settles',
    (tester) async {
      final startCompleter = Completer<MobileScannerViewAttributes>();
      platform.enqueueStart(() => startCompleter.future);
      final gateway = _ScannerGateway();
      final results = <String?>[];
      final navigatorKey = GlobalKey<NavigatorState>();
      await tester.pumpWidget(_scannerHost(navigatorKey, gateway, results));
      await tester.tap(find.text('Open scanner'));
      await tester.pumpAndSettle();

      expect(platform.startCalls, 1);
      expect(platform.stopCalls, 0);
      expect(platform.disposeCalls, 0);

      await tester.tap(find.byTooltip('取消掃描'));
      await tester.pump();
      expect(results, [null]);
      expect(platform.stopCalls, 0);
      expect(platform.disposeCalls, 0);

      startCompleter.complete(_cameraAttributes);
      await tester.pumpAndSettle();
      expect(platform.stopCalls, 1);
      expect(platform.disposeCalls, 1);
    },
  );

  testWidgets('immediate reopen waits for cancelled permission/start cleanup', (
    tester,
  ) async {
    final firstStart = Completer<MobileScannerViewAttributes>();
    platform.enqueueStart(() => firstStart.future);
    final gateway = _ScannerGateway();
    final results = <String?>[];
    final navigatorKey = GlobalKey<NavigatorState>();
    await tester.pumpWidget(_scannerHost(navigatorKey, gateway, results));

    await tester.tap(find.text('Open scanner'));
    await tester.pumpAndSettle();
    expect(platform.startCalls, 1);

    await tester.tap(find.byTooltip('取消掃描'));
    await tester.pump();
    expect(results, [null]);

    await tester.tap(find.text('Open scanner'));
    await tester.pumpAndSettle();
    expect(
      platform.startCalls,
      1,
      reason: 'the new route must wait for the old camera start to settle',
    );
    expect(platform.stopCalls, 0);
    expect(platform.disposeCalls, 0);

    firstStart.complete(_cameraAttributes);
    await tester.pumpAndSettle();
    expect(platform.startCalls, 2);
    expect(platform.stopCalls, 1);
    expect(platform.disposeCalls, 1);

    await tester.tap(find.byTooltip('取消掃描'));
    await tester.pumpAndSettle();
    expect(results, [null, null]);
    expect(platform.stopCalls, 2);
    expect(platform.disposeCalls, 2);
  });

  testWidgets('background stops camera and resume restarts it', (tester) async {
    final gateway = _ScannerGateway();
    final results = <String?>[];
    final navigatorKey = GlobalKey<NavigatorState>();
    await tester.pumpWidget(_scannerHost(navigatorKey, gateway, results));
    await _openScanner(tester);

    expect(platform.startCalls, 1);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    await tester.pumpAndSettle();
    expect(platform.stopCalls, 1);

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pumpAndSettle();
    expect(platform.startCalls, 2);

    await tester.tap(find.byTooltip('取消掃描'));
    await tester.pumpAndSettle();
    expect(results, [null]);
    expect(platform.stopCalls, 2);
    expect(platform.disposeCalls, 1);
  });
}

const _cameraAttributes = MobileScannerViewAttributes(
  cameraDirection: CameraFacing.back,
  currentTorchMode: TorchState.unavailable,
  size: Size(320, 240),
  numberOfCameras: 1,
);

Widget _scannerHost(
  GlobalKey<NavigatorState> navigatorKey,
  _ScannerGateway gateway,
  List<String?> results,
) {
  return MaterialApp(
    navigatorKey: navigatorKey,
    theme: ThemeData(
      extensions: const [
        PircColors({'surface.subtle': Color(0xffeeeeee)}),
      ],
    ),
    home: Scaffold(
      body: Builder(
        builder: (context) => Center(
          child: TextButton(
            onPressed: () async {
              final result = await Navigator.of(context).push<String>(
                MaterialPageRoute(
                  builder: (_) => PairingScannerPage(gateway: gateway),
                ),
              );
              results.add(result);
            },
            child: const Text('Open scanner'),
          ),
        ),
      ),
    ),
  );
}

Future<void> _openScanner(WidgetTester tester) async {
  await tester.tap(find.text('Open scanner'));
  await tester.pumpAndSettle();
}

class _ScannerGateway extends Gateway {
  final calls = <String>[];

  @override
  Future<dynamic> call(String method, [Json args = const {}]) async {
    calls.add(method);
    return null;
  }
}

class _FakeMobileScannerPlatform extends MobileScannerPlatform
    with MockPlatformInterfaceMixin {
  final _barcodeEvents = StreamController<BarcodeCapture?>.broadcast(
    sync: true,
  );
  final _startResponses =
      Queue<Future<MobileScannerViewAttributes> Function()>();
  int startCalls = 0;
  int stopCalls = 0;
  int disposeCalls = 0;
  bool get hasBarcodeListener => _barcodeEvents.hasListener;

  void enqueueStart(Future<MobileScannerViewAttributes> Function() response) {
    _startResponses.add(response);
  }

  void emit(BarcodeCapture capture) => _barcodeEvents.add(capture);

  @override
  Stream<BarcodeCapture?> get barcodesStream => _barcodeEvents.stream;

  @override
  Stream<TorchState> get torchStateStream =>
      Stream.value(TorchState.unavailable);

  @override
  Stream<double> get zoomScaleStateStream => Stream.value(1);

  @override
  Future<MobileScannerViewAttributes> start(StartOptions startOptions) {
    startCalls++;
    if (_startResponses.isNotEmpty) return _startResponses.removeFirst()();
    return Future.value(_cameraAttributes);
  }

  @override
  Widget buildCameraView() => const ColoredBox(color: Colors.black);

  @override
  Future<void> stop() async {
    stopCalls++;
  }

  @override
  Future<void> updateScanWindow(Rect? window) async {}

  @override
  Future<void> dispose() async {
    disposeCalls++;
  }

  Future<void> close() => _barcodeEvents.close();
}
