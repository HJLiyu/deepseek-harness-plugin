import test from'node:test';import assert from'node:assert/strict';import{createHash}from'node:crypto';
import{deliveryUnsettled}from'../src/group-admission.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
const store={group:()=>({contexts:{codex:'ct',harness:'ht'}}),request:()=>({revision:4}),hash};
test('known terminal empty reply releases only session occupancy, with exact original native proof',()=>{
 const d={id:'d',groupId:'g',requestId:'r',started:true,status:'completed_without_reply',member:'codex',prompt:'p',nativeTurnId:'t',nativeAdmission:{threadId:'ct',turnId:'t',promptHash:hash('[Group delivery d]\np')},nativeEmptyProof:{kind:'codex-empty-turn',threadId:'ct',turnId:'t',status:'completed',itemCount:0}};
 assert.equal(deliveryUnsettled(store,d),false);assert.equal(d.status,'completed_without_reply');
 for(const change of [x=>delete x.nativeEmptyProof,x=>x.nativeEmptyProof.turnId='other',x=>x.prompt='changed',x=>x.nativeEmptyProof.itemCount=1]){const x=structuredClone(d);change(x);assert.equal(deliveryUnsettled(store,x),true);}
 const h={...d,member:'harness',nativeEmptyProof:null,nativeTerminalProof:{deliveryId:'d',sessionId:'ht',reason:'completed',idle:true,turn:3,endSeq:4}};
 assert.equal(deliveryUnsettled(store,h),false);h.nativeTerminalProof.idle=false;assert.equal(deliveryUnsettled(store,h),true);
});
test('quarantined superseded planning is historical uncertainty, never an active execution or a successful task',()=>{
 const d={id:'d',groupId:'g',requestId:'r',started:true,status:'unmatched_superseded_readonly',member:'codex',phase:'planning',revision:3,recoveryProof:{kind:'superseded-readonly-unmatched',threadId:'ct',completeNativeTurnCount:20,desktopStatus:'idle'}};
 assert.equal(deliveryUnsettled(store,d),false);assert.equal(d.status,'unmatched_superseded_readonly');
 for(const change of [x=>x.phase='work',x=>x.phase='integrate',x=>x.revision=4,x=>x.recoveryProof.threadId='other',x=>x.recoveryProof.desktopStatus='running',x=>x.nativeTurnId='unknown',x=>delete x.recoveryProof]){const x=structuredClone(d);change(x);assert.equal(deliveryUnsettled(store,x),true);}
 assert.equal(deliveryUnsettled(store,{...d,status:'unknown'}),true);
});
