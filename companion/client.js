window.__ModuleLoader__.load({id:'dsh-codex-group',factory:require=>{
  const React=require('react'),h=React.createElement;
  function Panel({sessions,onNative}){
    const[entry,setEntry]=React.useState(null),[error,setError]=React.useState(''),[selected,setSelected]=React.useState('');
    React.useEffect(()=>{fetch('/api/codex-group/entry').then(async r=>{const b=await r.json();if(!r.ok)throw Error(b.error);setEntry(b);setSelected(b.groups?.[0]?.sessionId||'')}).catch(e=>setError(e.message))},[]);
    if(!entry)return h('div',{style:{padding:16}},error||'正在连接项目群…');
    return h('div',{style:{display:'flex',flexDirection:'column',height:'100%'}},h('div',{style:{display:'flex',gap:8,padding:8}},h('select',{value:selected,onChange:e=>setSelected(e.target.value),'aria-label':'群的原生 Harness 会话'},...(entry.groups||[]).map(g=>h('option',{key:g.sessionId,value:g.sessionId},g.groupId))),h('button',{disabled:!selected,onClick:()=>sessions.refresh().then(()=>{sessions.open(selected);onNative?.()}).catch(e=>setError(e.message))},'进入群的原生会话'),error?h('span',{role:'alert'},error):null),h('iframe',{src:entry.url,title:'Codex × Harness 群聊',style:{width:'100%',flex:1,minHeight:'50vh',border:0}}));
  }
  function apply(ctx){
    let dispose;
    const BoundPanel=props=>h(Panel,{...props,sessions:ctx.sessions});
    const presence=()=>fetch('/api/codex-group/presence',{method:'POST'}).catch(()=>{});
    presence();const heartbeat=setInterval(presence,4000);
    let attempts=0;
    const timer=setInterval(()=>{let service;try{service=(typeof ctx.get==='function'?ctx.get('betterSidebar'):null)||ctx.betterSidebar}catch{}if(service?.registerTab){dispose=service.registerTab({id:'codex-group',title:'项目群聊',description:'你、Codex、Harness 的同一个项目群',order:61,single:true,component:BoundPanel});clearInterval(timer)}else if(++attempts>=12)clearInterval(timer)},800);
    ctx.on?.('dispose',()=>{clearInterval(timer);clearInterval(heartbeat);if(typeof dispose==='function')dispose()});
    ctx.slots.inject('shell.overlay',()=>ctx.slots.register({name:'shell.overlay',id:'codex-group-entry',order:90001},()=>{const[open,setOpen]=React.useState(false);return h('div',null,h('button',{onClick:()=>setOpen(!open),style:{position:'fixed',right:18,top:60,zIndex:9000}},'项目群聊'),open?h('div',{style:{position:'fixed',inset:'10% 5%',zIndex:90001,display:'flex',flexDirection:'column',background:'var(--dsw-alias-bg-layer-1, Canvas)'}},h('button',{onClick:()=>setOpen(false)},'关闭'),h(BoundPanel,{onNative:()=>setOpen(false)})):null)}));
  }
  return {inject:['slots','sessions'],apply}
}});
