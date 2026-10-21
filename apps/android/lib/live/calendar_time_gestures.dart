import 'package:flutter/material.dart';

/// Pointer edits only produce a draft; the calendar opens its normal editor
/// before making any request. Ordinary vertical swipes keep scrolling the page.
class CalendarTimeGestures extends StatefulWidget {
  const CalendarTimeGestures({
    super.key,
    required this.child,
    required this.onMove,
    required this.onResize,
    required this.resizeLabel,
    required this.handleColor,
    this.canResize = true,
  });

  final Widget child;
  final ValueChanged<Offset> onMove;
  final ValueChanged<double> onResize;
  final String resizeLabel;
  final Color handleColor;
  final bool canResize;

  @override
  State<CalendarTimeGestures> createState() => _CalendarTimeGesturesState();
}

class _CalendarTimeGesturesState extends State<CalendarTimeGestures> {
  Offset? _origin;
  double _resize = 0;
  bool _cancelled = false;

  @override
  Widget build(BuildContext context) => Listener(
    onPointerDown: (_) => _cancelled = false,
    onPointerCancel: (_) => _cancelled = true,
    child: LayoutBuilder(
      builder: (context, bounds) => LongPressDraggable<Object>(
        maxSimultaneousDrags: 1,
        onDragStarted: () {
          _origin = (context.findRenderObject()! as RenderBox).localToGlobal(
            Offset.zero,
          );
        },
        onDragEnd: (details) {
          final origin = _origin;
          _origin = null;
          if (origin == null || _cancelled) return;
          final delta = details.offset - origin;
          if (delta.distance > 4) widget.onMove(delta);
        },
        feedback: Material(
          color: Colors.transparent,
          elevation: 4,
          borderRadius: BorderRadius.circular(6),
          child: SizedBox(
            width: bounds.maxWidth,
            height: bounds.maxHeight,
            child: widget.child,
          ),
        ),
        childWhenDragging: Opacity(opacity: .3, child: widget.child),
        child: Stack(
          fit: StackFit.expand,
          children: [
            widget.child,
            if (widget.canResize)
              Positioned(
                bottom: 0,
                left: 0,
                right: 0,
                height: 18,
                child: Semantics(
                  label: widget.resizeLabel,
                  child: GestureDetector(
                    key: const ValueKey('calendar-resize-handle'),
                    behavior: HitTestBehavior.opaque,
                    onVerticalDragStart: (_) => _resize = 0,
                    onVerticalDragUpdate: (details) =>
                        _resize += details.delta.dy,
                    onVerticalDragEnd: (_) {
                      final delta = _resize;
                      _resize = 0;
                      if (delta.abs() > 4) widget.onResize(delta);
                    },
                    onVerticalDragCancel: () => _resize = 0,
                    child: Align(
                      alignment: Alignment.bottomCenter,
                      child: Container(
                        width: 18,
                        height: 3,
                        margin: const EdgeInsets.only(bottom: 2),
                        decoration: BoxDecoration(
                          color: widget.handleColor,
                          borderRadius: BorderRadius.circular(2),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    ),
  );
}

/// The grid is 56 px per hour. Snap edits to a quarter hour, including backwards
/// moves. Day arithmetic uses date-only UTC carriers, never the device zone.
int calendarDragMinutes(double pixels) => (pixels / 56 * 4).round() * 15;
