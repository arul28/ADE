import{Cmt as e,Dft as t,Emt as n,Gft as r,Gmt as i,Jmt as a,Mpt as o,Npt as s,Oft as c,Ppt as l,Rft as u,Rpt as d,Tpt as f,Wmt as p,dmt as m,jpt as h,kmt as g,lht as _,mmt as v,uht as y,vmt as b,wmt as x}from"./demo-shared-DFDfOeUE.js";function S(e,t){return t<e?-1:t>e?1:t>=e?0:NaN}function C(e){return e}function w(){var e=C,t=S,n=null,r=l(0),i=l(s),a=l(0);function o(o){var c,l=(o=h(o)).length,u,d,f=0,p=Array(l),m=Array(l),g=+r.apply(this,arguments),_=Math.min(s,Math.max(-s,i.apply(this,arguments)-g)),v,y=Math.min(Math.abs(_)/l,a.apply(this,arguments)),b=y*(_<0?-1:1),x;for(c=0;c<l;++c)(x=m[p[c]=c]=+e(o[c],c,o))>0&&(f+=x);for(t==null?n!=null&&p.sort(function(e,t){return n(o[e],o[t])}):p.sort(function(e,n){return t(m[e],m[n])}),c=0,d=f?(_-l*b)/f:0;c<l;++c,g=v)u=p[c],x=m[u],v=g+(x>0?x*d:0)+b,m[u]={data:o[u],index:c,value:x,startAngle:g,endAngle:v,padAngle:y};return m}return o.value=function(t){return arguments.length?(e=typeof t==`function`?t:l(+t),o):e},o.sortValues=function(e){return arguments.length?(t=e,n=null,o):t},o.sort=function(e){return arguments.length?(n=e,t=null,o):n},o.startAngle=function(e){return arguments.length?(r=typeof e==`function`?e:l(+e),o):r},o.endAngle=function(e){return arguments.length?(i=typeof e==`function`?e:l(+e),o):i},o.padAngle=function(e){return arguments.length?(a=typeof e==`function`?e:l(+e),o):a},o}var T=b.pie,E={sections:new Map,showData:!1,config:T},D=E.sections,O=E.showData,k=structuredClone(T),A={getConfig:_(()=>structuredClone(k),`getConfig`),clear:_(()=>{D=new Map,O=E.showData,m()},`clear`),setDiagramTitle:a,getDiagramTitle:g,setAccTitle:i,getAccTitle:x,setAccDescription:p,getAccDescription:e,addSection:_(({label:e,value:t})=>{if(t<0)throw Error(`"${e}" has invalid value: ${t}. Negative values are not allowed in pie charts. All slice values must be >= 0.`);D.has(e)||(D.set(e,t),y.debug(`added new section: ${e}, with value: ${t}`))},`addSection`),getSections:_(()=>D,`getSections`),setShowData:_(e=>{O=e},`setShowData`),getShowData:_(()=>O,`getShowData`)},j=_((e,t)=>{c(e,t),t.setShowData(e.showData),e.sections.map(t.addSection)},`populateDb`),M={parse:_(async e=>{let n=await t(`pie`,e);y.debug(n),j(n,A)},`parse`)},N=_(e=>`
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
`,`getStyles`),P=_(e=>{let t=[...e.values()].reduce((e,t)=>e+t,0),n=[...e.entries()].map(([e,t])=>({label:e,value:t})).filter(e=>e.value/t*100>=1);return w().value(e=>e.value).sort(null)(n)},`createPieArcs`),F={parser:M,db:A,renderer:{draw:_((e,t,i,a)=>{y.debug(`rendering pie chart
`+e);let s=a.db,c=n(),l=u(s.getConfig(),c.pie),p=f(t),m=p.append(`g`);m.attr(`transform`,`translate(225,225)`);let{themeVariables:h}=c,[g]=r(h.pieOuterStrokeWidth);g??=2;let _=l.textPosition,b=o().innerRadius(0).outerRadius(185),x=o().innerRadius(185*_).outerRadius(185*_);m.append(`circle`).attr(`cx`,0).attr(`cy`,0).attr(`r`,185+g/2).attr(`class`,`pieOuterCircle`);let S=s.getSections(),C=P(S),w=[h.pie1,h.pie2,h.pie3,h.pie4,h.pie5,h.pie6,h.pie7,h.pie8,h.pie9,h.pie10,h.pie11,h.pie12],T=0;S.forEach(e=>{T+=e});let E=C.filter(e=>(e.data.value/T*100).toFixed(0)!==`0`),D=d(w).domain([...S.keys()]);m.selectAll(`mySlices`).data(E).enter().append(`path`).attr(`d`,b).attr(`fill`,e=>D(e.data.label)).attr(`class`,`pieCircle`),m.selectAll(`mySlices`).data(E).enter().append(`text`).text(e=>(e.data.value/T*100).toFixed(0)+`%`).attr(`transform`,e=>`translate(`+x.centroid(e)+`)`).style(`text-anchor`,`middle`).attr(`class`,`slice`);let O=m.append(`text`).text(s.getDiagramTitle()).attr(`x`,0).attr(`y`,-400/2).attr(`class`,`pieTitleText`),k=[...S.entries()].map(([e,t])=>({label:e,value:t})),A=m.selectAll(`.legend`).data(k).enter().append(`g`).attr(`class`,`legend`).attr(`transform`,(e,t)=>{let n=22*k.length/2;return`translate(216,`+(t*22-n)+`)`});A.append(`rect`).attr(`width`,18).attr(`height`,18).style(`fill`,e=>D(e.label)).style(`stroke`,e=>D(e.label)),A.append(`text`).attr(`x`,22).attr(`y`,14).text(e=>s.getShowData()?`${e.label} [${e.value}]`:e.label);let j=512+Math.max(...A.selectAll(`text`).nodes().map(e=>e?.getBoundingClientRect().width??0)),M=O.node()?.getBoundingClientRect().width??0,N=450/2-M/2,F=450/2+M/2,I=Math.min(0,N),L=Math.max(j,F)-I;p.attr(`viewBox`,`${I} 0 ${L} 450`),v(p,450,L,l.useMaxWidth)},`draw`)},styles:N};export{F as diagram};