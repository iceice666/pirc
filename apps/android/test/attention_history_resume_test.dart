import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:pirc_mobile/live/attention.dart';
import 'package:pirc_mobile/live/gateway.dart';

class _MemoryGateway extends Gateway {
  Json response = <String, dynamic>{};
  Future<Json> Function()? delayedResponse;

  @override
  Future<dynamic> call(
    String method, [
    Json args = const <String, dynamic>{},
  ]) async {
    if (method != 'request' || args['path'] != '/api/memory') {
      throw StateError('Unexpected gateway call: $method ${args['path']}');
    }
    final delayed = delayedResponse;
    if (delayed != null) {
      delayedResponse = null;
      return delayed();
    }
    return response;
  }
}

void main() {
  test(
    'history refresh compares nested JSON independent of map key order',
    () async {
      final gateway = _MemoryGateway()
        ..response = <String, dynamic>{
          'revision': 4,
          'entries': <dynamic>[
            <String, dynamic>{
              'id': 'memory-1',
              'revision': 2,
              'metadata': <String, dynamic>{
                'origin': 'user',
                'details': <String, dynamic>{
                  'confidence': 0.8,
                  'labels': <dynamic>[
                    'work',
                    <String, dynamic>{'lang': 'zh'},
                  ],
                },
              },
            },
          ],
        };
      final attention = AttentionState(gateway);

      await attention.refreshMemory();
      expect(attention.memoryRevision, 1);

      gateway.response = <String, dynamic>{
        'entries': <dynamic>[
          <String, dynamic>{
            'metadata': <String, dynamic>{
              'details': <String, dynamic>{
                'labels': <dynamic>[
                  'work',
                  <String, dynamic>{'lang': 'zh'},
                ],
                'confidence': 0.8,
              },
              'origin': 'user',
            },
            'revision': 2,
            'id': 'memory-1',
          },
        ],
        'revision': 4,
      };

      await attention.refreshMemory(preserveUnchanged: true);
      expect(attention.memoryRevision, 1);
      expect(attention.memory, gateway.response);

      gateway.response = <String, dynamic>{
        ...gateway.response,
        'entries': <dynamic>[
          <String, dynamic>{
            ...obj(rows(gateway.response['entries']).single),
            'revision': 3,
            'metadata': <String, dynamic>{
              'origin': 'user',
              'details': <String, dynamic>{
                'confidence': 0.9,
                'labels': <dynamic>[
                  'work',
                  <String, dynamic>{'lang': 'zh'},
                ],
              },
            },
          },
        ],
      };

      await attention.refreshMemory(preserveUnchanged: true);
      expect(attention.memoryRevision, 2);
      expect(rows(attention.memory?['entries']).single['revision'], 3);

      attention.dispose();
    },
  );

  test(
    'ordinary identical refresh still advances the memory revision',
    () async {
      final gateway = _MemoryGateway()
        ..response = <String, dynamic>{
          'entries': <dynamic>[
            <String, dynamic>{'id': 'memory-1', 'revision': 1},
          ],
        };
      final attention = AttentionState(gateway);

      await attention.refreshMemory();
      expect(attention.memoryRevision, 1);
      await attention.refreshMemory();
      expect(attention.memoryRevision, 2);

      attention.dispose();
    },
  );

  test('reset fences a delayed history-resume memory response', () async {
    final gateway = _MemoryGateway()
      ..response = <String, dynamic>{
        'entries': <dynamic>[
          <String, dynamic>{'id': 'old-account-entry'},
        ],
      };
    final attention = AttentionState(gateway);
    await attention.refreshMemory();
    final revisionBeforeReset = attention.memoryRevision;
    final started = Completer<void>();
    final delayed = Completer<Json>();
    gateway.delayedResponse = () {
      started.complete();
      return delayed.future;
    };

    final pending = attention.refreshMemory(preserveUnchanged: true);
    await started.future;
    attention.reset();
    final resetRevision = attention.memoryRevision;
    delayed.complete(<String, dynamic>{
      'entries': <dynamic>[
        <String, dynamic>{'id': 'old-account-entry', 'late': true},
      ],
    });
    await pending;

    expect(resetRevision, revisionBeforeReset + 1);
    expect(attention.memory, isNull);
    expect(attention.memoryRevision, resetRevision);
    expect(attention.memoryLoading, isFalse);

    attention.dispose();
  });
}
