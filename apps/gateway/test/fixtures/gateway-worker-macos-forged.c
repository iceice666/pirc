#include <stdio.h>
#include <unistd.h>
int main(void) { puts("{\"seq\":1,\"action\":\"model\",\"provider\":\"forged\",\"binding\":{}}");fflush(stdout);for(;;)pause(); }
