import{Apt as e,Cmt as t,Dft as n,Eft as r,Lft as i,Lpt as a,Mpt as o,Npt as s,Omt as c,Smt as l,Tmt as u,Umt as d,Wft as f,Wmt as p,_mt as m,cht as h,jpt as g,lht as _,pmt as v,qmt as y,umt as b,wpt as x}from"./demo-shared-28b-BOcf.js";function S(e,t){return t<e?-1:t>e?1:t>=e?0:NaN}function C(e){return e}function w(){var t=C,n=S,r=null,i=s(0),a=s(o),c=s(0);function l(s){var l,u=(s=e(s)).length,d,f,p=0,m=Array(u),h=Array(u),g=+i.apply(this,arguments),_=Math.min(o,Math.max(-o,a.apply(this,arguments)-g)),v,y=Math.min(Math.abs(_)/u,c.apply(this,arguments)),b=y*(_<0?-1:1),x;for(l=0;l<u;++l)(x=h[m[l]=l]=+t(s[l],l,s))>0&&(p+=x);for(n==null?r!=null&&m.sort(function(e,t){return r(s[e],s[t])}):m.sort(function(e,t){return n(h[e],h[t])}),l=0,f=p?(_-u*b)/p:0;l<u;++l,g=v)d=m[l],x=h[d],v=g+(x>0?x*f:0)+b,h[d]={data:s[d],index:l,value:x,startAngle:g,endAngle:v,padAngle:y};return h}return l.value=function(e){return arguments.length?(t=typeof e==`function`?e:s(+e),l):t},l.sortValues=function(e){return arguments.length?(n=e,r=null,l):n},l.sort=function(e){return arguments.length?(r=e,n=null,l):r},l.startAngle=function(e){return arguments.length?(i=typeof e==`function`?e:s(+e),l):i},l.endAngle=function(e){return arguments.length?(a=typeof e==`function`?e:s(+e),l):a},l.padAngle=function(e){return arguments.length?(c=typeof e==`function`?e:s(+e),l):c},l}var T=m.pie,E={sections:new Map,showData:!1,config:T},D=E.sections,O=E.showData,k=structuredClone(T),A={getConfig:h(()=>structuredClone(k),`getConfig`),clear:h(()=>{D=new Map,O=E.showData,b()},`clear`),setDiagramTitle:y,getDiagramTitle:c,setAccTitle:p,getAccTitle:t,setAccDescription:d,getAccDescription:l,addSection:h(({label:e,value:t})=>{if(t<0)throw Error(`"${e}" has invalid value: ${t}. Negative values are not allowed in pie charts. All slice values must be >= 0.`);D.has(e)||(D.set(e,t),_.debug(`added new section: ${e}, with value: ${t}`))},`addSection`),getSections:h(()=>D,`getSections`),setShowData:h(e=>{O=e},`setShowData`),getShowData:h(()=>O,`getShowData`)},j=h((e,t)=>{n(e,t),t.setShowData(e.showData),e.sections.map(t.addSection)},`populateDb`),M={parse:h(async e=>{let t=await r(`pie`,e);_.debug(t),j(t,A)},`parse`)},N=h(e=>`
  .pieCircle{
    stroke: ${e.pieStrokeColor};
    stroke-width : ${e.pieStrokeWidth};
    opacity : ${e.pieOpacity};
  }
  .pieOuterCircle{
    stroke: ${e.pieOuterStrokeColor};
    stroke-width: ${e.pieOuterStrokeWidth};
    fill: none;
  }
  .pieTitleText {
    text-anchor: middle;
    font-size: ${e.pieTitleTextSize};
    fill: ${e.pieTitleTextColor};
    font-family: ${e.fontFamily};
  }
  .slice {
    font-family: ${e.fontFamily};
    fill: ${e.pieSectionTextColor};
    font-size:${e.pieSectionTextSize};
    // fill: white;
  }
  .legend text {
    fill: ${e.pieLegendTextColor};
    font-family: ${e.fontFamily};
    font-size: ${e.pieLegendTextSize};
  }
`,`getStyles`),P=h(e=>{let t=[...e.values()].reduce((e,t)=>e+t,0),n=[...e.entries()].map(([e,t])=>({label:e,value:t})).filter(e=>e.value/t*100>=1);return w().value(e=>e.value).sort(null)(n)},`createPieArcs`),F={parser:M,db:A,renderer:{draw:h((e,t,n,r)=>{_.debug(`rendering pie chart
`+e);let o=r.db,s=u(),c=i(o.getConfig(),s.pie),l=x(t),d=l.append(`g`);d.attr(`transform`,`translate(225,225)`);let{themeVariables:p}=s,[m]=f(p.pieOuterStrokeWidth);m??=2;let h=c.textPosition,y=g().innerRadius(0).outerRadius(185),b=g().innerRadius(185*h).outerRadius(185*h);d.append(`circle`).attr(`cx`,0).attr(`cy`,0).attr(`r`,185+m/2).attr(`class`,`pieOuterCircle`);let S=o.getSections(),C=P(S),w=[p.pie1,p.pie2,p.pie3,p.pie4,p.pie5,p.pie6,p.pie7,p.pie8,p.pie9,p.pie10,p.pie11,p.pie12],T=0;S.forEach(e=>{T+=e});let E=C.filter(e=>(e.data.value/T*100).toFixed(0)!==`0`),D=a(w).domain([...S.keys()]);d.selectAll(`mySlices`).data(E).enter().append(`path`).attr(`d`,y).attr(`fill`,e=>D(e.data.label)).attr(`class`,`pieCircle`),d.selectAll(`mySlices`).data(E).enter().append(`text`).text(e=>(e.data.value/T*100).toFixed(0)+`%`).attr(`transform`,e=>`translate(`+b.centroid(e)+`)`).style(`text-anchor`,`middle`).attr(`class`,`slice`);let O=d.append(`text`).text(o.getDiagramTitle()).attr(`x`,0).attr(`y`,-400/2).attr(`class`,`pieTitleText`),k=[...S.entries()].map(([e,t])=>({label:e,value:t})),A=d.selectAll(`.legend`).data(k).enter().append(`g`).attr(`class`,`legend`).attr(`transform`,(e,t)=>{let n=22*k.length/2;return`translate(216,`+(t*22-n)+`)`});A.append(`rect`).attr(`width`,18).attr(`height`,18).style(`fill`,e=>D(e.label)).style(`stroke`,e=>D(e.label)),A.append(`text`).attr(`x`,22).attr(`y`,14).text(e=>o.getShowData()?`${e.label} [${e.value}]`:e.label);let j=512+Math.max(...A.selectAll(`text`).nodes().map(e=>e?.getBoundingClientRect().width??0)),M=O.node()?.getBoundingClientRect().width??0,N=450/2-M/2,F=450/2+M/2,I=Math.min(0,N),L=Math.max(j,F)-I;l.attr(`viewBox`,`${I} 0 ${L} 450`),v(l,450,L,c.useMaxWidth)},`draw`)},styles:N};export{F as diagram};