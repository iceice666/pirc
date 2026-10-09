/* Finite shipped phase driver; no context, model, tools, eval or ambient APIs.
 * Accept ONLY the supervisor's canonical closed JSON frames. Any alternate
 * ordering, duplicate/unknown field, whitespace, truncation or overflow fails.
 */
#ifndef PIRC_MACOS_WORKER_PROTOCOL_H
#define PIRC_MACOS_WORKER_PROTOCOL_H
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <stdint.h>
static int pirc_worker_phase_loop(void) {
  unsigned long long seq = 0;
  const char *action = "model";
  char frame[4098], canonical[128], next[8], selected[8];
  for (;;) {
    if (++seq > 9007199254740991ULL) return 2;
    if (fprintf(stdout, "{\"seq\":%llu,\"action\":\"%s\"}\n", seq, action) < 0
        || fflush(stdout) != 0) return 2;
    size_t used = 0;
    for (;;) {
      int byte = fgetc(stdin);
      if (byte == EOF || used >= sizeof(frame) - 1 || byte == 0) return 2;
      frame[used++] = (char)byte;
      if (byte == '\n') break;
    }
    frame[used] = 0;
    unsigned long long reply_seq = 0;
    int consumed = 0;
    if (sscanf(frame, "{\"next\":\"%7[a-z]\",\"seq\":%llu}%n", next, &reply_seq, &consumed) != 2
        || consumed <= 0 || reply_seq != seq
        || (strcmp(next, "model") && strcmp(next, "tools") && strcmp(next, "done"))) return 2;
    int length = snprintf(canonical, sizeof(canonical), "{\"next\":\"%s\",\"seq\":%llu}\n", next, reply_seq);
    if (length <= 0 || (size_t)length != used || memcmp(canonical, frame, used)) return 2;
    if (!strcmp(action, "done")) return 0;
    /* Keep the next action outside the reply reconstruction buffer. */
    strcpy(selected, next);
    action = selected;
  }
}
#endif
