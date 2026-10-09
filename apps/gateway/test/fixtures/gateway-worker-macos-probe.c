/* Hostile native shipped fixture: never cooperates with a self-seal API. */
#include "../../src/gateway-runtime/macos-worker-protocol.h"
#include <unistd.h>
#include <fcntl.h>
#include <sys/socket.h>
#include <sys/sysctl.h>
#include <sys/wait.h>
#include <mach/mach.h>
#include <mach-o/dyld.h>
#include <libproc.h>
#include <servers/bootstrap.h>
#include <spawn.h>
#include <signal.h>
extern char **environ;
static int contains(const void *haystack,size_t size,const char *needle){
  size_t length=strlen(needle);const unsigned char *bytes=haystack;
  for(size_t i=0;i+length<=size;i++)if(!memcmp(bytes+i,needle,length))return 1;
  return 0;
}
static int readable(const char *file) { int fd=open(file,O_RDONLY); if(fd<0)return 0; close(fd); return 1; }
static int writable(const char *file) { int fd=open(file,O_WRONLY|O_CREAT,0600); if(fd<0)return 0; close(fd); return 1; }
int main(void) {
  char executable[4096]; uint32_t size=sizeof(executable);
  if(_NSGetExecutablePath(executable,&size)!=0)return 2;
  char directory[4096]; strcpy(directory,executable); char *slash=strrchr(directory,'/'); if(!slash)return 2; *slash=0;
  char file[8192]; int host_workspace,host_home,host_canary,host_alias;
  snprintf(file,sizeof(file),"%s/host-workspace",directory);host_workspace=readable(file);
  snprintf(file,sizeof(file),"%s/host-home",directory);host_home=readable(file);
  snprintf(file,sizeof(file),"%s/credential-canary",directory);host_canary=readable(file);
  snprintf(file,sizeof(file),"%s/credential-alias",directory);host_alias=readable(file);
  int leaked=0; char secret[128];
  for(int fd=3;fd<1024;fd++){ memset(secret,0,sizeof(secret)); ssize_t bytes=pread(fd,secret,sizeof(secret)-1,0); if(bytes>0&&strstr(secret,"private host canary"))leaked=1; }
  int domains[]={AF_INET,AF_INET6,AF_UNIX}, sockets[3], socket_errors[3];
  for(int i=0;i<3;i++){ errno=0;sockets[i]=socket(domains[i],SOCK_STREAM,0);socket_errors[i]=errno;if(sockets[i]>=0)close(sockets[i]); }
  char *args[]={executable,NULL}, *empty[]={NULL}; errno=0;
  int exec_result=execve(executable,args,empty),exec_errno=errno;
  pid_t spawned=-1; pid_t child=fork();int fork_errno=errno;
  if(child==0)_exit(124);if(child>0){int status;waitpid(child,&status,0);spawned=child;}
  pid_t subprocess=-1;int spawn_result=posix_spawn(&subprocess,executable,NULL,NULL,args,empty);
  if(spawn_result==0){kill(subprocess,SIGKILL);int status;waitpid(subprocess,&status,0);spawned=subprocess;}
  mach_port_t task=MACH_PORT_NULL; int parent_task=task_for_pid(mach_task_self(),getppid(),&task);
  int peer_results[2],peer_errors[2];
  for(int i=0;i<2;i++){errno=0;peer_results[i]=(int)syscall(538+i,mach_task_self(),getppid(),&task);peer_errors[i]=errno;}
  mach_port_t bootstrap=MACH_PORT_NULL;int bootstrap_result=task_get_special_port(mach_task_self(),TASK_BOOTSTRAP_PORT,&bootstrap);
  mach_port_t service=MACH_PORT_NULL;int service_attempted=MACH_PORT_VALID(bootstrap),service_result=0;
  if(service_attempted)service_result=bootstrap_look_up(bootstrap,"com.apple.cfprefsd.daemon",&service);
  char service_json[32];if(service_attempted)snprintf(service_json,sizeof(service_json),"%d",service_result);else strcpy(service_json,"null");
  int mib[]={CTL_KERN,KERN_PROCARGS2,getppid()};char arguments[65536]={0};size_t bytes=sizeof(arguments);errno=0;
  int procargs=sysctl(mib,3,arguments,&bytes,NULL,0),procargs_errno=errno;
  errno=0;int raw=(int)syscall(202,mib,3,arguments,&bytes,NULL,0),raw_errno=errno;
  errno=0;int private_sysctl=sysctlbyname("kern.hostname",arguments,&bytes,NULL,0),private_errno=errno;
  arguments[sizeof(arguments)-1]=0;
  errno=0;int signal_result=kill(getppid(),SIGCONT),signal_errno=errno;
  struct proc_taskinfo info;int peer_info=proc_pidinfo(getppid(),PROC_PIDTASKINFO,0,&info,sizeof(info));
  int writes=writable(executable)||writable("/private/tmp/pirc-worker-write-probe")||writable("/nonexistent/test");
  fprintf(stderr,"{\"hostEtc\":%s,\"hostWorkspace\":%s,\"hostHome\":%s,\"hostCanary\":%s,\"hostAlias\":%s,\"descriptorSecret\":%s,\"environment\":[",
    readable("/etc/passwd")?"true":"false",host_workspace?"true":"false",host_home?"true":"false",host_canary?"true":"false",host_alias?"true":"false",leaked?"true":"false");
  for(int i=0;environ[i];i++){const char *end=strchr(environ[i],'=');if(!end)return 2;fprintf(stderr,"%s\"%.*s\"",i?",":"",(int)(end-environ[i]),environ[i]);}
  fprintf(stderr,"],\"execResult\":%d,\"execErrno\":%d,\"subprocess\":%s,\"forkErrno\":%d,\"parentTaskResult\":%d,\"peerInfoBytes\":%d,\"bootstrapResult\":%d,\"bootstrapPort\":%u,\"serviceAttempted\":%s,\"serviceResult\":%s,\"signalResult\":%d,\"signalErrno\":%d,\"procargsResult\":%d,\"procargsErrno\":%d,\"rawProcargsResult\":%d,\"rawProcargsErrno\":%d,\"privateSysctlResult\":%d,\"privateSysctlErrno\":%d,\"procargsSecret\":%s,\"procargsCommand\":%s,\"writable\":%s,\"peerTasks\":[{\"result\":%d,\"errno\":%d},{\"result\":%d,\"errno\":%d}],\"sockets\":[",
    exec_result,exec_errno,spawned>0?"true":"false",fork_errno,parent_task,peer_info,bootstrap_result,bootstrap,service_attempted?"true":"false",service_json,signal_result,signal_errno,procargs,procargs_errno,raw,raw_errno,private_sysctl,private_errno,contains(arguments,sizeof(arguments),"PIRC_WORKER_SECRET_CANARY")?"true":"false",contains(arguments,sizeof(arguments),"gateway-worker-isolation")?"true":"false",writes?"true":"false",peer_results[0],peer_errors[0],peer_results[1],peer_errors[1]);
  for(int i=0;i<3;i++)fprintf(stderr,"%s{\"result\":%d,\"errno\":%d}",i?",":"",sockets[i],socket_errors[i]);
  fprintf(stderr,"]}\n");
  return pirc_worker_phase_loop();
}
