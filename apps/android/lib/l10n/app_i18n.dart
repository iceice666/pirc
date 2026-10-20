import 'package:flutter/widgets.dart';
import 'catalogs.g.dart';

/// Language belongs to this client, independently of the gateway or OS locale.
class AppI18n extends ChangeNotifier {
  static final instance = AppI18n();
  String _language = 'en';
  String get language => _language;
  Locale get locale =>
      _language == 'zh-TW' ? const Locale('zh', 'TW') : const Locale('en');
  void setLanguage(Object? value) {
    final next = value == 'zh-TW' ? 'zh-TW' : 'en';
    if (next == _language) return;
    _language = next;
    notifyListeners();
  }

  static void watch(BuildContext context) {
    context.dependOnInheritedWidgetOfExactType<I18nScope>();
  }
}

class I18nScope extends InheritedNotifier<AppI18n> {
  I18nScope({super.key, required super.child})
    : super(notifier: AppI18n.instance);
}

/// Parameters are substituted after lookup, so user/model text is never translated.
String tr(String source, [List<Object?> values = const []]) {
  final english = englishMessages[source] ?? source;
  final translated = AppI18n.instance.language == 'zh-TW'
      ? traditionalChineseMessages[source]
      : null;
  final template = translated ?? english;
  return template.replaceAllMapped(RegExp(r'\{(\d+)\}'), (match) {
    final index = int.tryParse(match[1]!);
    return index != null && index < values.length
        ? '${values[index] ?? ''}'
        : match[0]!;
  });
}
