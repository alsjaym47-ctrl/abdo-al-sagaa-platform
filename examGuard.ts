export type ExamSignal = 'TAB_HIDDEN'|'WINDOW_BLUR'|'ESC'|'F11'|'SCREEN_SHARE_STOPPED'|'SCREEN_CAPTURE_ATTEMPT';
export type GuardHandlers = { onViolation:(signal:ExamSignal)=>void };

export function installExamGuard(handlers:GuardHandlers){
  const onVisibility=()=>{ if(document.hidden) handlers.onViolation('TAB_HIDDEN'); };
  const onBlur=()=>handlers.onViolation('WINDOW_BLUR');
  const onKey=(e:KeyboardEvent)=>{ if(e.key==='Escape')handlers.onViolation('ESC'); if(e.key==='F11')handlers.onViolation('F11'); };
  document.addEventListener('visibilitychange',onVisibility); window.addEventListener('blur',onBlur); window.addEventListener('keydown',onKey);
  return ()=>{document.removeEventListener('visibilitychange',onVisibility);window.removeEventListener('blur',onBlur);window.removeEventListener('keydown',onKey);};
}

export async function requestFullscreen(el:HTMLElement=document.documentElement){
  if(!document.fullscreenElement && el.requestFullscreen) await el.requestFullscreen();
}

export async function requestScreenShareWatch(onStopped:()=>void){
  if(!navigator.mediaDevices?.getDisplayMedia) return null;
  try { const stream=await navigator.mediaDevices.getDisplayMedia({video:true}); const track=stream.getVideoTracks()[0]; track.addEventListener('ended',onStopped); return stream; } catch { return null; }
}
