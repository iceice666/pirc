import 'package:flutter/services.dart';

/// HTML maxlength counts UTF-16 code units, rather than grapheme clusters.
/// Keeps the untouched suffix when a replacement exceeds the available space.
class WebLengthFormatter extends TextInputFormatter {
  const WebLengthFormatter(this.maxLength);
  final int maxLength;

  int boundary(String text, int limit) {
    var end = limit.clamp(0, text.length);
    if (end > 0 && end < text.length) {
      final before = text.codeUnitAt(end - 1), after = text.codeUnitAt(end);
      if (before >= 0xd800 &&
          before <= 0xdbff &&
          after >= 0xdc00 &&
          after <= 0xdfff) {
        end--;
      }
    }
    return end;
  }

  @override
  TextEditingValue formatEditUpdate(
    TextEditingValue oldValue,
    TextEditingValue newValue,
  ) {
    // Let the IME finish composing before enforcing the committed value.
    if (!newValue.composing.isCollapsed || newValue.text.length <= maxLength) {
      return newValue;
    }
    final old = oldValue.text, next = newValue.text;
    String result;
    if (old.length > maxLength) {
      result = next.substring(0, boundary(next, maxLength));
    } else {
      var start = oldValue.selection.isValid ? oldValue.selection.start : 0;
      var end = oldValue.selection.isValid
          ? oldValue.selection.end
          : old.length;
      if (start > old.length ||
          end > old.length ||
          !next.startsWith(old.substring(0, start)) ||
          !next.endsWith(old.substring(end)) ||
          next.length < start + old.length - end) {
        start = 0;
        while (start < old.length &&
            start < next.length &&
            old.codeUnitAt(start) == next.codeUnitAt(start)) {
          start++;
        }
        var suffix = 0;
        while (suffix < old.length - start &&
            suffix < next.length - start &&
            old.codeUnitAt(old.length - suffix - 1) ==
                next.codeUnitAt(next.length - suffix - 1)) {
          suffix++;
        }
        end = old.length - suffix;
      }
      final prefix = old.substring(0, start), suffix = old.substring(end);
      final inserted = next.substring(start, next.length - suffix.length);
      final available = maxLength - prefix.length - suffix.length;
      result =
          prefix +
          inserted.substring(0, boundary(inserted, available)) +
          suffix;
    }
    return newValue.copyWith(
      text: result,
      selection: TextSelection(
        baseOffset: newValue.selection.baseOffset.clamp(0, result.length),
        extentOffset: newValue.selection.extentOffset.clamp(0, result.length),
        affinity: newValue.selection.affinity,
        isDirectional: newValue.selection.isDirectional,
      ),
      composing: TextRange.empty,
    );
  }
}
