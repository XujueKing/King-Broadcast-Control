import { createRoot } from "react-dom/client";
import { MixerConsole } from "../src/MixerConsole.jsx";
import { mixerModelById } from "../src/mixer-models/index.js";

export function mountQu16ControlHarness(container,initialProps={}) {
  const root=createRoot(container);
  const writes=[];
  let props={...initialProps};
  const onWriteParameters=(batch)=>{
    writes.push({at:performance.now(),writes:structuredClone(batch)});
    if(props.rejectWrites)return Promise.resolve({accepted:false,error:"synthetic write rejection"});
    return Promise.resolve({accepted:true});
  };
  const render=()=>root.render(
    <MixerConsole
      model={mixerModelById("allen-heath-qu16")}
      meterSnapshot={null}
      parameterSnapshot={props.parameterSnapshot??null}
      controlMode={props.controlMode??"hardware-live"}
      onWriteParameters={onWriteParameters}
    />,
  );
  render();
  return {
    writes,
    clearWrites:()=>{writes.length=0},
    update(nextProps){props={...props,...nextProps};render()},
    unmount(){root.unmount()},
  };
}
