import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'schedule_picker_value.dart';

/// Returns null on cancel, an empty string on Clear, or a wall-time value.
Future<String?> showScheduleDateTimePicker(
  BuildContext context,
  String initial,
) {
  final value = SchedulePickerValue.parse(initial);
  if (value == null) throw ArgumentError.value(initial, 'initial');
  return showDialog<String>(
    context: context,
    useRootNavigator: false,
    builder: (_) => ScheduleDateTimePicker(initial: value),
  );
}

class ScheduleDateTimePicker extends StatefulWidget {
  const ScheduleDateTimePicker({super.key, required this.initial});
  final SchedulePickerValue initial;
  @override
  State<ScheduleDateTimePicker> createState() => _ScheduleDateTimePickerState();
}

class _ScheduleDateTimePickerState extends State<ScheduleDateTimePicker> {
  late SchedulePickerValue value = widget.initial;
  final wheels = <String, GlobalKey<_DateTimeWheelState>>{};
  String? error;
  static const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  Widget wheel(
    String name,
    int selected,
    int min,
    int max,
    ValueChanged<int> change, {
    List<String>? labels,
  }) => Expanded(
    child: _DateTimeWheel(
      key: wheels.putIfAbsent(name, () => GlobalKey<_DateTimeWheelState>()),
      name: name,
      value: selected,
      min: min,
      max: max,
      labels: labels,
      onChanged: (next) => setState(() {
        change(next);
        error = null;
      }),
    ),
  );
  void accept() {
    var valid = true;
    for (final key in wheels.values) {
      if (key.currentState?.commit() == false) valid = false;
    }
    if (!valid) {
      setState(() => error = 'Enter a valid date and time.');
      return;
    }
    Navigator.pop(context, value.wallTime);
  }

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    final foreground = dark ? const Color(0xffe6e1e9) : const Color(0xff1d1b20);
    final action = dark ? const Color(0xffb3c5ff) : const Color(0xff4b6197);
    final use24 = MediaQuery.alwaysUse24HourFormatOf(context);
    Widget group(List<Widget> children) => SizedBox(
      height: 212,
      child: Center(
        child: SizedBox(width: 256, child: Row(children: children)),
      ),
    );
    Widget button(String name, VoidCallback callback) => TextButton(
      onPressed: callback,
      style: TextButton.styleFrom(
        foregroundColor: action,
        minimumSize: const Size(64, 48),
        textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w500),
      ),
      child: Text(name),
    );
    return Dialog(
      insetPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 24),
      backgroundColor: dark ? const Color(0xff211f26) : const Color(0xfffaf7ff),
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(24)),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 560),
        child: SingleChildScrollView(
          child: DefaultTextStyle(
            style: TextStyle(color: foreground, fontSize: 16),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(24, 20, 24, 0),
                  child: Semantics(
                    namesRoute: true,
                    header: true,
                    child: const Text(
                      'Set date and time',
                      style: TextStyle(fontSize: 22, height: 1.3),
                    ),
                  ),
                ),
                group([
                  wheel(
                    'Month',
                    value.month,
                    1,
                    12,
                    (v) => value = value.withMonth(v),
                    labels: months,
                  ),
                  const SizedBox(width: 16),
                  wheel(
                    'Day',
                    value.day,
                    1,
                    value.daysInMonth,
                    (v) => value = value.withDay(v),
                  ),
                  const SizedBox(width: 16),
                  wheel(
                    'Year',
                    value.year,
                    1,
                    275760,
                    (v) => value = value.withYear(v),
                  ),
                ]),
                group([
                  wheel(
                    'Hour',
                    use24 ? value.hour : value.hour12,
                    use24 ? 0 : 1,
                    use24 ? 23 : 12,
                    (v) =>
                        value = use24 ? value.withHour(v) : value.withHour12(v),
                  ),
                  const SizedBox(width: 16, child: Center(child: Text(':'))),
                  wheel(
                    'Minute',
                    value.minute,
                    0,
                    59,
                    (v) => value = value.withMinute(v),
                  ),
                  const SizedBox(width: 16),
                  if (!use24)
                    wheel(
                      'Period',
                      value.isPm ? 1 : 0,
                      0,
                      1,
                      (v) => value = value.withPeriod(v == 1),
                      labels: const ['AM', 'PM'],
                    )
                  else
                    const Expanded(child: SizedBox()),
                ]),
                if (error != null)
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 24),
                    child: Semantics(
                      liveRegion: true,
                      child: Text(
                        error!,
                        style: TextStyle(
                          color: Theme.of(context).colorScheme.error,
                        ),
                      ),
                    ),
                  ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                  child: Row(
                    children: [
                      button('Clear', () => Navigator.pop(context, '')),
                      const Spacer(),
                      button('Cancel', () => Navigator.pop(context)),
                      button('Set', accept),
                    ],
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

class _DateTimeWheel extends StatefulWidget {
  const _DateTimeWheel({
    super.key,
    required this.name,
    required this.value,
    required this.min,
    required this.max,
    required this.onChanged,
    this.labels,
  });
  final String name;
  final int value, min, max;
  final List<String>? labels;
  final ValueChanged<int> onChanged;
  @override
  State<_DateTimeWheel> createState() => _DateTimeWheelState();
}

class _DateTimeWheelState extends State<_DateTimeWheel> {
  late final scroll = FixedExtentScrollController(
    initialItem: widget.value - widget.min,
  );
  late final text = TextEditingController(text: display(widget.value));
  final focus = FocusNode();
  bool dirty = false;

  @override
  void initState() {
    super.initState();
    focus.addListener(commitOnBlur);
  }

  void commitOnBlur() {
    if (!focus.hasFocus) commit();
  }

  String display(int value) =>
      widget.labels?[value - widget.min] ??
      (widget.name == 'Day' || widget.name == 'Minute'
          ? value.toString().padLeft(2, '0')
          : value.toString());
  @override
  void didUpdateWidget(covariant _DateTimeWheel old) {
    super.didUpdateWidget(old);
    if (old.value != widget.value ||
        old.min != widget.min ||
        old.max != widget.max) {
      if (!dirty) text.text = display(widget.value);
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted &&
            scroll.hasClients &&
            scroll.selectedItem != widget.value - widget.min) {
          scroll.jumpToItem(widget.value - widget.min);
        }
      });
    }
  }

  bool commit() {
    if (!dirty) return true;
    final value = widget.labels == null
        ? int.tryParse(text.text)
        : widget.labels!.indexWhere(
                (v) => v.toLowerCase() == text.text.toLowerCase(),
              ) +
              widget.min;
    if (value == null || value < widget.min || value > widget.max) return false;
    dirty = false;
    widget.onChanged(value);
    return true;
  }

  @override
  void dispose() {
    scroll.dispose();
    text.dispose();
    focus.removeListener(commitOnBlur);
    focus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => SizedBox(
    height: 180,
    child: Stack(
      children: [
        Positioned(
          left: 0,
          right: 0,
          top: 66,
          bottom: 66,
          child: IgnorePointer(
            child: DecoratedBox(
              decoration: BoxDecoration(
                border: Border.symmetric(
                  horizontal: BorderSide(
                    color: Theme.of(context).brightness == Brightness.dark
                        ? const Color(0xff938f99)
                        : const Color(0xff626169),
                    width: 1.5,
                  ),
                ),
              ),
            ),
          ),
        ),
        ListWheelScrollView.useDelegate(
          controller: scroll,
          itemExtent: 60,
          diameterRatio: 100,
          perspective: .0001,
          physics: const FixedExtentScrollPhysics(),
          overAndUnderCenterOpacity: .45,
          onSelectedItemChanged: (index) {
            dirty = false;
            focus.unfocus();
            widget.onChanged(index + widget.min);
          },
          childDelegate: ListWheelChildBuilderDelegate(
            childCount: widget.max - widget.min + 1,
            builder: (context, index) {
              final value = index + widget.min;
              if (value == widget.value) {
                return Center(
                  child: TextField(
                    key: ValueKey('schedule-picker-${widget.name}'),
                    controller: text,
                    onChanged: (_) => dirty = true,
                    focusNode: focus,
                    textAlign: TextAlign.center,
                    style: DefaultTextStyle.of(context).style,
                    keyboardType: widget.labels == null
                        ? TextInputType.number
                        : TextInputType.text,
                    inputFormatters: widget.labels == null
                        ? [FilteringTextInputFormatter.digitsOnly]
                        : null,
                    textInputAction: TextInputAction.done,
                    onSubmitted: (_) => commit(),
                    decoration: InputDecoration(
                      isDense: true,
                      border: InputBorder.none,
                      contentPadding: const EdgeInsets.symmetric(vertical: 12),
                      semanticCounterText: widget.name,
                    ),
                  ),
                );
              }
              return Semantics(
                button: true,
                label: '${widget.name} ${display(value)}',
                child: GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTap: () => scroll.animateToItem(
                    index,
                    duration: const Duration(milliseconds: 150),
                    curve: Curves.easeOut,
                  ),
                  child: Center(child: Text(display(value))),
                ),
              );
            },
          ),
        ),
      ],
    ),
  );
}
