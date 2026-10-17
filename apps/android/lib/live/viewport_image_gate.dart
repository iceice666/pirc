import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';

/// Defers image-provider creation until the image approaches its scroll viewport.
/// Once started, scrolling away does not discard decoded image state.
class ViewportImageGate extends StatefulWidget {
  const ViewportImageGate({
    super.key,
    required this.placeholder,
    required this.builder,
    required this.preloadDistance,
  });
  final Widget placeholder;
  final WidgetBuilder builder;
  final double preloadDistance;

  @override
  State<ViewportImageGate> createState() => _ViewportImageGateState();
}

class _ViewportImageGateState extends State<ViewportImageGate> {
  final _anchor = GlobalKey();
  final _positions = <ScrollPosition>{};
  bool _active = false, _scheduled = false, _enabled = true;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _enabled = TickerMode.valuesOf(context).enabled;
    for (final position in _positions) {
      position.removeListener(_schedule);
    }
    _positions.clear();
    context.visitAncestorElements((element) {
      if (element is StatefulElement && element.state is ScrollableState) {
        _positions.add((element.state as ScrollableState).position);
      }
      return true;
    });
    for (final position in _positions) {
      position.addListener(_schedule);
    }
    _schedule();
  }

  void _schedule() {
    if (_active || _scheduled || !_enabled) return;
    _scheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _scheduled = false;
      if (!mounted || _active || !_enabled) return;
      final box = _anchor.currentContext?.findRenderObject();
      if (box is! RenderBox || !box.attached || !box.hasSize) return;
      if (_nearViewport(box)) setState(() => _active = true);
    });
  }

  bool _nearViewport(RenderBox box) {
    RenderObject? ancestor = box.parent;
    while (ancestor != null) {
      if (ancestor is RenderOffstage && ancestor.offstage) return false;
      if (ancestor is RenderAbstractViewport && ancestor is RenderBox) {
        final bounds = MatrixUtils.transformRect(
          box.getTransformTo(ancestor),
          Offset.zero & box.size,
        );
        if (!bounds.overlaps(
          ancestor.paintBounds.inflate(widget.preloadDistance),
        )) {
          return false;
        }
      } else if (ancestor is RenderView) {
        final bounds = MatrixUtils.transformRect(
          box.getTransformTo(null),
          Offset.zero & box.size,
        );
        final margin =
            widget.preloadDistance * ancestor.configuration.devicePixelRatio;
        return bounds.overlaps(ancestor.paintBounds.inflate(margin));
      }
      ancestor = ancestor.parent;
    }
    return false;
  }

  @override
  void didUpdateWidget(covariant ViewportImageGate oldWidget) {
    super.didUpdateWidget(oldWidget);
    _schedule();
  }

  @override
  void dispose() {
    for (final position in _positions) {
      position.removeListener(_schedule);
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => _ImageLayoutProbe(
    key: _anchor,
    onLayout: _schedule,
    child: _active ? widget.builder(context) : widget.placeholder,
  );
}

class _ImageLayoutProbe extends SingleChildRenderObjectWidget {
  const _ImageLayoutProbe({
    super.key,
    required this.onLayout,
    required super.child,
  });
  final VoidCallback onLayout;
  @override
  RenderObject createRenderObject(BuildContext context) =>
      _RenderImageLayoutProbe(onLayout);
  @override
  void updateRenderObject(
    BuildContext context,
    _RenderImageLayoutProbe renderObject,
  ) {
    renderObject.onLayout = onLayout;
  }
}

class _RenderImageLayoutProbe extends RenderProxyBox {
  _RenderImageLayoutProbe(this.onLayout);
  VoidCallback onLayout;
  @override
  void paint(PaintingContext context, Offset offset) {
    onLayout();
    super.paint(context, offset);
  }

  @override
  void performLayout() {
    super.performLayout();
    onLayout();
  }
}
