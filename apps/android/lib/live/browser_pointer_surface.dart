import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';

/// Adapts touch gestures to the browser's existing mouse/wheel protocol.
/// Touch scrolls by default; drag mode and mouse/stylus retain pointer dragging.
class BrowserPointerSurface extends StatefulWidget {
  const BrowserPointerSurface({
    super.key,
    required this.enabled,
    required this.scope,
    required this.remoteSize,
    required this.onMessage,
    required this.onKeyboard,
    required this.child,
    this.touchDrag = false,
  });
  final bool enabled, touchDrag;
  final Object scope;
  final Size remoteSize;
  final ValueChanged<Map<String, dynamic>> onMessage;
  final VoidCallback onKeyboard;
  final Widget child;

  @override
  State<BrowserPointerSurface> createState() => _BrowserPointerSurfaceState();
}

class _BrowserPointerSurfaceState extends State<BrowserPointerSurface> {
  int? pointer;
  Offset start = Offset.zero, last = Offset.zero;
  bool scrollTouch = false, scrolling = false, pressed = false;
  String button = 'left';
  Duration? lastHover, lastClickTime;
  Offset? lastClickPosition;
  String? lastClickButton;
  int clickCount = 1;
  bool moved = false;

  @override
  void didUpdateWidget(BrowserPointerSurface oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.scope != widget.scope ||
        oldWidget.enabled != widget.enabled ||
        oldWidget.touchDrag != widget.touchDrag ||
        oldWidget.remoteSize != widget.remoteSize) {
      // Never finish an old gesture in a new session/control generation.
      if (pressed && oldWidget.scope == widget.scope && widget.enabled) {
        mouse('up', last);
      }
      reset();
      clearClicks();
    }
  }

  void clearClicks() {
    lastClickTime = null;
    lastClickPosition = null;
    lastClickButton = null;
    clickCount = 1;
  }

  void countClick(Duration time, Offset position) {
    final elapsed = lastClickTime == null ? null : time - lastClickTime!;
    clickCount =
        elapsed != null &&
            elapsed >= Duration.zero &&
            elapsed <= kDoubleTapTimeout &&
            lastClickButton == button &&
            (position - lastClickPosition!).distance <= kTouchSlop
        ? clickCount + 1
        : 1;
  }

  void rememberClick(Duration time, Offset position) {
    lastClickTime = time;
    lastClickPosition = position;
    lastClickButton = button;
  }

  void reset() {
    pointer = null;
    pressed = scrolling = scrollTouch = false;
    lastHover = null;
  }

  Map<String, int> point(Offset position) {
    final box = context.findRenderObject()! as RenderBox;
    return {
      'x': (position.dx / box.size.width * widget.remoteSize.width)
          .round()
          .clamp(0, widget.remoteSize.width.toInt() - 1),
      'y': (position.dy / box.size.height * widget.remoteSize.height)
          .round()
          .clamp(0, widget.remoteSize.height.toInt() - 1),
    };
  }

  void mouse(String action, Offset position) {
    if (!widget.enabled) return;
    widget.onMessage({
      'type': 'mouse',
      'action': action,
      ...point(position),
      if (action != 'move') 'button': button,
      if (action != 'move') 'clickCount': clickCount,
    });
  }

  void down(PointerDownEvent event) {
    if (!widget.enabled || pointer != null) return;
    pointer = event.pointer;
    start = last = event.localPosition;
    moved = false;
    button = event.buttons & kMiddleMouseButton != 0
        ? 'middle'
        : event.buttons & kSecondaryMouseButton != 0
        ? 'right'
        : 'left';
    scrollTouch = event.kind == PointerDeviceKind.touch && !widget.touchDrag;
    if (!scrollTouch) {
      countClick(event.timeStamp, start);
      pressed = true;
      widget.onKeyboard();
      mouse('down', start);
    }
  }

  void move(PointerMoveEvent event) {
    if (!widget.enabled || pointer != event.pointer) return;
    final position = event.localPosition;
    moved = moved || (position - start).distance > kTouchSlop;
    if (scrollTouch) {
      if (!scrolling && (position - start).distance <= kTouchSlop) return;
      scrolling = true;
      final box = context.findRenderObject()! as RenderBox;
      final delta = last - position;
      widget.onMessage({
        'type': 'wheel',
        ...point(start),
        'dx': delta.dx * widget.remoteSize.width / box.size.width,
        'dy': delta.dy * widget.remoteSize.height / box.size.height,
      });
    } else {
      mouse('move', position);
    }
    last = position;
  }

  void up(PointerUpEvent event) {
    if (pointer != event.pointer) return;
    if (widget.enabled) {
      if (scrollTouch && !scrolling) {
        countClick(event.timeStamp, event.localPosition);
        widget.onKeyboard();
        mouse('down', event.localPosition);
        mouse('up', event.localPosition);
      } else if (pressed) {
        mouse('up', event.localPosition);
      }
      if (!scrolling && !moved) {
        rememberClick(event.timeStamp, event.localPosition);
      } else {
        clearClicks();
      }
    }
    reset();
  }

  void cancel(PointerCancelEvent event) {
    if (pointer != event.pointer) return;
    if (pressed) mouse('up', last);
    reset();
    clearClicks();
  }

  @override
  Widget build(BuildContext context) => Listener(
    onPointerDown: down,
    onPointerMove: move,
    onPointerUp: up,
    onPointerCancel: cancel,
    onPointerHover: (event) {
      if (lastHover != null &&
          event.timeStamp - lastHover! < const Duration(milliseconds: 50)) {
        return;
      }
      lastHover = event.timeStamp;
      mouse('move', event.localPosition);
    },
    onPointerSignal: (event) {
      if (!widget.enabled || event is! PointerScrollEvent) return;
      GestureBinding.instance.pointerSignalResolver.register(event, (_) {
        if (mounted && widget.enabled) {
          widget.onMessage({
            'type': 'wheel',
            ...point(event.localPosition),
            'dx': event.scrollDelta.dx,
            'dy': event.scrollDelta.dy,
          });
        }
      });
    },
    child: RawGestureDetector(
      behavior: HitTestBehavior.opaque,
      gestures: widget.enabled
          ? {
              EagerGestureRecognizer:
                  GestureRecognizerFactoryWithHandlers<EagerGestureRecognizer>(
                    () => EagerGestureRecognizer(),
                    (_) {},
                  ),
            }
          : const {},
      child: widget.child,
    ),
  );
}
