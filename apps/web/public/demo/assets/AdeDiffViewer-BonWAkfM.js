const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/vendor-monaco-C1gXc9CV.js","assets/rolldown-runtime-COnpUsM8.js","assets/vendor-monaco-Bea5N5JO.css"])))=>i.map(i=>d[i]);
import{a as e}from"./rolldown-runtime-COnpUsM8.js";import{E as t,O as n}from"./vendor-graph-B_soRnLq.js";import{n as r}from"./webZoom-BLDKIjSp.js";import{Ft as i}from"./vendor-monaco-C1gXc9CV.js";import{t as a}from"./CaretDown.es-BlI43QTb.js";import{t as o}from"./Copy.es-zBM3aCax.js";import{t as s}from"./MagnifyingGlass.es-128PpCGy.js";import{t as c}from"./X.es-D1KiNDnk.js";import{a as l,g as u,r as d,t as f}from"./laneDesignTokens-C0UDJlrc.js";import{t as p}from"./cn-CpDUS0cj.js";import{n as m,t as h}from"./useActiveTheme-nS8kskk2.js";import{V as g,Z as _,c as v,q as y,t as b,tt as x}from"./dist-D2d7tIHT.js";import{c as S,d as C,t as w}from"./appMenuCommands-DnDpLfa7.js";import{n as T}from"./keybindings-Dg370-up.js";import{to as E}from"./index-CXpecf_z.js";var D=`diffs-container`;(()=>{try{return!1}catch{return!1}})();var O=/(?=^From [a-f0-9]+ .+$)/m,k=/(?=^diff --git)/gm,A=/^(---|\+\+\+)\s+([^\t\r\n]+)/,j=/^(---|\+\+\+)\s+[ab]\/([^\t\r\n]+)/,M=/^diff --git (?:"a\/(.+?)"|a\/(.+?)) (?:"b\/(.+?)"|b\/(.+?))$/,N=/^index ([0-9a-f]+)\.\.([0-9a-f]+)(?: (\d+))?$/i,ee=`header-prefix`,te=`header-metadata`,ne=`header-custom`,P={dark:`pierre-dark`,light:`pierre-light`},re=`data-theme-css`,ie=`data-unsafe-css`,ae=`data-diffs-scrollbar-measure`,oe=`--diffs-scrollbar-gutter-measured`,se=1e5,ce={hunkLineCount:50,lineHeight:20,diffHeaderHeight:44,spacing:8};({...ce});var le=Object.freeze({fromStart:0,fromEnd:0}),ue={startingLine:0,totalLines:1/0,bufferBefore:0,bufferAfter:0},de={startingLine:0,totalLines:0,bufferBefore:0,bufferAfter:0};function fe(e,t,n){if(e===t||e==null||t==null)return e===t;let r=new Set(n),i=Object.keys(e),a=new Set(Object.keys(t));for(let n of i)if(a.delete(n),!r.has(n)&&(!(n in t)||e[n]!==t[n]))return!1;for(let e of Array.from(a))if(!r.has(e))return!1;return!0}function pe(e,t){return e==null||t==null||typeof e==`string`||typeof t==`string`?e===t:e.dark===t.dark&&e.light===t.light}function me(e,t){let n=e?.theme??P,r=t?.theme??P,i=he(e),a=he(t);return pe(n,r)&&fe(e,t,[`theme`,`parseDiffOptions`])&&fe(i,a)}function he(e){if(e!=null&&`parseDiffOptions`in e)return e.parseDiffOptions}function ge(e,t){return e?.start===t?.start&&e?.end===t?.end&&e?.side===t?.side&&e?.endSide===t?.endSide}function F(e){return{type:`text`,value:e}}function I({tagName:e,children:t=[],properties:n={}}){return{type:`element`,tagName:e,properties:n,children:t}}function _e({name:e,width:t=16,height:n=16,properties:r}){return I({tagName:`svg`,properties:{width:t,height:n,viewBox:`0 0 16 16`,...r},children:[I({tagName:`use`,properties:{href:`#${e.replace(/^#/,``)}`}})]})}function ve(e){let t=e.children[0];for(;t!=null;){if(t.type===`element`&&t.tagName===`code`)return t;t=`children`in t?t.children[0]:null}}function ye(e){return I({tagName:`div`,properties:{"data-gutter":``},children:e})}function be(e,t,n,r={}){return I({tagName:`div`,properties:{"data-line-type":e,"data-column-number":t,"data-line-index":n,...r},children:t==null?void 0:[I({tagName:`span`,properties:{"data-line-number-content":``},children:[F(`${t}`)]})]})}function L(e,t,n){return I({tagName:`div`,properties:{"data-gutter-buffer":t,"data-buffer-size":n,"data-line-type":t===`annotation`?void 0:e,style:t===`annotation`?`grid-row: span ${n};`:`grid-row: span ${n};min-height:calc(${n} * 1lh);`}})}function xe(){return I({tagName:`button`,properties:{"data-utility-button":``,type:`button`},children:[_e({name:`diffs-icon-plus`,properties:{"data-icon":``}})]})}function Se(e,t){return e.lineNumber===t.lineNumber&&e.side===t.side}var Ce=class{mode;options;hoveredLine;hoveredToken;pre;gutterUtilityLine;gutterUtilityContainer;gutterUtilityButton;gutterUtilitySlot;interactiveLinesAttr=!1;interactiveLineNumbersAttr=!1;hasPointerListeners=!1;hasDocumentPointerListeners=!1;selectedRange=null;proposedSelectedRange;renderedSelectionRange;selectionAnchor;queuedSelectionRender;pointerSession={mode:`idle`};constructor(e,t){this.mode=e,this.options=t}setOptions(e){this.options=e}cleanUp(){this.pre?.removeEventListener(`click`,this.handlePointerClick),this.pre?.removeEventListener(`pointerdown`,this.handlePointerDown),this.pre?.removeEventListener(`pointermove`,this.handlePointerMove),this.pre?.removeEventListener(`pointerleave`,this.handlePointerLeave),this.pre?.removeAttribute(`data-interactive-lines`),this.pre?.removeAttribute(`data-interactive-line-numbers`),this.pre=void 0,this.gutterUtilityContainer?.remove(),this.gutterUtilityLine=void 0,this.gutterUtilityContainer=void 0,this.gutterUtilityButton=void 0,this.gutterUtilitySlot=void 0,this.clearHoveredLine(),this.clearHoveredToken(),this.detachDocumentPointerListeners(),this.clearPointerSession(),this.queuedSelectionRender!=null&&(cancelAnimationFrame(this.queuedSelectionRender),this.queuedSelectionRender=void 0),this.interactiveLinesAttr=!1,this.interactiveLineNumbersAttr=!1,this.hasPointerListeners=!1}setup(e){this.setSelectionDirty();let{usesCustomGutterUtility:t=!1,enableGutterUtility:n=!1}=this.options;this.pre!==e&&(this.cleanUp(),this.pre=e),n?this.ensureGutterUtilityNode(t):this.gutterUtilityContainer!=null&&(this.gutterUtilityContainer.remove(),this.gutterUtilityLine=void 0,this.gutterUtilityContainer=void 0,this.gutterUtilityButton=void 0,this.gutterUtilitySlot=void 0,this.pointerSession.mode===`gutterSelecting`&&(this.clearPointerSession(),this.detachDocumentPointerListeners())),this.syncPointerListeners(e),this.updateInteractiveLineAttributes(),this.renderSelection(),this.placeUtility()}setSelectionDirty(){this.renderedSelectionRange=void 0}isSelectionDirty(){return this.renderedSelectionRange===null}setSelection(e,t){let n=!(e===this.selectedRange||ge(e??void 0,this.selectedRange??void 0));!this.isSelectionDirty()&&!n||(this.proposedSelectedRange=void 0,this.selectedRange=e,this.renderSelection(),this.placeUtility(),n&&t?.notify!==!1&&this.notifySelectionCommitted())}getSelection(){return this.selectedRange}getHoveredLine=()=>{let e=this.gutterUtilityLine??this.hoveredLine;if(e!=null){if(this.mode===`diff`&&e.type===`diff-line`)return{lineNumber:e.lineNumber,side:e.annotationSide};if(this.mode===`file`&&e.type===`line`)return{lineNumber:e.lineNumber}}};handlePointerClick=e=>{let{onHunkExpand:t,onLineClick:n,onLineNumberClick:r,onTokenClick:i,onMergeConflictActionClick:a}=this.options;t==null&&n==null&&r==null&&a==null&&i==null||this.options.onGutterUtilityClick!=null&&Be(e.composedPath())||(R(this.options.__debugPointerEvents,`click`,`FileDiff.DEBUG.handlePointerClick:`,e),this.handlePointerEvent({eventType:`click`,event:e}))};handlePointerMove=e=>{if(e.pointerType!==`mouse`)return;let{lineHoverHighlight:t=`disabled`,onLineEnter:n,onLineLeave:r,onTokenEnter:i,onTokenLeave:a,enableGutterUtility:o=!1}=this.options;t===`disabled`&&!o&&n==null&&r==null&&i==null&&a==null||(R(this.options.__debugPointerEvents,`move`,`FileDiff.DEBUG.handlePointerMove:`,e),this.handlePointerEvent({eventType:`move`,event:e}))};handlePointerLeave=e=>{let{__debugPointerEvents:t}=this.options;if(R(t,`move`,`FileDiff.DEBUG.handlePointerLeave: no event`),this.hoveredLine==null&&this.hoveredToken==null){R(t,`move`,`FileDiff.DEBUG.handlePointerLeave: returned early, no hovered line or token`);return}this.hoveredToken!=null&&(this.options.onTokenLeave?.(this.hoveredToken,e),this.clearHoveredToken()),this.hoveredLine!=null&&(this.options.onLineLeave?.({...this.hoveredLine,event:e}),this.clearHoveredLine()),this.placeUtility()};handlePointerEvent({eventType:e,event:t}){let{__debugPointerEvents:n}=this.options,r=t.composedPath();R(n,e,`FileDiff.DEBUG.handlePointerEvent:`,{eventType:e,composedPath:r});let i=this.resolvePointerTarget(r);R(n,e,`FileDiff.DEBUG.handlePointerEvent: resolvePointerTarget result:`,i);let{onLineClick:a,onLineNumberClick:o,onLineEnter:s,onLineLeave:c,onTokenClick:l,onTokenEnter:u,onTokenLeave:d,onHunkExpand:f,onMergeConflictActionClick:p}=this.options;switch(e){case`move`:{let e=Oe(i)&&this.hoveredLine?.lineElement===i.lineElement;De(i)&&this.hoveredToken?.tokenElement===i.tokenElement||(this.hoveredToken!=null&&(d?.(this.hoveredToken,t),this.clearHoveredToken()),De(i)&&(this.setHoveredToken(this.toTokenEventBaseProps(i)),u?.(this.hoveredToken,t))),e||(this.hoveredLine!=null&&(c?.({...this.hoveredLine,event:t}),this.clearHoveredLine()),Oe(i)?(this.setHoveredLine(this.toEventBaseProps(i)),this.placeUtility(),s?.({...this.hoveredLine,event:t})):this.placeUtility());break}case`click`:{if(i==null)break;if(Ae(i)&&p!=null){p(i);break}if(ke(i)&&f!=null){f(i.hunkIndex,i.all||t.shiftKey?`both`:i.direction,i.all||t.shiftKey?1/0:void 0);break}if(!Oe(i))break;De(i)&&l!=null&&l(this.toTokenEventBaseProps(i),t);let e=this.toEventBaseProps(i);o!=null&&i.numberColumn?o({...e,event:t}):a?.({...e,event:t});break}}}syncPointerListeners(e){let{__debugPointerEvents:t,lineHoverHighlight:n=`disabled`,onLineClick:r,onLineNumberClick:i,onLineEnter:a,onLineLeave:o,onTokenClick:s,onTokenEnter:c,onTokenLeave:l,onHunkExpand:u,onMergeConflictActionClick:d,enableGutterUtility:f=!1,enableLineSelection:p=!1,onGutterUtilityClick:m}=this.options,h=m!=null,g=n!==`disabled`||r!=null||i!=null||a!=null||o!=null||s!=null||c!=null||l!=null||u!=null||d!=null||f||p||h;g&&!this.hasPointerListeners?(e.addEventListener(`click`,this.handlePointerClick),e.addEventListener(`pointerdown`,this.handlePointerDown),e.addEventListener(`pointermove`,this.handlePointerMove),e.addEventListener(`pointerleave`,this.handlePointerLeave),this.hasPointerListeners=!0,R(t,`click`,`FileDiff.DEBUG.attachEventListeners: Attaching click events for:`,(()=>{let e=[];return(t===`both`||t===`click`)&&(r!=null&&e.push(`onLineClick`),i!=null&&e.push(`onLineNumberClick`),u!=null&&e.push(`expandable hunk separators`),d!=null&&e.push(`merge conflict actions`)),e})()),R(t,`move`,`FileDiff.DEBUG.attachEventListeners: Attaching pointer move event`),R(t,`move`,`FileDiff.DEBUG.attachEventListeners: Attaching pointer leave event`)):!g&&this.hasPointerListeners&&(e.removeEventListener(`click`,this.handlePointerClick),e.removeEventListener(`pointerdown`,this.handlePointerDown),e.removeEventListener(`pointermove`,this.handlePointerMove),e.removeEventListener(`pointerleave`,this.handlePointerLeave),this.hasPointerListeners=!1);let _=this.pointerSession.mode===`selecting`||this.pointerSession.mode===`pendingSingleLineUnselect`,v=this.pointerSession.mode===`gutterSelecting`;(!p&&_||!h&&v)&&(this.clearPointerSession(),this.detachDocumentPointerListeners(),this.selectionAnchor=void 0,this.clearPendingSingleLineState())}updateInteractiveLineAttributes(){if(this.pre==null)return;let{onLineClick:e,onLineNumberClick:t,enableLineSelection:n=!1}=this.options,r=e!=null,i=t!=null||n;r&&!this.interactiveLinesAttr?(this.pre.setAttribute(`data-interactive-lines`,``),this.interactiveLinesAttr=!0):!r&&this.interactiveLinesAttr&&(this.pre.removeAttribute(`data-interactive-lines`),this.interactiveLinesAttr=!1),i&&!this.interactiveLineNumbersAttr?(this.pre.setAttribute(`data-interactive-line-numbers`,``),this.interactiveLineNumbersAttr=!0):!i&&this.interactiveLineNumbersAttr&&(this.pre.removeAttribute(`data-interactive-line-numbers`),this.interactiveLineNumbersAttr=!1)}handlePointerDown=e=>{if(e.pointerType===`mouse`&&e.button!==0||this.pre==null||this.pointerSession.mode!==`idle`)return;let t=e.composedPath();Be(t)&&this.options.onGutterUtilityClick!=null?this.startGutterSelectionFromPointerDown(e):(e.pointerType!==`mouse`&&this.revealUtilityFromGutterPath(t),this.startLineSelectionFromPointerDown(e))};startLineSelectionFromPointerDown(e){let{enableLineSelection:t=!1}=this.options;if(!t)return;let n=this.resolveSelectionInfo(e,{source:`event-path`,requireNumberColumn:!0});if(n==null)return;let{pre:r}=this;if(r==null)return;let{lineNumber:i,eventSide:a,lineIndex:o}=n;if(e.shiftKey&&this.selectedRange!=null){let t=this.getIndexesFromSelection(this.selectedRange,r.getAttribute(`data-diff-type`)===`split`);if(t==null)return;let n=t.start<=t.end?o>=t.start:o<=t.end;this.selectionAnchor={lineNumber:n?this.selectedRange.start:this.selectedRange.end,side:n?this.selectedRange.side:this.selectedRange.endSide??this.selectedRange.side},this.updateSelection(i,a,!1),this.notifySelectionStart(this.getCurrentSelectionRange()),this.pointerSession={mode:`selecting`,pointerId:e.pointerId},this.attachDocumentPointerListeners();return}if(this.selectedRange?.start===i&&this.selectedRange?.end===i){let t={lineNumber:i,side:a};this.selectionAnchor=t,this.pointerSession={mode:`pendingSingleLineUnselect`,pointerId:e.pointerId,anchor:t,pending:t},this.attachDocumentPointerListeners();return}this.options.controlledSelection===!0?this.proposedSelectedRange=null:this.selectedRange=null,this.placeUtility(),this.selectionAnchor={lineNumber:i,side:a},this.updateSelection(i,a,!1),this.notifySelectionStart(this.getCurrentSelectionRange()),this.pointerSession={mode:`selecting`,pointerId:e.pointerId},this.attachDocumentPointerListeners()}startGutterSelectionFromPointerDown(e){let{enableLineSelection:t=!1,onGutterUtilityClick:n}=this.options;if(n==null)return;let r=this.currentSelectionEnds(),i=r?.bottom??this.resolveSelectionPoint(e,{source:`event-path`,excludeUtility:!1}),a=r?.top??i;i==null||a==null||(e.preventDefault(),e.stopPropagation(),this.pointerSession={mode:`gutterSelecting`,pointerId:e.pointerId,anchor:a,current:i},t&&(this.selectionAnchor={lineNumber:a.lineNumber,side:a.side},this.updateSelection(i.lineNumber,i.side,!1),this.notifySelectionStart(this.getCurrentSelectionRange())),this.attachDocumentPointerListeners())}handleDocumentPointerMove=e=>{let{enableLineSelection:t=!1}=this.options;switch(this.pointerSession.mode){case`idle`:return;case`gutterSelecting`:{if(e.pointerId!==this.pointerSession.pointerId)return;e.preventDefault();let n=this.resolveSelectionPoint(e,{source:`coordinates-first`});if(n==null)return;this.pointerSession.current=n,t===!0&&this.updateSelection(n.lineNumber,n.side);return}case`selecting`:{if(e.pointerId!==this.pointerSession.pointerId)return;e.preventDefault();let t=this.resolveSelectionInfo(e,{source:`coordinates-first`,requireNumberColumn:!1});if(t==null||this.selectionAnchor==null)return;this.updateSelection(t.lineNumber,t.eventSide);return}case`pendingSingleLineUnselect`:{if(e.pointerId!==this.pointerSession.pointerId)return;e.preventDefault();let t=this.resolveSelectionInfo(e,{source:`coordinates-first`,requireNumberColumn:!1});if(t==null||this.selectionAnchor==null)return;let n={lineNumber:t.lineNumber,side:t.eventSide};if(Se(this.pointerSession.pending,n))return;this.updateSelection(t.lineNumber,t.eventSide,!1),this.notifySelectionStart(this.getCurrentSelectionRange()),this.notifySelectionChangeDelta(),this.pointerSession={mode:`selecting`,pointerId:e.pointerId};return}}};handleDocumentPointerUp=e=>{let{enableLineSelection:t=!1,onGutterUtilityClick:n}=this.options;switch(this.pointerSession.mode){case`idle`:return;case`gutterSelecting`:{if(e.pointerId!==this.pointerSession.pointerId)return;e.preventDefault();let r=this.resolveSelectionPoint(e,{source:`coordinates-first`});r!=null&&(this.pointerSession.current=r,t&&this.updateSelection(r.lineNumber,r.side)),n?.(this.buildSelectedLineRange(this.pointerSession.anchor,this.pointerSession.current)),this.selectionAnchor=void 0,t&&(this.notifySelectionEnd(this.getCurrentSelectionRange()),this.notifySelectionCommitted(),this.clearProposedSelection()),this.clearPointerSession(),this.detachDocumentPointerListeners();return}case`pendingSingleLineUnselect`:if(e.pointerId!==this.pointerSession.pointerId)return;e.preventDefault(),this.updateSelection(null,void 0,!1),this.selectionAnchor=void 0,this.clearPendingSingleLineState(),this.detachDocumentPointerListeners(),this.notifySelectionEnd(this.getCurrentSelectionRange()),this.notifySelectionCommitted(),this.clearProposedSelection();return;case`selecting`:if(e.pointerId!==this.pointerSession.pointerId)return;e.preventDefault(),this.selectionAnchor=void 0,this.detachDocumentPointerListeners(),this.clearPointerSession(),this.notifySelectionEnd(this.getCurrentSelectionRange()),this.notifySelectionCommitted(),this.clearProposedSelection()}};handleDocumentPointerCancel=e=>{switch(this.pointerSession.mode){case`idle`:return;case`gutterSelecting`:case`selecting`:case`pendingSingleLineUnselect`:if(`pointerId`in this.pointerSession&&e.pointerId!==this.pointerSession.pointerId)return;this.selectionAnchor=void 0,this.clearProposedSelection(),this.clearPendingSingleLineState(),this.clearPointerSession(),this.detachDocumentPointerListeners()}};clearHoveredLine(){this.hoveredLine!=null&&(this.hoveredLine.lineElement.removeAttribute(`data-hovered`),this.hoveredLine.numberElement.removeAttribute(`data-hovered`),this.hoveredLine=void 0)}setHoveredLine(e){let{lineHoverHighlight:t=`disabled`}=this.options;this.hoveredLine!=null&&this.clearHoveredLine(),this.hoveredLine=e,t!==`disabled`&&((t===`both`||t===`line`)&&this.hoveredLine.lineElement.setAttribute(`data-hovered`,``),(t===`both`||t===`number`)&&this.hoveredLine.numberElement.setAttribute(`data-hovered`,``))}clearHoveredToken(){this.hoveredToken!=null&&(this.hoveredToken=void 0)}setHoveredToken(e){this.hoveredToken!=null&&this.clearHoveredToken(),this.hoveredToken=e}ensureGutterUtilityNode(e){if(this.gutterUtilityContainer??(this.gutterUtilityContainer=document.createElement(`div`),this.gutterUtilityContainer.setAttribute(`data-gutter-utility-slot`,``)),e)this.gutterUtilityButton!=null&&(this.gutterUtilityButton.remove(),this.gutterUtilityButton=void 0),this.gutterUtilitySlot??(this.gutterUtilitySlot=document.createElement(`slot`),this.gutterUtilitySlot.name=`gutter-utility-slot`),this.gutterUtilitySlot.parentNode!==this.gutterUtilityContainer&&this.gutterUtilityContainer.replaceChildren(this.gutterUtilitySlot);else{if(this.gutterUtilitySlot?.remove(),this.gutterUtilitySlot=void 0,this.gutterUtilityButton==null){let e=document.createElement(`div`);e.innerHTML=x(xe());let t=e.firstElementChild;if(!(t instanceof HTMLButtonElement))throw Error(`InteractionManager.ensureGutterUtilityNode: Node element should be a button`);t.remove(),this.gutterUtilityButton=t}this.gutterUtilityButton.parentNode!==this.gutterUtilityContainer&&this.gutterUtilityContainer.replaceChildren(this.gutterUtilityButton)}}revealUtilityFromGutterPath(e){if(this.placeUtilityFromSelection())return;let t=this.resolvePointerTarget(e);Ee(t)&&t.numberColumn&&this.showUtilityOnLine(this.toEventBaseProps(t))}placeUtility(){if(!this.placeUtilityFromSelection()){if(this.hoveredLine!=null){this.showUtilityOnLine(this.hoveredLine);return}this.hideUtility()}}placeUtilityFromSelection(){let e=this.currentSelectionEnds();if(e==null)return!1;let t=this.targetForSelectionPoint(e.bottom);return t==null?this.hideUtility():this.showUtilityOnLine(this.toEventBaseProps(t)),!0}showUtilityOnLine(e){this.gutterUtilityContainer!=null&&(this.gutterUtilityLine=e,e.numberElement.appendChild(this.gutterUtilityContainer))}hideUtility(){this.gutterUtilityContainer?.remove(),this.gutterUtilityLine=void 0}currentSelectionEnds(){let e=this.getCurrentSelectionRange();return e==null?void 0:this.selectionEnds(e)}selectionEnds(e){let t={lineNumber:e.start,side:e.side},n={lineNumber:e.end,side:e.endSide??e.side},r=this.selectionPointRowIndex(t),i=this.selectionPointRowIndex(n);if(!(r==null||i==null))return r>i?{top:n,bottom:t}:{top:t,bottom:n}}selectionPointRowIndex(e){let t=this.getLineIndex(e.lineNumber,e.side);if(t!=null)return this.isSplitDiff()?t[1]:t[0]}targetForSelectionPoint(e){if(this.pre==null)return;let t=this.getLineIndex(e.lineNumber,e.side);if(t==null)return;let n=this.mode===`diff`?`${t[0]},${t[1]}`:`${t[0]}`,r=this.pre.querySelectorAll(`[data-column-number="${e.lineNumber}"][data-line-index="${n}"]`);for(let t of r){if(!(t instanceof HTMLElement))continue;let n=this.resolvePointerTarget(Ne(t));if(Ee(n)&&!(this.mode===`diff`&&e.side!=null&&n.side!==e.side))return n}}attachDocumentPointerListeners(){this.hasDocumentPointerListeners||=(document.addEventListener(`pointermove`,this.handleDocumentPointerMove),document.addEventListener(`pointerup`,this.handleDocumentPointerUp),document.addEventListener(`pointercancel`,this.handleDocumentPointerCancel),!0)}detachDocumentPointerListeners(){this.hasDocumentPointerListeners&&=(document.removeEventListener(`pointermove`,this.handleDocumentPointerMove),document.removeEventListener(`pointerup`,this.handleDocumentPointerUp),document.removeEventListener(`pointercancel`,this.handleDocumentPointerCancel),!1)}clearPointerSession(){this.pointerSession={mode:`idle`}}clearPendingSingleLineState(){this.pointerSession.mode===`pendingSingleLineUnselect`&&(this.pointerSession={mode:`idle`})}selectionInfoFromPath(e,t){let n=this.resolvePointerTarget(e);if(Ee(n)&&!(t&&!n.numberColumn)&&n.splitLineIndex!=null)return{lineIndex:n.splitLineIndex,lineNumber:n.lineNumber,eventSide:this.mode===`diff`?n.side:void 0}}resolveSelectionInfo(e,t){let n=this.resolveSelectionPath(e,t);return n==null?void 0:this.selectionInfoFromPath(n,t.requireNumberColumn)}selectionPointFromPath(e){let t=this.resolvePointerTarget(e);if(Ee(t))return{lineNumber:t.lineNumber,side:this.mode===`diff`?t.side:void 0}}resolveSelectionPoint(e,t){let n=this.resolveSelectionPath(e,t);return n==null?void 0:this.selectionPointFromPath(n)}resolveSelectionPath(e,t){let n=t.excludeUtility!==!1;switch(t.source){case`event-path`:return this.pathFromEventPath(e.composedPath(),n);case`coordinates-first`:{let t=this.pathFromCoordinates(e,n);return t===void 0?this.pathFromEventPath(e.composedPath(),n):t??void 0}}}pathFromCoordinates(e,t){let n=this.hitTest(e);if(n!==void 0)return n===null?null:this.pathFromElement(n,t)??null}pathFromEventPath(e,t){if(!(t&&Be(e))){for(let n of e)if(n instanceof Element)return this.pathFromElement(n,t)}}pathFromElement(e,t){let n=Ne(e);if(t&&Be(n))return;let r=Pe(e);return r==null?this.pathFromAnnotationSlot(e):Ne(r)}pathFromAnnotationSlot(e){let t=Ie(Fe(e));if(t==null)return;let n=this.targetForSelectionPoint(t);return n==null?void 0:Ne(n.lineElement)}hitTest(e){if(!Number.isFinite(e.clientX)||!Number.isFinite(e.clientY))return;let t=this.pre?.getRootNode(),n=Le(t)?t:Le(document)?document:void 0;if(n!=null)return n.elementFromPoint(e.clientX,e.clientY)}getLineIndex(e,t){let{getLineIndex:n}=this.options;return n==null?[e-1,e-1]:n(e,t)}getCurrentSelectionRange(){return this.proposedSelectedRange===void 0?this.selectedRange:this.proposedSelectedRange}clearProposedSelection(){this.proposedSelectedRange=void 0}updateSelection(e,t,n=!0){let r=this.getCurrentSelectionRange(),i;if(e==null)i=null;else{let n=this.selectionAnchor?.side??t,r=this.selectionAnchor?.lineNumber??e;i=this.buildSelectionRange(r,e,n,t)}ge(r??void 0,i??void 0)||(this.options.controlledSelection===!0?this.proposedSelectedRange=i:(this.selectedRange=i,this.queuedSelectionRender??=requestAnimationFrame(this.renderSelection)),this.placeUtility(),n&&this.notifySelectionChangeDelta())}getIndexesFromSelection(e,t){if(this.pre==null)return;let n=this.getLineIndex(e.start,e.side),r=this.getLineIndex(e.end,e.endSide??e.side);return n!=null&&r!=null?{start:t?n[1]:n[0],end:t?r[1]:r[0]}:void 0}renderSelection=()=>{if(this.queuedSelectionRender!=null&&(cancelAnimationFrame(this.queuedSelectionRender),this.queuedSelectionRender=void 0),this.pre==null||this.renderedSelectionRange===this.selectedRange)return;let e=this.pre.querySelectorAll(`[data-selected-line]`);for(let t of e)t.removeAttribute(`data-selected-line`);if(this.renderedSelectionRange=this.selectedRange,this.selectedRange==null)return;let{children:t}=this.pre;if(t.length===0)return;if(t.length>2)throw console.error(t),Error(`InteractionManager.renderSelection: Somehow there are more than 2 code elements...`);let n=this.pre.getAttribute(`data-diff-type`)===`split`,r=this.getIndexesFromSelection(this.selectedRange,n);if(r==null)throw console.error({rowRange:r,selectedRange:this.selectedRange}),Error(`InteractionManager.renderSelection: No valid rowRange`);let i=r.start===r.end,a=Math.min(r.start,r.end),o=Math.max(r.start,r.end);for(let e of t){let[t,r]=e.children,s=r.children.length;if(s!==t.children.length)throw Error(`InteractionManager.renderSelection: gutter and content children dont match, something is wrong`);for(let e=0;e<s;e++){let s=r.children[e],c=t.children[e];if(!(s instanceof HTMLElement)||!(c instanceof HTMLElement))continue;let l=this.parseLineIndex(s,n);if((l??0)>o)break;if(l==null||l<a)continue;let u=i?`single`:l===a?`first`:l===o?`last`:``;s.setAttribute(`data-selected-line`,u),c.setAttribute(`data-selected-line`,u),c.nextSibling instanceof HTMLElement&&s.nextSibling instanceof HTMLElement&&(s.nextSibling.hasAttribute(`data-line-annotation`)||s.nextSibling.hasAttribute(`data-merge-conflict-actions`))&&(i?(u=`last`,s.setAttribute(`data-selected-line`,`first`)):l===a?u=``:l===o&&s.setAttribute(`data-selected-line`,``),s.nextSibling.setAttribute(`data-selected-line`,u),c.nextSibling.setAttribute(`data-selected-line`,u))}}};notifySelectionCommitted(){this.options.onLineSelected?.(this.getCurrentSelectionRange()??null)}notifySelectionChangeDelta(){this.options.onLineSelectionChange?.(this.getCurrentSelectionRange()??null)}notifySelectionStart(e){this.options.onLineSelectionStart?.(e)}notifySelectionEnd(e){this.options.onLineSelectionEnd?.(e)}toEventBaseProps(e){return this.mode===`file`?{type:`line`,lineElement:e.lineElement,lineNumber:e.lineNumber,numberColumn:e.numberColumn,numberElement:e.numberElement}:{type:`diff-line`,annotationSide:e.side,lineType:e.lineType,lineElement:e.lineElement,numberElement:e.numberElement,lineNumber:e.lineNumber,numberColumn:e.numberColumn}}toTokenEventBaseProps({lineCharEnd:e,lineCharStart:t,lineNumber:n,side:r,tokenElement:i,tokenText:a}){return this.mode===`file`?{type:`token`,lineCharEnd:e,lineCharStart:t,lineNumber:n,tokenElement:i,tokenText:a}:{type:`token`,lineCharEnd:e,lineCharStart:t,lineNumber:n,side:r,tokenElement:i,tokenText:a}}buildSelectedLineRange(e,t){return this.buildSelectionRange(e.lineNumber,t.lineNumber,e.side,t.side)}buildSelectionRange(e,t,n,r){return{start:e,end:t,...n==null?{}:{side:n},...n!==r&&r!=null?{endSide:r}:{}}}resolvePointerTarget(e){let t=!1,n,r,i,a,o,s,c,l,u,d;for(let f of e){if(!(f instanceof HTMLElement))continue;if(d==null&&f.hasAttribute(`data-merge-conflict-action`)){let e=f.getAttribute(`data-merge-conflict-action`)??void 0,t=f.getAttribute(`data-merge-conflict-conflict-index`)??void 0,n=t==null?NaN:Number.parseInt(t,10);je(e)&&Number.isFinite(n)&&(d={kind:`merge-conflict-action`,resolution:e,conflictIndex:n})}if(s==null&&f.hasAttribute(`data-char`)){s=f;let e=f.getAttribute(`data-char`);if(e!=null){let t=Number.parseInt(e,10);if(!Number.isNaN(t)){let e=f.textContent??``,n=t+e.length;(e.trim()!==``||this.options.enableTokenInteractionsOnWhitespace===!0)&&(c={tokenElement:s,lineCharStart:t,lineCharEnd:n,tokenText:e});continue}}}let e=o==null?f.getAttribute(`data-column-number`)??void 0:void 0;if(e!=null){o=f,u=Number.parseInt(e,10),t=!0,n=ze(f),a=f.getAttribute(`data-line-index`)??void 0;continue}let p=i==null?f.getAttribute(`data-line`)??void 0:void 0;if(p!=null){i=f,u=Number.parseInt(p,10),n=ze(f),a=f.getAttribute(`data-line-index`)??void 0;continue}if(l==null&&(f.hasAttribute(`data-expand-button`)||f.hasAttribute(`data-unmodified-lines`))){l={hunkIndex:void 0,direction:f.hasAttribute(`data-expand-up`)?`up`:f.hasAttribute(`data-expand-down`)?`down`:`both`,all:f.hasAttribute(`data-expand-all-button`)};continue}let m=l==null?void 0:f.getAttribute(`data-expand-index`)??void 0;if(l!=null&&m!=null){let e=Number.parseInt(m,10);Number.isNaN(e)||(l.hunkIndex=e);continue}if(r==null&&f.hasAttribute(`data-code`)){r=f;break}}if(d!=null)return d;if(l?.hunkIndex!=null)return{type:`line-info`,hunkIndex:l.hunkIndex,direction:l.direction,all:l.all};if(i??=a==null?void 0:Me(r,`[data-line][data-line-index="${a}"]`),o??=a==null?void 0:Me(r,`[data-column-number][data-line-index="${a}"]`),r==null||i==null||o==null||n==null||u==null||Number.isNaN(u))return;let f=this.parseLineIndex(i,this.isSplitDiff());return c==null?this.mode===`file`?{kind:`line`,lineType:n,lineElement:i,lineNumber:u,numberColumn:t,numberElement:o,side:void 0,splitLineIndex:f}:{kind:`line`,lineType:n,lineElement:i,lineNumber:u,numberColumn:t,numberElement:o,side:Re(n,r),splitLineIndex:f}:this.mode===`file`?{kind:`token`,lineType:n,lineElement:i,lineNumber:u,numberColumn:t,numberElement:o,side:void 0,splitLineIndex:f,...c}:{kind:`token`,lineType:n,lineElement:i,lineNumber:u,numberColumn:t,numberElement:o,side:Re(n,r),splitLineIndex:f,...c}}isSplitDiff(){return this.pre?.getAttribute(`data-diff-type`)===`split`}parseLineIndex(e,t){let n=(e.getAttribute(`data-line-index`)??``).split(`,`).map(e=>Number.parseInt(e,10)).filter(e=>!Number.isNaN(e));if(t&&n.length===2)return n[1];if(!t)return n[0]}};function we({enableTokenInteractionsOnWhitespace:e,enableGutterUtility:t,lineHoverHighlight:n,onGutterUtilityClick:r,onLineClick:i,onLineEnter:a,onLineLeave:o,onLineNumberClick:s,onTokenClick:c,onTokenEnter:l,onTokenLeave:u,renderGutterUtility:d,__debugPointerEvents:f,enableLineSelection:p,controlledSelection:m,onLineSelected:h,onLineSelectionStart:g,onLineSelectionChange:_,onLineSelectionEnd:v},y,b,x){return{enableTokenInteractionsOnWhitespace:e,enableGutterUtility:Te({enableGutterUtility:t,renderGutterUtility:d,onGutterUtilityClick:r}),usesCustomGutterUtility:d!=null,lineHoverHighlight:n,onGutterUtilityClick:r,onHunkExpand:y,onMergeConflictActionClick:x,onLineClick:i,onLineEnter:a,onLineLeave:o,onLineNumberClick:s,onTokenClick:c,onTokenEnter:l,onTokenLeave:u,__debugPointerEvents:f,enableLineSelection:p,controlledSelection:m,onLineSelected:h,onLineSelectionStart:g,onLineSelectionChange:_,onLineSelectionEnd:v,getLineIndex:b}}function Te({enableGutterUtility:e,renderGutterUtility:t,onGutterUtilityClick:n}){if(n!=null&&t!=null)throw Error(`Cannot use both 'onGutterUtilityClick' and 'renderGutterUtility'. Use only one gutter utility API.`);return e??!1}function Ee(e){return e!=null&&`kind`in e&&e.kind===`line`}function De(e){return e!=null&&`kind`in e&&e.kind===`token`}function Oe(e){return Ee(e)||De(e)}function ke(e){return`type`in e&&e.type===`line-info`}function Ae(e){return`kind`in e&&e.kind===`merge-conflict-action`}function je(e){return e===`current`||e===`incoming`||e===`both`}function Me(e,t){let n=e?.querySelector(t);return n instanceof HTMLElement?n:void 0}function Ne(e){let t=[],n=e;for(;n!=null;)t.push(n),n=n.parentNode;return t}function Pe(e){let t=e.closest(`[data-line], [data-column-number]`);if(t instanceof HTMLElement)return t;let n=e.closest(`[data-line-annotation], [data-gutter-buffer="annotation"]`);if(!(n instanceof HTMLElement))return;let r=n.previousElementSibling;return r instanceof HTMLElement&&(r.hasAttribute(`data-line`)||r.hasAttribute(`data-column-number`))?r:void 0}function Fe(e){let t=e.closest(`[slot^="annotation-"]`);if(t instanceof HTMLElement)return t.getAttribute(`slot`)??void 0;if(e instanceof HTMLElement){let t=e.getAttribute(`name`)??void 0;return t!=null&&t.startsWith(`annotation-`)?t:void 0}}function Ie(e){if(e==null)return;let t=/^annotation-(?:(additions|deletions)-)?(\d+)$/.exec(e);if(t==null)return;let n=Number.parseInt(t[2],10);if(!(!Number.isFinite(n)||n<=0))return{lineNumber:n,side:t[1]}}function Le(e){return e!=null&&typeof e.elementFromPoint==`function`}function Re(e,t){switch(e){case`change-deletion`:return`deletions`;case`change-addition`:return`additions`;default:return t.hasAttribute(`data-deletions`)?`deletions`:`additions`}}function ze(e){let t=e.getAttribute(`data-line-type`);if(t!=null)switch(t){case`change-deletion`:case`change-addition`:case`context`:case`context-expanded`:return t;default:return}}function Be(e){for(let t of e)if(t instanceof HTMLElement&&(t.hasAttribute(`data-utility-button`)||t.hasAttribute(`data-gutter-utility-slot`)||t.getAttribute(`slot`)===`gutter-utility-slot`||t.getAttribute(`name`)===`gutter-utility-slot`))return!0;return!1}function R(e=`none`,t,...n){switch(e){case`none`:return;case`both`:break;case`click`:if(t!==`click`)return;break;case`move`:if(t!==`move`)return;break}console.log(...n)}var Ve=class e{static resizeObserver;static managersByElement=new Map;static getResizeObserver(){let t=e.resizeObserver??new ResizeObserver(e.handleSharedResizeEntries);return e.resizeObserver=t,t}static handleSharedResizeEntries(t){let n=new Map;for(let r of t){let t=e.managersByElement.get(r.target);if(t==null)continue;let i=n.get(t);i==null?n.set(t,[r]):i.push(r)}for(let[e,t]of n)e.handleResizeEntries(t)}observedNodes=new Map;setup(e,t){let n=new Set,r=0,i=new Map(this.observedNodes);this.observedNodes.clear();for(let t of e.children){if(r===2)break;let e=(()=>{if(t instanceof HTMLElement&&t.tagName===`CODE`)return t})();if(e==null)continue;r++;let n=i.get(e);if(n!=null&&n.type!==`code`)throw Error(`ResizeManager.setup: somehow a code node is being used for an annotation, should be impossible`);let a=e.firstElementChild;a instanceof HTMLElement||(a=null),n==null?(n={type:`code`,codeElement:e,numberElement:a,codeWidth:`auto`,numberWidth:0},this.observedNodes.set(e,n),this.observe(e),a!=null&&(this.observedNodes.set(a,n),this.observe(a))):(this.observedNodes.set(e,n),i.delete(e),n.numberElement===a?n.numberElement==null?n.numberWidth=0:(i.delete(n.numberElement),this.observedNodes.set(n.numberElement,n)):(n.numberElement!=null&&(this.unobserve(n.numberElement),i.delete(n.numberElement)),a!=null&&(this.observe(a),i.delete(a),this.observedNodes.set(a,n)),n.numberElement=a,n.numberWidth=0))}if(r>1&&!t){let t=e.querySelectorAll(`[data-line-annotation*=","]`),r=new Map;for(let e of t){if(!(e instanceof HTMLElement))continue;let t=e.getAttribute(`data-line-annotation`)??``;if(!/^-?\d+,-?\d+$/.test(t)){console.error(`DiffFileRenderer.setupResizeObserver: Invalid element or annotation`,{lineAnnotation:t,element:e});continue}let n=r.get(t);n??(n=[],r.set(t,n)),n.push(e)}for(let[e,t]of r){if(t.length!==2){console.error(`DiffFileRenderer.setupResizeObserver: Bad Pair`,e,t);continue}let[r,a]=t,o=r.firstElementChild,s=a.firstElementChild;if(!(r instanceof HTMLElement)||!(a instanceof HTMLElement)||!(o instanceof HTMLElement)||!(s instanceof HTMLElement))continue;let c=i.get(o);if(c!=null){this.observedNodes.set(o,c),this.observedNodes.set(s,c),i.delete(o),i.delete(s);continue}let l=o.getBoundingClientRect().height,u=s.getBoundingClientRect().height;c={type:`annotations`,column1:{container:r,child:o,childHeight:l},column2:{container:a,child:s,childHeight:u},currentHeight:`auto`},n.add({child1:o,child2:s,item:c,newHeight:Math.max(l,u)})}for(let e of n)this.applyNewHeight(e.item,e.newHeight),this.observedNodes.set(e.child1,e.item),this.observedNodes.set(e.child2,e.item),this.observe(e.child1),this.observe(e.child2);n.clear()}for(let[e,t]of i)this.unobserve(e),t.type===`code`?We(t):Ge(t);i.clear()}cleanUp(){for(let e of this.observedNodes.keys())this.unobserve(e);this.observedNodes.clear()}observe(t){let{managersByElement:n}=e,r=n.get(t);if(r!==this){if(r!=null&&r!==this)throw Error(`ResizeManager.observe: element is already owned by another ResizeManager`);n.set(t,this),e.getResizeObserver().observe(t)}}unobserve(t){let{managersByElement:n,resizeObserver:r}=e,i=n.get(t);if(i!=null){if(i!==this)throw Error(`ResizeManager.unobserve: element is owned by another ResizeManager`);n.delete(t),r?.unobserve(t),r!=null&&n.size===0&&(r.disconnect(),e.resizeObserver=void 0)}}handleResizeEntries(e){let t=new Map,n=new Set;for(let r of e){let{target:e,borderBoxSize:i,contentBoxSize:a}=r;if(!(e instanceof HTMLElement)){console.error(`ResizeManager.handleResizeEntries: Invalid element for ResizeObserver`,r);continue}let o=this.observedNodes.get(e);if(o==null){console.error(`ResizeManager.handleResizeEntries: Not a valid observed node`,r);continue}if(o.type===`annotations`){let t=(()=>{if(e===o.column1.child)return o.column1;if(e===o.column2.child)return o.column2})();if(t==null){console.error(`ResizeManager.handleResizeEntries: Couldn't find a column for`,{item:o,target:e});continue}t.childHeight=i[0].blockSize,n.add(o)}else if(o.type===`code`){let n=t.get(o)??{},r=a[0].inlineSize;e===o.codeElement?n.codeInlineSize=r:e===o.numberElement&&(n.numberInlineSize=r),t.set(o,n)}}this.applyAnnotationUpdates(n),n.clear(),this.applyColumnUpdates(t),t.clear()}applyAnnotationUpdates(e){for(let t of e)this.applyNewHeight(t,Math.max(t.column1.childHeight,t.column2.childHeight))}applyColumnUpdates=e=>{for(let[t,n]of e){let e=n.codeInlineSize==null?t.codeWidth:He(n.codeInlineSize),r=n.numberInlineSize==null?t.numberWidth:Ue(n.numberInlineSize),i=e!==t.codeWidth,a=r!==t.numberWidth;if(!(!i&&!a)&&(t.codeWidth=e,t.numberWidth=r,i&&t.codeElement.style.setProperty(`--diffs-column-width`,`${typeof e==`number`?`${e}px`:`auto`}`),a&&t.codeElement.style.setProperty(`--diffs-column-number-width`,`${r===0?`auto`:`${r}px`}`),i||a&&e!==`auto`)){let n=typeof e==`number`?Math.max(e-r,0):0;t.codeElement.style.setProperty(`--diffs-column-content-width`,`${n>0?`${n}px`:`auto`}`)}}};applyNewHeight(e,t){t!==e.currentHeight&&(e.currentHeight=Math.max(t,0),e.column1.container.style.setProperty(`--diffs-annotation-min-height`,`${e.currentHeight}px`),e.column2.container.style.setProperty(`--diffs-annotation-min-height`,`${e.currentHeight}px`))}};function He(e){let t=Math.max(Math.floor(e),0);return t===0?`auto`:t}function Ue(e){return Math.max(Math.ceil(e),0)}function We(e){e.codeElement.isConnected&&(e.codeElement.style.removeProperty(`--diffs-column-content-width`),e.codeElement.style.removeProperty(`--diffs-column-number-width`),e.codeElement.style.removeProperty(`--diffs-column-width`))}function Ge(e){e.column1.container.isConnected&&e.column1.container.style.removeProperty(`--diffs-annotation-min-height`),e.column2.container.isConnected&&e.column2.container.style.removeProperty(`--diffs-annotation-min-height`)}var Ke=new Map,qe=new Map,Je=new Map,Ye=new Set;function Xe(e){for(let t of Array.isArray(e)?e:[e])if(!(t===`text`||t===`ansi`)&&!Ye.has(t))return!1;return!0}function Ze(e,t){e=Array.isArray(e)?e:[e];for(let n of e){if(Ye.has(n.name))continue;let e=Ke.get(n.name);e??(e=n,Ke.set(n.name,e)),Ye.add(e.name),t.loadLanguageSync(e.data)}}function Qe(){return typeof WorkerGlobalScope<`u`&&typeof self<`u`&&self instanceof WorkerGlobalScope}async function $e(e){if(Qe())throw Error(`resolveLanguage("${e}") cannot be called from a worker context. Languages must be pre-resolved on the main thread and passed to the worker via the resolvedLanguages parameter.`);let t=qe.get(e);if(t!=null)return t;try{let t=Je.get(e);if(t==null&&Object.prototype.hasOwnProperty.call(_,e)&&(t=_[e]),t==null)throw Error(`resolveLanguage: "${e}" not found in bundled or custom languages`);let n=t().then(({default:t})=>{let n={name:e,data:t};return Ke.has(e)||Ke.set(e,n),n});return qe.set(e,n),await n}finally{qe.delete(e)}}function et(e){return Ke.get(e)??$e(e)}var tt=new Set;function nt(e){let t=[],n=new Set;for(let r of rt(e.themes)){let e=ot(r)?r.getThemes():[r];for(let r of e){if(n.has(r.name))throw Error(`Theme collection already contains theme "${r.name}"`);n.add(r.name),t.push(r)}}let r=Object.freeze([...t]),i=Object.freeze(r.filter(e=>e.colorScheme===`light`)),a=Object.freeze(r.filter(e=>e.colorScheme===`dark`)),o=new Map(r.map(e=>[e.name,e])),s=Object.freeze(r.map(e=>e.name)),c=Object.freeze(i.map(e=>e.name)),l=Object.freeze(a.map(e=>e.name));function u(e){if(e==null)return r;let{colorScheme:t,collection:n}=e;return n==null?t===`light`?i:t===`dark`?a:r:r.filter(e=>e.collection===n?t==null||e.colorScheme===t:!1)}return{getTheme(e){return o.get(e)},getThemes(e){return u(e)},getThemeNames(e){return e?.collection==null?e?.colorScheme===`light`?c:e?.colorScheme===`dark`?l:s:u(e).map(e=>e.name)},hasTheme(e){return o.has(e)},orderBy(e){return nt({themes:r.map((e,t)=>({descriptor:e,index:t})).sort((t,n)=>{let r=e(t.descriptor,n.descriptor);return r===0?t.index-n.index:r}).map(e=>e.descriptor)})},pick(e){let t=[],n=new Set;for(let r of e){if(n.has(r))throw Error(`Theme collection pick already includes theme "${r}"`);n.add(r);let e=o.get(r);if(e==null)throw Error(`Theme collection does not contain theme "${r}"`);t.push(e)}return nt({themes:t})},registerInto(e){for(let t of r)e.registerThemeIfAbsent(t.name,t.load)}}}function rt(e){return it(e)?[e]:e}function it(e){return ot(e)||at(e)}function at(e){return typeof e.name==`string`&&typeof e.load==`function`}function ot(e){return typeof e.getThemes==`function`}function st(e){return typeof e==`object`&&e&&`default`in e?e.default:e}var ct=class extends Error{constructor(e){super(`Theme "${e}" is already registered`),this.name=`DuplicateThemeError`}},lt=class extends Error{constructor(e){super(`No loader registered for theme "${e}"`),this.name=`UnregisteredThemeError`}},ut=class extends Error{constructor(e){super(`Theme "${e}" has not been resolved`),this.name=`UnresolvedThemeError`}};function dt(){let e=new Map,t=new Map,n=new Map,r=0;function i(t,n){if(e.has(t))throw new ct(t);e.set(t,n)}function a(t,n){return e.has(t)?!1:(e.set(t,n),!0)}function o(t){return e.has(t)}function s(i){let a=t.get(i);if(a!==void 0)return Promise.resolve(a);let o=n.get(i);if(o!==void 0)return o;let s=e.get(i);if(s===void 0)return Promise.reject(new lt(i));let c=r,l=s().then(e=>{let a=st(e);return c===r&&t.set(i,a),n.get(i)===l&&n.delete(i),a}).catch(e=>{throw n.get(i)===l&&n.delete(i),e});return n.set(i,l),l}function c(e){return Promise.all(e.map(e=>s(e)))}function l(e,n){t.set(e,n)}function u(e){for(let[t,n]of e)l(t,n)}function d(e){return t.get(e)}function f(e){let n=[];for(let r of e){let e=t.get(r);if(e===void 0)throw new ut(r);n.push(e)}return n}function p(e){return t.has(e)}function m(e){for(let n of e)if(!t.has(n))return!1;return!0}function h(e){let n=t.get(e);return n===void 0?s(e):n}function g(){r++,t.clear(),n.clear()}return{clearResolvedThemes:g,getResolvedOrResolveTheme:h,getResolvedTheme:d,getResolvedThemes:f,hasRegisteredTheme:o,hasResolvedTheme:p,hasResolvedThemes:m,registerTheme:i,registerThemeIfAbsent:a,resolveTheme:s,resolveThemes:c,seedResolvedTheme:l,seedResolvedThemes:u}}var z=dt();function ft(e,t){e=Array.isArray(e)?e:[e];for(let n of e){let e;if(typeof n==`string`){if(e=z.getResolvedTheme(n),e==null)throw Error(`loadResolvedThemes: ${n} is not resolved, you must resolve it before calling loadResolvedThemes`)}else e=n,n=n.name,z.getResolvedTheme(n)??z.seedResolvedTheme(n,e);tt.has(n)||(tt.add(n),t.loadThemeSync(e))}}function pt({name:e,load:t,colorScheme:n,collection:r,displayName:i}){return{name:e,colorScheme:n,collection:r,displayName:i,load:mt(t)}}function mt(e){return async()=>g(st(await e()))}var ht=`pierre`,gt=[`pierre-dark`,`pierre-dark-soft`,`pierre-dark-vibrant`,`pierre-dark-protanopia-deuteranopia`,`pierre-dark-tritanopia`],_t=[`pierre-light`,`pierre-light-soft`,`pierre-light-vibrant`,`pierre-light-protanopia-deuteranopia`,`pierre-light-tritanopia`],vt=[..._t,...gt],yt=new Set(_t);function bt(e){return yt.has(e)?`light`:`dark`}var xt={"pierre-dark":`Pierre Dark`,"pierre-dark-soft":`Pierre Dark Soft`,"pierre-dark-vibrant":`Pierre Dark Vibrant`,"pierre-dark-protanopia-deuteranopia":`Pierre Dark Protanopia & Deuteranopia`,"pierre-dark-tritanopia":`Pierre Dark Tritanopia`,"pierre-light":`Pierre Light`,"pierre-light-soft":`Pierre Light Soft`,"pierre-light-vibrant":`Pierre Light Vibrant`,"pierre-light-protanopia-deuteranopia":`Pierre Light Protanopia & Deuteranopia`,"pierre-light-tritanopia":`Pierre Light Tritanopia`},St={"pierre-dark":()=>i(()=>import(`./pierre-dark-CLu9zc_X.js`),[]),"pierre-dark-soft":()=>i(()=>import(`./pierre-dark-soft-DJHdps8P.js`),[]),"pierre-dark-vibrant":()=>i(()=>import(`./pierre-dark-vibrant-CYHuOS09.js`),[]),"pierre-dark-protanopia-deuteranopia":()=>i(()=>import(`./pierre-dark-protanopia-deuteranopia-RUuTFddZ.js`),[]),"pierre-dark-tritanopia":()=>i(()=>import(`./pierre-dark-tritanopia-Cc3c3_6E.js`),[]),"pierre-light":()=>i(()=>import(`./pierre-light-CgDa4wPH.js`),[]),"pierre-light-soft":()=>i(()=>import(`./pierre-light-soft-Cx2RMwZJ.js`),[]),"pierre-light-vibrant":()=>i(()=>import(`./pierre-light-vibrant-B8dXsvkW.js`),[]),"pierre-light-protanopia-deuteranopia":()=>i(()=>import(`./pierre-light-protanopia-deuteranopia-CK33y42o.js`),[]),"pierre-light-tritanopia":()=>i(()=>import(`./pierre-light-tritanopia-CTANsgtT.js`),[])};function Ct(e){return pt({name:e,collection:ht,colorScheme:bt(e),displayName:xt[e],load:St[e]})}var wt=nt({themes:vt.map(e=>Ct(e))}),Tt=`shiki`,Et=[`ayu-light`,`catppuccin-latte`,`everforest-light`,`github-light`,`github-light-default`,`github-light-high-contrast`,`gruvbox-light-hard`,`gruvbox-light-medium`,`gruvbox-light-soft`,`horizon-bright`,`kanagawa-lotus`,`light-plus`,`material-theme-lighter`,`min-light`,`night-owl-light`,`one-light`,`rose-pine-dawn`,`slack-ochin`,`snazzy-light`,`solarized-light`,`vitesse-light`],Dt=`andromeeda.aurora-x.ayu-dark.ayu-mirage.catppuccin-frappe.catppuccin-macchiato.catppuccin-mocha.dark-plus.dracula.dracula-soft.everforest-dark.github-dark.github-dark-default.github-dark-dimmed.github-dark-high-contrast.gruvbox-dark-hard.gruvbox-dark-medium.gruvbox-dark-soft.horizon.houston.kanagawa-dragon.kanagawa-wave.laserwave.material-theme.material-theme-darker.material-theme-ocean.material-theme-palenight.min-dark.monokai.night-owl.nord.one-dark-pro.plastic.poimandres.red.rose-pine.rose-pine-moon.slack-dark.solarized-dark.synthwave-84.tokyo-night.vesper.vitesse-black.vitesse-dark`.split(`.`),Ot=new Set(Et);function kt(e){return Ot.has(e)?`light`:`dark`}var At={andromeeda:()=>i(()=>import(`./andromeeda-BYCS_bDf.js`),[]),"aurora-x":()=>i(()=>import(`./aurora-x-OPnRSRw9.js`),[]),"ayu-dark":()=>i(()=>import(`./ayu-dark-2cs5bGze.js`),[]),"ayu-light":()=>i(()=>import(`./ayu-light-D3wiuAeL.js`),[]),"ayu-mirage":()=>i(()=>import(`./ayu-mirage-BC6kWM_L.js`),[]),"catppuccin-frappe":()=>i(()=>import(`./catppuccin-frappe-chtEVuoL.js`),[]),"catppuccin-latte":()=>i(()=>import(`./catppuccin-latte-B1lrlvKq.js`),[]),"catppuccin-macchiato":()=>i(()=>import(`./catppuccin-macchiato-Ci307xGc.js`),[]),"catppuccin-mocha":()=>i(()=>import(`./catppuccin-mocha-BDUUTPBb.js`),[]),"dark-plus":()=>i(()=>import(`./dark-plus-BRVobPG7.js`),[]),dracula:()=>i(()=>import(`./dracula-CJ0K_gtd.js`),[]),"dracula-soft":()=>i(()=>import(`./dracula-soft-CFSSiFKc.js`),[]),"everforest-dark":()=>i(()=>import(`./everforest-dark-_6gJOdoe.js`),[]),"everforest-light":()=>i(()=>import(`./everforest-light-6YZEZoAQ.js`),[]),"github-dark":()=>i(()=>import(`./github-dark-DjrdUdlM.js`),[]),"github-dark-default":()=>i(()=>import(`./github-dark-default-CL3l4qG0.js`),[]),"github-dark-dimmed":()=>i(()=>import(`./github-dark-dimmed-Dn5NuOzJ.js`),[]),"github-dark-high-contrast":()=>i(()=>import(`./github-dark-high-contrast-DNS7hCqj.js`),[]),"github-light":()=>i(()=>import(`./github-light-BnTc8NS-.js`),[]),"github-light-default":()=>i(()=>import(`./github-light-default-Cl7cQm-E.js`),[]),"github-light-high-contrast":()=>i(()=>import(`./github-light-high-contrast-C7S6a0gg.js`),[]),"gruvbox-dark-hard":()=>i(()=>import(`./gruvbox-dark-hard-BkjiiWci.js`),[]),"gruvbox-dark-medium":()=>i(()=>import(`./gruvbox-dark-medium-BYR1FkBT.js`),[]),"gruvbox-dark-soft":()=>i(()=>import(`./gruvbox-dark-soft-Bpq_TvSi.js`),[]),"gruvbox-light-hard":()=>i(()=>import(`./gruvbox-light-hard-DWcyiDGj.js`),[]),"gruvbox-light-medium":()=>i(()=>import(`./gruvbox-light-medium-DN1NQxrD.js`),[]),"gruvbox-light-soft":()=>i(()=>import(`./gruvbox-light-soft-CiHdUZnQ.js`),[]),horizon:()=>i(()=>import(`./horizon-BnfoVIK1.js`),[]),"horizon-bright":()=>i(()=>import(`./horizon-bright-BPyCUZOC.js`),[]),houston:()=>i(()=>import(`./houston-Dn3tL9SV.js`),[]),"kanagawa-dragon":()=>i(()=>import(`./kanagawa-dragon-Bi4mKfFK.js`),[]),"kanagawa-lotus":()=>i(()=>import(`./kanagawa-lotus-CdN86-8g.js`),[]),"kanagawa-wave":()=>i(()=>import(`./kanagawa-wave-CpFkcnDP.js`),[]),laserwave:()=>i(()=>import(`./laserwave-DxAS_be2.js`),[]),"light-plus":()=>i(()=>import(`./light-plus-L6fjWH9O.js`),[]),"material-theme":()=>i(()=>import(`./material-theme-BtSdpajG.js`),[]),"material-theme-darker":()=>i(()=>import(`./material-theme-darker-D51Pqih7.js`),[]),"material-theme-lighter":()=>i(()=>import(`./material-theme-lighter-y0_k3y1N.js`),[]),"material-theme-ocean":()=>i(()=>import(`./material-theme-ocean-BJkGOFY9.js`),[]),"material-theme-palenight":()=>i(()=>import(`./material-theme-palenight-Cr-Oy1u_.js`),[]),"min-dark":()=>i(()=>import(`./min-dark-DzGN-kHj.js`),[]),"min-light":()=>i(()=>import(`./min-light-DXMxCAek.js`),[]),monokai:()=>i(()=>import(`./monokai-BcbA8_5l.js`),[]),"night-owl":()=>i(()=>import(`./night-owl-CSXfYcbU.js`),[]),"night-owl-light":()=>i(()=>import(`./night-owl-light-BeNRJVu-.js`),[]),nord:()=>i(()=>import(`./nord-CspLva_O.js`),[]),"one-dark-pro":()=>i(()=>import(`./one-dark-pro-DV-kAzU0.js`),[]),"one-light":()=>i(()=>import(`./one-light-DFBmQXTx.js`),[]),plastic:()=>i(()=>import(`./plastic-CGYkjiwj.js`),[]),poimandres:()=>i(()=>import(`./poimandres-Boka1awd.js`),[]),red:()=>i(()=>import(`./red-DVS2UiZC.js`),[]),"rose-pine":()=>i(()=>import(`./rose-pine-BMt6Gvqo.js`),[]),"rose-pine-dawn":()=>i(()=>import(`./rose-pine-dawn-C2-VH0b8.js`),[]),"rose-pine-moon":()=>i(()=>import(`./rose-pine-moon-B7HjgxkD.js`),[]),"slack-dark":()=>i(()=>import(`./slack-dark-CxVN588I.js`),[]),"slack-ochin":()=>i(()=>import(`./slack-ochin-ULYwDBjQ.js`),[]),"snazzy-light":()=>i(()=>import(`./snazzy-light-CgF1tfzc.js`),[]),"solarized-dark":()=>i(()=>import(`./solarized-dark-C2KLNcyW.js`),[]),"solarized-light":()=>i(()=>import(`./solarized-light-D2-oRn9c.js`),[]),"synthwave-84":()=>i(()=>import(`./synthwave-84-DHiF0sxg.js`),[]),"tokyo-night":()=>i(()=>import(`./tokyo-night-CMMZlzFG.js`),[]),vesper:()=>i(()=>import(`./vesper-CQDBXfcz.js`),[]),"vitesse-black":()=>i(()=>import(`./vitesse-black-BfkTww4W.js`),[]),"vitesse-dark":()=>i(()=>import(`./vitesse-dark-Cjbw86ta.js`),[]),"vitesse-light":()=>i(()=>import(`./vitesse-light-DfLyAJ81.js`),[])};function jt(e){return pt({name:e,collection:Tt,colorScheme:kt(e),load:At[e]})}var Mt=nt({themes:Object.freeze([...Et.map(e=>jt(e)),...Dt.map(e=>jt(e))])});function Nt(e){if(Qe())throw Error(`Theme "${e}" cannot be resolved from a worker context. Themes must be pre-resolved on the main thread and passed to the worker via the resolvedLanguages parameter.`);if(z.hasRegisteredTheme(e))return;let t=Mt.getTheme(e);if(t!=null){z.registerThemeIfAbsent(t.name,t.load);return}throw Error(`No valid theme loader registered for "${e}"`)}function Pt(e,t){if(t.name!==e)throw Error(`resolvedTheme: themeName: ${e} does not match theme.name: ${t.name}`)}async function Ft(e){Nt(e);let t=await z.resolveTheme(e);return Pt(e,t),t}function It(e){return z.getResolvedTheme(e)??Ft(e)}var B;async function Lt({themes:e,langs:t,preferredHighlighter:n=`shiki-js`}){B??=v({themes:[],langs:[`text`],engine:n===`shiki-wasm`?y(i(()=>import(`./wasm-BmNyO2tI.js`),[])):b()});let r=zt(B)?await B:B;B=r;let a=[];for(let e of t){if(e===`text`||e===`ansi`)continue;let t=et(e);`then`in t?a.push(t):Ze(t,r)}let o=[];for(let t of e){let e=It(t);`then`in e?o.push(e):ft(e,B)}return(a.length>0||o.length>0)&&await Promise.all([Promise.all(a).then(e=>{Ze(e,r)}),Promise.all(o).then(e=>{ft(e,r)})]),r}function Rt(){if(B!=null&&!(`then`in B))return B}function zt(e=B){return e!=null&&`then`in e}for(let e of wt.getThemes())z.registerThemeIfAbsent(e.name,e.load);function Bt(e=P){let t=[];return typeof e==`string`?t.push(e):(t.push(e.dark),t.push(e.light)),t}function Vt(e){for(let t of Bt(e))if(!tt.has(t))return!1;return!0}function Ht(e,t){return e?.cacheKey===t?.cacheKey&&e?.contents===t?.contents&&e?.name===t?.name&&e?.lang===t?.lang}function Ut(e,t){return e==null||t==null?e===t:e.startingLine===t.startingLine&&e.totalLines===t.totalLines&&e.bufferBefore===t.bufferBefore&&e.bufferAfter===t.bufferAfter}function Wt(e){return I({tagName:`div`,children:[I({tagName:`div`,children:e.annotations?.map(e=>I({tagName:`slot`,properties:{name:e}})),properties:{"data-annotation-content":``}})],properties:{"data-line-annotation":`${e.hunkIndex},${e.lineIndex}`}})}function Gt(e){switch(e){case`file`:return`diffs-icon-file-code`;case`change`:return`diffs-icon-symbol-modified`;case`new`:return`diffs-icon-symbol-added`;case`deleted`:return`diffs-icon-symbol-deleted`;case`rename-pure`:case`rename-changed`:return`diffs-icon-symbol-moved`}}function Kt({fileOrDiff:e,mode:t,stickyHeader:n}){let r=`type`in e?e:void 0,i={"data-diffs-header":t,"data-change-type":r?.type,"data-sticky":n?``:void 0};return I({tagName:`div`,children:[t===`custom`?I({tagName:`slot`,properties:{name:ne}}):qt({name:e.name,prevName:`prevName`in e?e.prevName:void 0,iconType:r?.type??`file`}),...t===`custom`?[]:[Jt(r)]],properties:i})}function qt({name:e,prevName:t,iconType:n}){let r=[I({tagName:`slot`,properties:{name:ee}}),_e({name:Gt(n),properties:{"data-change-icon":n}})];return t!=null&&(r.push(I({tagName:`div`,children:[I({tagName:`bdi`,children:[F(t)]})],properties:{"data-prev-name":``}})),r.push(_e({name:`diffs-icon-arrow-right-short`,properties:{"data-rename-icon":``}}))),r.push(I({tagName:`div`,children:[I({tagName:`bdi`,children:[F(e)]})],properties:{"data-title":``}})),I({tagName:`div`,children:r,properties:{"data-header-content":``}})}function Jt(e){let t=[];if(e!=null){let n=0,r=0;for(let t of e.hunks)n+=t.additionLines,r+=t.deletionLines;(r>0||n===0)&&t.push(I({tagName:`span`,children:[F(`-${r}`)],properties:{"data-deletions-count":``}})),(n>0||r===0)&&t.push(I({tagName:`span`,children:[F(`+${n}`)],properties:{"data-additions-count":``}}))}return t.push(I({tagName:`slot`,properties:{name:te}})),I({tagName:`div`,children:t,properties:{"data-metadata":``}})}function Yt(e){return I({tagName:`pre`,properties:Xt(e)})}function Xt({diffIndicators:e,disableBackground:t,disableLineNumbers:n,overflow:r,split:i,totalLines:a,type:o,customProperties:s}){return{...s,"data-diff":o===`diff`?``:void 0,"data-file":o===`file`?``:void 0,"data-diff-type":o===`diff`?i?`split`:`single`:void 0,"data-overflow":r,"data-disable-line-numbers":n?``:void 0,"data-background":t?void 0:``,"data-indicators":e===`bars`||e===`classic`?e:void 0,style:`--diffs-min-number-column-width-default:${`${a}`.length}ch;`}}var V=new Map,Zt={"1c":`1c`,abap:`abap`,as:`actionscript-3`,ada:`ada`,adb:`ada`,ads:`ada`,adoc:`asciidoc`,asciidoc:`asciidoc`,"component.html":`angular-html`,"component.ts":`angular-ts`,conf:`nginx`,htaccess:`apache`,cls:`tex`,trigger:`apex`,apl:`apl`,applescript:`applescript`,scpt:`applescript`,ara:`ara`,asm:`asm`,s:`riscv`,astro:`astro`,awk:`awk`,bal:`ballerina`,sh:`zsh`,bash:`zsh`,bat:`cmd`,cmd:`cmd`,be:`berry`,beancount:`beancount`,bib:`bibtex`,bicep:`bicep`,"blade.php":`blade`,bsl:`bsl`,c:`c`,h:`objective-cpp`,cs:`csharp`,cpp:`cpp`,hpp:`cpp`,cc:`cpp`,cxx:`cpp`,hh:`cpp`,cdc:`cdc`,cairo:`cairo`,clar:`clarity`,clj:`clojure`,cljs:`clojure`,cljc:`clojure`,soy:`soy`,cmake:`cmake`,"CMakeLists.txt":`cmake`,cob:`cobol`,cbl:`cobol`,cobol:`cobol`,CODEOWNERS:`codeowners`,ql:`ql`,coffee:`coffeescript`,lisp:`lisp`,cl:`lisp`,lsp:`lisp`,log:`log`,v:`verilog`,cql:`cql`,cr:`crystal`,css:`css`,csv:`csv`,cue:`cue`,cypher:`cypher`,cyp:`cypher`,d:`d`,dart:`dart`,dax:`dax`,desktop:`desktop`,diff:`diff`,patch:`diff`,Dockerfile:`dockerfile`,dockerfile:`dockerfile`,env:`dotenv`,dm:`dream-maker`,edge:`edge`,el:`emacs-lisp`,ex:`elixir`,exs:`elixir`,elm:`elm`,erb:`erb`,erl:`erlang`,hrl:`erlang`,f:`fortran-fixed-form`,for:`fortran-fixed-form`,fs:`fsharp`,fsi:`fsharp`,fsx:`fsharp`,f03:`f03`,f08:`f08`,f18:`f18`,f77:`f77`,f90:`fortran-free-form`,f95:`fortran-free-form`,fnl:`fennel`,fish:`fish`,ftl:`ftl`,tres:`gdresource`,res:`gdresource`,gd:`gdscript`,gdshader:`gdshader`,gs:`genie`,feature:`gherkin`,COMMIT_EDITMSG:`git-commit`,"git-rebase-todo":`git-rebase`,gjs:`glimmer-js`,gleam:`gleam`,gts:`glimmer-ts`,glsl:`glsl`,vert:`glsl`,frag:`glsl`,shader:`shaderlab`,gp:`gnuplot`,plt:`gnuplot`,gnuplot:`gnuplot`,go:`go`,graphql:`graphql`,gql:`graphql`,groovy:`groovy`,gvy:`groovy`,hack:`hack`,haml:`haml`,hbs:`handlebars`,handlebars:`handlebars`,hs:`haskell`,lhs:`haskell`,hx:`haxe`,hcl:`hcl`,hjson:`hjson`,hlsl:`hlsl`,fx:`hlsl`,html:`html`,htm:`html`,http:`http`,rest:`http`,hxml:`hxml`,hy:`hy`,imba:`imba`,ini:`ini`,cfg:`ini`,jade:`pug`,pug:`pug`,java:`java`,js:`javascript`,mjs:`javascript`,cjs:`javascript`,jinja:`jinja`,jinja2:`jinja`,j2:`jinja`,jison:`jison`,jl:`julia`,json:`json`,json5:`json5`,jsonc:`jsonc`,jsonl:`jsonl`,jsonnet:`jsonnet`,libsonnet:`jsonnet`,jssm:`jssm`,jsx:`jsx`,kt:`kotlin`,kts:`kts`,kql:`kusto`,tex:`tex`,ltx:`tex`,lean:`lean4`,less:`less`,liquid:`liquid`,lit:`lit`,ll:`llvm`,logo:`logo`,lua:`lua`,luau:`luau`,Makefile:`makefile`,mk:`makefile`,makefile:`makefile`,md:`markdown`,markdown:`markdown`,marko:`marko`,m:`wolfram`,mat:`matlab`,mdc:`mdc`,mdx:`mdx`,wiki:`wikitext`,mediawiki:`wikitext`,mmd:`mermaid`,mermaid:`mermaid`,mips:`mipsasm`,mojo:`mojo`,"🔥":`mojo`,move:`move`,nar:`narrat`,nf:`nextflow`,nim:`nim`,nims:`nim`,nimble:`nim`,nix:`nix`,nu:`nushell`,mm:`objective-cpp`,ml:`ocaml`,mli:`ocaml`,mll:`ocaml`,mly:`ocaml`,pas:`pascal`,p:`pascal`,pl:`prolog`,pm:`perl`,t:`perl`,raku:`raku`,p6:`raku`,pl6:`raku`,php:`php`,phtml:`php`,pls:`plsql`,sql:`sql`,po:`po`,polar:`polar`,pcss:`postcss`,pot:`pot`,potx:`potx`,pq:`powerquery`,pqm:`powerquery`,ps1:`powershell`,psm1:`powershell`,psd1:`powershell`,prisma:`prisma`,pro:`prolog`,P:`prolog`,properties:`properties`,proto:`protobuf`,pp:`puppet`,purs:`purescript`,py:`python`,pyw:`python`,pyi:`python`,qml:`qml`,qmldir:`qmldir`,qss:`qss`,r:`r`,R:`r`,rkt:`racket`,rktl:`racket`,razor:`razor`,cshtml:`razor`,rb:`ruby`,rbw:`ruby`,reg:`reg`,regex:`regexp`,rel:`rel`,rs:`rust`,rst:`rst`,rake:`ruby`,gemspec:`ruby`,jbuilder:`ruby`,builder:`ruby`,rabl:`ruby`,arb:`ruby`,ru:`ruby`,podspec:`ruby`,Gemfile:`ruby`,Rakefile:`ruby`,Guardfile:`ruby`,Capfile:`ruby`,Berksfile:`ruby`,Brewfile:`ruby`,Vagrantfile:`ruby`,Thorfile:`ruby`,Appraisals:`ruby`,Dangerfile:`ruby`,sas:`sas`,sass:`sass`,scala:`scala`,sc:`scala`,scm:`scheme`,ss:`scheme`,sld:`scheme`,scss:`scss`,sdbl:`sdbl`,shadergraph:`shader`,st:`smalltalk`,sol:`solidity`,sparql:`sparql`,rq:`sparql`,spl:`splunk`,config:`ssh-config`,do:`stata`,ado:`stata`,dta:`stata`,styl:`stylus`,stylus:`stylus`,svelte:`svelte`,swift:`swift`,sv:`system-verilog`,svh:`system-verilog`,service:`systemd`,socket:`systemd`,device:`systemd`,timer:`systemd`,talon:`talonscript`,tasl:`tasl`,tcl:`tcl`,templ:`templ`,tf:`tf`,tfvars:`tfvars`,toml:`toml`,ts:`typescript`,tsp:`typespec`,tsv:`tsv`,tsx:`tsx`,ttl:`turtle`,twig:`twig`,typ:`typst`,vv:`v`,vala:`vala`,vapi:`vala`,vb:`vb`,vbs:`vb`,bas:`vb`,vh:`verilog`,vhd:`vhdl`,vhdl:`vhdl`,vim:`vimscript`,vue:`vue`,"vine.ts":`vue-vine`,vy:`vyper`,wasm:`wasm`,wat:`wasm`,wy:`文言`,wgsl:`wgsl`,wit:`wit`,wl:`wolfram`,nb:`wolfram`,xml:`xml`,xsl:`xsl`,xslt:`xsl`,yaml:`yaml`,yml:`yml`,zs:`zenscript`,zig:`zig`,zsh:`zsh`,sty:`tex`};function H(e){if(V.has(e))return V.get(e)??`text`;if(Zt[e]!=null)return Zt[e];let t=e.match(/\.([^/\\]+\.[^/\\]+)$/);if(t!=null){if(V.has(t[1]))return V.get(t[1])??`text`;if(Zt[t[1]]!=null)return Zt[t[1]]??`text`}let n=e.match(/\.([^.]+)$/)?.[1]??``;return V.has(n)?V.get(n)??`text`:Zt[n]??`text`}function Qt(e,{theme:t,preferredHighlighter:n=`shiki-js`}){return{langs:[e??`text`],themes:Bt(t),preferredHighlighter:n}}function U(e){return`annotation-${`side`in e?`${e.side}-`:``}${e.lineNumber}`}function W(e){return e.replace(/\n$|\r\n$/,``)}function $t(e,t,n){let r=typeof n.lineInfo==`function`?n.lineInfo(t):n.lineInfo[t-1];if(r==null){let r=`processLine: line ${t}, contains no state.lineInfo`;throw console.error(r,{node:e,line:t,state:n}),Error(r)}return e.tagName=`div`,e.properties[`data-line`]=r.lineNumber,e.properties[`data-alt-line`]=r.altLineNumber,e.properties[`data-line-type`]=r.type,e.properties[`data-line-index`]=r.lineIndex,e.children.length===0&&e.children.push(F(`
`)),e}var en=Symbol(`no-token`),tn=Symbol(`multiple-tokens`);function nn(e){let t=rn(e);if(t!=null)return t;let n=en,r=[],i=[],a,o=()=>{if(i.length===0||a==null){i=[],a=void 0;return}if(i.length===1){let e=i[0];if(e?.type===`element`){on(e,a);for(let t of e.children)an(t)}else an(e);r.push(e),i=[],a=void 0;return}for(let e of i)an(e);r.push(I({tagName:`span`,properties:{"data-char":a},children:i})),i=[],a=void 0},s=e=>{if(e!==en){if(e===tn){n=tn;return}if(n===en){n=e;return}n!==e&&(n=tn)}};for(let t of e.children){let e=t.type===`element`?nn(t):en;if(s(e),typeof e!=`number`){o(),r.push(t);continue}a!=null&&a!==e&&o(),a??=e,i.push(t)}return o(),e.children=r,n}function rn(e){let t=e.properties[`data-char`];if(typeof t==`number`)return t}function an(e){if(e.type===`element`){e.properties[`data-char`]=void 0;for(let t of e.children)an(t)}}function on(e,t){e.properties[`data-char`]=t}function sn(e={}){let{classPrefix:t=`__shiki_`,classSuffix:n=``,classReplacer:r=e=>e}=e,i=new Map;function a(e){return Object.entries(e).map(([e,t])=>`${e}:${t}`).join(`;`)}function o(e){let o=t+cn(typeof e==`string`?e:a(e))+n;return o=r(o),i.has(o)||i.set(o,typeof e==`string`?e:{...e}),o}return{name:`@shikijs/transformers:style-to-class`,pre(e){if(!e.properties.style)return;let t=o(e.properties.style);delete e.properties.style,this.addClassToHast(e,t)},tokens(e){for(let t of e)for(let e of t){if(!e.htmlStyle)continue;let t=o(e.htmlStyle);e.htmlStyle={},e.htmlAttrs||={},e.htmlAttrs.class?e.htmlAttrs.class+=` ${t}`:e.htmlAttrs.class=t}},getClassRegistry(){return i},getCSS(){let e=``;for(let[t,n]of i.entries())e+=`.${t}{${typeof n==`string`?n:a(n)}}`;return e},clearRegistry(){i.clear()}}}function cn(e,t=0){let n=3735928559^t,r=1103547991^t;for(let t=0,i;t<e.length;t++)i=e.charCodeAt(t),n=Math.imul(n^i,2654435761),r=Math.imul(r^i,1597334677);return n=Math.imul(n^n>>>16,2246822507),n^=Math.imul(r^r>>>13,3266489909),r=Math.imul(r^r>>>16,2246822507),r^=Math.imul(n^n>>>13,3266489909),(4294967296*(2097151&r)+(n>>>0)).toString(36).slice(0,6)}function ln(e=!1,t=!1){let n={lineInfo:[]},r=[{line(e){return delete e.properties.class,e},pre(t){let r=ve(t),i=[];if(r!=null){let t=1;for(let a of r.children)a.type===`element`&&(e&&nn(a),i.push($t(a,t,n)),t++);r.children=i}return t},...e?{tokens(e){for(let t of e){let e=0;for(let n of t){let t=n;t.__lineChar??=e,e+=n.content.length}}},preprocess(e,t){t.mergeWhitespaces=`never`},span(e,t,n,r,i){if(i?.offset!=null&&i.content!=null){let t=i.__lineChar;return t!=null&&(e.properties[`data-char`]=t),e}return e}}:null}];return t&&r.push(dn,un),{state:n,transformers:r,toClass:un}}var un=sn({classPrefix:`hl-`}),dn={name:`token-style-normalizer`,tokens(e){for(let t of e)for(let e of t){if(e.htmlStyle!=null)continue;let t={};e.color!=null&&(t.color=e.color),e.bgColor!=null&&(t[`background-color`]=e.bgColor),e.fontStyle!=null&&e.fontStyle!==0&&(e.fontStyle&1&&(t[`font-style`]=`italic`),e.fontStyle&2&&(t[`font-weight`]=`bold`),e.fontStyle&4&&(t[`text-decoration`]=`underline`)),Object.keys(t).length>0&&(e.htmlStyle=t)}}};function G(e){return`--${e===`token`?`diffs-token`:`diffs`}-`}var fn=/^#(?:[0-9a-f]{3}0|[0-9a-f]{6}00)$/i,pn=/^0(?:\.0+)?%?$/;function mn(e){let t=e.indexOf(`(`);if(t<=0||!e.endsWith(`)`))return;let n=e.slice(0,t).trim();if(!/^(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)$/i.test(n))return;let r=e.slice(t+1,-1).trim();if(r.length===0)return;let i=r.lastIndexOf(`/`);if(i!==-1)return r.slice(i+1).trim();if(/^(?:rgba|hsla)$/i.test(n)){let e=r.split(`,`);if(e.length===4)return e[3]?.trim()}}function hn(e){let t=/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})\b/i.exec(e.trim());if(t==null)return null;let n=t[1],r,i=1;return n.length===3?r=n.split(``).map(e=>e+e).join(``):n.length===6?r=n:(r=n.slice(0,6),i=parseInt(n.slice(6,8),16)/255),[parseInt(r.slice(0,2),16),parseInt(r.slice(2,4),16),parseInt(r.slice(4,6),16),i]}function gn(e){if(e==null)return null;let t=hn(e);if(t==null)return null;let n=t[0]/255,r=t[1]/255,i=t[2]/255,a=e=>e<=.03928?e/12.92:((e+.055)/1.055)**2.4;return .2126*a(n)+.7152*a(r)+.0722*a(i)}function _n(e){if(e==null)return!1;let t=e.trim().toLowerCase();if(t===`transparent`||fn.test(t))return!0;let n=mn(t);return n!=null&&pn.test(n)}function vn(e,t,n){if(t==null||n==null)return!1;let r=gn(e),i=gn(t),a=gn(n);return r==null||i==null||a==null?!1:Math.abs(r-a)<Math.abs(r-i)}var yn=new WeakMap;function bn(e){let t=yn.get(e);if(t!=null)return t;let n=e.colors??{},r={...n},i=n[`editor.background`]??e.bg,a=n[`editor.foreground`]??e.fg,o=n[`sideBar.background`]??i,s=n[`sideBar.foreground`]??a;K(r,`editor.background`,i),K(r,`editor.foreground`,a),K(r,`sideBar.background`,o),K(r,`sideBar.foreground`,s),K(r,`input.background`,n[`input.background`]??o),K(r,`sideBarSectionHeader.foreground`,n[`sideBarSectionHeader.foreground`]??s),K(r,`list.activeSelectionForeground`,n[`list.activeSelectionForeground`]??s),K(r,`gitDecoration.addedResourceForeground`,xn(n[`gitDecoration.addedResourceForeground`],n[`terminal.ansiGreen`],n[`editorGutter.addedBackground`])),K(r,`gitDecoration.modifiedResourceForeground`,xn(n[`gitDecoration.modifiedResourceForeground`],n[`terminal.ansiBlue`],n[`editorGutter.modifiedBackground`])),K(r,`gitDecoration.deletedResourceForeground`,xn(n[`gitDecoration.deletedResourceForeground`],n[`terminal.ansiRed`],n[`editorGutter.deletedBackground`]));let c=(_n(n[`list.focusOutline`])?void 0:n[`list.focusOutline`])??(_n(n.focusBorder)?void 0:n.focusBorder);c==null?delete r[`list.focusOutline`]:r[`list.focusOutline`]=c;let l=n[`list.hoverBackground`];l!=null&&(Sn(l,o)||vn(l,o,s))&&delete r[`list.hoverBackground`];let u=Object.freeze({...e,colors:Object.freeze(r)});return yn.set(e,u),u}function K(e,t,n){n!=null&&n!==``&&(e[t]=n)}function xn(...e){for(let t of e)if(t!=null&&t!==``)return t}function Sn(e,t){return t!=null&&e.toLowerCase()===t.toLowerCase()}function Cn({theme:e=P,highlighter:t,prefix:n}){let r=``;if(typeof e==`string`){let i=t.getTheme(e),a=bn(i);r+=`color:${a.fg};`,r+=`background-color:${a.bg};`,r+=`${G(`global`)}fg:${a.fg};`,r+=`${G(`global`)}bg:${a.bg};`,r+=wn(i,n)}else{let n=t.getTheme(e.dark),i=bn(n);r+=`${G(`global`)}dark:${i.fg};`,r+=`${G(`global`)}dark-bg:${i.bg};`,r+=wn(n,`dark`),n=t.getTheme(e.light),i=bn(n),r+=`${G(`global`)}light:${i.fg};`,r+=`${G(`global`)}light-bg:${i.bg};`,r+=wn(n,`light`)}return r}function wn(e,t){t=t==null?``:`${t}-`;let n=``,r=e.colors?.[`gitDecoration.addedResourceForeground`]??e.colors?.[`terminal.ansiGreen`];r!=null&&(n+=`${G(`global`)}${t}addition-color:${r};`);let i=e.colors?.[`gitDecoration.deletedResourceForeground`]??e.colors?.[`terminal.ansiRed`];i!=null&&(n+=`${G(`global`)}${t}deletion-color:${i};`);let a=e.colors?.[`gitDecoration.modifiedResourceForeground`]??e.colors?.[`terminal.ansiBlue`];return a!=null&&(n+=`${G(`global`)}${t}modified-color:${a};`),n}function Tn(e){let t=e.children[0];for(;t!=null;){if(t.type===`element`&&t.tagName===`code`)return t.children;t=`children`in t?t.children[0]:null}throw console.error(e),Error(`getLineNodes: Unable to find children`)}var En=`-1,-1`;function Dn(e){return e?.some(e=>e.lineNumber===0)??!1}function On(e){let t=e[0];return t!=null&&t.length>0?t:void 0}function kn(e){return e.startingLine===0&&e.totalLines>0}function An(e,t){return I({tagName:`div`,children:e,properties:{"data-content":``,style:`grid-row: span ${t}`}})}function jn(e){return e.useTokenTransformer===!0||e.onTokenClick!=null||e.onTokenEnter!=null||e.onTokenLeave!=null}var Mn=`<svg data-icon-sprite aria-hidden="true" width="0" height="0">
  <symbol id="diffs-icon-arrow-right-short" viewBox="0 0 16 16">
    <path d="M8.47 4.22a.75.75 0 0 0 0 1.06l1.97 1.97H3.75a.75.75 0 0 0 0 1.5h6.69l-1.97 1.97a.75.75 0 1 0 1.06 1.06l3.25-3.25a.75.75 0 0 0 0-1.06L9.53 4.22a.75.75 0 0 0-1.06 0"/>
  </symbol>
  <symbol id="diffs-icon-brand-github" viewBox="0 0 16 16">
    <path d="M8 0c4.42 0 8 3.58 8 8a8.01 8.01 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27s-1.36.09-2 .27c-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8"/>
  </symbol>
  <symbol id="diffs-icon-chevron" viewBox="0 0 16 16">
    <path d="M1.47 4.47a.75.75 0 0 1 1.06 0L8 9.94l5.47-5.47a.75.75 0 1 1 1.06 1.06l-6 6a.75.75 0 0 1-1.06 0l-6-6a.75.75 0 0 1 0-1.06"/>
  </symbol>
  <symbol id="diffs-icon-chevrons-narrow" viewBox="0 0 10 16">
    <path d="M4.47 2.22a.75.75 0 0 1 1.06 0l3.25 3.25a.75.75 0 0 1-1.06 1.06L5 3.81 2.28 6.53a.75.75 0 0 1-1.06-1.06zM1.22 9.47a.75.75 0 0 1 1.06 0L5 12.19l2.72-2.72a.75.75 0 0 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0l-3.25-3.25a.75.75 0 0 1 0-1.06"/>
  </symbol>
  <symbol id="diffs-icon-diff-split" viewBox="0 0 16 16">
    <path d="M14 0H8.5v16H14a2 2 0 0 0 2-2V2a2 2 0 0 0-2-2m-1.5 6.5v1h1a.5.5 0 0 1 0 1h-1v1a.5.5 0 0 1-1 0v-1h-1a.5.5 0 0 1 0-1h1v-1a.5.5 0 0 1 1 0"/><path d="M2 0a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5.5V0zm.5 7.5h3a.5.5 0 0 1 0 1h-3a.5.5 0 0 1 0-1" opacity=".3"/>
  </symbol>
  <symbol id="diffs-icon-diff-unified" viewBox="0 0 16 16">
    <path fill-rule="evenodd" d="M16 14a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V8.5h16zm-8-4a.5.5 0 0 0-.5.5v1h-1a.5.5 0 0 0 0 1h1v1a.5.5 0 0 0 1 0v-1h1a.5.5 0 0 0 0-1h-1v-1A.5.5 0 0 0 8 10" clip-rule="evenodd"/><path fill-rule="evenodd" d="M14 0a2 2 0 0 1 2 2v5.5H0V2a2 2 0 0 1 2-2zM6.5 3.5a.5.5 0 0 0 0 1h3a.5.5 0 0 0 0-1z" clip-rule="evenodd" opacity=".4"/>
  </symbol>
  <symbol id="diffs-icon-expand" viewBox="0 0 16 16">
    <path d="M3.47 5.47a.75.75 0 0 1 1.06 0L8 8.94l3.47-3.47a.75.75 0 1 1 1.06 1.06l-4 4a.75.75 0 0 1-1.06 0l-4-4a.75.75 0 0 1 0-1.06"/>
  </symbol>
  <symbol id="diffs-icon-expand-all" viewBox="0 0 16 16">
    <path d="M11.47 9.47a.75.75 0 1 1 1.06 1.06l-4 4a.75.75 0 0 1-1.06 0l-4-4a.75.75 0 1 1 1.06-1.06L8 12.94zM7.526 1.418a.75.75 0 0 1 1.004.052l4 4a.75.75 0 1 1-1.06 1.06L8 3.06 4.53 6.53a.75.75 0 1 1-1.06-1.06l4-4z"/>
  </symbol>
  <symbol id="diffs-icon-file-code" viewBox="0 0 16 16">
    <path d="M10.75 0c.199 0 .39.08.53.22l3.5 3.5c.14.14.22.331.22.53v9A2.75 2.75 0 0 1 12.25 16h-8.5A2.75 2.75 0 0 1 1 13.25V2.75A2.75 2.75 0 0 1 3.75 0zm-7 1.5c-.69 0-1.25.56-1.25 1.25v10.5c0 .69.56 1.25 1.25 1.25h8.5c.69 0 1.25-.56 1.25-1.25V5h-1.25A2.25 2.25 0 0 1 10 2.75V1.5z"/><path d="M7.248 6.19a.75.75 0 0 1 .063 1.058L5.753 9l1.558 1.752a.75.75 0 0 1-1.122.996l-2-2.25a.75.75 0 0 1 0-.996l2-2.25a.75.75 0 0 1 1.06-.063M8.69 7.248a.75.75 0 1 1 1.12-.996l2 2.25a.75.75 0 0 1 0 .996l-2 2.25a.75.75 0 1 1-1.12-.996L10.245 9z"/>
  </symbol>
  <symbol id="diffs-icon-plus" viewBox="0 0 16 16">
    <path d="M8 3a.75.75 0 0 1 .75.75v3.5h3.5a.75.75 0 0 1 0 1.5h-3.5v3.5a.75.75 0 0 1-1.5 0v-3.5h-3.5a.75.75 0 0 1 0-1.5h3.5v-3.5A.75.75 0 0 1 8 3"/>
  </symbol>
  <symbol id="diffs-icon-symbol-added" viewBox="0 0 16 16">
    <path d="M8 4a.75.75 0 0 1 .75.75v2.5h2.5a.75.75 0 0 1 0 1.5h-2.5v2.5a.75.75 0 0 1-1.5 0v-2.5h-2.5a.75.75 0 0 1 0-1.5h2.5v-2.5A.75.75 0 0 1 8 4"/><path d="M1.788 4.296c.196-.88.478-1.381.802-1.706s.826-.606 1.706-.802C5.194 1.588 6.387 1.5 8 1.5s2.806.088 3.704.288c.88.196 1.381.478 1.706.802s.607.826.802 1.706c.2.898.288 2.091.288 3.704s-.088 2.806-.288 3.704c-.195.88-.478 1.381-.802 1.706s-.826.607-1.706.802c-.898.2-2.091.288-3.704.288s-2.806-.088-3.704-.288c-.88-.195-1.381-.478-1.706-.802s-.606-.826-.802-1.706C1.588 10.806 1.5 9.613 1.5 8s.088-2.806.288-3.704M8 0C1.412 0 0 1.412 0 8s1.412 8 8 8 8-1.412 8-8-1.412-8-8-8"/>
  </symbol>
  <symbol id="diffs-icon-symbol-deleted" viewBox="0 0 16 16">
    <path d="M4 8a.75.75 0 0 1 .75-.75h6.5a.75.75 0 0 1 0 1.5h-6.5A.75.75 0 0 1 4 8"/><path d="M1.788 4.296c.196-.88.478-1.381.802-1.706s.826-.606 1.706-.802C5.194 1.588 6.387 1.5 8 1.5s2.806.088 3.704.288c.88.196 1.381.478 1.706.802s.607.826.802 1.706c.2.898.288 2.091.288 3.704s-.088 2.806-.288 3.704c-.195.88-.478 1.381-.802 1.706s-.826.607-1.706.802c-.898.2-2.091.288-3.704.288s-2.806-.088-3.704-.288c-.88-.195-1.381-.478-1.706-.802s-.606-.826-.802-1.706C1.588 10.806 1.5 9.613 1.5 8s.088-2.806.288-3.704M8 0C1.412 0 0 1.412 0 8s1.412 8 8 8 8-1.412 8-8-1.412-8-8-8"/>
  </symbol>
  <symbol id="diffs-icon-symbol-diffstat" viewBox="0 0 16 16">
    <path d="M1.788 4.296c.196-.88.478-1.381.802-1.706s.826-.606 1.706-.802C5.194 1.588 6.387 1.5 8 1.5s2.806.088 3.704.288c.88.196 1.381.478 1.706.802s.607.826.802 1.706c.2.898.288 2.091.288 3.704s-.088 2.806-.288 3.704c-.195.88-.478 1.381-.802 1.706s-.826.607-1.706.802c-.898.2-2.091.288-3.704.288s-2.806-.088-3.704-.288c-.88-.195-1.381-.478-1.706-.802s-.606-.826-.802-1.706C1.588 10.806 1.5 9.613 1.5 8s.088-2.806.288-3.704M8 0C1.412 0 0 1.412 0 8s1.412 8 8 8 8-1.412 8-8-1.412-8-8-8"/><path d="M8.75 4.296a.75.75 0 0 0-1.5 0V6.25h-2a.75.75 0 0 0 0 1.5h2v1.5h1.5v-1.5h2a.75.75 0 0 0 0-1.5h-2zM5.25 10a.75.75 0 0 0 0 1.5h5.5a.75.75 0 0 0 0-1.5z"/>
  </symbol>
  <symbol id="diffs-icon-symbol-ignored" viewBox="0 0 16 16">
    <path d="M1.5 8c0 1.613.088 2.806.288 3.704.196.88.478 1.381.802 1.706s.826.607 1.706.802c.898.2 2.091.288 3.704.288s2.806-.088 3.704-.288c.88-.195 1.381-.478 1.706-.802s.607-.826.802-1.706c.2-.898.288-2.091.288-3.704s-.088-2.806-.288-3.704c-.195-.88-.478-1.381-.802-1.706s-.826-.606-1.706-.802C10.806 1.588 9.613 1.5 8 1.5s-2.806.088-3.704.288c-.88.196-1.381.478-1.706.802s-.606.826-.802 1.706C1.588 5.194 1.5 6.387 1.5 8M0 8c0-6.588 1.412-8 8-8s8 1.412 8 8-1.412 8-8 8-8-1.412-8-8m11.53-2.47a.75.75 0 0 0-1.06-1.06l-6 6a.75.75 0 1 0 1.06 1.06z"/>
  </symbol>
  <symbol id="diffs-icon-symbol-modified" viewBox="0 0 16 16">
    <path d="M1.5 8c0 1.613.088 2.806.288 3.704.196.88.478 1.381.802 1.706s.826.607 1.706.802c.898.2 2.091.288 3.704.288s2.806-.088 3.704-.288c.88-.195 1.381-.478 1.706-.802s.607-.826.802-1.706c.2-.898.288-2.091.288-3.704s-.088-2.806-.288-3.704c-.195-.88-.478-1.381-.802-1.706s-.826-.606-1.706-.802C10.806 1.588 9.613 1.5 8 1.5s-2.806.088-3.704.288c-.88.196-1.381.478-1.706.802s-.606.826-.802 1.706C1.588 5.194 1.5 6.387 1.5 8M0 8c0-6.588 1.412-8 8-8s8 1.412 8 8-1.412 8-8 8-8-1.412-8-8m8 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6"/>
  </symbol>
  <symbol id="diffs-icon-symbol-moved" viewBox="0 0 16 16">
    <path d="M1.788 4.296c.196-.88.478-1.381.802-1.706s.826-.606 1.706-.802C5.194 1.588 6.387 1.5 8 1.5s2.806.088 3.704.288c.88.196 1.381.478 1.706.802s.607.826.802 1.706c.2.898.288 2.091.288 3.704s-.088 2.806-.288 3.704c-.195.88-.478 1.381-.802 1.706s-.826.607-1.706.802c-.898.2-2.091.288-3.704.288s-2.806-.088-3.704-.288c-.88-.195-1.381-.478-1.706-.802s-.606-.826-.802-1.706C1.588 10.806 1.5 9.613 1.5 8s.088-2.806.288-3.704M8 0C1.412 0 0 1.412 0 8s1.412 8 8 8 8-1.412 8-8-1.412-8-8-8"/><path d="M8.495 4.695a.75.75 0 0 0-.05 1.06L10.486 8l-2.041 2.246a.75.75 0 0 0 1.11 1.008l2.5-2.75a.75.75 0 0 0 0-1.008l-2.5-2.75a.75.75 0 0 0-1.06-.051m-4 0a.75.75 0 0 0-.05 1.06l2.044 2.248-1.796 1.995a.75.75 0 0 0 1.114 1.004l2.25-2.5a.75.75 0 0 0-.002-1.007l-2.5-2.75a.75.75 0 0 0-1.06-.05"/>
  </symbol>
  <symbol id="diffs-icon-symbol-ref" viewBox="0 0 16 16">
    <path d="M1.5 8c0 1.613.088 2.806.288 3.704.196.88.478 1.381.802 1.706.286.286.71.54 1.41.73V1.86c-.7.19-1.124.444-1.41.73-.324.325-.606.826-.802 1.706C1.588 5.194 1.5 6.387 1.5 8m4 6.397c.697.07 1.522.103 2.5.103 1.613 0 2.806-.088 3.704-.288.88-.195 1.381-.478 1.706-.802s.607-.826.802-1.706c.2-.898.288-2.091.288-3.704s-.088-2.806-.288-3.704c-.195-.88-.478-1.381-.802-1.706s-.826-.606-1.706-.802C10.806 1.588 9.613 1.5 8 1.5c-.978 0-1.803.033-2.5.103zM0 8c0-6.588 1.412-8 8-8s8 1.412 8 8-1.412 8-8 8-8-1.412-8-8m7-2a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1z"/>
  </symbol>
</svg>`;function Nn(e,t){return e==null||t==null?e===t:Fn(e.customProperties,t.customProperties)&&e.type===t.type&&e.diffIndicators===t.diffIndicators&&e.disableBackground===t.disableBackground&&e.disableLineNumbers===t.disableLineNumbers&&e.overflow===t.overflow&&e.split===t.split&&e.totalLines===t.totalLines}var Pn={};function Fn(e=Pn,t=Pn){if(e===t)return!0;let n=Object.keys(e),r=Object.keys(t);if(n.length!==r.length)return!1;for(let r of n)if(e[r]!==t[r])return!1;return!0}function In(e){let t=document.createElement(`div`);return t.dataset.annotationSlot=``,t.slot=e,t.style.whiteSpace=`normal`,t}function Ln(){let e=document.createElement(`div`);return e.slot=`gutter-utility-slot`,e.style.position=`absolute`,e.style.top=`0`,e.style.bottom=`0`,e.style.textAlign=`center`,e.style.whiteSpace=`normal`,e.style.touchAction=`none`,e}function Rn(){let e=document.createElement(`style`);return e.setAttribute(ie,``),e}var zn=`@layer base {
  :host {
    --diffs-font-fallback: "SF Mono", Monaco, Consolas, "Ubuntu Mono", "Liberation Mono",
      "Courier New", monospace;
    --diffs-header-font-fallback: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue",
      "Noto Sans", "Liberation Sans", Arial, sans-serif;
    --diffs-mixer: light-dark(#000, #fff);
    --diffs-gap-fallback: 8px;
    --diffs-scrollbar-gutter-fallback: 6px;
    --diffs-scrollbar-gutter: var(--diffs-scrollbar-gutter-override, var(--diffs-scrollbar-gutter-measured, var(--diffs-scrollbar-gutter-fallback)));
    --diffs-added-light: #0dbe4e;
    --diffs-added-dark: #5ecc71;
    --diffs-modified-light: #009fff;
    --diffs-modified-dark: #69b1ff;
    --diffs-deleted-light: #ff2e3f;
    --diffs-deleted-dark: #ff6762;
    color-scheme: light dark;
    font-family: var(--diffs-header-font-family, var(--diffs-header-font-fallback));
    font-size: var(--diffs-font-size, 13px);
    line-height: var(--diffs-line-height, 20px);
    font-feature-settings: var(--diffs-font-features);
    --diffs-bg: light-dark(var(--diffs-light-bg, #fff), var(--diffs-dark-bg, #000));
    --diffs-bg-buffer: var(--diffs-bg-buffer-override, light-dark(color-mix(in lab, var(--diffs-bg) 92%, var(--diffs-mixer)), color-mix(in lab, var(--diffs-bg) 92%, var(--diffs-mixer))));
    --diffs-bg-context: var(--diffs-bg-context-override, light-dark(color-mix(in lab, var(--diffs-bg) 98.5%, var(--diffs-mixer)), color-mix(in lab, var(--diffs-bg) 92.5%, var(--diffs-mixer))));
    --diffs-bg-context-gutter: var(--diffs-bg-context-gutter-override, light-dark(color-mix(in lab, var(--diffs-bg-context) 90%, var(--diffs-bg)), color-mix(in lab, var(--diffs-bg-context) 45%, var(--diffs-bg))));
    --diffs-bg-separator: var(--diffs-bg-separator-override, light-dark(color-mix(in lab, var(--diffs-bg) 96%, var(--diffs-mixer)), color-mix(in lab, var(--diffs-bg) 85%, var(--diffs-mixer))));
    --diffs-fg: light-dark(var(--diffs-light, #000), var(--diffs-dark, #fff));
    --diffs-fg-number: var(--diffs-fg-number-override, light-dark(color-mix(in lab, var(--diffs-fg) 65%, var(--diffs-bg)), color-mix(in lab, var(--diffs-fg) 65%, var(--diffs-bg))));
    --diffs-fg-conflict-marker: var(--diffs-fg-conflict-marker-override, var(--diffs-fg-number));
    --diffs-deletion-base: var(--diffs-deletion-color-override, light-dark(var(--diffs-light-deletion-color, var(--diffs-deletion-color, var(--diffs-deleted-light))), var(--diffs-dark-deletion-color, var(--diffs-deletion-color, var(--diffs-deleted-dark)))));
    --diffs-addition-base: var(--diffs-addition-color-override, light-dark(var(--diffs-light-addition-color, var(--diffs-addition-color, var(--diffs-added-light))), var(--diffs-dark-addition-color, var(--diffs-addition-color, var(--diffs-added-dark)))));
    --diffs-modified-base: var(--diffs-modified-color-override, light-dark(var(--diffs-light-modified-color, var(--diffs-modified-color, var(--diffs-modified-light))), var(--diffs-dark-modified-color, var(--diffs-modified-color, var(--diffs-modified-dark)))));
    --diffs-bg-deletion: var(--diffs-bg-deletion-override, light-dark(color-mix(in lab, var(--diffs-bg) 88%, var(--diffs-deletion-base)), color-mix(in lab, var(--diffs-bg) 80%, var(--diffs-deletion-base))));
    --diffs-bg-deletion-emphasis: var(--diffs-bg-deletion-emphasis-override, light-dark(rgb(from var(--diffs-deletion-base) r g b / .15), rgb(from var(--diffs-deletion-base) r g b / .2)));
    --diffs-bg-addition: var(--diffs-bg-addition-override, light-dark(color-mix(in lab, var(--diffs-bg) 88%, var(--diffs-addition-base)), color-mix(in lab, var(--diffs-bg) 80%, var(--diffs-addition-base))));
    --diffs-bg-addition-emphasis: var(--diffs-bg-addition-emphasis-override, light-dark(rgb(from var(--diffs-addition-base) r g b / .15), rgb(from var(--diffs-addition-base) r g b / .2)));
    --diffs-selection-base: var(--diffs-modified-base);
    --diffs-selection-number-fg: light-dark(color-mix(in lab, var(--diffs-selection-base) 65%, var(--diffs-mixer)), color-mix(in lab, var(--diffs-selection-base) 75%, var(--diffs-mixer)));
    background-color: var(--diffs-bg);
    color: var(--diffs-fg);
    display: block;
  }

  pre, code, [data-error-wrapper] {
    isolation: isolate;
    font-family: var(--diffs-font-family, var(--diffs-font-fallback));
    outline: none;
    margin: 0;
    padding: 0;
    display: block;
  }

  pre, code {
    background-color: var(--diffs-bg);
  }

  code {
    contain: content;
  }

  *, :before, :after {
    box-sizing: border-box;
  }

  [data-icon-sprite] {
    display: none;
  }

  [data-diffs-header], [data-separator] {
    font-family: var(--diffs-header-font-family, var(--diffs-header-font-fallback));
  }

  [data-diffs-header][data-sticky] {
    z-index: 1;
    background-color: var(--diffs-bg);
    position: sticky;
    top: 0;
  }

  [data-file-info] {
    color: var(--fg);
    background-color: color-mix(in lab, var(--bg) 98%, var(--fg));
    border-block: 1px solid color-mix(in lab, var(--bg) 95%, var(--fg));
    padding: 10px;
    font-weight: 700;
  }

  [data-diff], [data-file] {
    --diffs-grid-number-column-width: minmax(min-content, max-content);
    --diffs-code-grid: var(--diffs-grid-number-column-width) 1fr;

    &[data-dehydrated] {
      --diffs-code-grid: var(--diffs-grid-number-column-width) minmax(0, 1fr);
    }

    &:hover [data-code]::-webkit-scrollbar-thumb {
      background-color: var(--diffs-bg-context);
    }
  }

  @supports (-webkit-touch-callout: none) {
    :host {
      --diffs-scrollbar-gutter-fallback: 0px;
    }
  }

  [data-line] span {
    color: light-dark(var(--diffs-token-light, var(--diffs-light)), var(--diffs-token-dark, var(--diffs-dark)));
    background-color: light-dark(var(--diffs-token-light-bg, inherit), var(--diffs-token-dark-bg, inherit));
    font-weight: light-dark(var(--diffs-token-light-font-weight, inherit), var(--diffs-token-dark-font-weight, inherit));
    font-style: light-dark(var(--diffs-token-light-font-style, inherit), var(--diffs-token-dark-font-style, inherit));
    text-decoration: light-dark(var(--diffs-token-light-text-decoration, inherit), var(--diffs-token-dark-text-decoration, inherit));
  }

  [data-line], [data-gutter-buffer], [data-column-number], [data-line-annotation], [data-no-newline], [data-merge-conflict], [data-merge-conflict-actions] {
    --diffs-computed-decoration-bg: var(--diffs-bg);
    --diffs-computed-diff-line-bg: var(--diffs-bg);
    --diffs-computed-selected-line-bg: var(--diffs-bg);
    color: var(--diffs-fg);
    background-color: var(--diffs-line-bg, var(--diffs-bg));

    @media (pointer: fine) {
      &:where([data-hovered]) {
        --diffs-computed-hovered-line-bg: light-dark(color-mix(in lab,
            var(--diffs-computed-selected-line-bg) 97%,
            var(--diffs-bg-hover-override, var(--diffs-mixer))), color-mix(in lab,
            var(--diffs-computed-selected-line-bg) 91%,
            var(--diffs-bg-hover-override, var(--diffs-mixer))));
        --diffs-line-bg: var(--diffs-computed-hovered-line-bg, inherit);
      }
    }
  }

  [data-line], [data-no-newline] {
    &[data-decoration-bg] {
      --mix-deco-light: 92%;
      --mix-deco-dark: 85%;

      &[data-decoration-bg-depth="2"] {
        --mix-deco-light: 88%;
        --mix-deco-dark: 80%;
      }

      &[data-decoration-bg-depth="3"] {
        --mix-deco-light: 85%;
        --mix-deco-dark: 78%;
      }

      @media (pointer: fine) {
        &[data-hovered]:not([data-selected-line]) {
          --mix-deco-light: 85%;
          --mix-deco-dark: 85%;
        }

        &[data-hovered]:not([data-selected-line])[data-decoration-bg-depth="2"] {
          --mix-deco-light: 83%;
          --mix-deco-dark: 83%;
        }

        &[data-hovered]:not([data-selected-line])[data-decoration-bg-depth="3"] {
          --mix-deco-light: 81%;
          --mix-deco-dark: 81%;
        }
      }

      --diffs-computed-decoration-bg: light-dark(color-mix(in lab,
          var(--diffs-bg) var(--mix-deco-light),
          var(--diffs-decoration-bg)), color-mix(in lab,
          var(--diffs-bg) var(--mix-deco-dark),
          var(--diffs-decoration-bg)));
      --diffs-computed-diff-line-bg: var(--diffs-computed-decoration-bg);
      --diffs-computed-selected-line-bg: var(--diffs-computed-decoration-bg);
      --diffs-line-bg: var(--diffs-computed-decoration-bg);
    }
  }

  [data-line-annotation], [data-gutter-buffer="annotation"] {
    --diffs-annotation-bg: var(--diffs-bg-context);
    --diffs-computed-decoration-bg: var(--diffs-annotation-bg);
    --diffs-computed-diff-line-bg: var(--diffs-annotation-bg);
    --diffs-computed-selected-line-bg: var(--diffs-annotation-bg);
    --diffs-line-bg: var(--diffs-annotation-bg);
  }

  [data-merge-conflict-actions], [data-gutter-buffer="merge-conflict-action"], [data-gutter-buffer="merge-conflict-marker-base"], [data-gutter-buffer="merge-conflict-marker-separator"], [data-merge-conflict="marker-base"], [data-merge-conflict="marker-separator"] {
    --diffs-computed-decoration-bg: var(--diffs-bg-context);
    --diffs-computed-diff-line-bg: var(--diffs-bg-context);
    --diffs-computed-selected-line-bg: var(--diffs-bg-context);
    --diffs-line-bg: var(--diffs-bg-context);
  }

  [data-gutter-buffer="merge-conflict-marker-start"], [data-merge-conflict="marker-start"] {
    --diffs-computed-decoration-bg: light-dark(color-mix(in lab,
        var(--diffs-bg) 78%,
        var(--conflict-bg-current-header-override, var(--diffs-addition-base))), color-mix(in lab,
        var(--diffs-bg) 68%,
        var(--conflict-bg-current-header-override, var(--diffs-addition-base))));
    --diffs-computed-diff-line-bg: var(--diffs-computed-decoration-bg);
    --diffs-computed-selected-line-bg: var(--diffs-computed-decoration-bg);
    --diffs-line-bg: var(--diffs-computed-decoration-bg);
  }

  [data-gutter-buffer="merge-conflict-marker-end"], [data-merge-conflict="marker-end"] {
    --diffs-computed-decoration-bg: light-dark(color-mix(in lab,
        var(--diffs-bg) 78%,
        var(--conflict-bg-incoming-header-override, var(--diffs-modified-base))), color-mix(in lab,
        var(--diffs-bg) 68%,
        var(--conflict-bg-incoming-header-override, var(--diffs-modified-base))));
    --diffs-computed-diff-line-bg: var(--diffs-computed-decoration-bg);
    --diffs-computed-selected-line-bg: var(--diffs-computed-decoration-bg);
    --diffs-line-bg: var(--diffs-computed-decoration-bg);
  }

  [data-has-merge-conflict] [data-line-annotation], [data-has-merge-conflict] [data-gutter-buffer="annotation"] {
    --diffs-computed-decoration-bg: var(--diffs-bg);
    --diffs-computed-diff-line-bg: var(--diffs-bg);
    --diffs-computed-selected-line-bg: var(--diffs-bg);
    --diffs-line-bg: var(--diffs-bg);
  }

  :where([data-background]) {
    & [data-gutter-buffer], & [data-column-number] {
      --mix-light: 91%;
      --mix-dark: 85%;
    }

    & [data-line], & [data-no-newline] {
      --mix-light: 88%;
      --mix-dark: 80%;
    }

    & [data-gutter-buffer], & [data-column-number], & [data-line], & [data-no-newline] {
      --diffs-diff-line-mix-target: var(--diffs-bg);

      &[data-line-type="change-deletion"] {
        --diffs-diff-line-mix-target: var(--diffs-bg-deletion-override, var(--diffs-deletion-base));

        @media (pointer: fine) {
          &[data-hovered] {
            --mix-light: 80%;
            --mix-dark: 75%;
          }
        }

        &:where([data-gutter-buffer], [data-column-number]) {
          color: var(--diffs-fg-number-deletion-override, var(--diffs-deletion-base));
          --diffs-diff-line-mix-target: var(--diffs-bg-deletion-number-override, var(--diffs-deletion-base));
        }

        --diffs-computed-diff-line-bg: light-dark(color-mix(in lab,
            var(--diffs-computed-decoration-bg) var(--mix-light),
            var(--diffs-diff-line-mix-target)), color-mix(in lab,
            var(--diffs-computed-decoration-bg) var(--mix-dark),
            var(--diffs-diff-line-mix-target)));
        --diffs-computed-selected-line-bg: var(--diffs-computed-diff-line-bg);
        --diffs-line-bg: var(--diffs-computed-diff-line-bg, inherit);
      }

      &[data-line-type="change-addition"] {
        --diffs-diff-line-mix-target: var(--diffs-bg-addition-override, var(--diffs-addition-base));

        @media (pointer: fine) {
          &[data-hovered] {
            --mix-light: 80%;
            --mix-dark: 70%;
          }
        }

        &:where([data-gutter-buffer], [data-column-number]) {
          color: var(--diffs-fg-number-addition-override, var(--diffs-addition-base));
          --diffs-diff-line-mix-target: var(--diffs-bg-addition-number-override, var(--diffs-addition-base));
        }

        --diffs-computed-diff-line-bg: light-dark(color-mix(in lab,
            var(--diffs-computed-decoration-bg) var(--mix-light),
            var(--diffs-diff-line-mix-target)), color-mix(in lab,
            var(--diffs-computed-decoration-bg) var(--mix-dark),
            var(--diffs-diff-line-mix-target)));
        --diffs-computed-selected-line-bg: var(--diffs-computed-diff-line-bg);
        --diffs-line-bg: var(--diffs-computed-diff-line-bg, inherit);
      }

      &[data-merge-conflict="current"] {
        --diffs-diff-line-mix-target: var(--conflict-bg-current-override, var(--diffs-addition-base));

        &:where([data-gutter-buffer], [data-column-number]) {
          color: var(--diffs-fg-number-addition-override, var(--diffs-addition-base));
          --diffs-diff-line-mix-target: var(--conflict-bg-current-number-override, var(--diffs-addition-base));
        }

        @media (pointer: fine) {
          &[data-hovered] {
            --mix-light: 80%;
            --mix-dark: 70%;
          }
        }

        --diffs-computed-diff-line-bg: light-dark(color-mix(in lab,
            var(--diffs-computed-decoration-bg) var(--mix-light),
            var(--diffs-diff-line-mix-target)), color-mix(in lab,
            var(--diffs-computed-decoration-bg) var(--mix-dark),
            var(--diffs-diff-line-mix-target)));
        --diffs-computed-selected-line-bg: var(--diffs-computed-diff-line-bg);
        --diffs-line-bg: var(--diffs-computed-diff-line-bg, inherit);
      }

      &[data-merge-conflict="incoming"] {
        --diffs-diff-line-mix-target: var(--conflict-bg-incoming-override, var(--diffs-modified-base));

        &:where([data-gutter-buffer], [data-column-number]) {
          color: var(--diffs-modified-base);
          --diffs-diff-line-mix-target: var(--conflict-bg-incoming-number-override, var(--diffs-modified-base));
        }

        @media (pointer: fine) {
          &[data-hovered] {
            --mix-light: 80%;
            --mix-dark: 70%;
          }
        }

        --diffs-computed-diff-line-bg: light-dark(color-mix(in lab,
            var(--diffs-computed-decoration-bg) var(--mix-light),
            var(--diffs-diff-line-mix-target)), color-mix(in lab,
            var(--diffs-computed-decoration-bg) var(--mix-dark),
            var(--diffs-diff-line-mix-target)));
        --diffs-computed-selected-line-bg: var(--diffs-computed-diff-line-bg);
        --diffs-line-bg: var(--diffs-computed-diff-line-bg, inherit);
      }
    }
  }

  [data-gutter-buffer], [data-column-number], [data-line], [data-line-annotation], [data-merge-conflict], [data-merge-conflict-actions], [data-no-newline] {
    --diffs-selection-mix-target: var(--diffs-bg-selection-override, var(--diffs-selection-base));

    &:where([data-line], [data-line-annotation], [data-merge-conflict], [data-merge-conflict-actions], [data-no-newline])[data-selected-line] {
      --mix-selection-light: 82%;
      --mix-selection-dark: 75%;

      @media (pointer: fine) {
        &[data-hovered]:not([data-merge-conflict], [data-line-type="change-addition"], [data-line-type="change-deletion"]) {
          --mix-selection-light: 75%;
          --mix-selection-dark: 70%;
        }
      }
    }

    &:where([data-gutter-buffer], [data-column-number])[data-selected-line] {
      --mix-selection-light: 75%;
      --mix-selection-dark: 60%;
      --diffs-selection-mix-target: var(--diffs-bg-selection-number-override, var(--diffs-selection-base));

      @media (pointer: fine) {
        &[data-hovered]:not([data-merge-conflict], [data-line-type="change-addition"], [data-line-type="change-deletion"]) {
          --mix-selection-light: 70%;
          --mix-selection-dark: 55%;
        }
      }
    }

    &[data-selected-line] {
      --diffs-computed-selected-line-bg: light-dark(color-mix(in lab,
          var(--diffs-computed-diff-line-bg) var(--mix-selection-light),
          var(--diffs-selection-mix-target)), color-mix(in lab,
          var(--diffs-computed-diff-line-bg) var(--mix-selection-dark),
          var(--diffs-selection-mix-target)));
      --diffs-line-bg: var(--diffs-computed-selected-line-bg, inherit);
    }
  }

  [data-gutter-buffer], [data-column-number] {
    &[data-selected-line] {
      color: var(--diffs-selection-number-fg);
    }
  }

  [data-no-newline] {
    user-select: none;

    & span {
      opacity: .6;
    }
  }

  [data-diff-type="split"][data-overflow="scroll"] {
    grid-template-columns: 1fr 1fr;
    display: grid;

    & [data-additions] {
      border-left: 1px solid var(--diffs-bg);
    }

    & [data-deletions] {
      border-right: 1px solid var(--diffs-bg);
    }
  }

  [data-code] {
    grid-auto-flow: dense;
    grid-template-columns: var(--diffs-code-grid);
    overflow: var(--diffs-overflow-override, scroll) clip;
    overscroll-behavior-x: none;
    tab-size: var(--diffs-tab-size, 2);
    padding-top: var(--diffs-gap-block, var(--diffs-gap-fallback));
    padding-bottom: max(0px,
      calc(var(--diffs-gap-block, var(--diffs-gap-fallback)) -
          var(--diffs-scrollbar-gutter)));
    scrollbar-gutter: stable;
    align-self: flex-start;
    display: grid;
  }

  [data-diffs-scrollbar-measure] {
    opacity: 0;
    pointer-events: none;
    scrollbar-gutter: auto;
    grid-template-columns: none;
    width: 100px;
    height: 100px;
    padding: 0;
    position: absolute;
    top: -200px;
    left: -200px;
  }

  [data-container-size] {
    container-type: inline-size;
  }

  [data-code]::-webkit-scrollbar {
    width: 0;
    height: var(--diffs-scrollbar-gutter);
  }

  [data-code]::-webkit-scrollbar-track {
    background: none;
  }

  [data-code]::-webkit-scrollbar-thumb {
    background-color: #0000;
    background-clip: content-box;
    border: 1px solid #0000;
    border-radius: 3px;
  }

  [data-code]::-webkit-scrollbar-corner {
    background-color: #0000;
  }

  @supports ((-moz-appearance: none)) {
    [data-code] {
      scrollbar-width: thin;
      scrollbar-color: var(--diffs-bg-context) transparent;
      padding-bottom: var(--diffs-gap-block, var(--diffs-gap-fallback));
    }
  }

  [data-diffs-header] ~ [data-diff], [data-diffs-header] ~ [data-file] {
    & [data-code], &[data-overflow="wrap"] {
      padding-top: 0;
    }
  }

  [data-gutter] {
    grid-template-rows: subgrid;
    grid-template-columns: subgrid;
    z-index: 3;
    background-color: var(--diffs-bg);
    grid-column: 1;
    display: grid;
    position: relative;

    & [data-gutter-buffer], & [data-column-number] {
      border-right: var(--diffs-gap-style, 2px solid var(--diffs-bg));
    }
  }

  [data-content] {
    grid-template-rows: subgrid;
    grid-template-columns: subgrid;
    background-color: var(--diffs-bg);
    grid-column: 2;
    min-width: 0;
    display: grid;
  }

  [data-diff-type="split"][data-overflow="wrap"] {
    grid-auto-flow: dense;
    grid-template-columns: repeat(2, var(--diffs-code-grid));
    padding-block: var(--diffs-gap-block, var(--diffs-gap-fallback));
    display: grid;

    & [data-deletions] {
      display: contents;

      & [data-gutter] {
        grid-column: 1;
      }

      & [data-content] {
        border-right: 1px solid var(--diffs-bg);
        grid-column: 2;
      }
    }

    & [data-additions] {
      display: contents;

      & [data-gutter] {
        border-left: 1px solid var(--diffs-bg);
        grid-column: 3;
      }

      & [data-content] {
        grid-column: 4;
      }
    }
  }

  [data-overflow="scroll"] [data-gutter] {
    position: sticky;
    left: 0;
  }

  [data-interactive-lines] [data-line] {
    cursor: pointer;
  }

  [data-interactive-line-numbers] [data-column-number] {
    cursor: pointer;
    touch-action: none;
  }

  [data-content-buffer], [data-gutter-buffer] {
    user-select: none;
    min-height: 1lh;
    position: relative;
  }

  [data-gutter-buffer] {
    padding-left: 2ch;
    padding-right: 1ch;

    &:before {
      content: "";
      min-width: var(--diffs-min-number-column-width, var(--diffs-min-number-column-width-default, 3ch));
      display: block;
    }
  }

  [data-gutter-buffer="annotation"] {
    --diffs-annotation-bg: var(--diffs-bg-context-gutter);
    min-height: 0;
  }

  [data-gutter-buffer="buffer"] {
    --diffs-line-bg: var(--diffs-bg-context-gutter);
  }

  [data-content-buffer] {
    background-position: 5px 0;
    background-size: 8px 8px;
    background-origin: border-box;
    background-image: repeating-linear-gradient(-45deg,
      transparent,
      transparent calc(3px * 1.414),
      var(--diffs-bg-buffer) calc(3px * 1.414),
      var(--diffs-bg-buffer) calc(4px * 1.414));
    grid-column: 1;
  }

  [data-separator] {
    box-sizing: content-box;
    background-color: var(--diffs-bg);
  }

  [data-separator="simple"] {
    min-height: 4px;
  }

  [data-separator="line-info"], [data-separator="line-info-basic"], [data-separator="metadata"], [data-separator="simple"] {
    background-color: var(--diffs-bg-separator);
  }

  [data-separator="line-info"], [data-separator="line-info-basic"], [data-separator="metadata"] {
    height: 32px;
    position: relative;
  }

  [data-separator-wrapper] {
    user-select: none;
    fill: currentColor;
    background-color: var(--diffs-bg);
    align-items: center;
    height: 100%;
    display: flex;
    position: absolute;
    inset-inline: 0;
  }

  [data-content] [data-separator-wrapper] {
    display: none;
  }

  [data-separator="metadata"] [data-separator-wrapper] {
    background-color: var(--diffs-bg-separator);
    height: 100%;
    color: var(--diffs-fg-number);
    white-space: nowrap;
    text-overflow: ellipsis;
    min-width: min-content;
    padding-inline: 1ch;
    inset-inline: 100% auto;
    overflow: hidden;
  }

  [data-separator="line-info"] {
    margin-block: var(--diffs-gap-block, var(--diffs-gap-fallback));

    & [data-separator-wrapper] {
      min-width: 16px;
    }
  }

  [data-separator="line-info-basic"], [data-separator="metadata"] {
    margin-block: 0;
  }

  [data-separator="line-info"][data-separator-first] {
    margin-top: 0;
  }

  [data-separator="line-info"][data-separator-last] {
    margin-bottom: 0;
  }

  [data-expand-index] [data-separator-wrapper] {
    grid-template-columns: 32px auto;
    display: grid;
  }

  [data-expand-index] [data-separator-wrapper][data-separator-multi-button] {
    grid-template-columns: 32px 32px auto;
  }

  [data-expand-button], [data-separator-content] {
    background-color: var(--diffs-bg-separator);
    flex: none;
    align-items: center;
    display: flex;
  }

  [data-expand-index] [data-separator-content]:hover {
    cursor: pointer;
    text-decoration: underline;
  }

  [data-expand-button] {
    cursor: pointer;
    min-width: 32px;
    color: var(--diffs-fg-number);
    border-right: 2px solid var(--diffs-bg);
    flex-shrink: 0;
    justify-content: center;
    align-self: stretch;

    &:hover {
      color: var(--diffs-fg);
    }

    &[data-expand-all-button] {
      display: none;
    }
  }

  [data-expand-down] [data-icon] {
    transform: scaleY(-1);
  }

  [data-separator-content] {
    height: 100%;
    color: var(--diffs-fg-number);
    flex: auto;
    justify-content: flex-start;
    padding: 0 1ch;
    overflow: hidden;
  }

  [data-separator="line-info"], [data-separator="line-info-basic"] {
    & [data-separator-content] {
      user-select: none;
      height: 100%;
      overflow: clip;
    }
  }

  [data-unmodified-lines] {
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 0 auto;
    min-width: 0;
    display: block;
    overflow: hidden;
  }

  @supports (width: 1cqi) {
    [data-unified] {
      & [data-separator="line-info"] [data-separator-wrapper] {
        padding-inline: var(--diffs-gap-inline, var(--diffs-gap-fallback));
        width: 100cqi;

        & [data-separator-content] {
          border-radius: 6px;
        }
      }

      & [data-separator="line-info"][data-expand-index] [data-separator-wrapper] [data-separator-content] {
        border-top-left-radius: unset;
        border-bottom-left-radius: unset;
      }
    }

    [data-gutter] {
      & [data-separator="line-info"] [data-separator-wrapper] {
        padding-left: var(--diffs-gap-inline, var(--diffs-gap-fallback));
      }

      & [data-separator="line-info"] [data-separator-content] {
        border-top-left-radius: 6px;
        border-bottom-left-radius: 6px;
      }

      & [data-separator="line-info"][data-expand-index] [data-separator-content] {
        border-top-left-radius: unset;
        border-bottom-left-radius: unset;
      }
    }

    [data-additions] {
      & [data-content] [data-separator="line-info"] {
        background-color: var(--diffs-bg);

        & [data-separator-wrapper] {
          display: none;
        }
      }

      & [data-gutter] [data-separator="line-info"] [data-separator-wrapper] {
        background-color: var(--diffs-bg-separator);
        border-top-right-radius: 6px;
        border-bottom-right-radius: 6px;
        height: 100%;
        display: block;

        & [data-separator-content], & [data-expand-button] {
          display: none;
        }
      }
    }

    [data-overflow="scroll"] [data-additions] [data-gutter] [data-separator="line-info"] [data-separator-wrapper] {
      width: calc(100cqi - var(--diffs-gap-inline, var(--diffs-gap-fallback)));
    }

    [data-overflow="wrap"] [data-additions] [data-content] [data-separator="line-info"] [data-separator-wrapper] {
      background-color: var(--diffs-bg-separator);
      height: 100%;
      margin-right: var(--diffs-gap-inline, var(--diffs-gap-fallback));
      border-top-right-radius: 6px;
      border-bottom-right-radius: 6px;
      display: block;

      & [data-separator-content], & [data-expand-button] {
        display: none;
      }
    }

    [data-separator="line-info"] [data-separator-wrapper] {
      & [data-expand-both], & [data-expand-down], & [data-expand-up] {
        border-top-left-radius: 6px;
        border-bottom-left-radius: 6px;
      }
    }

    @media (pointer: fine) {
      [data-separator="line-info"] [data-separator-wrapper] {
        &[data-separator-multi-button] {
          & [data-expand-up] {
            border-top-left-radius: 6px;
            border-bottom-left-radius: unset;
          }

          & [data-expand-down] {
            border-bottom-left-radius: 6px;
            border-top-left-radius: unset;
          }
        }
      }
    }
  }

  @media (pointer: coarse) {
    [data-separator="line-info-basic"] [data-separator-wrapper][data-separator-multi-button] {
      grid-template-columns: 34px 34px auto;

      & [data-separator-content] {
        grid-column: unset;
        grid-row: unset;
      }
    }

    @supports (width: 1cqi) {
      [data-separator="line-info"] [data-separator-wrapper] {
        & [data-expand-both], & [data-expand-down], & [data-expand-up] {
          border-top-left-radius: 6px;
          border-bottom-left-radius: 6px;
        }

        &[data-separator-multi-button] {
          & [data-expand-up] {
            border-top-left-radius: 6px;
            border-bottom-left-radius: 6px;
          }

          & [data-expand-down] {
            border-bottom-left-radius: unset;
            border-top-left-radius: unset;
          }
        }
      }
    }
  }

  @media (pointer: fine) {
    [data-separator-wrapper][data-separator-multi-button] {
      grid-template-rows: 50% 50%;
      display: grid;

      & [data-separator-content] {
        grid-area: 1 / 2 / -1;
        min-width: min-content;
      }

      & [data-expand-button] {
        grid-column: 1;
      }
    }

    [data-separator="line-info"] [data-separator-wrapper], [data-separator="line-info"] [data-separator-wrapper][data-separator-multi-button] {
      grid-template-columns: 34px auto;
    }

    [data-separator="line-info-basic"][data-expand-index] [data-separator-wrapper] {
      grid-template-columns: 100% auto;
    }

    [data-separator="line-info"], [data-separator="line-info-basic"] {
      & [data-separator-multi-button] {
        & [data-expand-up] {
          border-bottom: 1px solid var(--diffs-bg);
          border-right: 2px solid var(--diffs-bg);
        }

        & [data-expand-down] {
          border-top: 1px solid var(--diffs-bg);
          border-right: 2px solid var(--diffs-bg);
        }
      }
    }
  }

  [data-additions] [data-gutter] [data-separator-wrapper], [data-additions] [data-separator="line-info-basic"] [data-separator-wrapper], [data-content] [data-separator-wrapper] {
    display: none;
  }

  [data-line-annotation] {
    min-height: var(--diffs-annotation-min-height, 0);
    z-index: 2;
  }

  [data-merge-conflict-actions] {
    z-index: 2;
  }

  [data-separator="custom"] {
    grid-template-columns: subgrid;
    display: grid;
  }

  [data-line], [data-column-number], [data-no-newline] {
    padding-inline: 1ch;
    position: relative;
  }

  [data-indicators="classic"] [data-line] {
    padding-inline-start: 2ch;
  }

  [data-indicators="classic"] {
    & [data-line-type="change-addition"], & [data-line-type="change-deletion"] {
      &[data-no-newline], &[data-line] {
        &:before {
          user-select: none;
          width: 1ch;
          height: 1lh;
          display: inline-block;
          position: absolute;
          top: 0;
          left: 0;
        }
      }
    }

    & [data-line-type="change-addition"] {
      &[data-line], &[data-no-newline] {
        &:before {
          content: "+";
          color: var(--diffs-addition-base);
        }
      }
    }

    & [data-line-type="change-deletion"] {
      &[data-line], &[data-no-newline] {
        &:before {
          content: "-";
          color: var(--diffs-deletion-base);
        }
      }
    }
  }

  [data-indicators="bars"] {
    & [data-line-type="change-deletion"], & [data-line-type="change-addition"] {
      &[data-column-number] {
        &:before {
          content: "";
          user-select: none;
          contain: strict;
          width: 4px;
          height: 100%;
          display: block;
          position: absolute;
          top: 0;
          left: 0;
        }
      }
    }

    & [data-line-type="change-deletion"] {
      &[data-column-number] {
        &:before {
          background-image: linear-gradient(0deg,
            var(--diffs-bg-deletion) 50%,
            var(--diffs-deletion-base) 50%);
          background-repeat: repeat;
          background-size: 2px 2px;
          background-size: calc(1lh / round(1lh / 2px))
            calc(1lh / round(1lh / 2px));
        }
      }
    }

    & [data-line-type="change-addition"] {
      &[data-column-number] {
        &:before {
          background-color: var(--diffs-addition-base);
        }
      }
    }
  }

  [data-overflow="wrap"] {
    & [data-line], & [data-annotation-content] {
      white-space: pre-wrap;
      word-break: break-word;
    }
  }

  [data-overflow="scroll"] [data-line] {
    white-space: pre;
    min-height: 1lh;
  }

  [data-column-number] {
    box-sizing: content-box;
    text-align: right;
    user-select: none;
    color: var(--diffs-fg-number);
    padding-left: 2ch;
  }

  [data-line-number-content] {
    min-width: var(--diffs-min-number-column-width, var(--diffs-min-number-column-width-default, 3ch));
    z-index: 1;
    display: inline-block;
    position: relative;
  }

  [data-disable-line-numbers] {
    & [data-gutter-buffer], & [data-column-number] {
      min-width: 4px;
      padding: 0;

      &:before {
        min-width: 0;
      }
    }

    & [data-line-number-content] {
      display: none;
    }

    & [data-gutter-utility-slot] {
      right: unset;
      justify-content: flex-start;
      left: 0;
    }

    &[data-indicators="bars"] [data-gutter-utility-slot] {
      left: 6px;
    }
  }

  [data-file][data-disable-line-numbers] {
    & [data-gutter-buffer], & [data-column-number] {
      border-right: 0;
      min-width: 0;
    }
  }

  [data-diff-span] {
    box-decoration-break: clone;
    border-radius: 3px;
  }

  [data-line-type="change-addition"] [data-diff-span] {
    background-color: var(--diffs-bg-addition-emphasis);
  }

  [data-line-type="change-deletion"] [data-diff-span] {
    background-color: var(--diffs-bg-deletion-emphasis);
  }

  [data-merge-conflict="marker-start"], [data-merge-conflict="marker-base"], [data-merge-conflict="marker-separator"], [data-merge-conflict="marker-end"] {
    color: var(--diffs-fg);
    padding-left: 1ch;
  }

  [data-merge-conflict="marker-start"], [data-merge-conflict="marker-end"] {
    align-items: center;
    display: flex;

    &:after {
      color: var(--diffs-fg-conflict-marker);
      font-size: .75rem;
      font-style: normal;
      line-height: 1.25rem;
      font-family: var(--diffs-header-font-family, var(--diffs-header-font-fallback));
      padding-left: 1ch;
    }
  }

  [data-merge-conflict="marker-start"]:after {
    content: "(Current Change)";
  }

  [data-merge-conflict="marker-end"]:after {
    content: "(Incoming Change)";
  }

  [data-merge-conflict-actions-content] {
    min-height: 1.75rem;
    font-family: var(--diffs-header-font-family, var(--diffs-header-font-fallback));
    color: var(--diffs-fg);
    align-items: center;
    gap: .25rem;
    padding-inline: .5rem;
    font-size: .75rem;
    line-height: 1.2;
    display: flex;
  }

  [data-merge-conflict-action] {
    appearance: none;
    color: var(--diffs-fg-number);
    font: inherit;
    cursor: pointer;
    background: none;
    border: 0;
    padding: 0;
    font-style: normal;
  }

  [data-merge-conflict-action]:hover {
    color: var(--diffs-fg);
  }

  [data-merge-conflict-action="current"]:hover {
    color: var(--diffs-addition-base);
  }

  [data-merge-conflict-action="incoming"]:hover {
    color: var(--diffs-modified-base);
  }

  [data-merge-conflict-action-separator] {
    color: var(--diffs-fg-number);
    opacity: .6;
    user-select: none;
  }

  [data-diffs-header="default"] {
    background-color: var(--diffs-bg);
    justify-content: space-between;
    align-items: center;
    gap: var(--diffs-gap-inline, var(--diffs-gap-fallback));
    min-height: calc(1lh + (var(--diffs-gap-block, var(--diffs-gap-fallback)) * 3));
    z-index: 2;
    flex-direction: row;
    padding-inline: 16px;
    display: flex;
    position: relative;
    top: 0;
  }

  [data-header-content] {
    align-items: center;
    gap: var(--diffs-gap-inline, var(--diffs-gap-fallback));
    white-space: nowrap;
    flex-direction: row;
    min-width: 0;
    display: flex;
  }

  [data-header-content] [data-prev-name], [data-header-content] [data-title] {
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    min-width: 0;
    overflow: hidden;
  }

  [data-prev-name] {
    opacity: .7;
  }

  [data-rename-icon] {
    fill: currentColor;
    flex-grow: 0;
    flex-shrink: 0;
  }

  [data-diffs-header="default"] [data-metadata] {
    white-space: nowrap;
    align-items: center;
    gap: 1ch;
    display: flex;
  }

  [data-diffs-header="default"] [data-additions-count] {
    font-family: var(--diffs-font-family, var(--diffs-font-fallback));
    color: var(--diffs-addition-base);
  }

  [data-diffs-header="default"] [data-deletions-count] {
    font-family: var(--diffs-font-family, var(--diffs-font-fallback));
    color: var(--diffs-deletion-base);
  }

  [data-change-icon] {
    fill: currentColor;
    flex-shrink: 0;
  }

  [data-change-icon="change"], [data-change-icon="rename-pure"], [data-change-icon="rename-changed"] {
    color: var(--diffs-modified-base);
  }

  [data-change-icon="new"] {
    color: var(--diffs-addition-base);
  }

  [data-change-icon="deleted"] {
    color: var(--diffs-deletion-base);
  }

  [data-change-icon="file"] {
    opacity: .6;
  }

  [data-annotation-content] {
    z-index: 2;
    isolation: isolate;
    align-self: flex-start;
    min-width: 0;
    display: flow-root;
    position: relative;
  }

  [data-overflow="scroll"] [data-annotation-content], [data-overflow="scroll"] [data-merge-conflict-actions-content] {
    width: var(--diffs-column-content-width, auto);
    left: var(--diffs-column-number-width, 0);
    position: sticky;
  }

  [data-annotation-slot] {
    text-wrap-mode: wrap;
    word-break: normal;
    white-space-collapse: collapse;
  }

  [data-gutter-utility-slot] {
    touch-action: none;
    justify-content: flex-end;
    display: flex;
    position: absolute;
    top: 0;
    bottom: 0;
    right: 0;
  }

  [data-utility-button] {
    appearance: none;
    cursor: pointer;
    width: 1lh;
    height: 1lh;
    font-size: var(--diffs-font-size, 13px);
    line-height: var(--diffs-line-height, 20px);
    background-color: var(--diffs-modified-base);
    color: var(--diffs-bg);
    fill: currentColor;
    z-index: 4;
    touch-action: none;
    border: none;
    border-radius: 4px;
    justify-content: center;
    align-items: center;
    margin-right: calc(-1lh + 1ch);
    padding: 0;
    display: flex;
    position: relative;

    &:before {
      content: "";
      display: block;
      position: absolute;
      inset: 0 0 0 -4px;
    }
  }

  [data-decoration-bar-stack] {
    pointer-events: none;
    isolation: isolate;
    z-index: 1;
    background-color: var(--diffs-decoration-bar-color, transparent);
    box-sizing: content-box;
    border-left: 2px solid var(--diffs-bg);
    border-right: 2px solid var(--diffs-bg);
    width: 6px;
    position: absolute;
    top: 0;
    bottom: 0;
    right: -2px;

    [data-decoration-bar-depth="1"] & {
      background-color: color-mix(in lab,
        var(--diffs-bg) 20%,
        var(--diffs-decoration-bar-color, transparent));
    }

    [data-decoration-bar-depth="2"] & {
      background-color: color-mix(in lab,
        var(--diffs-bg) 45%,
        var(--diffs-decoration-bar-color, transparent));
    }

    [data-decoration-bar-depth="3"] & {
      background-color: color-mix(in lab,
        var(--diffs-bg) 65%,
        var(--diffs-decoration-bar-color, transparent));
    }

    [data-decoration-bar-start] & {
      border-top-left-radius: 5px;
      border-top-right-radius: 5px;
    }

    [data-decoration-bar-end] & {
      z-index: 3;
      border-bottom-right-radius: 5px;
      border-bottom-left-radius: 5px;
    }
  }

  [data-placeholder] {
    contain: strict;
  }

  [data-error-wrapper] {
    padding: var(--diffs-gap-block, var(--diffs-gap-fallback))
      var(--diffs-gap-inline, var(--diffs-gap-fallback));
    scrollbar-width: none;
    max-height: 400px;
    overflow: auto;

    & [data-error-message] {
      color: var(--diffs-deletion-base);
      font-size: 18px;
      font-weight: bold;
    }

    & [data-error-stack] {
      color: var(--diffs-fg-number);
    }
  }
}

@layer theme, rendered, unsafe;
`,Bn;function Vn(e){if(Bn!=null)return Bn;let t=e.host;if(typeof HTMLElement<`u`&&t instanceof HTMLElement&&!t.isConnected)return;let n=document.createElement(`div`);n.setAttribute(`data-code`,``),n.setAttribute(ae,`true`);let r=document.createElement(`div`);return r.style.position=`relative`,r.style.width=`200%`,r.style.height=`200%`,n.appendChild(r),e.appendChild(n),Bn=Math.max(n.offsetHeight-n.clientHeight,0),n.remove(),Bn}function Hn(e){return`${oe}: ${e==null?`var(--diffs-scrollbar-gutter-fallback)`:`${e}px`};`}var Un=`@layer base, theme, rendered, unsafe;`,Wn=RegExp(`${Jn(oe)}\\s*:\\s*[^;]+;`);function Gn(e){return`${Un}
@layer unsafe {
  ${e}
}`}function Kn(e,t=`system`,n){return`${Un}
@layer rendered {
  :host {${t===`system`?``:`
  color-scheme: ${t};`}
  ${Hn(n)}
  ${e}
  }
}`}function qn(e,t){let n=Hn(t);return e.replace(Wn,n)}function Jn(e){return e.replace(/[.*+?^${}()|[\]\\]/g,`\\$&`)}function Yn({code:e,pre:t,columnType:n,rowSpan:r,containerSize:i=!1}={}){return e??(e=document.createElement(`code`),e.setAttribute(`data-code`,``),n!=null&&e.setAttribute(`data-${n}`,``),t?.appendChild(e)),r==null?e.style.removeProperty(`grid-row`):e.style.setProperty(`grid-row`,`span ${r}`),i?e.setAttribute(`data-container-size`,``):e.removeAttribute(`data-container-size`),e}function Xn(e,t){if(t==null)return;let n=e.shadowRoot??e.attachShadow({mode:`open`});n.innerHTML===``&&(n.innerHTML=t)}function Zn(e,{type:t,diffIndicators:n,disableBackground:r,disableLineNumbers:i,overflow:a,split:o,totalLines:s,customProperties:c}){if(c!=null)for(let t in c){let n=c[t];n!=null&&e.setAttribute(t,`${n}`)}switch(t===`diff`?(e.setAttribute(`data-diff`,``),e.removeAttribute(`data-file`)):(e.setAttribute(`data-file`,``),e.removeAttribute(`data-diff`)),n){case`bars`:case`classic`:e.setAttribute(`data-indicators`,n);break;case`none`:e.removeAttribute(`data-indicators`);break}return i?e.setAttribute(`data-disable-line-numbers`,``):e.removeAttribute(`data-disable-line-numbers`),r?e.removeAttribute(`data-background`):e.setAttribute(`data-background`,``),t===`diff`?e.setAttribute(`data-diff-type`,o?`split`:`single`):e.removeAttribute(`data-diff-type`),e.setAttribute(`data-overflow`,a),e.style.setProperty(`--diffs-min-number-column-width-default`,`${`${s}`.length}ch`),e}function Qn(e){if(typeof HTMLStyleElement<`u`&&e instanceof HTMLStyleElement)return!0;let t=e.tagName??e.nodeName;return typeof t==`string`&&t.toLowerCase()===`style`}function $n({shadowRoot:e,currentNode:t,themeCSS:n}){if(n.trim()===``){t?.remove();return}return t??=er(),t.textContent=n,t.parentNode!==e&&e.appendChild(t),t}function er(){let e=document.createElement(`style`);return e.setAttribute(re,``),e}if(typeof HTMLElement<`u`&&customElements.get(`diffs-container`)==null){let e;class t extends HTMLElement{constructor(){if(super(),this.shadowRoot!=null)return;let t=this.attachShadow({mode:`open`});e??(e=new CSSStyleSheet,e.replaceSync(zn)),t.adoptedStyleSheets=[e]}connectedCallback(){Vn(this.shadowRoot??this.attachShadow({mode:`open`}))}}customElements.define(D,t)}function tr(e){return{...ce,...e}}function q(e,t){let n=nr(e,t);return t?n:e.diffHeaderHeight+n}function nr(e,t){return e.paddingTop??(t?e.spacing:0)}function rr(e){return e.paddingBottom??e.spacing}function ir(e){switch(e){case`simple`:return 4;case`metadata`:case`line-info`:case`line-info-basic`:case`custom`:return 32}}function ar(e,t){return e===t||e?.cacheKey!=null&&e.cacheKey===t?.cacheKey}var or=new TextEncoder,sr=new TextDecoder(`utf-8`,{ignoreBOM:!0}),cr=/[\uD800-\uDFFF]/,lr=1024,ur=new Uint8Array(lr);function dr(){ur.length!==lr&&(ur=new Uint8Array(lr))}function J(e){if(e.length===0)return e;if(cr.test(e))return JSON.parse(JSON.stringify(e));let t=e.length*3;ur.length<t&&(ur=new Uint8Array(t));let{written:n}=or.encodeInto(e,ur);return sr.decode(ur.subarray(0,n))}function fr(e,t,n){try{return pr(e,t,n)}finally{dr()}}function pr(e,t,n=!1){let r=jr(e),i=r?br(e):xr(e),a,o=[];for(let e of i){if(r&&!k.test(e)){if(a==null)a=J(e);else if(n)throw Error(`parsePatchContent: unknown file blob`);else console.error(`parsePatchContent: unknown file blob:`,e);continue}else if(!r&&!Sr(e)){if(a==null)a=J(e);else if(n)throw Error(`parsePatchContent: unknown file blob`);else console.error(`parsePatchContent: unknown file blob:`,e);continue}let i=hr(e,{cacheKey:t==null?void 0:`${t}-${o.length}`,isGitDiff:r,throwOnError:n});i!=null&&o.push(i)}return{patchMetadata:a,files:o}}function mr(e,t){try{return hr(e,t)}finally{dr()}}function hr(e,{cacheKey:t,isGitDiff:n=k.test(e),oldFile:r,newFile:i,throwOnError:a=!1}={}){let o=0,s=Mr(e,`@@ `),c,l=r==null||i==null,u=0,d=0;for(let e of s){let s=yr(e),f=s[0];if(f==null){if(a)throw Error(`parsePatchContent: invalid hunk`);console.error(`parsePatchContent: invalid hunk`,e);continue}let p=Or(f),m=0,h=0;if(p==null||c==null){if(c!=null){if(a)throw Error(`parsePatchContent: Invalid hunk`);console.error(`parsePatchContent: Invalid hunk`,e);continue}c={name:``,type:`change`,hunks:[],splitLineCount:0,unifiedLineCount:0,isPartial:l,additionLines:!l&&r!=null&&i!=null?vr(i.contents):[],deletionLines:!l&&r!=null&&i!=null?vr(r.contents):[],cacheKey:Pr(t)},c.additionLines.length===1&&i?.contents===``&&(c.additionLines.length=0),c.deletionLines.length===1&&r?.contents===``&&(c.deletionLines.length=0);for(let e of s){if(e.startsWith(`diff --git`)){let t=e.trim().match(M),n=t?.[1]??t?.[2],r=t?.[3]??t?.[4];if(n==null||r==null){if(a)throw Error(`parsePatchContent: invalid git diff header`);console.error(`parsePatchContent: invalid git diff header`,e);continue}c.name=J(r.trim()),n!==r&&(c.prevName=J(n.trim()));continue}let t=e.startsWith(`---`)||e.startsWith(`+++`)?e.match(n?j:A):null;if(t!=null){let[,e,n]=t;if(e===`---`&&n!==`/dev/null`){let e=J(n.trim());c.prevName=e,c.name=e}else e===`+++`&&n!==`/dev/null`&&(c.name=J(n.trim()))}else if(n){if(e.startsWith(`new mode `)&&(c.mode=J(e.slice(8).trim())),e.startsWith(`old mode `)&&(c.prevMode=J(e.slice(8).trim())),e.startsWith(`new file mode`)&&(c.type=`new`,c.mode=J(e.slice(13).trim())),e.startsWith(`deleted file mode`)&&(c.type=`deleted`,c.mode=J(e.slice(17).trim())),e.startsWith(`similarity index`)&&(e.startsWith(`similarity index 100%`)?c.type=`rename-pure`:c.type=`rename-changed`),e.startsWith(`index `)){let[,t,n,r]=e.trim().match(N)??[];t!=null&&(c.prevObjectId=J(t)),n!=null&&(c.newObjectId=J(n)),r!=null&&(c.mode=J(r))}e.startsWith(`rename from `)&&(c.prevName=J(e.slice(12).trim())),e.startsWith(`rename to `)&&(c.name=J(e.slice(10).trim()))}}continue}let g,_;for(;s.length>0&&(s[s.length-1]===`
`||s[s.length-1]===`\r`||s[s.length-1]===`\r
`||s[s.length-1]===``);)s.pop();let{additionStart:v,deletionStart:y}=p;u=l?u:y-1,d=l?d:v-1;let b={collapsedBefore:0,splitLineCount:0,splitLineStart:0,unifiedLineCount:0,unifiedLineStart:0,additionCount:p.additionCount,additionStart:v,additionLines:m,deletionCount:p.deletionCount,deletionStart:y,deletionLines:h,deletionLineIndex:u,additionLineIndex:d,hunkContent:[],hunkContext:Pr(p.hunkContext),hunkSpecs:J(f),noEOFCRAdditions:!1,noEOFCRDeletions:!1},x=0,S=0;for(let e=1;e<s.length;e++){let t=s[e];if(x>=b.additionCount&&S>=b.deletionCount&&!t.startsWith(`\\`)){if(a&&Er(t)&&!Dr(t))throw Error(`parsePatchContent: hunk has more lines than expected`);break}let n=t[0];if(n!==`+`&&n!==`-`&&n!==` `&&n!==`\\`){if(a)throw Error(`parsePatchContent: invalid hunk line`);console.error(`parseLineType: Invalid firstChar: "${n}", full line: "${t}"`),console.error(`processFile: invalid rawLine:`,t);continue}let r=Fr(n);if(r===`addition`){if(a&&x>=b.additionCount)throw Error(`parsePatchContent: hunk has too many addition lines`);let e=Ir(t);(g==null||g.type!==`change`)&&(g=Lr(`change`,u,d),b.hunkContent.push(g)),d++,x++,l&&c.additionLines.push(e),g.additions++,m++,_=`addition`}else if(r===`deletion`){if(a&&S>=b.deletionCount)throw Error(`parsePatchContent: hunk has too many deletion lines`);let e=Ir(t);(g==null||g.type!==`change`)&&(g=Lr(`change`,u,d),b.hunkContent.push(g)),u++,S++,l&&c.deletionLines.push(e),g.deletions++,h++,_=`deletion`}else if(r===`context`){if(a&&(S>=b.deletionCount||x>=b.additionCount))throw Error(`parsePatchContent: hunk has too many context lines`);let e=Ir(t);(g==null||g.type!==`context`)&&(g=Lr(`context`,u,d),b.hunkContent.push(g)),d++,u++,x++,S++,l&&(c.deletionLines.push(e),c.additionLines.push(e)),g.lines++,_=`context`}else if(r===`metadata`&&g!=null){if(g.type===`context`?(b.noEOFCRAdditions=!0,b.noEOFCRDeletions=!0):_===`deletion`?b.noEOFCRDeletions=!0:_===`addition`&&(b.noEOFCRAdditions=!0),l&&(_===`addition`||_===`context`)){let e=c.additionLines.length-1;e>=0&&(c.additionLines[e]=W(c.additionLines[e]))}if(l&&(_===`deletion`||_===`context`)){let e=c.deletionLines.length-1;e>=0&&(c.deletionLines[e]=W(c.deletionLines[e]))}}}if(a&&(x!==b.additionCount||S!==b.deletionCount))throw Error(`parsePatchContent: hunk line count mismatch`);b.additionLines=m,b.deletionLines=h,b.collapsedBefore=Math.max(b.additionStart-1-o,0),c.hunks.push(b),o=b.additionStart+b.additionCount-1;for(let e of b.hunkContent)e.type===`context`?(b.splitLineCount+=e.lines,b.unifiedLineCount+=e.lines):(b.splitLineCount+=Math.max(e.additions,e.deletions),b.unifiedLineCount+=e.deletions+e.additions);b.splitLineStart=c.splitLineCount+b.collapsedBefore,b.unifiedLineStart=c.unifiedLineCount+b.collapsedBefore,c.splitLineCount+=b.collapsedBefore+b.splitLineCount,c.unifiedLineCount+=b.collapsedBefore+b.unifiedLineCount}if(c!=null){if(a&&l&&!n&&c.hunks.length===0)throw Error(`parsePatchContent: unified file has no hunks`);if(c.hunks.length>0&&!l&&c.additionLines.length>0&&c.deletionLines.length>0){let e=c.hunks[c.hunks.length-1],t=e.additionStart+e.additionCount-1,n=c.additionLines.length,r=Math.max(n-t,0);c.splitLineCount+=r,c.unifiedLineCount+=r}return n||(c.prevName!=null&&c.name!==c.prevName?c.hunks.length>0?c.type=`rename-changed`:c.type=`rename-pure`:(r==null||r.contents===``)&&i!=null&&i.contents!==``?c.type=`new`:r!=null&&r.contents!==``&&(i==null||i.contents===``)&&(c.type=`deleted`)),c.type!==`rename-pure`&&c.type!==`rename-changed`&&(c.prevName=void 0),c}}function gr(e,t,n=!1){let r=[],i=_r(e)?e.split(O):[e];for(let e of i)try{r.push(fr(e,t==null?void 0:`${t}-${r.length}`,n))}catch(e){if(n)throw e;console.error(e)}return r}function _r(e){return e.startsWith(`From `)||e.includes(`
From `)}function vr(e){let t=yr(e);for(let e=0;e<t.length;e++)t[e]=J(t[e]);return t}function yr(e){if(e.length===0)return[``];let t=[],n=0;for(;;){let r=e.indexOf(`
`,n);if(r===-1)break;t.push(e.slice(n,r+1)),n=r+1}return n<e.length&&t.push(e.slice(n)),t}function br(e){return Mr(e,`diff --git`)}function xr(e){if(e.length===0)return[``];let t=[],n=0,r=0,i=0,a=0,o=!1;for(;r<e.length;){let s=Tr(e,r);if(i<=0&&a<=0){if(Cr(e,r)){r>n&&t.push(e.slice(n,r)),n=r,o=!0,r=Tr(e,s);continue}if(o&&e.startsWith(`@@ -`,r)){let t=Or(e.slice(r,s));t!=null&&(i=t.deletionCount,a=t.additionCount)}r=s;continue}let c=e[r];if(c===`\\`){r=s;continue}c===` `?(i=Math.max(i-1,0),a=Math.max(a-1,0)):c===`-`?i=Math.max(i-1,0):c===`+`&&(a=Math.max(a-1,0)),r=s}return t.push(e.slice(n)),t}function Sr(e){return Cr(e,0)}function Cr(e,t){let n=Tr(e,t);return wr(e,t,`---`)&&wr(e,n,`+++`)}function wr(e,t,n){if(!e.startsWith(n,t))return!1;let r=e[t+n.length];if(r!==` `&&r!==`	`)return!1;for(let r=t+n.length+1;r<e.length;r++){let t=e[r];if(t===`
`||t===`\r`)break;if(t!==` `&&t!==`	`)return!0}return!1}function Tr(e,t){let n=e.indexOf(`
`,t);return n===-1?e.length:n+1}function Er(e){let t=e[0];return t===`+`||t===`-`||t===` `}function Dr(e){if(!e.startsWith(`--`))return!1;for(let t=2;t<e.length;t++){let n=e[t];if(n!==` `&&n!==`	`&&n!==`
`&&n!==`\r`)return!1}return!0}function Or(e){if(!e.startsWith(`@@ -`))return;let t=4,n=kr(e,t);if(n==null)return;let r=n.value;t=n.endIndex;let i=1;if(e[t]===`,`){let n=kr(e,t+1);if(n==null)return;i=n.value,t=n.endIndex}if(e[t]!==` `||e[t+1]!==`+`)return;t+=2;let a=kr(e,t);if(a==null)return;let o=a.value;t=a.endIndex;let s=1;if(e[t]===`,`){let n=kr(e,t+1);if(n==null)return;s=n.value,t=n.endIndex}if(e[t]!==` `||e[t+1]!==`@`||e[t+2]!==`@`)return;let c,l=t+3;return e[l]===` `&&(c=Ar(e.slice(l+1))),{additionCount:s,additionStart:o,deletionCount:i,deletionStart:r,hunkContext:c}}function kr(e,t){let n=t,r=0;for(;n<e.length;n++){let t=e.charCodeAt(n)-48;if(t<0||t>9)break;r=r*10+t}if(n!==t)return{value:r,endIndex:n}}function Ar(e){return e.endsWith(`\r
`)?e.slice(0,-2):e.endsWith(`
`)?e.slice(0,-1):e}function jr(e){return e.startsWith(`diff --git`)||e.includes(`
diff --git`)}function Mr(e,t){if(e.length===0)return[``];let n=`\n${t}`,r=e.startsWith(t)?0:Nr(e,n,0);if(r===-1)return[e];let i=[];r>0&&i.push(e.slice(0,r));let a=r;for(;;){let t=Nr(e,n,a+1);if(t===-1)break;i.push(e.slice(a,t)),a=t}return i.push(e.slice(a)),i}function Nr(e,t,n){let r=e.indexOf(t,n);return r===-1?-1:r+1}function Pr(e){return e==null?e:J(e)}function Fr(e){return e===` `?`context`:e===`\\`?`metadata`:e===`+`?`addition`:`deletion`}function Ir(e){let t=e.slice(1);return J(t===``?`
`:t)}function Lr(e,t,n){return e===`change`?{type:`change`,additions:0,deletions:0,additionLineIndex:n,deletionLineIndex:t}:{type:`context`,lines:0,additionLineIndex:n,deletionLineIndex:t}}var Y=class{diff(e,t,n={}){let r;typeof n==`function`?(r=n,n={}):`callback`in n&&(r=n.callback);let i=this.castInput(e,n),a=this.castInput(t,n),o=this.removeEmpty(this.tokenize(i,n)),s=this.removeEmpty(this.tokenize(a,n));return this.diffWithOptionsObj(o,s,n,r)}diffWithOptionsObj(e,t,n,r){let i=e=>{if(e=this.postProcess(e,n),r){setTimeout(function(){r(e)},0);return}else return e},a=t.length,o=e.length,s=1,c=a+o;n.maxEditLength!=null&&(c=Math.min(c,n.maxEditLength));let l=n.timeout??1/0,u=Date.now()+l,d=[{oldPos:-1,lastComponent:void 0}],f=this.extractCommon(d[0],t,e,0,n);if(d[0].oldPos+1>=o&&f+1>=a)return i(this.buildValues(d[0].lastComponent,t,e));let p=-1/0,m=1/0,h=()=>{for(let r=Math.max(p,-s);r<=Math.min(m,s);r+=2){let s,c=d[r-1],l=d[r+1];c&&(d[r-1]=void 0);let u=!1;if(l){let e=l.oldPos-r;u=l&&0<=e&&e<a}let h=c&&c.oldPos+1<o;if(!u&&!h){d[r]=void 0;continue}if(s=!h||u&&c.oldPos<l.oldPos?this.addToPath(l,!0,!1,0,n):this.addToPath(c,!1,!0,1,n),f=this.extractCommon(s,t,e,r,n),s.oldPos+1>=o&&f+1>=a)return i(this.buildValues(s.lastComponent,t,e))||!0;d[r]=s,s.oldPos+1>=o&&(m=Math.min(m,r-1)),f+1>=a&&(p=Math.max(p,r+1))}s++};if(r)(function e(){setTimeout(function(){if(s>c||Date.now()>u)return r(void 0);h()||e()},0)})();else for(;s<=c&&Date.now()<=u;){let e=h();if(e)return e}}addToPath(e,t,n,r,i){let a=e.lastComponent;return a&&!i.oneChangePerToken&&a.added===t&&a.removed===n?{oldPos:e.oldPos+r,lastComponent:{count:a.count+1,added:t,removed:n,previousComponent:a.previousComponent}}:{oldPos:e.oldPos+r,lastComponent:{count:1,added:t,removed:n,previousComponent:a}}}extractCommon(e,t,n,r,i){let a=t.length,o=n.length,s=e.oldPos,c=s-r,l=0;for(;c+1<a&&s+1<o&&this.equals(n[s+1],t[c+1],i);)c++,s++,l++,i.oneChangePerToken&&(e.lastComponent={count:1,previousComponent:e.lastComponent,added:!1,removed:!1});return l&&!i.oneChangePerToken&&(e.lastComponent={count:l,previousComponent:e.lastComponent,added:!1,removed:!1}),e.oldPos=s,c}equals(e,t,n){return n.comparator?n.comparator(e,t):e===t||!!n.ignoreCase&&e.toLowerCase()===t.toLowerCase()}removeEmpty(e){let t=[];for(let n=0;n<e.length;n++)e[n]&&t.push(e[n]);return t}castInput(e,t){return e}tokenize(e,t){return Array.from(e)}join(e){return e.join(``)}postProcess(e,t){return e}get useLongestToken(){return!1}buildValues(e,t,n){let r=[],i;for(;e;)r.push(e),i=e.previousComponent,delete e.previousComponent,e=i;r.reverse();let a=r.length,o=0,s=0,c=0;for(;o<a;o++){let e=r[o];if(e.removed)e.value=this.join(n.slice(c,c+e.count)),c+=e.count;else{if(!e.added&&this.useLongestToken){let r=t.slice(s,s+e.count);r=r.map(function(e,t){let r=n[c+t];return r.length>e.length?r:e}),e.value=this.join(r)}else e.value=this.join(t.slice(s,s+e.count));s+=e.count,e.added||(c+=e.count)}}return r}},Rr=new class extends Y{};function zr(e,t,n){return Rr.diff(e,t,n)}function Br(e,t){let n;for(n=0;n<e.length&&n<t.length;n++)if(e[n]!=t[n])return e.slice(0,n);return e.slice(0,n)}function Vr(e,t){let n;if(!e||!t||e[e.length-1]!=t[t.length-1])return``;for(n=0;n<e.length&&n<t.length;n++)if(e[e.length-(n+1)]!=t[t.length-(n+1)])return e.slice(-n);return e.slice(-n)}function Hr(e,t,n){if(e.slice(0,t.length)!=t)throw Error(`string ${JSON.stringify(e)} doesn't start with prefix ${JSON.stringify(t)}; this is a bug`);return n+e.slice(t.length)}function Ur(e,t,n){if(!t)return e+n;if(e.slice(-t.length)!=t)throw Error(`string ${JSON.stringify(e)} doesn't end with suffix ${JSON.stringify(t)}; this is a bug`);return e.slice(0,-t.length)+n}function Wr(e,t){return Hr(e,t,``)}function Gr(e,t){return Ur(e,t,``)}function Kr(e,t){return t.slice(0,qr(e,t))}function qr(e,t){let n=0;e.length>t.length&&(n=e.length-t.length);let r=t.length;e.length<t.length&&(r=e.length);let i=Array(r),a=0;i[0]=0;for(let e=1;e<r;e++){for(t[e]==t[a]?i[e]=i[a]:i[e]=a;a>0&&t[e]!=t[a];)a=i[a];t[e]==t[a]&&a++}a=0;for(let r=n;r<e.length;r++){for(;a>0&&e[r]!=t[a];)a=i[a];e[r]==t[a]&&a++}return a}function Jr(e,t){let n=[];for(let r of Array.from(t.segment(e))){let e=r.segment;n.length&&/\s/.test(n[n.length-1])&&/\s/.test(e)?n[n.length-1]+=e:n.push(e)}return n}function Yr(e,t){if(t)return Zr(e,t)[1];let n;for(n=e.length-1;n>=0&&e[n].match(/\s/);n--);return e.substring(n+1)}function Xr(e,t){if(t)return Zr(e,t)[0];let n=e.match(/^\s*/);return n?n[0]:``}function Zr(e,t){if(!t)return[Xr(e),Yr(e)];if(t.resolvedOptions().granularity!=`word`)throw Error(`The segmenter passed must have a granularity of "word"`);let n=Jr(e,t),r=n[0],i=n[n.length-1];return[/\s/.test(r)?r:``,/\s/.test(i)?i:``]}var Qr=`a-zA-Z0-9_\\u{AD}\\u{C0}-\\u{D6}\\u{D8}-\\u{F6}\\u{F8}-\\u{2C6}\\u{2C8}-\\u{2D7}\\u{2DE}-\\u{2FF}\\u{1E00}-\\u{1EFF}`,$r=RegExp(`[${Qr}]+|\\s+|[^${Qr}]`,`ug`);new class extends Y{equals(e,t,n){return n.ignoreCase&&(e=e.toLowerCase(),t=t.toLowerCase()),e.trim()===t.trim()}tokenize(e,t={}){let n;if(t.intlSegmenter){let r=t.intlSegmenter;if(r.resolvedOptions().granularity!=`word`)throw Error(`The segmenter passed must have a granularity of "word"`);n=Jr(e,r)}else n=e.match($r)||[];let r=[],i=null;return n.forEach(e=>{/\s/.test(e)?i==null?r.push(e):r.push(r.pop()+e):i!=null&&/\s/.test(i)?r[r.length-1]==i?r.push(r.pop()+e):r.push(i+e):r.push(e),i=e}),r}join(e){return e.map((e,t)=>t==0?e:e.replace(/^\s+/,``)).join(``)}postProcess(e,t){if(!e||t.oneChangePerToken)return e;let n=null,r=null,i=null;return e.forEach(e=>{e.added?r=e:e.removed?i=e:((r||i)&&ei(n,i,r,e,t.intlSegmenter),n=e,r=null,i=null)}),(r||i)&&ei(n,i,r,null,t.intlSegmenter),e}};function ei(e,t,n,r,i){if(t&&n){let[a,o]=Zr(t.value,i),[s,c]=Zr(n.value,i);if(e){let r=Br(a,s);e.value=Ur(e.value,s,r),t.value=Wr(t.value,r),n.value=Wr(n.value,r)}if(r){let e=Vr(o,c);r.value=Hr(r.value,c,e),t.value=Gr(t.value,e),n.value=Gr(n.value,e)}}else if(n){if(e){let e=Xr(n.value,i);n.value=n.value.substring(e.length)}if(r){let e=Xr(r.value,i);r.value=r.value.substring(e.length)}}else if(e&&r){let n=Xr(r.value,i),[a,o]=Zr(t.value,i),s=Br(n,a);t.value=Wr(t.value,s);let c=Vr(Wr(n,s),o);t.value=Gr(t.value,c),r.value=Hr(r.value,n,c),e.value=Ur(e.value,n,n.slice(0,n.length-c.length))}else if(r){let e=Xr(r.value,i),n=Kr(Yr(t.value,i),e);t.value=Gr(t.value,n)}else if(e){let n=Kr(Yr(e.value,i),Xr(t.value,i));t.value=Wr(t.value,n)}}var ti=new class extends Y{tokenize(e){let t=RegExp(`(\\r?\\n)|[${Qr}]+|[^\\S\\n\\r]+|[^${Qr}]`,`ug`);return e.match(t)||[]}};function ni(e,t,n){return ti.diff(e,t,n)}var ri=new class extends Y{constructor(){super(...arguments),this.tokenize=ai}equals(e,t,n){return n.ignoreWhitespace?((!n.newlineIsToken||!e.includes(`
`))&&(e=e.trim()),(!n.newlineIsToken||!t.includes(`
`))&&(t=t.trim())):n.ignoreNewlineAtEof&&!n.newlineIsToken&&(e.endsWith(`
`)&&(e=e.slice(0,-1)),t.endsWith(`
`)&&(t=t.slice(0,-1))),super.equals(e,t,n)}};function ii(e,t,n){return ri.diff(e,t,n)}function ai(e,t){t.stripTrailingCr&&(e=e.replace(/\r\n/g,`
`));let n=[],r=e.split(/(\n|\r\n)/);r[r.length-1]||r.pop();for(let e=0;e<r.length;e++){let i=r[e];e%2&&!t.newlineIsToken?n[n.length-1]+=i:n.push(i)}return n}function oi(e){return e==`.`||e==`!`||e==`?`}new class extends Y{tokenize(e){let t=[],n=0;for(let r=0;r<e.length;r++){if(r==e.length-1){t.push(e.slice(n));break}if(oi(e[r])&&e[r+1].match(/\s/)){for(t.push(e.slice(n,r+1)),r=n=r+1;e[r+1]?.match(/\s/);)r++;t.push(e.slice(n,r+1)),n=r+1}}return t}},new class extends Y{tokenize(e){return e.split(/([{}:;,]|\s+)/)}},new class extends Y{constructor(){super(...arguments),this.tokenize=ai}get useLongestToken(){return!0}castInput(e,t){let{undefinedReplacement:n,stringifyReplacer:r=(e,t)=>t===void 0?n:t}=t;return typeof e==`string`?e:JSON.stringify(si(e,null,null,r),null,`  `)}equals(e,t,n){return super.equals(e.replace(/,([\r\n])/g,`$1`),t.replace(/,([\r\n])/g,`$1`),n)}};function si(e,t,n,r,i){t||=[],n||=[],r&&(e=r(i===void 0?``:i,e));let a;for(a=0;a<t.length;a+=1)if(t[a]===e)return n[a];let o;if(Object.prototype.toString.call(e)===`[object Array]`){for(t.push(e),o=Array(e.length),n.push(o),a=0;a<e.length;a+=1)o[a]=si(e[a],t,n,r,String(a));return t.pop(),n.pop(),o}if(e&&e.toJSON&&(e=e.toJSON()),typeof e==`object`&&e){t.push(e),o={},n.push(o);let i=[],s;for(s in e)Object.prototype.hasOwnProperty.call(e,s)&&i.push(s);for(i.sort(),a=0;a<i.length;a+=1)s=i[a],o[s]=si(e[s],t,n,r,s);t.pop(),n.pop()}else o=e;return o}new class extends Y{tokenize(e){return e.slice()}join(e){return e}removeEmpty(e){return e}};function ci(e){for(let t=0;t<e.length;t++)if(e[t]<` `||e[t]>`~`||e[t]===`"`||e[t]===`\\`)return!0;return!1}function X(e){if(!ci(e))return e;let t=`"`,n=new TextEncoder().encode(e),r=0;for(;r<n.length;){let e=n[r];e===7?t+=`\\a`:e===8?t+=`\\b`:e===9?t+=`\\t`:e===10?t+=`\\n`:e===11?t+=`\\v`:e===12?t+=`\\f`:e===13?t+=`\\r`:e===34?t+=`\\"`:e===92?t+=`\\\\`:e>=32&&e<=126?t+=String.fromCharCode(e):t+=`\\`+e.toString(8).padStart(3,`0`),r++}return t+=`"`,t}var li={includeIndex:!0,includeUnderline:!0,includeFileHeaders:!0};function ui(e,t,n,r,i,a,o){let s;s=o?typeof o==`function`?{callback:o}:o:{},s.context===void 0&&(s.context=4);let c=s.context;if(s.newlineIsToken)throw Error(`newlineIsToken may not be used with patch-generation functions, only with diffing functions`);if(s.callback){let{callback:e}=s;ii(n,r,Object.assign(Object.assign({},s),{callback:t=>{e(l(t))}}))}else return l(ii(n,r,s));function l(n){if(!n)return;n.push({value:``,lines:[]});function r(e){return e.map(function(e){return` `+e})}let o=[],s=0,l=0,u=[],d=1,f=1;for(let e=0;e<n.length;e++){let t=n[e],i=t.lines||pi(t.value);if(t.lines=i,t.added||t.removed){if(!s){let t=n[e-1];s=d,l=f,t&&(u=c>0?r(t.lines.slice(-c)):[],s-=u.length,l-=u.length)}for(let e of i)u.push((t.added?`+`:`-`)+e);t.added?f+=i.length:d+=i.length}else{if(s)if(i.length<=c*2&&e<n.length-2)for(let e of r(i))u.push(e);else{let e=Math.min(i.length,c);for(let t of r(i.slice(0,e)))u.push(t);let t={oldStart:s,oldLines:d-s+e,newStart:l,newLines:f-l+e,lines:u};o.push(t),s=0,l=0,u=[]}d+=i.length,f+=i.length}}for(let e of o)for(let t=0;t<e.lines.length;t++)e.lines[t].endsWith(`
`)?e.lines[t]=e.lines[t].slice(0,-1):(e.lines.splice(t+1,0,`\\ No newline at end of file`),t++);return{oldFileName:e,newFileName:t,oldHeader:i,newHeader:a,hunks:o}}}function di(e,t){if(t||=li,Array.isArray(e)){if(e.length>1&&!t.includeFileHeaders&&!e.every(e=>e.isGit))throw Error(`Cannot omit file headers on a multi-file patch. (The result would be unparseable; how would a tool trying to apply the patch know which changes are to which file?)`);return e.map(e=>di(e,t)).join(`
`)}let n=[];if(e.isGit){if(t=li,!e.oldFileName)throw Error(`oldFileName must be specified for Git patches`);if(!e.newFileName)throw Error(`newFileName must be specified for Git patches`);let r=e.oldFileName,i=e.newFileName;e.isCreate&&r===`/dev/null`?r=i.replace(/^b\//,`a/`):e.isDelete&&i===`/dev/null`&&(i=r.replace(/^a\//,`b/`)),n.push(`diff --git `+X(r)+` `+X(i)),e.isDelete&&n.push(`deleted file mode `+(e.oldMode??`100644`)),e.isCreate&&n.push(`new file mode `+(e.newMode??`100644`)),e.oldMode&&e.newMode&&!e.isDelete&&!e.isCreate&&(n.push(`old mode `+e.oldMode),n.push(`new mode `+e.newMode)),e.isRename&&(n.push(`rename from `+X((e.oldFileName??``).replace(/^a\//,``))),n.push(`rename to `+X((e.newFileName??``).replace(/^b\//,``)))),e.isCopy&&(n.push(`copy from `+X((e.oldFileName??``).replace(/^a\//,``))),n.push(`copy to `+X((e.newFileName??``).replace(/^b\//,``))))}else t.includeIndex&&e.oldFileName==e.newFileName&&e.oldFileName!==void 0&&n.push(`Index: `+e.oldFileName),t.includeUnderline&&n.push(`===================================================================`);let r=e.hunks.length>0;t.includeFileHeaders&&e.oldFileName!==void 0&&e.newFileName!==void 0&&(!e.isGit||r)&&(n.push(`--- `+X(e.oldFileName)+(e.oldHeader?`	`+e.oldHeader:``)),n.push(`+++ `+X(e.newFileName)+(e.newHeader?`	`+e.newHeader:``)));for(let t=0;t<e.hunks.length;t++){let r=e.hunks[t],i=r.oldLines===0?r.oldStart-1:r.oldStart,a=r.newLines===0?r.newStart-1:r.newStart;n.push(`@@ -`+i+`,`+r.oldLines+` +`+a+`,`+r.newLines+` @@`);for(let e of r.lines)n.push(e)}return n.join(`
`)+`
`}function fi(e,t,n,r,i,a,o){if(typeof o==`function`&&(o={callback:o}),o?.callback){let{callback:s}=o;ui(e,t,n,r,i,a,Object.assign(Object.assign({},o),{callback:e=>{s(e?di(e,o.headerOptions):void 0)}}))}else{let s=ui(e,t,n,r,i,a,o);return s?di(s,o?.headerOptions):void 0}}function pi(e){let t=e.endsWith(`
`),n=e.split(`
`).map(e=>e+`
`);return t?n.pop():n.push(n.pop().slice(0,-1)),n}function mi(e,t,n,r=!1){let i=mr(fi(e.name,t.name,e.contents,t.contents,e.header,t.header,n),{cacheKey:(()=>{if(e.cacheKey!=null&&t.cacheKey!=null)return`${e.cacheKey}:${t.cacheKey}`})(),oldFile:e,newFile:t,throwOnError:r});if(i==null)throw Error(`parseDiffFrom: FileInvalid diff -- probably need to fix something -- if the files are the same maybe?`);return t.lang!=null&&(i.lang=t.lang),i}var hi=class{isDeletionsScrolling=!1;isAdditionsScrolling=!1;timeoutId=-1;codeDeletions;codeAdditions;enabled=!1;cleanUp(){this.enabled&&=(this.codeDeletions?.removeEventListener(`scroll`,this.handleDeletionsScroll),this.codeAdditions?.removeEventListener(`scroll`,this.handleAdditionsScroll),clearTimeout(this.timeoutId),this.codeDeletions=void 0,this.codeAdditions=void 0,!1)}setup(e,t,n){if(t==null||n==null)for(let r of e.children??[])r instanceof HTMLElement&&(`deletions`in r.dataset?t=r:`additions`in r.dataset&&(n=r));if(n==null||t==null){this.cleanUp();return}this.codeDeletions!==t&&(this.codeDeletions?.removeEventListener(`scroll`,this.handleDeletionsScroll),this.codeDeletions=t,t.addEventListener(`scroll`,this.handleDeletionsScroll,{passive:!0})),this.codeAdditions!==n&&(this.codeAdditions?.removeEventListener(`scroll`,this.handleAdditionsScroll),this.codeAdditions=n,n.addEventListener(`scroll`,this.handleAdditionsScroll,{passive:!0})),this.enabled=!0}handleDeletionsScroll=()=>{this.isAdditionsScrolling||(this.isDeletionsScrolling=!0,clearTimeout(this.timeoutId),this.timeoutId=setTimeout(()=>{this.isDeletionsScrolling=!1},300),this.codeAdditions?.scrollTo({left:this.codeDeletions?.scrollLeft}))};handleAdditionsScroll=()=>{this.isDeletionsScrolling||(this.isAdditionsScrolling=!0,clearTimeout(this.timeoutId),this.timeoutId=setTimeout(()=>{this.isAdditionsScrolling=!1},300),this.codeDeletions?.scrollTo({left:this.codeAdditions?.scrollLeft}))}};function gi(e,t){return pe(e.theme,t.theme)&&e.useTokenTransformer===t.useTokenTransformer&&e.tokenizeMaxLineLength===t.tokenizeMaxLineLength&&e.lineDiffType===t.lineDiffType&&e.maxLineDiffLength===t.maxLineDiffLength}function _i(e){return I({tagName:`div`,properties:{"data-content-buffer":``,"data-buffer-size":e,style:`grid-row: span ${e};min-height:calc(${e} * 1lh)`}})}function vi(e){return I({tagName:`div`,children:[I({tagName:`span`,children:[F(`No newline at end of file`)]})],properties:{"data-no-newline":``,"data-line-type":e,"data-column-content":``}})}function yi(e){return I({tagName:`div`,children:[_e({name:e===`both`?`diffs-icon-expand-all`:`diffs-icon-expand`,properties:{"data-icon":``}})],properties:{role:`button`,"data-expand-button":``,"data-expand-both":e===`both`?``:void 0,"data-expand-up":e===`up`?``:void 0,"data-expand-down":e===`down`?``:void 0}})}function bi({type:e,content:t,expandIndex:n,chunked:r=!1,slotName:i,isFirstHunk:a,isLastHunk:o}){let s=0,c=[];if(e===`metadata`&&t!=null&&c.push(I({tagName:`div`,children:[F(t)],properties:{"data-separator-wrapper":``}})),(e===`line-info`||e===`line-info-basic`)&&t!=null){let e=[];n!=null&&(r?(a||(e.push(yi(`up`)),s++),o||(e.push(yi(`down`)),s++)):(e.push(yi(!a&&!o?`both`:a?`down`:`up`)),s++)),e.push(I({tagName:`div`,children:[I({tagName:`span`,children:[F(t)],properties:{"data-unmodified-lines":``}})],properties:{"data-separator-content":``}})),r&&n!=null&&e.push(I({tagName:`div`,children:[F(`Expand all`)],properties:{role:`button`,"data-expand-button":``,"data-expand-all-button":``}})),c.push(I({tagName:`div`,children:e,properties:{"data-separator-wrapper":``,"data-separator-multi-button":s>1?``:void 0}}))}return e===`custom`&&i!=null&&c.push(I({tagName:`slot`,properties:{name:i}})),I({tagName:`div`,children:c,properties:{"data-separator":c.length===0?`simple`:e,"data-expand-index":n,"data-separator-first":a?``:void 0,"data-separator-last":o?``:void 0}})}function xi(e,t){return`hunk-separator-${e}-${t}`}function Si(e){let t=e.at(-1);return t==null?0:Math.max(t.additionStart+t.additionCount,t.deletionStart+t.deletionCount)}function Ci(e){return e.startingLine===0&&e.totalLines===1/0&&e.bufferBefore===0&&e.bufferAfter===0}function wi({line:e,spanStart:t,spanLength:n}){return{start:{line:e,character:t},end:{line:e,character:t+n},properties:{"data-diff-span":``},alwaysWrap:!0}}function Ti({item:e,arr:t,enableJoin:n,isNeutral:r=!1,isLastItem:i=!1}){let a=t[t.length-1];if(a==null||i||!n){t.push([r?0:1,e.value]);return}let o=a[0]===0;if(r===o||r&&e.value.length===1&&!o){a[1]+=e.value;return}t.push([r?0:1,e.value])}function Ei({isPartial:e,rangeSize:t,expandedHunks:n,hunkIndex:r,collapsedContextThreshold:i}){let a=Math.max(t,0);if(a===0||e)return{fromStart:0,fromEnd:0,rangeSize:a,collapsedLines:a,renderAll:!1};if(n===!0||a<=i)return{fromStart:a,fromEnd:0,rangeSize:a,collapsedLines:0,renderAll:!0};let o=n?.get(r),s=Math.min(Math.max(o?.fromStart??0,0),a),c=Math.min(Math.max(o?.fromEnd??0,0),a),l=s+c,u=l>=a;return{fromStart:u?a:s,fromEnd:u?0:c,rangeSize:a,collapsedLines:Math.max(a-l,0),renderAll:u}}function Di({fileDiff:e,errorPrefix:t}){let n=e.hunks[e.hunks.length-1];if(n==null||e.isPartial||e.additionLines.length===0||e.deletionLines.length===0)return 0;let r=e.additionLines.length-(n.additionLineIndex+n.additionCount),i=e.deletionLines.length-(n.deletionLineIndex+n.deletionCount);if(r<=0&&i<=0)return 0;if(r!==i)throw Error(`${t}: trailing context mismatch (additions=${r}, deletions=${i}) for ${e.name}`);return Math.min(r,i)}function Oi({fileDiff:e,hunkIndex:t,expandedHunks:n,collapsedContextThreshold:r,errorPrefix:i}){if(t!==e.hunks.length-1)return;let a=Di({fileDiff:e,errorPrefix:i});if(a<=0)return;if(n===!0||a<=r)return{fromStart:a,fromEnd:0,rangeSize:a,collapsedLines:0,renderAll:!0};let o=n?.get(e.hunks.length),s=Math.min(Math.max(o?.fromStart??0,0),a);return{fromStart:s,fromEnd:0,rangeSize:a,collapsedLines:a-s,renderAll:s>=a}}function ki({type:e,metrics:t}){return t.hunkSeparatorHeight??ir(e)}function Ai({type:e,metrics:t}){return e===`simple`||e===`metadata`||e===`line-info-basic`?0:t.spacing}function ji({type:e,hunkIndex:t,hunkSpecs:n}){switch(e){case`simple`:return t>0;case`metadata`:return n!=null;case`line-info`:case`line-info-basic`:case`custom`:return!0}}function Mi(e){return e!==`simple`&&e!==`metadata`}function Ni({type:e,metrics:t,hunkIndex:n,hunkSpecs:r}){if(!ji({type:e,hunkIndex:n,hunkSpecs:r}))return;let i=ki({type:e,metrics:t}),a=Ai({type:e,metrics:t}),o=n>0?a:0,s=a;return{height:i,gapBefore:o,gapAfter:s,totalHeight:o+i+s}}function Pi({type:e,metrics:t}){if(!Mi(e))return;let n=ki({type:e,metrics:t}),r=Ai({type:e,metrics:t});return{height:n,gapBefore:r,gapAfter:0,totalHeight:r+n}}function Fi({diff:e,diffStyle:t,startingLine:n=0,totalLines:r=1/0,expandedHunks:i,collapsedContextThreshold:a=1,callback:o}){let s=Ii({diff:e,diffStyle:t,startingLine:n,expandedHunks:i,collapsedContextThreshold:a}),c={viewportStart:n,viewportEnd:n+r,isWindowedHighlight:n>0||r<1/0,splitCount:s.splitCount,unifiedCount:s.unifiedCount,finalHunkIndex:e.hunks.length-1,shouldBreak(){if(!c.isWindowedHighlight)return!1;let e=c.unifiedCount>=n+r,i=c.splitCount>=n+r;return t===`unified`?e:(t===`split`||e)&&i},shouldSkip(e,r){if(!c.isWindowedHighlight)return!1;let i=c.unifiedCount+e<n,a=c.splitCount+r<n;return t===`unified`?i:(t===`split`||i)&&a},incrementCounts(e,n){(t===`unified`||t===`both`)&&(c.unifiedCount+=e),(t===`split`||t===`both`)&&(c.splitCount+=n)},isInWindow(e,n){if(!c.isWindowedHighlight)return!0;let r=c.isInUnifiedWindow(e),i=c.isInSplitWindow(n);return t===`unified`?r:t===`split`?i:r||i},isInUnifiedWindow(e){return!c.isWindowedHighlight||c.unifiedCount>=n-e&&c.unifiedCount<n+r},isInSplitWindow(e){return!c.isWindowedHighlight||c.splitCount>=n-e&&c.splitCount<n+r},emit(e,n=!1){return n||(t===`unified`?c.incrementCounts(1,0):t===`split`?c.incrementCounts(0,1):c.incrementCounts(1,1)),o(e)??!1}};hunkIterator:for(let n=s.hunkIndex;n<e.hunks.length;n++){let r=e.hunks[n];if(r==null)throw Error(`iterateOverDiff: invalid hunk index`);if(c.shouldBreak())break;let o=Ei({isPartial:e.isPartial,rangeSize:r.collapsedBefore,expandedHunks:i,hunkIndex:n,collapsedContextThreshold:a}),s=n===c.finalHunkIndex?Oi({fileDiff:e,hunkIndex:n,expandedHunks:i,collapsedContextThreshold:a,errorPrefix:`iterateOverDiff`}):void 0,l=o.fromStart+o.fromEnd;function u(e,n){return s==null||s.collapsedLines<=0||s.fromStart+s.fromEnd>0?0:t===`unified`?e===r.unifiedLineStart+r.unifiedLineCount-1?s.collapsedLines:0:n===r.splitLineStart+r.splitLineCount-1?s.collapsedLines:0}let d=o.collapsedLines===0;function f(){return d?0:(d=!0,o.collapsedLines)}if(c.shouldSkip(l,l))c.incrementCounts(l,l),f();else{let e=r.unifiedLineStart-o.rangeSize,i=r.splitLineStart-o.rangeSize,a=r.deletionLineIndex-o.rangeSize,s=r.additionLineIndex-o.rangeSize,l=r.deletionStart-o.rangeSize,u=r.additionStart-o.rangeSize;if(zi(c,o.fromStart,t,t=>c.emit({hunkIndex:n,hunk:r,collapsedBefore:0,collapsedAfter:0,type:`context-expanded`,deletionLine:{lineNumber:l+t,lineIndex:a+t,noEOFCR:!1,unifiedLineIndex:e+t,splitLineIndex:i+t},additionLine:{unifiedLineIndex:e+t,splitLineIndex:i+t,lineIndex:s+t,lineNumber:u+t,noEOFCR:!1}}))||(e=r.unifiedLineStart-o.fromEnd,i=r.splitLineStart-o.fromEnd,a=r.deletionLineIndex-o.fromEnd,s=r.additionLineIndex-o.fromEnd,l=r.deletionStart-o.fromEnd,u=r.additionStart-o.fromEnd,zi(c,o.fromEnd,t,t=>c.emit({hunkIndex:n,hunk:r,collapsedBefore:f(),collapsedAfter:0,type:`context-expanded`,deletionLine:{lineNumber:l+t,lineIndex:a+t,noEOFCR:!1,unifiedLineIndex:e+t,splitLineIndex:i+t},additionLine:{unifiedLineIndex:e+t,splitLineIndex:i+t,lineIndex:s+t,lineNumber:u+t,noEOFCR:!1}}),()=>{f()})))break hunkIterator}let p=r.unifiedLineStart,m=r.splitLineStart,h=r.deletionLineIndex,g=r.additionLineIndex,_=r.deletionStart,v=r.additionStart,y=r.hunkContent.at(-1);for(let e of r.hunkContent){if(c.shouldBreak())break hunkIterator;let i=e===y;if(e.type===`context`){if(c.shouldSkip(e.lines,e.lines))c.incrementCounts(e.lines,e.lines),f();else if(zi(c,e.lines,t,t=>{let a=i&&t===e.lines-1,o=p+t,s=m+t;return c.emit({hunkIndex:n,hunk:r,collapsedBefore:f(),collapsedAfter:u(o,s),type:`context`,deletionLine:{lineNumber:_+t,lineIndex:h+t,noEOFCR:a&&r.noEOFCRDeletions,unifiedLineIndex:o,splitLineIndex:s},additionLine:{unifiedLineIndex:o,splitLineIndex:s,lineIndex:g+t,lineNumber:v+t,noEOFCR:a&&r.noEOFCRAdditions}})},()=>{f()}))break hunkIterator;p+=e.lines,m+=e.lines,h+=e.lines,g+=e.lines,_+=e.lines,v+=e.lines}else{let a=Math.max(e.deletions,e.additions),o=e.deletions+e.additions;if(!c.shouldSkip(o,a)){let s=Bi(c,e,t);(s[0]?.[0]??0)>0&&f();for(let[l,d]of s)for(let s=l;s<d;s++){let l=u(p+s,t===`unified`?m+(s<e.deletions?s:s-e.deletions):m+s);if(c.emit(Vi({hunkIndex:n,hunk:r,collapsedBefore:f(),collapsedAfter:l,diffStyle:t,index:s,unifiedLineIndex:p,splitLineIndex:m,additionLineIndex:g,deletionLineIndex:h,additionLineNumber:v,deletionLineNumber:_,content:e,isLastContent:i,unifiedCount:o,splitCount:a}),!0))break hunkIterator}}f(),c.incrementCounts(o,a),p+=o,m+=a,h+=e.deletions,g+=e.additions,_+=e.deletions,v+=e.additions}}if(s!=null){let{collapsedLines:n,fromStart:r,fromEnd:i}=s,a=r+i;if(zi(c,a,t,t=>{let r=t===a-1;return c.emit({hunkIndex:e.hunks.length,hunk:void 0,collapsedBefore:0,collapsedAfter:r?n:0,type:`context-expanded`,deletionLine:{lineNumber:_+t,lineIndex:h+t,noEOFCR:!1,unifiedLineIndex:p+t,splitLineIndex:m+t},additionLine:{unifiedLineIndex:p+t,splitLineIndex:m+t,lineIndex:g+t,lineNumber:v+t,noEOFCR:!1}})},void 0,()=>c.shouldBreak()))break hunkIterator}}}function Ii({diff:e,diffStyle:t,startingLine:n,expandedHunks:r,collapsedContextThreshold:i}){if(n<=0||t===`both`)return{hunkIndex:0,splitCount:0,unifiedCount:0};let a=Li({diff:e,expandedHunks:r,collapsedContextThreshold:i}),o=0,s=e.hunks.length-1,c=e.hunks.length;for(;o<=s;){let e=o+s>>1,r=a[e+1];if(r==null)throw Error(`iterateOverDiff: invalid hunk prefix index`);(t===`unified`?r.unifiedCount:r.splitCount)>n?(c=e,s=e-1):o=e+1}if(c>=e.hunks.length){let t=a[e.hunks.length];if(t==null)throw Error(`iterateOverDiff: invalid terminal hunk prefix index`);return{hunkIndex:e.hunks.length,splitCount:t.splitCount,unifiedCount:t.unifiedCount}}let l=a[c];if(l==null)throw Error(`iterateOverDiff: invalid selected hunk prefix index`);return{hunkIndex:c,splitCount:l.splitCount,unifiedCount:l.unifiedCount}}function Li({diff:e,expandedHunks:t,collapsedContextThreshold:n}){let r=0,i=0,a=e.hunks.length-1,o=[{splitCount:0,unifiedCount:0}];for(let s=0;s<e.hunks.length;s++){let c=e.hunks[s];if(c==null)throw Error(`iterateOverDiff: invalid hunk summary index`);let l=Ei({isPartial:e.isPartial,rangeSize:c.collapsedBefore,expandedHunks:t,hunkIndex:s,collapsedContextThreshold:n}),u=l.fromStart+l.fromEnd;r+=u+c.splitLineCount,i+=u+c.unifiedLineCount;let d=s===a?Oi({fileDiff:e,hunkIndex:s,expandedHunks:t,collapsedContextThreshold:n,errorPrefix:`iterateOverDiff`}):void 0;if(d!=null){let e=d.fromStart+d.fromEnd;r+=e,i+=e}o.push({splitCount:r,unifiedCount:i})}return o}function Ri(e,t,n){if(!e.isWindowedHighlight||t<=0)return[0,t];let r=[];function i(n){let i=Math.max(0,e.viewportStart-n),a=Math.min(t,e.viewportEnd-n);a>i&&r.push([i,a])}if(n!==`split`&&i(e.unifiedCount),n!==`unified`&&i(e.splitCount),r.length===0)return[0,0];let a=r[0][0],o=r[0][1];for(let e=1;e<r.length;e++){let t=r[e];a=Math.min(a,t[0]),o=Math.max(o,t[1])}return[a,o]}function zi(e,t,n,r,i,a){let[o,s]=Ri(e,t,n);o>0&&(e.incrementCounts(o,o),i?.());let c=o;for(;c<t;){if(a?.()===!0)return!0;if(c>=s){e.incrementCounts(t-c,t-c);break}if(e.isInWindow(0,0)){if(r(c)===!0)return!0}else e.incrementCounts(1,1);c++}return!1}function Bi(e,t,n){if(!e.isWindowedHighlight)return[[0,n===`unified`?t.deletions+t.additions:Math.max(t.deletions,t.additions)]];let r=n!==`split`,i=n!==`unified`,a=n===`unified`?`unified`:`split`,o=[];function s(t,n){if(t+n<=e.viewportStart||t>=e.viewportEnd)return;let r=Math.max(0,e.viewportStart-t),i=Math.min(n,e.viewportEnd-t);return i>r?[r,i]:void 0}function c(e,n){return a===`split`?e:n===`additions`?[e[0]+t.deletions,e[1]+t.deletions]:e}function l(e,t){if(e==null)return;let[n,r]=c(e,t);r>n&&o.push([n,r])}if(r&&(l(s(e.unifiedCount,t.deletions),`deletions`),l(s(e.unifiedCount+t.deletions,t.additions),`additions`)),i&&(l(s(e.splitCount,t.deletions),`deletions`),l(s(e.splitCount,t.additions),`additions`)),o.length===0)return o;o.sort((e,t)=>e[0]-t[0]);let u=[o[0]];for(let[e,t]of o.slice(1)){let n=u[u.length-1];e<=n[1]?n[1]=Math.max(n[1],t):u.push([e,t])}return u}function Vi({hunkIndex:e,hunk:t,collapsedAfter:n,collapsedBefore:r,diffStyle:i,index:a,unifiedLineIndex:o,splitLineIndex:s,additionLineIndex:c,deletionLineIndex:l,additionLineNumber:u,deletionLineNumber:d,content:f,isLastContent:p,unifiedCount:m,splitCount:h}){let g=a<f.deletions?o+a:void 0,_=i===`unified`?a>=f.deletions?o+a:void 0:a<f.additions?o+f.deletions+a:void 0,v=i===`unified`?s+(a<f.deletions?a:a-f.deletions):s+a,y=a<f.deletions?l+a:void 0,b=a<f.deletions?d+a:void 0,x=i===`unified`?a>=f.deletions?c+(a-f.deletions):void 0:a<f.additions?c+a:void 0,S=i===`unified`?a>=f.deletions?u+(a-f.deletions):void 0:a<f.additions?u+a:void 0,C=i===`unified`?p&&a===f.deletions-1&&t.noEOFCRDeletions:p&&a===h-1&&t.noEOFCRDeletions,w=i===`unified`?p&&a===m-1&&t.noEOFCRAdditions:p&&a===h-1&&t.noEOFCRAdditions,T=y!=null&&b!=null&&g!=null?{lineNumber:b,lineIndex:y,noEOFCR:C,unifiedLineIndex:g,splitLineIndex:v}:void 0,E=x!=null&&S!=null&&_!=null?{unifiedLineIndex:_,splitLineIndex:v,lineIndex:x,lineNumber:S,noEOFCR:w}:void 0;if(T==null&&E!=null)return{type:`change`,hunkIndex:e,hunk:t,collapsedAfter:n,collapsedBefore:r,deletionLine:void 0,additionLine:E};if(T!=null&&E==null)return{type:`change`,hunkIndex:e,hunk:t,collapsedAfter:n,collapsedBefore:r,deletionLine:T,additionLine:void 0};if(T==null||E==null)throw Error(`iterateOverDiff: missing change line data`);return{type:`change`,hunkIndex:e,hunk:t,collapsedAfter:n,collapsedBefore:r,deletionLine:T,additionLine:E}}var Hi={forcePlainText:!1};function Ui(e,t,n,{forcePlainText:r,startingLine:i,totalLines:a,expandedHunks:o,collapsedContextThreshold:s=1}=Hi){r?(i??=0,a??=1/0):(i=0,a=1/0);let c=i>0||a<1/0,l=typeof n.theme==`string`?t.getTheme(n.theme).type:void 0,u=Cn({theme:n.theme,highlighter:t}),d=r&&!c&&(e.unifiedLineCount>1e3||e.splitLineCount>1e3)?`none`:n.lineDiffType,f={deletionLines:[],additionLines:[]},{maxLineDiffLength:p}=n,m=!r&&!e.isPartial,h=r?o:void 0,g=new Map;function _(e){let t=m?0:e,n=g.get(t)??Gi();return g.set(t,n),n}function v(e,t,n,r){if(c){let e=n.at(-1);(e==null||e.targetIndex+e.count!==t)&&(e={targetIndex:t,originalOffset:r.length,count:0},n.push(e)),e.count++}r.push(e)}Fi({diff:e,diffStyle:`both`,startingLine:i,totalLines:a,expandedHunks:c?h:!0,collapsedContextThreshold:s,callback:({hunkIndex:t,additionLine:n,deletionLine:r,type:i})=>{let a=_(t),o=n==null?r.splitLineIndex:n.splitLineIndex;i===`change`&&n!=null&&r!=null&&Wi({additionLine:e.additionLines[n.lineIndex],deletionLine:e.deletionLines[r.lineIndex],deletionLineIndex:a.deletionContent.length,additionLineIndex:a.additionContent.length,deletionDecorations:a.deletionDecorations,additionDecorations:a.additionDecorations,lineDiffType:d,maxLineDiffLength:p}),r!=null&&(v(e.deletionLines[r.lineIndex],r.lineIndex,a.deletionSegments,a.deletionContent),a.deletionInfo.push({type:i===`change`?`change-deletion`:i,lineNumber:r.lineNumber,altLineNumber:i===`change`?void 0:n.lineNumber??void 0,lineIndex:`${r.unifiedLineIndex},${o}`})),n!=null&&(v(e.additionLines[n.lineIndex],n.lineIndex,a.additionSegments,a.additionContent),a.additionInfo.push({type:i===`change`?`change-addition`:i,lineNumber:n.lineNumber,altLineNumber:i===`change`?void 0:r.lineNumber??void 0,lineIndex:`${n.unifiedLineIndex},${o}`}))}});for(let i of g.values()){if(i.deletionContent.length===0&&i.additionContent.length===0)continue;let a={name:e.prevName??e.name,contents:i.deletionContent.value},o={name:e.name,contents:i.additionContent.value},{deletionLines:s,additionLines:c}=Ki({deletionFile:a,deletionInfo:i.deletionInfo,deletionDecorations:i.deletionDecorations,additionFile:o,additionInfo:i.additionInfo,additionDecorations:i.additionDecorations,highlighter:t,options:n,languageOverride:r?`text`:e.lang});if(m){f.deletionLines=s,f.additionLines=c;continue}if(i.deletionSegments.length>0)for(let e of i.deletionSegments)for(let t=0;t<e.count;t++)f.deletionLines[e.targetIndex+t]=s[e.originalOffset+t];else f.deletionLines.push(...s);if(i.additionSegments.length>0)for(let e of i.additionSegments)for(let t=0;t<e.count;t++)f.additionLines[e.targetIndex+t]=c[e.originalOffset+t];else f.additionLines.push(...c)}return{code:f,themeStyles:u,baseThemeType:l}}function Wi({deletionLine:e,additionLine:t,deletionLineIndex:n,additionLineIndex:r,deletionDecorations:i,additionDecorations:a,lineDiffType:o,maxLineDiffLength:s}){if(e==null||t==null||o===`none`||(e=W(e),t=W(t),e.length>s||t.length>s))return;let c=o===`char`?zr(e,t):ni(e,t),l=[],u=[],d=o===`word-alt`,f=c.at(-1);for(let e of c){let t=e===f;!e.added&&!e.removed?(Ti({item:e,arr:l,enableJoin:d,isNeutral:!0,isLastItem:t}),Ti({item:e,arr:u,enableJoin:d,isNeutral:!0,isLastItem:t})):e.removed?Ti({item:e,arr:l,enableJoin:d,isLastItem:t}):Ti({item:e,arr:u,enableJoin:d,isLastItem:t})}let p=0;for(let e of l)e[0]===1&&i.push(wi({line:n,spanStart:p,spanLength:e[1].length})),p+=e[1].length;p=0;for(let e of u)e[0]===1&&a.push(wi({line:r,spanStart:p,spanLength:e[1].length})),p+=e[1].length}function Gi(){return{deletionContent:{push(e){this.value+=e,this.length++},value:``,length:0},additionContent:{push(e){this.value+=e,this.length++},value:``,length:0},deletionInfo:[],additionInfo:[],deletionDecorations:[],additionDecorations:[],deletionSegments:[],additionSegments:[]}}function Ki({deletionFile:e,additionFile:t,deletionInfo:n,additionInfo:r,highlighter:i,deletionDecorations:a,additionDecorations:o,languageOverride:s,options:{theme:c=P,...l}}){let u=s??H(e.name),d=s??H(t.name),{state:f,transformers:p}=ln(l.useTokenTransformer),m=typeof c==`string`?{...l,lang:`text`,theme:c,transformers:p,decorations:void 0,defaultColor:!1,cssVariablePrefix:G(`token`),tokenizeTimeLimit:0}:{...l,lang:`text`,themes:c,transformers:p,decorations:void 0,defaultColor:!1,cssVariablePrefix:G(`token`),tokenizeTimeLimit:0};return{deletionLines:e.contents===``?[]:(m.lang=u,f.lineInfo=n,m.decorations=a,Tn(i.codeToHast(W(e.contents),m))),additionLines:t.contents===``?[]:(m.lang=d,m.decorations=o,f.lineInfo=r,Tn(i.codeToHast(W(t.contents),m)))}}function qi(e){let t=e.lang??H(e.name),n=e.lang??(e.prevName==null?`text`:H(e.prevName));return t===`text`&&n===`text`}var Ji=-1,Yi=class{options;onRenderUpdate;workerManager;__id=`diff-hunks-renderer:${++Ji}`;highlighter;diff;expandedHunks=new Map;deletionAnnotations={};additionAnnotations={};computedLang=`text`;renderCache;constructor(e={theme:P},t,n){this.options=e,this.onRenderUpdate=t,this.workerManager=n,n?.isWorkingPool()!==!0&&(this.highlighter=Vt(e.theme??P)?Rt():void 0)}cleanUp(){this.recycle(),this.expandedHunks.clear(),this.workerManager=void 0,this.onRenderUpdate=void 0}recycle(){this.highlighter=void 0,this.diff=void 0,this.clearRenderCache(),this.additionAnnotations={},this.deletionAnnotations={},this.workerManager?.cleanUpTasks(this)}clearRenderCache(){this.renderCache=void 0}setOptions(e){this.options=e}mergeOptions(e){this.options={...this.options,...e}}expandHunk(e,t,n=this.getOptionsWithDefaults().expansionLineCount){let r={...this.expandedHunks.get(e)??{fromStart:0,fromEnd:0}};(t===`up`||t===`both`)&&(r.fromStart+=n),(t===`down`||t===`both`)&&(r.fromEnd+=n),this.renderCache?.highlighted!==!0&&this.clearRenderCache(),this.expandedHunks.set(e,r)}getExpandedHunk(e){return this.expandedHunks.get(e)??le}getExpandedHunksMap(){return this.expandedHunks}setLineAnnotations(e){this.additionAnnotations={},this.deletionAnnotations={};for(let t of e){let e=(()=>{switch(t.side){case`deletions`:return this.deletionAnnotations;case`additions`:return this.additionAnnotations}})(),n=e[t.lineNumber]??[];e[t.lineNumber]=n,n.push(t)}}getUnifiedLineDecoration({lineType:e}){return{gutterLineType:e}}getSplitLineDecoration({side:e,type:t}){return t===`change`?{gutterLineType:e===`deletions`?`change-deletion`:`change-addition`}:{gutterLineType:t}}createAnnotationElement=e=>Wt(e);getOptionsWithDefaults(){let{diffIndicators:e=`bars`,diffStyle:t=`split`,disableBackground:n=!1,disableFileHeader:r=!1,disableLineNumbers:i=!1,disableVirtualizationBuffers:a=!1,collapsed:o=!1,expandUnchanged:s=!1,collapsedContextThreshold:c=1,expansionLineCount:l=100,hunkSeparators:u=`line-info`,lineDiffType:d=`word-alt`,maxLineDiffLength:f=1e3,overflow:p=`scroll`,stickyHeader:m=!1,theme:h=P,headerRenderMode:g=`default`,tokenizeMaxLineLength:_=1e3,tokenizeMaxLength:v=se,useTokenTransformer:y=!1,useCSSClasses:b=!1}=this.options;return{diffIndicators:e,diffStyle:t,disableBackground:n,disableFileHeader:r,disableLineNumbers:i,disableVirtualizationBuffers:a,collapsed:o,expandUnchanged:s,collapsedContextThreshold:c,expansionLineCount:l,hunkSeparators:u,lineDiffType:d,maxLineDiffLength:f,overflow:p,stickyHeader:m,theme:this.workerManager?.getDiffRenderOptions().theme??h,headerRenderMode:g,tokenizeMaxLineLength:_,tokenizeMaxLength:v,useTokenTransformer:y,useCSSClasses:b}}async initializeHighlighter(){return this.highlighter=await Lt(Qt(this.computedLang,this.options)),this.highlighter}hydrate(e){if(e==null)return;this.diff=e;let{options:t}=this.getRenderOptions(e),n=ia(e,this.getTokenizeMaxLength()),r=this.workerManager?.getDiffResultCache(e);r!=null&&!gi(t,r.options)&&(r=void 0),this.renderCache??={diff:e,highlighted:!n&&!qi(e),options:t,result:n?void 0:r?.result,renderRange:void 0},this.workerManager?.isWorkingPool()===!0?this.renderCache.result==null&&!n&&this.workerManager.highlightDiffAST(this,this.diff):this.highlighter??(this.computedLang=e.lang??H(e.name),this.initializeHighlighter())}getRenderOptions(e){let t=(()=>{if(this.workerManager?.isWorkingPool()===!0)return this.workerManager.getDiffRenderOptions();let{theme:e,tokenizeMaxLineLength:t,lineDiffType:n,maxLineDiffLength:r}=this.getOptionsWithDefaults();return{theme:e,useTokenTransformer:jn(this.options),tokenizeMaxLineLength:t,lineDiffType:n,maxLineDiffLength:r}})();this.getOptionsWithDefaults();let{renderCache:n}=this;return n?.result==null||!ar(e,n.diff)||!gi(t,n.options)?{options:t,forceHighlight:!0}:{options:t,forceHighlight:!1}}renderDiff(e=this.renderCache?.diff,t=ue){if(e==null)return;let{expandUnchanged:n=!1,collapsedContextThreshold:r}=this.getOptionsWithDefaults(),{options:i,forceHighlight:a}=this.getRenderOptions(e),o=this.getMatchingWorkerResultCache(e,i);o!=null&&!this.hasHighlightedRenderCache(e,i)&&(this.renderCache={diff:e,highlighted:!0,renderRange:void 0,...o},a=!1),this.renderCache??={diff:e,highlighted:!1,options:i,result:void 0,renderRange:void 0};let s=e.additionLines.length>0||e.deletionLines.length>0,c=!s||qi(e)||ia(e,this.getTokenizeMaxLength()),l=!ar(e,this.renderCache.diff),u=!Ut(this.renderCache.renderRange,t);if(this.workerManager?.isWorkingPool()===!0)(c||this.renderCache.result==null||!this.renderCache.highlighted&&(l||u))&&(this.renderCache.diff=e,this.renderCache.options=i,this.renderCache.highlighted=!1,(this.renderCache.result==null||l||u||a)&&(this.renderCache.result=this.workerManager.getPlainDiffAST(e,t.startingLine,t.totalLines,Ci(t)||n?!0:this.expandedHunks,r)),this.renderCache.renderRange=t),!c&&s&&(!this.renderCache.highlighted||a)&&this.workerManager.highlightDiffAST(this,e);else{this.computedLang=e.lang??H(e.name);let t=this.highlighter!=null&&Vt(i.theme),n=this.highlighter!=null&&Xe(this.computedLang),r=!c&&n;if(this.highlighter!=null&&t&&(a||c||!this.renderCache.highlighted&&r||this.renderCache.result==null)){let{result:t,options:i}=this.renderDiffWithHighlighter(e,this.highlighter,c||!n);this.renderCache={diff:e,options:i,highlighted:r,result:t,renderRange:void 0}}(!t||!c&&!n)&&this.asyncHighlight(e).then(({result:t,options:n})=>{this.renderCache!=null&&(this.renderCache.highlighted=!1),this.onHighlightSuccess(e,t,n,!c)})}return this.renderCache.result==null?void 0:this.processDiffResult(this.renderCache.diff,t,this.renderCache.result)}async asyncRender(e,t=ue){let{result:n}=await this.asyncHighlight(e);return this.processDiffResult(e,t,n)}createPreElement(e,t,n){let{diffIndicators:r,disableBackground:i,disableLineNumbers:a,overflow:o}=this.getOptionsWithDefaults();return Yt({type:`diff`,diffIndicators:r,disableBackground:i,disableLineNumbers:a,overflow:o,split:e,totalLines:t,customProperties:n})}async asyncHighlight(e){let t=ia(e,this.getTokenizeMaxLength());this.computedLang=t?`text`:e.lang??H(e.name);let n=this.highlighter!=null&&Vt(this.options.theme??P),r=t||this.highlighter!=null&&Xe(this.computedLang);return(this.highlighter==null||!n||!r)&&(this.highlighter=await this.initializeHighlighter()),this.renderDiffWithHighlighter(e,this.highlighter,t)}renderDiffWithHighlighter(e,t,n=!1){let{options:r}=this.getRenderOptions(e),{collapsedContextThreshold:i}=this.getOptionsWithDefaults();return{result:Ui(e,t,r,{forcePlainText:n,expandedHunks:n?!0:void 0,collapsedContextThreshold:i}),options:r}}onHighlightSuccess(e,t,n,r=!0){if(this.renderCache==null)return;let i=!this.renderCache.highlighted||!gi(this.renderCache.options,n)||!ar(this.renderCache.diff,e);this.renderCache={diff:e,options:n,highlighted:r,result:t,renderRange:void 0},i&&this.onRenderUpdate?.()}getMatchingWorkerResultCache(e,t){let n=this.workerManager?.getDiffResultCache(e);if(!(n==null||!gi(t,n.options)))return n}hasHighlightedRenderCache(e,t){let{renderCache:n}=this;return n?.result!=null&&n.highlighted&&ar(e,n.diff)&&gi(t,n.options)}onHighlightError(e){console.error(e)}getTokenizeMaxLength(){return this.options.tokenizeMaxLength??1e5}processDiffResult(e,t,{code:n,themeStyles:r,baseThemeType:i}){let{diffStyle:a,disableFileHeader:o,expandUnchanged:s,expansionLineCount:c,collapsedContextThreshold:l,hunkSeparators:u}=this.getOptionsWithDefaults();this.diff=e;let d=a===`unified`,f=[],p=[],m=[],h=[],{additionLines:g,deletionLines:_}=n,v={rowCount:0,hunkSeparators:u,additionsContentAST:f,deletionsContentAST:p,unifiedContentAST:m,unifiedGutterAST:ye(),deletionsGutterAST:ye(),additionsGutterAST:ye(),expansionLineCount:c,hunkData:h,incrementRowCount(e=1){v.rowCount+=e},pushToGutter(e,t){switch(e){case`unified`:v.unifiedGutterAST.children.push(t);break;case`deletions`:v.deletionsGutterAST.children.push(t);break;case`additions`:v.additionsGutterAST.children.push(t);break}}},y=Di({fileDiff:e,errorPrefix:`DiffHunksRenderer.processDiffResult`}),b={size:0,side:void 0,increment(){this.size+=1},flush(){if(a!==`unified`){if(this.size<=0||this.side==null){this.side=void 0,this.size=0;return}this.side===`additions`?(v.pushToGutter(`additions`,L(void 0,`buffer`,this.size)),f?.push(_i(this.size))):(v.pushToGutter(`deletions`,L(void 0,`buffer`,this.size)),p?.push(_i(this.size))),this.size=0,this.side=void 0}}},x=(e,t,n,r,i)=>{v.pushToGutter(e,be(t,n,r,i))};function S(e){b.flush(),a===`unified`?na(`unified`,e,v):(na(`deletions`,e,v),na(`additions`,e,v))}this.pushFileLevelAnnotations(e,a,t,v),Fi({diff:e,diffStyle:a,startingLine:t.startingLine,totalLines:t.totalLines,expandedHunks:s?!0:this.expandedHunks,collapsedContextThreshold:l,callback:({hunkIndex:t,hunk:n,collapsedBefore:r,collapsedAfter:i,additionLine:o,deletionLine:s,type:c})=>{let l=s==null?o.splitLineIndex:s.splitLineIndex,d=o==null?s.unifiedLineIndex:o.unifiedLineIndex;a===`split`&&c!==`change`&&b.flush(),r>0&&S({hunkIndex:t,collapsedLines:r,rangeSize:Math.max(n?.collapsedBefore??0,0),hunkSpecs:n?.hunkSpecs,isFirstHunk:t===0,isLastHunk:!1,isExpandable:!e.isPartial});let f=a===`unified`?d:l,p={type:c,hunkIndex:t,lineIndex:f,unifiedLineIndex:d,splitLineIndex:l,deletionLine:s,additionLine:o};if(a===`unified`){let n=this.getUnifiedInjectedRowsForLine?.(p);n?.before!=null&&$i(n.before,v);let r=s==null?void 0:_[s.lineIndex],i=o==null?void 0:g[o.lineIndex];if(r==null&&i==null){let t=`DiffHunksRenderer.processDiffResult: deletionLine and additionLine are null, something is wrong`;throw console.error(t,{file:e.name}),Error(t)}let a=c===`change`?o==null?`change-deletion`:`change-addition`:c,u=this.getUnifiedLineDecoration({type:c,lineType:a,additionLineIndex:o?.lineIndex,deletionLineIndex:s?.lineIndex});x(`unified`,u.gutterLineType,o==null?s.lineNumber:o.lineNumber,`${d},${l}`,u.gutterProperties),i==null?r!=null&&(r=ra(r,u.contentProperties)):i=ra(i,u.contentProperties),ta({diffStyle:`unified`,type:c,deletionLine:r,additionLine:i,unifiedSpan:this.getAnnotations(`unified`,s?.lineNumber,o?.lineNumber,t,f),createAnnotationElement:e=>this.createAnnotationElement(e),context:v}),n?.after!=null&&$i(n.after,v)}else{let n=this.getSplitInjectedRowsForLine?.(p);n?.before!=null&&ea(n.before,v,b);let r=s==null?void 0:_[s.lineIndex],i=o==null?void 0:g[o.lineIndex],a=this.getSplitLineDecoration({side:`deletions`,type:c,lineIndex:s?.lineIndex}),u=this.getSplitLineDecoration({side:`additions`,type:c,lineIndex:o?.lineIndex});if(r==null&&i==null){let t=`DiffHunksRenderer.processDiffResult: deletionLine and additionLine are null, something is wrong`;throw console.error(t,{file:e.name}),Error(t)}let d=(()=>{if(c===`change`){if(i==null)return`additions`;if(r==null)return`deletions`}})();if(d!=null){if(b.side!=null&&b.side!==d)throw Error(`DiffHunksRenderer.processDiffResult: iterateOverDiff, invalid pending splits`);b.side=d,b.increment()}let m=this.getAnnotations(`split`,s?.lineNumber,o?.lineNumber,t,f);if(m!=null&&b.size>0&&b.flush(),s!=null){let e=ra(r,a.contentProperties);x(`deletions`,a.gutterLineType,s.lineNumber,`${s.unifiedLineIndex},${l}`,a.gutterProperties),e!=null&&(r=e)}if(o!=null){let e=ra(i,u.contentProperties);x(`additions`,u.gutterLineType,o.lineNumber,`${o.unifiedLineIndex},${l}`,u.gutterProperties),e!=null&&(i=e)}ta({diffStyle:`split`,type:c,additionLine:i,deletionLine:r,...m,createAnnotationElement:e=>this.createAnnotationElement(e),context:v}),n?.after!=null&&ea(n.after,v,b)}let m=a===`split`&&n!=null&&l===n.splitLineStart+n.splitLineCount-1,h=m?n.noEOFCRDeletions:!1,C=m?n.noEOFCRAdditions:!1,w=(s?.noEOFCR??!1)||h,T=(o?.noEOFCR??!1)||C;if(T||w){if(a===`split`&&b.flush(),w){let e=c===`context`||c===`context-expanded`?c:`change-deletion`;a===`unified`?(v.unifiedContentAST.push(vi(e)),v.pushToGutter(`unified`,L(e,`metadata`,1))):(v.deletionsContentAST.push(vi(e)),v.pushToGutter(`deletions`,L(e,`metadata`,1)),T||(v.pushToGutter(`additions`,L(void 0,`buffer`,1)),v.additionsContentAST.push(_i(1))))}if(T){let e=c===`context`||c===`context-expanded`?c:`change-addition`;a===`unified`?(v.unifiedContentAST.push(vi(e)),v.pushToGutter(`unified`,L(e,`metadata`,1))):(v.additionsContentAST.push(vi(e)),v.pushToGutter(`additions`,L(e,`metadata`,1)),w||(v.pushToGutter(`deletions`,L(void 0,`buffer`,1)),v.deletionsContentAST.push(_i(1))))}v.incrementRowCount(1)}i>0&&u!==`simple`&&S({hunkIndex:c===`context-expanded`?t:t+1,collapsedLines:i,rangeSize:y,hunkSpecs:void 0,isFirstHunk:!1,isLastHunk:!0,isExpandable:!e.isPartial}),v.incrementRowCount(1)}}),a===`split`&&b.flush();let C=Math.max(Si(e.hunks),e.additionLines.length??0,e.deletionLines.length??0),w=t.bufferBefore>0||t.bufferAfter>0,T=!d&&e.type!==`deleted`,E=!d&&e.type!==`new`,D=v.rowCount>0||w;f=T&&D?f:void 0,p=E&&D?p:void 0,m=d&&D?m:void 0;let O=this.createPreElement(p!=null&&f!=null,C);return{unifiedGutterAST:d&&D?v.unifiedGutterAST.children:void 0,unifiedContentAST:m,deletionsGutterAST:E&&D?v.deletionsGutterAST.children:void 0,deletionsContentAST:p,additionsGutterAST:T&&D?v.additionsGutterAST.children:void 0,additionsContentAST:f,hunkData:h,preNode:O,themeStyles:r,baseThemeType:i,headerElement:o?void 0:this.renderHeader(this.diff),totalLines:C,rowCount:v.rowCount,bufferBefore:t.bufferBefore,bufferAfter:t.bufferAfter,css:``}}renderCodeAST(e,t){let n=e===`unified`?t.unifiedGutterAST:e===`deletions`?t.deletionsGutterAST:t.additionsGutterAST,r=e===`unified`?t.unifiedContentAST:e===`deletions`?t.deletionsContentAST:t.additionsContentAST;if(n==null||r==null)return;let i=ye(n);return i.properties.style=`grid-row: span ${t.rowCount}`,[i,An(r,t.rowCount)]}renderFullAST(e,t=[]){let n=this.getOptionsWithDefaults().hunkSeparators===`line-info`,r=this.renderCodeAST(`unified`,e);if(r!=null)return t.push(I({tagName:`code`,children:r,properties:{"data-code":``,"data-container-size":n?``:void 0,"data-unified":``}})),{...e.preNode,children:t};let i=this.renderCodeAST(`deletions`,e);i!=null&&t.push(I({tagName:`code`,children:i,properties:{"data-code":``,"data-container-size":n?``:void 0,"data-deletions":``}}));let a=this.renderCodeAST(`additions`,e);return a!=null&&t.push(I({tagName:`code`,children:a,properties:{"data-code":``,"data-container-size":n?``:void 0,"data-additions":``}})),{...e.preNode,children:t}}renderFullHTML(e,t=[]){return x(this.renderFullAST(e,t))}renderPartialHTML(e,t){return x(t==null?e:I({tagName:`code`,children:e,properties:{"data-code":``,"data-container-size":this.getOptionsWithDefaults().hunkSeparators===`line-info`?``:void 0,[`data-${t}`]:``}}))}pushFileLevelAnnotations(e,t,n,r){if(!kn(n))return;let i=e.type===`new`?[]:Xi(On(this.deletionAnnotations)),a=e.type===`deleted`?[]:Xi(On(this.additionAnnotations));if(i.length===0&&a.length===0)return;let{createAnnotationElement:o}=this;if(t===`unified`){ta({diffStyle:t,type:`context`,unifiedSpan:{type:`annotation`,hunkIndex:-1,lineIndex:-1,annotations:i.concat(a)},createAnnotationElement:o,context:r});return}ta({diffStyle:t,type:`context`,deletionSpan:{type:`annotation`,hunkIndex:-1,lineIndex:-1,annotations:i},additionSpan:{type:`annotation`,hunkIndex:-1,lineIndex:-1,annotations:a},createAnnotationElement:o,context:r})}getAnnotations(e,t,n,r,i){let a={type:`annotation`,hunkIndex:r,lineIndex:i,annotations:[]};if(t!=null)for(let e of this.deletionAnnotations[t]??[])a.annotations.push(U(e));let o={type:`annotation`,hunkIndex:r,lineIndex:i,annotations:[]};if(n!=null)for(let t of this.additionAnnotations[n]??[])(e===`unified`?a:o).annotations.push(U(t));if(e===`unified`)return a.annotations.length>0?a:void 0;if(!(o.annotations.length===0&&a.annotations.length===0))return{deletionSpan:a,additionSpan:o}}renderHeader(e){let{headerRenderMode:t,stickyHeader:n}=this.getOptionsWithDefaults();return Kt({fileOrDiff:e,mode:t,stickyHeader:n})}};function Xi(e){return e?.map(e=>U(e))??[]}var Zi=new Intl.PluralRules(`en-US`);function Qi(e){return`${e} unmodified line${Zi.select(e)===`one`?``:`s`}`}function $i(e,t){for(let n of e)t.unifiedContentAST.push(n.content),t.pushToGutter(`unified`,n.gutter),t.incrementRowCount(1)}function ea(e,t,n){for(let{deletion:r,addition:i}of e){if(r==null&&i==null)continue;let e=r!=null&&i!=null?void 0:r==null?`deletions`:`additions`;(e==null||n.side!==e)&&n.flush(),r!=null&&(t.deletionsContentAST.push(r.content),t.pushToGutter(`deletions`,r.gutter)),i!=null&&(t.additionsContentAST.push(i.content),t.pushToGutter(`additions`,i.gutter)),e!=null&&(n.side=e,n.increment()),t.incrementRowCount(1)}}function ta({diffStyle:e,type:t,deletionLine:n,additionLine:r,unifiedSpan:i,deletionSpan:a,additionSpan:o,createAnnotationElement:s,context:c}){let l=!1;if(e===`unified`){if(r==null?n!=null&&c.unifiedContentAST.push(n):c.unifiedContentAST.push(r),i!=null){let e=t===`change`?n==null?`change-addition`:`change-deletion`:t;c.unifiedContentAST.push(s(i)),c.pushToGutter(`unified`,L(e,`annotation`,1)),l=!0}}else if(e===`split`){if(n!=null&&c.deletionsContentAST.push(n),r!=null&&c.additionsContentAST.push(r),a!=null){let e=t===`change`?n==null?`context`:`change-deletion`:t;c.deletionsContentAST.push(s(a)),c.pushToGutter(`deletions`,L(e,`annotation`,1)),l=!0}if(o!=null){let e=t===`change`?r==null?`context`:`change-addition`:t;c.additionsContentAST.push(s(o)),c.pushToGutter(`additions`,L(e,`annotation`,1)),l=!0}}l&&c.incrementRowCount(1)}function na(e,{hunkIndex:t,collapsedLines:n,rangeSize:r,hunkSpecs:i,isFirstHunk:a,isLastHunk:o,isExpandable:s},c){if(n<=0)return;let l=e===`unified`?c.unifiedContentAST:e===`deletions`?c.deletionsContentAST:c.additionsContentAST;if(c.hunkSeparators===`metadata`){i!=null&&(c.pushToGutter(e,bi({type:`metadata`,content:i,isFirstHunk:a,isLastHunk:o})),l.push(bi({type:`metadata`,content:i,isFirstHunk:a,isLastHunk:o})),e!==`additions`&&c.incrementRowCount(1));return}if(c.hunkSeparators===`simple`){t>0&&(c.pushToGutter(e,bi({type:`simple`,isFirstHunk:a,isLastHunk:!1})),l.push(bi({type:`simple`,isFirstHunk:a,isLastHunk:!1})),e!==`additions`&&c.incrementRowCount(1));return}let u=xi(e,t),d=r>c.expansionLineCount,f=s?t:void 0;c.pushToGutter(e,bi({type:c.hunkSeparators,content:Qi(n),expandIndex:f,chunked:d,slotName:u,isFirstHunk:a,isLastHunk:o})),l.push(bi({type:c.hunkSeparators,content:Qi(n),expandIndex:f,chunked:d,slotName:u,isFirstHunk:a,isLastHunk:o})),e!==`additions`&&c.incrementRowCount(1),c.hunkData.push({slotName:u,hunkIndex:t,lines:n,type:e,expandable:s?{up:!a,down:!o,chunked:d}:void 0})}function ra(e,t){return e==null||e.type!==`element`||t==null?e:{...e,properties:{...e.properties,...t}}}function ia(e,t){return Math.max(e.additionLines.length,e.deletionLines.length)>t}function aa(e,t){return e.lineNumber===t.lineNumber&&e.side===t.side&&e.metadata===t.metadata}function oa(e,t){return e.slotName===t.slotName&&e.hunkIndex===t.hunkIndex&&e.lines===t.lines&&e.type===t.type&&e.expandable?.chunked===t.expandable?.chunked&&e.expandable?.up===t.expandable?.up&&e.expandable?.down===t.expandable?.down}function sa(e){return{theme:e?.theme,disableLineNumbers:e?.disableLineNumbers,overflow:e?.overflow,collapsed:e?.collapsed,disableFileHeader:e?.disableFileHeader,disableVirtualizationBuffers:e?.disableVirtualizationBuffers,stickyHeader:e?.stickyHeader,preferredHighlighter:e?.preferredHighlighter,useCSSClasses:e?.useCSSClasses,useTokenTransformer:e?.useTokenTransformer,tokenizeMaxLineLength:e?.tokenizeMaxLineLength,tokenizeMaxLength:e?.tokenizeMaxLength,diffStyle:e?.diffStyle,diffIndicators:e?.diffIndicators,disableBackground:e?.disableBackground,hunkSeparators:typeof e?.hunkSeparators==`function`?`custom`:e?.hunkSeparators,expandUnchanged:e?.expandUnchanged,collapsedContextThreshold:e?.collapsedContextThreshold,lineDiffType:e?.lineDiffType,maxLineDiffLength:e?.maxLineDiffLength,expansionLineCount:e?.expansionLineCount,headerRenderMode:e?.renderCustomHeader==null?`default`:`custom`}}var ca=-1,la=class{options;workerManager;isContainerManaged;static LoadedCustomComponent=!0;__id=`file-diff:${++ca}`;type=`file-diff`;fileContainer;spriteSVG;pre;codeUnified;codeDeletions;codeAdditions;bufferBefore;bufferAfter;themeCSSStyle;appliedThemeCSS;hasAdoptedThemeCSS=!1;unsafeCSSStyle;appliedUnsafeCSS;gutterUtilityContent;headerElement;headerPrefix;headerMetadata;headerCustom;separatorCache=new Map;errorWrapper;placeHolder;hunksRenderer;resizeManager;scrollSyncManager;interactionManager;annotationCache=new Map;lineAnnotations=[];managersDirty=!1;deletionFile;additionFile;fileDiff;renderRange;appliedPreAttributes;lastRenderedHeaderHTML;cachedHeaderHTML;lastRowCount;mounted=!1;enabled=!0;constructor(e={theme:P},t,n=!1){this.options=e,this.workerManager=t,this.isContainerManaged=n,this.hunksRenderer=this.createHunksRenderer(e),this.resizeManager=new Ve,this.scrollSyncManager=new hi,this.interactionManager=new Ce(`diff`,we(e,typeof e.hunkSeparators==`function`||(e.hunkSeparators??`line-info`)===`line-info`||e.hunkSeparators===`line-info-basic`?this.handleExpandHunk:void 0,this.getLineIndex)),this.workerManager?.subscribeToThemeChanges(this),this.enabled=!0}handleHighlightRender=()=>{this.rerender()};getHunksRendererOptions(e){return sa(e)}createHunksRenderer(e){return new Yi(this.getHunksRendererOptions(e),this.handleHighlightRender,this.workerManager)}getLineIndex=(e,t=`additions`)=>{if(this.fileDiff==null)return;let n=this.fileDiff.hunks.at(-1),r,i;hunkIterator:for(let a of this.fileDiff.hunks){let o=t===`deletions`?a.deletionStart:a.additionStart,s=t===`deletions`?a.deletionCount:a.additionCount,c=a.splitLineStart,l=a.unifiedLineStart;if(e<o){let t=o-e;r=Math.max(l-t,0),i=Math.max(c-t,0);break hunkIterator}if(e>=o+s){if(a===n){let t=e-(o+s);r=l+a.unifiedLineCount+t,i=c+a.splitLineCount+t;break hunkIterator}continue}for(let n of a.hunkContent)if(n.type===`context`)if(e<o+n.lines){let t=e-o;i=c+t,r=l+t;break hunkIterator}else o+=n.lines,c+=n.lines,l+=n.lines;else{let a=t===`deletions`?n.deletions:n.additions;if(e<o+a){let a=e-o;r=l+(t===`additions`?n.deletions:0)+a,i=c+a;break hunkIterator}else o+=a,c+=Math.max(n.deletions,n.additions),l+=n.deletions+n.additions}break hunkIterator}if(!(r==null||i==null))return[r,i]};setOptions(e){e!=null&&(this.options=e,this.cachedHeaderHTML=void 0,this.hunksRenderer.setOptions(this.getHunksRendererOptions(e)),this.syncInteractionOptions())}syncInteractionOptions(){this.interactionManager.setOptions(we(this.options,typeof this.options.hunkSeparators==`function`||(this.options.hunkSeparators??`line-info`)===`line-info`||this.options.hunkSeparators===`line-info-basic`?this.handleExpandHunk:void 0,this.getLineIndex))}mergeOptions(e){this.options={...this.options,...e}}setThemeType(e){(this.options.themeType??`system`)!==e&&(this.mergeOptions({themeType:e}),this.applyCachedThemeState(e))}applyCachedThemeState(e){if(typeof this.options.theme==`string`||this.fileContainer==null||this.appliedThemeCSS==null)return!1;let t=this.appliedThemeCSS.baseThemeType??e;return this.appliedThemeCSS.themeType===t?!1:(this.applyThemeState(this.fileContainer,this.appliedThemeCSS.themeStyles,e,this.appliedThemeCSS.baseThemeType),!0)}hasThemeChanged(){return this.appliedThemeCSS!=null&&!pe(this.appliedThemeCSS.theme,this.options.theme??P)}getHoveredLine=()=>this.interactionManager.getHoveredLine();setLineAnnotations(e){this.lineAnnotations=e}canPartiallyRender(e,t,n){return!(e||t||n||typeof this.options.hunkSeparators==`function`)}setSelectedLines(e,t){this.interactionManager.setSelection(e,t)}flushManagers(){if(!this.managersDirty||this.pre==null){this.managersDirty=!1;return}let{diffStyle:e=`split`,overflow:t=`scroll`}=this.options;this.interactionManager.setup(this.pre),this.resizeManager.setup(this.pre,t===`wrap`),t===`scroll`&&e===`split`?this.scrollSyncManager.setup(this.pre,this.codeDeletions,this.codeAdditions):this.scrollSyncManager.cleanUp(),this.managersDirty=!1}cleanUp(e=!1){this.emitPostRender(!0),this.resizeManager.cleanUp(),this.interactionManager.cleanUp(),this.scrollSyncManager.cleanUp(),this.managersDirty=!1,this.workerManager?.unsubscribeToThemeChanges(this),this.renderRange=void 0,this.isContainerManaged||this.fileContainer?.remove(),this.fileContainer=void 0,this.mounted=!1,e||(this.lineAnnotations=[]),this.clearAuxiliaryNodes(),this.annotationCache.clear(),this.pre=void 0,this.codeUnified=void 0,this.codeDeletions=void 0,this.codeAdditions=void 0,this.bufferBefore=void 0,this.bufferAfter=void 0,this.appliedPreAttributes=void 0,this.headerElement=void 0,this.headerPrefix=void 0,this.headerMetadata=void 0,this.headerCustom=void 0,this.placeHolder=void 0,this.lastRenderedHeaderHTML=void 0,e||(this.cachedHeaderHTML=void 0),this.errorWrapper=void 0,this.spriteSVG=void 0,this.lastRowCount=void 0,this.themeCSSStyle=void 0,this.appliedThemeCSS=void 0,this.hasAdoptedThemeCSS=!1,this.unsafeCSSStyle=void 0,this.appliedUnsafeCSS=void 0,e?this.hunksRenderer.recycle():(this.hunksRenderer.cleanUp(),this.workerManager=void 0,this.fileDiff=void 0,this.deletionFile=void 0,this.additionFile=void 0),this.enabled=!1}virtualizedSetup(){this.enabled=!0,this.workerManager?.subscribeToThemeChanges(this)}hydrate(e){let{fileContainer:t,prerenderedHTML:n,preventEmit:r=!1,lineAnnotations:i,oldFile:a,newFile:o,fileDiff:s}=e;this.hydrateElements(t,n),fa(this.pre,ua({fileDiff:s,oldFile:a,newFile:o}),this.options.collapsed)||pa(this.headerElement,da({fileDiff:s,oldFile:a,newFile:o}),this.options.disableFileHeader)?this.render({...e,preventEmit:!0}):this.hydrationSetup({fileDiff:s,oldFile:a,newFile:o,lineAnnotations:i}),r||this.emitPostRender()}hydrateElements(e,t){this.fileContainer!==e&&this.emitPostRender(!0),Xn(e,t);for(let t of e.shadowRoot?.children??[]){if(t instanceof SVGElement){this.spriteSVG=t;continue}if(t instanceof HTMLElement){if(t instanceof HTMLPreElement){this.pre=t;for(let e of t.children)!(e instanceof HTMLElement)||e.tagName.toLowerCase()!==`code`||(`deletions`in e.dataset&&(this.codeDeletions=e),`additions`in e.dataset&&(this.codeAdditions=e),`unified`in e.dataset&&(this.codeUnified=e));continue}if(`diffsHeader`in t.dataset){this.headerElement=t;continue}if(t instanceof HTMLStyleElement&&t.hasAttribute(`data-theme-css`)){this.themeCSSStyle=t;continue}if(t instanceof HTMLStyleElement&&t.hasAttribute(`data-unsafe-css`)){this.unsafeCSSStyle=t,this.appliedUnsafeCSS=t.textContent;continue}}}this.pre!=null&&(this.syncCodeNodesFromPre(this.pre),this.pre.removeAttribute(`data-dehydrated`)),this.fileContainer=e,this.hydrateMeasuredScrollbar()}hydrationSetup({fileDiff:e,oldFile:t,newFile:n,lineAnnotations:r}){this.lineAnnotations=r??this.lineAnnotations,this.additionFile=n,this.deletionFile=t,this.fileDiff=e??(t!=null&&n!=null?mi(t,n,this.options.parseDiffOptions):void 0),this.pre!=null&&(this.syncInteractionOptions(),this.hunksRenderer.hydrate(this.fileDiff),this.renderAnnotations(),this.renderGutterUtility(),this.injectUnsafeCSS(),this.managersDirty=!0,this.flushManagers())}rerender(){!this.enabled||this.fileDiff==null&&this.additionFile==null&&this.deletionFile==null||this.render({forceRender:!0,renderRange:this.renderRange})}onThemeChange(){this.hunksRenderer.clearRenderCache(),this.rerender()}handleExpandHunk=(e,t,n)=>{this.expandHunk(e,t,n)};expandHunk=(e,t,n)=>{this.hunksRenderer.expandHunk(e,t,n),this.rerender()};render({oldFile:e,newFile:t,fileDiff:n,deferManagers:r=!1,forceRender:i=!1,preventEmit:a=!1,lineAnnotations:o,fileContainer:s,containerWrapper:c,renderRange:l}){if(!this.enabled)throw Error(`FileDiff.render: attempting to call render after cleaned up`);let{collapsed:u=!1,themeType:d=`system`}=this.options,f=u?void 0:l,p=this.hasThemeChanged(),m=e!=null&&t!=null&&(!Ht(e,this.deletionFile)||!Ht(t,this.additionFile)),h=n!=null&&n!==this.fileDiff,g=o!=null&&(o.length>0||this.lineAnnotations.length>0)?o!==this.lineAnnotations:!1;if(!u&&Ut(f,this.renderRange)&&!i&&!g&&!p&&(n!=null&&n===this.fileDiff||n==null&&!m))return this.applyCachedThemeState(d);let{renderRange:_}=this;if(this.renderRange=f,this.deletionFile=e,this.additionFile=t,n==null?e!=null&&t!=null&&m&&(h=!0,this.fileDiff=mi(e,t,this.options.parseDiffOptions)):this.fileDiff=n,h&&(this.cachedHeaderHTML=void 0),o!=null&&this.setLineAnnotations(o),this.fileDiff==null)return!1;this.hunksRenderer.setOptions(this.getHunksRendererOptions(this.options)),this.syncInteractionOptions(),this.hunksRenderer.setLineAnnotations(this.lineAnnotations);let{disableErrorHandling:v=!1,disableFileHeader:y=!1}=this.options;if(y&&(this.headerElement!=null&&(this.headerElement.remove(),this.headerElement=void 0,this.lastRenderedHeaderHTML=void 0),this.clearHeaderSlots()),s=this.getOrCreateFileContainer(s,c),this.applyCachedThemeState(d),u){this.removeRenderedCode(),this.clearAuxiliaryNodes();try{let e=this.hunksRenderer.renderDiff(this.fileDiff,de);e!=null&&this.applyThemeState(s,e.themeStyles,d,e.baseThemeType),e?.headerElement!=null&&this.applyHeaderToDOM(e.headerElement,s),this.renderSeparators([]),this.injectUnsafeCSS()}catch(e){if(v)throw e;console.error(e),e instanceof Error&&this.applyErrorToDOM(e,s)}return a||this.emitPostRender(),!0}try{let e=this.getOrCreatePreNode(s);if(!(this.canPartiallyRender(i,g,m||h||p)&&this.applyPartialRender({previousRenderRange:_,renderRange:f}))){let t=this.hunksRenderer.renderDiff(this.fileDiff,f);if(t==null)return this.workerManager?.isInitialized()===!1&&this.workerManager.initialize().then(()=>this.rerender()),!1;this.applyThemeState(s,t.themeStyles,d,t.baseThemeType),t.headerElement!=null&&this.applyHeaderToDOM(t.headerElement,s),t.additionsContentAST!=null||t.deletionsContentAST!=null||t.unifiedContentAST!=null?this.applyHunksToDOM(e,t):this.pre!=null&&(this.pre.remove(),this.pre=void 0),this.renderSeparators(t.hunkData)}this.applyBuffers(e,f),this.injectUnsafeCSS(),this.renderAnnotations(),this.renderGutterUtility(),this.managersDirty=!0,r||this.flushManagers()}catch(e){if(v)throw e;console.error(e),e instanceof Error&&this.applyErrorToDOM(e,s)}return a||this.emitPostRender(),!0}emitPostRender(e=!1){let{fileContainer:t,options:{onPostRender:n}}=this;if(e){if(!this.mounted||(this.mounted=!1,t==null))return;this.options.onPostRender?.(t,this,`unmount`);return}if(t==null)return;let r=this.mounted?`update`:`mount`;this.mounted=!0,n?.(t,this,r)}removeRenderedCode(){this.resizeManager.cleanUp(),this.scrollSyncManager.cleanUp(),this.interactionManager.cleanUp(),this.bufferBefore?.remove(),this.bufferBefore=void 0,this.bufferAfter?.remove(),this.bufferAfter=void 0,this.codeUnified?.remove(),this.codeUnified=void 0,this.codeDeletions?.remove(),this.codeDeletions=void 0,this.codeAdditions?.remove(),this.codeAdditions=void 0,this.pre?.remove(),this.pre=void 0,this.appliedPreAttributes=void 0,this.lastRowCount=void 0}clearAuxiliaryNodes(){for(let{element:e}of this.separatorCache.values())e.remove();this.separatorCache.clear();for(let{element:e}of this.annotationCache.values())e.remove();this.annotationCache.clear(),this.gutterUtilityContent?.remove(),this.gutterUtilityContent=void 0}renderPlaceholder(e){if(this.fileContainer==null)return!1;if(this.emitPostRender(!0),this.cleanChildNodes(),this.placeHolder==null){let e=this.fileContainer.shadowRoot??this.fileContainer.attachShadow({mode:`open`});this.placeHolder=document.createElement(`div`),this.placeHolder.dataset.placeholder=``,e.appendChild(this.placeHolder)}return this.placeHolder.style.setProperty(`height`,`${e}px`),!0}primeHighlightCache(){let{fileDiff:e,workerManager:t}=this;if(e==null||t==null||qi(e))return;let n=this.options.tokenizeMaxLength??1e5;Math.max(e.additionLines.length,e.deletionLines.length)>n||t.primeDiffHighlightCache(e)}cleanChildNodes(){this.resizeManager.cleanUp(),this.scrollSyncManager.cleanUp(),this.interactionManager.cleanUp(),this.clearAuxiliaryNodes(),this.bufferAfter?.remove(),this.bufferBefore?.remove(),this.codeAdditions?.remove(),this.codeDeletions?.remove(),this.codeUnified?.remove(),this.errorWrapper?.remove(),this.headerElement?.remove(),this.headerPrefix?.remove(),this.headerMetadata?.remove(),this.headerCustom?.remove(),this.pre?.remove(),this.spriteSVG?.remove(),this.themeCSSStyle?.remove(),this.unsafeCSSStyle?.remove(),this.bufferAfter=void 0,this.bufferBefore=void 0,this.codeAdditions=void 0,this.codeDeletions=void 0,this.codeUnified=void 0,this.errorWrapper=void 0,this.headerElement=void 0,this.headerPrefix=void 0,this.headerMetadata=void 0,this.headerCustom=void 0,this.pre=void 0,this.spriteSVG=void 0,this.themeCSSStyle=void 0,this.appliedThemeCSS=void 0,this.hasAdoptedThemeCSS=!1,this.unsafeCSSStyle=void 0,this.appliedUnsafeCSS=void 0,this.lastRenderedHeaderHTML=void 0,this.lastRowCount=void 0,this.mounted=!1}renderSeparators(e){let{hunkSeparators:t}=this.options;if(this.isContainerManaged||this.fileContainer==null||typeof t!=`function`){for(let{element:e}of this.separatorCache.values())e.remove();this.separatorCache.clear();return}let n=new Map(this.separatorCache);for(let r of e){let e=r.slotName,i=this.separatorCache.get(e);if(i==null||!oa(r,i.hunkData)){i?.element.remove();let n=document.createElement(`div`);n.style.display=`contents`,n.slot=r.slotName;let a=t(r,this);a!=null&&n.appendChild(a),this.fileContainer.appendChild(n),i={element:n,hunkData:r},this.separatorCache.set(e,i)}n.delete(e)}for(let[e,{element:t}]of n.entries())this.separatorCache.delete(e),t.remove()}renderAnnotations(){if(this.isContainerManaged||this.fileContainer==null){for(let{element:e}of this.annotationCache.values())e.remove();this.annotationCache.clear();return}let e=new Map(this.annotationCache),{renderAnnotation:t}=this.options;if(t!=null&&this.lineAnnotations.length>0)for(let[n,r]of this.lineAnnotations.entries()){let i=`${n}-${U(r)}`,a=this.annotationCache.get(i);if(a==null||!aa(r,a.annotation)){a?.element.remove();let e=t(r);if(e==null)continue;a={element:In(U(r)),annotation:r},a.element.appendChild(e),this.fileContainer.appendChild(a.element),this.annotationCache.set(i,a)}e.delete(i)}for(let[t,{element:n}]of e.entries())this.annotationCache.delete(t),n.remove()}renderGutterUtility(){let{renderGutterUtility:e}=this.options;if(this.fileContainer==null||e==null){this.gutterUtilityContent?.remove(),this.gutterUtilityContent=void 0;return}let t=e(this.interactionManager.getHoveredLine);if(t!=null&&this.gutterUtilityContent!=null)return;if(t==null){this.gutterUtilityContent?.remove(),this.gutterUtilityContent=void 0;return}let n=Ln();n.appendChild(t),this.fileContainer.appendChild(n),this.gutterUtilityContent=n}getOrCreateFileContainer(e,t){let{fileContainer:n}=this,r=e??n??document.createElement(`diffs-container`),i=n!==r;return i&&this.emitPostRender(!0),this.fileContainer=r,n!=null&&i&&(this.lastRenderedHeaderHTML=void 0,this.headerElement=void 0),t!=null&&this.fileContainer.parentNode!==t&&t.appendChild(this.fileContainer),i&&this.adoptReusableShellElements(this.fileContainer),this.ensureSpriteSVG(this.fileContainer),this.fileContainer}adoptReusableShellElements(e){let{shadowRoot:t}=e;if(t!=null)for(let e of t.children)e instanceof SVGElement?this.spriteSVG??=e:Qn(e)&&e.hasAttribute(`data-theme-css`)?(this.themeCSSStyle??=e,this.hasAdoptedThemeCSS=!0):Qn(e)&&e.hasAttribute(`data-unsafe-css`)&&(this.unsafeCSSStyle??=e,this.appliedUnsafeCSS??=this.options.unsafeCSS??void 0)}ensureSpriteSVG(e){let t=e.shadowRoot??e.attachShadow({mode:`open`});if(this.spriteSVG==null){let e=document.createElement(`div`);e.innerHTML=Mn;let t=e.firstChild;t instanceof SVGElement&&(this.spriteSVG=t)}this.spriteSVG!=null&&this.spriteSVG.parentNode!==t&&t.appendChild(this.spriteSVG)}getOrCreatePreNode(e){let t=e.shadowRoot??e.attachShadow({mode:`open`});return this.pre==null?(this.pre=document.createElement(`pre`),this.appliedPreAttributes=void 0,this.codeUnified=void 0,this.codeDeletions=void 0,this.codeAdditions=void 0,t.appendChild(this.pre)):this.pre.parentNode!==t&&(t.appendChild(this.pre),this.appliedPreAttributes=void 0),this.placeHolder?.remove(),this.placeHolder=void 0,this.pre}syncCodeNodesFromPre(e){this.codeUnified=void 0,this.codeDeletions=void 0,this.codeAdditions=void 0;for(let t of Array.from(e.children))t instanceof HTMLElement&&(t.hasAttribute(`data-unified`)?this.codeUnified=t:t.hasAttribute(`data-deletions`)?this.codeDeletions=t:t.hasAttribute(`data-additions`)&&(this.codeAdditions=t))}applyHeaderToDOM(e,t){this.cleanupErrorWrapper(),this.placeHolder?.remove(),this.placeHolder=void 0;let{fileDiff:n}=this,r=this.cachedHeaderHTML??x(e);if(this.cachedHeaderHTML=r,r!==this.lastRenderedHeaderHTML){let e=document.createElement(`div`);e.innerHTML=r;let n=e.firstElementChild;if(!(n instanceof HTMLElement))return;this.headerElement==null?t.shadowRoot?.prepend(n):t.shadowRoot?.replaceChild(n,this.headerElement),this.headerElement=n,this.lastRenderedHeaderHTML=r}if(this.isContainerManaged||n==null)return;let{renderCustomHeader:i,renderHeaderPrefix:a,renderHeaderMetadata:o}=this.options;if(i!=null){let e=i(n)??void 0;this.headerCustom=this.upsertHeaderSlotElement(t,this.headerCustom,ne,e),this.headerPrefix?.remove(),this.headerMetadata?.remove(),this.headerPrefix=void 0,this.headerMetadata=void 0;return}let s=a?.(n)??void 0,c=o?.(n)??void 0;this.headerPrefix=this.upsertHeaderSlotElement(t,this.headerPrefix,ee,s),this.headerMetadata=this.upsertHeaderSlotElement(t,this.headerMetadata,te,c),this.headerCustom?.remove(),this.headerCustom=void 0}clearHeaderSlots(){this.headerPrefix?.remove(),this.headerMetadata?.remove(),this.headerCustom?.remove(),this.headerPrefix=void 0,this.headerMetadata=void 0,this.headerCustom=void 0}upsertHeaderSlotElement(e,t,n,r){if(r==null){t?.remove();return}let i=t??this.createHeaderSlotElement(n);return t??e.appendChild(i),this.replaceHeaderSlotContent(i,r),i}replaceHeaderSlotContent(e,t){e.replaceChildren(),t instanceof Element?e.appendChild(t):e.innerText=`${t}`}createHeaderSlotElement(e){let t=document.createElement(`div`);return t.slot=e,t}injectUnsafeCSS(){let{unsafeCSS:e}=this.options,t=this.fileContainer?.shadowRoot;if(t!=null){if(e==null||e===``){this.unsafeCSSStyle!=null&&(this.unsafeCSSStyle.remove(),this.unsafeCSSStyle=void 0),this.appliedUnsafeCSS=void 0;return}this.unsafeCSSStyle?.parentNode===t&&this.appliedUnsafeCSS===e||(this.unsafeCSSStyle??=Rn(),this.unsafeCSSStyle.parentNode!==t&&t.appendChild(this.unsafeCSSStyle),this.unsafeCSSStyle.textContent=Gn(e),this.appliedUnsafeCSS=e)}}applyThemeState(e,t,n,r){let i=e.shadowRoot??e.attachShadow({mode:`open`}),a=r??n,o=this.options.theme??P,s=typeof o==`string`?o:{...o},c=Vn(i);if(this.themeCSSStyle?.parentNode===i&&this.appliedThemeCSS?.themeStyles===t&&this.appliedThemeCSS.themeType===a&&this.appliedThemeCSS.scrollbarGutter===c){this.appliedThemeCSS.theme=s;return}if(this.hasAdoptedThemeCSS&&this.themeCSSStyle?.parentNode===i){this.hasAdoptedThemeCSS=!1,this.appliedThemeCSS={theme:s,themeStyles:t,themeType:a,baseThemeType:r,scrollbarGutter:c};return}this.themeCSSStyle=$n({shadowRoot:i,currentNode:this.themeCSSStyle,themeCSS:Kn(t,a,c)}),this.appliedThemeCSS=this.themeCSSStyle==null?void 0:{theme:s,themeStyles:t,themeType:a,baseThemeType:r,scrollbarGutter:c}}hydrateMeasuredScrollbar(){let e=this.fileContainer?.shadowRoot;e==null||this.themeCSSStyle==null||(this.themeCSSStyle.textContent=qn(this.themeCSSStyle.textContent??``,Vn(e)))}applyHunksToDOM(e,t){let{overflow:n=`scroll`}=this.options,r=(this.options.hunkSeparators??`line-info`)===`line-info`,i=n===`wrap`?t.rowCount:void 0;this.cleanupErrorWrapper(),this.applyPreNodeAttributes(e,t);let a=!1,o=[],s=this.hunksRenderer.renderCodeAST(`unified`,t),c=this.hunksRenderer.renderCodeAST(`deletions`,t),l=this.hunksRenderer.renderCodeAST(`additions`,t);s==null?c!=null||l!=null?(c==null?(this.codeDeletions?.remove(),this.codeDeletions=void 0):(a=this.codeDeletions==null||this.codeUnified!=null,this.codeUnified?.remove(),this.codeUnified=void 0,this.codeDeletions=Yn({code:this.codeDeletions,columnType:`deletions`,rowSpan:i,containerSize:r}),this.codeDeletions.innerHTML=this.hunksRenderer.renderPartialHTML(c),o.push(this.codeDeletions)),l==null?(this.codeAdditions?.remove(),this.codeAdditions=void 0):(a=a||this.codeAdditions==null||this.codeUnified!=null,this.codeUnified?.remove(),this.codeUnified=void 0,this.codeAdditions=Yn({code:this.codeAdditions,columnType:`additions`,rowSpan:i,containerSize:r}),this.codeAdditions.innerHTML=this.hunksRenderer.renderPartialHTML(l),o.push(this.codeAdditions))):(this.codeUnified?.remove(),this.codeUnified=void 0,this.codeDeletions?.remove(),this.codeDeletions=void 0,this.codeAdditions?.remove(),this.codeAdditions=void 0):(a=this.codeUnified==null||this.codeAdditions!=null||this.codeDeletions!=null,this.codeDeletions?.remove(),this.codeDeletions=void 0,this.codeAdditions?.remove(),this.codeAdditions=void 0,this.codeUnified=Yn({code:this.codeUnified,columnType:`unified`,rowSpan:i,containerSize:r}),this.codeUnified.innerHTML=this.hunksRenderer.renderPartialHTML(s),o.push(this.codeUnified)),o.length===0?e.textContent=``:a&&e.replaceChildren(...o),this.lastRowCount=t.rowCount}applyPartialRender({previousRenderRange:e,renderRange:t}){let{pre:n,codeUnified:r,codeAdditions:i,codeDeletions:a,options:{diffStyle:o=`split`}}=this;if(n==null||e==null||t==null||!Number.isFinite(e.totalLines)||!Number.isFinite(t.totalLines)||this.lastRowCount==null)return!1;let s=this.getCodeColumns(o,r,a,i);if(s==null)return!1;let c=e.startingLine,l=t.startingLine,u=c+e.totalLines,d=l+t.totalLines,f=Math.max(c,l),p=Math.min(u,d);if(p<=f)return!1;let m=Math.max(0,f-c),h=Math.max(0,u-p),g=this.trimColumns({columns:s,trimStart:m,trimEnd:h,previousStart:c,overlapStart:f,overlapEnd:p,diffStyle:o});if(g<0)throw Error(`applyPartialRender: failed to trim to overlap`);if(this.lastRowCount<g)throw Error(`applyPartialRender: trimmed beyond DOM row count`);let _=this.lastRowCount-g,v=(e,t)=>{if(!(t<=0||this.fileDiff==null))return this.hunksRenderer.renderDiff(this.fileDiff,{startingLine:e,totalLines:t,bufferBefore:0,bufferAfter:0})},y=v(l,Math.max(f-l,0));if(y==null&&l<f)return!1;let b=v(p,Math.max(d-p,0));if(b==null&&d>p)return!1;let x=(e,t)=>{if(e!=null){if(o===`unified`&&!Array.isArray(s))this.insertPartialHTML(o,s,e,t);else if(o===`split`&&Array.isArray(s))this.insertPartialHTML(o,s,e,t);else throw Error(`FileDiff.applyPartialRender.applyChunk: invalid chunk application`);_+=e.rowCount}};return this.cleanupErrorWrapper(),x(y,`afterbegin`),x(b,`beforeend`),this.lastRowCount!==_&&(this.applyRowSpan(o,s,_),this.lastRowCount=_),!0}insertPartialHTML(e,t,n,r){if(e===`unified`&&!Array.isArray(t)){let e=this.hunksRenderer.renderCodeAST(`unified`,n);this.renderPartialColumn(t,e,r)}else if(e===`split`&&Array.isArray(t)){let e=this.hunksRenderer.renderCodeAST(`deletions`,n),i=this.hunksRenderer.renderCodeAST(`additions`,n);this.renderPartialColumn(t[0],e,r),this.renderPartialColumn(t[1],i,r)}else throw Error(`FileDiff.insertPartialHTML: Invalid argument composition`)}renderPartialColumn(e,t,n){if(e==null||t==null)return;let r=ma(t[0]),i=ma(t[1]);if(r==null||i==null)throw Error(`FileDiff.insertPartialHTML: Unexpected AST structure`);let a=i.at(0);n===`beforeend`&&a?.type===`element`&&typeof a.properties[`data-buffer-size`]==`number`&&this.mergeBuffersIfNecessary(a.properties[`data-buffer-size`],e.content.children[e.content.children.length-1],e.gutter.children[e.gutter.children.length-1],r,i,!0);let o=i.at(-1);n===`afterbegin`&&o?.type===`element`&&typeof o.properties[`data-buffer-size`]==`number`&&this.mergeBuffersIfNecessary(o.properties[`data-buffer-size`],e.content.children[0],e.gutter.children[0],r,i,!1),e.gutter.insertAdjacentHTML(n,this.hunksRenderer.renderPartialHTML(r)),e.content.insertAdjacentHTML(n,this.hunksRenderer.renderPartialHTML(i))}mergeBuffersIfNecessary(e,t,n,r,i,a){if(!(t instanceof HTMLElement)||!(n instanceof HTMLElement))return;let o=this.getBufferSize(t.dataset);o!=null&&(a?(r.shift(),i.shift()):(r.pop(),i.pop()),this.updateBufferSize(t,o+e),this.updateBufferSize(n,o+e))}applyRowSpan(e,t,n){let r=e=>{e!=null&&(e.gutter.style.setProperty(`grid-row`,`span ${n}`),e.content.style.setProperty(`grid-row`,`span ${n}`))};if(e===`unified`&&!Array.isArray(t))r(t);else if(e===`split`&&Array.isArray(t))r(t[0]),r(t[1]);else throw Error(`dun fuuuuked up`)}trimColumnRows(e,t,n){let r=0,i=0,a=0,o=!1,s=n>=0;if(e==null)return 0;let c=Array.from(e.content.children),l=Array.from(e.gutter.children);if(c.length!==l.length)throw Error(`FileDiff.trimColumnRows: columns do not match`);for(;a<c.length&&!(t<=0&&!s&&!o);){let e=l[a],u=c[a];if(a++,!(e instanceof HTMLElement)||!(u instanceof HTMLElement))throw console.error({gutterElement:e,contentElement:u}),Error(`FileDiff.trimColumnRows: invalid row elements`);if(o&&(o=!1,e.dataset.gutterBuffer===`annotation`&&`lineAnnotation`in u.dataset||e.dataset.gutterBuffer===`metadata`&&`noNewline`in u.dataset)){e.remove(),u.remove(),i++;continue}if(`lineIndex`in e.dataset&&`lineIndex`in u.dataset){(t>0||s&&r>=n)&&(e.remove(),u.remove(),t>0&&(t--,t===0&&(o=!0)),i++),r++;continue}if(`separator`in e.dataset&&`separator`in u.dataset){(t>0||s&&r>=n)&&(e.remove(),u.remove(),i++);continue}if(e.dataset.gutterBuffer===`annotation`&&`lineAnnotation`in u.dataset){(t>0||s&&r>=n)&&(e.remove(),u.remove(),i++);continue}if(e.dataset.gutterBuffer===`metadata`&&`noNewline`in u.dataset){(t>0||s&&r>=n)&&(e.remove(),u.remove(),i++);continue}if(e.dataset.gutterBuffer===`buffer`&&`contentBuffer`in u.dataset){let a=this.getBufferSize(u.dataset);if(a==null)throw Error(`FileDiff.trimColumnRows: invalid element`);if(t>0){let n=Math.min(t,a),r=a-n;r>0?(this.updateBufferSize(e,r),this.updateBufferSize(u,r),i+=n):(e.remove(),u.remove(),i+=a),t-=n,t===0&&r===0&&(o=!0)}else if(s){let t=r,o=r+a-1;if(n<=t)e.remove(),u.remove(),i+=a;else if(n<=o){let t=o-n+1,r=a-t;this.updateBufferSize(e,r),this.updateBufferSize(u,r),i+=t}}r+=a;continue}throw console.error({gutterElement:e,contentElement:u}),Error(`FileDiff.trimColumnRows: unknown row elements`)}return i}trimColumns({columns:e,diffStyle:t,overlapEnd:n,overlapStart:r,previousStart:i,trimEnd:a,trimStart:o}){let s=Math.max(0,r-i),c=n-i;if(c<0)throw Error(`FileDiff.trimColumns: overlap ends before previous`);let l=o>0,u=a>0;if(!l&&!u)return 0;let d=l?s:0,f=u?c:-1;if(t===`unified`&&!Array.isArray(e))return this.trimColumnRows(e,d,f);if(t===`split`&&Array.isArray(e)){let t=this.trimColumnRows(e[0],d,f),n=this.trimColumnRows(e[1],d,f);if(e[0]!=null&&e[1]!=null&&t!==n)throw Error(`FileDiff.trimColumns: split columns out of sync`);return e[0]==null?n:t}else throw console.error({diffStyle:t,columns:e}),Error(`FileDiff.trimColumns: Invalid columns for diffType`)}getBufferSize(e){let t=Number.parseInt(e?.bufferSize??``,10);return Number.isNaN(t)?void 0:t}updateBufferSize(e,t){e.dataset.bufferSize=`${t}`,e.style.setProperty(`grid-row`,`span ${t}`),e.style.setProperty(`min-height`,`calc(${t} * 1lh)`)}getCodeColumns(e,t,n,r){function i(e){if(e==null)return;let t=e.children[0],n=e.children[1];if(!(!(t instanceof HTMLElement)||!(n instanceof HTMLElement)||t.dataset.gutter==null||n.dataset.content==null))return{gutter:t,content:n}}if(e===`unified`)return i(t);{let e=i(n),t=i(r);return e!=null||t!=null?[e,t]:void 0}}applyBuffers(e,t){if(t==null||this.shouldDisableVirtualizationBuffers()){this.bufferBefore!=null&&(this.bufferBefore.remove(),this.bufferBefore=void 0),this.bufferAfter!=null&&(this.bufferAfter.remove(),this.bufferAfter=void 0);return}t.bufferBefore>0?(this.bufferBefore??(this.bufferBefore=document.createElement(`div`),this.bufferBefore.dataset.virtualizerBuffer=`before`,e.before(this.bufferBefore)),this.bufferBefore.style.setProperty(`height`,`${t.bufferBefore}px`),this.bufferBefore.style.setProperty(`contain`,`strict`)):this.bufferBefore!=null&&(this.bufferBefore.remove(),this.bufferBefore=void 0),t.bufferAfter>0?(this.bufferAfter??(this.bufferAfter=document.createElement(`div`),this.bufferAfter.dataset.virtualizerBuffer=`after`,e.after(this.bufferAfter)),this.bufferAfter.style.setProperty(`height`,`${t.bufferAfter}px`),this.bufferAfter.style.setProperty(`contain`,`strict`)):this.bufferAfter!=null&&(this.bufferAfter.remove(),this.bufferAfter=void 0)}shouldDisableVirtualizationBuffers(){return this.options.disableVirtualizationBuffers??!1}applyPreNodeAttributes(e,{additionsContentAST:t,deletionsContentAST:n,totalLines:r},i){let{diffIndicators:a=`bars`,disableBackground:o=!1,disableLineNumbers:s=!1,overflow:c=`scroll`,diffStyle:l=`split`}=this.options,u={type:`diff`,diffIndicators:a,disableBackground:o,disableLineNumbers:s,overflow:c,split:l===`unified`?!1:t!=null&&n!=null,totalLines:r,customProperties:i};Nn(u,this.appliedPreAttributes)||(Zn(e,u),this.appliedPreAttributes=u)}applyErrorToDOM(e,t){this.cleanupErrorWrapper(),this.pre?.remove(),this.pre=void 0,this.appliedPreAttributes=void 0;let n=t.shadowRoot??t.attachShadow({mode:`open`});this.errorWrapper??=document.createElement(`div`),this.errorWrapper.dataset.errorWrapper=``,this.errorWrapper.textContent=``,n.appendChild(this.errorWrapper);let r=document.createElement(`div`);r.dataset.errorMessage=``,r.innerText=e.message,this.errorWrapper.appendChild(r);let i=document.createElement(`pre`);i.dataset.errorStack=``,i.innerText=e.stack??`No Error Stack`,this.errorWrapper.appendChild(i)}cleanupErrorWrapper(){this.errorWrapper?.remove(),this.errorWrapper=void 0}};function ua({fileDiff:e,oldFile:t,newFile:n}){return e!=null&&e.hunks.length>0||t!=null||n!=null}function da({fileDiff:e,oldFile:t,newFile:n}){return e!=null||t!=null||n!=null}function fa(e,t,n=!1){return!n&&e==null&&t}function pa(e,t,n=!1){return e==null&&t&&!n}function ma(e){if(!(e==null||e.type!==`element`))return e.children??[]}function ha({fileDiff:e,metrics:t,disableFileHeader:n,hunkSeparators:r,expandUnchanged:i,expandedHunks:a,collapsedContextThreshold:o}){let s=q(t,n),c=s,l=i?!0:a,u=e.hunks.length-1;for(let n=0;n<e.hunks.length;n++){let i=e.hunks[n];if(i==null)throw Error(`computeEstimatedDiffHeights: invalid hunk index`);let a=Ei({isPartial:e.isPartial,rangeSize:i.collapsedBefore,expandedHunks:l,hunkIndex:n,collapsedContextThreshold:o}),d=(a.fromStart+a.fromEnd)*t.lineHeight;if(s+=d,c+=d,a.collapsedLines>0){let e=Ni({type:r,metrics:t,hunkIndex:n,hunkSpecs:i.hunkSpecs})?.totalHeight??0;s+=e,c+=e}s+=i.splitLineCount*t.lineHeight,c+=i.unifiedLineCount*t.lineHeight;let f=ga(i);s+=f.split*t.lineHeight,c+=f.unified*t.lineHeight;let p=n===u?Oi({fileDiff:e,hunkIndex:n,expandedHunks:l,collapsedContextThreshold:o,errorPrefix:`computeEstimatedDiffHeights`}):void 0;if(p!=null){let e=(p.fromStart+p.fromEnd)*t.lineHeight;if(s+=e,c+=e,p.collapsedLines>0){let e=Pi({type:r,metrics:t})?.totalHeight??0;s+=e,c+=e}}}if(e.hunks.length>0){let e=rr(t);s+=e,c+=e}return{splitHeight:s,unifiedHeight:c}}function ga(e){if(!e.noEOFCRAdditions&&!e.noEOFCRDeletions)return{split:0,unified:0};let t=e.hunkContent.at(-1);if(t==null)return{split:0,unified:0};if(t.type===`context`){let e=t.lines>0?1:0;return{split:e,unified:e}}return _a(e,t)}function _a(e,t){let n=(t.deletions>0&&e.noEOFCRDeletions?1:0)+(t.additions>0&&e.noEOFCRAdditions?1:0),r=t.deletions>0&&e.noEOFCRDeletions,i=t.additions>0&&e.noEOFCRAdditions;return{split:r||i?1:0,unified:n}}var va=5e3,ya=-1,ba=class extends la{__id=`little-virtualized-file-diff:${++ya}`;top;height=0;metrics;cache={heightDeltas:new Map,measuredHeightDeltaTotal:0,estimatedSplitHeight:void 0,estimatedUnifiedHeight:void 0,checkpoints:[],totalLines:0,fileAnnotationHeight:0};isVisible=!1;isSetup=!1;virtualizer;layoutDirty=!0;forceRenderOverride;currentCollapsed;constructor(e,t,n,r,i=!1){super(e,r,i),this.virtualizer=t,this.metrics=tr(n)}setMetrics(e,t=!1){let n=tr(e);!t&&fe(this.metrics,n)||(this.metrics=n,this.resetLayoutCache({includeEstimatedHeights:!0}))}setLineAnnotations(e){this.syncLineAnnotations(e)&&this.resetLayoutCache({includeEstimatedHeights:!1})}syncLineAnnotations(e){return e==null||e===this.lineAnnotations||e.length===0&&this.lineAnnotations.length===0?!1:(super.setLineAnnotations(e),!0)}setFileAnnotationHeight(e){let t=this.cache.fileAnnotationHeight;return e===t?!1:(this.cache.fileAnnotationHeight=e,this.cache.measuredHeightDeltaTotal+=e-t,!0)}hasFileAnnotations(e=this.fileDiff){return e==null||!Dn(this.lineAnnotations)?!1:this.lineAnnotations.some(t=>t.lineNumber===0?e.type===`new`?t.side===`additions`:e.type===`deleted`?t.side===`deletions`:!0:!1)}getLineHeight(e,t=!1){return this.getEstimatedLineHeight(t)+(this.cache.heightDeltas.get(e)??0)}getEstimatedLineHeight(e=!1){let t=e?2:1;return this.metrics.lineHeight*t}setOptions(e){if(this.isAdvancedMode())throw Error(`VirtualizedFileDiff.setOptions cannot be used inside CodeView. Update CodeView options instead.`);if(e==null)return;let{options:t}=this,n=!me(t,e),r=n&&Oa(t,e);super.setOptions(e),r&&this.resetLayoutCache({forceSimpleRecompute:!0,includeEstimatedHeights:ka(t,e)}),n&&(this.forceRenderOverride=!0),n&&this.isSimpleMode()&&this.virtualizer.instanceChanged(this,r)}setThemeType(e){if(this.isAdvancedMode())throw Error(`VirtualizedFileDiff.setThemeType cannot be used inside CodeView. Update CodeView options instead.`);super.setThemeType(e)}resetLayoutCache({forceSimpleRecompute:e=!1,includeEstimatedHeights:t=!1}={}){this.layoutDirty=!0,this.cache.fileAnnotationHeight=0,this.cache.heightDeltas.size>0&&this.cache.heightDeltas.clear(),this.cache.measuredHeightDeltaTotal!==0&&(this.cache.measuredHeightDeltaTotal=0),this.cache.checkpoints.length>0&&(this.cache.checkpoints.length=0),this.cache.totalLines!==0&&(this.cache.totalLines=0),t&&(this.cache.estimatedSplitHeight=void 0,this.cache.estimatedUnifiedHeight=void 0),this.renderRange!=null&&(this.renderRange=void 0),e&&this.isSimpleMode()&&this.computeApproximateSize()}reconcileHeights(){let e=!1,{overflow:t=`scroll`}=this.options;if(this.fileContainer==null||this.fileDiff==null)return this.height!==0&&(e=!0),this.height=0,e;if(this.top=this.getVirtualizedTop(),t===`scroll`&&this.lineAnnotations.length===0&&!this.isResizeDebuggingEnabled())return e;let n=this.getDiffStyle(),r=n===`split`?[this.codeDeletions,this.codeAdditions]:[this.codeUnified],i=this.hasFileAnnotations(this.fileDiff);if(this.renderRange!=null&&i&&kn(this.renderRange)){let t=xa(r)??0;this.setFileAnnotationHeight(t)&&(e=!0)}else !i&&this.setFileAnnotationHeight(0)&&(e=!0);for(let t of r){if(t==null)continue;let r=t.children[1];if(r instanceof HTMLElement)for(let t of r.children){if(!(t instanceof HTMLElement))continue;let r=t.dataset.lineIndex;if(r==null)continue;let i=ja(r,n),a=t.getBoundingClientRect().height,o=!1;t.nextElementSibling instanceof HTMLElement&&(`lineAnnotation`in t.nextElementSibling.dataset||`noNewline`in t.nextElementSibling.dataset)&&(`noNewline`in t.nextElementSibling.dataset&&(o=!0),a+=t.nextElementSibling.getBoundingClientRect().height);let s=this.getEstimatedLineHeight(o),c=this.cache.heightDeltas.get(i)??0,l=a-s;l!==c&&(e=!0,this.cache.measuredHeightDeltaTotal+=l-c,l===0?this.cache.heightDeltas.delete(i):this.cache.heightDeltas.set(i,l))}}return(e||this.isResizeDebuggingEnabled())&&this.computeApproximateSize(!0),e}onRender=e=>this.fileContainer==null?!1:(e&&(this.top=this.getVirtualizedTop()),this.render());prepareCodeViewItem(e,t,n,r){let i=!ar(this.fileDiff,e),a=this.syncLineAnnotations(r),o=n?.resetDiffLayoutCache===!0||i||a,s=i||n?.resetDiffLayoutCache===!0&&n.includeEstimatedDiffHeights;n?.metrics!=null&&(this.metrics=tr(n.metrics),o=!0,s=!0);let{collapsed:c=!1}=this.options;return this.currentCollapsed!==c&&(this.currentCollapsed=c,o=!0),o&&this.resetLayoutCache({includeEstimatedHeights:s}),this.fileDiff=e,this.top=t,this.computeApproximateSize(),this.height}getLinePosition(e,t=`additions`){if(this.fileDiff==null||e<1)return;let n=this.getLineIndex(e,t);if(n==null)return;let{disableFileHeader:r=!1,expandUnchanged:i=!1,collapsed:a=!1,collapsedContextThreshold:o=1}=this.options,s=this.getDiffStyle(),c=this.getHunkSeparatorType(),l=s===`split`?n[1]:n[0];this.approximateLayoutCheckpoints();let u=q(this.metrics,r),d=this.getLayoutCheckpointBeforeLineIndex(l),f=d?.top??u+this.cache.fileAnnotationHeight;if(a)return{top:u,height:0};let p;return Fi({diff:this.fileDiff,diffStyle:s,startingLine:d?.renderedLineIndex??0,expandedHunks:i?!0:this.hunksRenderer.getExpandedHunksMap(),collapsedContextThreshold:o,callback:({hunkIndex:e,hunk:t,collapsedBefore:n,collapsedAfter:r,deletionLine:i,additionLine:a})=>{let o=s===`split`?a?.splitLineIndex??i?.splitLineIndex:a?.unifiedLineIndex??i?.unifiedLineIndex;if(o==null)throw Error(`VirtualizedFileDiff.getLinePosition: missing line index data`);if(n>0){let r=Ni({type:c,metrics:this.metrics,hunkIndex:e,hunkSpecs:t?.hunkSpecs});if(r!=null){if(f+=r.gapBefore,l>=o-n&&l<o)return p={top:f,height:r.height},!0;f+=r.height+r.gapAfter}}let u=this.getLineHeight(o,(a?.noEOFCR??!1)||(i?.noEOFCR??!1));if(o===l)return p={top:f,height:u},!0;if(f+=u,r>0){let e=Pi({type:c,metrics:this.metrics});if(e!=null){if(l>o&&l<=o+r)return p={top:f+e.gapBefore,height:e.height},!0;f+=e.totalHeight}}return!1}}),p}getNumericScrollAnchor(e){if(this.fileDiff==null)return;let{disableFileHeader:t=!1,expandUnchanged:n=!1,collapsed:r=!1,collapsedContextThreshold:i=1}=this.options;if(r)return;let a=this.getDiffStyle(),o=this.getHunkSeparatorType();this.approximateLayoutCheckpoints();let s=this.getLayoutCheckpointBeforeTop(e),c=s?.top??q(this.metrics,t)+this.cache.fileAnnotationHeight,l;return Fi({diff:this.fileDiff,diffStyle:a,startingLine:s?.renderedLineIndex??0,expandedHunks:n?!0:this.hunksRenderer.getExpandedHunksMap(),collapsedContextThreshold:i,callback:({hunkIndex:t,hunk:n,collapsedBefore:r,collapsedAfter:i,deletionLine:s,additionLine:u})=>{let d=a===`split`?u?.splitLineIndex??s?.splitLineIndex:u?.unifiedLineIndex??s?.unifiedLineIndex;if(d==null)throw Error(`VirtualizedFileDiff.getNumericScrollAnchor: missing line index data`);if(r>0){let e=Ni({type:o,metrics:this.metrics,hunkIndex:t,hunkSpecs:n?.hunkSpecs});e!=null&&(c+=e.totalHeight)}if(c>=e&&(s==null?u!=null&&(l={lineNumber:u.lineNumber,side:`additions`,top:c}):l={lineNumber:s.lineNumber,side:`deletions`,top:c},l!=null))return!0;let f=this.getLineHeight(d,(u?.noEOFCR??!1)||(s?.noEOFCR??!1));if(c+=f,i>0){let e=Pi({type:o,metrics:this.metrics});e!=null&&(c+=e.totalHeight)}return!1}}),l}getVirtualizedHeight(){return this.height}getAdvancedStickySpecs(e){if(this.top==null||this.fileDiff==null)return;if(this.options.collapsed===!0)return{topOffset:this.top,height:this.height};let t=e==null?this.renderRange:this.computeRenderRangeFromWindow(this.fileDiff,this.top,e);if(t==null)return;let{bufferBefore:n,bufferAfter:r,totalLines:i}=t,a=0;if(i===0){let t=e??this.virtualizer.getWindowSpecs();this.top<t.top&&(a=r)}return{topOffset:this.top+n+a,height:this.height-(n+r)}}cleanUp(e=!1){this.fileContainer!=null&&this.isSimpleMode()&&this.getSimpleVirtualizer()?.disconnect(this.fileContainer),e||this.resetLayoutCache({includeEstimatedHeights:!0}),this.isSetup=!1,super.cleanUp(e)}expandHunk=(e,t,n)=>{this.hunksRenderer.expandHunk(e,t,n),this.forceRenderOverride=!0,this.resetLayoutCache({includeEstimatedHeights:!0}),this.isSimpleMode()&&this.computeApproximateSize(),this.virtualizer.instanceChanged(this,!0)};setVisibility(e){this.isAdvancedMode()||this.fileContainer==null||(this.renderRange=void 0,e&&!this.isVisible?(this.top=this.getVirtualizedTop(),this.isVisible=!0):!e&&this.isVisible&&(this.isVisible=!1,this.rerender()))}rerender(){!this.enabled||this.fileDiff==null&&this.additionFile==null&&this.deletionFile==null||(this.forceRenderOverride=!0,this.virtualizer.instanceChanged(this,!1))}computeApproximateSize(e=!1){let t=this.isResizeDebuggingEnabled();if(!e&&!this.layoutDirty&&!t)return;let n=this.height===0;if(this.height=0,this.cache.checkpoints=[],this.cache.totalLines=0,this.fileDiff==null){this.layoutDirty=!1;return}let{disableFileHeader:r=!1,collapsed:i=!1}=this.options,a=q(this.metrics,r);if(this.height+=a,i){this.layoutDirty=!1;return}this.height=this.getActiveEstimatedHeight()+this.cache.measuredHeightDeltaTotal,t&&!n&&this.validateComputedHeight(),this.layoutDirty=!1}getActiveEstimatedHeight(){this.ensureEstimatedDiffHeights();let e=this.getDiffStyle()===`split`?this.cache.estimatedSplitHeight:this.cache.estimatedUnifiedHeight;if(e==null)throw Error(`VirtualizedFileDiff.getActiveEstimatedHeight: missing estimated height`);return e}ensureEstimatedDiffHeights(){if(this.fileDiff==null){this.cache.estimatedSplitHeight=void 0,this.cache.estimatedUnifiedHeight=void 0;return}if(this.cache.estimatedSplitHeight!=null&&this.cache.estimatedUnifiedHeight!=null)return;let{disableFileHeader:e=!1,expandUnchanged:t=!1,collapsedContextThreshold:n=1}=this.options,{splitHeight:r,unifiedHeight:i}=ha({fileDiff:this.fileDiff,metrics:this.metrics,disableFileHeader:e,hunkSeparators:this.getHunkSeparatorType(),expandUnchanged:t,expandedHunks:this.hunksRenderer.getExpandedHunksMap(),collapsedContextThreshold:n});this.cache.estimatedSplitHeight=r,this.cache.estimatedUnifiedHeight=i}validateComputedHeight(){if(this.fileContainer==null||this.fileDiff==null)return;let e=this.fileContainer.getBoundingClientRect();e.height===this.height?console.log(`VirtualizedFileDiff.computeApproximateSize: computed height IS CORRECT`):console.log(`VirtualizedFileDiff.computeApproximateSize: computed height doesnt match`,{name:this.fileDiff.name,elementHeight:e.height,computedHeight:this.height})}render({fileContainer:e,oldFile:t,newFile:n,fileDiff:r,forceRender:i=!1,lineAnnotations:a,...o}={}){let{forceRenderOverride:s,isSetup:c}=this;this.forceRenderOverride=void 0;let l=this.syncLineAnnotations(a);if(l&&this.resetLayoutCache({includeEstimatedHeights:!1}),this.fileDiff??=r??(t!=null&&n!=null?mi(t,n,this.options.parseDiffOptions):void 0),e=this.getOrCreateFileContainer(e),this.fileDiff==null)return console.error(`VirtualizedFileDiff.render: attempting to virtually render when we dont have the correct data`),!1;if(c)this.top??=this.getVirtualizedTop();else{this.computeApproximateSize();let t=this.getSimpleVirtualizer();if(this.top??=this.getVirtualizedTop(),this.isAdvancedMode())this.isVisible=!0;else{if(t==null)throw Error(`VirtualizedFileDiff.render: simple virtualizer is not available`);t.connect(e,this),this.isVisible=t.isInstanceVisible(this.top??0,this.height)}this.isSetup=!0}if(!this.isVisible&&this.isSimpleMode())return this.renderPlaceholder(this.height);let u=this.virtualizer.getWindowSpecs(),d=this.top??0,f=this.computeRenderRangeFromWindow(this.fileDiff,d,u);return super.render({fileDiff:this.fileDiff,fileContainer:e,renderRange:f,oldFile:t,newFile:n,lineAnnotations:a,forceRender:(s??i)||l,...o})}syncVirtualizedTop(){this.top=this.getVirtualizedTop()}shouldDisableVirtualizationBuffers(){return this.isAdvancedMode()||super.shouldDisableVirtualizationBuffers()}isSimpleMode(){return this.virtualizer.type===`simple`}isAdvancedMode(){return this.virtualizer.type===`advanced`}getVirtualizedTop(){return this.virtualizer.type===`advanced`?this.virtualizer.getLocalTopForInstance(this):this.fileContainer==null?0:this.virtualizer.getOffsetInScrollContainer(this.fileContainer)}getSimpleVirtualizer(){return this.virtualizer.type===`simple`?this.virtualizer:void 0}isResizeDebuggingEnabled(){return this.getSimpleVirtualizer()?.config.resizeDebugging??!1}getDiffStyle(){return this.options.diffStyle??`split`}getHunkSeparatorType(){return Aa(this.options.hunkSeparators)}approximateLayoutCheckpoints(){if(this.cache.checkpoints.length>0||this.fileDiff==null||this.fileDiff.hunks.length===0||this.options.collapsed===!0)return;let{disableFileHeader:e=!1,expandUnchanged:t=!1,collapsedContextThreshold:n=1}=this.options,r=this.fileDiff.hunks.length-1,i=this.getDiffStyle(),a=this.getHunkSeparatorType(),o=t?!0:this.hunksRenderer.getExpandedHunksMap(),s=Sa(this.cache.heightDeltas),c=q(this.metrics,e)+this.cache.fileAnnotationHeight,l=0,u=({rowCount:e,startLineIndex:t,preSeparatorHeight:n=0,postSeparatorHeight:r=0,metadataOffsets:i=[]})=>{if(e<=0)return;let a=l,o=l+e,u=Ta(a);for(;u<o;){let e=u-a,r=c+(e>0?n:0)+e*this.metrics.lineHeight+Ea(i,e)*this.metrics.lineHeight+Ca(s,t,t+e);this.cache.checkpoints.push({renderedLineIndex:u,lineIndex:t+e,top:r}),u+=va}c+=n+e*this.metrics.lineHeight+i.length*this.metrics.lineHeight+Ca(s,t,t+e)+r,l=o};for(let e=0;e<this.fileDiff.hunks.length;e++){let t=this.fileDiff.hunks[e];if(t==null)throw Error(`VirtualizedFileDiff.approximateLayoutCheckpoints: invalid hunk index`);let s=Ei({isPartial:this.fileDiff.isPartial,rangeSize:t.collapsedBefore,expandedHunks:o,hunkIndex:e,collapsedContextThreshold:n}),c=s.collapsedLines>0?Ni({type:a,metrics:this.metrics,hunkIndex:e,hunkSpecs:t.hunkSpecs})?.totalHeight??0:0;u({rowCount:s.fromStart,startLineIndex:(i===`split`?t.splitLineStart:t.unifiedLineStart)-s.rangeSize});let l=c;u({rowCount:s.fromEnd,startLineIndex:(i===`split`?t.splitLineStart:t.unifiedLineStart)-s.fromEnd,preSeparatorHeight:l}),s.fromEnd>0&&(l=0);let d=e===r?Oi({fileDiff:this.fileDiff,hunkIndex:e,expandedHunks:o,collapsedContextThreshold:n,errorPrefix:`VirtualizedFileDiff`}):void 0,f=d!=null&&d.collapsedLines>0?Pi({type:a,metrics:this.metrics})?.totalHeight??0:0,p=d==null?0:d.fromStart+d.fromEnd,m=i===`split`?t.splitLineCount:t.unifiedLineCount,h=i===`split`?t.splitLineStart:t.unifiedLineStart;u({rowCount:m,startLineIndex:h,preSeparatorHeight:l,postSeparatorHeight:p===0?f:0,metadataOffsets:Da({diffStyle:i,hunk:t,rowCount:m})}),d!=null&&p>0&&u({rowCount:p,startLineIndex:h+m,postSeparatorHeight:f})}this.cache.totalLines=l}getLayoutCheckpointBeforeLineIndex(e){if(e<=0||this.cache.checkpoints.length===0)return;let t=0,n=this.cache.checkpoints.length-1,r;for(;t<=n;){let i=t+n>>1,a=this.cache.checkpoints[i];if(a==null)throw Error(`VirtualizedFileDiff: invalid checkpoint index`);a.lineIndex<=e?(r=a,t=i+1):n=i-1}return r}getLayoutCheckpointBeforeTop(e,t){let n=0,r=this.cache.checkpoints.length-1,i=-1;for(;n<=r;){let t=n+r>>1,a=this.cache.checkpoints[t];if(a==null)throw Error(`VirtualizedFileDiff: invalid checkpoint index`);a.top<=e?(i=t,n=t+1):r=t-1}if(t==null)return i>=0?this.cache.checkpoints[i]:void 0;for(let e=i;e>=0;e--){let n=this.cache.checkpoints[e];if(n==null)throw Error(`VirtualizedFileDiff: invalid checkpoint index`);if(n.renderedLineIndex%t===0)return n}}getExpandedLineCount(e,t){let n=0;if(e.isPartial){for(let r of e.hunks)n+=t===`split`?r.splitLineCount:r.unifiedLineCount;return n}let{expandUnchanged:r=!1,collapsedContextThreshold:i=1}=this.options,a=r?!0:this.hunksRenderer.getExpandedHunksMap();for(let[r,o]of e.hunks.entries()){let s=t===`split`?o.splitLineCount:o.unifiedLineCount;n+=s;let c=Math.max(o.collapsedBefore,0),{fromStart:l,fromEnd:u,renderAll:d}=Ei({isPartial:e.isPartial,rangeSize:c,expandedHunks:a,hunkIndex:r,collapsedContextThreshold:i});c>0&&(n+=d?c:l+u)}let o=Oi({fileDiff:e,hunkIndex:e.hunks.length-1,expandedHunks:a,collapsedContextThreshold:i,errorPrefix:`VirtualizedFileDiff`});return o!=null&&(n+=o.fromStart+o.fromEnd),n}computeRenderRangeFromWindow(e,t,{top:n,bottom:r}){let{disableFileHeader:i=!1,expandUnchanged:a=!1,collapsedContextThreshold:o=1}=this.options,{hunkLineCount:s,lineHeight:c}=this.metrics,l=this.getDiffStyle(),u=this.getHunkSeparatorType(),d=this.height,f=this.cache.totalLines>0?this.cache.totalLines:this.getExpandedLineCount(e,l),p=q(this.metrics,i),m=e.hunks.length>0?rr(this.metrics):0,{fileAnnotationHeight:h}=this.cache,g=p+h,_=Math.max(0,d-p-h-m),v=this.hasFileAnnotations(e),y=t+p,b=h>0&&v&&y<r&&y+h>n;if(t<n-d||t>r)return{startingLine:0,totalLines:0,bufferBefore:0,bufferAfter:d-p-m};if(f<=s||e.hunks.length===0)return{startingLine:0,totalLines:s,bufferBefore:0,bufferAfter:0};this.approximateLayoutCheckpoints(),f=this.cache.totalLines>0?this.cache.totalLines:f;let x=Math.ceil(Math.max(r-n,0)/c),S=Math.ceil(x/s)*s+s,C=S/s,w=C,T=[],E=(n+r)/2,D=this.getLayoutCheckpointBeforeTop(Math.max(0,n-t-S*c*2),s),O=t+(D?.top??g),k=D?.renderedLineIndex??0,A,j,M;if(Fi({diff:e,diffStyle:l,startingLine:D?.renderedLineIndex??0,expandedHunks:a?!0:this.hunksRenderer.getExpandedHunksMap(),collapsedContextThreshold:o,callback:({hunkIndex:e,hunk:i,collapsedBefore:a,collapsedAfter:o,deletionLine:c,additionLine:d})=>{let f=d==null?c.splitLineIndex:d.splitLineIndex,p=d==null?c.unifiedLineIndex:d.unifiedLineIndex,m=(d?.noEOFCR??!1)||(c?.noEOFCR??!1),h=(a>0?Ni({type:u,metrics:this.metrics,hunkIndex:e,hunkSpecs:i?.hunkSpecs}):void 0)?.totalHeight??0;O+=h;let _=k%s===0,v=Math.floor(k/s);if(_&&(T[v]=O-(t+g+h),M!=null)){if(M<=0)return!0;M--}let y=this.getLineHeight(l===`split`?f:p,m);return O>n-y&&O<r&&(A??=v),j==null&&O+y>E&&(j=v),M==null&&O>=r&&_&&(M=w),k++,O+=y,o>0&&(O+=Pi({type:u,metrics:this.metrics})?.totalHeight??0),!1}}),A==null)if(b)A=0,j=0;else return{startingLine:0,totalLines:0,bufferBefore:0,bufferAfter:d-p-m};j??=A;let N=Math.round(j-C/2),ee=Math.max(0,Math.ceil(f/s)-C),te=Math.max(0,Math.min(N,ee)),ne=te*s,P=N<0?S+N*s:S,re=T[te]??0,ie=ne===0?0:h+re,ae=te+P/s,oe=ae<T.length?_-T[ae]:_-(O-t-g);return{startingLine:ne,totalLines:P,bufferBefore:ie,bufferAfter:Math.max(0,oe)}}};function xa(e){let t;for(let n of e){if(n==null)continue;let e=n.children[1];if(e instanceof HTMLElement)for(let n of e.children)n instanceof HTMLElement&&n.dataset.lineAnnotation===En&&(t=Math.max(t??0,n.getBoundingClientRect().height))}return t}function Sa(e){let t=Array.from(e).sort((e,t)=>e[0]-t[0]),n=[],r=[0],i=0;for(let[e,a]of t)n.push(e),i+=a,r.push(i);return{lineIndexes:n,prefixTotals:r}}function Ca({lineIndexes:e,prefixTotals:t},n,r){if(n>=r||e.length===0)return 0;let i=wa(e,n);return(t[wa(e,r)]??0)-(t[i]??0)}function wa(e,t){let n=0,r=e.length;for(;n<r;){let i=n+r>>1,a=e[i];if(a==null)throw Error(`VirtualizedFileDiff: invalid prefix index`);a<t?n=i+1:r=i}return n}function Ta(e){return Math.ceil(e/va)*va}function Ea(e,t){let n=0;for(let r of e)r<t&&n++;return n}function Da({diffStyle:e,hunk:t,rowCount:n}){if(n<=0||!t.noEOFCRAdditions&&!t.noEOFCRDeletions)return[];let r=t.hunkContent.at(-1);if(r==null)return[];if(r.type===`context`)return[n-1];let i=Math.max(r.deletions,r.additions),a=r.deletions+r.additions;if(e===`split`)return i>0&&(t.noEOFCRAdditions||t.noEOFCRDeletions)?[n-1]:[];let o=[],s=n-a;return r.deletions>0&&t.noEOFCRDeletions&&o.push(s+r.deletions-1),r.additions>0&&t.noEOFCRAdditions&&o.push(n-1),o}function Oa(e,t){return(e.diffStyle??`split`)!==(t.diffStyle??`split`)||(e.overflow??`scroll`)!==(t.overflow??`scroll`)||(e.collapsed??!1)!==(t.collapsed??!1)||(e.disableLineNumbers??!1)!==(t.disableLineNumbers??!1)||(e.disableFileHeader??!1)!==(t.disableFileHeader??!1)||(e.diffIndicators??`bars`)!==(t.diffIndicators??`bars`)||(e.hunkSeparators??`line-info`)!==(t.hunkSeparators??`line-info`)||(e.expandUnchanged??!1)!==(t.expandUnchanged??!1)||(e.collapsedContextThreshold??1)!==(t.collapsedContextThreshold??1)||e.unsafeCSS!==t.unsafeCSS}function ka(e,t){return(e.disableFileHeader??!1)!==(t.disableFileHeader??!1)||(e.hunkSeparators??`line-info`)!==(t.hunkSeparators??`line-info`)||(e.expandUnchanged??!1)!==(t.expandUnchanged??!1)||(e.collapsedContextThreshold??1)!==(t.collapsedContextThreshold??1)}function Aa(e){return typeof e==`function`?`custom`:e??`line-info`}function ja(e,t){let[n,r]=e.split(`,`).map(Number);return t===`split`?r:n}function Ma({hunkIndex:e,lineIndex:t,conflictIndex:n}){return`merge-conflict-action-${e}-${t}-${n}`}function Na(e,t){let n=t.hunks[e.hunkIndex];if(n!=null)return{hunkIndex:e.hunkIndex,lineIndex:Pa(n,e.startContentIndex)}}function Pa(e,t){let n=e.unifiedLineStart;for(let r=0;r<t;r++){let t=e.hunkContent[r];n+=t.type===`context`?t.lines:t.deletions+t.additions}return n}function Fa(e){let t=gr(e);if(t.length!==1)throw console.error(t),Error(`PatchDiff: Provided patch must include only 1 patch, with 1 diff`);let{files:n}=t[0];if(n.length!==1)throw console.error(n),Error(`FileDiff: Provided patch must contain exactly 1 file diff`);return n[0]}var Ia={position:`absolute`,top:0,bottom:0,textAlign:`center`,whiteSpace:`normal`,touchAction:`none`},La={display:`contents`};function Ra(){return null}var Z=t();function za({fileDiff:e,actions:t,renderCustomHeader:n,renderHeaderPrefix:r,renderHeaderMetadata:i,renderAnnotation:a,renderGutterUtility:o,renderMergeConflictUtility:s,lineAnnotations:c,getHoveredLine:l,getInstance:u}){let d=n?.(e),f=r?.(e),p=i?.(e);return(0,Z.jsxs)(Z.Fragment,{children:[d==null?(0,Z.jsxs)(Z.Fragment,{children:[f!=null&&(0,Z.jsx)(`div`,{slot:`header-prefix`,children:f}),p!=null&&(0,Z.jsx)(`div`,{slot:`header-metadata`,children:p})]}):(0,Z.jsx)(`div`,{slot:ne,children:d}),a!=null&&c?.map((e,t)=>(0,Z.jsx)(`div`,{slot:U(e),children:a(e)},t)),t!=null&&s!=null&&u!=null&&t.map(t=>{if(t==null)return;let n=Ba(t,e);return(0,Z.jsx)(`div`,{slot:n,style:La,children:s(t,u)},n)}),o!=null&&(0,Z.jsx)(`div`,{slot:`gutter-utility-slot`,style:Ia,children:o(l)})]})}function Ba(e,t){let n=Na(e,t);return n==null?void 0:Ma({hunkIndex:n.hunkIndex,lineIndex:n.lineIndex,conflictIndex:e.conflictIndex})}var Q=e(n(),1);function Va(e){let t=(0,Q.useRef)(e);return(0,Q.useInsertionEffect)(()=>void(t.current=e)),(0,Q.useCallback)((...e)=>t.current(...e),[])}var Ha=(0,Q.createContext)(void 0);function Ua(e,t){return typeof window>`u`&&t!=null?(0,Z.jsxs)(Z.Fragment,{children:[(0,Z.jsx)(`template`,{shadowrootmode:`open`,dangerouslySetInnerHTML:{__html:t}}),e]}):(0,Z.jsx)(Z.Fragment,{children:e})}var Wa=(0,Q.createContext)(void 0);function Ga(){return(0,Q.useContext)(Wa)}var Ka=typeof window>`u`?Q.useEffect:Q.useLayoutEffect;function qa({fileDiff:e,options:t,lineAnnotations:n,selectedLines:r,prerenderedHTML:i,metrics:a,hasGutterRenderUtility:o,hasCustomHeader:s,disableWorkerPool:c}){let l=Ga(),u=r!==void 0,d=(0,Q.useContext)(Ha),f=(0,Q.useRef)(null),p=Va(r=>{if(r!=null){if(f.current!=null)throw Error(`useFileDiffInstance: An instance should not already exist when a node is created`);l==null?f.current=new la(Ja({controlledSelection:u,hasCustomHeader:s,hasGutterRenderUtility:o,options:t}),c?void 0:d,!0):f.current=new ba(Ja({controlledSelection:u,hasCustomHeader:s,hasGutterRenderUtility:o,options:t}),l,a,c?void 0:d,!0),f.current.hydrate({fileDiff:e,fileContainer:r,lineAnnotations:n,prerenderedHTML:i})}else{if(f.current==null)throw Error(`useFileDiffInstance: A FileDiff instance should exist when unmounting`);f.current.cleanUp(),f.current=null}});return Ka(()=>{let{current:i}=f;if(i==null)return;let a=Ja({controlledSelection:u,hasCustomHeader:s,hasGutterRenderUtility:o,options:t}),c=!me(i.options,a);i.setOptions(a),i.render({forceRender:c,fileDiff:e,lineAnnotations:n}),r!==void 0&&i.setSelectedLines(r)}),{ref:p,getHoveredLine:(0,Q.useCallback)(()=>f.current?.getHoveredLine(),[])}}function Ja({options:e,controlledSelection:t,hasCustomHeader:n,hasGutterRenderUtility:r}){return!t&&!r&&!n?e:{...e,controlledSelection:t,renderCustomHeader:n?Ra:e?.renderCustomHeader,renderGutterUtility:r?Ra:e?.renderGutterUtility}}function Ya({oldFile:e,newFile:t,options:n,metrics:r,lineAnnotations:i,selectedLines:a,className:o,style:s,prerenderedHTML:c,renderAnnotation:l,renderCustomHeader:u,renderHeaderPrefix:d,renderHeaderMetadata:f,renderGutterUtility:p,disableWorkerPool:m=!1}){let h=(0,Q.useMemo)(()=>mi(e,t,n?.parseDiffOptions),[e,t,n?.parseDiffOptions]),{ref:g,getHoveredLine:_}=qa({fileDiff:h,options:n,metrics:r,lineAnnotations:i,selectedLines:a,prerenderedHTML:c,hasGutterRenderUtility:p!=null,hasCustomHeader:u!=null,disableWorkerPool:m});return(0,Z.jsx)(D,{ref:g,className:o,style:s,children:Ua(za({fileDiff:h,renderCustomHeader:u,renderHeaderPrefix:d,renderHeaderMetadata:f,renderAnnotation:l,lineAnnotations:i,renderGutterUtility:p,getHoveredLine:_}),c)})}function Xa({patch:e,options:t,metrics:n,lineAnnotations:r,selectedLines:i,className:a,style:o,prerenderedHTML:s,renderAnnotation:c,renderCustomHeader:l,renderHeaderPrefix:u,renderHeaderMetadata:d,renderGutterUtility:f,disableWorkerPool:p=!1}){let m=Za(e),{ref:h,getHoveredLine:g}=qa({fileDiff:m,options:t,metrics:n,lineAnnotations:r,selectedLines:i,prerenderedHTML:s,hasGutterRenderUtility:f!=null,hasCustomHeader:l!=null,disableWorkerPool:p});return(0,Z.jsx)(D,{ref:h,className:a,style:o,children:Ua(za({fileDiff:m,renderCustomHeader:l,renderHeaderPrefix:u,renderHeaderMetadata:d,renderAnnotation:c,lineAnnotations:r,renderGutterUtility:f,getHoveredLine:g}),s)})}function Za(e){return(0,Q.useMemo)(()=>Fa(e),[e])}function Qa(e,t){if(!t||typeof window>`u`)return!1;try{return window.localStorage.getItem(`${e}${t}`)===`1`}catch{return!1}}function $a(e,t,n){if(!(!t||typeof window>`u`))try{window.localStorage.setItem(`${e}${t}`,n?`1`:`0`)}catch{}}function eo(){return typeof CSS<`u`&&!!CSS.highlights&&typeof Highlight==`function`}function to(e){let t=new Map;return{publish(n,r){if(r)t.set(n,r);else if(!t.delete(n))return;if(eo())for(let n of e){let e=new Highlight;for(let r of t.values())for(let t of r[n]??[])e.add(t);e.size?CSS.highlights.set(n,e):CSS.highlights.delete(n)}}}}var no=1440*6e4;function ro(e){try{window.ade?.analytics?.capture({event:`ade_feature_used`,properties:{feature:`find`,action:`find_opened`,outcome:e,source:`renderer_route`},dedupeKey:`find_opened:${e}`,minimumIntervalMs:no}).catch(()=>void 0)}catch{}}function io(e){let t=e.toLowerCase().replace(/ς/g,`σ`);if(t.length===e.length)return t;let n=``;for(let t of e){let e=t.toLowerCase().replace(/ς/g,`σ`);n+=e.length===t.length?e:t}return n}function ao(e,t,n){if(!t||e.length<t.length)return 0;let r=0,i=0;for(;;){let a=e.indexOf(t,i);if(a<0)return r;n?.(a),r+=1,i=a+t.length}}function oo(e,t){return ao(e,t)}function so(e,t,n){return e<=0?null:t==null?n>0?0:e-1:((t+n)%e+e)%e}var co=new Set([`SCRIPT`,`STYLE`,`TEXTAREA`,`INPUT`,`SELECT`,`SVG`,`IFRAME`,`NOSCRIPT`]),lo=new Set(`ADDRESS.ARTICLE.ASIDE.BLOCKQUOTE.BR.DD.DETAILS.DIV.DL.DT.FIGCAPTION.FIGURE.FOOTER.H1.H2.H3.H4.H5.H6.HEADER.HR.LI.MAIN.NAV.OL.P.PRE.SECTION.SUMMARY.TABLE.TBODY.TD.TH.THEAD.TR.UL`.split(`.`));function uo(e){let t=[],n=``,r=()=>{n.length&&!n.endsWith(`
`)&&(n+=`
`)},i=e=>{if(e.nodeType===Node.TEXT_NODE){let r=e.data;if(!r)return;t.push({node:e,start:n.length}),n+=r;return}if(!(e instanceof Element))return;let a=e.tagName.toUpperCase();if(co.has(a)||a===`BUTTON`&&!e.hasAttribute(`data-ade-find-include`)||e.hasAttribute(`data-ade-find-skip`)||e.getAttribute(`aria-hidden`)===`true`)return;let o=lo.has(a);o&&r();for(let t=e.firstChild;t;t=t.nextSibling)i(t);o&&r()};return i(e),{text:n,runs:t}}function fo(e,t,n){let r=0,i=e.length-1;for(;r<=i;){let a=r+i>>1,o=e[a],s=o.start+o.node.data.length;if(t<o.start)i=a-1;else if(n?t>s:t>=s)r=a+1;else return{node:o.node,offset:t-o.start}}return null}function po(e,t){if(!t)return[];let{text:n,runs:r}=uo(e),i=[];return ao(io(n),t,e=>{let n=fo(r,e,!1),a=fo(r,e+t.length,!0);if(!n||!a)return;let o=document.createRange();try{o.setStart(n.node,n.offset),o.setEnd(a.node,a.offset)}catch{return}i.push(o)}),i}var mo=to([`ade-find`,`ade-find-active`]);function $(e,t){mo.publish(e,t&&(t.all.length||t.active)?{"ade-find":t.all.filter(e=>e!==t.active),"ade-find-active":t.active?[t.active]:[]}:null)}function ho(e){if(!e.query.trim())return``;let t=`${e.total}${e.partial?`+`:``}`;return e.total===0?e.partial?`Searching…`:`No results`:e.activeIndex==null?`${t} ${e.total===1&&!e.partial?`match`:`matches`}`:`${e.activeIndex+1} of ${t}`}var go=.35,_o=48,vo=1/4,yo=1/3;function bo(e,t,n={}){let i=t.getBoundingClientRect();if(!i.width&&!i.height)return;let a=r(e)||1,o=e.getBoundingClientRect(),s=o.top+(n.covered?.top??0),c=Math.max(s+1,o.bottom-(n.covered?.bottom??0)),l=c-s,u=Math.min(_o,l*vo);if(i.top<s+u||i.bottom>c-u){let t=e.scrollTop+(i.top-s-l*go)/a;n.scrollTo?n.scrollTo(t):e.scrollTop=t}let d=t.startContainer.parentElement;for(;d&&d!==e&&d.scrollWidth<=d.clientWidth;)d=d.parentElement;if(!d||d===e)return;let f=t.getBoundingClientRect(),p=d.getBoundingClientRect(),m=Math.min(_o,p.width*vo);(f.left<p.left+m||f.right>p.right-m)&&(d.scrollLeft+=(f.left-p.left-p.width*yo)/a)}var xo=1500;function So(e){let t=performance.now(),n=!1,r=()=>{let i=e.current,a=document.activeElement;if(i&&a===i){n=!0;return}let o=!a||a===document.body||a===document.documentElement;i?.isConnected&&(o||!n)&&!i.closest(`[inert]`)&&(i.focus(),i.select(),document.activeElement===i&&(n=!0)),performance.now()-t<xo&&requestAnimationFrame(r)};requestAnimationFrame(r)}function Co({inputRef:e,query:t,onQueryChange:n,onStep:r,onClose:i,status:o,statusTone:l=`count`,canStep:u,placeholder:d,inputClassName:f,buttonClassName:m}){return(0,Z.jsxs)(Z.Fragment,{children:[(0,Z.jsx)(s,{size:13,className:`shrink-0 text-muted-fg/55`,"aria-hidden":!0}),(0,Z.jsx)(`input`,{ref:e,value:t,onChange:e=>n(e.target.value),onKeyDownCapture:e=>{e.key===`Escape`&&(e.preventDefault(),e.stopPropagation(),e.nativeEvent.stopImmediatePropagation(),i())},onKeyDown:e=>{e.key!==`Enter`||e.nativeEvent.isComposing||(e.preventDefault(),r(e.shiftKey?-1:1))},placeholder:d,"aria-label":d,spellCheck:!1,autoComplete:`off`,className:p(`h-full min-w-0 flex-1 bg-transparent text-[12px] text-fg/85 outline-none placeholder:text-muted-fg/45 focus:shadow-none! focus-visible:shadow-none!`,f)}),(0,Z.jsx)(`span`,{role:`status`,"aria-live":`polite`,className:p(`min-w-0 shrink-0 truncate text-[10.5px]`,l===`warning`?`font-sans text-amber-200/85`:`font-mono text-muted-fg/70`),children:o}),(0,Z.jsx)(`button`,{type:`button`,onClick:()=>r(-1),disabled:!u,title:`Previous match (⇧↵)`,"aria-label":`Previous match`,className:m,children:(0,Z.jsx)(E,{size:12})}),(0,Z.jsx)(`button`,{type:`button`,onClick:()=>r(1),disabled:!u,title:`Next match (↵)`,"aria-label":`Next match`,className:m,children:(0,Z.jsx)(a,{size:12})}),(0,Z.jsx)(`button`,{type:`button`,onClick:i,title:`Close (Esc)`,"aria-label":`Close find bar`,className:m,children:(0,Z.jsx)(c,{size:12})})]})}function wo({className:e,...t}){return(0,Z.jsx)(`div`,{className:`pointer-events-none absolute inset-x-0 top-1.5 z-20 flex justify-end px-2`,children:(0,Z.jsx)(`form`,{role:`search`,"aria-label":t.placeholder,"data-ade-escape-scope":`find`,"data-ade-find-skip":``,onSubmit:e=>{e.preventDefault(),t.onStep(1)},onMouseDown:e=>{e.target!==t.inputRef.current&&e.preventDefault()},className:p(`kit-card kit-find-bar pointer-events-auto w-[min(360px,100%)]`,e),children:(0,Z.jsx)(Co,{...t,buttonClassName:`kit-icon-btn`})})})}function To({ownsFind:e,onStep:t,onClosed:n,paint:r,escapeRootRef:i,openedByShortcut:a}){let[o,s]=(0,Q.useState)(!1),c=(0,Q.useRef)(!1),l=(0,Q.useRef)(null),u=(0,Q.useRef)(null),d=(0,Q.useId)(),f=(0,Q.useRef)(e);f.current=e;let p=(0,Q.useRef)(a);p.current=a;let m=(0,Q.useRef)(t);m.current=t;let h=(0,Q.useRef)(n);h.current=n;let g=(0,Q.useRef)(r);g.current=r;let _=(0,Q.useRef)(null),v=(0,Q.useCallback)(()=>{_.current!=null&&cancelAnimationFrame(_.current),_.current=null},[]),y=(0,Q.useCallback)(()=>{_.current??=requestAnimationFrame(()=>{_.current=null,g.current()})},[]),b=(0,Q.useCallback)(()=>{if(!c.current){let e=document.activeElement;u.current=e instanceof HTMLElement&&e!==document.body?e:null,c.current=!0,s(!0)}So(l)},[]),x=(0,Q.useCallback)(()=>{c.current=!1,s(!1),v(),h.current(),$(d,null);let e=u.current;u.current=null,e?.isConnected&&e.focus({preventScroll:!0})},[v,d]);return(0,Q.useEffect)(()=>()=>{v(),$(d,null)},[v,d]),(0,Q.useEffect)(()=>(C(),w(e=>{if(e!==`find`||!f.current())return!1;let t=c.current;return b(),t||p.current?.(),!0})),[b]),(0,Q.useEffect)(()=>{if(!o)return;let e=e=>{if(e.defaultPrevented)return;if(e.key===`Escape`){let t=e.target,n=i.current;if(!(t===document.body||t instanceof Node&&n?.contains(t))||!f.current())return;e.preventDefault(),x();return}let t=T(e,`Mod+G`);!t&&!T(e,`Mod+Shift+G`)||f.current()&&(e.preventDefault(),m.current(t?1:-1))};return window.addEventListener(`keydown`,e),()=>window.removeEventListener(`keydown`,e)},[x,i,o]),{open:o,openRef:c,inputRef:l,surfaceId:d,openBar:b,closeBar:x,schedulePaint:y}}var Eo=null;async function Do(){return Eo||=(async()=>{let[{default:e},{default:t}]=await Promise.all([i(()=>import(`./vendor-monaco-C1gXc9CV.js`).then(e=>e.o),__vite__mapDeps([0,1,2])),i(()=>import(`./vendor-monaco-C1gXc9CV.js`).then(e=>e.n),__vite__mapDeps([0,1,2]))]),n=globalThis,r=n.MonacoEnvironment;return n.MonacoEnvironment={...r,getWorker:r?.getWorker??((n,r)=>r===`typescript`||r===`javascript`?new t:new e)},await i(()=>import(`./vendor-monaco-C1gXc9CV.js`).then(e=>e.s),__vite__mapDeps([0,1,2]))})(),await Eo}function Oo(e,t){try{e?.setModel(null)}catch{}if(t){try{t.original.dispose()}catch{}try{t.modified.dispose()}catch{}}}var ko=(0,Q.forwardRef)(function({diff:e,editable:t=!1,className:n,theme:r=`dark`},i){let a=(0,Q.useRef)(null),o=(0,Q.useRef)(null),s=(0,Q.useRef)(null),c=(0,Q.useRef)(t),[l,u]=(0,Q.useState)(!1),[f,g]=(0,Q.useState)(!1),_=r===`light`?`vs`:`vs-dark`,v=h(),y=(0,Q.useRef)(v);y.current=v;let b=(0,Q.useRef)(_);(0,Q.useImperativeHandle)(i,()=>({getModifiedValue:()=>o.current?.getModel()?.modified.getValue()??null,revealLineInCenter:e=>{try{(o.current?.getModifiedEditor())?.revealLineInCenter(e)}catch{}}})),(0,Q.useEffect)(()=>{c.current=t},[t]),(0,Q.useEffect)(()=>{b.current=_},[_]);let x=(0,Q.useRef)(null);return(0,Q.useEffect)(()=>(C(),w(e=>{if(e!==`find`)return!1;let t=x.current,n=o.current;if(!n||!S(t))return!1;let r=n.getOriginalEditor();return(r.hasTextFocus()?r:n.getModifiedEditor()).getAction(`actions.find`)?.run(),!0})),[]),(0,Q.useEffect)(()=>{let e=!1;return Do().then(t=>{e||a.current&&(o.current=t.editor.createDiffEditor(a.current,{readOnly:!c.current,automaticLayout:!0,renderSideBySide:!0,minimap:{enabled:!1},scrollbar:{verticalScrollbarSize:8,horizontalScrollbarSize:8},fontFamily:d,fontSize:13,lineHeight:18,scrollBeyondLastLine:!1,theme:m(t,y.current,b.current)}),g(!1),u(!0))}).catch(()=>{e||g(!0)}),()=>{e=!0,Oo(o.current,s.current),s.current=null;try{o.current?.dispose()}catch{}o.current=null}},[]),(0,Q.useEffect)(()=>{let t=!1;return Do().then(n=>{if(t)return;let r=o.current;if(!r)return;if(e.isBinary){Oo(r,s.current),s.current=null;return}Oo(r,s.current);let i=e.language??void 0,a=n.editor.createModel(e.original.text??``,i),l=n.editor.createModel(e.modified.text??``,i);s.current={original:a,modified:l},r.setModel({original:a,modified:l}),r.getModifiedEditor().updateOptions({readOnly:!c.current}),r.getOriginalEditor().updateOptions({readOnly:!0})}).catch(()=>{t||g(!0)}),()=>{t=!0}},[e,l]),(0,Q.useEffect)(()=>{let e=o.current;e&&(e.getModifiedEditor().updateOptions({readOnly:!t}),e.getOriginalEditor().updateOptions({readOnly:!0}))},[t]),(0,Q.useEffect)(()=>{let e=!1;return Do().then(t=>{e||t.editor.setTheme(m(t,v,_))}).catch(()=>{e||g(!0)}),()=>{e=!0}},[_,v]),(0,Z.jsxs)(`div`,{ref:x,"data-ade-find-scope":`diff-editor`,className:p(`relative h-full w-full overflow-hidden rounded-lg border border-border bg-card/60`,n),children:[(0,Z.jsx)(`div`,{ref:a,className:p(`h-full w-full`,(f||e.isBinary)&&`hidden`)}),e.isBinary?(0,Z.jsx)(`div`,{className:`flex h-full w-full items-center justify-center p-4 text-xs text-muted-fg`,children:`Binary diff preview unavailable.`}):null,!l&&!f&&!e.isBinary?(0,Z.jsx)(`div`,{className:`pointer-events-none absolute inset-0 flex items-center justify-center p-4 text-sm text-muted-fg`,children:`Loading diff editor…`}):null,f&&!e.isBinary?(0,Z.jsxs)(`div`,{className:`h-full w-full overflow-auto p-3 text-xs`,children:[(0,Z.jsx)(`div`,{className:`mb-2 rounded border border-amber-400/30 bg-amber-500/10 px-2 py-1 text-amber-200`,children:`Monaco failed to load in dev mode. Showing plain-text diff fallback.`}),(0,Z.jsxs)(`div`,{className:`grid h-[calc(100%-36px)] grid-cols-1 gap-2 md:grid-cols-2`,children:[(0,Z.jsxs)(`div`,{className:`min-h-0 overflow-auto rounded border border-border bg-bg p-2`,children:[(0,Z.jsx)(`div`,{className:`mb-1 text-[11px] font-semibold text-muted-fg`,children:`Original`}),(0,Z.jsx)(`pre`,{className:`whitespace-pre-wrap break-words font-mono text-[11px] leading-5`,children:e.original.text??``})]}),(0,Z.jsxs)(`div`,{className:`min-h-0 overflow-auto rounded border border-border bg-bg p-2`,children:[(0,Z.jsx)(`div`,{className:`mb-1 text-[11px] font-semibold text-muted-fg`,children:t?`Modified (editable in Monaco only)`:`Modified`}),(0,Z.jsx)(`pre`,{className:`whitespace-pre-wrap break-words font-mono text-[11px] leading-5`,children:e.modified.text??``})]})]})]}):null]})});function Ao(e){return e.trim()}function jo(e,t){let n=e=>{let t=e.replace(/\r\n/g,`
`).split(`
`);for(;t.length>1&&t[t.length-1]===``;)t.pop();return t.map(Ao)},r=n(e),i=n(t);if(r.length!==i.length)return!1;for(let e=0;e<r.length;e+=1)if(r[e]!==i[e])return!1;return!0}function Mo(e){return!!(e.startsWith(`-`)||e.startsWith(`+`))}function No(e){let t=[],n=0,r=0;for(;r<e.length;){let i=e[r];if(!Mo(i)){t.push(i),r+=1;continue}let a=[],o=[],s=[],c=[];for(;r<e.length;){let t=e[r];if(t.startsWith(`-`))a.push(t),s.push(null);else if(t.startsWith(`+`))o.push(t),c.push(null);else if(t.startsWith(`\\`)&&(o.length>0||a.length>0))o.length>0?c[o.length-1]=t:s[a.length-1]=t;else break;r+=1}let l=Math.min(a.length,o.length);for(let e=0;e<l;e+=1){let r=a[e].slice(1),i=o[e].slice(1),l=s[e],u=c[e];if(Ao(r)===Ao(i)&&!!l==!!u){t.push(` ${i}`),u&&t.push(u);continue}t.push(a[e]),l&&t.push(l),t.push(o[e]),u&&t.push(u),n+=1}for(let e=l;e<a.length;e+=1)t.push(a[e]),s[e]&&t.push(s[e]),n+=1;for(let e=l;e<o.length;e+=1)t.push(o[e]),c[e]&&t.push(c[e]),n+=1}return{lines:t,changes:n}}function Po(e){return e.startsWith(`diff --git `)||e.startsWith(`diff --cc `)}function Fo(e){let t=e.split(`
`),n=[],r=!1,i=!1,a=0;for(;a<t.length;){let e=t[a];if(!e.startsWith(`@@`)){n.push(e),a+=1;continue}r=!0;let o=a+1;for(;o<t.length&&!t[o].startsWith(`@@`)&&!Po(t[o]);)o+=1;let s=No(t.slice(a+1,o));s.changes>0&&(n.push(e),n.push(...s.lines),i=!0),a=o}return!r||i?{patch:n.join(`
`),whitespaceOnly:!1}:{patch:``,whitespaceOnly:!0}}var Io=`diffs-container`;function Lo(e){let t=[];for(let n of e.querySelectorAll(Io))n.shadowRoot&&t.push(n.shadowRoot);return t}function Ro(e){if(e.closest(`[data-deletions]`))return{old:!0,new:!1};if(e.closest(`[data-additions]`))return{old:!1,new:!0};let t=e.getAttribute(`data-line-type`)??``;return t.includes(`deletion`)?{old:!0,new:!1}:t.includes(`addition`)?{old:!1,new:!0}:{old:!0,new:!0}}function zo(e,t){let n=[],r=0,i=0;for(let a of Lo(e))for(let e of a.querySelectorAll(`[data-line]`)){let a=po(e,t);if(!a.length)continue;let o=Ro(e);o.old&&(r+=a.length),o.new&&(i+=a.length);let s=e.getBoundingClientRect();n.push({ranges:a,top:s.top,left:s.left})}return n.sort((e,t)=>e.top-t.top||e.left-t.left),{ranges:n.flatMap(e=>e.ranges),oldDrawn:r,newDrawn:i}}function Bo(e){return Lo(e).some(e=>e.querySelector(`[data-expand-button], [data-unmodified-lines]`)!=null)}function Vo(e,t){if(!e)return null;let n=t.current;if(n&&n.source.old===e.old&&n.source.new===e.new)return n.folded;let r={old:io(e.old),new:io(e.new)};return t.current={source:e,folded:r},r}function Ho({rootRef:e,scrollRef:t,fullText:n}){let[r,i]=(0,Q.useState)(``),[a,o]=(0,Q.useState)(0),[s,c]=(0,Q.useState)(null),[l,u]=(0,Q.useState)(!1),d=(0,Q.useRef)(r);d.current=r;let f=(0,Q.useRef)(s);f.current=s;let p=(0,Q.useRef)(l);p.current=l;let m=(0,Q.useRef)([]),h=(0,Q.useRef)(n);h.current=n;let g=(0,Q.useRef)(null),_=(0,Q.useRef)(!1),v=(0,Q.useCallback)(()=>S(e.current),[e]),y=(0,Q.useRef)({step:e=>{},clearMatches:()=>{},recompute:()=>{},reveal:e=>{}}),{open:b,openRef:x,inputRef:C,surfaceId:w,closeBar:T,schedulePaint:E}=To({ownsFind:v,onStep:e=>y.current.step(e),onClosed:()=>y.current.clearMatches(),paint:()=>y.current.recompute(),escapeRootRef:e,openedByShortcut:()=>ro(`diff_shortcut`)});y.current.reveal=e=>{let n=t.current;if(!n)return;let r=C.current?.closest(`form`)?.getBoundingClientRect();bo(n,e,{covered:{top:r?Math.max(0,r.bottom-n.getBoundingClientRect().top):0,bottom:0}})};let D=(0,Q.useCallback)(()=>{let n=e.current;if(!x.current||!n||!d.current.trim()){m.current=[],f.current=null,o(0),c(null),$(w,null);return}let r=io(d.current),{ranges:i,oldDrawn:a,newDrawn:s}=zo(n,r);if(m.current=i,!p.current&&Bo(n)){let e=Vo(h.current,g);e&&(oo(e.old,r)>a||oo(e.new,r)>s)&&(p.current=!0,_.current=!0,u(!0))}o(i.length);let l=f.current,v=!1;if(_.current&&!Bo(n)&&(_.current=!1,v=!0),l==null){let e=t.current?.getBoundingClientRect().top??0,n=i.findIndex(t=>t.getBoundingClientRect().bottom>e);l=i.length?Math.max(0,n):null,v=l!=null}else l>=i.length&&(l=i.length?i.length-1:null);f.current=l,c(l);let b=l==null?null:i[l]??null;$(w,{all:i,active:b}),b&&v&&y.current.reveal(b)},[x,e,t,w]);y.current.recompute=D;let O=(0,Q.useCallback)(e=>{let t=m.current,n=so(t.length,f.current,e);if(n==null)return;let r=t[n];r&&(f.current=n,c(n),$(w,{all:t,active:r}),y.current.reveal(r))},[w]);y.current.step=O;let k=(0,Q.useCallback)(()=>{p.current=!1,_.current=!1,u(!1),f.current=null,c(null),m.current=[]},[]);y.current.clearMatches=k;let A=(0,Q.useCallback)(e=>{d.current=e,i(e),f.current=null,c(null)},[]);return(0,Q.useEffect)(()=>{if(!b)return;let e=t.current;if(!e||typeof MutationObserver>`u`)return;let n=new MutationObserver(E),r=new Set,i=()=>{for(let t of Lo(e))r.has(t)||(r.add(t),n.observe(t,{childList:!0,subtree:!0,characterData:!0}))};i();let a=new MutationObserver(()=>{i(),E()});return a.observe(e,{childList:!0,subtree:!0}),()=>{n.disconnect(),a.disconnect()}},[b,E,t]),(0,Q.useLayoutEffect)(()=>{b&&E()},[b,r,E]),{open:b,expandAll:l,bar:{inputRef:C,query:r,onQueryChange:A,onStep:O,onClose:T,status:ho({query:r,total:a,activeIndex:s}),canStep:a>0}}}var Uo=`ade:diff:ignoreWhitespace:`;function Wo(e){return Qa(Uo,e)}function Go(e,t){$a(Uo,e,t)}var Ko=`
  [data-diffs-header="default"] {
    display: none;
  }
  [data-code] {
    scrollbar-width: thin;
  }
  [data-diff],
  [data-file] {
    border-radius: 0;
  }
  /* Find (⌘F) matches. The colours are index.css's variables, which inherit
     into this shadow root. */
  ::highlight(ade-find) {
    background-color: var(--ade-find-match);
  }
  ::highlight(ade-find-active) {
    background-color: var(--ade-find-current);
    color: var(--ade-find-current-fg);
  }
`,qo=`@max-[340px]:px-[5px]!`;function Jo(e,t){return u({height:24,padding:`0 8px`,fontSize:11,borderRadius:6,color:e?f.accent:f.textSecondary,whiteSpace:`nowrap`,flexShrink:0,...t})}function Yo(e,t,n){return{name:e,contents:t,cacheKey:`${e}:${n}:${t.length}`}}function Xo(e){let t=e.patch.trimEnd();if(!t)return``;if(t.startsWith(`diff --git `)||t.startsWith(`--- `))return t;let n=e.oldPath??e.path,r=e.status===`added`?`/dev/null`:`a/${n}`,i=e.status===`deleted`?`/dev/null`:`b/${e.path}`;return[`diff --git a/${n} b/${e.path}`,`--- ${r}`,`+++ ${i}`,t].join(`
`)}function Zo(e){navigator.clipboard?.writeText(e).catch(()=>{})}function Qo({title:e,detail:t}){return(0,Z.jsx)(`div`,{className:`flex h-full w-full items-center justify-center p-4`,children:(0,Z.jsxs)(`div`,{style:{maxWidth:420,textAlign:`center`},children:[(0,Z.jsx)(`div`,{style:{fontFamily:l,fontSize:13,color:f.textSecondary},children:e}),t?(0,Z.jsx)(`div`,{style:{marginTop:6,fontFamily:d,fontSize:11,lineHeight:1.5,color:f.textDim},children:t}):null]})})}var $o=12,es=20;function ts(e){return e.binary?{kind:`binary`,path:e.activePath}:e.usesPatch?e.findExpandAll&&e.patchFullFiles&&!e.filteredPatch?.whitespaceOnly?{kind:`files`,oldFile:e.patchFullFiles.old,newFile:e.patchFullFiles.new}:e.filteredPatch?e.filteredPatch.whitespaceOnly?{kind:`whitespace-hidden`}:{kind:`patch`,patch:e.filteredPatch.patch}:e.normalizedPatch?{kind:`patch`,patch:e.normalizedPatch}:{kind:`empty-patch`,path:e.activePath}:e.files?e.whitespaceOnlyTextDiff?{kind:`whitespace-hidden`}:e.hasInlineDiffContent?{kind:`files`,oldFile:e.files.old,newFile:e.files.new}:{kind:`no-text`,path:e.activePath}:{kind:`none`}}function ns(e,t){switch(e.kind){case`none`:return(0,Z.jsx)(Qo,{title:`No diff selected`});case`binary`:return(0,Z.jsx)(Qo,{title:`Binary diff preview unavailable`,detail:e.path});case`whitespace-hidden`:return(0,Z.jsx)(Qo,{title:`Whitespace-only changes hidden`,detail:`Turn off Whitespace to see them.`});case`patch`:return(0,Z.jsx)(Xa,{patch:e.patch,options:t});case`files`:return(0,Z.jsx)(Ya,{oldFile:e.oldFile,newFile:e.newFile,options:t});case`empty-patch`:return(0,Z.jsx)(Qo,{title:`No patch available`,detail:e.path});case`no-text`:return(0,Z.jsx)(Qo,{title:`No text diff available`,detail:e.path})}}var rs=(0,Q.forwardRef)(function({diff:e,patch:t,editable:n=!1,className:r,theme:i=`dark`,compact:a=!1,showToolbar:s=!0,persistKey:c},u){let m=(0,Q.useRef)(null),h=(0,Q.useRef)(null),g=(0,Q.useRef)(null),[_,v]=(0,Q.useState)(`split`),[y,b]=(0,Q.useState)(`scroll`),[x,S]=(0,Q.useState)(!0),[C,w]=(0,Q.useState)(()=>Wo(c)),T=(0,Q.useCallback)(()=>{w(e=>{let t=!e;return Go(c,t),t})},[c]);(0,Q.useImperativeHandle)(u,()=>({getModifiedValue:()=>m.current?.getModifiedValue()??null,revealLineInCenter:e=>{m.current?.revealLineInCenter(e)}}));let E=t?.path??e?.path??``,D=t?Xo(t):``,O=e&&!t?Yo(e.path,e.original.text??``,`old`):null,k=e&&!t?Yo(e.path,e.modified.text??``,`new`):null,A=!!(e&&!e.isBinary&&!e.original.isTruncated&&!e.modified.isTruncated&&typeof e.original.text==`string`&&typeof e.modified.text==`string`),j=t&&A&&e?{old:Yo(e.path,e.original.text??``,`old`),new:Yo(e.path,e.modified.text??``,`new`)}:null,M=O&&k?{old:O,new:k}:j,N=Ho({rootRef:h,scrollRef:g,fullText:M?{old:M.old.contents,new:M.new.contents}:null}),ee=!!(O&&k&&((e?.original.text??``).length>0||(e?.modified.text??``).length>0)),te=(0,Q.useMemo)(()=>({theme:i===`light`?`pierre-light`:`pierre-dark`,themeType:i,diffStyle:_,overflow:y,disableLineNumbers:!x,hunkSeparators:`line-info-basic`,lineDiffType:`word`,collapsedContextThreshold:$o,expansionLineCount:es,...N.expandAll?{expandUnchanged:!0}:{},unsafeCSS:Ko,...C?{parseDiffOptions:{ignoreWhitespace:!0}}:{}}),[N.expandAll,C,_,x,y,i]),ne=(0,Q.useMemo)(()=>C&&D?Fo(D):null,[C,D]),P=C&&O&&k?jo(O.contents,k.contents):!1;if(n&&e)return(0,Z.jsx)(ko,{ref:m,diff:e,editable:!0,className:r,theme:i});let re=!!(t?.isBinary||e?.isBinary),ie=!!(t?.isTruncated||e?.original.isTruncated||e?.modified.isTruncated),ae=ts({binary:re,usesPatch:!!t,activePath:E,normalizedPatch:D,filteredPatch:ne,files:O&&k?{old:O,new:k}:null,patchFullFiles:j,findExpandAll:N.expandAll,whitespaceOnlyTextDiff:P,hasInlineDiffContent:ee});return(0,Z.jsxs)(`div`,{ref:h,"data-ade-find-scope":`diff`,className:p(`flex h-full min-h-0 w-full flex-col overflow-hidden rounded-lg border border-border bg-card/60`,r),style:{"--diffs-font-family":d,"--diffs-header-font-family":l,"--diffs-font-size":a?`12px`:`13px`,"--diffs-line-height":a?`18px`:`20px`,"--diffs-dark-bg":`transparent`,"--diffs-light-bg":`transparent`},children:[s?(0,Z.jsxs)(`div`,{className:`@container flex shrink-0 flex-nowrap items-center gap-1 overflow-x-auto border-b border-border [scrollbar-width:none]`,style:{minHeight:a?30:34,padding:a?`3px 6px`:`4px 8px`,background:f.recessedBg},children:[(0,Z.jsx)(`button`,{type:`button`,className:qo,style:Jo(_===`split`),onClick:()=>v(`split`),children:`Split`}),(0,Z.jsx)(`button`,{type:`button`,className:qo,style:Jo(_===`unified`),onClick:()=>v(`unified`),children:`Unified`}),(0,Z.jsx)(`button`,{type:`button`,className:qo,style:Jo(y===`wrap`),onClick:()=>b(e=>e===`wrap`?`scroll`:`wrap`),children:`Wrap`}),(0,Z.jsx)(`button`,{type:`button`,className:qo,style:Jo(x),onClick:()=>S(e=>!e),children:`Lines`}),(0,Z.jsx)(`button`,{type:`button`,className:qo,style:Jo(C),title:`Ignore whitespace-only changes`,"aria-label":`Ignore whitespace-only changes`,"aria-pressed":C,onClick:T,children:`Whitespace`}),E?(0,Z.jsxs)(`button`,{type:`button`,className:qo,style:Jo(!1,{marginLeft:`auto`,gap:5}),onClick:()=>Zo(E),title:`Copy path: ${E}`,"aria-label":`Copy path`,children:[(0,Z.jsx)(o,{size:12,"aria-hidden":!0}),(0,Z.jsx)(`span`,{className:`hidden @[400px]:inline`,children:`Copy path`})]}):null]}):null,ie?(0,Z.jsx)(`div`,{style:{padding:`5px 8px`,borderBottom:`1px solid ${f.border}`,fontFamily:d,fontSize:11,color:f.warning},children:`Preview is truncated.`}):null,(0,Z.jsxs)(`div`,{className:`relative flex min-h-0 flex-1 flex-col`,children:[N.open?(0,Z.jsx)(wo,{...N.bar,placeholder:`Find in diff`}):null,(0,Z.jsx)(`div`,{ref:g,className:`min-h-0 flex-1 overflow-auto`,style:{paddingTop:N.open?42:void 0},children:ns(ae,te)})]})]})});export{oo as a,io as c,so as d,ro as f,$a as h,Co as i,$ as l,Qa as m,To as n,ho as o,to as p,wo as r,po as s,rs as t,bo as u};