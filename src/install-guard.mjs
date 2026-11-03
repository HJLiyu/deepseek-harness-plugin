export function assertInstallerIdle(health, bindings, threadId) {
  if (threadId && bindings.some(b => Object.values(b.contexts ?? {}).includes(threadId))) {
    throw new Error('不能在群成员自己的原生回合内更新该插件。请先结算当前回合，再由独立维护会话正常更新；本次尚未修改安装文件。');
  }
  if (health.running > 0) throw new Error('群内仍有执行中的回合，暂不安装或重载插件。先保留并结算原生检查点，再由独立维护会话更新；不打断当前回合。');
}

export function reusablePlugin(registry, version) {
  return registry.installed?.some(p => p.pluginId === 'codex-deepseek-harness@haoju-local' && p.installed === true && p.enabled === true && p.version === version) ?? false;
}

export async function waitForAdapter(readHealth, adapterId, {now=Date.now,delay=ms=>new Promise(r=>setTimeout(r,ms)),timeoutMs=6000}={}) {
  const deadline=now()+timeoutMs;
  let health;
  do {
    health=await readHealth();
    if(health.adapters?.some(a=>a.adapterId===adapterId&&a.connected)||now()>=deadline)return health;
    await delay(Math.min(500,Math.max(0,deadline-now())));
  }while(now()<=deadline);
  return health;
}
