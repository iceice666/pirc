/* Native hostile fixture: does not seal itself, ignores stdin EOF, and stays
 * alive until the trusted launch watchdog kills it. Never deploy this binary.
 */
#include <stdio.h>
#include <unistd.h>
int main(void) {
  puts("{\"seq\":1,\"action\":\"model\"}");
  fflush(stdout);
  for (;;) pause();
}
