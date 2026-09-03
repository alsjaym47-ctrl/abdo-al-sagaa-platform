export type WatermarkData={studentName:string;studentCode:string;rotateMs?:number};
export function startDynamicWatermark(el:HTMLElement,data:WatermarkData){
  const rotateMs=data.rotateMs??8000; const render=()=>{el.textContent=`${data.studentName} · ${data.studentCode}`; el.style.left=`${8+Math.random()*70}%`; el.style.top=`${12+Math.random()*70}%`;}; render(); const id=window.setInterval(render,rotateMs); return ()=>window.clearInterval(id);
}
