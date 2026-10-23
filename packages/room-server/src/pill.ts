// Web pill shell for published sites: vanilla CSS+JS constants mirroring the desktop capsule; no React ships to visitors.

/** Must equal the desktop Console's SHRINK_MS (hover-out grace before the fold). */
export const PILL_SHRINK_MS = 500;
/** Must equal the desktop consoleState's OPEN_HOVER_MS (hover-intent delay). */
export const PILL_OPEN_HOVER_MS = 180;

// Every value below mirrors the desktop composer CSS; re-derive from the desktop values on drift.
export const PILL_CSS = [
  '#tent-nocode-pill{position:fixed;left:50%;bottom:36px;transform:translateX(-50%);z-index:60;',
  'width:min(680px,calc(100vw - 48px));display:flex;flex-direction:column;gap:10px;',
  "font-family:var(--sans,system-ui);pointer-events:none;}",
  '#tent-nocode-pill .tp-region{display:none;flex-direction:column;justify-content:flex-end;',
  'max-height:min(56vh,560px);overflow:auto;background:var(--bg,#171717);',
  'border:1px solid var(--border,#333);border-radius:var(--r3,16px);',
  'padding:var(--s3,12px);pointer-events:auto;opacity:0;transform:translateY(6px);',
  'transition:opacity 170ms ease,transform 170ms ease;}',
  '#tent-nocode-pill.tp-open .tp-region{display:flex;opacity:1;transform:translateY(0);}',
  '#tent-nocode-pill .tp-msg{color:var(--t2,#b5b5b5);font-size:13px;padding:6px 4px;white-space:pre-wrap;}',
  '#tent-nocode-pill .tp-capsule{pointer-events:auto;display:flex;gap:10px;align-items:center;',
  'background:var(--panel2,#232323);border:1px solid var(--border,#333);border-radius:999px;',
  'padding:6px 6px 6px 18px;transition:border-color 180ms ease-out;',
  'filter:drop-shadow(0 14px 36px rgba(0,0,0,0.6)) drop-shadow(0 3px 10px rgba(0,0,0,0.35));}',
  '#tent-nocode-pill .tp-capsule:focus-within{border-color:var(--border2,#4a4a4a);}',
  '#tent-nocode-pill .tp-input{flex:1;background:transparent;border:none;outline:none;color:var(--t1,#ececec);',
  'font-family:var(--sans,system-ui);font-size:13px;padding:8px 0;}',
  '#tent-nocode-pill .tp-input::placeholder{color:var(--t3,#8a8a8a);}',
  '#tent-nocode-pill .tp-send{flex:none;width:30px;height:30px;display:grid;place-items:center;',
  'border:none;border-radius:50%;font-size:15px;line-height:1;background:var(--accent,#ececec);',
  'color:var(--bg,#171717);cursor:pointer;transition:opacity 150ms ease-out;}',
  '#tent-nocode-pill .tp-send:disabled{background:var(--panel,#1f1f1f);color:var(--t3,#8a8a8a);',
  'border:1px solid var(--border,#333);cursor:default;}',
  '@media (prefers-reduced-motion: reduce){#tent-nocode-pill .tp-region{transition:none;transform:none;}}',
].join('');

export const PILL_JS = '(function(){'
  + `var HOVER=${PILL_OPEN_HOVER_MS},SHRINK=${PILL_SHRINK_MS};`
  + "var root=document.getElementById('tent-nocode-pill');if(!root)return;"
  + "var app=root.getAttribute('data-app')||'';"
  + 'root.innerHTML=\'<div class="tp-region"><div class="tp-msg"></div></div>\''
  + '+\'<div class="tp-capsule"><input class="tp-input" type="text" placeholder="Ask anything…" aria-label="Ask the assistant">\''
  + '+\'<button class="tp-send" type="button" disabled aria-label="Send">↑</button></div>\';'
  + "var msg=root.querySelector('.tp-msg'),input=root.querySelector('.tp-input'),send=root.querySelector('.tp-send');"
  + 'var openT=null,shrinkT=null,asked=false;'
  // Send disc: disabled while empty, click matches the Enter path.
  + "input.addEventListener('input',function(){send.disabled=!input.value.trim();});"
  + "send.addEventListener('click',function(){if(!input.value.trim())return;asked=false;open();input.value='';send.disabled=true;});"
  + 'function speak(){if(asked)return;asked=true;'
  // The AI door's refusal sentence renders as-is.
  + "fetch('/api/ai',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({app:app})})"
  + '.then(function(r){return r.json();}).then(function(res){msg.textContent=res.reason||"";})'
  + ".catch(function(){msg.textContent='the app could not reach its server';});}"
  + "function open(){root.classList.add('tp-open');speak();}"
  + "function fold(){root.classList.remove('tp-open');}"
  + "root.addEventListener('mouseenter',function(){"
  + 'if(shrinkT){clearTimeout(shrinkT);shrinkT=null;}'
  + 'if(openT)return;openT=setTimeout(function(){openT=null;open();},HOVER);});'
  + "root.addEventListener('mouseleave',function(){"
  + 'if(openT){clearTimeout(openT);openT=null;}'
  + 'if(shrinkT)clearTimeout(shrinkT);shrinkT=setTimeout(fold,SHRINK);});'
  + "input.addEventListener('focus',open);"
  + "input.addEventListener('keydown',function(e){"
  + "if(e.key!=='Enter'||!input.value.trim())return;asked=false;open();input.value='';send.disabled=true;});"
  + '})();';

/** The mount injected only when the release declares an assistant; appSlug is already validated attribute-safe. */
export function pillMountHtml(appSlug: string): string {
  return '<link rel="stylesheet" href="/assets/pill.css">'
    + `<div id="tent-nocode-pill" data-app="${appSlug}"></div>`
    + '<script src="/assets/pill.js"></script>';
}
