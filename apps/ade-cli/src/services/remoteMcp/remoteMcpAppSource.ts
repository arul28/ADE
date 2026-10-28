/**
 * The source of ADE MCP's one MCP Apps view (`ui://ade/app-….html`): its CSS
 * and its script, kept as plain strings so the HTML ships inside the brain
 * with no build step, no network and no dependency. `remoteMcpApps.ts` puts
 * them in one document.
 *
 * The script speaks the MCP Apps postMessage protocol itself (SEP-1865,
 * spec 2026-01-26): `ui/initialize`, then `ui/notifications/initialized`;
 * it renders `ui/notifications/tool-result`, answers `ping` and
 * `ui/resource-teardown`, reports `ui/notifications/size-changed`, and calls
 * `tools/call` / `ui/open-link` through the host. It builds every node with
 * textContent, never innerHTML, so nothing in a tool result can run.
 *
 * Authoring rule for APP_JS: no backticks and no dollar-brace, because it
 * lives in a String.raw template literal; and never the closing script tag.
 */

export const APP_CSS = String.raw`
:root{color-scheme:light dark;
--ade-bg:#0C0B10;--ade-fg:#F0F0F2;--ade-muted:#908FA0;--ade-accent:#A78BFA;
--ade-ok:#22c55e;--ade-warn:#f59e0b;--ade-crit:#ef4444;--ade-info:#38bdf8;
--pr-open:#3fb950;--pr-merged:#a371f7;--pr-closed:#f85149;--add:#3fb950;--del:#f85149}
:root[data-theme=light]{--ade-bg:#f5f3f0;--ade-fg:#1a1a1e;--ade-muted:#636370;--ade-accent:#049068;
--ade-ok:#16a34a;--ade-warn:#d97706;--ade-crit:#dc2626;--ade-info:#0284c7;
--pr-open:#1a7f37;--pr-merged:#8250df;--pr-closed:#cf222e;--add:#1a7f37;--del:#cf222e}
:root{--bg:var(--color-background-primary,var(--ade-bg));--fg:var(--color-text-primary,var(--ade-fg));
--muted:var(--color-text-secondary,var(--ade-muted));--accent:var(--ade-accent);
--ok:var(--ade-ok);--warn:var(--ade-warn);--crit:var(--ade-crit);
--t2:color-mix(in srgb,var(--fg) 70%,var(--muted));--t3:var(--muted);
--hover:color-mix(in srgb,var(--fg) 5.5%,transparent);--active:color-mix(in srgb,var(--fg) 9%,transparent);
--rule:color-mix(in srgb,var(--fg) 7%,transparent);--track:color-mix(in srgb,var(--fg) 9%,transparent);
--fill:color-mix(in srgb,var(--fg) 62%,transparent);
--edge:var(--color-border-primary,color-mix(in srgb,var(--fg) 8%,transparent));
--card:color-mix(in srgb,var(--bg) 58%,transparent);
--sans:var(--font-sans,"Geist",system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);
--mono:var(--font-mono,"JetBrains Mono","Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace);
--r-lg:var(--border-radius-lg,12px);--r-md:var(--border-radius-md,8px);--r-sm:var(--border-radius-sm,6px)}
:root[data-theme=light]{--t2:color-mix(in srgb,var(--fg) 76%,var(--muted));--card:color-mix(in srgb,var(--bg) 72%,transparent);
--edge:var(--color-border-primary,color-mix(in srgb,var(--fg) 10%,transparent))}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:transparent}
body{font-family:var(--sans);font-size:12.5px;line-height:1.45;color:var(--fg);-webkit-font-smoothing:antialiased}
button{font:inherit;color:inherit}
:where(button,[tabindex]):focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.card{display:flex;flex-direction:column;min-width:0;border:1px solid var(--edge);border-radius:var(--r-lg);background:var(--card);overflow:hidden}
.card+.card{margin-top:8px}
.head{display:flex;align-items:center;gap:8px;height:40px;padding:0 14px;font-size:12.5px;font-weight:500;flex:none;min-width:0}
.head .lbl{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.count,.num{font-family:var(--mono);font-variant-numeric:tabular-nums}
.count{font-size:11px;color:var(--t3)}
.ctx{margin-left:auto;display:flex;align-items:center;gap:6px;color:var(--t3);font-size:11px;min-width:0;white-space:nowrap;overflow:hidden}
.ctx span{overflow:hidden;text-overflow:ellipsis}
.chip{display:inline-flex;align-items:center;gap:4px;height:18px;padding:0 7px;border-radius:999px;border:1px solid color-mix(in srgb,var(--fg) 10%,transparent);background:color-mix(in srgb,var(--fg) 4%,transparent);font-size:10.5px;color:var(--t2);white-space:nowrap;flex:none}
.back{border:0;background:transparent;color:var(--t3);cursor:pointer;height:24px;padding:0 6px;margin-left:-6px;border-radius:var(--r-sm);font-size:12px}
.back:hover{background:var(--hover);color:var(--fg)}
.body{padding:2px 14px 14px;min-height:0}
.flush{padding:0 6px 6px}
.eyebrow{font-family:var(--mono);font-size:10px;line-height:14px;font-weight:500;letter-spacing:.22em;text-transform:uppercase;color:var(--t3)}
.sec{display:flex;align-items:center;gap:8px;padding:10px 8px 4px}
.rule{height:1px;background:var(--rule);border:0;margin:6px 0}
.row{display:flex;align-items:center;gap:10px;min-height:32px;padding:4px 8px;border-radius:var(--r-md);font-size:12.5px;width:100%;text-align:left;border:0;background:transparent;color:var(--fg)}
button.row{cursor:pointer}
button.row:hover{background:var(--hover)}
.grow{flex:1;min-width:0}
.trunc{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dim{color:var(--t3)}
.t2{color:var(--t2)}
.mono{font-family:var(--mono)}
.small{font-size:11px}
.dot{flex:none;width:6px;height:6px;border-radius:999px;background:color-mix(in srgb,var(--muted) 60%,transparent)}
.dot[data-s=ok]{background:var(--ok)}.dot[data-s=warn]{background:var(--warn)}.dot[data-s=crit]{background:var(--crit)}
.dot[data-s=accent]{background:var(--accent)}.dot[data-s=info]{background:var(--ade-info)}
.dot.big{width:8px;height:8px}
.tag{display:inline-flex;align-items:center;gap:4px;height:18px;padding:0 6px;border-radius:4px;font-family:var(--mono);font-size:10px;letter-spacing:.06em;background:color-mix(in srgb,var(--fg) 7%,transparent);color:var(--t2);white-space:nowrap;flex:none}
.tag[data-t=ok]{background:color-mix(in srgb,var(--ok) 14%,transparent);color:var(--ok)}
.tag[data-t=warn]{background:color-mix(in srgb,var(--warn) 14%,transparent);color:var(--warn)}
.tag[data-t=crit]{background:color-mix(in srgb,var(--crit) 14%,transparent);color:var(--crit)}
.tag[data-t=accent]{background:color-mix(in srgb,var(--accent) 16%,transparent);color:var(--accent)}
.meter{position:relative;height:4px;border-radius:999px;background:var(--track);overflow:hidden}
.meter>span{position:absolute;inset:0 auto 0 0;border-radius:inherit;background:var(--fill)}
.meter[data-l=warn]>span{background:var(--warn)}.meter[data-l=crit]>span{background:var(--crit)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:26px;padding:0 10px;border:1px solid color-mix(in srgb,var(--fg) 12%,transparent);border-radius:var(--r-md);background:color-mix(in srgb,var(--fg) 3%,transparent);font-size:12px;font-weight:500;white-space:nowrap;cursor:pointer}
.btn:hover:not(:disabled){background:var(--active)}
.btn:disabled{opacity:.55;cursor:default}
.btn.primary{border-color:transparent;background:var(--fg);color:var(--bg);font-weight:600}
.btn.primary:hover:not(:disabled){background:color-mix(in srgb,var(--fg) 86%,var(--bg))}
.btn.ghost{border-color:transparent;background:transparent;color:var(--t2)}
.btn.ghost:hover:not(:disabled){background:var(--hover);color:var(--fg)}
.btn[data-t=crit]{color:var(--crit)}
.input{height:26px;padding:0 10px;border:1px solid var(--edge);border-radius:var(--r-md);outline:none;background:var(--hover);color:var(--fg);font:inherit;font-size:12px;min-width:0;flex:1}
.input:focus{border-color:color-mix(in srgb,var(--fg) 35%,transparent)}
.more{display:block;width:100%;margin-top:2px;border:0;background:transparent;color:var(--t3);font-size:11.5px;padding:6px 8px;text-align:left;border-radius:var(--r-md);cursor:pointer}
.more:hover{background:var(--hover);color:var(--fg)}
.empty{padding:14px 8px;color:var(--t3);font-size:12px}
.err{color:var(--crit);font-size:12px;padding:6px 8px}
.wrow{display:block;padding:8px 8px;border-radius:var(--r-md)}
.wl{display:flex;align-items:center;gap:6px;min-width:0;height:18px;font-size:11px}
.wt{margin-top:2px;font-size:12.5px;font-weight:600;min-width:0}
.wp{margin-top:1px;display:flex;gap:8px;align-items:center;font-size:12px;color:color-mix(in srgb,var(--muted) 90%,transparent);min-width:0}
.wp i{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lane{font-weight:600;color:var(--accent);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.status{margin-left:auto;display:inline-flex;align-items:center;gap:5px;font-size:11px;white-space:nowrap;flex:none;color:var(--t3)}
.status[data-s=info]{color:var(--ade-info)}.status[data-s=warn]{color:var(--warn)}.status[data-s=ok]{color:var(--ok)}.status[data-s=crit]{color:var(--crit)}
.tx{display:flex;flex-direction:column;gap:10px;padding:6px 14px 14px;max-height:520px;overflow:auto}
.u{align-self:flex-end;max-width:82%;padding:8px 12px;border-radius:16px;color:#fff;white-space:pre-wrap;word-break:break-word;
background:linear-gradient(135deg,color-mix(in srgb,var(--accent) 76%,#fff 6%) 0%,color-mix(in srgb,var(--accent) 60%,#7c3aed 40%) 50%,color-mix(in srgb,var(--accent) 58%,#4c1d95 42%) 100%);
border:1px solid color-mix(in srgb,var(--accent) 26%,rgba(255,255,255,.14))}
:root[data-theme=light] .u{background:linear-gradient(135deg,rgba(0,0,0,.22),rgba(0,0,0,.08)),linear-gradient(135deg,color-mix(in srgb,var(--accent) 76%,#fff 6%) 0%,color-mix(in srgb,var(--accent) 60%,#7c3aed 40%) 50%,color-mix(in srgb,var(--accent) 58%,#4c1d95 42%) 100%)}
.u code{background:rgba(0,0,0,.3)}
.a{max-width:100%;font-size:13px;line-height:1.55;word-break:break-word}
.a p,.u p{margin:0;white-space:pre-wrap}.a>*+*{margin-top:8px}.a ul{margin:0;padding-left:18px}.a li+li{margin-top:2px}.mdh{font-weight:600}
code{font-family:var(--mono);font-size:.92em;padding:0 4px;border-radius:4px;background:color-mix(in srgb,var(--fg) 8%,transparent)}
pre{margin:0;font-family:var(--mono);font-size:11.5px;line-height:1.5;padding:8px 10px;border-radius:var(--r-md);background:color-mix(in srgb,var(--fg) 5%,transparent);overflow:auto;white-space:pre}
.ts{font-size:10.5px;color:var(--t3);font-family:var(--mono)}
details.tool{border:1px solid var(--rule);border-radius:var(--r-md);font-size:12px}
details.tool>summary{list-style:none;cursor:pointer;display:flex;gap:6px;align-items:center;padding:4px 8px;color:var(--t2)}
details.tool>summary::-webkit-details-marker{display:none}
details.tool>summary:before{content:"\25B8";font-size:10px;color:var(--t3)}
details.tool[open]>summary:before{content:"\25BE"}
details.tool>pre{border-radius:0 0 var(--r-md) var(--r-md);max-height:220px}
.strip{display:flex;gap:22px;padding:2px 14px 10px}
.strip b{display:block;font-size:15px;font-weight:600;font-family:var(--mono);font-variant-numeric:tabular-nums}
.strip small{font-size:11px;color:var(--t3);font-weight:500}
.bar{display:flex;height:4px;border-radius:999px;overflow:hidden;background:var(--track);margin:0 14px 6px}
.bar>span{display:block;height:100%}
.add{color:var(--add)}.del{color:var(--del)}
.diff{font-family:var(--mono);font-size:11.5px;line-height:1.55;max-height:520px;overflow:auto;border-top:1px solid var(--rule)}
.diff div{white-space:pre;padding:0 14px;min-width:max-content}
.diff .p{background:color-mix(in srgb,var(--add) 13%,transparent)}
.diff .m{background:color-mix(in srgb,var(--del) 13%,transparent)}
.diff .h{color:var(--accent);background:color-mix(in srgb,var(--accent) 7%,transparent)}
.diff .f{color:var(--t3)}
.acct{padding:8px 8px 10px}
.acct+.acct{border-top:1px solid var(--rule)}
.win{display:grid;grid-template-columns:64px 1fr 74px;gap:4px 10px;align-items:center;margin-top:7px;font-size:11.5px}
.win .meter{grid-column:2}
.win>.num{text-align:right}
.win .r{color:var(--t3);font-size:10.5px;grid-column:2/4;margin-top:-2px}
.swatch{width:8px;height:8px;border-radius:2px;flex:none}
.ask{padding:10px 14px 12px;border-top:1px solid var(--rule)}
.ask:first-child{border-top:0}
.ask .q{margin:6px 0 8px;font-size:13px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.ask .opts{display:flex;flex-wrap:wrap;gap:6px}
.ask .opt{height:auto;min-height:26px;padding:4px 10px;text-align:left;white-space:normal;flex-direction:column;align-items:flex-start;gap:0}
.ask .opt small{font-weight:400;color:var(--t3);font-size:11px}
.btn.primary small{color:color-mix(in srgb,var(--bg) 78%,transparent)}
.ask .free{display:flex;gap:6px;margin-top:8px}
.done{display:flex;align-items:center;gap:8px;font-size:12.5px}
.done .grow{font-weight:500}
.kv{display:grid;grid-template-columns:minmax(90px,max-content) 1fr;gap:4px 14px;padding:4px 8px 8px;font-size:12px}
.kv>dt{font-family:var(--mono);font-size:10.5px;color:var(--t3);padding-top:2px;word-break:break-all}
.kv>dd{margin:0;min-width:0;word-break:break-word;white-space:pre-wrap}
.text{white-space:pre-wrap;word-break:break-word;font-family:var(--mono);font-size:11.5px;padding:4px 8px 8px;max-height:420px;overflow:auto}
.muted-load{padding:12px 14px;color:var(--t3);font-size:12px}
.mgroup+.mgroup{margin-top:4px}
.mgroup>.sec{padding-left:14px}
.label{display:inline-flex;align-items:center;gap:5px;height:18px;padding:0 7px;border-radius:999px;font-size:10.5px;border:1px solid color-mix(in srgb,var(--fg) 12%,transparent);color:var(--t2);flex:none}
.label i{width:7px;height:7px;border-radius:99px}
.prbody{font-size:12.5px;line-height:1.55;word-break:break-word;padding:2px 8px 6px;max-height:280px;overflow:auto;color:var(--t2)}
@media (prefers-reduced-motion:no-preference){.row,.btn,.more{transition:background-color .1s ease,color .1s ease}}
`;

export const APP_JS = String.raw`
(function(){
"use strict";
var PROTOCOL="2026-01-26";
var nextId=1,pending={},ctx={},state={tool:null,args:null,stack:[]};
var root=document.getElementById("app");
var parentWin=window.parent;

/* ---------- transport ---------- */
function post(msg){try{parentWin.postMessage(msg,"*")}catch(e){}}
function request(method,params,timeoutMs){
  var id=nextId++;
  return new Promise(function(resolve,reject){
    var timer=setTimeout(function(){delete pending[id];reject(new Error("The host did not answer."))},timeoutMs||120000);
    pending[id]={resolve:function(v){clearTimeout(timer);resolve(v)},reject:function(e){clearTimeout(timer);reject(e)}};
    post({jsonrpc:"2.0",id:id,method:method,params:params||{}});
  });
}
function notify(method,params){post({jsonrpc:"2.0",method:method,params:params||{}})}
window.addEventListener("message",function(ev){
  if(ev.source!==parentWin)return;
  var m=ev.data;
  if(!m||typeof m!=="object"||m.jsonrpc!=="2.0")return;
  if(m.method===undefined&&m.id!==undefined){
    var p=pending[m.id];if(!p)return;delete pending[m.id];
    if(m.error)p.reject(new Error(m.error&&m.error.message||"Request failed"));else p.resolve(m.result);
    return;
  }
  if(typeof m.method!=="string")return;
  if(m.id!==undefined&&m.id!==null){
    if(m.method==="ping"||m.method==="ui/resource-teardown")post({jsonrpc:"2.0",id:m.id,result:{}});
    else post({jsonrpc:"2.0",id:m.id,error:{code:-32601,message:"Method not found: "+m.method}});
    return;
  }
  var params=m.params||{};
  if(m.method==="ui/notifications/tool-input"){state.args=params.arguments||{};if(!state.result)renderLoading()}
  else if(m.method==="ui/notifications/tool-result"){state.result=params;state.stack=[];render()}
  else if(m.method==="ui/notifications/tool-cancelled"){if(!state.result)renderNote("Cancelled.")}
  else if(m.method==="ui/notifications/host-context-changed"){mergeCtx(params);applyCtx()}
});

/* ---------- host context: theme, styles, size ---------- */
function mergeCtx(next){for(var k in next){if(Object.prototype.hasOwnProperty.call(next,k))ctx[k]=next[k]}}
var fontsApplied=false;
function applyCtx(){
  var de=document.documentElement;
  var theme=ctx.theme==="light"||ctx.theme==="dark"?ctx.theme:(window.matchMedia&&window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark");
  de.setAttribute("data-theme",theme);de.style.colorScheme=theme;
  var vars=ctx.styles&&ctx.styles.variables;
  if(vars&&typeof vars==="object"){for(var k in vars){if(/^--[a-z0-9-]+$/.test(k)&&typeof vars[k]==="string")de.style.setProperty(k,vars[k])}}
  var fonts=ctx.styles&&ctx.styles.css&&ctx.styles.css.fonts;
  if(typeof fonts==="string"&&fonts&&!fontsApplied){var st=document.createElement("style");st.textContent=fonts;document.head.appendChild(st);fontsApplied=true}
  var cd=ctx.containerDimensions||{};
  de.style.height=typeof cd.height==="number"?"100vh":"";
  de.style.maxHeight=typeof cd.maxHeight==="number"?cd.maxHeight+"px":"";
  document.body.style.overflow=typeof cd.height==="number"?"auto":"";
  if(typeof cd.height==="number")document.body.style.height="100vh";
}
var lastW=0,lastH=0,sizeQueued=false;
function reportSize(){
  if(sizeQueued)return;sizeQueued=true;
  requestAnimationFrame(function(){
    sizeQueued=false;
    var de=document.documentElement,old=de.style.height;
    de.style.height="max-content";
    var h=Math.ceil(de.getBoundingClientRect().height);
    de.style.height=old;
    var w=Math.ceil(window.innerWidth);
    if(w!==lastW||h!==lastH){lastW=w;lastH=h;notify("ui/notifications/size-changed",{width:w,height:h})}
  });
}
if(typeof ResizeObserver==="function"){var ro=new ResizeObserver(reportSize);ro.observe(document.documentElement);ro.observe(document.body)}

/* ---------- dom ---------- */
function h(tag,props){
  var el=document.createElement(tag);
  if(props)for(var k in props){
    var v=props[k];if(v===undefined||v===null||v===false)continue;
    if(k==="cls")el.className=v;
    else if(k==="text")el.textContent=String(v);
    else if(k==="style")el.setAttribute("style",v);
    else if(k.slice(0,2)==="on")el.addEventListener(k.slice(2),v);
    else el.setAttribute(k,v===true?"":String(v));
  }
  for(var i=2;i<arguments.length;i++)add(el,arguments[i]);
  return el;
}
function add(el,c){
  if(c===undefined||c===null||c===false)return;
  if(Array.isArray(c)){for(var i=0;i<c.length;i++)add(el,c[i]);return}
  el.appendChild(typeof c==="object"?c:document.createTextNode(String(c)));
}
function mount(node){root.textContent="";root.appendChild(node);reportSize()}

/* ---------- values ---------- */
function isObj(v){return !!v&&typeof v==="object"&&!Array.isArray(v)}
function str(v){return typeof v==="string"&&v.trim()?v.trim():(typeof v==="number"&&isFinite(v)?String(v):null)}
function first(o,keys){if(!isObj(o))return null;for(var i=0;i<keys.length;i++){var v=str(o[keys[i]]);if(v)return v}return null}
function arr(v,keys){if(Array.isArray(v))return v.filter(isObj);if(isObj(v)&&keys)for(var i=0;i<keys.length;i++){if(Array.isArray(v[keys[i]]))return v[keys[i]].filter(isObj)}return []}
function num(v){return typeof v==="number"&&isFinite(v)?v:null}
function plural(n,w){return n+" "+w+(n===1?"":"s")}
function rel(iso){
  var t=typeof iso==="number"?iso:Date.parse(iso);if(!isFinite(t))return "";
  var s=Math.max(0,(Date.now()-t)/1000);
  if(s<60)return "now";if(s<3600)return Math.floor(s/60)+"m";if(s<86400)return Math.floor(s/3600)+"h";
  if(s<86400*30)return Math.floor(s/86400)+"d";return new Date(t).toLocaleDateString();
}
function dur(min){
  if(min===null)return "";min=Math.max(0,Math.round(min));
  var d=Math.floor(min/1440),hh=Math.floor((min%1440)/60),mm=min%60;
  if(d)return d+"d "+hh+"h";if(hh)return hh+"h "+mm+"m";return mm+"m";
}
var PROVIDERS={claude:["Claude","#C15F3C","#D97757"],anthropic:["Claude","#C15F3C","#D97757"],codex:["Codex","#0F9E8E","#2DD4BF"],openai:["Codex","#0F9E8E","#2DD4BF"],
cursor:["Cursor","#52627A","#93A6C4"],copilot:["Copilot","#2DA44E","#3FB950"],gemini:["Gemini","#2C6FE0","#5B93F5"],droid:["Droid","#B45309","#E0A82E"],
opencode:["OpenCode","#7C5CE0","#A78BFA"],grok:["Grok","#52525B","#D4D4D8"],kimi:["Kimi","#2563EB","#60A5FA"],muse:["Muse","#BE185D","#F472B6"],pi:["Pi","#4D7C0F","#A3E635"]};
function prov(p){var k=String(p||"").toLowerCase();var e=PROVIDERS[k];
  var light=document.documentElement.getAttribute("data-theme")==="light";
  return {name:e?e[0]:(k?k.charAt(0).toUpperCase()+k.slice(1):"Other"),color:e?(light?e[1]:e[2]):"var(--fill)"};}
function model(m){var s=str(m);if(!s)return "";var i=s.lastIndexOf("/");return i>=0?s.slice(i+1):s}

/* ---------- host calls ---------- */
function canCallTools(){var c=ctx.__caps||{};return !!c.serverTools}
function scopeArgs(extra,cur){
  var a={};var sc=cur||state.current||{};
  if(sc.projectId)a.project=sc.projectId;
  if(sc.machineKey)a.machine=sc.machineKey;
  for(var k in extra)if(extra[k]!==undefined&&extra[k]!==null)a[k]=extra[k];
  return a;
}
function callTool(name,args){return request("tools/call",{name:name,arguments:args},180000)}
function openLink(url){
  if(!/^(https?:|ade:)/i.test(String(url||"")))return;
  request("ui/open-link",{url:String(url)},15000).catch(function(){});
}
function drill(name,args,label){
  if(!canCallTools())return;
  var prev={result:state.result,tool:state.tool,args:state.args};
  state.stack.push(prev);
  renderNote("Loading "+label+"…",true);
  callTool(name,args).then(function(res){
    state.tool=name;state.args=args;state.result=res;render();
  }).catch(function(e){renderNote(e.message||"That did not work.",true,true)});
}
function goBack(){var p=state.stack.pop();if(!p)return;state.result=p.result;state.tool=p.tool;state.args=p.args;render()}

/* ---------- frame ---------- */
function frame(title,count,body,opts){
  opts=opts||{};
  var sc=state.current||{};
  var ctxNodes=[];
  if(sc.machineName)ctxNodes.push(h("span",{cls:"chip",title:"Computer"},sc.machineName));
  if(sc.projectName&&!opts.noProject)ctxNodes.push(h("span",{text:sc.projectName,title:sc.projectPath||sc.projectName}));
  var head=h("div",{cls:"head"},
    state.stack.length&&!opts.nested?h("button",{cls:"back",type:"button","aria-label":"Back",onclick:goBack},"‹ Back"):null,
    h("span",{cls:"lbl"},title),
    count!==null&&count!==undefined?h("span",{cls:"count"},String(count)):null,
    opts.headExtra||null,
    ctxNodes.length||opts.headEnd?h("span",{cls:"ctx"},ctxNodes,opts.headEnd||null):null);
  return h("section",{cls:"card","aria-label":title},head,body);
}
function listBody(rows,limit,emptyText){
  var box=h("div",{cls:"body flush",role:"list"});
  if(!rows.length){box.appendChild(h("div",{cls:"empty"},emptyText||"Nothing here."));return box}
  var shown=Math.min(rows.length,limit||rows.length);
  for(var i=0;i<shown;i++)box.appendChild(rows[i]);
  if(rows.length>shown){
    var more=h("button",{cls:"more",type:"button",onclick:function(){more.remove();for(var j=shown;j<rows.length;j++)box.appendChild(rows[j]);reportSize()}},"Show all "+rows.length);
    box.appendChild(more);
  }
  return box;
}

/* ---------- views ---------- */
/* chat_list rows carry a lane id only; one lanes_list call (same project and computer) names them. */
var laneNameCache={};
function laneSpan(name,id,list){
  if(!name&&!id)return null;
  var el=h("span",{cls:"lane",title:id||name},name||"");
  if(!name&&id)list.push({el:el,id:String(id)});
  return el;
}
function fillLaneNames(list,cur){
  if(!list.length)return;
  var key=((cur&&cur.projectId)||"")+"|"+((cur&&cur.machineKey)||"");
  function apply(map){list.forEach(function(x){x.el.textContent=map[x.id]||"Lane";});reportSize()}
  if(!canCallTools()){apply({});return}
  var p=laneNameCache[key]||(laneNameCache[key]=callTool("lanes_list",scopeArgs({},cur)).then(function(res){
    var sc=res&&res.structuredContent;var lanes=arr(isObj(sc)&&"result" in sc?sc.result:sc,["lanes"]);var map={};
    lanes.forEach(function(l){var id=first(l,["id"]);if(id)map[id]=first(l,["name"])||""});return map;
  }));
  p.then(apply,function(){delete laneNameCache[key];apply({})});
}
function chatStatus(c){
  var st=String(c.status||"").toLowerCase();
  if(c.awaitingInput===true||st==="awaiting-input"||st==="needs_you"||st==="blocked")return ["warn","Needs you"];
  if(st==="active"||st==="running"||st==="working")return ["info","Working"];
  if(st==="idle"||st==="ready"||st==="done")return ["ok","Done"];
  if(st==="failed"||st==="error")return ["crit","Failed"];
  if(st==="ended"||st==="stopped")return ["","Ended"];
  return ["",st?st.charAt(0).toUpperCase()+st.slice(1):""];
}
function viewChatList(r){
  var cur=state.current;
  var chats=arr(r,["sessions","chats","items"]);
  var laneSpans=[];
  var rows=chats.map(function(c){
    var s=chatStatus(c);var id=first(c,["sessionId","id"]);
    var lane=first(c,["laneName","lane"])||"";
    var when=rel(c.lastActivityAt||c.currentTurnStartedAt);
    var pv=prov(c.provider);
    var inner=[
      h("div",{cls:"wl"},laneSpan(lane,c.laneId,laneSpans),
        c.machine&&isObj(c.machine)?h("span",{cls:"chip"},first(c.machine,["name","key"])):null,
        h("span",{cls:"status","data-s":s[0]},s[0]?h("span",{cls:"dot","data-s":s[0]}):null,s[1],when?h("span",{cls:"dim"}," · "+when):null)),
      h("div",{cls:"wt trunc"},first(c,["title"])||"Untitled chat"),
      h("div",{cls:"wp"},h("i",null,first(c,["lastOutputPreview","preview","summary"])||""),
        h("span",{cls:"mono small dim",style:"flex:none"},h("span",{cls:"swatch",style:"display:inline-block;margin-right:5px;background:"+pv.color}),model(c.model)||pv.name))
    ];
    if(id&&canCallTools())return h("button",{cls:"row wrow",type:"button",role:"listitem","aria-label":(first(c,["title"])||"Chat")+", "+s[1],onclick:function(){drill("chat_read",scopeArgs({session:id},cur),"chat")}},inner);
    return h("div",{cls:"wrow",role:"listitem"},inner);
  });
  fillLaneNames(laneSpans,cur);
  return frame("Chats",chats.length,listBody(rows,12,"No chats."));
}
function mdBlocks(text,container){
  var parts=String(text||"").split(/\n?\x60\x60\x60[^\n]*\n?/);
  for(var i=0;i<parts.length;i++){
    if(i%2===1){container.appendChild(h("pre",null,parts[i].replace(/\n$/,"")));continue}
    var paras=parts[i].split(/\n{2,}/);
    for(var j=0;j<paras.length;j++){var t=paras[j].trim();if(!t)continue;
      var lines=t.split("\n");
      if(lines.every(function(l){return /^\s*([-*]|\d+\.)\s+/.test(l)})){
        var ul=h("ul");lines.forEach(function(l){ul.appendChild(inlineMd(h("li"),l.replace(/^\s*([-*]|\d+\.)\s+/,"")))});container.appendChild(ul);continue}
      var hm=/^#{1,6}\s+(.*)$/.exec(lines[0]);
      if(hm){container.appendChild(inlineMd(h("p",{cls:"mdh"}),hm[1]));lines.shift();t=lines.join("\n").trim();if(!t)continue}
      container.appendChild(inlineMd(h("p"),t))}
  }
  return container;
}
function inlineMd(el,t){
  var bits=t.split(/(\x60[^\x60\n]+\x60|\*\*[^*\n]+\*\*)/);
  for(var i=0;i<bits.length;i++){var b=bits[i];if(!b)continue;
    if(b.charAt(0)==="\x60"&&b.length>1)el.appendChild(h("code",null,b.slice(1,-1)));
    else if(b.slice(0,2)==="**"&&b.length>4)el.appendChild(h("strong",null,b.slice(2,-2)));
    else el.appendChild(document.createTextNode(b));}
  return el;
}
function viewChatRead(r){
  var entries=arr(r,["entries","messages","items","transcript"]);
  var tx=h("div",{cls:"tx",role:"log","aria-label":"Transcript"});
  if(isObj(r)&&(r.truncated===true||typeof r.nextCursor==="number"))tx.appendChild(h("div",{cls:"eyebrow",style:"text-align:center"},"Earlier messages not shown"));
  if(!entries.length)tx.appendChild(h("div",{cls:"empty"},"No messages yet."));
  entries.forEach(function(e){
    var role=String(e.role||e.kind||"").toLowerCase();
    var text=first(e,["displayText","text","content","summary"])||"";
    if(role==="tool"||role==="tool_call"||e.toolName||e.tool){
      var name=first(e,["toolName","tool","name","title"])||"Tool call";
      tx.appendChild(h("details",{cls:"tool"},h("summary",null,h("span",{cls:"mono"},name),e.status?h("span",{cls:"dim small"},String(e.status)):null),text?h("pre",null,text):null));
    }else if(role==="user"){
      tx.appendChild(h("div",{cls:"u"},text||"(empty)"));
    }else{
      tx.appendChild(mdBlocks(text||"(empty)",h("div",{cls:"a"})));
    }
  });
  var title=first(r,["title"])||"Chat";
  var card=frame(title,entries.length?plural(entries.length,"message"):null,tx);
  requestAnimationFrame(function(){tx.scrollTop=tx.scrollHeight});
  return card;
}
function checkState(c){
  var st=String(c.status||"").toLowerCase(),co=String(c.conclusion||c.state||"").toLowerCase();
  if(st&&st!=="completed")return ["warn","pending"];
  if(co==="success"||co==="passed"||co==="pass")return ["ok","passed"];
  if(co==="failure"||co==="failed"||co==="timed_out"||co==="action_required"||co==="startup_failure"||co==="error")return ["crit","failed"];
  if(co==="cancelled")return ["crit","cancelled"];
  if(co==="skipped"||co==="neutral"||co==="stale")return ["",co];
  if(!co)return ["warn","pending"];
  return ["",co];
}
function checksTone(s){s=String(s||"").toLowerCase();return s==="passing"||s==="success"?"ok":s==="failing"||s==="failure"?"crit":s==="pending"||s==="running"?"warn":""}
function viewChecks(r){
  var checks=arr(r,["checks"]);
  var rank={crit:0,warn:1,ok:2,"":3};
  var rows=checks.map(function(c){return {c:c,s:checkState(c)}}).sort(function(a,b){return rank[a.s[0]]-rank[b.s[0]]}).map(function(x){
    var c=x.c,url=str(c.url||c.detailsUrl);
    var inner=[h("span",{cls:"dot","data-s":x.s[0]}),h("span",{cls:"grow trunc"},first(c,["name"])||"check"),h("span",{cls:"small dim"},x.s[1]),url?h("span",{cls:"dim","aria-hidden":"true"},"↗"):null];
    return url?h("button",{cls:"row",type:"button",role:"listitem",title:"Open "+url,onclick:function(){openLink(url)}},inner):h("div",{cls:"row",role:"listitem"},inner);
  });
  var counts=isObj(r.checksCounts)?r.checksCounts:{};
  var pass=num(counts.passing),fail=num(counts.failing),pend=num(counts.pending),total=num(counts.total);
  if(total===null){pass=0;fail=0;pend=0;checks.forEach(function(c){var s=checkState(c)[0];if(s==="ok")pass++;else if(s==="crit")fail++;else if(s==="warn")pend++});total=checks.length}
  var body=h("div",null,
    h("div",{cls:"strip"},
      h("div",null,h("small",{cls:"eyebrow"},"Passed"),h("b",{style:"color:var(--ok)"},String(pass),h("small",null,"/"+total))),
      h("div",null,h("small",{cls:"eyebrow"},"Failed"),h("b",{style:fail?"color:var(--crit)":"color:var(--t3)"},String(fail))),
      h("div",null,h("small",{cls:"eyebrow"},"Pending"),h("b",{style:pend?"color:var(--warn)":"color:var(--t3)"},String(pend)))),
    total?h("div",{cls:"bar","aria-hidden":"true"},
      h("span",{style:"flex:"+pass+";background:var(--ok)"}),h("span",{style:"flex:"+fail+";background:var(--crit)"}),
      h("span",{style:"flex:"+pend+";background:var(--warn)"}),h("span",{style:"flex:"+Math.max(0,total-pass-fail-pend)+";background:var(--track)"})):null,
    listBody(rows,10,"No checks on this pull request."));
  var st=str(r.checksStatus);
  var missing=arr(r.checksMissingRequired||[]);
  return frame("Checks · #"+(first(r,["prNumber","githubPrNumber","prId"])||""),null,body,{headExtra:st?h("span",{cls:"tag","data-t":checksTone(st)},st):null});
}
function prStateColor(s){s=String(s||"").toLowerCase();return s==="merged"?"var(--pr-merged)":s==="closed"?"var(--pr-closed)":s==="draft"?"var(--t3)":"var(--pr-open)"}
function reviewWord(s){s=String(s||"").toLowerCase().replace(/_/g," ");return s&&s!=="none"?s:""}
function viewPrList(r){
  var prs=arr(r,["prs","pullRequests"]);
  var rows=prs.map(function(p){
    var url=str(p.githubUrl);var n=first(p,["githubPrNumber"]);
    var inner=[h("span",{cls:"dot big",style:"background:"+prStateColor(p.state)}),
      h("span",{cls:"grow trunc"},h("span",{cls:"mono dim"},n?"#"+n+" ":""),first(p,["title"])||"Pull request"),
      reviewWord(p.reviewStatus)?h("span",{cls:"tag"},reviewWord(p.reviewStatus)):null,
      p.checksStatus&&p.checksStatus!=="none"?h("span",{cls:"dot","data-s":checksTone(p.checksStatus),title:"Checks: "+p.checksStatus}):null,
      h("span",{cls:"small dim num"},rel(p.updatedAt||p.createdAt))];
    return url?h("button",{cls:"row",type:"button",role:"listitem",onclick:function(){openLink(url)}},inner):h("div",{cls:"row",role:"listitem"},inner);
  });
  return frame("Pull requests",prs.length,listBody(rows,10,"No pull requests."));
}
function viewPrShow(r){
  var title=first(r,["title"]);var n=first(r,["githubPrNumber","number","prId"]);
  var author=isObj(r.author)?first(r.author,["login","name"]):str(r.author);
  var labels=arr(r.labels||[]);var reviewers=arr(r.requestedReviewers||[]);
  var meta=h("div",{cls:"row",style:"flex-wrap:wrap;gap:6px"},
    r.state?h("span",{cls:"tag",style:"color:"+prStateColor(r.isDraft?"draft":r.state)},String(r.isDraft?"draft":r.state)):(r.isDraft?h("span",{cls:"tag"},"draft"):null),
    author?h("span",{cls:"t2"},"by "+author):null,
    labels.map(function(l){var c=/^[0-9a-f]{6}$/i.test(String(l.color||""))?"#"+l.color:"var(--t3)";return h("span",{cls:"label"},h("i",{style:"background:"+c}),first(l,["name"])||"label")}),
    reviewWord(r.reviewStatus)?h("span",{cls:"tag"},"review: "+reviewWord(r.reviewStatus)):null,
    r.checksStatus?h("span",{cls:"tag","data-t":checksTone(r.checksStatus)},"checks: "+r.checksStatus):null);
  var body=h("div",{cls:"body flush"},meta);
  if(reviewers.length)body.appendChild(h("div",{cls:"row small t2"},"Review requested from "+reviewers.map(function(x){return first(x,["login","name"])}).filter(Boolean).join(", ")));
  var text=str(r.body);
  if(text){var bt=text.length>2400?text.slice(0,2400)+"…":text;body.appendChild(h("div",{cls:"rule"}));body.appendChild(mdBlocks(bt,h("div",{cls:"prbody a"})))}
  var url=str(r.githubUrl||r.url);
  return frame((n?"#"+n+" ":"")+(title||"Pull request"),null,body,{headEnd:url?h("button",{cls:"btn ghost",type:"button",onclick:function(){openLink(url)},style:"margin-right:-8px"},"Open ↗"):null});
}
function viewLanes(r){
  var cur=state.current;
  var lanes=arr(r,["lanes"]);
  var rows=lanes.map(function(l){
    var s=isObj(l.status)?l.status:{};var id=first(l,["id","laneId"]);
    var changed=num(s.changedFileCount);var ahead=num(s.ahead),behind=num(s.behind);
    var inner=[h("span",{cls:"dot","data-s":s.dirty?"warn":l.archivedAt?"":"ok",title:s.dirty?"Uncommitted changes":"Clean"}),
      h("span",{cls:"grow",style:"display:flex;flex-direction:column;min-width:0"},
        h("span",{cls:"trunc",style:"font-weight:500"},first(l,["name"])||id||"Lane"),
        h("span",{cls:"trunc mono small dim"},first(l,["branchRef","branch"])||"")),
      l.laneType==="primary"?h("span",{cls:"tag","data-t":"accent"},"primary"):null,
      l.archivedAt?h("span",{cls:"tag"},"archived"):null,
      s.rebaseInProgress?h("span",{cls:"tag","data-t":"warn"},"rebasing"):null,
      changed?h("span",{cls:"small t2 num"},plural(changed,"file")):null,
      ahead||behind?h("span",{cls:"small dim num",title:"Ahead / behind "+(l.baseRef||"base")},(ahead?"↑"+ahead:"")+(behind?" ↓"+behind:"")):null];
    if(id&&canCallTools())return h("button",{cls:"row",type:"button",role:"listitem",onclick:function(){drill("diff_changes",scopeArgs({lane:id},cur),"changes")}},inner);
    return h("div",{cls:"row",role:"listitem"},inner);
  });
  return frame("Lanes",lanes.length,listBody(rows,12,"No lanes."));
}
function splitPath(p){p=String(p||"");var i=p.lastIndexOf("/");return i<0?["",p]:[p.slice(0,i+1),p.slice(i+1)]}
var KIND_TONE={added:"ok",untracked:"ok",new:"ok",deleted:"crit",removed:"crit",renamed:"accent",modified:"warn"};
function fileRow(f,mode){
  var cur=state.current;
  var path=first(f,["path","file"])||"";var sp=splitPath(path);var kind=String(f.kind||f.status||"").toLowerCase();
  var a=num(f.additions),d=num(f.deletions);var lane=state.args&&state.args.lane;
  var inner=[h("span",{cls:"dot","data-s":KIND_TONE[kind]||"",title:kind||"changed"}),
    h("span",{cls:"grow trunc"},h("span",{cls:"dim"},sp[0]),sp[1]),
    kind&&kind!=="modified"?h("span",{cls:"tag","data-t":KIND_TONE[kind]||""},kind):null,
    a!==null?h("span",{cls:"num small add"},"+"+a):null,d!==null?h("span",{cls:"num small del"},"−"+d):null];
  if(lane&&path&&canCallTools()&&kind!=="untracked")return h("button",{cls:"row",type:"button",role:"listitem",onclick:function(){drill("diff_patch",scopeArgs({lane:lane,path:path,mode:mode==="staged"?"staged":"unstaged"},cur),"diff")}},inner);
  return h("div",{cls:"row",role:"listitem"},inner);
}
function viewDiffChanges(r){
  var groups=[["Unstaged",arr(r,["unstaged"]),"unstaged"],["Staged",arr(r,["staged"]),"staged"]];
  if(Array.isArray(r))groups=[["Changes",arr(r),"unstaged"]];
  if(isObj(r)&&Array.isArray(r.files))groups=[["Changes",arr(r.files),"unstaged"]];
  var total=0;var body=h("div",{cls:"body flush"});
  groups.forEach(function(g){if(!g[1].length)return;total+=g[1].length;
    body.appendChild(h("div",{cls:"sec"},h("span",{cls:"eyebrow"},g[0]),h("span",{cls:"count"},String(g[1].length))));
    var rows=g[1].map(function(f){return fileRow(f,g[2])});var lb=listBody(rows,15);lb.className="";body.appendChild(lb)});
  if(!total)body.appendChild(h("div",{cls:"empty"},"No changes."));
  return frame("Changes",total,body);
}
function viewDiffPatch(r){
  var patch=str(r.patch)||"";var path=first(r,["path"])||(state.args&&state.args.path)||"Diff";
  var box=h("div",{cls:"diff",role:"region","aria-label":"Diff of "+path});
  if(r.isBinary===true)box.appendChild(h("div",{cls:"f",style:"padding:10px 14px"},"Binary file; no text diff."));
  else if(!patch)box.appendChild(h("div",{cls:"f",style:"padding:10px 14px"},"No changes in this file."));
  else{var lines=patch.replace(/\n$/,"").split("\n");var cap=Math.min(lines.length,1500);
    for(var i=0;i<cap;i++){var l=lines[i],c="";
      if(/^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(l))c="f";
      else if(l.charAt(0)==="@")c="h";else if(l.charAt(0)==="+")c="p";else if(l.charAt(0)==="-")c="m";
      box.appendChild(h("div",{cls:c},l||" "))}
    if(lines.length>cap)box.appendChild(h("div",{cls:"f"},(lines.length-cap)+" more lines not shown"))}
  var a=num(r.additions),d=num(r.deletions);var sp=splitPath(path);
  return frame(sp[1]||path,null,box,{headExtra:h("span",{style:"display:inline-flex;gap:6px;margin-left:4px"},a!==null?h("span",{cls:"num small add"},"+"+a):null,d!==null?h("span",{cls:"num small del"},"−"+d):null)});
}
function viewUsage(r){
  var accts=arr(r,["accounts"]);var order=[];var by={};
  accts.forEach(function(a){var p=String(a.provider||"other");if(!by[p]){by[p]=[];order.push(p)}by[p].push(a)});
  var body=h("div",{cls:"body flush"});
  order.forEach(function(p){
    var pv=prov(p);
    body.appendChild(h("div",{cls:"sec"},h("span",{cls:"swatch",style:"background:"+pv.color}),h("span",{style:"font-weight:600;font-size:12.5px"},pv.name)));
    by[p].forEach(function(a){
      var who=first(a,["email","label"])||"Signed in on this computer";
      var box=h("div",{cls:"acct"},h("div",{cls:"row",style:"padding:0;min-height:20px"},h("span",{cls:"grow trunc t2"},who),
        a.plan?h("span",{cls:"tag"},String(a.plan)):null,a.nextChat===true?h("span",{cls:"tag","data-t":"accent",title:"The next chat starts on this account"},"next chat"):null,
        a.state&&a.state!=="ok"?h("span",{cls:"tag","data-t":"warn"},String(a.state)):null));
      if(a.note)box.appendChild(h("div",{cls:"small dim"},String(a.note)));
      arr(a.windows||[]).forEach(function(w){
        var left=num(w.percentLeft);var lvl=left===null?"":left<=5?"crit":left<=20?"warn":"";
        var pace=isObj(w.pace)?w.pace:{};var resets=dur(num(w.resetsInMinutes));
        var note=[];if(resets)note.push("resets in "+resets);
        if(pace.lastsToReset===false&&num(pace.runsOutInMinutes)!==null)note.push("runs out in "+dur(pace.runsOutInMinutes));
        if(num(w.countLeft)!==null&&num(w.countTotal)!==null)note.push(w.countLeft+" of "+w.countTotal+" left");
        box.appendChild(h("div",{cls:"win"},h("span",{cls:"t2 trunc"},first(w,["label","type"])||"Window"),
          h("div",{cls:"meter","data-l":lvl,role:"meter","aria-valuemin":"0","aria-valuemax":"100","aria-valuenow":left===null?"":String(left),"aria-label":(first(w,["label"])||"Window")+" left"},h("span",{style:"width:"+(left===null?0:Math.max(0,Math.min(100,left)))+"%"})),
          h("span",{cls:"num small",style:lvl?"color:var(--"+lvl+")":""},left===null?"—":Math.round(left)+"% left"),
          note.length?h("span",{cls:"r",style:pace.lastsToReset===false?"color:var(--warn)":null},note.join(" · ")):null));
      });
      body.appendChild(box);
    });
  });
  if(!accts.length)body.appendChild(h("div",{cls:"empty"},"No usage readings on this computer."));
  return frame("Usage limits",null,body);
}
function viewMachines(r){
  var ms=arr(r,["machines","computers","items"]);
  var rows=ms.map(function(m){
    var online=m.online===true;
    return h("div",{cls:"row",role:"listitem"},h("span",{cls:"dot","data-s":online?"ok":"",title:online?"Online":"Offline"}),
      h("span",{cls:"grow",style:"display:flex;flex-direction:column;min-width:0"},h("span",{cls:"trunc",style:"font-weight:500"},first(m,["name","machineName","key"])||"Computer"),
        h("span",{cls:"small dim trunc"},[online?"Online":"Offline",first(m,["version"])?"ADE "+first(m,["version"]):null,first(m,["platform","os"])].filter(Boolean).join(" · "))),
      m.isThisMachine===true?h("span",{cls:"tag","data-t":"accent"},"this computer"):null,
      m.serving===true?h("span",{cls:"tag","data-t":"ok"},"serving"):m.serving===false?h("span",{cls:"tag"},"not serving"):null,
      m.included===false?h("span",{cls:"tag","data-t":"warn"},"left out"):null,
      m.supported===false?h("span",{cls:"tag","data-t":"warn"},"update ADE"):null);
  });
  return frame("Computers",ms.length,listBody(rows,20,"No computers on this account."),{noProject:true});
}

/* ---------- inbox ---------- */
function inboxItems(r){return arr(r,["items","inbox","requests","pending"])}
function itemQuestions(it){
  var qs=arr(it.questions||[]);
  if(qs.length)return qs;
  var text=first(it,["text","question","prompt","description"])||"";
  return text?[{id:null,question:text,options:arr(it.options||[])}]:[];
}
function respondArgs(it,answer){
  var args={session:first(it,["sessionId","session"]),request_id:first(it,["requestId","request_id"])};
  var a=scopeArgs(args,it.__cur);
  var mk=isObj(it.machine)?first(it.machine,["key","name"]):str(it.machine);if(mk)a.machine=mk;
  for(var k in answer)a[k]=answer[k];
  return a;
}
function inboxCard(it){
  it.__cur=state.current;
  var kind=String(it.kind||"question").toLowerCase();
  var approval=kind==="approval"||kind==="plan"||kind==="permissions"||kind.indexOf("approval")>=0;
  var ask=kind==="ask"||(!first(it,["requestId"])&&!approval&&!arr(it.questions||[]).length);
  var title=first(it,["title"])||"Chat";
  var lane=first(it,["lane","laneName"]);
  var mname=isObj(it.machine)?first(it.machine,["name","key"]):null;
  var link=linkOf(it);
  var wrap=h("div",{cls:"ask",role:"group","aria-label":title});
  wrap.appendChild(h("div",{cls:"wl"},h("span",{cls:"dot","data-s":"warn"}),
    h("span",{style:"color:var(--warn);font-weight:500"},kind==="plan"?"Plan":approval?"Approval":ask?"Waiting on you":"Question"),
    lane?h("span",{cls:"lane",style:"margin-left:4px"},lane):null,mname?h("span",{cls:"chip"},mname):null,
    h("span",{cls:"status dim"},rel(it.since)),
    link?h("button",{cls:"back",type:"button",style:"margin:0 -6px 0 0",title:"Open in ADE",onclick:function(){openLink(link)}},"Open ↗"):null));
  wrap.appendChild(h("div",{cls:"wt trunc"},title));
  var qs=itemQuestions(it);
  if(!qs.length&&str(it.text))qs=[{question:it.text}];
  var actions=h("div");var live=h("div",{"aria-live":"polite"});
  var multi=qs.length>1;
  qs.forEach(function(q){var t=str(q.question)||str(q.header);if(t)wrap.appendChild(h("div",{cls:"q"},multi&&str(q.header)&&str(q.question)?str(q.header)+": "+str(q.question):t))});
  if(str(it.detail))wrap.appendChild(h("details",{cls:"tool",style:"margin:-2px 0 8px"},h("summary",null,"Details"),h("pre",{style:"white-space:pre-wrap"},it.detail)));
  var writable=canCallTools();
  function lock(on){Array.prototype.forEach.call(wrap.querySelectorAll(".opts button,.free button,.free input"),function(b){b.disabled=on})}
  function send(tool,answer,label,btn,tone){
    if(!writable)return;
    lock(true);live.textContent="";if(btn)btn.textContent="Sending…";
    var args=tool==="chat_send"?scopeArgs({session:first(it,["sessionId"]),text:answer.text},it.__cur):respondArgs(it,answer);
    if(tool==="chat_send"){var mk=isObj(it.machine)?first(it.machine,["key","name"]):null;if(mk)args.machine=mk}
    callTool(tool,args).then(function(res){
      if(!res||res.isError)throw new Error(resultText(res)||"ADE could not send that answer.");
      actions.textContent="";
      actions.appendChild(h("div",{cls:"done"},h("span",{cls:"dot big","data-s":tone||"ok"}),h("span",{cls:"grow"},label)));
      reportSize();
    }).catch(function(e){
      lock(false);if(btn)btn.textContent=btn.getAttribute("data-label");
      live.appendChild(h("div",{cls:"err"},e.message||"That did not go through."));reportSize();
    });
  }
  if(approval){
    var ap=h("button",{cls:"btn primary",type:"button","data-label":"Approve",disabled:!writable,onclick:function(){send("chat_respond",{decision:"approve"},"Approved · "+title,ap,"ok")}},"Approve");
    var dn=h("button",{cls:"btn",type:"button","data-label":"Deny","data-t":"crit",disabled:!writable,onclick:function(){send("chat_respond",{decision:"deny"},"Denied · "+title,dn,"crit")}},"Deny");
    actions.appendChild(h("div",{cls:"opts"},ap,dn));
  }else if(!ask){
    var instant=qs.length===1&&!qs[0].multiSelect;var picks={};var anyOpts=false;
    qs.forEach(function(q,qi){
      var opts=arr(q.options||[]);if(!opts.length)return;anyOpts=true;
      var row=h("div",{cls:"opts",style:multi?"margin-bottom:6px":null,role:q.multiSelect?"group":null,"aria-label":str(q.question)||"Options"});
      opts.forEach(function(o,i){
        var lab=first(o,["label"])||"Option "+(i+1);
        var b=h("button",{cls:"btn opt"+(o.recommended&&instant?" primary":""),type:"button","data-label":lab,"aria-pressed":instant?null:"false",disabled:!writable,
          onclick:function(){
            if(instant){send("chat_respond",{option:String(i+1)},"Answered · "+lab,b);return}
            var key=String(qi+1);var cur=picks[key]||[];var at=cur.indexOf(lab);
            if(q.multiSelect){if(at>=0)cur.splice(at,1);else cur.push(lab)}else cur=at>=0?[]:[lab];
            picks[key]=cur;
            Array.prototype.forEach.call(row.querySelectorAll("button"),function(x){x.setAttribute("aria-pressed",cur.indexOf(x.getAttribute("data-label"))>=0?"true":"false");x.classList.toggle("primary",cur.indexOf(x.getAttribute("data-label"))>=0)});
          }},h("span",null,lab),str(o.description)?h("small",null,o.description):null);
        row.appendChild(b);
      });
      actions.appendChild(row);
    });
    if(!instant&&anyOpts){
      var sb=h("button",{cls:"btn primary",type:"button","data-label":"Send answers",disabled:!writable,onclick:function(){
        var answers={};var labels=[];for(var k in picks){if(picks[k].length){var q=qs[Number(k)-1];answers[k]=q&&q.multiSelect?picks[k]:picks[k][0];labels.push(picks[k].join(", "))}}
        if(!labels.length)return;send("chat_respond",{answers:answers},"Answered · "+labels.join(" · "),sb)}},"Send answers");
      actions.appendChild(h("div",{cls:"free"},sb));
    }
    var optionsOnly=qs.some(function(q){return q.optionsOnly===true||q.secret===true});
    if(!optionsOnly)actions.appendChild(freeText("chat_respond"));
  }else actions.appendChild(freeText("chat_send"));
  function freeText(tool){
    var inp=h("input",{cls:"input",type:"text",placeholder:tool==="chat_send"||!anyOptsIn()?"Type an answer":"Or type an answer","aria-label":"Answer for "+title,disabled:!writable});
    var go=h("button",{cls:"btn",type:"button","data-label":"Send",disabled:!writable,onclick:function(){var v=inp.value.trim();if(v)send(tool,{text:v},(tool==="chat_send"?"Sent · ":"Answered · ")+v,go)}},"Send");
    inp.addEventListener("keydown",function(ev){if(ev.key==="Enter"){ev.preventDefault();go.click()}});
    return h("div",{cls:"free"},inp,go);
  }
  function anyOptsIn(){return qs.some(function(q){return arr(q.options||[]).length>0})}
  if(!writable)actions.appendChild(h("div",{cls:"small dim",style:"margin-top:6px"},"Answer this in ADE, or ask me to."));
  wrap.appendChild(actions);wrap.appendChild(live);
  return wrap;
}
function viewInbox(r){
  var items=inboxItems(r);
  var body=h("div");
  if(!items.length)body.appendChild(h("div",{cls:"empty",style:"padding:6px 14px 14px"},first(r,["message","note"])||"Nothing waits on you."));
  items.forEach(function(it){body.appendChild(inboxCard(it))});
  return frame("Needs you",items.length||null,body);
}

/* ---------- write results ---------- */
function resultText(res){var c=res&&Array.isArray(res.content)?res.content:[];return c.filter(function(x){return x&&x.type==="text"}).map(function(x){return x.text}).join("\n").replace(/^(\[(project|machine):[^\]\n]*\]\n?)+/,"").trim()}
function linkOf(r){var u=first(r,["link","adeLink","url","openUrl","deeplink","webUrl"]);return u&&/^(https?:|ade:)/i.test(u)?u:null}
function viewWriteResult(tool,r){
  var chat=first(r,["title","chatTitle"])||(first(r,["sessionId"])?"chat "+String(r.sessionId).slice(0,8):"chat");
  var line,tone="ok",note=null;
  if(tool==="chat_respond"){
    var d=String(r.decision||"").toLowerCase();
    line=d==="decline"||d==="deny"?"Denied":d==="cancel"?"Cancelled":d==="accept_for_session"||d==="approve_for_session"?"Approved for this chat":d==="accept"||d==="approve"?"Approved":"Answered";
    if(line==="Denied"||line==="Cancelled")tone="crit";
    line+=" · "+chat;
  }else if(tool==="chat_start"){
    var ph=String(r.phase||"").toLowerCase();
    if(ph==="failed"||ph==="cancelled"){tone="crit";line=(ph==="failed"?"Could not start ":"Cancelled ")+chat;note=str(r.error)}
    else{line=(ph==="running"?"Starting ":"Started ")+chat;tone=ph==="running"?"info":"ok"}
    if(str(r.lane))note=note||("in "+r.lane);
  }else{line="Sent to "+chat;var dv=first(r,["delivery","routedAction"]);if(dv)note=dv.replace(/_/g," ")}
  var url=linkOf(r);var sc=state.current||{};
  var body=h("div",{cls:"head",style:"height:auto;min-height:44px;padding:8px 14px"},h("span",{cls:"dot big","data-s":tone}),
    h("span",{cls:"grow",style:"display:flex;flex-direction:column;min-width:0"},h("span",{cls:"trunc",style:"font-weight:500"},line),note?h("span",{cls:"small dim trunc"},note):null),
    sc.machineName?h("span",{cls:"chip"},sc.machineName):null,
    url?h("button",{cls:"btn",type:"button",onclick:function(){openLink(url)}},"Open in ADE"):null);
  return h("section",{cls:"card","aria-label":line},body);
}

/* ---------- fallback ---------- */
function kvValue(v){
  if(v===null||v===undefined)return "—";
  if(typeof v==="object"){var s=JSON.stringify(v);return s.length>240?s.slice(0,240)+"…":s}
  return String(v);
}
function viewKv(title,r){
  if(Array.isArray(r)){
    var rows=r.slice(0,50).map(function(x){
      if(!isObj(x))return h("div",{cls:"row",role:"listitem"},kvValue(x));
      var keys=Object.keys(x).filter(function(k){return x[k]!==null&&typeof x[k]!=="object"}).slice(0,3);
      return h("div",{cls:"row",role:"listitem"},h("span",{cls:"grow trunc"},keys.length?kvValue(x[keys[0]]):kvValue(x)),keys.slice(1).map(function(k){return h("span",{cls:"small dim trunc",style:"max-width:40%"},kvValue(x[k]))}));
    });
    return frame(title,r.length,listBody(rows,15,"Nothing here."));
  }
  var dl=h("dl",{cls:"kv"});
  if(isObj(r))Object.keys(r).slice(0,40).forEach(function(k){dl.appendChild(h("dt",null,k));dl.appendChild(h("dd",null,kvValue(r[k])))});
  else dl.appendChild(h("dd",null,kvValue(r)));
  return frame(title,null,h("div",{cls:"body flush"},dl));
}
function viewText(title,text,isErr){
  return frame(title,null,h("div",{cls:"body flush"},h("div",{cls:isErr?"err":"text"},text||"(no output)")));
}

/* ---------- routing ---------- */
var TITLES={inbox:"Needs you",chat_list:"Chats",chat_read:"Chat",chat_respond:"Answer",chat_send:"Message",chat_start:"New chat",prs_list:"Pull requests",prs_show:"Pull request",prs_checks:"Checks",lanes_list:"Lanes",diff_changes:"Changes",diff_patch:"Diff",usage_limits:"Usage limits",machines_list:"Computers",projects_list:"Projects",lanes_show:"Lane",files_tree:"Files",files_read:"File",files_search:"Search",git_status:"Git status",chat_status:"Chat status",chat_wait:"Chat"};
function detect(tool,r,args){
  if(tool&&VIEWS[tool])return tool;
  args=args||{};
  if(Array.isArray(r)){var x=r[0]||{};
    if(x.sessionId&&(x.provider||x.model||x.status))return "chat_list";
    if(x.branchRef||x.worktreePath||x.laneType)return "lanes_list";
    if(x.githubPrNumber||x.headBranch)return "prs_list";
    if(x.role&&(x.text!==undefined||x.displayText!==undefined))return "chat_read";
    if(x.isThisMachine!==undefined||(x.online!==undefined&&x.name))return "machines_list";
    if(x.requestId&&(x.questions||x.options||x.kind))return "inbox";
    return null}
  if(!isObj(r))return null;
  if(Array.isArray(r.checks))return "prs_checks";
  if(Array.isArray(r.accounts))return "usage_limits";
  if(Array.isArray(r.unstaged)||Array.isArray(r.staged))return "diff_changes";
  if(typeof r.patch==="string")return "diff_patch";
  if(Array.isArray(r.entries)||(Array.isArray(r.messages)&&r.messages[0]&&r.messages[0].role))return "chat_read";
  if(Array.isArray(r.lanes))return "lanes_list";
  if(Array.isArray(r.sessions)||Array.isArray(r.chats))return r.chats&&r.chats[0]&&r.chats[0].requestId?"inbox":"chat_list";
  if(Array.isArray(r.items)&&(r.items.length===0||r.items[0].requestId||r.items[0].kind))return "inbox";
  if(Array.isArray(r.machines)&&r.machines[0]&&r.machines[0].ok===undefined)return "machines_list";
  if(r.body!==undefined&&(r.author||r.labels||r.prId))return "prs_show";
  if(r.answered===true||(r.decision&&r.sessionId))return "chat_respond";
  if(r.sessionId&&(r.phase!==undefined||r.launchId))return "chat_start";
  if(r.sessionId&&(r.delivery!==undefined||r.routedAction!==undefined))return "chat_send";
  return null;
}
var VIEWS={chat_list:viewChatList,chat_read:viewChatRead,prs_checks:viewChecks,prs_list:viewPrList,prs_show:viewPrShow,lanes_list:viewLanes,
  diff_changes:viewDiffChanges,diff_patch:viewDiffPatch,usage_limits:viewUsage,machines_list:viewMachines,inbox:viewInbox,
  chat_respond:function(r){return viewWriteResult("chat_respond",r)},chat_send:function(r){return viewWriteResult("chat_send",r)},chat_start:function(r){return viewWriteResult("chat_start",r)}};
function setCurrent(sc){
  var p=isObj(sc)&&isObj(sc.project)?sc.project:null;var m=isObj(sc)&&isObj(sc.machine)?sc.machine:null;
  state.current={projectId:p&&first(p,["id","projectId"]),projectName:p&&first(p,["name","displayName"]),projectPath:p&&first(p,["path","rootPath"]),
    machineKey:m&&first(m,["key"]),machineName:m&&first(m,["name","key"])};
}
function viewFor(tool,sc,args){
  var r=isObj(sc)&&"result" in sc?sc.result:sc;
  var name=detect(tool,r,args);
  if(name&&VIEWS[name])return VIEWS[name](r===null||r===undefined?{}:r);
  return viewKv(TITLES[tool]||"Result",r);
}
function viewFanout(tool,sc){
  var wrap=h("div");
  arr(sc.machines).forEach(function(entry){
    var m=isObj(entry.machine)?entry.machine:{};var name=first(m,["name","key"])||"Computer";
    var g=h("div",{cls:"mgroup"});
    var inner=isObj(entry.result)?entry.result:{result:entry.result};
    if(!inner.machine)inner.machine=m;
    if(entry.ok===false||entry.error){
      g.appendChild(h("section",{cls:"card"},h("div",{cls:"head"},h("span",{cls:"dot","data-s":"crit"}),h("span",{cls:"lbl"},name)),
        h("div",{cls:"err",style:"padding:0 14px 12px"},(isObj(entry.error)?first(entry.error,["message"]):str(entry.error))||"No answer from this computer.")));
    }else{setCurrent(inner);g.appendChild(viewFor(tool,inner,state.args))}
    wrap.appendChild(g);
  });
  return wrap;
}
function render(){
  var res=state.result||{};var sc=res.structuredContent;var tool=state.tool||toolName();
  try{
    if(res.isError){setCurrent(sc);mount(viewText(TITLES[tool]||"ADE",resultText(res)||"That did not work.",true));return}
    if(isObj(sc)&&Array.isArray(sc.machines)&&sc.machines.length&&sc.machines[0]&&("ok" in sc.machines[0])){mount(viewFanout(tool,sc));return}
    if(sc===undefined||sc===null){setCurrent(null);mount(viewText(TITLES[tool]||"ADE",resultText(res)));return}
    setCurrent(sc);mount(viewFor(tool,sc,state.args));
  }catch(e){mount(viewText("ADE",resultText(res)||String(e&&e.message||e)))}
}
function toolName(){var ti=ctx.toolInfo;return ti&&ti.tool&&typeof ti.tool.name==="string"?ti.tool.name:null}
function renderLoading(){var t=toolName();mount(h("section",{cls:"card"},h("div",{cls:"muted-load"},(TITLES[t]?TITLES[t]+": ":"")+"Asking ADE…")))}
function renderNote(text,keepBack,isErr){
  mount(h("section",{cls:"card"},h("div",{cls:"head"},keepBack&&state.stack.length?h("button",{cls:"back",type:"button",onclick:goBack},"‹ Back"):null,h("span",{cls:isErr?"err":"dim",style:"padding:0"},text))));
}

/* ---------- handshake ---------- */
applyCtx();
request("ui/initialize",{appInfo:{name:"ade",version:"1"},appCapabilities:{availableDisplayModes:["inline"]},protocolVersion:PROTOCOL},30000).then(function(res){
  res=res||{};mergeCtx(res.hostContext||{});ctx.__caps=res.hostCapabilities||{};applyCtx();
  notify("ui/notifications/initialized",{});
  if(state.result)render();
  reportSize();
}).catch(function(){applyCtx();reportSize()});
})();
`;
