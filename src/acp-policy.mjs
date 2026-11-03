// Loaded into a dedicated Harness ACP child, never into the desktop profile.
import fs from 'node:fs';
export const name='codex-group-acp-policy';
export const inject=['permissionPresets'];
export function apply(ctx){
  const preset=process.env.HARNESS_PEER_PHASE==='work'||process.env.HARNESS_PEER_PHASE==='integrate'?'workspace-write':'read-only';
  // inbox/claimed runs for the exact resumed agent before its turn starts.
  ctx.on('agent/inbox/claimed',({agent})=>ctx.permissionPresets.set(agent.session,preset));
  ctx.on('session/event',(session,event)=>{if(event.type==='user/message')ctx.permissionPresets.set(session,preset);});
  if(!process.env.HARNESS_ACP_POLICY_RECEIPT)throw Error('Missing dedicated ACP policy receipt.');
  fs.writeFileSync(process.env.HARNESS_ACP_POLICY_RECEIPT,JSON.stringify({pid:process.pid,preset}),{mode:0o600,flag:'wx'});
}
