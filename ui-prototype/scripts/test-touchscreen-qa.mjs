const endpoint=process.env.KING_WEBVIEW_DEBUG_URL??"http://127.0.0.1:9229";
const targets=await fetch(`${endpoint}/json/list`).then((response)=>response.json());
const main=targets.find((target)=>!target.url.includes("output.html")&&/localhost:1420|tauri\.localhost/.test(target.url));
if(!main)throw new Error("Main Tauri WebView target not found");

const socket=new WebSocket(main.webSocketDebuggerUrl);
let sequence=0;
const pending=new Map();
socket.addEventListener("message",(event)=>{const message=JSON.parse(String(event.data));if(!message.id||!pending.has(message.id))return;const handler=pending.get(message.id);pending.delete(message.id);message.error?handler.reject(new Error(JSON.stringify(message.error))):handler.resolve(message.result)});
await new Promise((resolve,reject)=>{socket.addEventListener("open",resolve,{once:true});socket.addEventListener("error",reject,{once:true})});
const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}))});
const evaluate=async(expression)=>{const result=await call("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});return result.result.value};

await evaluate(`(async()=>{const buttons=[...document.querySelectorAll('.bottom-nav button')];buttons.find((button)=>button.textContent.includes('设置'))?.click();await new Promise((resolve)=>setTimeout(resolve,380));[...document.querySelectorAll('.bottom-nav button')].find((button)=>button.textContent.includes('调音台'))?.click();await new Promise((resolve)=>setTimeout(resolve,380));[...document.querySelectorAll('.qu-processing label')].find((entry)=>entry.textContent.trim()==='Processing')?.querySelector('button')?.click();await new Promise((resolve)=>setTimeout(resolve,30));return true})()`);
await call("Input.dispatchMouseEvent",{type:"mouseMoved",x:1,y:1});

const geometry=await evaluate(`(()=>{
  const bank=document.querySelector('.qu-knob-bank');
  const screen=document.querySelector('.qu-touchscreen');
  const lcd=document.querySelector('.qu-lcd-panel');
  const touchChannel=document.querySelector('.qu-lcd-channel');
  const processing=document.querySelector('.qu-processing');
  const rotary=document.querySelector('.qu-screen-rotary .qu-rotary-control');
  const parametricRotary=document.querySelector('.parametric-eq .qu-rotary-control');
  const rotaryLine=document.querySelector('.qu-screen-rotary>i');
  const screenControls=document.querySelector('.qu-screen-controls');
  const rotaryZone=document.querySelector('.qu-screen-rotary');
  const oldTouchChannel=document.querySelector('.qu-superstrip>.qu-touchchannel');
  const rect=(node)=>{const value=node?.getBoundingClientRect();return value?{width:value.width,height:value.height,x:value.x,y:value.y}:null};
  return {
    bank:rect(bank),screen:rect(screen),lcd:rect(lcd),touchChannel:rect(touchChannel),processing:rect(processing),rotary:rect(rotary),parametricRotary:rect(parametricRotary),rotaryLine:rect(rotaryLine),screenControls:rect(screenControls),rotaryZone:rect(rotaryZone),
    lcdContent:{width:lcd?.clientWidth??0,height:lcd?.clientHeight??0},
    screenSelectCenters:[...(processing?.querySelectorAll('label')??[])].map((label)=>{const value=label.getBoundingClientRect();return value.y+value.height/2}),
    bottomButtons:[...document.querySelectorAll('.qu-screen-controls button')].map(rect),
    controlGroups:[...document.querySelectorAll('.qu-screen-fn,.qu-screen-edit-keys>label')].map(rect),
    bottomLabelStyle:(()=>{const style=getComputedStyle(document.querySelector('.qu-screen-controls label>span'));return {fontSize:style.fontSize,fontWeight:style.fontWeight,textTransform:style.textTransform}})(),
    screenSelectLabelStyle:(()=>{const style=getComputedStyle(document.querySelector('.qu-processing label>span'));return {fontSize:style.fontSize,fontWeight:style.fontWeight,textTransform:style.textTransform}})(),
    activeScreenLampColor:getComputedStyle(document.querySelector('.qu-processing label>button.active i')).backgroundColor,
    keyBackgrounds:{
      fn:getComputedStyle(document.querySelector('.qu-screen-fn button')).backgroundColor,
      copy:getComputedStyle(document.querySelector('.qu-screen-edit-keys label:nth-child(1) button')).backgroundColor,
      paste:getComputedStyle(document.querySelector('.qu-screen-edit-keys label:nth-child(2) button')).backgroundColor,
      reset:getComputedStyle(document.querySelector('.qu-screen-edit-keys label:nth-child(3) button')).backgroundColor,
      screenGreen:getComputedStyle(document.querySelector('.qu-processing label:nth-child(1)>button')).backgroundColor,
      screenGrey:getComputedStyle(document.querySelector('.qu-processing label:nth-child(3)>button')).backgroundColor
    },
    oldTouchChannel:Boolean(oldTouchChannel),touchInsideLcd:Boolean(touchChannel&&lcd?.contains(touchChannel)),
    screenSelectCount:processing?.querySelectorAll('label>button').length??0,
    activeScreenSelect:processing?.querySelectorAll('label>button.active').length??0,
    page:lcd?.dataset.screenPage,
    syncMode:lcd?.dataset.syncMode,
    fnInsideLcd:Boolean(lcd?.contains(document.querySelector('.qu-screen-fn'))),
    editInsideLcd:Boolean(lcd?.contains(document.querySelector('.qu-screen-edit-keys')))
  };
})()`);

if(geometry.oldTouchChannel||!geometry.touchInsideLcd)throw new Error(`TouchChannel hierarchy is invalid: ${JSON.stringify(geometry)}`);
if(geometry.screenSelectCount!==6||geometry.activeScreenSelect!==1||geometry.page!=="Processing")throw new Error(`Screen Select state is invalid: ${JSON.stringify(geometry)}`);
if(geometry.syncMode!=="local-ui-only"||geometry.fnInsideLcd||geometry.editInsideLcd)throw new Error(`Screen local-state/control hierarchy is invalid: ${JSON.stringify(geometry)}`);
const screenBankRatio=geometry.screen.width/geometry.bank.width;
const screenHeightRatio=geometry.screen.height/geometry.bank.height;
const touchWidthRatio=geometry.touchChannel.width/geometry.lcd.width;
const lcdContentAspect=geometry.lcdContent.width/geometry.lcdContent.height;
const controlBandRatio=geometry.screenControls.height/geometry.screen.height;
const rotaryZoneRatio=geometry.rotaryZone.width/geometry.screenControls.width;
const screenSelectGaps=geometry.screenSelectCenters.slice(1).map((center,index)=>center-geometry.screenSelectCenters[index]);
const rotaryCenter=geometry.rotary.y+geometry.rotary.height/2;
const rotaryLinePairCenter=geometry.rotaryLine.y+geometry.rotaryLine.height/2+4;
const buttonFaceCenters=geometry.bottomButtons.map((button)=>button.y+button.height/2);
const controlCenterSpread=Math.max(...buttonFaceCenters)-Math.min(...buttonFaceCenters);
const controlGroupCenters=geometry.controlGroups.map((group)=>group.y+group.height/2);
const opticalCenters=[...controlGroupCenters,rotaryCenter];
const opticalCenterSpread=Math.max(...opticalCenters)-Math.min(...opticalCenters);
const screenBottom=geometry.screen.y+geometry.screen.height;
const keyBottomGaps=geometry.bottomButtons.slice(0,4).map((button)=>screenBottom-button.y-button.height);
const rotaryBottomGap=screenBottom-geometry.rotary.y-geometry.rotary.height;
if(screenBankRatio<.55||screenBankRatio>.7||screenHeightRatio<.86||screenHeightRatio>.93||touchWidthRatio<.12||touchWidthRatio>.17)throw new Error(`Touch Screen proportions are invalid: ${JSON.stringify({screenBankRatio,screenHeightRatio,touchWidthRatio,geometry})}`);
if(lcdContentAspect<1.62||lcdContentAspect>1.71||controlBandRatio<.18||controlBandRatio>.27||rotaryZoneRatio<.27||rotaryZoneRatio>.36)throw new Error(`Touch Screen internal proportions are invalid: ${JSON.stringify({lcdContentAspect,controlBandRatio,rotaryZoneRatio,geometry})}`);
if(screenSelectGaps.length!==5||screenSelectGaps[1]<screenSelectGaps[0]+8||screenSelectGaps.slice(2).some((gap)=>gap<28||gap>38))throw new Error(`Screen Select grouping is invalid: ${JSON.stringify(screenSelectGaps)}`);
if(Math.abs(geometry.rotary.width-geometry.rotary.height)>.25||Math.abs(geometry.rotary.width-geometry.parametricRotary.width)>.5||Math.abs(geometry.rotary.height-geometry.parametricRotary.height)>.5)throw new Error(`Screen Rotary does not match the Parametric EQ rotary: ${JSON.stringify({screen:geometry.rotary,parametric:geometry.parametricRotary})}`);
if(Math.abs(rotaryCenter-rotaryLinePairCenter)>.5||opticalCenterSpread>1||keyBottomGaps.some((gap)=>gap<10||gap>12)||rotaryBottomGap<4||rotaryBottomGap>7)throw new Error(`Screen edit-row optical alignment is invalid: ${JSON.stringify({rotaryCenter,rotaryLinePairCenter,buttonFaceCenters,controlCenterSpread,controlGroupCenters,opticalCenterSpread,keyBottomGaps,rotaryBottomGap,geometry})}`);
if(geometry.bottomLabelStyle.textTransform!=="uppercase"||parseFloat(geometry.bottomLabelStyle.fontSize)<6.5||geometry.screenSelectLabelStyle.textTransform!=="uppercase"||parseFloat(geometry.screenSelectLabelStyle.fontSize)<6)throw new Error(`Physical labels are not readable uppercase text: ${JSON.stringify(geometry)}`);
if(geometry.activeScreenLampColor!=="rgb(228, 70, 77)")throw new Error(`Screen Select active lamp is not red: ${JSON.stringify(geometry.activeScreenLampColor)}`);

const hoverSelectors={fn:".qu-screen-fn button",copy:".qu-screen-edit-keys label:nth-child(1) button",paste:".qu-screen-edit-keys label:nth-child(2) button",reset:".qu-screen-edit-keys label:nth-child(3) button",screenGreen:".qu-processing label:nth-child(1)>button",screenGrey:".qu-processing label:nth-child(3)>button"};
const hoverBackgrounds={};
for(const [key,selector] of Object.entries(hoverSelectors)){
  const point=await evaluate(`(()=>{const node=document.querySelector('${selector}');const rect=node.getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}})()`);
  await call("Input.dispatchMouseEvent",{type:"mouseMoved",x:point.x,y:point.y});
  await new Promise((resolve)=>setTimeout(resolve,30));
  hoverBackgrounds[key]=await evaluate(`getComputedStyle(document.querySelector('${selector}')).backgroundColor`);
}
for(const key of Object.keys(hoverSelectors))if(hoverBackgrounds[key]!==geometry.keyBackgrounds[key])throw new Error(`Physical key ${key} changes background on hover: ${JSON.stringify({base:geometry.keyBackgrounds[key],hover:hoverBackgrounds[key]})}`);

const pageResults=[];
for(const page of ["Routing","Home","FX","Scenes","Setup"]){
  const state=await evaluate(`(async()=>{const label=[...document.querySelectorAll('.qu-processing label')].find((entry)=>entry.textContent.trim()==='${page}');label?.querySelector('button')?.click();await new Promise((resolve)=>setTimeout(resolve,30));const activeButton=document.querySelector('.qu-processing label>button.active');return {page:document.querySelector('.qu-lcd-panel')?.dataset.screenPage,title:document.querySelector('.qu-lcd-alt-page header strong')?.textContent,active:document.querySelectorAll('.qu-processing label>button.active').length,options:document.querySelectorAll('.qu-lcd-alt-page button').length,lamp:getComputedStyle(activeButton?.querySelector('i')).backgroundColor}})()`);
  pageResults.push(state);
  if(state.page!==page||state.title!==page||state.active!==1||state.options!==4||state.lamp!=="rgb(228, 70, 77)")throw new Error(`Screen page did not switch to ${page} with one red lamp: ${JSON.stringify(state)}`);
}

const optionActions=await evaluate(`(async()=>{
  [...document.querySelectorAll('.qu-processing label')].find((entry)=>entry.textContent.trim()==='Routing')?.querySelector('button')?.click();
  await new Promise((resolve)=>setTimeout(resolve,30));
  const options=[...document.querySelectorAll('.qu-lcd-alt-page>div button')];
  options[1]?.click();
  await new Promise((resolve)=>setTimeout(resolve,20));
  const draft={selected:document.querySelector('.qu-lcd-alt-page')?.dataset.selectedOption,applied:document.querySelector('.qu-lcd-alt-page')?.dataset.appliedOption,state:document.querySelector('.qu-lcd-alt-detail')?.dataset.actionState};
  document.querySelectorAll('.qu-lcd-alt-detail button')[1]?.click();
  await new Promise((resolve)=>setTimeout(resolve,20));
  const cancelled={selected:document.querySelector('.qu-lcd-alt-page')?.dataset.selectedOption,applied:document.querySelector('.qu-lcd-alt-page')?.dataset.appliedOption,state:document.querySelector('.qu-lcd-alt-detail')?.dataset.actionState,status:document.querySelector('.qu-lcd-status')?.dataset.localStatus};
  document.querySelectorAll('.qu-lcd-alt-page>div button')[1]?.click();
  await new Promise((resolve)=>setTimeout(resolve,20));
  document.querySelectorAll('.qu-lcd-alt-detail button')[0]?.click();
  await new Promise((resolve)=>setTimeout(resolve,20));
  const applied={selected:document.querySelector('.qu-lcd-alt-page')?.dataset.selectedOption,applied:document.querySelector('.qu-lcd-alt-page')?.dataset.appliedOption,state:document.querySelector('.qu-lcd-alt-detail')?.dataset.actionState,status:document.querySelector('.qu-lcd-status')?.dataset.localStatus};
  return {draft,cancelled,applied};
})()`);
if(optionActions.draft.selected!=="Mix Sends"||optionActions.draft.applied!=="Inputs"||optionActions.draft.state!=="draft")throw new Error(`Routing draft state is invalid: ${JSON.stringify(optionActions)}`);
if(optionActions.cancelled.selected!=="Inputs"||optionActions.cancelled.applied!=="Inputs"||optionActions.cancelled.state!=="cancelled"||!optionActions.cancelled.status.includes("Cancelled locally"))throw new Error(`Routing Cancel is invalid: ${JSON.stringify(optionActions)}`);
if(optionActions.applied.selected!=="Mix Sends"||optionActions.applied.applied!=="Mix Sends"||optionActions.applied.state!=="applied"||!optionActions.applied.status.includes("Applied locally"))throw new Error(`Routing Apply is invalid: ${JSON.stringify(optionActions)}`);

await evaluate(`(async()=>{[...document.querySelectorAll('.qu-processing label')].find((entry)=>entry.textContent.trim()==='Processing')?.querySelector('button')?.click();await new Promise((resolve)=>setTimeout(resolve,30));return true})()`);
const blockCases=[
  {selector:".qu-lcd-channel",block:"PREAMP",parameter:"gain",value:54,text:"30.1dB"},
  {selector:".qu-lcd-gate",block:"GATE",parameter:"threshold",value:58,text:"-19.8dB"},
  {selector:".qu-lcd-comp",block:"COMP",parameter:"threshold",value:58,text:"-8.9dB"},
  {selector:".qu-lcd-chart",block:"PEQ",parameter:"lm",value:67,text:"2.05kHz"}
];
const blockResults=[];
for(const blockCase of blockCases){
  const state=await evaluate(`(async()=>{document.querySelector('${blockCase.selector}')?.click();await new Promise((resolve)=>setTimeout(resolve,25));const rotary=document.querySelector('.qu-screen-rotary .qu-rotary-control');const active=document.querySelector('.qu-lcd-parameters button.active');return {block:document.querySelector('.qu-lcd-panel')?.dataset.screenBlock,parameterBlock:document.querySelector('.qu-lcd-parameters')?.dataset.parameterBlock,count:document.querySelectorAll('.qu-lcd-parameters button').length,parameter:active?.dataset.screenParameter,value:Number(rotary?.dataset.value),text:active?.querySelector('strong')?.textContent}})()`);
  blockResults.push(state);
  if(state.block!==blockCase.block||state.parameterBlock!==blockCase.block||state.count!==5||state.parameter!==blockCase.parameter||state.value!==blockCase.value||state.text!==blockCase.text)throw new Error(`Processing block ${blockCase.block} is invalid: ${JSON.stringify(state)}`);
}

const blockClipboard=await evaluate(`(async()=>{
  document.querySelector('.qu-lcd-gate')?.click();
  await new Promise((resolve)=>setTimeout(resolve,20));
  const editButtons=[...document.querySelectorAll('.qu-screen-edit-keys button')];
  const pasteDisabledBefore=editButtons[1]?.disabled;
  editButtons[0]?.click();
  await new Promise((resolve)=>setTimeout(resolve,20));
  const knob=document.querySelector('.qu-screen-rotary .qu-rotary-control');
  knob?.focus();
  knob?.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}));
  await new Promise((resolve)=>setTimeout(resolve,20));
  const changed=Number(knob?.dataset.value);
  editButtons[1]?.click();
  await new Promise((resolve)=>setTimeout(resolve,30));
  return {pasteDisabledBefore,pasteDisabledAfter:editButtons[1]?.disabled,changed,pasted:Number(knob?.dataset.value),status:document.querySelector('.qu-lcd-status')?.dataset.localStatus};
})()`);
if(!blockClipboard.pasteDisabledBefore||blockClipboard.pasteDisabledAfter||blockClipboard.changed!==59||blockClipboard.pasted!==58||!blockClipboard.status.includes("Pasted locally: GATE"))throw new Error(`Block clipboard is invalid: ${JSON.stringify(blockClipboard)}`);

await evaluate(`(async()=>{document.querySelector('.qu-lcd-chart')?.click();await new Promise((resolve)=>setTimeout(resolve,20));document.querySelector('.qu-screen-fn button')?.click();await new Promise((resolve)=>setTimeout(resolve,20));return true})()`);
const fnOpen=await evaluate(`Boolean(document.querySelector('.qu-lcd-popup'))`);
if(!fnOpen)throw new Error("Fn key did not open the contextual screen overlay");
const fnAction=await evaluate(`(async()=>{document.querySelector('.qu-lcd-popup [data-fn-option]')?.click();await new Promise((resolve)=>setTimeout(resolve,20));const lcd=document.querySelector('.qu-lcd-panel');return {open:Boolean(document.querySelector('.qu-lcd-popup')),selection:lcd?.dataset.fnSelection,status:document.querySelector('.qu-lcd-status')?.dataset.localStatus}})()`);
if(fnAction.open||fnAction.selection!=="User Library"||!fnAction.status.includes("Local Library: User Library"))throw new Error(`Fn option did not commit local UI state and close: ${JSON.stringify(fnAction)}`);

const rotaryBefore=await evaluate(`(()=>{const button=document.querySelector('.qu-screen-rotary .qu-rotary-control');const rect=button.getBoundingClientRect();return {value:Number(button.dataset.value),x:rect.x+rect.width/2,y:rect.y+rect.height/2,text:document.querySelector('.qu-lcd-parameters button.active strong')?.textContent}})()`);
await call("Input.dispatchMouseEvent",{type:"mouseMoved",x:rotaryBefore.x,y:rotaryBefore.y});
await call("Input.dispatchMouseEvent",{type:"mouseWheel",x:rotaryBefore.x,y:rotaryBefore.y,deltaX:0,deltaY:-120});
await new Promise((resolve)=>setTimeout(resolve,40));
const rotaryAfter=await evaluate(`(()=>{const button=document.querySelector('.qu-screen-rotary .qu-rotary-control');return {value:Number(button.dataset.value),text:document.querySelector('.qu-lcd-parameters button.active strong')?.textContent}})()`);
if(rotaryAfter.value!==rotaryBefore.value+1||rotaryAfter.text===rotaryBefore.text)throw new Error(`Screen Rotary did not update the focused parameter: ${JSON.stringify({rotaryBefore,rotaryAfter})}`);

await evaluate(`(async()=>{document.querySelector('.qu-screen-edit-keys label:last-child button')?.click();await new Promise((resolve)=>setTimeout(resolve,30));return true})()`);
const resetState=await evaluate(`(()=>{const button=document.querySelector('.qu-screen-rotary .qu-rotary-control');return {value:Number(button.dataset.value),text:document.querySelector('.qu-lcd-parameters button.active strong')?.textContent}})()`);
if(resetState.value!==67||resetState.text!=="2.05kHz")throw new Error(`Reset did not synchronize the Screen Rotary and LCD value: ${JSON.stringify(resetState)}`);
socket.close();
console.log(JSON.stringify({geometry,screenBankRatio,screenHeightRatio,touchWidthRatio,lcdContentAspect,controlBandRatio,rotaryZoneRatio,screenSelectGaps,rotaryCenter,rotaryLinePairCenter,buttonFaceCenters,controlCenterSpread,controlGroupCenters,opticalCenterSpread,keyBottomGaps,rotaryBottomGap,hoverBackgrounds,pageResults,optionActions,blockResults,blockClipboard,fnAction,rotaryBefore,rotaryAfter,resetState},null,2));
