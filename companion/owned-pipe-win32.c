/* Process-local compatibility for new libuv stdio pipes. No token or file ACL edits. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wchar.h>
#include <string.h>
#include <stdio.h>

/* Win32 ABI declarations omitted by the small compiler's legacy header set. */
typedef struct { void *multiple; DWORD operation,form,type; LPWSTR name; } PIPE_TRUSTEE;
typedef struct { DWORD permissions,mode,inheritance; PIPE_TRUSTEE trustee; } PIPE_ACCESS;
typedef struct { SID_AND_ATTRIBUTES Label; } PIPE_INTEGRITY;
typedef char check_pipe_access_size[(sizeof(PIPE_ACCESS)==48)?1:-1];
WINADVAPI DWORD WINAPI GetSecurityInfo(HANDLE,DWORD,DWORD,PSID *,PSID *,PACL *,PACL *,PSECURITY_DESCRIPTOR *);
WINADVAPI DWORD WINAPI SetSecurityInfo(HANDLE,DWORD,DWORD,PSID,PSID,PACL,PACL);
WINADVAPI DWORD WINAPI SetEntriesInAclW(ULONG,PIPE_ACCESS *,PACL,PACL *);
WINADVAPI VOID WINAPI BuildTrusteeWithSidW(PIPE_TRUSTEE *,PSID);

typedef HANDLE (WINAPI *CREATE_PIPE)(LPCSTR,DWORD,DWORD,DWORD,DWORD,DWORD,DWORD,LPSECURITY_ATTRIBUTES);
static CREATE_PIPE original_create;
static void **import_slot;
static void *original_import;
static PSID logon_sid;
static wchar_t workspace[32768];
static size_t workspace_length;
static volatile LONG enabled, granted, failed, last_failure, active_calls;

static void *token_information(HANDLE token, int kind) {
  DWORD size=0;
  void *buffer;
  GetTokenInformation(token,(TOKEN_INFORMATION_CLASS)kind,NULL,0,&size);
  if (!size || size>65536) return NULL;
  buffer=LocalAlloc(LPTR,size);
  if (buffer && !GetTokenInformation(token,(TOKEN_INFORMATION_CLASS)kind,buffer,size,&size)) { LocalFree(buffer); buffer=NULL; }
  return buffer;
}
static DWORD select_restricted_logon(void) {
  HANDLE token=NULL;
  TOKEN_GROUPS *groups=NULL,*restrictions=NULL;
  PIPE_INTEGRITY *integrity=NULL;
  PSID selected=NULL;
  DWORD error=ERROR_NOT_SUPPORTED,i,j;
  if (!OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&token)) return GetLastError();
  if (!IsTokenRestricted(token)) goto done;
  integrity=(PIPE_INTEGRITY *)token_information(token,25);
  groups=(TOKEN_GROUPS *)token_information(token,2);
  restrictions=(TOKEN_GROUPS *)token_information(token,11);
  if (!integrity || !groups || !restrictions) goto done;
  if (*GetSidSubAuthority(integrity->Label.Sid,*GetSidSubAuthorityCount(integrity->Label.Sid)-1)>4096) goto done;
  for (i=0;i<groups->GroupCount;i++) if ((groups->Groups[i].Attributes&SE_GROUP_LOGON_ID)==SE_GROUP_LOGON_ID) selected=groups->Groups[i].Sid;
  if (!selected) goto done;
  for (j=0;j<restrictions->GroupCount;j++) if (EqualSid(selected,restrictions->Groups[j].Sid)) break;
  if (j==restrictions->GroupCount) goto done;
  logon_sid=LocalAlloc(LPTR,GetLengthSid(selected));
  if (!logon_sid || !CopySid(GetLengthSid(selected),logon_sid,selected)) { error=ERROR_NOT_ENOUGH_MEMORY; goto done; }
  error=ERROR_SUCCESS;
done:
  if (integrity) LocalFree(integrity);
  if (groups) LocalFree(groups);
  if (restrictions) LocalFree(restrictions);
  if (token) CloseHandle(token);
  if (error && logon_sid) { LocalFree(logon_sid); logon_sid=NULL; }
  return error;
}
static int cwd_within_workspace(void) {
  wchar_t cwd[32768];
  DWORD n=GetCurrentDirectoryW(32768,cwd);
  if (!n || n>=32768 || n<workspace_length || _wcsnicmp(cwd,workspace,workspace_length)) return 0;
  return !cwd[workspace_length] || cwd[workspace_length]==L'\\' || workspace[workspace_length-1]==L'\\';
}
static int own_pipe(LPCSTR name,DWORD access,DWORD mode,DWORD instances,DWORD out_size,DWORD in_size,DWORD timeout,LPSECURITY_ATTRIBUTES attributes) {
  static const char prefix[]="\\\\?\\pipe\\uv\\";
  char pid[24];
  const char *p;
  if (!name || attributes || (access&0xc0000)!=0xc0000 || (access&3)<1 ||
      (access&~(DWORD)0x400c0003) || mode || instances!=1 || out_size!=65536 || in_size!=65536 || timeout) return 0;
  if (strncmp(name,prefix,sizeof(prefix)-1)) return 0;
  p=name+sizeof(prefix)-1;
  if (*p<'0' || *p>'9') return 0;
  while (*p>='0' && *p<='9') p++;
  if (*p++!='-') return 0;
  sprintf(pid,"%lu",GetCurrentProcessId());
  return !strcmp(p,pid) && cwd_within_workspace();
}
static DWORD grant_new_pipe(HANDLE pipe) {
  PACL old_acl=NULL,new_acl=NULL;
  PSECURITY_DESCRIPTOR descriptor=NULL;
  PIPE_ACCESS access;
  DWORD error=GetSecurityInfo(pipe,6,DACL_SECURITY_INFORMATION,NULL,NULL,&old_acl,NULL,&descriptor);
  if (error) return error;
  ZeroMemory(&access,sizeof(access));
  access.permissions=0x0016019f; /* read/write + READ_CONTROL/SYNCHRONIZE/WRITE_DAC; excludes WRITE_OWNER. */
  access.mode=1;
  BuildTrusteeWithSidW(&access.trustee,logon_sid);
  error=SetEntriesInAclW(1,&access,old_acl,&new_acl);
  if (!error) error=SetSecurityInfo(pipe,6,DACL_SECURITY_INFORMATION,NULL,NULL,new_acl,NULL);
  if (new_acl) LocalFree(new_acl);
  if (descriptor) LocalFree(descriptor);
  return error;
}
static HANDLE WINAPI create_owned_pipe(LPCSTR name,DWORD access,DWORD mode,DWORD instances,DWORD out_size,DWORD in_size,DWORD timeout,LPSECURITY_ATTRIBUTES attributes) {
  HANDLE result;
  DWORD error,grant_error;
  InterlockedIncrement(&active_calls);
  result=original_create(name,access,mode,instances,out_size,in_size,timeout,attributes);
  error=GetLastError();
  if (result!=INVALID_HANDLE_VALUE && enabled && own_pipe(name,access,mode,instances,out_size,in_size,timeout,attributes)) {
    grant_error=grant_new_pipe(result);
    if (grant_error) {
      InterlockedIncrement(&failed); InterlockedExchange(&last_failure,(LONG)grant_error);
      CloseHandle(result); result=INVALID_HANDLE_VALUE; error=ERROR_NOT_SUPPORTED;
    } else InterlockedIncrement(&granted);
  }
  InterlockedDecrement(&active_calls);
  SetLastError(error);
  return result;
}
static int inside_image(DWORD rva,SIZE_T bytes,DWORD size) { return rva<size && bytes<=(SIZE_T)size-rva; }
__declspec(dllexport) DWORD WINAPI OwnedPipeInstall(LPCWSTR root) {
  BYTE *base=(BYTE *)GetModuleHandleW(NULL);
  IMAGE_DOS_HEADER *dos=(IMAGE_DOS_HEADER *)base;
  IMAGE_NT_HEADERS64 *nt;
  IMAGE_DATA_DIRECTORY dir;
  DWORD size,offset,old_protect,ignored,error;
  void **found=NULL;
  HMODULE kernel=GetModuleHandleW(L"kernel32.dll");
  if (enabled) return ERROR_SUCCESS;
  if (!root || !*root || wcslen(root)>=32760 || sizeof(void *)!=8) return ERROR_INVALID_PARAMETER;
  if (!GetFullPathNameW(root,32768,workspace,NULL)) return GetLastError();
  workspace_length=wcslen(workspace);
  while (workspace_length>3 && workspace[workspace_length-1]==L'\\') workspace[--workspace_length]=0;
  if (!cwd_within_workspace()) return ERROR_ACCESS_DENIED;
  if (dos->e_magic!=IMAGE_DOS_SIGNATURE || dos->e_lfanew<0 || dos->e_lfanew>1048576) return ERROR_BAD_EXE_FORMAT;
  nt=(IMAGE_NT_HEADERS64 *)(base+dos->e_lfanew);
  if (nt->Signature!=IMAGE_NT_SIGNATURE || nt->OptionalHeader.Magic!=0x20b) return ERROR_BAD_EXE_FORMAT;
  size=nt->OptionalHeader.SizeOfImage;dir=nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
  if (!inside_image(dir.VirtualAddress,dir.Size,size) || dir.Size>20000) return ERROR_BAD_EXE_FORMAT;
  for (offset=0;offset+sizeof(IMAGE_IMPORT_DESCRIPTOR)<=dir.Size;offset+=sizeof(IMAGE_IMPORT_DESCRIPTOR)) {
    IMAGE_IMPORT_DESCRIPTOR *d=(IMAGE_IMPORT_DESCRIPTOR *)(base+dir.VirtualAddress+offset);
    DWORD i;
    if (!d->FirstThunk) break;
    if (!d->OriginalFirstThunk) continue;
    for (i=0;i<20000;i++) {
      ULONGLONG name_rva;
      DWORD rva=d->OriginalFirstThunk+i*8;
      if (!inside_image(rva,8,size) || !inside_image(d->FirstThunk+i*8,8,size)) return ERROR_BAD_EXE_FORMAT;
      name_rva=*(ULONGLONG *)(base+rva);
      if (!name_rva) break;
      if (name_rva&0x8000000000000000ULL) continue;
      if (name_rva>0xffffffffULL || !inside_image((DWORD)name_rva,19,size)) return ERROR_BAD_EXE_FORMAT;
      if (memcmp(base+(DWORD)name_rva+2,"CreateNamedPipeA\0",17)) continue;
      if (found) return ERROR_NOT_SUPPORTED;
      found=(void **)(base+d->FirstThunk+i*8);
    }
  }
  original_create=(CREATE_PIPE)GetProcAddress(kernel,"CreateNamedPipeA");
  if (!found || *found!=(void *)original_create) return ERROR_NOT_SUPPORTED;
  error=select_restricted_logon();if (error) return error;
  if (!VirtualProtect(found,sizeof(void *),PAGE_READWRITE,&old_protect)) return GetLastError();
  import_slot=found;original_import=*found;InterlockedExchange(&enabled,1);
  InterlockedExchangePointer(found,(void *)create_owned_pipe);
  if (!VirtualProtect(found,sizeof(void *),old_protect,&ignored)) return GetLastError();
  return ERROR_SUCCESS;
}
__declspec(dllexport) DWORD WINAPI OwnedPipeUninstall(void) {
  DWORD old_protect,ignored;
  if (!import_slot) return ERROR_SUCCESS;
  if (!VirtualProtect(import_slot,sizeof(void *),PAGE_READWRITE,&old_protect)) return GetLastError();
  if (*import_slot==(void *)create_owned_pipe) InterlockedExchangePointer(import_slot,original_import);
  VirtualProtect(import_slot,sizeof(void *),old_protect,&ignored);InterlockedExchange(&enabled,0);
  /* Keep immutable data and the DLL alive through process teardown to avoid an in-flight import race. */
  return active_calls?ERROR_BUSY:ERROR_SUCCESS;
}
__declspec(dllexport) void WINAPI OwnedPipeStatus(LONG *values) {
  if (!values) return;
  values[0]=enabled;values[1]=granted;values[2]=failed;values[3]=last_failure;
}
