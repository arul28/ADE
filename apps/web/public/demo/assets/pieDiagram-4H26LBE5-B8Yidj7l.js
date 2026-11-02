import{CD as e,DE as t,EE as n,HD as r,ME as i,OE as a,RD as o,TE as s,XT as c,YT as l,_D as u,aD as d,bD as f,cD as p,fD as m,iO as h,oE as g,pE as _,rO as v,vD as y,yE as b,zD as x}from"./demo-shared-BzVPtUYD.js";function S(e,t){return t<e?-1:t>e?1:t>=e?0:NaN}function C(e){return e}function w(){var e=C,n=S,r=null,i=a(0),o=a(t),c=a(0);function l(a){var l,u=(a=s(a)).length,d,f,p=0,m=Array(u),h=Array(u),g=+i.apply(this,arguments),_=Math.min(t,Math.max(-t,o.apply(this,arguments)-g)),v,y=Math.min(Math.abs(_)/u,c.apply(this,arguments)),b=y*(_<0?-1:1),x;for(l=0;l<u;++l)(x=h[m[l]=l]=+e(a[l],l,a))>0&&(p+=x);for(n==null?r!=null&&m.sort(function(e,t){return r(a[e],a[t])}):m.sort(function(e,t){return n(h[e],h[t])}),l=0,f=p?(_-u*b)/p:0;l<u;++l,g=v)d=m[l],x=h[d],v=g+(x>0?x*f:0)+b,h[d]={data:a[d],index:l,value:x,startAngle:g,endAngle:v,padAngle:y};return h}return l.value=function(t){return arguments.length?(e=typeof t==`function`?t:a(+t),l):e},l.sortValues=function(e){return arguments.length?(n=e,r=null,l):n},l.sort=function(e){return arguments.length?(r=e,n=null,l):r},l.startAngle=function(e){return arguments.length?(i=typeof e==`function`?e:a(+e),l):i},l.endAngle=function(e){return arguments.length?(o=typeof e==`function`?e:a(+e),l):o},l.padAngle=function(e){return arguments.length?(c=typeof e==`function`?e:a(+e),l):c},l}var T=m.pie,E={sections:new Map,showData:!1,config:T},D=E.sections,O=E.showData,k=structuredClone(T),A={getConfig:v(()=>structuredClone(k),`getConfig`),clear:v(()=>{D=new Map,O=E.showData,d()},`clear`),setDiagramTitle:r,getDiagramTitle:e,setAccTitle:x,getAccTitle:y,setAccDescription:o,getAccDescription:u,addSection:v(({label:e,value:t})=>{if(t<0)throw Error(`"${e}" has invalid value: ${t}. Negative values are not allowed in pie charts. All slice values must be >= 0.`);D.has(e)||(D.set(e,t),h.debug(`added new section: ${e}, with value: ${t}`))},`addSection`),getSections:v(()=>D,`getSections`),setShowData:v(e=>{O=e},`setShowData`),getShowData:v(()=>O,`getShowData`)},j=v((e,t)=>{c(e,t),t.setShowData(e.showData),e.sections.map(t.addSection)},`populateDb`),M={parse:v(async e=>{let t=await l(`pie`,e);h.debug(t),j(t,A)},`parse`)},N=v(e=>`
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
`,`getStyles`),P=v(e=>{let t=[...e.values()].reduce((e,t)=>e+t,0),n=[...e.entries()].map(([e,t])=>({label:e,value:t})).filter(e=>e.value/t*100>=1);return w().value(e=>e.value).sort(null)(n)},`createPieArcs`),F={parser:M,db:A,renderer:{draw:v((e,t,r,a)=>{h.debug(`rendering pie chart
`+e);let o=a.db,s=f(),c=g(o.getConfig(),s.pie),l=b(t),u=l.append(`g`);u.attr(`transform`,`translate(225,225)`);let{themeVariables:d}=s,[m]=_(d.pieOuterStrokeWidth);m??=2;let v=c.textPosition,y=n().innerRadius(0).outerRadius(185),x=n().innerRadius(185*v).outerRadius(185*v);u.append(`circle`).attr(`cx`,0).attr(`cy`,0).attr(`r`,185+m/2).attr(`class`,`pieOuterCircle`);let S=o.getSections(),C=P(S),w=[d.pie1,d.pie2,d.pie3,d.pie4,d.pie5,d.pie6,d.pie7,d.pie8,d.pie9,d.pie10,d.pie11,d.pie12],T=0;S.forEach(e=>{T+=e});let E=C.filter(e=>(e.data.value/T*100).toFixed(0)!==`0`),D=i(w).domain([...S.keys()]);u.selectAll(`mySlices`).data(E).enter().append(`path`).attr(`d`,y).attr(`fill`,e=>D(e.data.label)).attr(`class`,`pieCircle`),u.selectAll(`mySlices`).data(E).enter().append(`text`).text(e=>(e.data.value/T*100).toFixed(0)+`%`).attr(`transform`,e=>`translate(`+x.centroid(e)+`)`).style(`text-anchor`,`middle`).attr(`class`,`slice`);let O=u.append(`text`).text(o.getDiagramTitle()).attr(`x`,0).attr(`y`,-400/2).attr(`class`,`pieTitleText`),k=[...S.entries()].map(([e,t])=>({label:e,value:t})),A=u.selectAll(`.legend`).data(k).enter().append(`g`).attr(`class`,`legend`).attr(`transform`,(e,t)=>{let n=22*k.length/2;return`translate(216,`+(t*22-n)+`)`});A.append(`rect`).attr(`width`,18).attr(`height`,18).style(`fill`,e=>D(e.label)).style(`stroke`,e=>D(e.label)),A.append(`text`).attr(`x`,22).attr(`y`,14).text(e=>o.getShowData()?`${e.label} [${e.value}]`:e.label);let j=512+Math.max(...A.selectAll(`text`).nodes().map(e=>e?.getBoundingClientRect().width??0)),M=O.node()?.getBoundingClientRect().width??0,N=450/2-M/2,F=450/2+M/2,I=Math.min(0,N),L=Math.max(j,F)-I;l.attr(`viewBox`,`${I} 0 ${L} 450`),p(l,450,L,c.useMaxWidth)},`draw`)},styles:N};export{F as diagram};