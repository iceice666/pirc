import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'common.dart';
import 'web_controls.dart';

class ComposerOption {
  const ComposerOption(
    this.value,
    this.label, [
    this.detail,
    this.icon,
    this.warning = false,
  ]);
  final String value, label;
  final String? detail;
  final IconData? icon;
  final bool warning;
}

/// Native anchored selector; keeps the selected value visible and restores focus.
class ComposerSelect extends StatefulWidget {
  const ComposerSelect({
    super.key,
    required this.label,
    required this.value,
    required this.options,
    required this.onSelect,
    this.disabled = false,
    this.foregroundColorKey = 'text.secondary',
  });
  final String label, value;
  final List<ComposerOption> options;
  final ValueChanged<String> onSelect;
  final bool disabled;
  final String foregroundColorKey;
  @override
  State<ComposerSelect> createState() => _ComposerSelectState();
}

class _ComposerSelectState extends State<ComposerSelect> {
  final menu = MenuController();
  final focus = FocusNode();
  @override
  void dispose() {
    focus.dispose();
    super.dispose();
  }

  @override
  void didUpdateWidget(covariant ComposerSelect oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.disabled && menu.isOpen) menu.close();
  }

  @override
  Widget build(BuildContext context) {
    final colors = palette(context), viewport = MediaQuery.sizeOf(context);
    final small = viewport.width <= 640;
    final selected = widget.options
        .where((o) => o.value == widget.value)
        .firstOrNull;
    return MenuAnchor(
      controller: menu,
      childFocusNode: focus,
      alignmentOffset: const Offset(0, -10),
      consumeOutsideTap: false,
      style: MenuStyle(
        alignment: Alignment.topLeft,
        backgroundColor: WidgetStatePropertyAll(colors['web.bg-layer']),
        surfaceTintColor: const WidgetStatePropertyAll(Colors.transparent),
        elevation: const WidgetStatePropertyAll(8),
        minimumSize: WidgetStatePropertyAll(
          Size(math.min(220, viewport.width - 32), 0),
        ),
        maximumSize: WidgetStatePropertyAll(
          Size(
            math.min(320, viewport.width - 32),
            math.min(400, viewport.height * .55),
          ),
        ),
        padding: const WidgetStatePropertyAll(EdgeInsets.all(6)),
        side: WidgetStatePropertyAll(
          BorderSide(color: colors['web.line-dark']),
        ),
        shape: WidgetStatePropertyAll(
          RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        ),
      ),
      menuChildren: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
          child: Text(
            widget.label,
            style: webText(
              context,
              size: 11,
              weight: FontWeight.w500,
              color: 'text.secondary',
            ),
          ),
        ),
        for (final option in widget.options)
          MenuItemButton(
            onPressed: () {
              menu.close();
              focus.requestFocus();
              if (option.value != widget.value) widget.onSelect(option.value);
            },
            style: MenuItemButton.styleFrom(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
              minimumSize: Size.zero,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(8),
              ),
            ),
            leadingIcon: option.icon == null
                ? null
                : Icon(
                    option.icon,
                    size: 18,
                    color: option.warning ? colors['status.danger'] : null,
                  ),
            trailingIcon: SizedBox(
              width: 15,
              child: option.value == widget.value
                  ? const Icon(LucideIcons.check, size: 15)
                  : null,
            ),
            child: Semantics(
              selected: option.value == widget.value,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    option.label,
                    style: webText(
                      context,
                      size: 13,
                      color: option.warning ? 'status.danger' : 'text.primary',
                    ),
                  ),
                  if (option.detail != null) ...[
                    const SizedBox(height: 3),
                    Text(
                      option.detail!,
                      style: webText(
                        context,
                        size: 11,
                        color: 'text.secondary',
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
      ],
      builder: (context, controller, child) => Tooltip(
        message: widget.label,
        child: TextButton(
          focusNode: focus,
          onPressed: widget.disabled || widget.options.isEmpty
              ? null
              : () {
                  controller.isOpen ? controller.close() : controller.open();
                  setState(() {});
                },
          style: TextButton.styleFrom(
            minimumSize: const Size(0, 34),
            maximumSize: const Size(double.infinity, 34),
            padding: EdgeInsets.symmetric(horizontal: small ? 5 : 8),
            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            foregroundColor: colors[widget.foregroundColorKey],
            backgroundColor: controller.isOpen
                ? colors['web.bg-hover']
                : Colors.transparent,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(8),
            ),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (selected?.icon != null) ...[
                Icon(
                  selected!.icon,
                  size: 15,
                  color: colors[widget.foregroundColorKey],
                ),
                const SizedBox(width: 6),
              ],
              Flexible(
                child: Text(
                  selected?.label ??
                      (widget.value.isEmpty ? widget.label : widget.value),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: webText(
                    context,
                    size: small ? 12 : 13,
                    color: widget.foregroundColorKey,
                  ).copyWith(height: kTextHeightNone),
                ),
              ),
              const SizedBox(width: 6),
              const Icon(LucideIcons.chevronDown, size: 13),
            ],
          ),
        ),
      ),
    );
  }
}
