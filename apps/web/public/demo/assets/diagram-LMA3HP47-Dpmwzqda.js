import{CD as e,HD as t,RD as n,XT as r,YT as i,_D as a,aD as o,cD as s,fD as c,iO as l,oE as u,rO as d,vD as f,yD as p,yE as m,zD as h}from"./demo-shared-BzVPtUYD.js";var g=c.packet,_=class{constructor(){this.packet=[],this.setAccTitle=h,this.getAccTitle=f,this.setDiagramTitle=t,this.getDiagramTitle=e,this.getAccDescription=a,this.setAccDescription=n}static{d(this,`PacketDB`)}getConfig(){let e=u({...g,...p().packet});return e.showBits&&(e.paddingY+=10),e}getPacket(){return this.packet}pushWord(e){e.length>0&&this.packet.push(e)}clear(){o(),this.packet=[]}},v=1e4,y=d((e,t)=>{r(e,t);let n=-1,i=[],a=1,{bitsPerRow:o}=t.getConfig();for(let{start:r,end:s,bits:c,label:u}of e.blocks){if(r!==void 0&&s!==void 0&&s<r)throw Error(`Packet block ${r} - ${s} is invalid. End must be greater than start.`);if(r??=n+1,r!==n+1)throw Error(`Packet block ${r} - ${s??r} is not contiguous. It should start from ${n+1}.`);if(c===0)throw Error(`Packet block ${r} is invalid. Cannot have a zero bit field.`);for(s??=r+(c??1)-1,c??=s-r+1,n=s,l.debug(`Packet block ${r} - ${n} with label ${u}`);i.length<=o+1&&t.getPacket().length<v;){let[e,n]=b({start:r,end:s,bits:c,label:u},a,o);if(i.push(e),e.end+1===a*o&&(t.pushWord(i),i=[],a++),!n)break;({start:r,end:s,bits:c,label:u}=n)}}t.pushWord(i)},`populate`),b=d((e,t,n)=>{if(e.start===void 0)throw Error(`start should have been set during first phase`);if(e.end===void 0)throw Error(`end should have been set during first phase`);if(e.start>e.end)throw Error(`Block start ${e.start} is greater than block end ${e.end}.`);if(e.end+1<=t*n)return[e,void 0];let r=t*n-1,i=t*n;return[{start:e.start,end:r,label:e.label,bits:r-e.start},{start:i,end:e.end,label:e.label,bits:e.end-i}]},`getNextFittingBlock`),x={parser:{yy:void 0},parse:d(async e=>{let t=await i(`packet`,e),n=x.parser?.yy;if(!(n instanceof _))throw Error(`parser.parser?.yy was not a PacketDB. This is due to a bug within Mermaid, please report this issue at https://github.com/mermaid-js/mermaid/issues.`);l.debug(t),y(t,n)},`parse`)},S=d((e,t,n,r)=>{let i=r.db,a=i.getConfig(),{rowHeight:o,paddingY:c,bitWidth:l,bitsPerRow:u}=a,d=i.getPacket(),f=i.getDiagramTitle(),p=o+c,h=p*(d.length+1)-(f?0:o),g=l*u+2,_=m(t);_.attr(`viewBox`,`0 0 ${g} ${h}`),s(_,h,g,a.useMaxWidth);for(let[e,t]of d.entries())C(_,t,e,a);_.append(`text`).text(f).attr(`x`,g/2).attr(`y`,h-p/2).attr(`dominant-baseline`,`middle`).attr(`text-anchor`,`middle`).attr(`class`,`packetTitle`)},`draw`),C=d((e,t,n,{rowHeight:r,paddingX:i,paddingY:a,bitWidth:o,bitsPerRow:s,showBits:c})=>{let l=e.append(`g`),u=n*(r+a)+a;for(let e of t){let t=e.start%s*o+1,n=(e.end-e.start+1)*o-i;if(l.append(`rect`).attr(`x`,t).attr(`y`,u).attr(`width`,n).attr(`height`,r).attr(`class`,`packetBlock`),l.append(`text`).attr(`x`,t+n/2).attr(`y`,u+r/2).attr(`class`,`packetLabel`).attr(`dominant-baseline`,`middle`).attr(`text-anchor`,`middle`).text(e.label),!c)continue;let a=e.end===e.start,d=u-2;l.append(`text`).attr(`x`,t+(a?n/2:0)).attr(`y`,d).attr(`class`,`packetByte start`).attr(`dominant-baseline`,`auto`).attr(`text-anchor`,a?`middle`:`start`).text(e.start),a||l.append(`text`).attr(`x`,t+n).attr(`y`,d).attr(`class`,`packetByte end`).attr(`dominant-baseline`,`auto`).attr(`text-anchor`,`end`).text(e.end)}},`drawWord`),w={draw:S},T={byteFontSize:`10px`,startByteColor:`black`,endByteColor:`black`,labelColor:`black`,labelFontSize:`12px`,titleColor:`black`,titleFontSize:`14px`,blockStrokeColor:`black`,blockStrokeWidth:`1`,blockFillColor:`#efefef`},E={parser:x,get db(){return new _},renderer:w,styles:d(({packet:e}={})=>{let t=u(T,e);return`
	.packetByte {
		font-size: ${t.byteFontSize};
	}
	.packetByte.start {
		fill: ${t.startByteColor};
	}
	.packetByte.end {
		fill: ${t.endByteColor};
	}
	.packetLabel {
		fill: ${t.labelColor};
		font-size: ${t.labelFontSize};
	}
	.packetTitle {
		fill: ${t.titleColor};
		font-size: ${t.titleFontSize};
	}
	.packetBlock {
		stroke: ${t.blockStrokeColor};
		stroke-width: ${t.blockStrokeWidth};
		fill: ${t.blockFillColor};
	}
	`},`styles`)};export{E as diagram};