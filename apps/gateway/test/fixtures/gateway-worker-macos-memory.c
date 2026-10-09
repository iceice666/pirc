#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
int main(void) {
  puts("{\"seq\":1,\"action\":\"model\"}");fflush(stdout);
  usleep(250000);
  volatile unsigned char *retained[24];
  for(int i=0;i<24;i++){
    retained[i]=malloc(8*1024*1024);if(!retained[i])return 3;
    for(size_t byte=0;byte<8*1024*1024;byte+=4096)retained[i][byte]=0x42;
  }
  for(;;)pause();
}
