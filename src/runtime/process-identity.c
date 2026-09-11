// Darwin resource coalitions are inherited across fork, exec, setsid and
// reparenting. Each worker is placed in a dedicated launchd job coalition.
#include <libproc.h>
#include <sys/proc_info.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <signal.h>
#include <errno.h>
#include <string.h>
#include <sys/sysctl.h>
#include <sys/time.h>

struct oc_unique { uint8_t uuid[16]; uint64_t unique; uint64_t parent_unique; int32_t version; uint32_t reserved2; uint64_t reserved3; uint64_t reserved4; };
struct oc_coalition { uint64_t ids[2]; uint64_t reserved[3]; };
struct identity { pid_t pid; struct proc_bsdinfo bsd; struct oc_unique unique; struct oc_coalition coalition; };

static int inspect(pid_t pid, struct identity *out) {
  memset(out, 0, sizeof(*out)); out->pid = pid;
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &out->bsd, sizeof(out->bsd)) != sizeof(out->bsd)) return -1;
  if (proc_pidinfo(pid, 17, 0, &out->unique, sizeof(out->unique)) != sizeof(out->unique)) return -1;
  if (proc_pidinfo(pid, 20, 0, &out->coalition, sizeof(out->coalition)) != sizeof(out->coalition)) return -1;
  return 0;
}
static void print_identity(struct identity *i) {
  struct timeval boot; size_t size = sizeof(boot);
  if (sysctlbyname("kern.boottime",&boot,&size,NULL,0)!=0) exit(3);
  printf("{\"pid\":%d,\"ppid\":%d,\"unique\":%llu,\"parentUnique\":%llu,\"coalition\":%llu,\"uid\":%d,\"startedSeconds\":%llu,\"startedMicros\":%llu,\"bootSeconds\":%ld,\"bootMicros\":%d}",i->pid,i->bsd.pbi_ppid,i->unique.unique,i->unique.parent_unique,i->coalition.ids[0],i->bsd.pbi_uid,i->bsd.pbi_start_tvsec,i->bsd.pbi_start_tvusec,boot.tv_sec,boot.tv_usec);
}
static int members(uint64_t coalition, pid_t exclude, struct identity **out) {
  int size = proc_listallpids(NULL, 0) + 1024;
  pid_t *pids = calloc((size_t)size, sizeof(pid_t));
  struct identity *found = calloc((size_t)size, sizeof(struct identity));
  if (!pids || !found) return -1;
  int count = proc_listallpids(pids, size * (int)sizeof(pid_t)), total = 0;
  if (count <= 0 || count >= size) { free(pids); free(found); return -1; }
  for (int n=0; n<count; n++) {
    if (pids[n] <= 0 || pids[n] == getpid() || pids[n] == exclude) continue;
    struct proc_bsdinfo basic;
    if (proc_pidinfo(pids[n], PROC_PIDTBSDINFO, 0, &basic, sizeof(basic)) != sizeof(basic)) continue;
    if ((basic.pbi_uid != getuid() && basic.pbi_ruid != getuid()) || basic.pbi_status == 5) continue;
    struct identity i;
    if (inspect(pids[n], &i) != 0) {
      // A process may become a zombie between the three libproc reads. It
      // cannot execute or fork; do not mistake that transition for a live
      // process whose coalition cannot be established.
      if (proc_pidinfo(pids[n], PROC_PIDTBSDINFO, 0, &basic, sizeof(basic)) == sizeof(basic) && basic.pbi_status == 5) continue;
      if (kill(pids[n], 0) == -1 && errno == ESRCH) continue;
      free(pids); free(found); return -1;
    }
    if (i.coalition.ids[0] == coalition) found[total++] = i;
  }
  free(pids); *out = found; return total;
}
static int signal_identity(struct identity *i, int signal_number) {
  struct identity current;
  if (inspect(i->pid, &current) != 0) return 0;
  if (current.unique.unique != i->unique.unique || current.coalition.ids[0] != i->coalition.ids[0]) return 0;
  return kill(i->pid, signal_number);
}
int main(int argc, char **argv) {
  if (argc == 2) {
    pid_t pid = (pid_t)atoi(argv[1]); struct identity i;
    if (inspect(pid, &i) != 0) {
      if (kill(pid, 0) == -1 && errno == ESRCH) { puts("{\"status\":\"absent\"}"); return 0; }
      puts("{\"status\":\"uncertain\"}"); return 3;
    }
    print_identity(&i); puts(""); return 0;
  }
  if (argc < 3) return 2;
  uint64_t coalition = strtoull(argv[2], NULL, 10);
  if (!coalition) return 2;
  if (strcmp(argv[1], "members") == 0) {
    struct identity *list; int count = members(coalition, 0, &list);
    if (count < 0) { puts("{\"status\":\"uncertain\"}"); return 3; }
    printf("{\"status\":\"observed\",\"members\":[");
    for (int n=0; n<count; n++) { if(n) printf(","); print_identity(&list[n]); }
    puts("]}"); free(list); return 0;
  }
  if ((strcmp(argv[1], "terminate") == 0 || strcmp(argv[1], "cleanup") == 0) && argc == 5) {
    pid_t guardian = 0;
    if (strcmp(argv[1], "terminate") == 0) {
      guardian = (pid_t)atoi(argv[3]); uint64_t guardian_unique = strtoull(argv[4], NULL, 10);
      struct identity identity;
      if (inspect(guardian, &identity) != 0 || identity.unique.unique != guardian_unique || identity.coalition.ids[0] != coalition) return 4;
    } else {
      struct timeval boot; size_t size=sizeof(boot); struct identity self;
      if (sysctlbyname("kern.boottime",&boot,&size,NULL,0)!=0 || inspect(getpid(),&self)!=0) return 3;
      if (boot.tv_sec!=strtol(argv[3],NULL,10) || boot.tv_usec!=strtol(argv[4],NULL,10)) { puts("{\"status\":\"absent\"}"); return 0; }
      if (self.coalition.ids[0]==coalition) return 4;
    }
    for(int attempt=0; attempt<40; attempt++) {
      struct identity *list; int count = members(coalition, guardian, &list);
      if(count<0) { usleep(25000); continue; }
      if(count==0) { free(list); puts("{\"status\":\"absent\"}"); return 0; }
      // Freeze before killing, so a parent cannot fork after enumeration.
      for(int n=0;n<count;n++) signal_identity(&list[n],SIGSTOP);
      for(int n=0;n<count;n++) signal_identity(&list[n],SIGKILL);
      free(list); usleep(25000);
    }
    puts("{\"status\":\"uncertain\"}"); return 3;
  }
  return 2;
}
