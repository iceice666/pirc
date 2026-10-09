/* Shipped native host for the pinned QuickJS WASM asset. No WASI, files, network,
 * process spawning or dynamically supplied modules. The outer worker launcher must
 * seal this process before application entry. Native imports expose bounded IPC only.
 */
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <unistd.h>
#include <time.h>
#include "wasm3.h"
#include "native-ptc-assets.h"
#ifdef __linux__
#include <linux/seccomp.h>
#include <linux/filter.h>
#include <linux/audit.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <stddef.h>
#include <errno.h>
static void seal_exec(void) {
#if defined(__x86_64__)
 const unsigned arch=AUDIT_ARCH_X86_64;
#elif defined(__aarch64__)
 const unsigned arch=AUDIT_ARCH_AARCH64;
#else
 _exit(125);
#endif
 struct sock_filter code[]={
  BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,arch)),
  BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,arch,1,0),BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_KILL_PROCESS),
  BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,nr)),
  BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,__NR_execve,0,1),BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
  BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,__NR_execveat,0,1),BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
  BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,__NR_memfd_create,0,1),BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
  BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ALLOW)};
 struct sock_fprog program={sizeof(code)/sizeof(code[0]),code};
 if(prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0)||syscall(__NR_seccomp,SECCOMP_SET_MODE_FILTER,SECCOMP_FILTER_FLAG_TSYNC,&program))_exit(125);
}
#endif
#define FRAME_BYTES (32u * 1024u * 1024u)
static IM3Runtime runtime;
static IM3Module module;
static uint32_t context;
static int loaded;
static void die(const char *message) { fprintf(stderr,"native PTC: %.200s\n",message); _exit(2); }
static void check(M3Result result) { if(result)die(result); }
static IM3Function function(const char *name) { IM3Function f;check(m3_FindFunction(&f,runtime,name));return f; }
static uint32_t call(const char *name,...) {IM3Function f=function(name);va_list args;va_start(args,name);check(m3_CallVL(f,args));va_end(args);uint32_t result;check(m3_GetResultsV(f,&result));return result;}
static void *memory(uint32_t offset,size_t count) {size_t bytes;void *mem=m3_GetMemory(module,&bytes,0);if(count>bytes||offset>bytes-count)die("memory bounds");return (char *)mem+offset;}
static uint32_t string(const char *value,size_t length) {if(length>FRAME_BYTES)die("string quota");uint32_t offset=call("v",(uint32_t)length+1);if(!offset)die("allocation failed");memcpy(memory(offset,length+1),value,length);((char *)memory(offset,length+1))[length]=0;return offset;}
static void free_value(uint32_t value) {check(m3_CallV(function("N"),context,value));}
static uint32_t checked_value(uint32_t value) {uint32_t error=call("la",context,value);if(error)die("QuickJS exception");return value;}
static uint32_t evaluate(const char *source,size_t length) {uint32_t code=string(source,length),file=string("ptc.js",6);uint32_t value=checked_value(call("na",context,code,(uint32_t)length,file,0,0));check(m3_CallV(function("K"),code));check(m3_CallV(function("K"),file));return value;}
static void write_all(const void *bytes,size_t length) {const char *p=bytes;while(length){ssize_t n=write(1,p,length);if(n<=0)die("IPC write");p+=n;length-=(size_t)n;}}
static uint32_t argument(uint32_t argv,uint32_t index) {return call("Ca",argv,index);}
m3ApiRawFunction(host_call) {
 m3ApiReturnType(uint32_t);m3ApiGetArg(uint32_t,ctx);m3ApiGetArg(uint32_t,self);m3ApiGetArg(uint32_t,argc);m3ApiGetArg(uint32_t,argv);m3ApiGetArg(uint32_t,id);(void)self;
 if(ctx!=context) return "callback context mismatch";
 if(id==2&&argc==0){loaded=1;m3ApiReturn(0);}
 if(id!=1||argc!=1)return "callback identity mismatch";
 uint32_t text=call("Z",context,argument(argv,0));size_t bytes;char *mem=(char *)m3_GetMemory(module,&bytes,0);if(text>=bytes)return "callback string bounds";
 size_t available=bytes-text,limit=available<FRAME_BYTES+1?available:FRAME_BYTES+1,length=strnlen(mem+text,limit);if(length==limit||length>FRAME_BYTES)return "callback output quota";
 /* Store-read provenance is native-owned, outside mutable realm state. Every frame
  * carries the latch; the trusted host overwrites any guest-provided loaded flag. */
 write_all(loaded?"{\"loaded\":true,\"message\":" : "{\"loaded\":false,\"message\":",loaded?25:26);write_all(mem+text,length);write_all("}\n",2);check(m3_CallV(function("Q"),context,text));m3ApiReturn(0);
}
m3ApiRawFunction(zero) {m3ApiReturnType(uint32_t);m3ApiReturn(0);}
m3ApiRawFunction(noop) {m3ApiSuccess();}
m3ApiRawFunction(forbidden) {return "unsupported ambient import";}
m3ApiRawFunction(clock_now) {m3ApiReturnType(double);struct timespec time;if(clock_gettime(CLOCK_REALTIME,&time))return "clock unavailable";m3ApiReturn((double)time.tv_sec*1000.0+(double)time.tv_nsec/1000000.0);}
m3ApiRawFunction(local_time) {m3ApiGetArg(uint32_t,low);m3ApiGetArg(int32_t,high);m3ApiGetArg(uint32_t,out);int64_t seconds=(int64_t)high*4294967296LL+low;time_t epoch=(time_t)seconds;struct tm tm;if(!gmtime_r(&epoch,&tm))return "invalid date";int32_t fields[11]={tm.tm_sec,tm.tm_min,tm.tm_hour,tm.tm_mday,tm.tm_mon,tm.tm_year,tm.tm_wday,tm.tm_yday,0,0,0};memcpy(memory(out,sizeof(fields)),fields,sizeof(fields));m3ApiSuccess();}
m3ApiRawFunction(timezone_utc) {m3ApiGetArg(uint32_t,offset);m3ApiGetArg(uint32_t,daylight);m3ApiGetArg(uint32_t,standard);m3ApiGetArg(uint32_t,summer);memset(memory(offset,4),0,4);memset(memory(daylight,4),0,4);memcpy(memory(standard,4),"UTC",4);memcpy(memory(summer,4),"UTC",4);m3ApiSuccess();}
m3ApiRawFunction(empty_env) {m3ApiReturnType(uint32_t);m3ApiGetArg(uint32_t,a);m3ApiGetArg(uint32_t,b);memset(memory(a,4),0,4);memset(memory(b,4),0,4);m3ApiReturn(0);}
static void define(uint32_t global,const char *name,uint32_t id){uint32_t raw=string(name,strlen(name));uint32_t key=call("Y",context,raw),value=call("Ba",context,id,raw);check(m3_CallV(function("ha"),context,global,key,value));free_value(key);free_value(value);check(m3_CallV(function("K"),raw));}
int main(void) {
#ifdef __linux__
 seal_exec();
#endif
 IM3Environment env=m3_NewEnvironment();if(!env)die("environment allocation");runtime=m3_NewRuntime(env,1024*1024,NULL);if(!runtime)die("runtime allocation");
 /* The trusted fixed-memory adapter exports the exact imports expected by the
  * unchanged QuickJS module; both arrays are hashed/pinned by the build script. */
 IM3Module adapter;check(m3_ParseModule(env,&adapter,ptc_memory,sizeof(ptc_memory)));m3_SetModuleName(adapter,"a");check(m3_LoadModule(runtime,adapter));
 const char *names[]={"b","c","d","e","f","g","h","i","j","k","l","m","n","o","p","q","r","s","t"};
 const char *signatures[]={"v(iiii)","i(iiii)","i(i)","i(ii)","i(ii)","i(iiii)","i(iii)","i(i)","v(iii)","i(iiiii)","i(iF)","i(i)","v()","v(iiii)","F()","v()","v(i)","i(iiiii)","v(ii)"};
 for(int i=0;i<19;i++)check(m3_LinkRawFunction(adapter,"pirc",names[i],signatures[i],names[i][0]=='s'?host_call:names[i][0]=='j'?local_time:names[i][0]=='o'?timezone_utc:names[i][0]=='f'?empty_env:names[i][0]=='e'||names[i][0]=='i'||names[i][0]=='m'?zero:names[i][0]=='t'?noop:names[i][0]=='p'?clock_now:forbidden));
 check(m3_ParseModule(env,&module,ptc_quickjs,sizeof(ptc_quickjs)));check(m3_LoadModule(runtime,module));check(m3_CallV(function("u")));uint32_t rt=call("I");
 check(m3_CallV(function("y"),rt,128*1024*1024));check(m3_CallV(function("D"),rt,512*1024));context=call("L",rt,0);if(!context)die("context allocation");
 uint32_t global=call("sa",context);define(global,"__pirc_emit",1);define(global,"__pirc_loaded",2);free_value(global);
 uint32_t bridge=evaluate((const char *)ptc_sdk,sizeof(ptc_sdk)-1),receive=call("ga",context,bridge,0),idle=call("ga",context,bridge,1),undefined=call("E"),argv=call("v",4),jobContext=call("v",4);free_value(bridge);
 char *line=malloc(FRAME_BYTES+1);if(!line)die("frame allocation");size_t length=0;
 unsigned char input[65536];size_t position=0,available=0;
 for(;;){if(position==available){ssize_t n=read(0,input,sizeof(input));if(n==0)break;if(n<0)die("IPC read");position=0;available=(size_t)n;}char ch=(char)input[position++];if(ch!='\n'){if(ch==0||length>=FRAME_BYTES)die("frame quota");line[length++]=ch;continue;}
  uint32_t raw=string(line,length),value=call("Y",context,raw);check(m3_CallV(function("K"),raw));memcpy(memory(argv,4),&value,4);free_value(checked_value(call("ka",context,receive,undefined,1,argv)));free_value(value);
  uint32_t jobs=call("ea",rt,-1,jobContext);/* Job errors are values: require numeric result. */
  uint32_t type=call("pa",context,jobs);if(strcmp(memory(type,7),"number"))die("pending job failed");check(m3_CallV(function("K"),type));free_value(jobs);
  free_value(checked_value(call("ka",context,idle,undefined,0,0)));length=0;
 }
 if(length)die("truncated frame");return 0;
}
