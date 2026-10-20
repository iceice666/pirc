import '../l10n/app_i18n.dart';
import 'package:flutter/material.dart';

/// Flutter-rendered datalist suggestions above the Android software keyboard.
/// The child can suppress its anchored list while this strip is active.
class KeyboardSuggestions extends StatefulWidget {
  const KeyboardSuggestions({
    super.key,
    required this.controller,
    required this.focusNode,
    required this.options,
    required this.builder,
  });
  final TextEditingController controller;
  final FocusNode focusNode;
  final List<String> options;
  final Widget Function(BuildContext context, bool keyboardVisible) builder;

  @override
  State<KeyboardSuggestions> createState() => _KeyboardSuggestionsState();
}

class _KeyboardSuggestionsState extends State<KeyboardSuggestions>
    with WidgetsBindingObserver {
  final portal = OverlayPortalController();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    widget.controller.addListener(refresh);
    widget.focusNode.addListener(refresh);
    portal.show();
  }

  void refresh() {
    if (mounted) setState(() {});
  }

  @override
  void didChangeMetrics() => refresh();

  @override
  void didUpdateWidget(KeyboardSuggestions old) {
    super.didUpdateWidget(old);
    if (old.controller != widget.controller) {
      old.controller.removeListener(refresh);
      widget.controller.addListener(refresh);
    }
    if (old.focusNode != widget.focusNode) {
      old.focusNode.removeListener(refresh);
      widget.focusNode.addListener(refresh);
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    widget.controller.removeListener(refresh);
    widget.focusNode.removeListener(refresh);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    AppI18n.watch(context);
    // Scaffold removes viewInsets from its body MediaQuery. Read the view so
    // the strip still sits above the IME when the form resizes or scrolls.
    final view = View.of(context);
    final keyboard = view.viewInsets.bottom / view.devicePixelRatio;
    final visible = keyboard > 0 && widget.focusNode.hasFocus;
    final query = widget.controller.text.toLowerCase();
    final options = widget.options.where(
      (v) => v.toLowerCase().contains(query),
    );
    final dark = Theme.of(context).brightness == Brightness.dark;
    final labelStyle = TextStyle(
      fontFamily: Theme.of(context).textTheme.labelLarge?.fontFamily,
      fontSize: 16,
      fontWeight: FontWeight.w500,
    );
    final metrics = TextPainter(
      text: TextSpan(text: tr("Mg"), style: labelStyle),
      textDirection: Directionality.of(context),
      textScaler: MediaQuery.textScalerOf(context),
    )..layout();
    final stripHeight = (metrics.height.ceilToDouble() + 30).clamp(
      48.0,
      double.infinity,
    );
    metrics.dispose();
    return OverlayPortal(
      overlayLocation: OverlayChildLocation.rootOverlay,
      controller: portal,
      overlayChildBuilder: (context) {
        if (!visible || options.isEmpty) return const SizedBox.shrink();
        return Positioned(
          key: const ValueKey('keyboard-suggestions'),
          left: 0,
          right: 0,
          bottom: keyboard,
          height: stripHeight,
          child: TextFieldTapRegion(
            child: Material(
              color: dark ? const Color(0xff211f26) : const Color(0xfffaf8ff),
              elevation: 2,
              child: ListView.separated(
                scrollDirection: Axis.horizontal,
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
                itemCount: options.length,
                separatorBuilder: (_, _) => const SizedBox(width: 8),
                itemBuilder: (context, index) {
                  final option = options.elementAt(index);
                  return OutlinedButton(
                    key: ValueKey('keyboard-suggestion-$option'),
                    onPressed: () {
                      widget.controller.value = TextEditingValue(
                        text: option,
                        selection: TextSelection.collapsed(
                          offset: option.length,
                        ),
                      );
                    },
                    style: OutlinedButton.styleFrom(
                      foregroundColor: dark
                          ? const Color(0xffe6e1e9)
                          : const Color(0xff49454f),
                      side: BorderSide(
                        color: dark
                            ? const Color(0xff938f99)
                            : const Color(0xff929099),
                      ),
                      shape: const StadiumBorder(),
                      padding: const EdgeInsets.symmetric(horizontal: 16),
                      minimumSize: Size.zero,
                      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                      textStyle: labelStyle,
                    ),
                    child: Text(option, maxLines: 1),
                  );
                },
              ),
            ),
          ),
        );
      },
      child: widget.builder(context, visible),
    );
  }
}
