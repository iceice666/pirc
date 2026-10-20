import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/l10n/app_i18n.dart';
import 'package:pirc_mobile/l10n/catalogs.g.dart';

void main() {
  tearDown(() => AppI18n.instance.setLanguage('en'));
  test('English default, fallback and literal user parameters', () {
    AppI18n.instance.setLanguage('en');
    expect(tr('Settings'), 'Settings');
    AppI18n.instance.setLanguage('zh-TW');
    expect(tr('Settings'), '設定');
    expect(tr('Unknown authored text'), 'Unknown authored text');
    expect(
      tr('Unknown {999999999999999999999999}'),
      'Unknown {999999999999999999999999}',
    );
    expect(tr('New {0}', ['<Project>']), contains('<Project>'));
    AppI18n.instance.setLanguage('fr');
    expect(AppI18n.instance.language, 'en');
  });
  test(
    'native background UI catalogs keep English fallback and matching parameters',
    () {
      Map<String, dynamic> read(String language) =>
          jsonDecode(
                File(
                  'android/app/src/main/assets/locales/$language.json',
                ).readAsStringSync(),
              )
              as Map<String, dynamic>;
      final en = read('en'), zh = read('zh-TW');
      expect(zh.keys, unorderedEquals(en.keys));
      List<String> args(String value) =>
          RegExp(r'\{\d+\}').allMatches(value).map((m) => m[0]!).toList()
            ..sort();
      for (final key in en.keys) {
        expect(args(en[key] as String), args(key), reason: key);
        expect(args(zh[key] as String), args(key), reason: key);
      }
      expect(en['確認'], 'Confirm');
      expect(zh['確認'], '確認');
    },
  );
  test('catalogs have identical keys and placeholder counts', () {
    expect(
      traditionalChineseMessages.keys,
      unorderedEquals(englishMessages.keys),
    );
    List<String> args(String value) =>
        RegExp(r'\{\d+\}').allMatches(value).map((m) => m[0]!).toList()..sort();
    for (final entry in englishMessages.entries) {
      expect(args(entry.value), args(entry.key), reason: entry.key);
      expect(
        args(traditionalChineseMessages[entry.key]!),
        args(entry.value),
        reason: entry.key,
      );
    }
  });
}
